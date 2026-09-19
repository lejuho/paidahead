import { createPublicClient, http } from "viem";
import { privateKeyToAccount, mnemonicToAccount } from "viem/accounts";
import { Pool } from "@paidahead/database";
import { runRegistrationOnce } from "./registration.ts";
import { viemRegistrationChain, type RegistrationChain } from "./chain.ts";
import { runSettlementOnce } from "./settlement.ts";
import { setTimeout } from "node:timers/promises";

if (process.env.DEMO_MODE !== "true" || process.env.NODE_ENV === "production") throw new Error("Demo worker only");
const { DATABASE_URL, REGISTRATION_RPC_URL, REGISTRAR_PRIVATE_KEY } = process.env;
if (!DATABASE_URL || !REGISTRATION_RPC_URL) throw new Error("DATABASE_URL and REGISTRATION_RPC_URL required");
const pool = new Pool({ connectionString: DATABASE_URL });
try {
  const client = createPublicClient({ transport: http(REGISTRATION_RPC_URL, { timeout: 10000, retryCount: 0 }) });
  let chain: RegistrationChain | undefined;
  if (!process.argv.includes("--settlement-only")) {
    const local = process.env.LOCAL_DEMO_REGISTRAR === "true";
    if (local && (!["127.0.0.1", "localhost"].includes(new URL(REGISTRATION_RPC_URL).hostname) || await client.getChainId() !== 31337)) {
      throw new Error("Public demo mnemonic may only be used on loopback chain 31337");
    }
    if (!local && !/^0x[0-9a-fA-F]{64}$/.test(REGISTRAR_PRIVATE_KEY ?? "")) throw new Error("REGISTRAR_PRIVATE_KEY required");
    const account = local
      ? mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: 1 })
      : privateKeyToAccount(REGISTRAR_PRIVATE_KEY as `0x${string}`);
    chain = viemRegistrationChain(client, account);
  }
  const watch = process.argv.includes("--watch");
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { stopping = true; });
  async function cycle(component: string, work: () => Promise<{status:string}>) {
    try {
      const result = await work();
      if (!watch || !["IDLE", "BUSY", "WAITING_CONFIGURATION"].includes(result.status)) console.log(JSON.stringify({component,...result}));
    } catch (error) {
      // Keep the persisted cursor/work item. One component's outage must not stop the other.
      console.error(JSON.stringify({component,status:"RETRY_REQUIRED",reason:error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "RPC_OR_DATABASE_ERROR"}));
      if (!watch) process.exitCode=1;
    }
  }
  do {
    if (chain) await cycle("registration",()=>runRegistrationOnce(pool,chain!));
    await cycle("settlement",()=>runSettlementOnce(pool,client));
    if (watch && !stopping) await setTimeout(1000);
  } while (watch && !stopping);
} finally { await pool.end(); }
