import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // 'query' logging is invaluable in local dev but floods serverless logs
    // (Vercel) and slows cold starts — production logs errors only.
    log: process.env.NODE_ENV === "production" ? ["error"] : ["query"],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db