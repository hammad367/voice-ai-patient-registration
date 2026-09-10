// ============================================================================
// GET /api/calls/:id — full transcript for one call session
// ============================================================================

import { NextRequest } from "next/server";
import { ok, fail, handleRoute } from "@/lib/api-utils";
import { callService } from "@/lib/services/call-service";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return handleRoute(req, "/api/calls/:id", async () => {
    const { id } = await ctx.params;
    const row = await callService.getById(id);
    if (!row) return fail("Call session not found.", 404);
    return ok(callService.serialize(row));
  });
}
