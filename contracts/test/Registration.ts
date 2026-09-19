import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, it } from "node:test";
import { mnemonicToAccount } from "viem/accounts";
import { Pool, migrate, type DatabasePool } from "@paidahead/database";
import { seedDemo, DEMO_IDS } from "../../packages/database/src/seed.ts";
import { createApp } from "../../apps/api/src/app.ts";
import { runRegistrationOnce } from "../../apps/worker/src/registration.ts";
import { viemRegistrationChain, type RegistrationChain } from "../../apps/worker/src/chain.ts";
import { setup } from "./fixtures.js";
import { CHAIN_ROLES } from "@paidahead/domain";

// Use npm run check to start an isolated PostgreSQL instance for the integration suite.
describe("API → PostgreSQL → registrar → EVM → confirmed DB", { skip: !process.env.TEST_DATABASE_URL }, () => {
  let f: Awaited<ReturnType<typeof setup>>;
  let pool: DatabasePool, admin: DatabasePool, schema: string, deploymentId: string;
  let app: ReturnType<typeof createApp>, seed: Awaited<ReturnType<typeof seedDemo>>, chain: RegistrationChain;
  beforeEach(async () => {
    f = await setup();
    admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    schema = `registration_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
    await migrate(pool); seed = await seedDemo(pool);
    for (const [org, wallet] of [[DEMO_IDS.supplierOrg, f.supplier], [DEMO_IDS.buyerOrg, f.payer]] as const) {
      await pool.query(`INSERT INTO wallet_binding(id,organization_id,chain_id,address,verification_status,approved_at)
        VALUES($1,$2,31337,$3,'APPROVED',now())`, [randomUUID(), org, wallet.account.address.toLowerCase()]);
    }
    deploymentId = randomUUID();
    await pool.query(`INSERT INTO chain_deployment(id,chain_id,receivable_contract,registrar_address,deployment_block,environment,active)
      VALUES($1,31337,$2,$3,0,'local',true)`, [deploymentId, f.token.address.toLowerCase(), f.registrar.account.address.toLowerCase()]);
    chain = viemRegistrationChain(f.publicClient, mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: 1 }));
    assert.equal(chain.registrar.toLowerCase(), f.registrar.account.address.toLowerCase());
    app = createApp(pool, { demoMode: true });
  });
  afterEach(async () => {
    await app?.close(); await pool?.end();
    if (schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end(); await f?.connection.close();
  });
  const headers = (role = "supplier") => ({ authorization: `Bearer ${seed.credentials[role].token}`, "x-organization-id": seed.credentials[role].organizationId });
  const post = (url: string, body: object, role = "supplier") => app.inject({ method: "POST", url, headers: headers(role), payload: body });
  const input = () => ({ buyerOrgId: DEMO_IDS.buyerOrg, targetBankOrgId: DEMO_IDS.bankOrg,
    title: "등록 통합 시연", tradeReference: "INVOICE-REG-1", faceAmountKrw: "3000000",
    dueAt: new Date(Number(f.dueAt) * 1000).toISOString(), documentIds: DEMO_IDS.documents });
  async function confirmed() {
    const res = await post("/applications", input()); assert.equal(res.statusCode, 201, res.body);
    const a = res.json();
    assert.equal((await post(`/applications/${a.id}/review`, { expectedRevision: 1,
      items: [{ name: "식자재", quantity: 100, unitPriceKrw: "30000" }], note: "확인됨" })).statusCode, 200);
    const request = await post(`/applications/${a.id}/confirmations`, { expectedRevision: 1, consent: true, consentVersion: "v1" });
    const cf = request.json();
    const response = await post(`/confirmations/${cf.id}/decision`, { decision: "CONFIRM", snapshotHash: cf.snapshot_hash,
      deliveryAcknowledged: true, paymentObligationAcknowledged: true }, "buyer");
    assert.equal(response.statusCode, 200, response.body);
    return { a, cf };
  }
  async function count(table: "receivable" | "chain_event" | "chain_transaction" | "bank_review") {
    return (await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count;
  }
  const run = () => runRegistrationOnce(pool, chain);

  it("registers exactly the confirmed snapshot and opens one bank review", async () => {
    const { a, cf } = await confirmed();
    assert.equal(await count("receivable"), "0");
    const result = await run(); assert.equal(result.status, "CONFIRMED", JSON.stringify(result));
    const r = (await pool.query("SELECT * FROM receivable")).rows[0];
    const onchain = await f.token.read.getReceivable([BigInt(r.token_id)]);
    assert.equal(onchain.snapshotHash, cf.snapshot_hash); assert.equal(onchain.faceAmount, 3_000_000n);
    assert.equal((await f.token.read.ownerOf([BigInt(r.token_id)])).toLowerCase(), f.supplier.account.address.toLowerCase());
    assert.equal(r.chain_status, "REGISTERED"); assert.ok(r.registration_tx_hash);
    assert.equal(await count("bank_review"), "1"); assert.equal(await count("chain_event"), "1");
    assert.equal((await run()).status, "IDLE");
    const state = await app.inject({ method: "GET", url: `/applications/${a.id}/registration`, headers: headers() });
    assert.equal(state.json().status, "CONFIRMED"); assert.equal(state.json().signed_transaction, undefined);
    const queue = await app.inject({ method: "GET", url: "/bank/reviews", headers: headers("bank") });
    assert.equal(queue.json().length, 1);
  });

  it("queues confirmed requests only and invalidates an old queued revision", async () => {
    assert.equal((await run()).status, "IDLE");
    const { a } = await confirmed();
    const revision = await post(`/applications/${a.id}/revisions`, { ...input(), expectedRevision: 1 });
    assert.equal(revision.statusCode, 201, revision.body);
    assert.equal((await run()).status, "IDLE");
    assert.equal(await count("receivable"), "0");
    assert.equal((await pool.query("SELECT status FROM chain_operation")).rows[0].status, "INVALIDATED");
  });

  it("persisted signed transaction recovers a lost broadcast response without another nonce", async () => {
    await confirmed();
    const disconnected: RegistrationChain = { ...chain, broadcast: async (raw) => { await chain.broadcast(raw); throw new Error("response lost"); } };
    assert.equal((await runRegistrationOnce(pool, disconnected)).status, "PENDING");
    assert.equal((await pool.query("SELECT chain_status FROM receivable")).rows[0].chain_status, null);
    assert.equal(await count("bank_review"), "0");
    const firstTx = (await pool.query("SELECT tx_hash FROM chain_transaction")).rows[0].tx_hash;
    assert.equal((await run()).status, "CONFIRMED");
    assert.equal(await count("chain_transaction"), "1");
    assert.equal((await pool.query("SELECT registration_tx_hash FROM receivable")).rows[0].registration_tx_hash, firstTx);
  });

  it("retransmits identical signed bytes after stopping before broadcast", async () => {
    const { a } = await confirmed();
    const offline: RegistrationChain = { ...chain, broadcast: async () => { throw new Error("offline"); } };
    assert.equal((await runRegistrationOnce(pool, offline)).status, "PENDING");
    const tx = (await pool.query("SELECT tx_hash,signed_transaction FROM chain_transaction")).rows[0];
    assert.equal((await post(`/applications/${a.id}/revisions`, { ...input(), expectedRevision: 1 })).json().error, "REGISTRATION_LOCKED");
    assert.equal((await post(`/applications/${a.id}/registration/retry`, {})).statusCode, 409);
    assert.equal((await run()).status, "CONFIRMED");
    assert.equal((await pool.query("SELECT tx_hash FROM chain_transaction")).rows[0].tx_hash, tx.tx_hash);
    assert.equal(await count("chain_transaction"), "1");
  });

  it("recovers when the chain succeeded but the DB finalization transaction rolled back", async () => {
    await confirmed();
    await pool.query(`CREATE FUNCTION simulate_db_crash() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'crash'; END $$;
      CREATE TRIGGER crash BEFORE INSERT ON bank_review FOR EACH ROW EXECUTE FUNCTION simulate_db_crash()`);
    assert.equal((await run()).status, "PENDING");
    assert.equal(await count("chain_event"), "0");
    assert.equal((await pool.query("SELECT chain_status FROM receivable")).rows[0].chain_status, null);
    await pool.query("DROP TRIGGER crash ON bank_review");
    assert.equal((await run()).status, "CONFIRMED");
    assert.equal(await count("chain_event"), "1"); assert.equal(await count("bank_review"), "1");
  });

  it("serializes two workers and issues only one token", async () => {
    await confirmed();
    const results = await Promise.all([run(), run()]);
    assert.ok(results.some((r) => r.status === "CONFIRMED"), JSON.stringify(results));
    assert.equal(await count("receivable"), "1"); assert.equal(await count("chain_transaction"), "1");
    assert.equal(await f.token.read.balanceOf([f.supplier.account.address]), 1n);
  });

  it("rejects a duplicate business trade across two applications", async () => {
    await confirmed(); assert.equal((await run()).status, "CONFIRMED");
    await confirmed(); const result = await run();
    assert.equal(result.status, "FAILED"); assert.equal(result.reason, "DUPLICATE_TRADE");
    assert.equal(await count("receivable"), "1");
  });

  it("requires approved DB wallets and current registrar contract permission", async () => {
    const { a } = await confirmed();
    await pool.query("UPDATE wallet_binding SET verification_status='REVOKED' WHERE verification_status='APPROVED'");
    assert.equal((await run()).reason, "APPROVED_WALLETS_REQUIRED");
    assert.equal(await count("receivable"), "0");
    await pool.query("UPDATE wallet_binding SET verification_status='APPROVED' WHERE approved_at IS NOT NULL");
    await post(`/applications/${a.id}/registration/retry`, {});
    await f.token.write.revokeRole([CHAIN_ROLES.REGISTRAR_ROLE, f.registrar.account.address]);
    const rejected = await run(); assert.equal(rejected.status, "FAILED", JSON.stringify(rejected));
    assert.equal(await count("bank_review"), "0");
    await f.token.write.grantRole([CHAIN_ROLES.REGISTRAR_ROLE, f.registrar.account.address]);
    await post(`/applications/${a.id}/registration/retry`, {});
    assert.equal((await run()).status, "CONFIRMED");
  });

  it("waits for the configured confirmation depth", async () => {
    await confirmed(); await pool.query("UPDATE chain_deployment SET confirmations=3");
    assert.equal((await run()).status, "PENDING"); assert.equal(await count("bank_review"), "0");
    await f.networkHelpers.mine(2);
    assert.equal((await run()).status, "CONFIRMED");
  });

  it("never marks confirmed if a success receipt lacks the matching registration event", async () => {
    await confirmed();
    const missingLogs: RegistrationChain = { ...chain, receipt: async (h) => {
      const r = await chain.receipt(h); return r ? { ...r, logs: [] } : null;
    } };
    const result = await runRegistrationOnce(pool, missingLogs);
    assert.equal(result.status, "PENDING"); assert.equal(result.reason, "REGISTRATION_EVENT_MISSING");
    assert.equal(await count("bank_review"), "0");
    assert.equal((await run()).status, "CONFIRMED");
  });

  it("rejects wrong networks before reserving or submitting anything", async () => {
    await confirmed();
    await assert.rejects(runRegistrationOnce(pool, { ...chain, chainId: async () => 1 }), /WRONG_CHAIN/);
    assert.equal(await count("receivable"), "0");
  });

  it("blocks a reserved wallet revoked before broadcast and resumes the same transaction after approval", async () => {
    await confirmed();
    await runRegistrationOnce(pool, { ...chain, broadcast: async () => { throw new Error("not sent"); } });
    await pool.query("UPDATE wallet_binding SET verification_status='REVOKED' WHERE approved_at IS NOT NULL");
    const blocked = await run();
    assert.equal(blocked.status, "PENDING"); assert.equal(blocked.reason, "APPROVED_WALLETS_REQUIRED");
    assert.equal(await f.token.read.balanceOf([f.supplier.account.address]), 0n);
    await pool.query("UPDATE wallet_binding SET verification_status='APPROVED' WHERE approved_at IS NOT NULL");
    assert.equal((await run()).status, "CONFIRMED"); assert.equal(await count("chain_transaction"), "1");
  });

  it("only a confirmed reverted receipt enables a new signed attempt", async () => {
    const { a } = await confirmed();
    await runRegistrationOnce(pool, { ...chain, broadcast: async () => { throw new Error("not sent"); } });
    await f.token.write.revokeRole([CHAIN_ROLES.REGISTRAR_ROLE, f.registrar.account.address]);
    await run(); // Hardhat may throw the mined revert at send time; the next cycle reads its receipt.
    const failed = await run();
    const op = (await pool.query("SELECT status,failure_code FROM chain_operation")).rows[0];
    assert.equal(op.status, "FAILED", JSON.stringify(failed)); assert.equal(op.failure_code, "TRANSACTION_REVERTED");
    assert.equal(await count("bank_review"), "0");
    await f.token.write.grantRole([CHAIN_ROLES.REGISTRAR_ROLE, f.registrar.account.address]);
    const retry = await post(`/applications/${a.id}/registration/retry`, {});
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal((await run()).status, "CONFIRMED"); assert.equal(await count("chain_transaction"), "2");
    assert.equal(await f.token.read.balanceOf([f.supplier.account.address]), 1n);
  });
});
