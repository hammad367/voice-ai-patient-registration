// ============================================================================
// Patient field validation — SINGLE SOURCE OF TRUTH
// ============================================================================
// Used by THREE layers so the rules can never drift apart:
//   1. REST API (server-side validation — challenge requirement)
//   2. Voice agent engine (field-level re-prompting)
//   3. Automated tests
//
// Rules transcribed from the challenge data model:
//   first_name / last_name : 1–50 chars, alphabetic + hyphens/apostrophes
//   date_of_birth          : valid date, not in the future, MM/DD/YYYY
//   sex                    : Male | Female | Other | Decline to Answer
//   phone_number           : valid U.S. 10-digit number
//   email                  : valid email format (optional)
//   address_line_1         : street address (required)
//   address_line_2         : apt/suite/unit (optional)
//   city                   : 1–100 characters
//   state                  : valid 2-letter U.S. state abbreviation
//   zip_code               : 5-digit or ZIP+4 U.S. format
//   insurance_provider     : name of insurance company (optional)
//   insurance_member_id    : alphanumeric member/subscriber ID (optional)
//   preferred_language     : default English (optional)
//   emergency_contact_name : full name (optional)
//   emergency_contact_phone: valid U.S. 10-digit number (optional)
// ============================================================================

import { z } from "zod";

// ---------------------------------------------------------------------------
// U.S. states — full name → USPS abbreviation (agent can accept either)
// ---------------------------------------------------------------------------
export const VALID_STATE_CODES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina",
  ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};

const STATE_NAME_TO_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(VALID_STATE_CODES).map(([code, name]) => [name.toLowerCase(), code])
);

