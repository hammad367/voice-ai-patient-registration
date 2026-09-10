// ============================================================================
// POST /api/voice/chat — speak one turn to the voice agent.
// Body: { session_id: string, message: string }
// The same engine powers the phone line (telephony webhooks) and the web
// simulator, so conversational behavior is identical everywhere.
// ============================================================================

import { NextRequest } from "next/server";
import { ok, fail, handleRoute, parseJsonBody, ApiError, rateLimit } from "@/lib/api-utils";
import { getSession, touchSession } from "@/lib/voice/session-store";
import { runAgentTurn } from "@/lib/voice/agent";
import { callService } from "@/lib/services/call-service";
import { sanitizeText } from "@/lib/validation/patient";

export async function POST(req: NextRequest) {
  return handleRoute(req, "/api/voice/chat", async () => {
    const body = await parseJsonBody(req);
    const b = body as Record<string, unknown>;

    const sessionId = typeof b.session_id === "string" ? b.session_id : "";
    const message = typeof b.message === "string" ? b.message : "";
    if (!sessionId) throw new ApiError("session_id is required.", 400);
    if (!message.trim()) throw new ApiError("message is required.", 400);

    if (!rateLimit(`voice:chat:${sessionId}`, 40, 60_000)) {
      return fail("Too many turns — slow down.", 429);
    }

    const session = getSession(sessionId);
    if (!session) {
      return fail(
        "Session expired or not found. Start a new call via POST /api/voice/session.",
        404
      );
    }

    touchSession(session);
    const result = await runAgentTurn(session, sanitizeText(message, 800));

    if (result.done) {
      const outcome =
        result.outcome ??
        (session.updateMode ? "updated" : session.patientId ? "registered" : "abandoned");
      await callService.end(
        sessionId,
        result.error ? "failed" : "completed",
        outcome,
        result.patientId,
        result.error ?? null
      );
    }

    return ok(result);
  });
}
