// ============================================================================
// Runtime database self-provisioning ("DB bootstrap")
//
// WHY: On serverless hosts (Vercel) the build-time `prisma db push` can be
// skipped (custom build command, cache quirks, provider only visible at
// runtime). This module makes the running app heal itself:
//
//   1. Detects a Postgres connection URL (DATABASE_URL or the Vercel-injected
//      POSTGRES_PRISMA_URL / POSTGRES_URL family).
//   2. If the `patients` table is missing, applies the idempotent DDL from
//      db-init-sql.ts (CREATE ... IF NOT EXISTS — safe under cold-start races).
//   3. Seeds the demo dataset when the DB is empty (advisory-locked).
//
// It runs at most ONCE per serverless instance (singleton promise), is a
// no-op for local SQLite, and NEVER throws into the request path — failures
// are reported through /api/health diagnostics instead.
// ============================================================================

import { db } from "./db";
import { DB_INIT_SQL } from "./db-init-sql";
import { seedDemoDataIfEmpty } from "./seed-data";
import { logger } from "./logger";

export interface BootstrapResult {
  /** false = skipped (no Postgres URL — local SQLite or misconfiguration) */
  attempted: boolean;
  /** true when the schema exists (pre-existing or just created) */
  schemaReady: boolean;
  /** true when demo data was inserted during this bootstrap */
  seeded: boolean;
  /** which env var supplied the connection URL */
  source?: string;
  /** failure reason when attempted but unsuccessful */
  error?: string;
  at: string;
}

let bootstrapPromise: Promise<BootstrapResult> | null = null;

export function ensureDatabaseReady(): Promise<BootstrapResult> {
  if (!bootstrapPromise) {
    bootstrapPromise = runBootstrap().catch(
      (err): BootstrapResult => {
        bootstrapPromise = null; // allow a retry on the next request
        const error = err instanceof Error ? err.message : String(err);
        logger.warn("bootstrap", `database self-provisioning failed: ${error}`);
        return {
          attempted: true,
          schemaReady: false,
          seeded: false,
          error,
          at: new Date().toISOString(),
        };
      },
    );
  }
  return bootstrapPromise;
}

function firstEnv(...names: string[]): { name: string; value: string } | null {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return { name: n, value: v.trim() };
  }
  return null;
}

async function runBootstrap(): Promise<BootstrapResult> {
  const at = new Date().toISOString();
  const hit = firstEnv(
    "DATABASE_URL",
    "POSTGRES_PRISMA_URL",
    "POSTGRES_URL",
  );

  if (!hit || !/^postgres(ql)?:\/\//i.test(hit.value)) {
    // Local SQLite (or no DB configured) — nothing to self-provision.
    return { attempted: false, schemaReady: false, seeded: false, at };
  }

  logger.info("bootstrap", `ensuring Postgres schema (via ${hit.name})…`);

  const schemaReady = await ensureTables();
  const seeded = schemaReady ? await seedDemoDataIfEmpty(db) : false;

  const result: BootstrapResult = {
    attempted: true,
    schemaReady,
    seeded,
    source: hit.name,
    at,
  };
  logger.info(
    "bootstrap",
    `schemaReady=${schemaReady} seeded=${seeded} (source=${hit.name})`,
  );
  return result;
}

/** True when the `patients` table exists; creates all tables when missing. */
async function ensureTables(): Promise<boolean> {
  const rows = await db.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'patients'
    ) AS exists`;
  if (rows[0]?.exists === true) return true;

  logger.warn("bootstrap", "tables missing — creating schema from DDL");
  // Split the DDL into statements, strip comment lines, execute one by one and
  // tolerate "already exists" races between concurrent cold-start instances.
  for (const raw of DB_INIT_SQL.split(";")) {
    const stmt = raw
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim();
    if (!stmt) continue;
    try {
      await db.$executeRawUnsafe(`${stmt};`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/already exists/i.test(msg) || /42P07|42710|42P06/i.test(msg)) {
        continue; // lost a race — the object exists, which is all we need
      }
      throw err;
    }
  }
  return true;
}
