// ============================================================================
// Client-side API helpers for the dashboard SPA
// ============================================================================

export interface Envelope<T> {
  data: T | null;
  error: { message: string; details?: unknown } | string | null;
}

export async function api<T>(
  path: string,
  init?: RequestInit
): Promise<{ data: T | null; error: string | null }> {
  try {
    const res = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    const json = (await res.json()) as Envelope<T>;
    if (!res.ok || json.error) {
      const msg =
        typeof json.error === "string"
          ? json.error
          : json.error?.message ?? `HTTP ${res.status}`;
      const details = typeof json.error === "object" && json.error?.details;
      return {
        data: null,
        error: details ? `${msg} (${JSON.stringify(details).slice(0, 200)})` : msg,
      };
    }
    return { data: json.data as T, error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : "Network error" };
  }
}

// ---------------------------------------------------------------------------
// Types shared with the backend envelope payloads
// ---------------------------------------------------------------------------
export interface Patient {
  patient_id: string;
  first_name: string;
  last_name: string;
  date_of_birth: string; // YYYY-MM-DD
  date_of_birth_display: string; // MM/DD/YYYY
  sex: string;
  phone_number: string;
  email: string | null;
  address_line_1: string;
  address_line_2: string | null;
  city: string;
  state: string;
  zip_code: string;
  insurance_provider: string | null;
  insurance_member_id: string | null;
  preferred_language: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface CallSessionDto {
  id: string;
  session_id: string;
  channel: string;
  language: string;
  status: string;
  outcome: string | null;
  transcript: { role: string; content: string; at: string }[];
  collected_data: Record<string, unknown> | null;
  patient_id: string | null;
  error_message: string | null;
  started_at: string;
  ended_at: string | null;
  duration_sec: number | null;
}

export interface AppointmentDto {
  id: string;
  patient_id: string;
  patient_name: string | null;
  patient_phone: string | null;
  appointment_date: string;
  provider: string;
  reason: string | null;
  status: string;
  created_at: string;
}

export interface AgentTurnDto {
  reply: string;
  stage: string;
  collected: Record<string, unknown>;
  reprompt: Record<string, string>;
  done: boolean;
  outcome: string | null;
  patientId: string | null;
  language: string;
  appointment: { label: string; provider: string; date: string } | null;
  error?: string;
}

export function formatPhoneClient(ten: string): string {
  if (!ten || ten.length !== 10) return ten ?? "";
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}
