// ============================================================================
// GET /api/calls     — list call sessions (observability: transcripts)
// ============================================================================

import { NextRequest } from "next/server";
import { ok, handleRoute } from "@/lib/api-utils";
import { callService } from "@/lib/services/call-service";

export async function GET(req: NextRequest) {
  return handleRoute(req, "/api/calls", async () => {
    const rows = await callService.list(100);
    return ok({ calls: rows.map((r) => callService.serialize(r)), count: rows.length });
  });
}