export function normalizeState(raw: string): string | null {
  const v = raw.trim().toUpperCase().replace(/\./g, "");
  if (VALID_STATE_CODES[v]) return v;
  return STATE_NAME_TO_CODE[raw.trim().toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Phone normalization — accepts (415) 555-1234, 415.555.1234, +1 415 555 1234,
// "4155551234", spoken digit strings, etc. → canonical 10-digit string.
// ---------------------------------------------------------------------------
export function normalizePhone(raw: string): string | null {
  const digits = (raw || "").replace(/\D/g, "");
  let ten = digits;
  if (ten.length === 11 && ten.startsWith("1")) ten = ten.slice(1);
  if (ten.length !== 10) return null;
  // NANP: area code and exchange code cannot start with 0 or 1
  if (ten[0] < "2" || ten[3] < "2") return null;
  return ten;
}

export function formatPhone(ten: string): string {
  if (ten?.length !== 10) return ten;
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

// ---------------------------------------------------------------------------
// ZIP normalization — 5-digit or ZIP+4 ("94103", "94103-4180", "941034180")
// ---------------------------------------------------------------------------
export function normalizeZip(raw: string): string | null {
  const v = (raw || "").trim().toUpperCase();
  const m = v.match(/^(\d{5})(?:\s*-?\s*(\d{4}))?$/);
  if (m) return m[2] ? `${m[1]}-${m[2]}` : m[1];
  // 9 consecutive digits → ZIP+4
  const nine = v.replace(/\D/g, "");
  if (nine.length === 9) return `${nine.slice(0, 5)}-${nine.slice(5)}`;
  return null;
}


// ---------------------------------------------------------------------------
// DOB normalization — accepts MM/DD/YYYY, M/D/YYYY, YYYY-MM-DD,
// "April 12 1990", "12 Apr 1990", "15 de marzo de 1979" (Spanish).
// Returns JS Date (UTC) or null.
// ---------------------------------------------------------------------------
const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9,
  sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
  // Spanish
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

export function parseDateOfBirth(raw: string): Date | null {
  if (!raw) return null;
  // Strip Spanish "de" connectors: "15 de marzo de 1979" → "15 marzo 1979"
  const s = raw.trim().replace(/\s+de\s+/gi, " ");

  // ISO: YYYY-MM-DD (Prisma/JSON clients)
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return buildUtcDate(+m[1], +m[2], +m[3]);

  // US: MM/DD/YYYY or MM-DD-YYYY
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return buildUtcDate(+m[3], +m[1], +m[2]);

  // "April 12, 1990" / "April 12 1990"
  m = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  if (m && MONTHS[m[1].toLowerCase()]) return buildUtcDate(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);

  // "12 April 1990"
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return buildUtcDate(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);

  return null;
}

function buildUtcDate(y: number, mo: number, d: number): Date | null {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // Reject rollovers like 02/31/1990
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

export function validateDateOfBirth(raw: string): { valid: boolean; date?: Date; error?: string } {
  const date = parseDateOfBirth(raw);
  if (!date) return { valid: false, error: "Not a valid date. Expected MM/DD/YYYY." };
  const now = new Date();
  if (date > now) return { valid: false, error: "Date of birth cannot be in the future." };
  if (date < new Date("1900-01-01T00:00:00Z")) return { valid: false, error: "Date of birth must be after 1900." };
  const age = (now.getTime() - date.getTime()) / (365.25 * 24 * 3600 * 1000);
  if (age > 130) return { valid: false, error: "Date of birth implies an age over 130 — please double-check." };
  return { valid: true, date };
}

export function formatDobForSpeech(d: Date, lang: "en" | "es" = "en"): string {
  // Unambiguous spoken form: "April 12, 1990" / "12 de abril de 1990"
  return d.toLocaleDateString(lang === "es" ? "es-US" : "en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function toDobDateString(d: Date): string {
  // Canonical storage/API exchange format: MM/DD/YYYY
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getUTCFullYear()}`;
}

// ---------------------------------------------------------------------------
// Text sanitizer — strips control chars, collapses whitespace, trims, caps
// length. Applied to every free-text field server-side (basic input
// sanitization — challenge security requirement).
// ---------------------------------------------------------------------------
export function sanitizeText(raw: unknown, maxLen = 200): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

const NAME_RE = /^[A-Za-zÀ-ÖØ-öø-ÿ' -]{1,50}$/;

function nameValidator(label: string) {
  return z
    .string()
    .transform((v) => sanitizeText(v, 50))
    .refine((v) => v.length >= 1 && v.length <= 50, { message: `${label} must be 1–50 characters.` })
    .refine((v) => NAME_RE.test(v), {
      message: `${label} may only contain letters, hyphens and apostrophes.`,
    });
}

// ---------------------------------------------------------------------------
// Zod schemas — POST /patients (create) and PUT /patients/:id (partial update)
// ---------------------------------------------------------------------------
export const SEX_VALUES = ["Male", "Female", "Other", "Decline to Answer"] as const;
export type SexValue = (typeof SEX_VALUES)[number];

const dobSchema = z.string().refine((v) => validateDateOfBirth(v).valid, {
  message: "date_of_birth must be a valid date (MM/DD/YYYY), not in the future.",
});

const sexSchema = z.enum(SEX_VALUES);

const phoneSchema = z.string().refine((v) => normalizePhone(v) !== null, {
  message: "phone_number must be a valid U.S. 10-digit phone number.",
});

const emailSchema = z
  .string()
  .trim()
  .min(1)
  .max(254)
  .email({ message: "email must be a valid email address." });

const stateSchema = z.string().refine((v) => normalizeState(v) !== null, {
  message: "state must be a valid 2-letter U.S. state abbreviation.",
});

const zipSchema = z.string().refine((v) => normalizeZip(v) !== null, {
  message: "zip_code must be a 5-digit or ZIP+4 U.S. format.",
});

const alnumIdSchema = z
  .string()
  .transform((v) => sanitizeText(v, 50))
  .refine((v) => /^[A-Za-z0-9-]{1,50}$/.test(v), {
    message: "insurance_member_id must be alphanumeric (max 50 chars).",
  });

export const patientCreateSchema = z.object({
  first_name: nameValidator("first_name"),
  last_name: nameValidator("last_name"),
  date_of_birth: dobSchema,
  sex: sexSchema,
  phone_number: phoneSchema,
  email: emailSchema.optional().nullable(),
  address_line_1: z.string().transform((v) => sanitizeText(v, 200)).refine((v) => v.length >= 1, {
    message: "address_line_1 is required.",
  }),
  address_line_2: z.string().transform((v) => sanitizeText(v, 200)).optional().nullable(),
  city: z.string().transform((v) => sanitizeText(v, 100)).refine((v) => v.length >= 1 && v.length <= 100, {
    message: "city must be 1–100 characters.",
  }),
  state: stateSchema,
  zip_code: zipSchema,
  insurance_provider: z.string().transform((v) => sanitizeText(v, 100)).optional().nullable(),
  insurance_member_id: alnumIdSchema.optional().nullable(),
  preferred_language: z.string().transform((v) => sanitizeText(v, 50)).optional().nullable(),
  emergency_contact_name: z.string().transform((v) => sanitizeText(v, 100)).optional().nullable(),
  emergency_contact_phone: phoneSchema.optional().nullable(),
});

export const patientUpdateSchema = patientCreateSchema.partial();

export type PatientCreateInput = z.infer<typeof patientCreateSchema>;
export type PatientUpdateInput = z.infer<typeof patientUpdateSchema>;

// ---------------------------------------------------------------------------
// Normalizers applied AFTER Zod validation — converts user-friendly input into
// canonical storage form (10-digit phone, state code, ZIP+4, Date).
// ---------------------------------------------------------------------------
export function canonicalizePatientInput(input: PatientCreateInput | PatientUpdateInput) {
  const out: Record<string, unknown> = { ...input };
  if (typeof out.phone_number === "string") out.phone_number = normalizePhone(out.phone_number);
  if (typeof out.emergency_contact_phone === "string" && out.emergency_contact_phone)
    out.emergency_contact_phone = normalizePhone(out.emergency_contact_phone);
  if (typeof out.state === "string") out.state = normalizeState(out.state);
  if (typeof out.zip_code === "string") out.zip_code = normalizeZip(out.zip_code);
  if (typeof out.date_of_birth === "string") {
    const r = validateDateOfBirth(out.date_of_birth);
    if (r.valid && r.date) out.date_of_birth = r.date;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Field-level validation for the VOICE AGENT — validates + normalizes one
// field at a time so the agent can re-prompt for exactly the bad field.
// ---------------------------------------------------------------------------
export type AgentFieldName =
  | "first_name" | "last_name" | "date_of_birth" | "sex" | "phone_number"
  | "email" | "address_line_1" | "address_line_2" | "city" | "state"
  | "zip_code" | "insurance_provider" | "insurance_member_id"
  | "preferred_language" | "emergency_contact_name" | "emergency_contact_phone";

export const REQUIRED_AGENT_FIELDS: AgentFieldName[] = [
  "first_name", "last_name", "date_of_birth", "sex", "phone_number",
  "address_line_1", "city", "state", "zip_code",
];

export const OPTIONAL_AGENT_FIELDS: AgentFieldName[] = [
  "email", "address_line_2", "insurance_provider", "insurance_member_id",
  "preferred_language", "emergency_contact_name", "emergency_contact_phone",
];

export function validateAgentField(
  field: AgentFieldName,
  raw: unknown
): { valid: boolean; value?: unknown; error?: string } {
  const asStr = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
  switch (field) {
    case "first_name":
    case "last_name": {
      const v = sanitizeText(asStr, 50);
      if (!v) return { valid: false, error: "Name is empty." };
      if (!NAME_RE.test(v)) return { valid: false, error: `${field.replace("_", " ")} may only contain letters, hyphens and apostrophes.` };
      return { valid: true, value: v };
    }
    case "date_of_birth": {
      const r = validateDateOfBirth(asStr);
      return r.valid ? { valid: true, value: r.date } : { valid: false, error: r.error };
    }
    case "sex": {
      const s = asStr.trim().toLowerCase();
      if (s.startsWith("m")) return { valid: true, value: "Male" };
      if (s.startsWith("f")) return { valid: true, value: "Female" };
      if (s.startsWith("o") || s === "non-binary" || s === "nonbinary") return { valid: true, value: "Other" };
      if (
        s.includes("decline") || s.includes("prefer not") || s.includes("rather not") ||
        s.includes("not say") || s.includes("no answer") || s === "n/a"
      )
        return { valid: true, value: "Decline to Answer" };
      return { valid: false, error: "Sex must be Male, Female, Other, or Decline to Answer." };
    }
    case "phone_number":
    case "emergency_contact_phone": {
      const v = normalizePhone(asStr);
      if (!v) return { valid: false, error: "That doesn't look like a valid U.S. 10-digit phone number." };
      return { valid: true, value: v };
    }
    case "email": {
      const v = sanitizeText(asStr, 254).toLowerCase();
      if (!v) return { valid: true, value: null }; // optional
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return { valid: false, error: "That email address doesn't look valid." };
      return { valid: true, value: v };
    }
    case "address_line_1": {
      const v = sanitizeText(asStr, 200);
      if (v.length < 4) return { valid: false, error: "Please provide a full street address." };
      return { valid: true, value: v };
    }
    case "address_line_2":
      return { valid: true, value: sanitizeText(asStr, 200) || null };
    case "city": {
      const v = sanitizeText(asStr, 100);
      if (!v) return { valid: false, error: "City is required." };
      return { valid: true, value: v };
    }
    case "state": {
      const v = normalizeState(asStr);
      if (!v) return { valid: false, error: "Please provide a valid U.S. state." };
      return { valid: true, value: v };
    }
    case "zip_code": {
      const v = normalizeZip(asStr);
      if (!v) return { valid: false, error: "ZIP code must be 5 digits or ZIP+4." };
      return { valid: true, value: v };
    }
    case "insurance_provider":
      return { valid: true, value: sanitizeText(asStr, 100) || null };
    case "insurance_member_id": {
      const v = sanitizeText(asStr, 50).replace(/\s+/g, "");
      if (!v) return { valid: true, value: null };
      if (!/^[A-Za-z0-9-]{1,50}$/.test(v)) return { valid: false, error: "Member ID should be letters and numbers only." };
      return { valid: true, value: v };
    }
    case "preferred_language":
      return { valid: true, value: sanitizeText(asStr, 50) || "English" };
    case "emergency_contact_name": {
      const v = sanitizeText(asStr, 100);
      if (!v) return { valid: true, value: null };
      if (!NAME_RE.test(v)) return { valid: false, error: "Emergency contact name may only contain letters, hyphens and apostrophes." };
      return { valid: true, value: v };
    }
    default:
      return { valid: false, error: `Unknown field: ${field}` };
  }
}

// Language mapping for the multi-language bonus (spoken input → canonical)
export function normalizeLanguage(raw: string): string {
  const v = (raw || "").trim().toLowerCase();
  if (!v) return "English";
  if (/esp|spanish|español|castellano/.test(v)) return "Spanish";
  if (/engl|inglés|ingles|american/.test(v)) return "English";
  return sanitizeText(raw, 50) || "English";
}
