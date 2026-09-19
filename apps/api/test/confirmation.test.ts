import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it, beforeEach, afterEach } from "node:test";
import { Pool, migrate, tokenHash, type DatabasePool } from "@paidahead/database";
import { seedDemo, DEMO_IDS } from "../../../packages/database/src/seed.ts";
import { createApp } from "../src/app.ts";

if (!process.env.TEST_DATABASE_URL) throw new Error("Use npm run test:api or supply TEST_DATABASE_URL");

describe("PostgreSQL purchase confirmation API", () => {
  let pool: DatabasePool, admin: DatabasePool, schema: string;
  let app: ReturnType<typeof createApp>;
  let seed: Awaited<ReturnType<typeof seedDemo>>;
  beforeEach(async () => {
    admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    schema = `test_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 10 });
    await migrate(pool);
    seed = await seedDemo(pool);
    app = createApp(pool, { demoMode: true });
  });
  afterEach(async () => {
    await app?.close(); await pool?.end();
    if (schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });
  const headers = (role = "supplier") => ({ authorization: `Bearer ${seed.credentials[role].token}`, "x-organization-id": seed.credentials[role].organizationId });
  const payload = () => ({ buyerOrgId: DEMO_IDS.buyerOrg, targetBankOrgId: DEMO_IDS.bankOrg,
    tradeReference: "INV-DEMO-001", title: "시연 식자재", faceAmountKrw: "3000000",
    dueAt: new Date(Math.floor(Date.now() / 1000) * 1000 + 30 * 86400_000).toISOString(), documentIds: DEMO_IDS.documents });
  const call = async (url: string, body: unknown, role = "supplier") => app.inject({ method: "POST", url, headers: headers(role), payload: body as Record<string, unknown> });
  const create = async () => {
    const res = await call("/applications", payload());
    assert.equal(res.statusCode, 201, res.body); return res.json();
  };
  const review = (id: string, version = 1) => call(`/applications/${id}/review`, {
    expectedRevision: version, items: [{ name: "식자재 세트", quantity: 100, unitPriceKrw: "30000" }], note: "가상 자료 수동 대조 완료",
  });
  const request = (id: string, version = 1) => call(`/applications/${id}/confirmations`, { expectedRevision: version, consent: true, consentVersion: "v1" });
  const pending = async () => {
    const a = await create(); assert.equal((await review(a.id)).statusCode, 200);
    const res = await request(a.id); assert.equal(res.statusCode, 200, res.body);
    return { a, cf: res.json() };
  };
  const decide = (cf: { id: string; snapshot_hash: string }, extra = {}) => call(`/confirmations/${cf.id}/decision`, {
    decision: "CONFIRM", snapshotHash: cf.snapshot_hash, deliveryAcknowledged: true, paymentObligationAcknowledged: true, ...extra,
  }, "buyer");

  it("AI endpoint keeps organization scope, revision checks and missing-key truth", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const a = await create();
      const denied = await call(`/applications/${a.id}/analysis`, { expectedRevision: 1 }, "buyer");
      assert.equal(denied.statusCode, 403);
      assert.equal((await call(`/applications/${a.id}/analysis`, { expectedRevision: 2 })).statusCode, 409);
      const missing = await call(`/applications/${a.id}/analysis`, { expectedRevision: 1 });
      assert.equal(missing.statusCode, 503); assert.equal(missing.json().error, "AI_NOT_CONFIGURED");
      assert.equal((await call(`/applications/${a.id}/analysis`, { expectedRevision: 1, text: "must not transmit" })).statusCode, 400);
      assert.equal((await review(a.id)).statusCode, 200, "manual review remains available");
    } finally { if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved; }
  });

  it("migrations and seed reruns preserve existing records", async () => {
    await migrate(pool); await seedDemo(pool);
    assert.equal((await pool.query("SELECT count(*) FROM organization")).rows[0].count, "3");
    assert.equal((await pool.query("SELECT count(*) FROM document")).rows[0].count, "3");
    assert.equal((await pool.query("SELECT count(*) FROM schema_migration")).rows[0].count, "3");
  });

  it("creates, reviews, freezes and confirms a snapshot with an audit trail", async () => {
    const { a, cf } = await pending();
    const detail = await app.inject({ method: "GET", url: `/confirmations/${cf.id}`, headers: headers("buyer") });
    assert.equal(detail.statusCode, 200); assert.equal(detail.json().confirmed_amount, "3000000");
    assert.equal(detail.json().documents.length, 3); assert.equal(detail.json().confirmed_fields.mode, "MANUAL_DEMO");
    const file = await app.inject({ method: "GET", url: `/documents/${DEMO_IDS.documents[0]}/content`, headers: headers("buyer") });
    assert.equal(file.statusCode, 200, file.body); assert.match(file.body, /가상 발주서/);
    const result = await decide(cf); assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().status, "CONFIRMED"); assert.equal(result.json().confirmed_by, DEMO_IDS.buyer);
    assert.equal((await pool.query("SELECT frozen_at FROM application_revision WHERE id=$1", [a.revisionId])).rows[0].frozen_at instanceof Date, true);
    const audit = await pool.query("SELECT action FROM audit_log ORDER BY created_at");
    assert.deepEqual(audit.rows.map((r) => r.action), ["APPLICATION_CREATED", "MANUAL_REVIEW_COMPLETED", "CONFIRMATION_REQUESTED", "CONFIRMED"]);
  });

  it("rejects missing authentication, fake org headers, bank writes and expired sessions", async () => {
    assert.equal((await app.inject({ method: "GET", url: "/me" })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/me", headers: { ...headers(), "x-organization-id": DEMO_IDS.buyerOrg } })).statusCode, 403);
    assert.equal((await call("/applications", payload(), "bank")).statusCode, 403);
    await pool.query("UPDATE demo_session SET expires_at=now()-interval '1 second'");
    assert.equal((await app.inject({ method: "GET", url: "/me", headers: headers() })).statusCode, 401);
  });

  it("does not expose another buyer's details, documents, list or decision", async () => {
    const { cf } = await pending();
    const org = randomUUID(), user = randomUUID(), membership = randomUUID(), token = randomBytes(32).toString("hex");
    await pool.query("INSERT INTO organization(id,name,display_name,kind,approval_status) VALUES($1,'other','other','BUYER','APPROVED')", [org]);
    await pool.query("INSERT INTO app_user(id,auth_provider,auth_subject,display_name,status) VALUES($1,'demo','other','other','ACTIVE')", [user]);
    await pool.query("INSERT INTO user_membership(id,user_id,organization_id,status) VALUES($1,$2,$3,'ACTIVE')", [membership, user, org]);
    await pool.query("INSERT INTO membership_role VALUES($1,'BUYER_CONFIRMER')", [membership]);
    await pool.query("INSERT INTO demo_session(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [tokenHash(token), user]);
    seed.credentials.other = { userId: user, organizationId: org, token };
    assert.equal((await app.inject({ method: "GET", url: `/confirmations/${cf.id}`, headers: headers("other") })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: `/documents/${DEMO_IDS.documents[0]}/content`, headers: headers("other") })).statusCode, 404);
    assert.deepEqual((await app.inject({ method: "GET", url: "/confirmations", headers: headers("other") })).json(), []);
    assert.equal((await call(`/confirmations/${cf.id}/decision`, { decision: "REJECT", snapshotHash: cf.snapshot_hash, reason: "not ours" }, "other")).statusCode, 404);
  });

  it("enforces review, explicit consent, acknowledgements and the exact hash", async () => {
    const a = await create(); assert.equal((await request(a.id)).json().error, "REVIEW_NOT_COMPLETED");
    await review(a.id);
    assert.equal((await call(`/applications/${a.id}/confirmations`, { expectedRevision: 1, consent: false, consentVersion: "v1" })).statusCode, 400);
    const cf = (await request(a.id)).json();
    assert.equal((await decide(cf, { deliveryAcknowledged: false })).statusCode, 400);
    assert.equal((await decide(cf, { snapshotHash: `0x${"0".repeat(64)}` })).json().error, "SNAPSHOT_MISMATCH");
    assert.equal((await pool.query("SELECT status FROM buyer_confirmation WHERE id=$1", [cf.id])).rows[0].status, "PENDING");
  });

  it("blocks missing document types, expired amounts/dates and unresolved issues", async () => {
    assert.equal((await call("/applications", { ...payload(), faceAmountKrw: "3000000.1" })).statusCode, 400);
    assert.equal((await call("/applications", { ...payload(), dueAt: "2020-01-01T00:00:00Z" })).statusCode, 400);
    assert.equal((await call("/applications", { ...payload(), documentIds: DEMO_IDS.documents.slice(0, 2) })).statusCode, 400);
    const a = await create();
    await pool.query("INSERT INTO review_issue(id,revision_id,field_name,reason) VALUES($1,$2,'amount','mismatch')", [randomUUID(), a.revisionId]);
    assert.equal((await review(a.id)).json().error, "UNRESOLVED_ISSUES");
  });

  it("blocks revoked organization permissions and never trusts client-supplied review status", async () => {
    assert.equal((await call("/applications", { ...payload(), status: "REVIEW_COMPLETED" })).statusCode, 400);
    const a = await create(); await review(a.id);
    await pool.query("UPDATE organization SET approval_status='REVOKED' WHERE id=$1", [DEMO_IDS.buyerOrg]);
    assert.equal((await request(a.id)).json().error, "PARTICIPANT_APPROVAL_REVOKED");
    await pool.query("UPDATE user_membership SET status='REVOKED' WHERE user_id=$1", [DEMO_IDS.supplier]);
    assert.equal((await review(a.id)).statusCode, 403);
  });

  it("concurrent requests and repeated decisions have one effective record and audit", async () => {
    const a = await create(); await review(a.id);
    const requests = await Promise.all([request(a.id), request(a.id), request(a.id)]);
    for (const r of requests) assert.equal(r.statusCode, 200, r.body);
    assert.equal(new Set(requests.map((r) => r.json().id)).size, 1);
    const cf = requests[0].json();
    const decisions = await Promise.all([decide(cf), decide(cf)]);
    decisions.forEach((r) => assert.equal(r.statusCode, 200, r.body));
    assert.equal((await pool.query("SELECT count(*) FROM audit_log WHERE action='CONFIRMED'")).rows[0].count, "1");
  });

  it("new revision invalidates a completed confirmation and requires a fresh review", async () => {
    const { a, cf } = await pending(); await decide(cf);
    const changed = await call(`/applications/${a.id}/revisions`, { ...payload(), expectedRevision: 1, faceAmountKrw: "3100000" });
    assert.equal(changed.statusCode, 201, changed.body);
    assert.equal((await decide(cf)).json().error, "STALE_REVISION");
    assert.equal((await pool.query("SELECT status FROM buyer_confirmation WHERE id=$1", [cf.id])).rows[0].status, "INVALIDATED");
    assert.equal((await request(a.id, 2)).json().error, "REVIEW_NOT_COMPLETED");
    assert.equal((await review(a.id, 1)).json().error, "STALE_REVISION");
    const old = await pool.query("SELECT confirmed_amount FROM application_revision WHERE id=$1", [a.revisionId]);
    assert.equal(old.rows[0].confirmed_amount, "3000000");
  });

  it("two simultaneous revisions cannot overwrite each other", async () => {
    const a = await create();
    const results = await Promise.all([1, 2].map(() => call(`/applications/${a.id}/revisions`, { ...payload(), expectedRevision: 1 })));
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
    assert.equal((await pool.query("SELECT count(*) FROM application_revision WHERE application_id=$1", [a.id])).rows[0].count, "2");
  });

  it("confirm/withdraw race produces exactly one decision", async () => {
    const { cf } = await pending();
    const results = await Promise.all([decide(cf), call(`/confirmations/${cf.id}/withdraw`, {})]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
    const count = await pool.query("SELECT count(*) FROM audit_log WHERE action IN ('CONFIRMED','CONFIRMATION_WITHDRAWN')");
    assert.equal(count.rows[0].count, "1");
  });

  it("requires a rejection reason and a new revision after rejection", async () => {
    const { a, cf } = await pending();
    const reject = (reason: string) => call(`/confirmations/${cf.id}/decision`, { decision: "REJECT", snapshotHash: cf.snapshot_hash, reason }, "buyer");
    assert.equal((await reject(" ")).statusCode, 400);
    assert.equal((await reject("납품 수량 확인 필요")).json().status, "REJECTED");
    assert.equal((await request(a.id)).json().error, "NEW_REVISION_REQUIRED");
    assert.equal((await decide(cf)).json().error, "CONFIRMATION_NOT_PENDING");
  });

  it("database rejects mutation of frozen revisions, attachment lists and audit rows", async () => {
    const { a } = await pending();
    await assert.rejects(pool.query("UPDATE application_revision SET title='tampered' WHERE id=$1", [a.revisionId]), /frozen revision/);
    await assert.rejects(pool.query("DELETE FROM revision_document WHERE revision_id=$1", [a.revisionId]), /frozen attachment/);
    await assert.rejects(pool.query("UPDATE document SET file_hash=$1", ["0".repeat(64)]), /append-only/);
    await assert.rejects(pool.query("DELETE FROM audit_log"), /append-only/);
  });

  it("serves organization-scoped web views without widening access", async () => {
    const { a, cf } = await pending();
    const get = (url: string, role = "supplier") => app.inject({ method: "GET", url, headers: headers(role) });
    const me = (await get("/me")).json();
    assert.equal(me.organization.kind, "SUPPLIER"); assert.deepEqual(me.roles, ["SUPPLIER_OPERATOR"]);
    assert.equal(me.authMode, "DEMO"); assert.deepEqual(me.wallets, [], "DEMO_ONLY placeholder wallets are not usable bindings");
    assert.deepEqual((await get("/me", "bank")).json().roles, ["BANK_APPROVER", "BANK_REVIEWER"]);
    const list = await get("/applications"); assert.equal(list.statusCode, 200, list.body);
    assert.equal(list.json().length, 1);
    assert.deepEqual([list.json()[0].id, list.json()[0].confirmation_id, list.json()[0].confirmation_status, list.json()[0].confirmed_amount],
      [a.id, cf.id, "PENDING", "3000000"]);
    assert.equal((await get("/applications", "buyer")).statusCode, 403);
    assert.equal((await get("/applications", "bank")).statusCode, 403);
    const detail = (await get(`/applications/${a.id}`)).json();
    assert.equal(detail.id, a.id); assert.equal(detail.revision_id, a.revisionId);
    assert.equal(detail.confirmation.id, cf.id); assert.equal(detail.documents.length, 3);
    assert.equal((await get(`/applications/${a.id}`, "buyer")).statusCode, 403);
    assert.equal((await get("/confirmations", "buyer")).json()[0].supplier_name, "대구 식자재 납품 역할");
    assert.equal((await get("/chain")).statusCode, 409, "no active deployment configured yet");
    assert.equal((await get(`/receivables/${randomUUID()}/operations`)).statusCode, 404);
  });

  it("refuses production or implicit demo authentication", () => {
    assert.throws(() => createApp(pool, { demoMode: false }), /demo authentication/);
  });

  it("runs the documented demo through a real HTTP listener", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paidahead-api-demo-"));
    try {
      const credentials = join(directory, "access.json");
      await writeFile(credentials, JSON.stringify(seed), { mode: 0o600 });
      const endpoint = await app.listen({ host: "127.0.0.1", port: 0 });
      const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../../scripts/demo-api.mjs", import.meta.url))], {
        env: { ...process.env, API_URL: endpoint, DEMO_ACCESS_FILE: credentials }, timeout: 15000,
      });
      const result = JSON.parse(stdout);
      assert.equal(result.status, "CONFIRMED");
      assert.equal(result.chainRegistration, "NOT_SUBMITTED");
      assert.equal((await pool.query("SELECT status FROM buyer_confirmation WHERE id=$1", [result.confirmationId])).rows[0].status, "CONFIRMED");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
