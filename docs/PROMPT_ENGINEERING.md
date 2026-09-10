# Prompt Engineering — Voice Agent Design Notes

> The voice agent’s prompt lives in [`src/lib/voice/prompts.ts`](../src/lib/voice/prompts.ts),
> fully commented. This document explains *why* it is built the way it is.

## 1. The problem being solved

The challenge scores **Conversational Quality** (natural, corrections, confirmation) and
**Working System** (data actually persisted, validations enforced) equally. A single monolithic
“just chat with an LLM” prompt fails the second: models skip confirmations, accept a 3-digit phone,
hallucinate bookings, and invent data. A rigid IVR fails the first by definition.

## 2. The split

| Owned by deterministic code (`agent.ts`) | Owned by the LLM (`prompts.ts` + z-ai SDK) |
|---|---|
| Stage machine: `collect → (duplicate) → offer_optional → (optional_collect) → confirm → saving → (appointment_offer → appointment_time) → done` | Wording of every in-stage question and acknowledgment |
| Field validation via the same Zod rules as the REST API | Mapping messy speech onto field values (extraction) |
| Building the read-back confirmation string (server-side, always complete/accurate) | Classifying intent: yes / no / edit / start-over / switch language / pick slot |
| Applying validated merges; rejecting invalid values with reasons | Handling corrections, tangents, and off-order answers gracefully |
| Duplicate lookup, save (create vs update), appointment booking | Keeping the voice experience human (≤3 short sentences, one question at a time) |

## 3. Prompt anatomy (rebuilt fresh every turn)

1. **Persona** — “Maya”, patient-intake coordinator; voice-first style rules (short sentences, one
   question at a time, never invent, never mention handled fields, roll with corrections).
2. **Field rules** — normalization targets per field (MM/DD/YYYY, 10-digit phone, 2-letter state,
   “prefer not to say” → `Decline to Answer`, spoken “at/dot” → email punctuation). Includes the
   instruction: *never extract a value you believe violates a rule — re-ask instead* (the LLM
   self-screens; the server still verifies everything).
3. **Response contract** — strict JSON: `{ reply, extracted, action, edit_field, language,
   appointment_slot }`, followed by **12 few-shot extraction examples** (EN + ES), including the
   challenge’s spelled-correction example (`D-A-V-I-S → confirm_edit`).
4. **Stage block** — stage-specific instructions with rubric-critical lines quoted nearly verbatim:
   the optional-fields offer (“I can also collect your insurance information, emergency contact, and
   preferred language. Would you like to provide any of those?”), the duplicate line (“It looks like
   we already have a record for …”), and the completion line (“You’re all set, [First Name].”).
5. **Live state** — collected fields, still-missing fields, **rejected fields + reasons** (drives the
   specific re-prompt), the confirmation script (confirm stage), available slots (slot stage),
   existing-record summary (duplicate stage), update-mode flag.
6. **History** — last 16 user/assistant turns so follow-ups like “wait, I meant May” work.

Spanish mode swaps the persona/rules/stage blocks for ES equivalents; the JSON contract stays
English-keyed for parsing stability. The confirmation read-back is generated server-side with
locale-aware dates (`formatDobForSpeech(lang)`) and translated sex values.

## 4. Why the server overrides the model in specific places

| Override | Reason |
|---|---|
| Rejected-field reply replacement | the challenge requires re-prompting *specifically for that field*; templates guarantee it (with the LLM’s short acknowledgment prepended when usable) |
| Stage-transition lines (offer/duplicate/completion/slot listing) | rubric quotes exact phrasing; templates match it word-for-word while remaining warm |
| Intent fallback (`detectIntent`) | when the LLM labels an utterance `auto`, bilingual regex detection infers confirm/decline/slot-pick — a mis-classification can never skip confirmation or hallucinate a booking |
| Regex extraction fallback (`serverSideExtract`) | recovers high-confidence phone/ZIP/email/DOB patterns the model occasionally misses (observed in live testing with Spanish input) |
| JSON repair + corrective retry | models occasionally emit prose/fenced JSON; smart quotes → straight quotes, trailing commas stripped, then one corrective retry, then prose salvage, then graceful failure |

## 5. Temperature/tone choices

- Persona asks for acknowledgment words (“Perfect”, “Got it”), ≤3 sentence replies, and never
  reciting rules — this keeps the read-back confirmations as the only long turns.
- The LLM is told to prefer one question at a time and to *acknowledge before advancing*, which
  is what makes the flow feel human rather than form-like.

## 6. How it is tested

`tests/voice-agent.test.ts` drives the full state machine with a **scripted fake LLM**
(dependency-injected `LlmFn`): happy path (offer → read-back → save → book), the challenge’s
3-digit-phone re-prompt, spelled-correction during confirmation, start-over, duplicate→update,
DB-failure grace, and deterministic Spanish switching. This means prompt/flow regressions are
caught without any network calls.
