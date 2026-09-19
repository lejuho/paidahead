import { mkdir, writeFile, chmod } from "node:fs/promises";
import { Pool, migrate } from "./index.ts";
import { seedDemo } from "./seed.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  if (process.argv[2] === "migrate") {
    await migrate(pool);
    console.log("DB migrations applied.");
  } else if (process.argv[2] === "seed") {
    if (process.env.DEMO_MODE !== "true" || process.env.NODE_ENV === "production") throw new Error("Seed requires non-production DEMO_MODE=true");
    const data = await seedDemo(pool);
    const directory = new URL("../../../.local/", import.meta.url);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = new URL("demo-access.json", directory);
    await writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 });
    await chmod(file, 0o600);
    console.log("Demo organizations and documents ready. Local credentials: .local/demo-access.json (24h).");
  } else throw new Error("Expected migrate or seed");
} finally { await pool.end(); }
