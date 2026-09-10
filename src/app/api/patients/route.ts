// ============================================================================
// GET  /api/patients   — list (filters: ?last_name= &date_of_birth= &phone_number=)
// POST /api/patients   — create (challenge: returns created record w/ patient_id)
// Envelope: { data, error } ; codes: 200, 201, 400, 422, 500
// ============================================================================

import { NextRequest } from "next/server";
import { ok, fail, handleRoute, parseJsonBody, rateLimit, clientKey } from "@/lib/api-utils";
import { patientCreateSchema, sanitizeText } from "@/lib/validation/patient";
import { patientService } from "@/lib/services/patient-service";

export async function GET(req: NextRequest) {
  return handleRoute(req, "/api/patients", async () => {
    if (!rateLimit(clientKey(req, "patients:list"), 120, 60_000)) {
      return fail("Too many requests — please slow down.", 429);
    }
    const sp = req.nextUrl.searchParams;
    const last_name = sp.get("last_name") ?? undefined;
    const date_of_birth = sp.get("date_of_birth") ?? undefined;
    const phone_number = sp.get("phone_number") ?? undefined;

    if (date_of_birth && !/^\d{4}-\d{2}-\d{2}$/.test(date_of_birth)) {
      return fail("date_of_birth filter must be YYYY-MM-DD.", 400);
    }

    const patients = await patientService.list({
      last_name: last_name ? sanitizeText(last_name, 50) : undefined,
      date_of_birth,
      phone_number: phone_number ? sanitizeText(phone_number, 30) : undefined,
    });
    return ok({ patients, count: patients.length });
  });
}

export async function POST(req: NextRequest) {
  return handleRoute(req, "/api/patients", async () => {
    if (!rateLimit(clientKey(req, "patients:create"), 30, 60_000)) {
      return fail("Too many requests — please slow down.", 429);
    }
    const body = await parseJsonBody(req);
    const parsed = patientCreateSchema.safeParse(body);
    if (!parsed.success) {
      // 422 Unprocessable Entity — semantically precise validation failure
      return fail("Validation failed.", 422, parsed.error.issues.map((i) => ({
        field: i.path.join("."),
        message: i.message,
      })));
    }
    const created = await patientService.create(parsed.data);
    return ok(created, 201);
  });
}
