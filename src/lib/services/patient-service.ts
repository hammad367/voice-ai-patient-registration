// ============================================================================
// Patient Service — the single data-access layer shared by:
//   • the REST API routes (/api/patients...)
//   • the Voice Agent engine (challenge §5: "or directly invoke the same
//     service layer")
//   • the telephony webhooks
// ============================================================================

import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-utils";
import {
  PatientCreateInput,
  PatientUpdateInput,
  canonicalizePatientInput,
} from "@/lib/validation/patient";

export type PatientRecord = Awaited<ReturnType<typeof db.patient.findFirstOrThrow>>;

function serialize(p: PatientRecord) {
  return {
    patient_id: p.patient_id,
    first_name: p.first_name,
    last_name: p.last_name,
    date_of_birth: p.date_of_birth.toISOString().slice(0, 10), // YYYY-MM-DD (JSON-safe)
    date_of_birth_display: p.date_of_birth.toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }),
    sex: p.sex,
    phone_number: p.phone_number,
    email: p.email,
    address_line_1: p.address_line_1,
    address_line_2: p.address_line_2,
    city: p.city,
    state: p.state,
    zip_code: p.zip_code,
    insurance_provider: p.insurance_provider,
    insurance_member_id: p.insurance_member_id,
    preferred_language: p.preferred_language,
    emergency_contact_name: p.emergency_contact_name,
    emergency_contact_phone: p.emergency_contact_phone,
    created_at: p.created_at.toISOString(),
    updated_at: p.updated_at.toISOString(),
    deleted_at: p.deleted_at?.toISOString() ?? null,
  };
}

export const patientService = {
  serialize,

  /** List patients. Optional filters: last_name, date_of_birth, phone_number. */
  async list(filters: {
    last_name?: string;
    date_of_birth?: string;
    phone_number?: string;
  }): Promise<unknown[]> {
    const where = {
      deleted_at: null,
      ...(filters.last_name
        ? { last_name: { equals: filters.last_name.trim(), } }
        : {}),
      ...(filters.phone_number
        ? { phone_number: filters.phone_number.replace(/\D/g, "").slice(-10) }
        : {}),
      ...(filters.date_of_birth ? { date_of_birth: new Date(filters.date_of_birth + "T00:00:00.000Z") } : {}),
    };
    const rows = await db.patient.findMany({ where, orderBy: { created_at: "desc" } });
    return rows.map(serialize);
  },

  /** Get a single patient by UUID (soft-deleted patients read as 404). */
  async getById(patientId: string) {
    const p = await db.patient.findFirst({
      where: { patient_id: patientId, deleted_at: null },
    });
    return p ? serialize(p) : null;
  },

  /** Find active patients matching a phone number (duplicate detection bonus). */
  async findByPhone(phoneNumber10: string) {
    return db.patient.findFirst({
      where: { phone_number: phoneNumber10, deleted_at: null },
      orderBy: { created_at: "desc" },
    });
  },

  /** Create a patient. Returns the created record with patient_id. */
  async create(input: PatientCreateInput) {
    const data = canonicalizePatientInput(input);
    const p = await db.patient.create({
      data: data as { [K in keyof PatientCreateInput]: any },
    });
    return serialize(p);
  },

  /** Partial update by patient_id. Throws 404 when missing/soft-deleted. */
  async update(patientId: string, input: PatientUpdateInput) {
    const existing = await db.patient.findFirst({
      where: { patient_id: patientId, deleted_at: null },
    });
    if (!existing) throw new ApiError("Patient not found.", 404);
    const data = canonicalizePatientInput(input);
    const p = await db.patient.update({
      where: { patient_id: patientId },
      data: data as { [K in keyof PatientUpdateInput]?: any },
    });
    return serialize(p);
  },

  /** SOFT delete — sets deleted_at; never hard-deletes (challenge §4). */
  async softDelete(patientId: string) {
    const existing = await db.patient.findFirst({
      where: { patient_id: patientId, deleted_at: null },
    });
    if (!existing) throw new ApiError("Patient not found.", 404);
    await db.patient.update({
      where: { patient_id: patientId },
      data: { deleted_at: new Date() },
    });
    return { patient_id: patientId, deleted: true, deleted_at: new Date().toISOString() };
  },

  /** Dashboard stats. */
  async stats() {
    const [total, deleted, appointments, calls] = await Promise.all([
      db.patient.count({ where: { deleted_at: null } }),
      db.patient.count({ where: { deleted_at: { not: null } } }),
      db.appointment.count(),
      db.callSession.count(),
    ]);
    return { total_patients: total, deleted_patients: deleted, total_appointments: appointments, total_calls: calls };
  },
};
