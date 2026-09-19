import { randomUUID } from "node:crypto";
import { keccak256, toHex, type Hex } from "viem";
import { hashSnapshot } from "@paidahead/domain";
import { transaction, type DatabasePool, type PoolClient } from "@paidahead/database";
import { RegistrationError, verifyRegistration, type Deployment, type Registration, type RegistrationChain } from "./chain.ts";

function requireValue(value: unknown, code: string): asserts value {
  if (!value) throw new RegistrationError(code);
}
const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v);

async function validateConfirmation(c: PoolClient, op: { application_id: string; revision_id: string; confirmation_id: string }) {
  const app = (await c.query("SELECT * FROM application WHERE id=$1 FOR UPDATE", [op.application_id])).rows[0];
  requireValue(app?.current_revision_id === op.revision_id, "STALE_CONFIRMATION");
  const cf = (await c.query("SELECT * FROM buyer_confirmation WHERE id=$1", [op.confirmation_id])).rows[0];
  const r = (await c.query("SELECT * FROM application_revision WHERE id=$1", [op.revision_id])).rows[0];
  requireValue(cf?.status === "CONFIRMED" && cf.application_id === op.application_id && cf.revision_id === op.revision_id
    && cf.buyer_org_id === r?.buyer_org_id && cf.delivery_acknowledged && cf.payment_obligation_acknowledged
    && cf.confirmed_by && cf.confirmed_at && r.frozen_at && r.submission_consent_at && r.consented_by
    && r.status === "REVIEW_COMPLETED", "CONFIRMATION_REQUIRED");
  const orgs = await c.query("SELECT id FROM organization WHERE id=ANY($1::uuid[]) AND approval_status='APPROVED' FOR SHARE",
    [[app.supplier_org_id, r.buyer_org_id, r.target_bank_org_id]]);
  requireValue(orgs.rowCount === 3, "PARTICIPANT_NOT_APPROVED");
  const reserved = (await c.query("SELECT supplier_wallet_id,payer_wallet_id FROM receivable WHERE application_id=$1", [app.id])).rows[0];
  if (reserved) {
    const wallets = await c.query("SELECT id FROM wallet_binding WHERE id=ANY($1::uuid[]) AND verification_status='APPROVED' AND approved_at IS NOT NULL FOR SHARE",
      [[reserved.supplier_wallet_id, reserved.payer_wallet_id]]);
    requireValue(wallets.rowCount === 2, "APPROVED_WALLETS_REQUIRED");
  }
  requireValue(r.confirmed_due_at.getTime() > Date.now(), "DUE_DATE_PASSED");
  const fields = r.confirmed_fields;
  const reviewedHash = keccak256(toHex(JSON.stringify({ schemaVersion: 1, mode: "MANUAL_DEMO",
    items: fields.items.map((i: { name: string; quantity: number; unitPriceKrw: string }) => ({ name: i.name, quantity: i.quantity, unitPriceKrw: i.unitPriceKrw })), note: fields.note })));
  requireValue(reviewedHash === r.reviewed_fields_hash, "REVIEW_HASH_MISMATCH");
  const docs = await c.query("SELECT d.id,d.file_hash FROM document d JOIN revision_document rd ON rd.document_id=d.id WHERE rd.revision_id=$1", [r.id]);
  const hash = hashSnapshot({ schemaVersion: 1, applicationId: app.id, revision: r.version, supplierOrgId: app.supplier_org_id,
    buyerOrgId: r.buyer_org_id, targetBankOrgId: r.target_bank_org_id, tradeReference: r.trade_reference,
    faceAmountKrw: r.confirmed_amount, currency: "KRW", dueAt: String(r.confirmed_due_at.getTime() / 1000),
    documents: docs.rows.map((d) => ({ documentId: d.id, sha256: d.file_hash })), reviewedFieldsHash: reviewedHash,
    consentVersion: r.consent_version });
  requireValue(hash === r.snapshot_hash && hash === cf.snapshot_hash, "SNAPSHOT_MISMATCH");
  return { app, cf, r };
}

