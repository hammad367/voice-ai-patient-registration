// ============================================================================
// Voice session store — in-memory conversation state with TTL.
//
// Trade-off (documented in README): sessions are ephemeral by design — a
// "call" is a live conversation. PATIENT DATA is fully persistent (SQLite);
// the transcript of every turn is also persisted to the DB as it happens,
// so even if this process dies mid-call the conversation remains auditable.
// A multi-node deployment would back this with Redis (see README).
// ============================================================================

import type { VoiceSession } from "./types";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min — long enough for a held call
const MAX_SESSIONS = 500;

const globalForSessions = globalThis as unknown as {
  __voiceSessions?: Map<string, VoiceSession>;
};

const sessions: Map<string, VoiceSession> =
  globalForSessions.__voiceSessions ?? new Map<string, VoiceSession>();
globalForSessions.__voiceSessions = sessions;

export function createSession(session: VoiceSession): VoiceSession {
  // Lazy cleanup: expire stale sessions, mark long-running "in_progress"
  // DB rows as abandoned (handles "telephony connection dropped mid-call").
  sweep();
  sessions.set(session.session_id, session);
  return session;
}

export function getSession(sessionId: string): VoiceSession | undefined {
  const s = sessions.get(sessionId);
  if (!s) return undefined;
  if (Date.now() - s.lastActiveAt > SESSION_TTL_MS) {
    sessions.delete(sessionId);
    return undefined;
  }
  return s;
}

export function touchSession(session: VoiceSession) {
  session.lastActiveAt = Date.now();
  session.turns += 1;
}

export function endSession(sessionId: string) {
  sessions.delete(sessionId);
}

export function activeSessionCount() {
  return sessions.size;
}

/** Expire memory sessions + reconcile abandoned DB rows. */
function sweep() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActiveAt > SESSION_TTL_MS) sessions.delete(id);
  }
  if (sessions.size >= MAX_SESSIONS) {
    // drop oldest
    const oldest = [...sessions.values()].sort((a, b) => a.lastActiveAt - b.lastActiveAt);
    for (const s of oldest.slice(0, Math.floor(MAX_SESSIONS / 10))) sessions.delete(s.session_id);
  }
  // Mark DB sessions still "in_progress" after 2h as abandoned (lazy job).
  const cutoff = new Date(now - 2 * 60 * 60 * 1000);
  db.callSession
    .updateMany({
      where: { status: "in_progress", started_at: { lt: cutoff } },
      data: { status: "abandoned", outcome: "abandoned", ended_at: new Date() },
    })
    .catch((e) => logger.warn("call", "abandon sweep failed", { error: String(e) }));
}
