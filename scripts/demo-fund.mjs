// Mints mock payment tokens to the demo bank and buyer wallets so browser wallets can purchase and repay.
// Uses the public Hardhat admin account on a disposable loopback chain 31337 only.
// Usage: node scripts/demo-fund.mjs [--krw 10000000] [--only bank|buyer]
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { mnemonicToAccount } from "viem/accounts";

const rpc = process.env.REGISTRATION_RPC_URL ?? "http://127.0.0.1:8545";
const endpoint = process.env.API_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 3003}`;
for (const url of [rpc, endpoint]) if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname) || process.env.NODE_ENV === "production") throw new Error("Local demo only");
const client = createPublicClient({ transport: http(rpc) });
assert.equal(await client.getChainId(), 31337, "Local demo chain required");
const flag = process.argv.indexOf("--krw");
const krw = flag > 0 ? process.argv[flag + 1] : "10000000";
assert.match(krw, /^[1-9][0-9]{0,12}$/, "--krw expects a positive integer");
const access = JSON.parse(await readFile(process.env.DEMO_ACCESS_FILE ?? new URL("../.local/demo-access.json", import.meta.url), "utf8"));
const get = async (path, role) => {
  const user = access.credentials[role];
  const res = await fetch(`${endpoint}${path}`, { headers: { authorization: `Bearer ${user.token}`, "x-organization-id": user.organizationId } });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
};
const { paymentToken } = await get("/chain", "bank");
const admin = createWalletClient({ account: mnemonicToAccount("test test test test test test test test test test test junk"), transport: http(rpc) });
const abi = parseAbi(["function mint(address to,uint256 amount)", "function balanceOf(address) view returns (uint256)"]);
const result = {};
const only = process.argv.indexOf("--only") > 0 ? process.argv[process.argv.indexOf("--only") + 1] : null;
assert.ok(only === null || ["bank", "buyer"].includes(only), "--only expects bank or buyer");
for (const role of only ? [only] : ["bank", "buyer"]) {
  const address = (await get("/me", role)).wallets.find((w) => Number(w.chain_id) === 31337)?.address;
  assert.ok(address, `${role}: run chain:setup first`);
  const hash = await admin.writeContract({ chain: null, address: paymentToken, abi, functionName: "mint", args: [address, BigInt(krw) * 10n ** 6n], type: "legacy", gasPrice: await client.getGasPrice() });
  assert.equal((await client.waitForTransactionReceipt({ hash })).status, "success");
  result[role] = { address, balanceKrw: ((await client.readContract({ address: paymentToken, abi, functionName: "balanceOf", args: [address] })) / 10n ** 6n).toString() };
}
console.log(JSON.stringify({ mintedKrwEach: krw, paymentToken, ...result, note: "mock token, local demo only" }, null, 2));
