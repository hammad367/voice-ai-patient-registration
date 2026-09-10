// ============================================================================
// GET  /api/appointments — list (bonus feature)
// POST /api/appointments — create { patient_id, appointment_date, provider? }
// GET  /api/appointments/slots — mock availability
// ============================================================================

import { NextRequest } from "next/server";
import { ok, fail, handleRoute, parseJsonBody } from "@/lib/api-utils";
import { appointmentService, availableSlots } from "@/lib/services/appointment-service";

export async function GET(req: NextRequest) {
  return handleRoute(req, "/api/appointments", async () => {
    if (req.nextUrl.searchParams.get("slots") === "1") {
      return ok({ slots: availableSlots(6) });
    }
    const appointments = await appointmentService.list(100);
    return ok({ appointments, count: appointments.length });
  });
}

export async function POST(req: NextRequest) {
  return handleRoute(req, "/api/appointments", async () => {
    const body = (await parseJsonBody(req)) as Record<string, unknown>;
    if (typeof body.patient_id !== "string" || typeof body.appointment_date !== "string") {
      return fail("patient_id and appointment_date are required.", 400);
    }
    const created = await appointmentService.create({
      patient_id: body.patient_id,
      appointment_date: body.appointment_date,
      provider: typeof body.provider === "string" ? body.provider : undefined,
      reason: typeof body.reason === "string" ? body.reason : undefined,
    });
    return ok(created, 201);
  });
}
