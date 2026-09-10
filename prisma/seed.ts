// ============================================================================
// Seed script — 2 demonstration patients + 1 appointment (challenge: optional
// 1–2 seed patient records for demonstration). Run: bun run db:seed
// NOTE: seed data is fictional; do not store real patient data (challenge FAQ).
// The data itself lives in src/lib/seed-data.ts so the runtime bootstrap can
// seed the same demo dataset on serverless deployments.
// ============================================================================
import { PrismaClient } from "@prisma/client";
import { seedDemoDataIfEmpty } from "../src/lib/seed-data";

const prisma = new PrismaClient();

async function main() {
  const seeded = await seedDemoDataIfEmpty(prisma);
  if (seeded) {
    console.log("Seeded 2 patients + 1 appointment (Jane Doe, Carlos Garcia).");
  } else {
    console.log("Seed skipped — patients already exist.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
