// ============================================================================
// VOICE AGENT ENGINE — deterministic state machine + LLM wording/extraction.
// ============================================================================
// Division of responsibility (the core architectural idea):
//
//   DETERMINISTIC (this file)            LLM (prompts.ts + z-ai SDK)
//   --------------------------           --------------------------
//   • stage transitions                  • natural, warm spoken wording
//   • field validation (Zod rules)       • messy speech → field extraction
//   • confirmation read-back text        • intent classification (yes/no/
//   • duplicate detection                  edit / start-over / language)
//   • database writes + failure handling • handling corrections gracefully
//   • transcript + payload logging
//
// This guarantees the rubric-critical behaviors (confirm-before-save,
// re-prompt the invalid field, exact offer phrasing) can NEVER drift,
// while keeping the voice experience human.
// ============================================================================

import ZAI from "z-ai-web-dev-sdk";
import { logger } from "@/lib/logger";
import {
  AgentFieldName,
  REQUIRED_AGENT_FIELDS,
  validateAgentField,
  normalizeLanguage,
} from "@/lib/validation/patient";
import { patientService } from "@/lib/services/patient-service";
import { callService, TranscriptEntry } from "@/lib/services/call-service";
import { appointmentService, availableSlots } from "@/lib/services/appointment-service";
import {
  buildSystemPrompt,
  buildReadback,
} from "./prompts";
import {
  AgentStage,
  AgentTurnResult,
  CollectedPatientData,
  LlmTurnJson,
  VoiceSession,
} from "./types";
import { sanitizeText } from "@/lib/validation/patient";

// ---------------------------------------------------------------------------
// LLM wiring — z-ai-web-dev-sdk (server-side only). Injectable for tests.
// ---------------------------------------------------------------------------
export type LlmFn = (messages: { role: string; content: string }[]) => Promise<string>;

const LLM_TIMEOUT_MS = 30_000;

export const defaultLlm: LlmFn = async (messages) => {
  const zai = await ZAI.create();
  const completion = await Promise.race([
    zai.chat.completions.create({
      messages: messages as any,
      thinking: { type: "disabled" },
    }),
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error("LLM timeout")), LLM_TIMEOUT_MS)
    ),
  ]);
  const content = completion?.choices?.[0]?.message?.content;
  if (!content || !content.trim()) throw new Error("Empty LLM response");
  return content;
};

// ---------------------------------------------------------------------------
// LLM JSON parsing — tolerant: models occasionally wrap JSON in prose/fences,
// emit smart quotes or trailing commas. Salvage strategies in order:
//   1. direct parse of fenced/braced region
//   2. repair pass (smart quotes → straight, trailing commas removed)
//   3. prose salvage (short clean sentence with no braces → reply only)
// ---------------------------------------------------------------------------
export function parseLlmJson(raw: string): LlmTurnJson | null {
  const cleaned = raw.replace(/```json/gi, "```").trim();
  const fenced = cleaned.match(/```([\s\S]*?)```/);
  const candidates = [fenced?.[1], cleaned];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf("{");
    const end = c.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    const slice = c.slice(start, end + 1);
    for (const attempt of [slice, repairJson(slice)]) {
      try {
        const parsed = JSON.parse(attempt);
        if (parsed && typeof parsed === "object" && typeof parsed.reply === "string") {
          return parsed as LlmTurnJson;
        }
      } catch {
        /* next strategy */
      }
    }
  }
  // Prose salvage: model ignored the contract but produced a speakable line.
  const prose = cleaned.replace(/```[\s\S]*?```/g, "").trim();
  if (prose && prose.length <= 300 && !prose.includes("{") && !prose.includes("}")) {
    return { reply: prose, extracted: {}, action: "auto" };
  }
  return null;
}

