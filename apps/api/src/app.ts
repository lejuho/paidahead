import { documentAi } from "./document-ai.ts";
import Fastify, { type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { type PublicClient } from "viem";
import { tokenHash, transaction, readDemoDocument, type DatabasePool } from "@paidahead/database";
import { ApiError, requireRole, services, type Actor } from "./service.ts";
import { uuid, revisionInput, revisionNumber, reviewInput, requestInput, decisionInput } from "./validation.ts";
import { queries } from "./queries.ts";
import { banking, bankDecision, approvalInput, operationInput, supplementResponse, hashInput } from "./banking.ts";

export function createApp(pool: DatabasePool, options: { demoMode: boolean; chainClient?: PublicClient }) {
  if (!options.demoMode || process.env.NODE_ENV === "production") throw new Error("Only non-production demo authentication is implemented");
  const app = Fastify({ bodyLimit: 64 * 1024, logger: false });
  const service = services(pool);
  const analyze = documentAi(pool);
  const bank = banking(pool);
  const view = queries(pool);
  const actors = new WeakMap<FastifyRequest, Actor>();
  const actor = (r: FastifyRequest) => actors.get(r)!;
  const id = (r: FastifyRequest) => z.object({ id: uuid }).parse(r.params).id;

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: "INVALID_INPUT", fields: error.issues.map((i) => i.path.join(".")) });
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.code });
    const e = error as { code?: string; statusCode?: number };
    if (["23505", "23514", "23503"].includes(e.code ?? "")) return reply.code(409).send({ error: "DATA_CONFLICT" });
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) return reply.code(e.statusCode).send({ error: "INVALID_REQUEST" });
    app.log.error(error);
    return reply.code(500).send({ error: "INTERNAL_ERROR" });
  });
  app.get("/health", async () => { await pool.query("SELECT 1"); return { status: "ok", mode: "demo" }; });
  app.register(async (api) => {
    api.addHook("onRequest", async (request) => {
      const token = request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      if (!token) throw new ApiError(401, "UNAUTHENTICATED");
      const result = await pool.query(`SELECT u.id FROM demo_session s JOIN app_user u ON u.id=s.user_id
        WHERE s.token_hash=$1 AND s.expires_at>now() AND u.status='ACTIVE'`, [tokenHash(token)]);
      if (!result.rowCount) throw new ApiError(401, "UNAUTHENTICATED");
      const org = uuid.safeParse(request.headers["x-organization-id"]);
      if (!org.success) throw new ApiError(400, "ORGANIZATION_HEADER_REQUIRED");
      const member = await pool.query(`SELECT m.id FROM user_membership m JOIN organization o ON o.id=m.organization_id
        WHERE m.user_id=$1 AND m.organization_id=$2 AND m.status='ACTIVE' AND o.approval_status='APPROVED' AND o.is_demo=true`, [result.rows[0].id, org.data]);
      if (!member.rowCount) throw new ApiError(403, "FORBIDDEN");
      actors.set(request, { userId: result.rows[0].id, organizationId: org.data });
    });
    api.get("/me", async (r) => view.me(actor(r)));
    api.get("/chain", async () => view.chain());
    api.get("/applications", async (r) => view.applications(actor(r)));
    api.get("/receivables/:id/operations", async (r) => view.operations(actor(r), id(r)));
    api.get("/bank/reviews/:id", async (r) => bank.detail(actor(r), id(r)));
    api.post("/bank/reviews/:id/decision", async (r) => bank.decide(actor(r), id(r), bankDecision.parse(r.body)));
    api.post("/bank/reviews/:id/approvals", async (r) => bank.approve(actor(r), id(r), approvalInput.parse(r.body)));
    api.post("/supplements/:id/response", async (r) => bank.respond(actor(r), id(r), supplementResponse.parse(r.body).response));
    api.post("/bank/supplements/:id/close", async (r) => bank.closeSupplement(actor(r), id(r)));
    api.get("/receivables", async (r) => bank.list(actor(r)));
    api.get("/receivables/:id", async (r) => bank.state(actor(r), id(r)));
    api.post("/receivables/:id/operations", async (r) => bank.prepare(actor(r), id(r), operationInput.parse(r.body)));
    api.get("/operations/:id", async (r) => bank.operation(actor(r), id(r)));
    api.get("/operations/:id/preflight", async (r) => bank.preflight(actor(r), id(r), options.chainClient));
    api.post("/operations/:id/transaction", async (r) => bank.operation(actor(r), id(r), hashInput.parse(r.body).transactionHash));
    api.post("/operations/:id/reject", async (r) => bank.operation(actor(r), id(r), undefined, true));
    api.get("/demo/catalog", async (r) => ({
      organizations: (await pool.query("SELECT id,display_name,kind FROM organization WHERE is_demo=true AND approval_status='APPROVED'")).rows,
      documents: (await pool.query("SELECT id,document_type,original_filename,file_hash FROM document WHERE owner_org_id=$1", [actor(r).organizationId])).rows,
    }));
    api.post("/applications", async (r, reply) => reply.code(201).send(await service.create(actor(r), revisionInput.parse(r.body))));
    api.post("/applications/:id/revisions", async (r, reply) => reply.code(201).send(await service.revise(actor(r), id(r), revisionInput.extend({ expectedRevision: revisionNumber }).parse(r.body))));
    api.post("/applications/:id/analysis", async (r) => analyze(actor(r), id(r), z.object({ expectedRevision: revisionNumber }).strict().parse(r.body).expectedRevision));
    api.post("/applications/:id/review", async (r) => service.review(actor(r), id(r), reviewInput.parse(r.body)));
    api.post("/applications/:id/confirmations", async (r) => service.request(actor(r), id(r), requestInput.parse(r.body)));
    api.post("/confirmations/:id/decision", async (r) => service.decide(actor(r), id(r), decisionInput.parse(r.body)));
    api.post("/confirmations/:id/withdraw", async (r) => service.withdraw(actor(r), id(r)));

    api.get("/applications/:id/registration", async (r) => transaction(pool, async (c) => {
      const a = actor(r);
      const row = (await c.query(`SELECT a.supplier_org_id,v.buyer_org_id FROM application a
        JOIN application_revision v ON v.id=a.current_revision_id WHERE a.id=$1`, [id(r)])).rows[0];
      if (!row || ![row.supplier_org_id,row.buyer_org_id].includes(a.organizationId)) throw new ApiError(404, "NOT_FOUND");
      await requireRole(c, a, row.supplier_org_id === a.organizationId ? "SUPPLIER_OPERATOR" : "BUYER_CONFIRMER");
      const result = await c.query(`SELECT op.id,op.status,op.failure_code,op.attempt_count,op.confirmation_id,
        op.receivable_id,rv.token_id,rv.chain_status,rv.registration_tx_hash,rv.registered_at
        FROM chain_operation op LEFT JOIN receivable rv ON rv.id=op.receivable_id
        WHERE op.application_id=$1 ORDER BY op.created_at DESC,op.id DESC LIMIT 1`, [id(r)]);
      return result.rows[0] ?? { status: "CONFIRMATION_REQUIRED" };
    }));
    api.post("/applications/:id/registration/retry", async (r) => transaction(pool, async (c) => {
      const a = actor(r);
      await requireRole(c, a, "SUPPLIER_OPERATOR");
      const row = (await c.query("SELECT * FROM application WHERE id=$1 AND supplier_org_id=$2 FOR UPDATE", [id(r), a.organizationId])).rows[0];
      if (!row) throw new ApiError(404, "NOT_FOUND");
      const op = (await c.query("SELECT * FROM chain_operation WHERE application_id=$1 AND revision_id=$2 FOR UPDATE", [id(r), row.current_revision_id])).rows[0];
      if (!op || op.status !== "FAILED") throw new ApiError(409, "REGISTRATION_NOT_RETRYABLE");
      const pending = await c.query("SELECT id FROM chain_transaction WHERE operation_id=$1 AND status='PENDING'", [op.id]);
      if (pending.rowCount) throw new ApiError(409, "TRANSACTION_RESULT_UNKNOWN");
      await c.query("UPDATE chain_operation SET status='NOT_SUBMITTED',failure_code=NULL,updated_at=now() WHERE id=$1", [op.id]);
      await c.query(`INSERT INTO audit_log(id,actor_id,organization_id,action,target_type,target_id,previous_value,new_value)
        VALUES(gen_random_uuid(),$1,$2,'REGISTRATION_RETRY_REQUESTED','chain_operation',$3,'{"status":"FAILED"}','{"status":"NOT_SUBMITTED"}')`, [a.userId, a.organizationId, op.id]);
      return { id: op.id, status: "NOT_SUBMITTED" };
    }));
    api.get("/bank/reviews", async (r) => transaction(pool, async (c) => {
      await requireRole(c, actor(r), "BANK_REVIEWER");
      return (await c.query(`SELECT b.id,b.status,b.receivable_id,b.created_at,rv.face_amount,rv.due_at,rv.chain_status,
        v.title,s.display_name AS supplier_name,p.display_name AS buyer_name,b.updated_at,
        (SELECT count(*)::int FROM bank_supplement q WHERE q.review_id=b.id AND q.status='SUBMITTED') AS submitted_supplements,
        EXISTS(SELECT 1 FROM settlement_offer o WHERE o.receivable_id=rv.id AND o.status='ACTIVE' AND o.expires_at>now()) AS live_offer,
        EXISTS(SELECT 1 FROM offer_approval a LEFT JOIN settlement_offer o ON o.approval_id=a.id
          WHERE a.receivable_id=rv.id AND a.expires_at>now() AND o.id IS NULL) AS open_approval
        FROM bank_review b JOIN receivable rv ON rv.id=b.receivable_id JOIN application_revision v ON v.id=rv.revision_id
        JOIN organization s ON s.id=rv.supplier_org_id JOIN organization p ON p.id=rv.buyer_org_id WHERE b.bank_org_id=$1 ORDER BY b.created_at DESC LIMIT 100`, [actor(r).organizationId])).rows;
    }));

    api.get("/documents/:id/content", async (r, reply) => transaction(pool, async (c) => {
      const a = actor(r);
      const result = await c.query("SELECT * FROM document WHERE id=$1", [id(r)]);
      if (!result.rowCount) throw new ApiError(404, "NOT_FOUND");
      const document = result.rows[0];
      if (document.owner_org_id === a.organizationId) {
        await requireRole(c, a, "SUPPLIER_OPERATOR");
      } else {
        const bankAccess = await c.query(`SELECT b.id FROM bank_review b JOIN receivable rv ON rv.id=b.receivable_id
          JOIN revision_document rd ON rd.revision_id=rv.revision_id WHERE rd.document_id=$1 AND b.bank_org_id=$2 LIMIT 1`, [id(r), a.organizationId]);
        if (bankAccess.rowCount) await requireRole(c, a, "BANK_REVIEWER");
        else {
          await requireRole(c, a, "BUYER_CONFIRMER");
          const permitted = await c.query(`SELECT cf.id FROM buyer_confirmation cf JOIN revision_document rd ON rd.revision_id=cf.revision_id
            WHERE rd.document_id=$1 AND cf.buyer_org_id=$2 LIMIT 1`, [id(r), a.organizationId]);
          if (!permitted.rowCount) throw new ApiError(404, "NOT_FOUND");
        }
      }
      const bytes = await readDemoDocument(document.storage_key, document.file_hash);
      return reply.header("Cache-Control", "private, no-store").type("text/plain; charset=utf-8").send(bytes);
    }));

    api.get("/applications/:id", async (r) => transaction(pool, async (c) => {
      const a = actor(r);
      await requireRole(c, a, "SUPPLIER_OPERATOR");
      const row = await c.query(`SELECT a.id,a.lock_version,r.* FROM application a JOIN application_revision r ON r.id=a.current_revision_id
        WHERE a.id=$1 AND a.supplier_org_id=$2`, [id(r), a.organizationId]);
      if (!row.rowCount) throw new ApiError(404, "NOT_FOUND");
      const v = row.rows[0];
      const names = await c.query("SELECT id,display_name FROM organization WHERE id=ANY($1::uuid[])", [[v.buyer_org_id, v.target_bank_org_id]]);
      const name = (org: string) => names.rows.find((o) => o.id === org)?.display_name;
      const confirmation = await c.query(`SELECT id,status,snapshot_hash,requested_at,confirmed_at,rejected_at,rejection_reason,withdrawn_at
        FROM buyer_confirmation WHERE revision_id=$1 ORDER BY requested_at DESC,id LIMIT 1`, [v.id]);
      const documents = await c.query(`SELECT d.id,d.document_type,d.original_filename,d.file_hash FROM revision_document rd
        JOIN document d ON d.id=rd.document_id WHERE rd.revision_id=$1 ORDER BY d.document_type`, [v.id]);
      return { ...v, id: id(r), revision_id: v.id, application_id: id(r), buyer_name: name(v.buyer_org_id), bank_name: name(v.target_bank_org_id),
        confirmation: confirmation.rows[0] ?? null, documents: documents.rows };
    }));
    api.get("/confirmations", async (r) => transaction(pool, async (c) => {
      const a = actor(r);
      await requireRole(c, a, "BUYER_CONFIRMER");
      const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).default(0) }).parse(r.query);
      return (await c.query(`SELECT cf.*,r.title,r.confirmed_amount,r.confirmed_due_at,s.display_name AS supplier_name FROM buyer_confirmation cf
        JOIN application_revision r ON r.id=cf.revision_id JOIN application ap ON ap.id=cf.application_id
        JOIN organization s ON s.id=ap.supplier_org_id WHERE cf.buyer_org_id=$1 ORDER BY cf.requested_at DESC,cf.id LIMIT $2 OFFSET $3`,
        [a.organizationId, query.limit, query.offset])).rows;
    }));
    api.get("/confirmations/:id", async (r) => transaction(pool, async (c) => {
      const a = actor(r);
      await requireRole(c, a, "BUYER_CONFIRMER");
      const row = await c.query(`SELECT cf.*,r.version,r.title,r.trade_reference,r.confirmed_amount,r.currency,
        r.confirmed_due_at,r.confirmed_fields,r.reviewed_fields_hash,s.display_name AS supplier_name FROM buyer_confirmation cf
        JOIN application_revision r ON r.id=cf.revision_id JOIN application ap ON ap.id=cf.application_id
        JOIN organization s ON s.id=ap.supplier_org_id WHERE cf.id=$1 AND cf.buyer_org_id=$2`, [id(r), a.organizationId]);
      if (!row.rowCount) throw new ApiError(404, "NOT_FOUND");
      const documents = await c.query(`SELECT d.id,d.document_type,d.original_filename,d.file_hash FROM revision_document rd
        JOIN document d ON d.id=rd.document_id WHERE rd.revision_id=$1`, [row.rows[0].revision_id]);
      return { ...row.rows[0], documents: documents.rows };
    }));
  });
  return app;
}
