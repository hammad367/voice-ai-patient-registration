// ============================================================================
// GET    /api/patients/:id — retrieve by patient_id (UUID)
// PUT    /api/patients/:id — partial update allowed
// DELETE /api/patients/:id — SOFT delete (sets deleted_at; never hard-deletes)
// Codes: 200, 400, 404, 422, 500
// ============================================================================

import { NextRequest } from "next/server";
import { ok, fail, handleRoute, parseJsonBody, ApiError } from "@/lib/api-utils";
import { patientUpdateSchema } from "@/lib/validation/patient";
import { patientService } from "@/lib/services/patient-service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(id: string) {
  if (!UUID_RE.test(id)) throw new ApiError("patient_id must be a valid UUID.", 400);
}

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return handleRoute(req, "/api/patients/:id", async () => {
    const { id } = await ctx.params;
    assertUuid(id);
    const patient = await patientService.getById(id);
    if (!patient) return fail("Patient not found.", 404);
    return ok(patient);
  });
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  return handleRoute(req, "/api/patients/:id", async () => {
    const { id } = await ctx.params;
    assertUuid(id);
    const body = await parseJsonBody(req);
    const parsed = patientUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return fail("Validation failed.", 422, parsed.error.issues.map((i) => ({
        field: i.path.join("."),
        message: i.message,
      })));
    }
    if (Object.keys(parsed.data).length === 0) {
      return fail("Provide at least one field to update.", 400);
    }
    const updated = await patientService.update(id, parsed.data);
    return ok(updated);
  });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  return handleRoute(req, "/api/patients/:id", async () => {
    const { id } = await ctx.params;
    assertUuid(id);
    const result = await patientService.softDelete(id);
    return ok(result);
  });
}
