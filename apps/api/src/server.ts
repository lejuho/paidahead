import { Pool } from "@paidahead/database";
import { createApp } from "./app.ts";
import { createPublicClient, http } from "viem";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = createApp(pool, { demoMode: process.env.DEMO_MODE === "true",
  chainClient: process.env.REGISTRATION_RPC_URL ? createPublicClient({ transport: http(process.env.REGISTRATION_RPC_URL, { timeout: 10000, retryCount: 0 }) }) : undefined });
app.addHook("onClose", async () => pool.end());
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void app.close());
try {
  await app.listen({ host: "127.0.0.1", port: Number(process.env.API_PORT ?? 3003) });
  console.log(`PaidAhead demo API: ${app.server.address() && "http://127.0.0.1:" + (process.env.API_PORT ?? 3003)}`);
} catch (error) { await app.close(); throw error; }
