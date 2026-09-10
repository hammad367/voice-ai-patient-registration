// ============================================================================
// Call Service — persistence for voice-agent conversations (observability).
// The transcript + final collected payload of every call survives in SQLite,
// so a dropped connection mid-call still leaves an auditable record.
// ============================================================================

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

export interface TranscriptEntry {
  role: "agent" | "caller" | "system";
  content: string;
  at: string; // ISO timestamp
}

export const callService = {
  /** JSON-safe serialization for API responses. */
  serialize(row: {
    id: string;
    session_id: string;
    channel: string;
    caller_number: string | null;
    language: string;
    status: string;
    outcome: string | null;
    transcript: string;
    collected_data: string | null;
    patient_id: string | null;
    error_message: string | null;
    started_at: Date;
    ended_at: Date | null;
  }) {
    return {
      id: row.id,
      session_id: row.session_id,
      channel: row.channel,
      caller_number: row.caller_number,
      language: row.language,
      status: row.status,
      outcome: row.outcome,
      transcript: JSON.parse(row.transcript || "[]"),
      collected_data: row.collected_data ? JSON.parse(row.collected_data) : null,
      patient_id: row.patient_id,
      error_message: row.error_message,
      started_at: row.started_at.toISOString(),
      ended_at: row.ended_at?.toISOString() ?? null,
      duration_sec: row.ended_at
        ? Math.round((row.ended_at.getTime() - row.started_at.getTime()) / 1000)
        : null,
    };
  },

  /** Idempotently ensure a session row exists (called at conversation start). */
  async start(sessionId: string, channel: string, callerNumber?: string | null) {
    await db.callSession.upsert({
      where: { session_id: sessionId },
      create: {
        session_id: sessionId,
        channel,
        caller_number: callerNumber ?? null,
        status: "in_progress",
        transcript: "[]",
      },
      update: { status: "in_progress" },
    });
    logger.info("call", `session started ${sessionId} via ${channel}`);
  },

  /** Append transcript entries + snapshot collected data after each turn. */
  async appendTurn(
    sessionId: string,
    entries: TranscriptEntry[],
    collectedData?: unknown,
    language?: string
  ) {
    const row = await db.callSession.findUnique({ where: { session_id: sessionId } });
    if (!row) return;
    const existing: TranscriptEntry[] = JSON.parse(row.transcript || "[]");
    const merged = [...existing, ...entries];
    await db.callSession.update({
      where: { session_id: sessionId },
      data: {
        transcript: JSON.stringify(merged.slice(-500)), // guard runaway sessions
        ...(collectedData !== undefined ? { collected_data: JSON.stringify(collectedData) } : {}),
        ...(language ? { language } : {}),
      },
    });
  },

  /** Finalize a session: status, outcome, linked patient, duration. */
  async end(
    sessionId: string,
    status: "completed" | "abandoned" | "failed",
    outcome?: string,
    patientId?: string | null,
    errorMessage?: string | null
  ) {
    const row = await db.callSession.findUnique({ where: { session_id: sessionId } });
    if (!row) return;
    const endedAt = new Date();
    await db.callSession.update({
      where: { session_id: sessionId },
      data: {
        status,
        outcome: outcome ?? null,
        patient_id: patientId ?? row.patient_id,
        error_message: errorMessage ?? null,
        ended_at: endedAt,
      },
    });
    logger.info("call", `session ${status} ${sessionId} outcome=${outcome ?? "-"} durationSec=${Math.round((endedAt.getTime() - row.started_at.getTime()) / 1000)}`);
  },

  list(limit = 100) {
    return db.callSession.findMany({ orderBy: { started_at: "desc" }, take: limit });
  },

  async getById(id: string) {
    return db.callSession.findUnique({ where: { session_id: id } });
  },
};
