// ============================================================================
// Appointment Service — bonus feature: after registration the agent offers to
// schedule a first appointment with mock providers/slots.
// ============================================================================

import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-utils";
import { sanitizeText } from "@/lib/validation/patient";

/** Mock provider book — deterministic "slots" for the demo. */
export const PROVIDERS = [
  "Dr. Amara Okafor — Family Medicine",
  "Dr. Daniel Reyes — Internal Medicine",
  "Dr. Sarah Chen — Pediatrics",
];

/** Returns the next N business-day morning/afternoon mock slots. */
export function availableSlots(count = 6) {
  const slots: { label: string; date: string }[] = [];
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  let added = 0;
  while (added < count) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day === 0 || day === 6) continue; // skip weekends
    const morning = new Date(d); morning.setUTCHours(15, 0, 0, 0); // 9am ET ≈ 15:00 UTC
    const afternoon = new Date(d); afternoon.setUTCHours(20, 0, 0, 0); // 2pm ET
    for (const s of [morning, afternoon]) {
      if (slots.length < count) {
        slots.push({
          label: s.toLocaleString("en-US", {
            weekday: "short", month: "short", day: "numeric",
            hour: "numeric", minute: "2-digit", timeZone: "America/New_York",
          }),
          date: s.toISOString(),
        });
      }
    }
    added++;
  }
  return slots;
}

export const appointmentService = {
  async list(limit = 100) {
    const rows = await db.appointment.findMany({
      orderBy: { appointment_date: "asc" },
      take: limit,
      include: {
        patient: {
          select: { patient_id: true, first_name: true, last_name: true, phone_number: true },
        },
      },
    });
    return rows.map((a) => ({
      id: a.id,
      patient_id: a.patient_id,
      patient_name: a.patient ? `${a.patient.first_name} ${a.patient.last_name}` : null,
      patient_phone: a.patient?.phone_number ?? null,
      appointment_date: a.appointment_date.toISOString(),
      provider: a.provider,
      reason: a.reason,
      status: a.status,
      created_at: a.created_at.toISOString(),
    }));
  },

  async create(input: { patient_id: string; appointment_date: string; provider?: string; reason?: string }) {
    const patient = await db.patient.findFirst({
      where: { patient_id: input.patient_id, deleted_at: null },
    });
    if (!patient) throw new ApiError("Patient not found.", 404);

    const date = new Date(input.appointment_date);
    if (Number.isNaN(date.getTime())) throw new ApiError("appointment_date must be a valid ISO datetime.", 400);
    if (date.getTime() < Date.now()) throw new ApiError("appointment_date cannot be in the past.", 422);

    const a = await db.appointment.create({
      data: {
        patient_id: input.patient_id,
        appointment_date: date,
        provider: sanitizeText(input.provider ?? PROVIDERS[0], 120) || PROVIDERS[0],
        reason: sanitizeText(input.reason ?? "New patient intake", 200) || "New patient intake",
      },
    });
    return {
      id: a.id,
      patient_id: a.patient_id,
      appointment_date: a.appointment_date.toISOString(),
      provider: a.provider,
      reason: a.reason,
      status: a.status,
      created_at: a.created_at.toISOString(),
    };
  },
};
