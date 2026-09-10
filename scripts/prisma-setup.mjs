#!/usr/bin/env node
// ============================================================================
// prisma-setup.mjs — automatic Prisma provider/schema selection
//
// WHY: Local dev uses SQLite (zero setup). Serverless hosts like Vercel have a
// read-only, ephemeral filesystem and CANNOT run SQLite, so production uses
// hosted PostgreSQL. This script:
//   1. Detects the provider from DATABASE_URL (or DB_PROVIDER). DEFAULT is
//      PostgreSQL (schema.prisma) — what production/Vercel needs. A `file:`
//      URL (local dev) switches to prisma/schema.sqlite.prisma.
//   2. Loads .env (without overriding real environment variables).
//   3. Runs `prisma generate` with the matching schema file.
//   4. Provisions tables on the hosted DB (with --push):
//        - default:  `prisma db push` — robust, self-healing, no migration
//                    history to maintain (assessment/demo friendly).
//        - optional: `prisma migrate deploy` when PRISMA_MIGRATE=true or
//                    --migrate-deploy — production-grade, uses the SQL
//                    migrations in prisma/migrations (recommended by Prisma
//                    for long-lived production deployments).
//   5. With --seed: seeds demo data (idempotent — skipped when data exists).
//
// Usage:
//   node scripts/prisma-setup.mjs            # generate only (local build)
//   node scripts/prisma-setup.mjs --push     # generate + provision tables
//   node scripts/prisma-setup.mjs --push --seed   # full Vercel build setup
//
// Environment:
//   DATABASE_URL          sqlite: file:./db/custom.db   postgres: postgresql://...
//   DIRECT_DATABASE_URL   optional (Neon/Supabase): direct, non-pooled URL
//                         used by db push. Defaults to DATABASE_URL.
//   DB_PROVIDER           optional override: sqlite | postgres
//   PRISMA_SKIP_PUSH      set to "true" to skip the push step
// ============================================================================

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// DEFAULT schema = PostgreSQL (production / Vercel). The SQLite schema is the
// local-development variant, selected automatically for `file:` URLs.
const SCHEMA_PG = path.join(ROOT, "prisma", "schema.prisma");
const SCHEMA_SQLITE = path.join(ROOT, "prisma", "schema.sqlite.prisma");

const args = new Set(process.argv.slice(2));
const wantPush = args.has("--push");
const wantSeed = args.has("--seed");
const wantMigrateDeploy =
  args.has("--migrate-deploy") || process.env.PRISMA_MIGRATE === "true";

const log = (...m) => console.log("[prisma-setup]", ...m);
const warn = (...m) => console.warn("[prisma-setup] ⚠", ...m);

// ---------------------------------------------------------------------------
// 1. Tiny .env loader (project root) — real environment variables win.
// ---------------------------------------------------------------------------
function loadDotEnv() {
  const envFile = path.join(ROOT, ".env");
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = val;
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Provider detection
// ---------------------------------------------------------------------------
function detectProvider(url) {
  const forced = (process.env.DB_PROVIDER || "").toLowerCase();
  if (forced === "postgres" || forced === "postgresql") return "postgres";
  if (forced === "sqlite") return "sqlite";
  if (!url) return "postgres"; // default = production-grade PostgreSQL
  if (/^postgres(ql)?:\/\//i.test(url)) return "postgres";
  if (/^file:/i.test(url)) return "sqlite";
  return "postgres"; // unknown prefix → assume PostgreSQL
}

function maskUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = "••••••";
    return u.toString();
  } catch {
    return "<unparseable-url>";
  }
}

// Neon/Supabase pooled endpoints proxy Postgres via pgbouncer; telling Prisma
// avoids prepared-statement conflicts during db push. Harmless when direct.
function makePushSafe(url) {
  if (!/^[a-z]+:\/\//i.test(url)) return url;
  try {
    const u = new URL(url);
    const already =
      u.searchParams.has("pgbouncer") || u.searchParams.has("sslmode");
    if (!u.searchParams.has("sslmode")) u.searchParams.set("sslmode", "require");
    if (!already) u.searchParams.set("pgbouncer", "true");
    return u.toString();
  } catch {
    return url;
  }
}

loadDotEnv();

// ---------------------------------------------------------------------------
// 2b. Resolve connection URLs with Vercel-injected fallbacks.
//
// Vercel's marketplace Postgres integrations (Neon via Storage, Supabase,
// "Prisma Postgres" direct mode, Vercel Postgres) do not always inject
// `DATABASE_URL` — many inject the POSTGRES_* family instead. Accept all of
// them so the deployment works no matter which integration was used:
//
//   runtime URL : DATABASE_URL || POSTGRES_PRISMA_URL || POSTGRES_URL
//   direct URL  : DIRECT_DATABASE_URL || POSTGRES_URL_NON_POOLING
//                 || DATABASE_URL_UNPOOLED || <runtime URL>
// ---------------------------------------------------------------------------
function firstEnv(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return { name: n, value: v.trim() };
  }
  return null;
}

const runtimeHit = firstEnv("DATABASE_URL", "POSTGRES_PRISMA_URL", "POSTGRES_URL");
if (runtimeHit && runtimeHit.name !== "DATABASE_URL") {
  process.env.DATABASE_URL = runtimeHit.value; // visible to prisma CLI + seed
  log(`using ${runtimeHit.name} as DATABASE_URL (not set explicitly)`);
}

