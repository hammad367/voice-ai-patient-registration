// ============================================================================
// Voice agent types — session state and turn results
// ============================================================================

import type { AgentFieldName } from "@/lib/validation/patient";
import type { TranscriptEntry } from "@/lib/services/call-service";

export type AgentStage =
  | "collect" // collecting required demographics
  | "duplicate" // phone matched an existing record — update or new?
  | "offer_optional" // offering optional fields (insurance, emergency, language)
  | "optional_collect" // caller opted in — collecting optional fields
  | "confirm" // reading everything back for confirmation
  | "saving" // transient — write in flight (kept for UI clarity)
  | "appointment_offer" // offer to schedule first appointment (bonus)
  | "appointment_time" // caller opted in — picking a slot
  | "done"; // call complete

export type AgentAction =
  | "auto"
  | "start_over"
  | "cancel_call"
  | "switch_language"
  | "use_existing" // duplicate stage → update existing record
  | "new_record" // duplicate stage → different person, register new
  | "accept_optionals" // offer_optional stage → caller wants to give some
  | "skip_optionals" // caller declines optional fields
  | "confirm_yes" // confirm stage → save
  | "confirm_edit" // confirm stage → correct a field (+ edit_field)
  | "appointment_yes"
  | "appointment_no"
  | "appointment_pick";

export type AgentLanguage = "en" | "es";

export interface CollectedPatientData {
  first_name?: string;
  last_name?: string;
  date_of_birth?: Date; // normalized
  sex?: string;
  phone_number?: string; // 10-digit
  email?: string | null;
  address_line_1?: string;
  address_line_2?: string | null;
  city?: string;
  state?: string;
  zip_code?: string;
  insurance_provider?: string | null;
  insurance_member_id?: string | null;
  preferred_language?: string;
  emergency_contact_name?: string | null;
  emergency_contact_phone?: string | null;
}

export interface VoiceSession {
  session_id: string;
  channel: "web" | "vapi" | "twilio";
  caller_number: string | null;
  stage: AgentStage;
  language: AgentLanguage;
  collected: CollectedPatientData;
  /** Fields the server rejected — agent must re-prompt for exactly these. */
  reprompt: Partial<Record<AgentFieldName, string>>;
  /** When duplicate found: the matching existing patient (serialized). */
  existingPatient: Record<string, unknown> | null;
  existingPatientId: string | null;
  /** When true we are UPDATING the existing record instead of creating. */
  updateMode: boolean;
  /** Last read-back string (so confirm_edit can re-read). */
  lastReadback: string | null;
  /** Appointment slots presented to the caller (index → slot). */
  offeredSlots: { label: string; date: string; provider?: string }[];
  bookedAppointment: { label: string; provider: string; date: string } | null;
  /** Rolling conversation history for the LLM (user/assistant text only). */
  history: { role: "user" | "assistant"; content: string }[];
  transcript: TranscriptEntry[];
  consecutiveLlmFailures: number;
  turns: number;
  outcome:
    | "registered" | "updated" | "declined_optional" | "duplicate_new"
    | "abandoned" | "failed" | null;
  patientId: string | null;
  startedAt: number;
  lastActiveAt: number;
  endedAt: number | null;
}

export interface AgentTurnResult {
  reply: string;
  stage: AgentStage;
  collected: CollectedPatientData;
  reprompt: Partial<Record<AgentFieldName, string>>;
  done: boolean;
  outcome: VoiceSession["outcome"];
  patientId: string | null;
  language: AgentLanguage;
  appointment: { label: string; provider: string; date: string } | null;
  error?: string;
}

/** Strict JSON contract the LLM must answer with every turn. */
export interface LlmTurnJson {
  reply: string;
  extracted?: Record<string, unknown>;
  action?: AgentAction;
  edit_field?: string;
  language?: string;
  appointment_slot?: number;
}
