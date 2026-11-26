import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Prisma Client with dynamic initialization and graceful fallback
let prismaClientInstance: PrismaClient | null = null;

try {
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl) {
    const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
    if (globalForPrisma.prisma) {
      prismaClientInstance = globalForPrisma.prisma;
    } else {
      const adapter = new PrismaPg({ connectionString: databaseUrl });
      prismaClientInstance = new PrismaClient({
        adapter,
        log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
      });
      if (process.env.NODE_ENV !== "production") {
        globalForPrisma.prisma = prismaClientInstance;
      }
    }
  }
} catch (error) {
  console.warn("Failed to initialize Prisma with adapter-pg:", error);
  prismaClientInstance = null;
}

export const prisma = prismaClientInstance;
