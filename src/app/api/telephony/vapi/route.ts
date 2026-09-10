// ============================================================================
// POST /api/telephony/vapi — Vapi.ai webhook (recommended production path).
//
// Provision a real U.S. phone number in the Vapi dashboard, attach the
// assistant config from docs/vapi-assistant-config.json, and point the
// serverUrl here. Vapi handles STT/TTS/telephony; data operations are
// delegated to this endpoint via tool calls, so persistence flows through
// the SAME service layer as the REST API.
//
// Implemented tools:
//   register_patient        → validate + create patient
//   update_patient          → partial update by patient_id
//   get_patient_by_phone    → duplicate-detection lookup (bonus)
//   schedule_appointment    → book a mock slot (bonus)
//   end_registration_call   → finalize the call session
// ============================================================================

import { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { patientCreateSchema, patientUpdateSchema, validateAgentField, normalizePhone, AgentFieldName } from "@/lib/validation/patient";
import { patientService } from "@/lib/services/patient-service";
import { appointmentService } from "@/lib/services/appointment-service";
import { callService } from "@/lib/services/call-service";

interface VapiToolCall {
  id: string;
  type?: string;
  function?: { name: string; arguments?: string | Record<string, unknown> };
}

interface VapiWebhookBody {
  message?: { toolCalls?: VapiToolCall[]; type?: string };
  call?: { id?: string; customer?: { number?: string } };
}

function parseArgs(tc: VapiToolCall): Record<string, unknown> {
  const raw = tc.function?.arguments;
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw;
}

function xmlSafe(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function POST(req: NextRequest) {
  let body: VapiWebhookBody;
  try {
    body = (await req.json()) as VapiWebhookBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const toolCalls = body.message?.toolCalls ?? [];
  const callId = body.call?.id ?? "unknown";
  const callerNumber = body.call?.customer?.number ?? null;

  const results = await Promise.all(
    toolCalls.map(async (tc) => {
      const name = tc.function?.name ?? "";
      const args = parseArgs(tc);
      let result: unknown;
      try {
        switch (name) {
          case "register_patient": {
            const parsed = patientCreateSchema.safeParse(args);
            if (!parsed.success) {
              result = {
                success: false,
                error: "validation_failed",
                issues: parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
              };
            } else {
              const created = await patientService.create(parsed.data);
              result = { success: true, patient_id: created.patient_id, message: `Patient ${created.first_name} ${created.last_name} registered.` };
            }
            break;
          }
          case "update_patient": {
            const { patient_id, ...fields } = args as Record<string, unknown>;
            const parsed = patientUpdateSchema.safeParse(fields);
            if (typeof patient_id !== "string") {
              result = { success: false, error: "patient_id required" };
            } else if (!parsed.success) {
              result = {
                success: false,
                error: "validation_failed",
                issues: parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
              };
            } else {
              const updated = await patientService.update(patient_id, parsed.data);
              result = { success: true, patient: updated, message: "Record updated." };
            }
            break;
          }
          case "get_patient_by_phone": {
            const phone = normalizePhone(String(args.phone_number ?? ""));
            if (!phone) {
              result = { found: false, error: "invalid phone_number" };
            } else {
              const p = await patientService.findByPhone(phone);
              result = p
                ? { found: true, patient_id: p.patient_id, first_name: p.first_name, last_name: p.last_name, date_of_birth: p.date_of_birth.toISOString().slice(0, 10) }
                : { found: false };
            }
            break;
          }
          case "validate_field": {
            // Optional helper: pre-validate one field conversationally
            const field = String(args.field ?? "") as AgentFieldName;
            const res = validateAgentField(field, args.value);
            result = res.valid ? { valid: true, value: res.value } : { valid: false, reason: res.error };
            break;
          }
          case "schedule_appointment": {
            const appt = await appointmentService.create({
              patient_id: String(args.patient_id ?? ""),
              appointment_date: String(args.appointment_date ?? ""),
              provider: args.provider ? String(args.provider) : undefined,
              reason: "New patient intake",
            });
            result = { success: true, appointment_id: appt.id, provider: appt.provider, appointment_date: appt.appointment_date };
            break;
          }
          case "end_registration_call": {
            await callService.end(String(args.session_id ?? callId), "completed", String(args.outcome ?? "registered"), args.patient_id ? String(args.patient_id) : null, null);
            result = { success: true };
            break;
          }
          default:
            result = { error: `unknown tool ${name}` };
        }
      } catch (err) {
        logger.error("telephony", `vapi tool ${name} failed`, { error: String(err) });
        result = { success: false, error: "internal_error", message: "The write failed; the agent should apologize and offer to retry." };
      }
      return { toolCallId: tc.id, result };
    })
  );

  return NextResponse.json({ results });
}
