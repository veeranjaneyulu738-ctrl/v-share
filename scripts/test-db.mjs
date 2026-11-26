import pkg from "@prisma/client";
const { PrismaClient } = pkg;
import { PrismaPg } from "@prisma/adapter-pg";

try {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(".env.local");
  }
} catch {}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL not set. Add it to .env.local before running this script.");
  process.exit(1);
}

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("Connecting to Supabase PostgreSQL via PrismaPg adapter...");
  const result = await prisma.$queryRaw`SELECT 1 as connected, NOW() as server_time`;
  console.log("SUCCESS! Connected to Supabase:", result);

  // Check transfers count
  const count = await prisma.transfer.count();
  console.log("Transfer table row count:", count);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Connection failed:", err);
  process.exit(1);
});