const directHit = firstEnv(
  "DIRECT_DATABASE_URL",
  "POSTGRES_URL_NON_POOLING",
  "DATABASE_URL_UNPOOLED",
);
if (directHit && directHit.name !== "DIRECT_DATABASE_URL") {
  process.env.DIRECT_DATABASE_URL = directHit.value;
  log(`using ${directHit.name} as DIRECT_DATABASE_URL (not set explicitly)`);
}

// Prisma CLI runner: prefer bunx, fall back to npx when bun is unavailable
// (bun.lock makes Vercel use Bun, but support npm-based environments too).
function pickCliRunner() {
  const probe = spawnSync("bun", ["--version"], { stdio: "ignore" });
  return probe.status === 0 ? "bunx" : "npx";
}
const CLI = process.env.PRISMA_CLI || pickCliRunner();

const databaseUrl = process.env.DATABASE_URL || "";
const provider = detectProvider(databaseUrl);
const schema = provider === "postgres" ? SCHEMA_PG : SCHEMA_SQLITE;

const directUrl = process.env.DIRECT_DATABASE_URL || databaseUrl;
const childEnv = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  DIRECT_DATABASE_URL: directUrl,
};

log(`provider=${provider}  schema=${path.relative(ROOT, schema)}`);
if (databaseUrl) log(`DATABASE_URL=${maskUrl(databaseUrl)}`);

// ---------------------------------------------------------------------------
// 3. prisma generate (REQUIRED before build — bun does not run postinstall)
// ---------------------------------------------------------------------------
if (!existsSync(schema)) {
  console.error(`[prisma-setup] ✖ schema not found: ${schema}`);
  process.exit(1);
}

const gen = spawnSync(
  CLI,
  ["prisma", "generate", "--schema", schema],
  { stdio: "inherit", cwd: ROOT, env: childEnv },
);
if (gen.status !== 0) {
  console.error("[prisma-setup] ✖ prisma generate failed");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 4. Provision tables (--push): migrate deploy (opt-in) OR db push (default)
// ---------------------------------------------------------------------------
if (wantPush && process.env.PRISMA_SKIP_PUSH !== "true") {
  if (provider !== "postgres" && !existsSync(path.join(ROOT, "db"))) {
    // sqlite target dir may not exist yet on a fresh machine
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path.join(ROOT, "db"), { recursive: true });
  }
  const pushEnv = {
    ...childEnv,
    DIRECT_DATABASE_URL:
      provider === "postgres" ? makePushSafe(directUrl) : directUrl,
  };

  if (wantMigrateDeploy) {
    log("applying migrations (prisma migrate deploy)…");
    const mig = spawnSync(
      CLI,
      ["prisma", "migrate", "deploy", "--schema", schema],
      { stdio: "inherit", cwd: ROOT, env: pushEnv },
    );
    if (mig.status !== 0) {
      console.error(
        "[prisma-setup] ✖ prisma migrate deploy failed.\n" +
          "  If the database was previously provisioned with `db push`, either\n" +
          "  keep using db push (unset PRISMA_MIGRATE) or baseline the history:\n" +
          "  `prisma migrate resolve --applied <init-migration-name>`.",
      );
      process.exit(1);
    }
  } else {
    log("provisioning tables (prisma db push)…");
    const pushArgs = [
      "prisma",
      "db",
      "push",
      "--schema",
      schema,
      "--accept-data-loss",
      "--skip-generate",
    ];
    // Retry once: free-tier Postgres (e.g. Neon) can be auto-suspended and
    // needs a few seconds to wake up on the first connection attempt.
    let push = spawnSync(CLI, pushArgs, {
      stdio: "inherit",
      cwd: ROOT,
      env: pushEnv,
    });
    if (push.status !== 0) {
      warn("db push failed — retrying once in 3s (DB may be waking up)…");
      await new Promise((r) => setTimeout(r, 3000));
      push = spawnSync(CLI, pushArgs, {
        stdio: "inherit",
        cwd: ROOT,
        env: pushEnv,
      });
    }
    if (push.status !== 0) {
      console.error(
        "[prisma-setup] ✖ prisma db push failed.\n" +
          "  Check that DATABASE_URL / DIRECT_DATABASE_URL are correct and that\n" +
          "  the database accepts connections (Neon/Supabase: IP access is open\n" +
          "  by default; corporate Postgres may need allow-listing).\n" +
          "  Set PRISMA_SKIP_PUSH=true to skip provisioning during build.",
      );
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Seed demo data (--seed, idempotent)
// ---------------------------------------------------------------------------
if (wantSeed) {
  const runners = [
    { cmd: "bun", args: ["prisma/seed.ts"] },
    {
      cmd: process.execPath,
      args: ["--experimental-strip-types", "prisma/seed.ts"],
    },
  ];
  let seeded = false;
  for (const r of runners) {
    const res = spawnSync(r.cmd, r.args, {
      stdio: "inherit",
      cwd: ROOT,
      env: childEnv,
    });
    if (res.status === 0) {
      seeded = true;
      break;
    }
    warn(`seed via \`${r.cmd} ${r.args.join(" ")}\` failed — trying fallback`);
  }
  if (!seeded) warn("seed skipped (non-fatal) — app works with an empty DB");
}

log("done ✔");
