// ============================================================================
// DELETE /api/voice/session/:id — hang up / end the call explicitly.
// Finalizes the transcript row (status completed/abandoned).
// ============================================================================

import { NextRequest } from "next/server";
import { ok, fail, handleRoute } from "@/lib/api-utils";
import { endSession } from "@/lib/voice/session-store";
import { callService } from "@/lib/services/call-service";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(req: NextRequest, ctx: Ctx) {
  return handleRoute(req, "/api/voice/session/:id", async () => {
    const { id } = await ctx.params;
    const row = await callService.getById(id);
    if (!row) return fail("Session not found.", 404);

    endSession(id);
    // If the agent never completed a registration, mark the call abandoned.
    const alreadyEnded = row.status !== "in_progress";
    if (!alreadyEnded) {
      const outcome = row.patient_id ? (row.outcome ?? "registered") : "abandoned";
      await callService.end(id, "completed", outcome, row.patient_id, null);
    }
    return ok({ session_id: id, ended: true });
  });
}
