// ============================================================================
// GET /api/health — liveness + dependency checks + DB diagnostics
// (deployment requirement: "The system must be running and callable at the
// time of review").
//
// The `diagnostics` block exists to make Vercel/serverless database issues
// self-explanatory: it reports WHICH connection env vars are visible, the
// detected provider/protocol, and the result of the runtime self-provisioning
// bootstrap — without ever exposing secrets (no passwords, no full URLs).
// ============================================================================

import { NextRequest } from "next/server";
import { ok, handleRoute } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { ensureDatabaseReady } from "@/lib/db-bootstrap";
import { activeSessionCount } from "@/lib/voice/session-store";

const CONNECTION_VARS = [
  "DATABASE_URL",
  "DIRECT_DATABASE_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL",
  "POSTGRES_URL_NON_POOLING",
  "DATABASE_URL_UNPOOLED",
] as const;

function connectionDiagnostics() {
  const present = CONNECTION_VARS.filter((n) => !!process.env[n]);
  const raw =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL ||
    "";
  let protocol: string | null = null;
  let hostHint: string | null = null;
  let detectedProvider: "postgres" | "sqlite" | "unknown" = "unknown";
  if (raw) {
    try {
      const u = new URL(raw);
      protocol = u.protocol.replace(":", "");
      hostHint = u.hostname
        ? `${u.hostname.slice(0, 14)}${u.hostname.length > 14 ? "…" : ""}`
        : null;
      detectedProvider = /^postgres/i.test(protocol) ? "postgres" : "sqlite";
    } catch {
      protocol = "unparseable";
    }
  }
  return {
    connection_vars_present: present,
    runtime_url_source:
      process.env.DATABASE_URL
        ? "DATABASE_URL"
        : process.env.POSTGRES_PRISMA_URL
          ? "POSTGRES_PRISMA_URL"
          : process.env.POSTGRES_URL
            ? "POSTGRES_URL"
            : null,
    protocol,
    host_hint: hostHint,
    detected_provider: detectedProvider,
  };
}

export async function GET(req: NextRequest) {
  return handleRoute(req, "/api/health", async () => {
    // Attempt runtime self-provisioning first (no-op once ready / on SQLite).
    const bootstrap = await ensureDatabaseReady();

    let dbOk = true;
    let dbError: string | null = null;
    try {
      await db.$queryRaw`SELECT 1`;
    } catch (err) {
      dbOk = false;
      dbError = err instanceof Error ? err.message : String(err);
    }
    return ok({
      status: dbOk ? "healthy" : "degraded",
      database: dbOk ? "connected" : "unreachable",
      active_voice_sessions: activeSessionCount(),
      time: new Date().toISOString(),
      services: {
        rest_api: "up",
        voice_agent: "up",
        telephony_webhooks: ["vapi", "twilio"],
      },
      self_provisioning: {
        attempted: bootstrap.attempted,
        schema_ready: bootstrap.schemaReady,
        seeded: bootstrap.seeded,
        source: bootstrap.source ?? null,
        error: bootstrap.error ?? null,
      },
      diagnostics: {
        ...connectionDiagnostics(),
        db_error: dbError ? dbError.slice(0, 300) : null,
      },
    });
  });
}
