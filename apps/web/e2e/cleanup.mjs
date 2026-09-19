// Removes E2E-created business rows from the LOCAL demo database so test data never shows up in a demo.
// Only applications whose title starts with "E2E " are touched (optionally just one run's "[code]").
// The rows are protected by immutability triggers, so this needs a superuser connection to a loopback demo DB
// and is refused anywhere else. On-chain tokens of those runs remain on the disposable local chain; they are all
// terminal (repaid/cancelled) or never registered, and the worker's cursors are not rewound.
// CLI: npm run e2e:clean  (all E2E data)   ·   node e2e/cleanup.mjs <runCode>
import { Pool, transaction } from "@paidahead/database";

export async function cleanupE2E(runCode) {
  const url = process.env.DATABASE_URL;
  if (!url || process.env.DEMO_MODE !== "true" || process.env.NODE_ENV === "production") throw new Error("Local demo database required");
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost", ""].includes(host)) throw new Error("E2E cleanup only runs against a loopback database");
  const pool = new Pool({ connectionString: url });
  try {
    return await transaction(pool, async (c) => {
      const pattern = runCode ? `E2E %[${runCode}]` : "E2E %";
      const apps = (await c.query("SELECT DISTINCT application_id AS id FROM application_revision WHERE title LIKE $1", [pattern])).rows.map((r) => r.id);
      if (!apps.length) return 0;
      if (!(await c.query("SELECT rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0]?.rolsuper) throw new Error("Cleanup needs a superuser role (the local demo cluster's default)");
      await c.query("SET LOCAL session_replication_role = replica"); // bypasses the immutability triggers for this transaction only
      const ids = async (sql) => (await c.query(sql, [apps])).rows.map((r) => r.id);
      const revisions = await ids("SELECT id FROM application_revision WHERE application_id=ANY($1::uuid[])");
      const confirmations = await ids("SELECT id FROM buyer_confirmation WHERE application_id=ANY($1::uuid[])");
      const receivables = await ids("SELECT id FROM receivable WHERE application_id=ANY($1::uuid[])");
      const operations = await ids("SELECT id FROM chain_operation WHERE application_id=ANY($1::uuid[])");
      const del = (sql, list) => c.query(sql, [list]);
      const reviews = (await c.query("SELECT id FROM bank_review WHERE receivable_id=ANY($1::uuid[])", [receivables])).rows.map((r) => r.id);
      const walletOps = (await c.query("SELECT id FROM wallet_operation WHERE receivable_id=ANY($1::uuid[])", [receivables])).rows.map((r) => r.id);
      const transactions = (await c.query("SELECT id FROM chain_transaction WHERE operation_id=ANY($1::uuid[])", [operations])).rows.map((r) => r.id);
      await del("DELETE FROM settlement_event WHERE receivable_id=ANY($1::uuid[])", receivables);
      await del("DELETE FROM settlement_offer WHERE receivable_id=ANY($1::uuid[])", receivables);
      await del("DELETE FROM wallet_operation WHERE receivable_id=ANY($1::uuid[])", receivables);
      await del("DELETE FROM offer_approval WHERE receivable_id=ANY($1::uuid[])", receivables);
      await del("DELETE FROM bank_supplement WHERE review_id=ANY($1::uuid[])", reviews);
      await del("DELETE FROM bank_review_entry WHERE review_id=ANY($1::uuid[])", reviews);
      await del("DELETE FROM bank_review WHERE id=ANY($1::uuid[])", reviews);
      await del("DELETE FROM chain_event WHERE transaction_id=ANY($1::uuid[])", transactions);
      await del("DELETE FROM chain_transaction WHERE id=ANY($1::uuid[])", transactions);
      await del("DELETE FROM chain_operation WHERE id=ANY($1::uuid[])", operations);
      await del("DELETE FROM receivable WHERE id=ANY($1::uuid[])", receivables);
      await del("DELETE FROM buyer_confirmation WHERE id=ANY($1::uuid[])", confirmations);
      await del("DELETE FROM review_issue WHERE revision_id=ANY($1::uuid[])", revisions);
      await del("DELETE FROM revision_document WHERE revision_id=ANY($1::uuid[])", revisions);
      await del("DELETE FROM application_revision WHERE id=ANY($1::uuid[])", revisions);
      await del("DELETE FROM application WHERE id=ANY($1::uuid[])", apps);
      await del("DELETE FROM audit_log WHERE target_id=ANY($1::uuid[])", [...apps, ...revisions, ...confirmations, ...operations, ...walletOps]);
      return apps.length;
    });
  } finally { await pool.end(); }
}
if (import.meta.url === `file://${process.argv[1]}`) console.log(`E2E 신청 ${await cleanupE2E(process.argv[2])}건과 관련 기록을 정리했습니다.`);
