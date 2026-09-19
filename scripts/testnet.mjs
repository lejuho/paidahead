// Injective testnet only. Local DB/API/web stay on loopback; public development keys are never used.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync, rmSync, openSync, closeSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createPublicClient, createWalletClient, http, defineChain, formatEther, parseEther, keccak256, encodeDeployData, encodeFunctionData, getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount, mnemonicToAccount } from "viem/accounts";
import { Pool, migrate, transaction } from "../packages/database/src/index.ts";
import { seedDemo } from "../packages/database/src/seed.ts";
import { CHAIN_ROLES } from "../packages/domain/src/index.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const rehearsal = process.argv.includes("--rehearsal");
const dir = resolve(root, rehearsal ? ".local/testnet-rehearsal" : ".local/testnet");
const rpc = rehearsal ? "http://127.0.0.1:18545" : "https://k8s.testnet.json-rpc.injective.network/";
const chain = defineChain({ id: 1439, name: "Injective EVM Testnet", nativeCurrency: { name: "Injective", symbol: "INJ", decimals: 18 }, rpcUrls: { default: { http: [rpc] } }, testnet: true });
const client = createPublicClient({ chain, transport: http(rpc, { timeout: 20000, retryCount: 1 }) });
const command = process.argv[2]?.trim() ?? "status";
if (process.env.NODE_ENV === "production") throw new Error("Testnet demo only");
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
const file = (name) => resolve(dir, name);
const read = (name) => JSON.parse(readFileSync(file(name), "utf8"));
function save(name, value) {
  const target = file(name), temporary = `${target}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(temporary, 0o600); renameSync(temporary, target);
}
function keys() {
  if (!existsSync(file("wallets.json"))) throw new Error("Run npm run testnet -- init first");
  const data = read("wallets.json");
  const roles = ["admin", "registrar", "supplier", "buyer", "bank"];
  const publicKeys = new Set(Array.from({ length: 20 }, (_, addressIndex) => mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex }).address.toLowerCase()));
  const result = Object.fromEntries(roles.map((role) => {
    const item = data[role];
    const account = item.privateKey ? privateKeyToAccount(item.privateKey) : null;
    const address = getAddress(item.address);
    if (account && account.address !== address) throw new Error(`Wallet key/address mismatch: ${role}`);
    if (publicKeys.has(address.toLowerCase())) throw new Error("Public Anvil keys are forbidden on testnet");
    if (["admin", "registrar"].includes(role) && !account) throw new Error(`${role} local signing key required`);
    return [role, { account, address }];
  }));
  if (new Set(Object.values(result).map((v) => v.address.toLowerCase())).size !== roles.length) throw new Error("Use a separate wallet for each role");
  return result;
}
async function network() {
  if (await client.getChainId() !== 1439) throw new Error("Expected Injective testnet 1439");
}
async function status() {
  await network();
  const wallets = keys();
  console.log("Injective EVM Testnet 1439 · " + rpc);
  for (const [role, wallet] of Object.entries(wallets)) console.log(`${role.padEnd(10)} ${wallet.address}  ${formatEther(await client.getBalance({ address: wallet.address }))} INJ`);
  console.log("Faucet: https://testnet.faucet.injective.network/");
  if (existsSync(file("deployment.json"))) console.log(JSON.stringify(read("deployment.json"), null, 2));
}
function initialize() {
  if (existsSync(file("wallets.json"))) { console.log("Existing wallets preserved"); return; }
  const wallets = Object.fromEntries(["admin", "registrar", "supplier", "buyer", "bank"].map((role) => {
    const addressArg = process.argv.find((a) => a.startsWith(`--${role}=`))?.slice(role.length + 3);
    if (addressArg && ["supplier", "buyer", "bank"].includes(role)) return [role, { address: getAddress(addressArg) }];
    const privateKey = generatePrivateKey(); return [role, { address: privateKeyToAccount(privateKey).address, privateKey }];
  }));
  save("wallets.json", wallets);
  save("addresses.json", Object.fromEntries(Object.entries(wallets).map(([role, wallet]) => [role, wallet.address])));
  console.log("Created private testnet wallets locally (0600); addresses:");
  console.log(readFileSync(file("addresses.json"), "utf8"));
}
const dbName = rehearsal ? "paidahead_testnet_rehearsal" : "paidahead_testnet";
const dbUrl = `postgresql://paidahead:paidahead_local_only@127.0.0.1:54329/${dbName}`;
async function database() {
  execFileSync(process.execPath, ["scripts/local-pg.mjs", "start"], { cwd: root, stdio: "pipe" });
  const admin = new Pool({ connectionString: dbUrl.replace(new RegExp(`${dbName}$`), "postgres") });
  try {
    if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [dbName])).rowCount) await admin.query(`CREATE DATABASE ${dbName}`);
  } finally { await admin.end(); }
  const pool = new Pool({ connectionString: dbUrl });
  try { await migrate(pool); return pool; } catch (error) { await pool.end(); throw error; }
}
const artifact = (name) => JSON.parse(readFileSync(resolve(root, `contracts/artifacts/src/${name}.sol/${name}.json`), "utf8"));
async function deploy() {
  await network();
  const wallets = keys(), account = wallets.admin.account;
  const journal = existsSync(file("journal.json")) ? read("journal.json") : { chainId: 1439, admin: account.address, steps: {} };
  if (journal.chainId !== 1439 || journal.admin !== account.address) throw new Error("Deployment journal belongs to another wallet/network");
  if (await client.getBalance({ address: account.address }) < parseEther("0.05")) throw new Error(`Fund admin ${account.address} with testnet INJ (at least 0.05) using https://testnet.faucet.injective.network/`);
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });
  // Persist signed bytes before sending. Restart checks/rebroadcasts the same transaction instead of deploying twice.
  async function send(label, request) {
    const identity = JSON.stringify(request, (_, v) => typeof v === "bigint" ? v.toString() : v);
    let step = journal.steps[label];
    if (step && step.identity !== identity) throw new Error(`Journal configuration changed: ${label}`);
    if (!step) {
      const gasPrice = await client.getGasPrice();
      const estimate = await client.estimateGas({ account, ...request });
      const prepared = await wallet.prepareTransactionRequest({ ...request, type: "legacy", gasPrice, gas: estimate * 125n / 100n });
      const raw = await wallet.signTransaction(prepared);
      step = { identity, raw, hash: keccak256(raw) };
      journal.steps[label] = step; save("journal.json", journal);
    }
    let receipt;
    try { receipt = await client.getTransactionReceipt({ hash: step.hash }); } catch (error) { if (error.name !== "TransactionReceiptNotFoundError") throw error; }
    if (!receipt) {
      try { await client.sendRawTransaction({ serializedTransaction: step.raw }); }
      catch (error) {
        // A lost broadcast response is resolved using the recorded hash; never silently create another nonce.
        try { await client.getTransaction({ hash: step.hash }); } catch { throw new Error(`Broadcast uncertain for ${label}: ${step.hash}. Retry the same deploy command.`); }
      }
      receipt = await client.waitForTransactionReceipt({ hash: step.hash, confirmations: 2, timeout: 180000 });
    }
    if (receipt.status !== "success") throw new Error(`Reverted deployment step ${label}: ${step.hash}`);
    step.blockNumber = receipt.blockNumber.toString(); step.contractAddress = receipt.contractAddress;
    save("journal.json", journal);
    console.log(`${label}: ${rehearsal ? "local rehearsal " : "https://testnet.blockscout.injective.network/tx/"}${step.hash}`);
    return receipt;
  }
  async function contract(name, args) {
    const a = artifact(name);
    const receipt = await send(`deploy-${name}`, { data: encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args }) });
    const address = receipt.contractAddress;
    if (!address || !(await client.getCode({ address }))) throw new Error(`Missing contract ${name}`);
    return { address, abi: a.abi, block: receipt.blockNumber };
  }
  const receivable = await contract("ReceivableToken", [account.address]);
  const payment = await contract("MockPaymentToken", [account.address]);
  const settlement = await contract("Settlement", [receivable.address, payment.address, wallets.bank.address]);
  const call = (label, contract, functionName, args) => send(label, { to: contract.address, data: encodeFunctionData({ abi: contract.abi, functionName, args }) });
  await call("configure-settlement", receivable, "configureSettlement", [settlement.address]);
  for (const [role, chainRole] of [["registrar", CHAIN_ROLES.REGISTRAR_ROLE], ["supplier", CHAIN_ROLES.SUPPLIER_ROLE], ["buyer", CHAIN_ROLES.PAYER_ROLE], ["bank", CHAIN_ROLES.BANK_ROLE]]) {
    await call(`grant-${role}`, receivable, "grantRole", [chainRole, wallets[role].address]);
    if (!await client.readContract({ ...receivable, functionName: "hasRole", args: [chainRole, wallets[role].address] })) throw new Error(`Role verification failed: ${role}`);
  }
  for (const role of ["registrar", "supplier", "buyer", "bank"]) {
    const label = `gas-${role}`;
    if (journal.steps[label] || await client.getBalance({ address: wallets[role].address }) < parseEther("0.005")) await send(label, { to: wallets[role].address, value: parseEther("0.005") });
  }
  for (const role of ["buyer", "bank"]) await call(`mint-${role}`, payment, "mint", [wallets[role].address, 10_000_000n * 1_000_000n]);
  const deployment = { chainId: 1439, receivable: receivable.address, payment: payment.address, settlement: settlement.address,
    registrar: wallets.registrar.address, bank: wallets.bank.address, deploymentBlock: settlement.block.toString(), confirmations: 2, environment: "testnet" };
  const pool = await database();
  try {
    const access = await seedDemo(pool);
    await transaction(pool, async (c) => {
      const existing = (await c.query("SELECT * FROM chain_deployment WHERE active")).rows[0];
      if (existing && (existing.receivable_contract !== receivable.address.toLowerCase() || Number(existing.chain_id) !== 1439)) throw new Error("Testnet DB has another active deployment; refusing to replace it");
      for (const [role, org] of [["supplier", access.ids.supplierOrg], ["buyer", access.ids.buyerOrg], ["bank", access.ids.bankOrg]]) {
        const address = wallets[role].address.toLowerCase();
        const bound = (await c.query("SELECT address FROM wallet_binding WHERE organization_id=$1 AND chain_id=1439 AND verification_status='APPROVED'", [org])).rows[0];
        if (bound && bound.address !== address) throw new Error(`Existing ${role} wallet binding differs`);
        if (!bound) await c.query("INSERT INTO wallet_binding(id,organization_id,chain_id,address,verification_status,approved_at) VALUES($1,$2,1439,$3,'APPROVED',now())", [randomUUID(), org, address]);
      }
      const bank = (await c.query("SELECT id FROM wallet_binding WHERE chain_id=1439 AND address=$1", [wallets.bank.address.toLowerCase()])).rows[0];
      if (!existing) await c.query(`INSERT INTO chain_deployment(id,chain_id,receivable_contract,registrar_address,deployment_block,confirmations,environment,active,settlement_contract,payment_token,bank_wallet_id)
        VALUES($1,1439,$2,$3,$4,2,'testnet',true,$5,$6,$7)`, [randomUUID(), receivable.address.toLowerCase(), wallets.registrar.address.toLowerCase(), deployment.deploymentBlock, settlement.address.toLowerCase(), payment.address.toLowerCase(), bank.id]);
    });
    save("demo-access.json", access); save("deployment.json", deployment);
  } finally { await pool.end(); }
  console.log(rehearsal ? "Local deployment rehearsal verified (not a public testnet deployment)" : "Deployment verified and stored in separate paidahead_testnet DB. Run npm run testnet -- up");
}
function environment() {
  const env = { ...process.env, DEMO_MODE: "true", DATABASE_URL: dbUrl, API_PORT: "3103", API_URL: "http://127.0.0.1:3103", PAIDAHEAD_NETWORK: "injective-testnet",
    REGISTRATION_RPC_URL: rpc, WEB_CHAIN_RPC_URL: rpc, LOCAL_DEMO_REGISTRAR: "false", DEMO_ACCESS_FILE: file("demo-access.json") };
  delete env.REGISTRAR_PRIVATE_KEY;
  return env;
}
const services = {
  api: { cwd: "apps/api", args: ["src/server.ts"] },
  worker: { cwd: "apps/worker", args: ["src/cli.ts", "--watch"] },
  web: { cwd: "apps/web", args: [resolve(root, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", "3100"] },
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function up() {
  if (rehearsal) throw new Error("Rehearsal only supports init/status/deploy; never connect MetaMask to this test chain");
  await network(); keys();
  if (!existsSync(file("deployment.json"))) throw new Error("Deploy contracts before starting testnet services");
  const d = read("deployment.json");
  for (const address of [d.receivable, d.payment, d.settlement]) if (!(await client.getCode({ address }))) throw new Error("Deployed contract missing");
  const pool = await database();
  try { save("demo-access.json", await seedDemo(pool)); } finally { await pool.end(); }
  const pids = existsSync(file("pids.json")) ? read("pids.json") : {};
  for (const [name, service] of Object.entries(services)) {
    if (pids[name] && alive(pids[name])) continue;
    const env = environment();
    if (name === "worker") env.REGISTRAR_PRIVATE_KEY = read("wallets.json").registrar.privateKey;
    const fd = openSync(file(`${name}.log`), "a", 0o600);
    const child = spawn(process.execPath, service.args, { cwd: resolve(root, service.cwd), env, detached: true, stdio: ["ignore", fd, fd] });
    child.unref(); closeSync(fd); pids[name] = child.pid; save("pids.json", pids);
  }
  for (const [name, url] of [["api", "http://127.0.0.1:3103/health"], ["web", "http://127.0.0.1:3100/api/demo/session"]]) {
    let ok = false;
    for (let n = 0; n < 60; n++) {
      if (!alive(pids[name])) throw new Error(`${name} exited; see .local/testnet/${name}.log`);
      if ((await fetch(url).catch(() => null))?.ok) { ok = true; break; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!ok) throw new Error(`${name} readiness timed out`);
  }
  if (!alive(pids.worker)) throw new Error("Worker exited; see .local/testnet/worker.log");
  console.log("Testnet demo ready: http://localhost:3100 (local demo remains at :3000)");
}
function down() {
  if (!existsSync(file("pids.json"))) return;
  for (const pid of Object.values(read("pids.json"))) { try { process.kill(-pid, "SIGTERM"); } catch {} }
  save("pids.json", {});
  console.log("Stopped testnet services; DB, wallets and deployment preserved");
}
// Only one local orchestrator may mutate a deployment journal/process registry at a time.
const lock = file("command.lock");
let locked = false;
try {
  if (!["status", "addresses"].includes(command)) {
    try { mkdirSync(lock); locked = true; } catch { throw new Error("Another testnet command is running (or inspect stale .local/testnet/command.lock)"); }
    writeFileSync(resolve(lock, "pid"), String(process.pid));
  }
  if (command === "init") initialize();
  else if (command === "status") await status();
  else if (command === "addresses") console.log(readFileSync(file("addresses.json"), "utf8"));
  else if (command === "deploy") await deploy();
  else if (command === "up") await up();
  else if (command === "down") down();
  else if (command === "smoke") {
    if (rehearsal) throw new Error("Smoke targets public testnet only");
    await network(); keys();
    execFileSync(process.execPath, ["scripts/testnet-smoke.mjs"], { cwd: root, env: environment(), stdio: "inherit" });
  }
  else throw new Error("Usage: npm run testnet -- init|status|addresses|deploy|up|down|smoke");
} catch (error) {
  // viem errors can include full signed transaction payloads. Keep private material out of terminal/log output.
  console.error(error.shortMessage ?? error.message); process.exitCode = 1;
} finally { if (locked) rmSync(lock, { recursive: true }); }
