// ============================================================================
// POST /api/voice/session — start a registration conversation.
// Returns session_id + the agent's opening greeting (the "call answered").
// Body: { channel?: "web"|"vapi"|"twilio", caller_number?: string }
// ============================================================================

import { NextRequest } from "next/server";
import { ok, fail, handleRoute, rateLimit, clientKey } from "@/lib/api-utils";
import { createSession, activeSessionCount } from "@/lib/voice/session-store";
import { callService } from "@/lib/services/call-service";
import { AGENT_NAME, CLINIC_NAME } from "@/lib/voice/prompts";
import type { VoiceSession } from "@/lib/voice/types";

function greeting(lang: "en" | "es"): string {
  return lang === "es"
    ? `¡Gracias por llamar a ${CLINIC_NAME}! Le habla ${AGENT_NAME}. ¿Desea registrar a un nuevo paciente hoy?`
    : `Thank you for calling ${CLINIC_NAME}. This is ${AGENT_NAME}. Are you looking to register a new patient today?`;
}

export async function POST(req: NextRequest) {
  return handleRoute(req, "/api/voice/session", async () => {
    if (!rateLimit(clientKey(req, "voice:start"), 20, 60_000)) {
      return fail("Too many sessions — please wait a moment.", 429);
    }
    let channel: VoiceSession["channel"] = "web";
    let callerNumber: string | null = null;
    let language: "en" | "es" = "en";
    let sessionId = crypto.randomUUID();
    try {
      const body = await req.json();
      if (body && typeof body === "object") {
        const b = body as Record<string, unknown>;
        if (b.channel === "vapi" || b.channel === "twilio" || b.channel === "web") channel = b.channel;
        if (typeof b.caller_number === "string") callerNumber = b.caller_number.slice(0, 20);
        if (typeof b.session_id === "string" && /^[A-Za-z0-9_-]{6,80}$/.test(b.session_id)) sessionId = b.session_id;
        if (b.language === "es") language = "es";
      }
    } catch {
      /* empty body is fine */
    }

    const session: VoiceSession = {
      session_id: sessionId,
      channel,
      caller_number: callerNumber,
      stage: "collect",
      language,
      collected: {},
      reprompt: {},
      existingPatient: null,
      existingPatientId: null,
      updateMode: false,
      lastReadback: null,
      offeredSlots: [],
      bookedAppointment: null,
      history: [],
      transcript: [],
      consecutiveLlmFailures: 0,
      turns: 0,
      outcome: null,
      patientId: null,
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      endedAt: null,
    };
    createSession(session);
    await callService.start(sessionId, channel, callerNumber);

    const msg = greeting(language);
    await callService.appendTurn(sessionId, [
      { role: "agent", content: msg, at: new Date().toISOString() },
    ]);

    return ok(
      {
        session_id: sessionId,
        channel,
        language,
        greeting: msg,
        stage: session.stage,
        active_sessions: activeSessionCount(),
      },
      201
    );
  });
}