async function reserve(pool: DatabasePool, operationId: string, deployment: Deployment) {
  return transaction(pool, async (c) => {
    const initial = (await c.query("SELECT * FROM chain_operation WHERE id=$1", [operationId])).rows[0];
    const { app, cf, r } = await validateConfirmation(c, initial);
    const op = (await c.query("SELECT * FROM chain_operation WHERE id=$1 FOR UPDATE", [operationId])).rows[0];
    requireValue(op.status === "NOT_SUBMITTED" || op.status === "PENDING", "OPERATION_NOT_ACTIVE");
    if (op.receivable_id) return op;
    const wallets = await c.query(`SELECT * FROM wallet_binding WHERE organization_id=ANY($1::uuid[]) AND chain_id=$2
      AND verification_status='APPROVED' AND approved_at IS NOT NULL FOR SHARE`, [[app.supplier_org_id, r.buyer_org_id], deployment.chain_id]);
    const supplier = wallets.rows.find((w) => w.organization_id === app.supplier_org_id);
    const payer = wallets.rows.find((w) => w.organization_id === r.buyer_org_id);
    requireValue(wallets.rowCount === 2 && supplier && payer, "APPROVED_WALLETS_REQUIRED");
    const tradeKey = keccak256(toHex(JSON.stringify(["paidahead-trade-v1", app.supplier_org_id, r.buyer_org_id, r.trade_reference.normalize("NFKC").trim()])));
    requireValue(!(await c.query("SELECT id FROM receivable WHERE unique_trade_key=$1", [tradeKey])).rowCount, "DUPLICATE_TRADE");
    const confirmationHash = keccak256(toHex(JSON.stringify(["paidahead-confirmation-v1", cf.id, cf.snapshot_hash, cf.confirmed_by, cf.confirmed_at.toISOString()])));
    const receivableId = randomUUID();
    const tokenId = BigInt(`0x${receivableId.replaceAll("-", "")}`).toString();
    await c.query(`INSERT INTO receivable(id,application_id,revision_id,confirmation_id,unique_trade_key,snapshot_hash,
      confirmation_reference_hash,supplier_org_id,buyer_org_id,bank_org_id,supplier_wallet_id,payer_wallet_id,
      face_amount,due_at,deployment_id,token_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [receivableId, app.id, r.id, cf.id, tradeKey, r.snapshot_hash, confirmationHash, app.supplier_org_id,
        r.buyer_org_id, r.target_bank_org_id, supplier.id, payer.id, r.confirmed_amount, r.confirmed_due_at, deployment.id, tokenId]);
    return (await c.query(`UPDATE chain_operation SET receivable_id=$2,deployment_id=$3,updated_at=now()
      WHERE id=$1 RETURNING *`, [op.id, receivableId, deployment.id])).rows[0];
  });
}

async function loadRegistration(pool: DatabasePool, receivableId: string) {
  const r = (await pool.query(`SELECT r.*,s.address AS supplier_address,p.address AS payer_address FROM receivable r
    JOIN wallet_binding s ON s.id=r.supplier_wallet_id JOIN wallet_binding p ON p.id=r.payer_wallet_id WHERE r.id=$1`, [receivableId])).rows[0];
  const registration: Registration = { tokenId: BigInt(r.token_id), data: { tradeKey: r.unique_trade_key,
    snapshotHash: r.snapshot_hash, confirmationHash: r.confirmation_reference_hash, supplier: r.supplier_address,
    payer: r.payer_address, faceAmount: BigInt(r.face_amount), dueAt: BigInt(r.due_at.getTime() / 1000), status: 1 } };
  return { r, registration };
}

/** Processes at most one operation. Serializes the dedicated registrar across workers. */
export async function runRegistrationOnce(pool: DatabasePool, chain: RegistrationChain) {
  const lock = await pool.connect();
  let locked = false;
  try {
    locked = (await lock.query("SELECT pg_try_advisory_lock(72419202) AS locked")).rows[0].locked;
    if (!locked) return { status: "BUSY" };
    const deployment: Deployment | undefined = (await pool.query("SELECT * FROM chain_deployment WHERE active")).rows[0];
    if (!deployment) return { status: "WAITING_CONFIGURATION" };
    requireValue(Number(deployment.chain_id) === await chain.chainId(), "WRONG_CHAIN");
    requireValue(deployment.registrar_address === chain.registrar.toLowerCase(), "WRONG_REGISTRAR");
    let op = (await pool.query(`SELECT * FROM chain_operation WHERE status IN ('NOT_SUBMITTED','PENDING')
      AND (deployment_id IS NULL OR deployment_id=$1) ORDER BY CASE WHEN status='PENDING' THEN 0 ELSE 1 END,created_at,id LIMIT 1`, [deployment.id])).rows[0];
    if (!op) return { status: "IDLE" };
    try {
      let tx = (await pool.query("SELECT * FROM chain_transaction WHERE operation_id=$1 AND status='PENDING' ORDER BY created_at DESC LIMIT 1", [op.id])).rows[0];
      if (!tx) {
        op = await reserve(pool, op.id, deployment);
        const { registration } = await loadRegistration(pool, op.receivable_id);
        const signed = await chain.prepare(deployment, registration);
        // Persist exact signed bytes BEFORE broadcasting; recovery never allocates a new nonce blindly.
        tx = await transaction(pool, async (c) => {
          await validateConfirmation(c, op);
          const inserted = await c.query(`INSERT INTO chain_transaction(id,operation_id,chain_id,sender_address,nonce,tx_hash,signed_transaction)
            VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [randomUUID(), op.id, deployment.chain_id, deployment.registrar_address, signed.nonce, signed.hash, signed.raw]);
          await c.query("UPDATE chain_operation SET status='PENDING',failure_code=NULL,attempt_count=attempt_count+1,updated_at=now() WHERE id=$1", [op.id]);
          return inserted.rows[0];
        });
      }
      requireValue(keccak256(tx.signed_transaction) === tx.tx_hash, "SIGNED_TRANSACTION_MISMATCH");
      let receipt = await chain.receipt(tx.tx_hash);
      if (!receipt) {
        // A revocation before broadcast blocks new submission; existing receipts still reconcile.
        await transaction(pool, (c) => validateConfirmation(c, op));
        await chain.broadcast(tx.signed_transaction);
        receipt = await chain.receipt(tx.tx_hash);
      }
      if (!receipt) return { operationId: op.id, status: "PENDING" };
      if (await chain.head() < receipt.blockNumber + BigInt(deployment.confirmations - 1)) return { operationId: op.id, status: "PENDING" };
      requireValue(await chain.blockHash(receipt.blockNumber) === receipt.blockHash, "BLOCK_CHANGED");
      requireValue(receipt.transactionHash === tx.tx_hash && receipt.to?.toLowerCase() === deployment.receivable_contract
        && receipt.from.toLowerCase() === deployment.registrar_address, "RECEIPT_MISMATCH");
      if (receipt.status === "reverted") {
        await transaction(pool, async (c) => {
          await c.query("UPDATE chain_transaction SET status='REVERTED',block_number=$2,block_hash=$3 WHERE id=$1", [tx.id, receipt.blockNumber.toString(), receipt.blockHash]);
          await c.query("UPDATE chain_operation SET status='FAILED',failure_code='TRANSACTION_REVERTED',updated_at=now() WHERE id=$1", [op.id]);
        });
        return { operationId: op.id, status: "FAILED", reason: "TRANSACTION_REVERTED" };
      }
      const { r, registration } = await loadRegistration(pool, op.receivable_id);
      const event = verifyRegistration(deployment, registration, receipt, tx.tx_hash);
      const registeredAt = new Date(Number(await chain.blockTime(receipt.blockNumber)) * 1000);
      await transaction(pool, async (c) => {
        await c.query("SELECT id FROM application WHERE id=$1 FOR UPDATE", [op.application_id]);
        await c.query(`INSERT INTO chain_event(id,deployment_id,transaction_id,chain_id,contract_address,tx_hash,log_index,
          block_number,block_hash,event_type,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'ReceivableRegistered',$10)
          ON CONFLICT(chain_id,tx_hash,log_index) DO NOTHING`, [randomUUID(), deployment.id, tx.id, deployment.chain_id,
          deployment.receivable_contract, tx.tx_hash, event.logIndex, receipt.blockNumber.toString(), receipt.blockHash, json(event.args)]);
        await c.query(`UPDATE receivable SET chain_status='REGISTERED',holder_wallet_id=supplier_wallet_id,
          registration_tx_hash=$2,registered_at=$3,synced_at=now() WHERE id=$1 AND chain_status IS NULL`, [r.id, tx.tx_hash, registeredAt]);
        await c.query(`INSERT INTO bank_review(id,receivable_id,bank_org_id,reviewed_snapshot_hash)
          VALUES($1,$2,$3,$4) ON CONFLICT(receivable_id) DO NOTHING`, [randomUUID(), r.id, r.bank_org_id, r.snapshot_hash]);
        await c.query("UPDATE chain_transaction SET status='CONFIRMED',block_number=$2,block_hash=$3,confirmed_at=now() WHERE id=$1", [tx.id, receipt.blockNumber.toString(), receipt.blockHash]);
        await c.query("UPDATE chain_operation SET status='CONFIRMED',failure_code=NULL,confirmed_at=now(),updated_at=now() WHERE id=$1", [op.id]);
      });
      return { operationId: op.id, receivableId: r.id, status: "CONFIRMED", transactionHash: tx.tx_hash };
    } catch (error) {
      const code = error instanceof RegistrationError ? error.message : "RETRYABLE_ERROR";
      const hasPending = (await pool.query("SELECT id FROM chain_transaction WHERE operation_id=$1 AND status='PENDING'", [op.id])).rowCount;
      // Unknown network/DB errors never prove chain failure. Preserve signed transaction for recovery.
      const terminal = error instanceof RegistrationError && !hasPending;
      await pool.query(`UPDATE chain_operation SET status=CASE WHEN $2 THEN 'FAILED' ELSE status END,
        failure_code=$3,updated_at=now() WHERE id=$1 AND status IN ('NOT_SUBMITTED','PENDING')`, [op.id, terminal, code]);
      return { operationId: op.id, status: terminal ? "FAILED" : hasPending ? "PENDING" : "NOT_SUBMITTED", reason: code };
    }
  } finally {
    if (locked) await lock.query("SELECT pg_advisory_unlock(72419202)");
    lock.release();
  }
}
