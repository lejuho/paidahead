import { randomUUID } from "node:crypto";
import { hashSnapshot, type ConfirmationSnapshot } from "@paidahead/domain";
import { keccak256, toHex } from "viem";
import { transaction, type DatabasePool, type PoolClient } from "@paidahead/database";
import { type z } from "zod";
import { type RevisionInput, type reviewInput, type requestInput, type decisionInput } from "./validation.ts";

export class ApiError extends Error {
  statusCode: number;
  code: string;
  constructor(statusCode: number, code: string) { super(code); this.statusCode = statusCode; this.code = code; }
}
export interface Actor { userId: string; organizationId: string }
function fail(condition: unknown, code: string, status = 409): asserts condition {
  if (!condition) throw new ApiError(status, code);
}

export async function requireRole(c: PoolClient, actor: Actor, role: string): Promise<void> {
  const result = await c.query(`SELECT m.id FROM user_membership m
    JOIN organization o ON o.id=m.organization_id JOIN app_user u ON u.id=m.user_id
    JOIN membership_role r ON r.membership_id=m.id
    WHERE m.user_id=$1 AND m.organization_id=$2 AND m.status='ACTIVE' AND u.status='ACTIVE'
    AND o.approval_status='APPROVED' AND o.is_demo=true AND r.role=$3 FOR SHARE OF m,o,u,r`,
    [actor.userId, actor.organizationId, role]);
  fail(result.rowCount, "FORBIDDEN", 403);
}

async function audit(c: PoolClient, a: Actor, action: string, type: string, id: string, before: unknown, after: unknown, reason?: string) {
  await c.query(`INSERT INTO audit_log(id,actor_id,organization_id,action,target_type,target_id,previous_value,new_value,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [randomUUID(), a.userId, a.organizationId, action, type, id,
    JSON.stringify(before), JSON.stringify(after), reason ?? null]);
}

async function lockApplication(c: PoolClient, id: string) {
  const result = await c.query("SELECT * FROM application WHERE id=$1 FOR UPDATE", [id]);
  fail(result.rowCount, "NOT_FOUND", 404);
  return result.rows[0];
}

async function currentRevision(c: PoolClient, app: { current_revision_id: string }, expected: number) {
  const result = await c.query("SELECT * FROM application_revision WHERE id=$1 FOR UPDATE", [app.current_revision_id]);
  const r = result.rows[0];
  fail(r.version === expected, "STALE_REVISION");
  return r;
}

async function validateReferences(c: PoolClient, actor: Actor, input: RevisionInput) {
  fail(Date.parse(input.dueAt) > Date.now(), "DUE_DATE_PASSED", 400);
  fail(actor.organizationId !== input.buyerOrgId, "SELF_TRADE_UNSUPPORTED", 400);
  for (const [id, kind] of [[input.buyerOrgId, "BUYER"], [input.targetBankOrgId, "BANK"]]) {
    const row = await c.query("SELECT id FROM organization WHERE id=$1 AND kind=$2 AND approval_status='APPROVED' AND is_demo=true FOR SHARE", [id, kind]);
    fail(row.rowCount, "INVALID_PARTICIPANT", 400);
  }
  const docs = await c.query("SELECT id,document_type FROM document WHERE id=ANY($1::uuid[]) AND owner_org_id=$2", [input.documentIds, actor.organizationId]);
  fail(docs.rowCount === input.documentIds.length, "INVALID_DOCUMENT_ACCESS", 403);
  fail(new Set(docs.rows.map((d) => d.document_type)).size === 3, "MISSING_DOCUMENT_TYPE", 400);
}

async function insertRevision(c: PoolClient, id: string, appId: string, version: number, input: RevisionInput) {
  await c.query(`INSERT INTO application_revision(id,application_id,version,buyer_org_id,target_bank_org_id,
    trade_reference,title,confirmed_amount,confirmed_due_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, appId, version, input.buyerOrgId, input.targetBankOrgId, input.tradeReference, input.title, input.faceAmountKrw, input.dueAt]);
  for (const doc of input.documentIds) await c.query("INSERT INTO revision_document VALUES($1,$2)", [id, doc]);
}

