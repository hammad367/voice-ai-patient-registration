import type { NextConfig } from "next";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Vercel safety net: provision the database during EVERY production build.
//
// `vercel-build` in package.json normally handles this, but if Vercel runs a
// custom/default build command instead (e.g. plain `next build` or
// `npm run build`), this hook guarantees the database still gets provisioned:
// prisma generate → db push (tables) → demo seed. All steps are idempotent,
// so running after `vercel-build` is harmless. Failures are logged but never
// break the build — /api/health reports + self-heals at runtime.
// ---------------------------------------------------------------------------
if (
  process.env.VERCEL === "1" &&
  process.env.NEXT_PHASE === "phase-production-build"
) {
  try {
    console.log("[next.config] running scripts/prisma-setup.mjs --push --seed …");
    const res = spawnSync(
      "node",
      ["scripts/prisma-setup.mjs", "--push", "--seed"],
      { stdio: "inherit", cwd: process.cwd(), env: process.env },
    );
    console.log(`[next.config] prisma-setup exited with ${res.status}`);
  } catch (err) {
    console.warn("[next.config] prisma-setup hook failed (non-fatal):", err);
  }
}

const nextConfig: NextConfig = {
  // Standalone output serves the sandbox/local production flow
  // (`bun .next/standalone/server.js`). On Vercel it is unnecessary — Vercel
  // packages its own serverless output — so skip it there.
  output: process.env.VERCEL === "1" ? undefined : "standalone",
  // Keep Prisma out of the server bundle so the generated client + query
  // engine are traced into the serverless function correctly.
  serverExternalPackages: ["@prisma/client"],
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