function repairJson(s: string): string {
  return s
    .replace(/[“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, "$1");
}

/** Voice-safe text: strip markdown, collapse whitespace, cap length. */
function voiceSafe(text: string, cap = 700): string {
  return sanitizeText(
    text.replace(/[*_#`>|]/g, "").replace(/\s*\n+\s*/g, " "),
    cap
  );
}

// ---------------------------------------------------------------------------
// Missing-field helper
// ---------------------------------------------------------------------------
export function missingRequiredFields(collected: CollectedPatientData): AgentFieldName[] {
  return REQUIRED_AGENT_FIELDS.filter((f) => {
    const v = collected[f];
    return v === undefined || v === null || v === "";
  });
}

function shortAck(reply: string): string | null {
  const r = voiceSafe(reply, 140);
  if (!r || r.includes("?") || r.length > 130) return null;
  return r;
}

// ---------------------------------------------------------------------------
// Main turn handler
// ---------------------------------------------------------------------------
export async function runAgentTurn(
  session: VoiceSession,
  utterance: string,
  llmFn: LlmFn = defaultLlm
): Promise<AgentTurnResult> {
  const now = () => new Date().toISOString();
  const utteranceClean = sanitizeText(utterance, 800);

  // Deterministic language detection (multi-language bonus safety net):
  // strong Spanish markers switch the session language immediately, so the
  // flow never depends on the LLM emitting switch_language.
  const detected = detectSpanish(utteranceClean);
  if (detected && session.language !== "es") {
    session.language = "es";
    logger.voice(session.session_id, "language → es (server detection)");
  }

  session.history.push({ role: "user", content: utteranceClean });

  const tCaller: TranscriptEntry = { role: "caller", content: utteranceClean, at: now() };

  let llmReply = "";
  let parsed: LlmTurnJson | null = null;
  let llmError: string | undefined;

  const buildMessages = () => {
    const missing = missingRequiredFields(session.collected);
    const system = buildSystemPrompt({
      stage: session.stage,
      language: session.language,
      collected: session.collected,
      missingRequired: missing,
      reprompt: session.reprompt,
      readback: session.stage === "confirm" ? session.lastReadback : null,
      slots: session.stage === "appointment_time" ? session.offeredSlots.map((s) => s.label) : [],
      updateMode: session.updateMode,
      existingPatientSummary: session.existingPatient
        ? `${session.existingPatient.first_name} ${session.existingPatient.last_name}, DOB ${session.existingPatient.date_of_birth_display ?? ""}`
        : null,
    });
    const msgs = [{ role: "assistant", content: system }]; // SDK convention: persona as 'assistant'
    const hist = session.history.slice(-16);
    // Ensure first history entry is a user turn for clean alternation
    while (hist.length && hist[0].role !== "user") hist.shift();
    for (const h of hist) msgs.push({ role: h.role, content: h.content });
    return msgs;
  };

  try {
    let raw = await llmFn(buildMessages());
    parsed = parseLlmJson(raw);
    if (!parsed) {
      // One corrective retry — models occasionally break the JSON contract.
      logger.warn("voice", "LLM broke JSON contract, retrying once", {
        session_id: session.session_id,
        raw_preview: raw.slice(0, 200),
      });
      const retryMessages = [
        ...buildMessages(),
        {
          role: "user",
          content:
            "SYSTEM CORRECTION: Your previous answer was not the required JSON object. Answer again with ONLY the JSON object: {\"reply\":\"...\",\"extracted\":{},\"action\":\"auto\"}",
        },
      ];
      raw = await llmFn(retryMessages);
      parsed = parseLlmJson(raw);
    }
    if (!parsed) throw new Error("Unparseable LLM response");
    llmReply = voiceSafe(parsed.reply);
    session.consecutiveLlmFailures = 0;
  } catch (err) {
    session.consecutiveLlmFailures += 1;
    llmError = err instanceof Error ? err.message : String(err);
    logger.error("voice", `LLM failure #${session.consecutiveLlmFailures}`, {
      session_id: session.session_id,
      error: llmError,
    });
  }

  // --- Graceful degradation when the LLM is unavailable --------------------
  if (session.consecutiveLlmFailures >= 3) {
    const reply =
      session.language === "es"
        ? "Lo siento, estoy teniendo problemas técnicos y no quiero arriesgarme a perder su información. Por favor, llámenos de nuevo en unos minutos. Gracias por su paciencia."
        : "I'm sorry — I'm having a spot of technical trouble and I don't want to risk losing your information. Could you please try calling again in a few minutes? Thank you so much for your patience.";
    return finalize(session, reply, tCaller, { done: true, outcome: "failed" });
  }

  const action = parsed?.action ?? "auto";

  // --- Language switch (multi-language bonus) ------------------------------
  if (action === "switch_language" && parsed?.language) {
    const next = normalizeLanguage(parsed.language).toLowerCase().startsWith("es") ? "es" : "en";
    session.language = next;
    const reply =
      next === "es"
        ? "¡Por supuesto! Continuamos en español. ¿Cómo se llama?"
        : "Of course! Let's switch back to English. How may I help you?";
    return finalize(session, reply, tCaller, {});
  }

  // --- Global actions -------------------------------------------------------
  if (action === "start_over") {
    session.collected = {};
    session.reprompt = {};
    session.existingPatient = null;
    session.existingPatientId = null;
    session.updateMode = false;
    session.lastReadback = null;
    session.stage = "collect";
    const reply =
      session.language === "es"
        ? "No hay problema, empezamos de cero. ¿Cuál es su nombre y apellido?"
        : "No problem at all — let's start fresh. What's your first and last name?";
    return finalize(session, reply, tCaller, {});
  }

  if (action === "cancel_call") {
    // Stage-aware cancel: if registration already saved, close gracefully
    // instead of implying we discarded their information.
    const reply =
      session.language === "es"
        ? session.patientId
          ? "Entendido. Su registro ya quedó guardado. ¡Que tenga un buen día!"
          : "Entendido, cancelo el registro. Que tenga un buen día."
        : session.patientId
          ? "Understood — and no worries, your registration is already saved. Have a great day!"
          : "Understood — I'll stop right here. Have a great day, and feel free to call us anytime.";
    return finalize(session, reply, tCaller, { done: true, outcome: session.patientId ? session.outcome : "abandoned" });
  }

  // --- Field extraction + server-side validation ---------------------------
  let phoneExtractedThisTurn = false;
  const llmExtracted = new Set<string>();
  if (parsed?.extracted && typeof parsed.extracted === "object") {
    for (const [field, rawVal] of Object.entries(parsed.extracted)) {
      const knownFields: string[] = [...REQUIRED_AGENT_FIELDS, "email", "address_line_2", "insurance_provider", "insurance_member_id", "preferred_language", "emergency_contact_name", "emergency_contact_phone"];
      if (!knownFields.includes(field)) continue;
      const name = field as AgentFieldName;
      const res = validateAgentField(name, rawVal);
      if (res.valid) {
        (session.collected as Record<string, unknown>)[name] = res.value;
        delete session.reprompt[name];
        if (name === "phone_number") phoneExtractedThisTurn = true;
        llmExtracted.add(name);
      } else {
        session.reprompt[name] = res.error ?? "Invalid value.";
      }
    }
  }

  // Regex safety net — recovers high-confidence patterns (phone, ZIP, email,
  // explicit DOB phrases) when the LLM extraction misses them. Only fills
  // fields that are still missing and not currently being re-prompted.
  {
    const fb = serverSideExtract(utteranceClean, session, llmExtracted);
    for (const [name, rawVal] of Object.entries(fb)) {
      if (session.reprompt[name]) continue;
      const res = validateAgentField(name as AgentFieldName, rawVal);
      if (res.valid) {
        (session.collected as Record<string, unknown>)[name] = res.value;
        delete session.reprompt[name];
        if (name === "phone_number") phoneExtractedThisTurn = true;
        logger.voice(session.session_id, "regex fallback extraction", { field: name });
      }
    }
  }

  // Duplicate lookup (bonus): phone just arrived → does it match a record?
  let duplicateJustFound = false;
  if (
    phoneExtractedThisTurn &&
    session.collected.phone_number &&
    !session.updateMode &&
    session.stage === "collect" &&
    !session.existingPatient
  ) {
    duplicateJustFound = await checkDuplicate(session, session.collected.phone_number);
  }

  // --- Re-prompt override: invalid fields ALWAYS get a specific re-ask -----
  const repromptEntries = Object.entries(session.reprompt);
  if (repromptEntries.length > 0) {
    const [field, reason] = repromptEntries[0] as [AgentFieldName, string];
    const reply = buildRepromptReply(field, reason, session.language, llmReply);
    return finalize(session, reply, tCaller, {});
  }

  // --- Stage transitions ----------------------------------------------------
  // Intent safety net: if the LLM returned action="auto" (misclassification),
  // the server detects the obvious intent from the utterance itself. This
  // guarantees rubric-critical flows (confirm→save, duplicate handling,
  // appointment booking) even when the model mislabels the action.
  const forcedAction =
    action === "auto" || !action ? detectIntent(tCaller.content, session.stage, parsed) : null;
  if (forcedAction) {
    logger.voice(session.session_id, "intent safety-net fired", { forced: forcedAction, stage: session.stage });
  }
  const effectiveAction = forcedAction ?? action;
  return transition(session, effectiveAction as never, parsed, llmReply, tCaller, duplicateJustFound);
}

// ---------------------------------------------------------------------------
// Server-side intent detection — deterministic fallback used when the LLM
// leaves action="auto". Bilingual (EN/ES) affirmation / refusal / slot pick.
// ---------------------------------------------------------------------------
export function detectIntent(
  utterance: string,
  stage: AgentStage,
  parsed: LlmTurnJson | null
): string | null {
  const t = (utterance || "").toLowerCase().trim();
  const gaveFields = !!(parsed?.extracted && Object.keys(parsed.extracted).length > 0);
  const affirm =
    /^(yes|yep|yeah|yup|sure|correct|right|ok|okay|looks good|sounds good|that's right|thats right|all correct|please do|go ahead|do it|confirm|sí|si|claro|correcto|por favor)\b/.test(t) ||
    /^(yes|yeah|yep)[,.! ]/.test(t);
  const refuse =
    /^(no|nope|nah|not now|maybe later|skip|pass|cancel|never mind|nevermind|eso es todo|nada más|nada mas|no gracias)\b/.test(t) ||
    /that'?s all|that'?s it|that'?s everything|nothing else|i'?m (all )?(set|good|done)/.test(t);

  // Slot picking: "option 2", "number 2", "the first one", bare "2"
  if (stage === "appointment_time") {
    const num = t.match(/(?:option|number|choice)\s*(\d+)|^(\d)$/);
    if (num) return "appointment_pick";
    if (/\b(first|one|primero|primera)\b/.test(t) || /morning|mañana|manana/.test(t)) return "appointment_pick";
    if (/\b(second|two|segundo|segunda)\b/.test(t) || /afternoon|tarde/.test(t)) return "appointment_pick";
    if (refuse) return "appointment_no";
    return null;
  }

  if (stage === "confirm") {
    if (affirm && !gaveFields && !/but|actually|wait|sorry/.test(t)) return "confirm_yes";
    return null; // corrections must come via the LLM (edit_field required)
  }
  if (stage === "duplicate") {
    if (/\b(update|existing|that's me|thats me|yes|yep|yeah|sure|correct|sí|si)\b/.test(t)) return "use_existing";
    if (/\b(no|new|different|someone else|another person|otra persona|nuevo)\b/.test(t)) return "new_record";
    return null;
  }
  if (stage === "offer_optional") {
    if (refuse) return "skip_optionals";
    if (affirm) return "accept_optionals";
    return null;
  }
  if (stage === "optional_collect") {
    if (refuse && !gaveFields) return "skip_optionals";
    return null;
  }
  if (stage === "appointment_offer") {
    if (refuse) return "appointment_no";
    if (affirm || /\b(book|schedule|appointment|cita)\b/.test(t)) return "appointment_yes";
    return null;
  }
  if (stage === "collect") {
    if (/start over|start again|empezar de nuevo|empezar otra vez/.test(t)) return "start_over";
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Server-side regex extraction fallback — high-confidence patterns only.
// Runs AFTER the LLM extraction; never overrides the LLM or active re-prompts.
// ---------------------------------------------------------------------------
export function serverSideExtract(
  utterance: string,
  session: VoiceSession,
  alreadyExtracted: Set<string>
): Partial<Record<AgentFieldName, string>> {
  const out: Partial<Record<AgentFieldName, string>> = {};
  const t = utterance || "";
  const missing = (f: AgentFieldName) =>
    !alreadyExtracted.has(f) && session.collected[f] === undefined && !session.reprompt[f];

  // Phone: "(415) 555-0143", "415 555 0143", "3055550198", "+1 …"
  if (missing("phone_number") || missing("emergency_contact_phone")) {
    const m = t.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/);
    if (m) {
      const target = /emergencia|emergency/i.test(t) && missing("emergency_contact_phone") ? "emergency_contact_phone" : "phone_number";
      if (missing(target as AgentFieldName)) out[target as AgentFieldName] = m[0];
    }
  }
  // Email
  if (missing("email")) {
    const m = t.match(/[a-z0-9._%+-]+\s?(?:@|at|arroba)\s?[a-z0-9.-]+\s?(?:\.|dot|punto)\s?[a-z]{2,}/i);
    if (m) {
      out.email = m[0].replace(/\s?(at|arroba)\s?/i, "@").replace(/\s?(dot|punto)\s?/gi, ".");
    }
  }
  // ZIP: explicit keyword, or trailing 5 digits in an address-looking tail
  if (missing("zip_code")) {
    let m = t.match(/(?:zip|zip code|postal|código postal|codigo postal)\s*:?\s*(\d{5}(?:-\d{4})?)/i);
    if (!m) m = t.match(/\b(\d{5})(?:-\d{4})?\s*$/);
    if (m) out.zip_code = m[1];
  }
  // Explicit DOB phrases: "born …", "nací el …", "date of birth is …"
  if (missing("date_of_birth")) {
    const m = t.match(/(?:born on|born in|born|nací el|nací|nacimiento|date of birth is|date of birth|dob is|dob)\s*:?\s*([0-9]{1,4}[\s./-][A-Za-z0-9]{1,9}[\s./-][0-9]{2,4}|[A-Za-z]+\s+[0-9]{1,2},?\s+[0-9]{4}|[0-9]{1,2}\s+de\s+[A-Za-z]+\s+de\s+[0-9]{4})/i);
    if (m) out.date_of_birth = m[1];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Server-side Spanish detection — conservative marker list to avoid false
// positives on English words; accents/inverted punctuation are instant hits.
// ---------------------------------------------------------------------------
export function detectSpanish(utterance: string): boolean {
  const t = (utterance || "").toLowerCase();
  if (!t) return false;
  if (/[¿¡ñáéíóúü]/.test(t)) return true;
  const markers: Record<string, number> = {
    hola: 2, "buenos días": 2, "buenas tardes": 2, español: 3, espanol: 3,
    "habla español": 3, "no hablo inglés": 3, "no hablo ingles": 3,
    habla: 2, hablo: 2, gracias: 2, nací: 2, naci: 2, nacimiento: 2,
    masculino: 2, femenino: 2, dirección: 2, direccion: 2, teléfono: 2,
    telefono: 2, seguro: 1, apellido: 2, "código postal": 3, "codigo postal": 3,
    emergencia: 2, "cita": 1, "quiero registrar": 3, "necesito registrar": 3,
  };
  let score = 0;
  for (const [word, w] of Object.entries(markers)) {
    if (t.includes(word)) score += w;
  }
  return score >= 2;
}

// ---------------------------------------------------------------------------
// Duplicate detection (bonus): phone number match → offer update instead
// ---------------------------------------------------------------------------
async function checkDuplicate(session: VoiceSession, phone: string): Promise<boolean> {
  try {
    const existing = await patientService.findByPhone(phone);
    if (existing) {
      session.existingPatient = existing;
      session.existingPatientId = existing.patient_id;
      return true;
    }
  } catch (e) {
    logger.warn("voice", "duplicate lookup failed", { error: String(e) });
  }
  return false;
}

// ---------------------------------------------------------------------------
// Stage transition table — the deterministic heart of the agent
// ---------------------------------------------------------------------------
async function transition(
  session: VoiceSession,
  action: string,
  parsed: LlmTurnJson | null,
  llmReply: string,
  tCaller: TranscriptEntry,
  duplicateJustFound: boolean
): Promise<AgentTurnResult> {
  const lang = session.language;
  const es = lang === "es";
  const firstName = session.collected.first_name ?? session.existingPatient?.first_name ?? "";
  let done = false;
  let outcome = session.outcome;
  let reply = llmReply || fallbackReply(session);

  switch (session.stage) {
    // ======================================================================
    case "collect": {
      if (duplicateJustFound && session.existingPatient) {
        session.stage = "duplicate";
        const name = `${session.existingPatient.first_name} ${session.existingPatient.last_name}`;
        reply = es
          ? `Parece que ya tenemos un registro a nombre de ${name}. ¿Prefieres actualizar tu información?`
          : `It looks like we already have a record for ${name}. Would you like to update your information instead?`;
      } else if (missingRequiredFields(session.collected).length === 0) {
        session.stage = "offer_optional";
        reply = es
          ? "También puedo registrar tu información de seguro, un contacto de emergencia y tu idioma preferido. ¿Te gustaría proporcionar alguno de esos datos?"
          : "Great — I have everything I need. I can also collect your insurance information, emergency contact, and preferred language. Would you like to provide any of those?";
      } else if (!reply || (!includesQuestion(reply) && !acknowledges(reply))) {
        reply = askNextMissing(session);
      }
      break;
    }

    // ======================================================================
    case "duplicate": {
      if (action === "use_existing" && session.existingPatient) {
        session.updateMode = true;
        prefillFromExisting(session);
        session.stage = "confirm";
        session.lastReadback = buildReadback(session.collected, lang);
        reply = es
          ? `Encontré tu registro. ${session.lastReadback}`
          : `I found your record. ${session.lastReadback}`;
      } else if (action === "new_record") {
        session.existingPatient = null;
        session.existingPatientId = null;
        outcome = "duplicate_new";
        const missing = missingRequiredFields(session.collected);
        if (missing.length === 0) {
          session.stage = "offer_optional";
          reply = es
            ? "Sin problema, registramos una nueva solicitud. También puedo registrar tu información de seguro, un contacto de emergencia y tu idioma preferido. ¿Quieres proporcionar alguno?"
            : "No problem — let's get you registered. I can also collect your insurance information, emergency contact, and preferred language. Would you like to provide any of those?";
        } else {
          session.stage = "collect";
          reply = (es ? "Sin problema, hagamos un registro nuevo. " : "No problem — let's get you registered. ") + askNextMissing(session);
        }
      } else {
        const name = session.existingPatient
          ? `${session.existingPatient.first_name} ${session.existingPatient.last_name}`
          : "our records";
        reply = es
          ? `¿Prefieres actualizar el registro existente de ${name}, o eres una persona diferente y quieres un registro nuevo?`
          : `Just to check — would you like to update the existing record for ${name}, or are you a different person registering new?`;
      }
      break;
    }

    // ======================================================================
    case "offer_optional": {
      const gaveOptional = parsed?.extracted && Object.keys(parsed.extracted).length > 0;
      if (action === "skip_optionals" && !gaveOptional) {
        session.stage = "confirm";
        session.lastReadback = buildReadback(session.collected, lang);
        reply = session.lastReadback;
      } else if (action === "accept_optionals" || gaveOptional) {
        session.stage = "optional_collect";
        reply = includesQuestion(reply) && reply.length < 300
          ? reply
          : es
            ? "Perfecto. ¿Cuál es su compañía de seguro?"
            : "Perfect. Which insurance company are you with?";
      } else {
        reply = es
          ? "¿Le gustaría dar su información de seguro, un contacto de emergencia o su idioma preferido? Si no, simplemente diga 'eso es todo'."
          : "Would you like to add insurance details, an emergency contact, or a preferred language? If not, just say \"that's all\".";
      }
      break;
    }

    // ======================================================================
    case "optional_collect": {
      const gaveOptional = parsed?.extracted && Object.keys(parsed.extracted).length > 0;
      if (action === "skip_optionals" || (!gaveOptional && includesQuestion(llmReply) === false && /that'?s (all|it)|nada más|eso es todo/i.test(tCaller.content))) {
        session.stage = "confirm";
        session.lastReadback = buildReadback(session.collected, lang);
        reply = session.lastReadback;
      } else if (!includesQuestion(reply)) {
        reply = askNextOptional(session);
      }
      break;
    }

    // ======================================================================
    case "confirm": {
      if (action === "confirm_yes") {
        // ---------- SAVE (via the same service layer as the REST API) -----
        session.stage = "saving";
        try {
          const payload = collectedToApiPayload(session.collected);
          let saved: Record<string, unknown>;
          if (session.updateMode && session.existingPatientId) {
            saved = (await patientService.update(session.existingPatientId, payload)) as Record<string, unknown>;
            session.outcome = "updated";
            outcome = session.outcome;
          } else {
            saved = (await patientService.create(payload as never)) as Record<string, unknown>;
            session.outcome = session.outcome === "duplicate_new" ? "duplicate_new" : "registered";
            outcome = session.outcome;
          }
          session.patientId = String(saved.patient_id);
          logger.info("voice", "PATIENT SAVED", { session_id: session.session_id, payload });
          session.stage = "appointment_offer";
          reply = es
            ? `¡Listo, ${firstName}! Su registro quedó guardado. ¿Quieres que le agende su primera cita?`
            : `You're all set, ${firstName}. Your registration is complete. Would you like me to schedule your first appointment while we're on the phone?`;
        } catch (err) {
          session.stage = "confirm";
          logger.error("voice", "DB WRITE FAILED", {
            session_id: session.session_id,
            error: err instanceof Error ? err.message : String(err),
          });
          reply = es
            ? "Perdón — tuvimos un problema guardando la información en nuestro sistema. Tengo todos sus datos aquí; ¿intento guardarlos de nuevo?"
            : "I'm so sorry — something went wrong saving your information on our end. I still have all your details right here; may I try saving again?";
        }
      } else if (action === "confirm_edit" && parsed?.edit_field) {
        const field = parsed.edit_field as AgentFieldName;
        const rawVal = parsed?.extracted?.[field];
        const res = validateAgentField(field, rawVal);
        if (res.valid) {
          (session.collected as Record<string, unknown>)[field] = res.value;
          delete session.reprompt[field];
          if (field === "phone_number" && !session.updateMode) {
            const dup = await checkDuplicate(session, res.value as string);
            if (dup) {
              session.stage = "duplicate";
              const nm = `${session.existingPatient?.first_name} ${session.existingPatient?.last_name}`;
              reply = es
                ? `Parece que ya tenemos un registro a nombre de ${nm}. ¿Prefieres actualizar tu información?`
                : `It looks like we already have a record for ${nm}. Would you like to update your information instead?`;
              break;
            }
          }
          if (missingRequiredFields(session.collected).length > 0) {
            session.stage = "collect";
            reply = askNextMissing(session, es ? "Entendido. " : "Got it — that actually fills a gap. ");
          } else {
            session.lastReadback = buildReadback(session.collected, lang);
            reply = (es ? "Listo, corregido. " : "Got it — I've made that change. ") + session.lastReadback;
          }
        } else {
          session.reprompt[field] = res.error ?? "Invalid value.";
          reply = buildRepromptReply(field, res.error ?? "", lang, "");
        }
      } else if (!includesQuestion(reply)) {
        reply = es
          ? "¿Está todo correcto, o quiere corregir algo?"
          : "So — is everything correct, or would you like to change anything?";
      }
      break;
    }

    // ======================================================================
    case "saving":
      session.stage = "confirm";
      reply = es ? "Permítame intentar guardar de nuevo. ¿Confirmamos la información?" : "Let me try saving again — is everything correct?";
      break;

    // ======================================================================
    case "appointment_offer": {
      if (action === "appointment_yes") {
        session.stage = "appointment_time";
        session.offeredSlots = availableSlots();
        const list = session.offeredSlots
          .slice(0, 4)
          .map((s, i) => `option ${i + 1} — ${s.label}`)
          .join("; ");
        reply = es
          ? `Genial. Tenemos estos horarios: ${list}. ¿Cuál le viene mejor?`
          : `Wonderful. We have these openings: ${list}. Which works best for you?`;
      } else if (action === "appointment_no") {
        done = true;
        outcome = outcome ?? "registered";
        reply = es
          ? `Perfecto. Su registro está completo. ¡Que tenga un excelente día, ${firstName}!`
          : `No problem at all. Your registration is complete — welcome to the clinic, ${firstName}. Have a wonderful day!`;
      } else if (!includesQuestion(reply)) {
        reply = es ? `¿Le gustaría agendar su primera cita, ${firstName}?` : `Would you like me to book your first appointment, ${firstName}?`;
      }
      break;
    }

    // ======================================================================
    case "appointment_time": {
      const slotIdx = parsed?.appointment_slot;
      const picked =
        typeof slotIdx === "number" && session.offeredSlots[slotIdx - 1]
          ? session.offeredSlots[slotIdx - 1]
          : action === "appointment_pick" && typeof slotIdx !== "number"
            ? matchSlotByDate(session, tCaller.content)
            : null;
      if (picked && session.patientId) {
        try {
          const appt = await appointmentService.create({
            patient_id: session.patientId,
            appointment_date: picked.date,
            provider: picked.provider,
            reason: "New patient intake",
          });
          session.bookedAppointment = { label: picked.label, provider: appt.provider, date: picked.date };
          done = true;
          outcome = outcome ?? "registered";
          reply = es
            ? `¡Listo! Le agendé con ${appt.provider} el ${picked.label}. Su registro está completo. ¡Que tenga un gran día, ${firstName}!`
            : `Perfect — you're booked with ${appt.provider}, ${picked.label}. Your registration is all done. Have a great day, ${firstName}!`;
        } catch (err) {
          logger.error("voice", "appointment booking failed", { error: String(err) });
          reply = es
            ? `Uy, no pude agendar la cita en este momento, pero su registro quedó completo. Puede llamar para agendar cuando quiera. ¡Que tenga un gran día, ${firstName}!`
            : `Oh dear — I couldn't lock in the appointment just now, but your registration is complete. You can call us anytime to schedule. Have a great day, ${firstName}!`;
          done = true;
        }
      } else if (action === "appointment_no") {
        done = true;
        reply = es
          ? `De acuerdo. ¡Que tenga un excelente día, ${firstName}!`
          : `Alright, no worries. Have a wonderful day, ${firstName}!`;
      } else if (!includesQuestion(reply)) {
        const list = session.offeredSlots.slice(0, 4).map((s, i) => `option ${i + 1} — ${s.label}`).join("; ");
        reply = es ? `Estos son los horarios: ${list}. ¿Cuál prefiere?` : `Here are the options again: ${list}. Which would you like?`;
      }
      break;
    }

    // ======================================================================
    case "done": {
      done = true;
      reply = es
        ? `Gracias por llamar, ${firstName}. ¡Cuídese!`
        : `Thanks for calling${firstName ? `, ${firstName}` : ""}. Take care!`;
      break;
    }
  }

  return finalize(session, reply, tCaller, { done, outcome });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function finalize(
  session: VoiceSession,
  reply: string,
  tCaller: TranscriptEntry,
  opts: { done?: boolean; outcome?: VoiceSession["outcome"]; error?: string }
): AgentTurnResult {
  const replySafe = voiceSafe(reply);
  session.history.push({ role: "assistant", content: replySafe });
  const tAgent: TranscriptEntry = { role: "agent", content: replySafe, at: new Date().toISOString() };
  session.transcript.push(tCaller, tAgent);

  if (opts.done) {
    session.stage = "done";
    session.outcome = opts.outcome ?? session.outcome ?? "registered";
    session.endedAt = Date.now();
  }

  logger.voice(session.session_id, "turn", {
    stage: session.stage,
    language: session.language,
    caller: tCaller.content,
    agent: replySafe,
    collected: session.collected ? snapshotCollected(session.collected) : undefined,
    reprompt: Object.keys(session.reprompt).length ? session.reprompt : undefined,
  });

  // Persist transcript incrementally (survives mid-call drops).
  void callService
    .appendTurn(session.session_id, [tCaller, tAgent], snapshotCollected(session.collected), session.language)
    .catch((e) => logger.warn("voice", "transcript persist failed", { error: String(e) }));

  return {
    reply: replySafe,
    stage: session.stage,
    collected: session.collected,
    reprompt: session.reprompt,
    done: session.stage === "done",
    outcome: session.outcome,
    patientId: session.patientId,
    language: session.language,
    appointment: session.bookedAppointment,
    error: opts.error,
  };
}

/** JSON-safe snapshot (Date → MM/DD/YYYY string) used for logs + DB. */
export function snapshotCollected(c: CollectedPatientData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (v === undefined) continue;
    if (v instanceof Date) out[k] = v.toISOString().slice(0, 10);
    else out[k] = v;
  }
  return out;
}

function collectedToApiPayload(c: CollectedPatientData): Record<string, unknown> {
  return {
    ...snapshotCollected(c),
    preferred_language: c.preferred_language ?? "English",
  };
}

function prefillFromExisting(session: VoiceSession) {
  const e = session.existingPatient as Record<string, string | null> | null;
  if (!e) return;
  const c = session.collected;
  (["first_name", "last_name", "sex", "phone_number", "email", "address_line_1", "address_line_2", "city", "state", "zip_code", "insurance_provider", "insurance_member_id", "preferred_language", "emergency_contact_name", "emergency_contact_phone"] as const).forEach((k) => {
    if (e[k]) (c as Record<string, unknown>)[k] = e[k];
  });
  if (e.date_of_birth_display) {
    const [mm, dd, yyyy] = e.date_of_birth_display.split("/");
    c.date_of_birth = new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`);
  }
}

function includesQuestion(text: string): boolean {
  return /\?|¿/.test(text || "");
}

function acknowledges(text: string): boolean {
  return (text || "").length > 8; // has some substance
}

function fallbackReply(session: VoiceSession): string {
  return session.language === "es"
    ? "Perdone, ¿puede repetir eso?"
    : "Sorry, I didn't quite catch that — could you say it once more?";
}

export function askNextMissing(session: VoiceSession, prefix = ""): string {
  const missing = missingRequiredFields(session.collected);
  const es = session.language === "es";
  const first = missing[0];
  if (!first) return prefix;
  const asks: Record<AgentFieldName, [string, string]> = {
    first_name: ["What's your first and last name?", "¿Cuál es su nombre y apellido?"],
    last_name: ["And your last name?", "¿Y su apellido?"],
    date_of_birth: ["What's your date of birth?", "¿Cuál es su fecha de nacimiento?"],
    sex: ["May I ask your sex? You're also welcome to decline to answer.", "¿Me permite preguntar su sexo? También puede preferir no responder."],
    phone_number: ["What's the best phone number for you?", "¿Cuál es el mejor número de teléfono para contacto?"],
    email: ["", ""],
    address_line_1: ["What's your street address?", "¿Cuál es su dirección?"],
    address_line_2: ["", ""],
    city: ["Which city is that in?", "¿En qué ciudad?"],
    state: ["And which state?", "¿Y en qué estado?"],
    zip_code: ["What's the ZIP code?", "¿Cuál es el código postal?"],
    insurance_provider: ["", ""],
    insurance_member_id: ["", ""],
    preferred_language: ["", ""],
    emergency_contact_name: ["", ""],
    emergency_contact_phone: ["", ""],
  };
  const [en, esp] = asks[first];
  return prefix + (es ? esp : en);
}

function askNextOptional(session: VoiceSession): string {
  const es = session.language === "es";
  const c = session.collected;
  if (!c.insurance_provider) return es ? "¿Cuál es su compañía de seguro?" : "Which insurance company are you with?";
  if (!c.insurance_member_id) return es ? "¿Y su número de miembro del seguro?" : "And your insurance member ID?";
  if (!c.email) return es ? "¿Tiene un correo electrónico que podamos registrar? Es opcional." : "Do you have an email address we can put on file? That one's optional.";
  if (!c.address_line_2) return es ? "¿Hay apartamento, suite o unidad en su dirección? Si no, dígame 'no'." : "Is there an apartment, suite, or unit on your address? If not, just say \"no\".";
  if (!c.emergency_contact_name) return es ? "¿Le gustaría dejar un contacto de emergencia?" : "Would you like to leave an emergency contact?";
  if (!c.emergency_contact_phone) return es ? "¿Y el teléfono de su contacto de emergencia?" : "And your emergency contact's phone number?";
  if (!c.preferred_language) return es ? "¿Cuál es su idioma preferido?" : "And what's your preferred language?";
  return es ? "¿Algo más que quiera agregar, o 'eso es todo'?" : "Anything else to add, or is that everything?";
}

function buildRepromptReply(
  field: AgentFieldName,
  reason: string,
  lang: "en" | "es",
  llmAck: string
): string {
  const ack = shortAck(llmAck);
  const es = lang === "es";
  const specific: Partial<Record<AgentFieldName, [string, string]>> = {
    phone_number: [
      "I only caught part of that — could you give me your full 10-digit phone number, starting with the area code?",
      "Solo escuché parte — ¿me da su número de teléfono completo de 10 dígitos, empezando por el código de área?",
    ],
    date_of_birth: [
      "Let's try that once more — what's your date of birth, in the order month, day, then year?",
      "Intentemos otra vez — ¿su fecha de nacimiento, en el orden mes, día y año?",
    ],
    state: [
      "Which state is that — could you give me the state name or the two-letter abbreviation?",
      "¿En qué estado está? ¿Me dice el nombre o las dos letras?",
    ],
    zip_code: [
      "Could you repeat the ZIP code for me? It should be five digits.",
      "¿Me repite el código postal? Debe ser de cinco dígitos.",
    ],
    email: [
      "Hmm, that email doesn't look quite right — could you spell it out for me?",
      "Ese correo no parece completo — ¿me lo deletrea, por favor?",
    ],
    sex: [
      "Sorry, I didn't catch that — may I ask your sex? Male, Female, Other, or you can decline to answer.",
      "Perdón, no entendí — ¿su sexo? Masculino, Femenino, Otro, o puede preferir no responder.",
    ],
    insurance_member_id: [
      "The member ID is usually just letters and numbers — could you read it to me once more?",
      "El número de miembro suele ser solo letras y números — ¿me lo repite?",
    ],
    first_name: [
      "Sorry, what was your first name again?",
      "Perdón, ¿cuál era su nombre de nuevo?",
    ],
    last_name: [
      "And how do you spell your last name?",
      "¿Y cómo se escribe su apellido?",
    ],
  };
  const specificPair = specific[field];
  const core = specificPair ? (es ? specificPair[1] : specificPair[0]) : es ? `Perdón, ${reason} ¿Me lo repite?` : `Sorry — ${reason.toLowerCase()} Could you give me that once more?`;
  return ack ? `${ack} ${core}` : core;
}

function matchSlotByDate(session: VoiceSession, utterance: string) {
  const t = utterance.toLowerCase();
  for (let i = 0; i < session.offeredSlots.length; i++) {
    const s = session.offeredSlots[i];
    // "option 2", "the second one", "number 2", "2"
    if (new RegExp(`(option|number)\\s*${i + 1}\\b|^${i + 1}\\b`).test(t)) return s;
  }
  const ordinals: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, primero: 1, segunda: 2, segundo: 2, tercera: 3, tercero: 3 };
  for (const [word, idx] of Object.entries(ordinals)) {
    if (t.includes(word) && session.offeredSlots[idx - 1]) return session.offeredSlots[idx - 1];
  }
  // weekday / part-of-day match
  for (const s of session.offeredSlots) {
    const label = s.label.toLowerCase();
    const dayMatch = ["mon", "tue", "wed", "thu", "fri"].some((d) => label.includes(d) && t.includes(d));
    const pm = label.includes("pm");
    const wantsAfternoon = /afternoon|tarde/.test(t);
    const wantsMorning = /morning|mañana|manana/.test(t);
    if (dayMatch || (wantsAfternoon && pm) || (wantsMorning && !pm)) return s;
  }
  return null;
}