export function services(pool: DatabasePool) {
  return {
    create: (a: Actor, input: RevisionInput) => transaction(pool, async (c) => {
      await requireRole(c, a, "SUPPLIER_OPERATOR");
      await validateReferences(c, a, input);
      const id = randomUUID(), revisionId = randomUUID();
      await c.query("INSERT INTO application(id,supplier_org_id,current_revision_id,created_by) VALUES($1,$2,$3,$4)", [id, a.organizationId, revisionId, a.userId]);
      await insertRevision(c, revisionId, id, 1, input);
      await audit(c, a, "APPLICATION_CREATED", "application", id, null, { revisionId, version: 1 });
      return { id, revisionId, version: 1, status: "DRAFT" };
    }),

    revise: (a: Actor, id: string, input: RevisionInput & { expectedRevision: number }) => transaction(pool, async (c) => {
      await requireRole(c, a, "SUPPLIER_OPERATOR");
      const app = await lockApplication(c, id);
      fail(app.supplier_org_id === a.organizationId, "NOT_FOUND", 404);
      const old = await currentRevision(c, app, input.expectedRevision);
      const reserved = await c.query("SELECT id FROM receivable WHERE application_id=$1", [id]);
      fail(!reserved.rowCount, "REGISTRATION_LOCKED");
      await validateReferences(c, a, input);
      await c.query("UPDATE chain_operation SET status='INVALIDATED',updated_at=now() WHERE application_id=$1 AND receivable_id IS NULL AND status IN ('NOT_SUBMITTED','FAILED')", [id]);
      const revisionId = randomUUID(), version = old.version + 1;
      const invalidated = await c.query(`UPDATE buyer_confirmation SET status='INVALIDATED',invalidated_at=now()
        WHERE application_id=$1 AND status IN ('PENDING','CONFIRMED') RETURNING id`, [id]);
      await insertRevision(c, revisionId, id, version, input);
      await c.query("UPDATE application SET current_revision_id=$2,lock_version=lock_version+1,updated_at=now() WHERE id=$1", [id, revisionId]);
      await audit(c, a, "REVISION_CREATED", "application", id, { version: old.version }, { revisionId, version, invalidatedConfirmationIds: invalidated.rows.map((x) => x.id) });
      return { id, revisionId, version, status: "DRAFT" };
    }),

    review: (a: Actor, id: string, input: z.infer<typeof reviewInput>) => transaction(pool, async (c) => {
      await requireRole(c, a, "SUPPLIER_OPERATOR");
      const app = await lockApplication(c, id);
      fail(app.supplier_org_id === a.organizationId, "NOT_FOUND", 404);
      const r = await currentRevision(c, app, input.expectedRevision);
      fail(!r.frozen_at, "REVISION_FROZEN");
      const issues = await c.query("SELECT id FROM review_issue WHERE revision_id=$1 AND resolution_status='OPEN'", [r.id]);
      fail(!issues.rowCount, "UNRESOLVED_ISSUES");
      const total = input.items.reduce((sum, item) => sum + BigInt(item.quantity) * BigInt(item.unitPriceKrw), 0n);
      fail(total.toString() === r.confirmed_amount, "ITEM_TOTAL_MISMATCH", 400);
      // Fixed schema/property order; callers never provide the digest or reviewed status.
      const fields = { schemaVersion: 1, mode: "MANUAL_DEMO", items: input.items.map((i) => ({ name: i.name, quantity: i.quantity, unitPriceKrw: i.unitPriceKrw })), note: input.note };
      const hash = keccak256(toHex(JSON.stringify(fields)));
      await c.query(`UPDATE application_revision SET status='REVIEW_COMPLETED',confirmed_fields=$2,
        reviewed_fields_hash=$3,review_completed_by=$4,review_completed_at=now() WHERE id=$1`, [r.id, JSON.stringify(fields), hash, a.userId]);
      await audit(c, a, "MANUAL_REVIEW_COMPLETED", "application_revision", r.id, { status: r.status }, { status: "REVIEW_COMPLETED", reviewedFieldsHash: hash }, input.note);
      return { revisionId: r.id, version: r.version, status: "REVIEW_COMPLETED", reviewedFieldsHash: hash };
    }),

    request: (a: Actor, id: string, input: z.infer<typeof requestInput>) => transaction(pool, async (c) => {
      await requireRole(c, a, "SUPPLIER_OPERATOR");
      const app = await lockApplication(c, id);
      fail(app.supplier_org_id === a.organizationId, "NOT_FOUND", 404);
      const r = await currentRevision(c, app, input.expectedRevision);
      fail(r.status === "REVIEW_COMPLETED", "REVIEW_NOT_COMPLETED");
      fail(r.confirmed_due_at.getTime() > Date.now(), "DUE_DATE_PASSED");
      const participants = await c.query("SELECT id FROM organization WHERE id=ANY($1::uuid[]) AND approval_status='APPROVED' AND is_demo=true FOR SHARE", [[r.buyer_org_id, r.target_bank_org_id]]);
      fail(participants.rowCount === 2, "PARTICIPANT_APPROVAL_REVOKED");
      const existing = await c.query("SELECT * FROM buyer_confirmation WHERE revision_id=$1 AND status IN ('PENDING','CONFIRMED')", [r.id]);
      if (existing.rowCount) return existing.rows[0];
      // A rejected/withdrawn request requires a new revision and an explicit review.
      fail(!r.frozen_at, "NEW_REVISION_REQUIRED");
      const issues = await c.query("SELECT id FROM review_issue WHERE revision_id=$1 AND resolution_status='OPEN'", [r.id]);
      fail(!issues.rowCount, "UNRESOLVED_ISSUES");
      const docs = await c.query("SELECT d.id,d.file_hash FROM revision_document rd JOIN document d ON d.id=rd.document_id WHERE rd.revision_id=$1", [r.id]);
      const snapshot: ConfirmationSnapshot = {
        schemaVersion: 1, applicationId: id, revision: r.version, supplierOrgId: app.supplier_org_id,
        buyerOrgId: r.buyer_org_id, targetBankOrgId: r.target_bank_org_id, tradeReference: r.trade_reference,
        faceAmountKrw: r.confirmed_amount, currency: "KRW", dueAt: String(r.confirmed_due_at.getTime() / 1000),
        documents: docs.rows.map((d) => ({ documentId: d.id, sha256: d.file_hash })),
        reviewedFieldsHash: r.reviewed_fields_hash, consentVersion: input.consentVersion,
      };
      const snapshotHash = hashSnapshot(snapshot);
      await c.query(`UPDATE application_revision SET snapshot_hash=$2,frozen_at=now(),consented_by=$3,
        consent_version=$4,submission_consent_at=now() WHERE id=$1`, [r.id, snapshotHash, a.userId, input.consentVersion]);
      const confirmation = await c.query(`INSERT INTO buyer_confirmation(id,application_id,revision_id,buyer_org_id,snapshot_hash,status,requested_by)
        VALUES($1,$2,$3,$4,$5,'PENDING',$6) RETURNING *`, [randomUUID(), id, r.id, r.buyer_org_id, snapshotHash, a.userId]);
      await audit(c, a, "CONFIRMATION_REQUESTED", "buyer_confirmation", confirmation.rows[0].id, null, { status: "PENDING", snapshotHash });
      return confirmation.rows[0];
    }),

    decide: (a: Actor, id: string, input: z.infer<typeof decisionInput>) => transaction(pool, async (c) => {
      await requireRole(c, a, "BUYER_CONFIRMER");
      const found = await c.query("SELECT application_id FROM buyer_confirmation WHERE id=$1 AND buyer_org_id=$2", [id, a.organizationId]);
      fail(found.rowCount, "NOT_FOUND", 404);
      const app = await lockApplication(c, found.rows[0].application_id);
      const result = await c.query(`SELECT cf.*,r.confirmed_due_at,r.snapshot_hash AS revision_hash FROM buyer_confirmation cf
        JOIN application_revision r ON r.id=cf.revision_id WHERE cf.id=$1 FOR UPDATE OF cf`, [id]);
      const cf = result.rows[0];
      fail(app.current_revision_id === cf.revision_id, "STALE_REVISION");
      fail(cf.snapshot_hash === input.snapshotHash && cf.snapshot_hash === cf.revision_hash, "SNAPSHOT_MISMATCH");
      const target = input.decision === "CONFIRM" ? "CONFIRMED" : "REJECTED";
      if (cf.status === target) {
        fail(input.decision !== "REJECT" || cf.rejection_reason === input.reason, "DECISION_ALREADY_RECORDED");
        return cf;
      }
      fail(cf.status === "PENDING", "CONFIRMATION_NOT_PENDING");
      fail(cf.confirmed_due_at.getTime() > Date.now(), "DUE_DATE_PASSED");
      const updated = input.decision === "CONFIRM"
        ? await c.query(`UPDATE buyer_confirmation SET status='CONFIRMED',confirmed_by=$2,confirmed_at=now(),
            delivery_acknowledged=true,payment_obligation_acknowledged=true WHERE id=$1 RETURNING *`, [id, a.userId])
        : await c.query(`UPDATE buyer_confirmation SET status='REJECTED',rejected_by=$2,rejected_at=now(),rejection_reason=$3
            WHERE id=$1 RETURNING *`, [id, a.userId, input.reason]);
      await audit(c, a, target, "buyer_confirmation", id, { status: cf.status }, { status: target }, input.decision === "REJECT" ? input.reason : undefined);
      if (input.decision === "CONFIRM") {
        await c.query(`INSERT INTO chain_operation(id,application_id,revision_id,confirmation_id,idempotency_key)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT(confirmation_id) DO NOTHING`,
          [randomUUID(), cf.application_id, cf.revision_id, id, `register:${id}`]);
      }
      return updated.rows[0];
    }),

    withdraw: (a: Actor, id: string) => transaction(pool, async (c) => {
      await requireRole(c, a, "SUPPLIER_OPERATOR");
      const found = await c.query("SELECT application_id FROM buyer_confirmation WHERE id=$1", [id]);
      fail(found.rowCount, "NOT_FOUND", 404);
      const app = await lockApplication(c, found.rows[0].application_id);
      fail(app.supplier_org_id === a.organizationId, "NOT_FOUND", 404);
      const row = (await c.query("SELECT * FROM buyer_confirmation WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (row.status === "WITHDRAWN") return row;
      fail(row.status === "PENDING", "CONFIRMATION_NOT_PENDING");
      const updated = await c.query("UPDATE buyer_confirmation SET status='WITHDRAWN',withdrawn_at=now() WHERE id=$1 RETURNING *", [id]);
      await audit(c, a, "CONFIRMATION_WITHDRAWN", "buyer_confirmation", id, { status: "PENDING" }, { status: "WITHDRAWN" });
      return updated.rows[0];
    }),
  };
}
