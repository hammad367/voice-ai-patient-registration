// ============================================================================
// GET /api/stats — dashboard aggregate counters
// ============================================================================

import { NextRequest } from "next/server";
import { ok, handleRoute } from "@/lib/api-utils";
import { patientService } from "@/lib/services/patient-service";

export async function GET(req: NextRequest) {
  return handleRoute(req, "/api/stats", async () => {
    const stats = await patientService.stats();
    return ok({ ...stats, generated_at: new Date().toISOString() });
  });
}
