// ============================================================================
// POST /api/telephony/twilio — Twilio Programmable Voice webhook (TwiML).
//
// Works WITHOUT media streams: each caller response arrives as a
// <Gather input="speech"> POST with SpeechResult; we run one agent turn and
// answer with <Say> TTS, looping until the conversation is done.
// Point a Twilio U.S. number's "A call comes in" webhook at:
//     https://<your-host>/api/telephony/twilio  (HTTP POST)
// Session id = CallSid, so the SAME conversational engine is used as the web
// simulator and the Vapi path.
// ============================================================================

import { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSession, createSession } from "@/lib/voice/session-store";
import { runAgentTurn } from "@/lib/voice/agent";
import { callService } from "@/lib/services/call-service";
import { AGENT_NAME, CLINIC_NAME } from "@/lib/voice/prompts";
import { logger } from "@/lib/logger";
import type { VoiceSession } from "@/lib/voice/types";

function xml(response: string) {
  return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?><Response>${response}</Response>`, {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function readTwilioParams(req: NextRequest): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    try {
      const j = await req.json();
      return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v)]));
    } catch {
      return {};
    }
  }
  const form = await req.formData();
  const out: Record<string, string> = {};
  form.forEach((v, k) => (out[k] = String(v)));
  return out;
}

export async function POST(req: NextRequest) {
  try {
    const p = await readTwilioParams(req);
    const callSid = p.CallSid ?? crypto.randomUUID();
    const callerNumber = p.From ?? null;
    const speech = (p.SpeechResult ?? "").trim();
    const base = new URL(req.url).pathname;

    let session = getSession(callSid);
    if (!session) {
      // First hit: answer + greet, then gather.
      session = {
        session_id: callSid,
        channel: "twilio",
        caller_number: callerNumber,
        stage: "collect",
        language: "en",
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
      } satisfies VoiceSession;
      createSession(session);
      await callService.start(callSid, "twilio", callerNumber);
      const greeting = `Thank you for calling ${CLINIC_NAME}. This is ${AGENT_NAME}. Are you looking to register a new patient today?`;
      await callService.appendTurn(callSid, [
        { role: "agent", content: greeting, at: new Date().toISOString() },
      ]);
      return xml(
        `<Say>${esc(greeting)}</Say>` +
          `<Gather input="speech" action="${esc(base)}" method="POST" speechTimeout="auto" language="en-US"><Say> </Say></Gather>` +
          `<Redirect method="POST">${esc(base)}</Redirect>`
      );
    }

    // Continued turn: caller speech (or empty re-post after gather timeout)
    if (!speech) {
      return xml(
        `<Say>${esc("Are you still there?")}</Say>` +
          `<Gather input="speech" action="${esc(base)}" method="POST" speechTimeout="auto" language="en-US"><Say> </Say></Gather>` +
          `<Redirect method="POST">${esc(base)}</Redirect>`
      );
    }

    const result = await runAgentTurn(session, speech);

    if (result.done) {
      const outcome =
        result.outcome ?? (session.updateMode ? "updated" : session.patientId ? "registered" : "abandoned");
      await callService.end(callSid, "completed", outcome, result.patientId, result.error ?? null);
      return xml(`<Say>${esc(result.reply)}</Say><Hangup/>`);
    }

    return xml(
      `<Say>${esc(result.reply)}</Say>` +
        `<Gather input="speech" action="${esc(base)}" method="POST" speechTimeout="auto" language="${result.language === "es" ? "es-US" : "en-US"}"><Say> </Say></Gather>` +
        `<Redirect method="POST">${esc(base)}</Redirect>`
    );
  } catch (err) {
    logger.error("telephony", "twilio webhook error", { error: String(err) });
    return xml(
      `<Say>We're sorry — something went wrong on our side. Please try calling again in a few minutes. Goodbye.</Say><Hangup/>`
    );
  }
}
