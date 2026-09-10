// ============================================================================
// Shared demo-data seeding — used by BOTH:
//   • prisma/seed.ts (manual / build-time CLI seeding)
//   • src/lib/db-bootstrap.ts (runtime self-provisioning on serverless hosts)
// Idempotent: seeds only when the patients table is empty, and uses a Postgres
// advisory lock inside the transaction so concurrent serverless cold-starts
// cannot double-seed. Data is fictional (challenge FAQ: demo data only).
// ============================================================================

import type { PrismaClient } from "@prisma/client";

export async function seedDemoDataIfEmpty(prisma: PrismaClient): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    // Serialize concurrent cold-start seeds on Postgres. SQLite (local dev)
    // does not support advisory locks — single process there, so ignore.
    try {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(727411)`;
    } catch {
      /* non-Postgres: no lock available, not needed locally */
    }

    const count = await tx.patient.count();
    if (count > 0) return false;

    const jane = await tx.patient.create({
      data: {
        first_name: "Jane",
        last_name: "Doe",
        date_of_birth: new Date("1990-04-12T00:00:00.000Z"),
        sex: "Female",
        phone_number: "4155550101",
        email: "jane.doe@example.com",
        address_line_1: "123 Market Street",
        address_line_2: "Apt 4B",
        city: "San Francisco",
        state: "CA",
        zip_code: "94103",
        insurance_provider: "BlueCross BlueShield",
        insurance_member_id: "BCB8842109",
        preferred_language: "English",
        emergency_contact_name: "John Doe",
        emergency_contact_phone: "4155550102",
      },
    });

    await tx.patient.create({
      data: {
        first_name: "Carlos",
        last_name: "Garcia",
        date_of_birth: new Date("1985-11-30T00:00:00.000Z"),
        sex: "Male",
        phone_number: "3055550198",
        address_line_1: "800 Coral Way",
        city: "Miami",
        state: "FL",
        zip_code: "33130",
        preferred_language: "Spanish",
      },
    });

    await tx.appointment.create({
      data: {
        patient_id: jane.patient_id,
        appointment_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        provider: "Dr. Amara Okafor, Family Medicine",
        reason: "New patient intake",
      },
    });

    return true;
  });
}
