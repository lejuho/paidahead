import { randomUUID } from "node:crypto";
import { z } from "zod";
import { encodeFunctionData, decodeFunctionData, keccak256, toHex, BaseError, ContractFunctionRevertedError, ExecutionRevertedError, type PublicClient, type Hex } from "viem";
import { settlementAbi, paymentAbi, MAX_KRW, toTokenUnits } from "@paidahead/domain";
import { transaction, type DatabasePool, type PoolClient } from "@paidahead/database";
import { ApiError, requireRole, type Actor } from "./service.ts";
import { uuid } from "./validation.ts";

const text = z.string().trim().min(1).max(2000);
const version = z.number().int().positive();
export const bankDecision = z.object({ expectedVersion: version,
  action: z.enum(["START", "NOTE", "REQUEST_INFO", "DECLINE"]), internalNote: text.optional(), publicMessage: text.optional(),
}).strict();
export const approvalInput = z.object({ expectedVersion: version,
  purchaseAmountKrw: z.string().regex(/^[1-9][0-9]{0,18}$/).refine((v) => BigInt(v) <= MAX_KRW),
  expiresAt: z.string().datetime({ offset: true }).refine((v) => Date.parse(v) % 1000 === 0),
}).strict();
export const operationInput = z.object({ idempotencyKey: uuid,
  kind: z.enum(["CREATE_OFFER", "WITHDRAW_OFFER", "ACCEPT_OFFER", "REPAY", "CANCEL"]),
  approvalId: uuid.optional(), offerId: uuid.optional(),
}).strict();
export const supplementResponse = z.object({ response: text }).strict();
export const hashInput = z.object({ transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((v) => v.toLowerCase()) }).strict();
function must(ok: unknown, code: string, status = 409): asserts ok { if (!ok) throw new ApiError(status, code); }
const hash = (value: unknown) => keccak256(toHex(JSON.stringify(value)));
async function entry(c: PoolClient, a: Actor, review: string, action: string, note?: string, message?: string) {
  await c.query(`INSERT INTO bank_review_entry(id,review_id,actor_id,action,internal_note,public_message) VALUES($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), review, a.userId, action, note ?? null, message ?? null]);
}
async function audit(c: PoolClient, a: Actor, id: string, action: string) {
  await c.query(`INSERT INTO audit_log(id,actor_id,organization_id,action,target_type,target_id,new_value)
    VALUES($1,$2,$3,$4,'wallet_operation',$5,'{}')`, [randomUUID(), a.userId, a.organizationId, action, id]);
}
async function receivable(c: PoolClient, a: Actor, id: string) {
  const r = (await c.query(`SELECT r.*,d.chain_id,d.settlement_contract,d.payment_token,d.bank_wallet_id,d.active,
      s.address AS supplier_address,p.address AS payer_address,b.address AS bank_address
    FROM receivable r JOIN chain_deployment d ON d.id=r.deployment_id
    JOIN wallet_binding s ON s.id=r.supplier_wallet_id JOIN wallet_binding p ON p.id=r.payer_wallet_id
    LEFT JOIN wallet_binding b ON b.id=d.bank_wallet_id WHERE r.id=$1 FOR UPDATE OF r`, [id])).rows[0];
  must(r && [r.supplier_org_id,r.buyer_org_id,r.bank_org_id].includes(a.organizationId), "NOT_FOUND", 404);
  await requireRole(c, a, r.supplier_org_id === a.organizationId ? "SUPPLIER_OPERATOR" : r.buyer_org_id === a.organizationId ? "BUYER_CONFIRMER" : "BANK_REVIEWER");
  return r;
}
async function review(c: PoolClient, a: Actor, id: string) {
  const link = (await c.query("SELECT receivable_id FROM bank_review WHERE id=$1 AND bank_org_id=$2", [id,a.organizationId])).rows[0];
  must(link, "NOT_FOUND", 404);
  const r = await receivable(c,a,link.receivable_id);
  await requireRole(c,a,"BANK_REVIEWER");
  const b = (await c.query("SELECT * FROM bank_review WHERE id=$1 FOR UPDATE", [id])).rows[0];
  return { r,b };
}
async function approvedWallet(c: PoolClient, id: string, org: string, chainId: string) {
  must((await c.query(`SELECT w.id FROM wallet_binding w JOIN organization o ON o.id=w.organization_id
    WHERE w.id=$1 AND w.organization_id=$2 AND w.chain_id=$3 AND w.verification_status='APPROVED'
    AND w.approved_at IS NOT NULL AND o.approval_status='APPROVED' FOR SHARE OF w,o`, [id,org,chainId])).rowCount, "APPROVED_WALLET_REQUIRED");
}
const operationView = (row: Record<string, any>, chainId: string) => ({ id: row.id, kind: row.kind, status: row.status,
  transactionHash: row.tx_hash, failureCode: row.failure_code, ...(row.payment_approval ? { paymentApproval: row.payment_approval } : {}),
  transaction: { chainId: Number(chainId), from: row.sender_address, to: row.to_address, data: row.calldata, value: "0x0", type: "legacy" } });

export function banking(pool: DatabasePool) {
  return {
    detail: (a: Actor, id: string) => transaction(pool, async (c) => {
      const { r,b } = await review(c,a,id);
      const revision = (await c.query("SELECT title,trade_reference,confirmed_fields,reviewed_fields_hash FROM application_revision WHERE id=$1",[r.revision_id])).rows[0];
      const documents = (await c.query(`SELECT d.id,d.document_type,d.original_filename,d.file_hash FROM revision_document rd JOIN document d ON d.id=rd.document_id WHERE rd.revision_id=$1`,[r.revision_id])).rows;
      return { ...b, receivable: r, revision, documents,
        history: (await c.query("SELECT * FROM bank_review_entry WHERE review_id=$1 ORDER BY created_at,id",[id])).rows,
        supplements: (await c.query("SELECT * FROM bank_supplement WHERE review_id=$1 ORDER BY created_at,id",[id])).rows,
        approvals: (await c.query("SELECT * FROM offer_approval WHERE review_id=$1 ORDER BY created_at,id",[id])).rows };
    }),
    decide: (a: Actor, id: string, input: z.infer<typeof bankDecision>) => transaction(pool, async (c) => {
      const { r,b } = await review(c,a,id);
      must(b.version === input.expectedVersion,"STALE_REVIEW");
      must(r.chain_status === "REGISTERED" && new Date(r.due_at).getTime()>Date.now(),"RECEIVABLE_NOT_REVIEWABLE");
      must(!["DECLINED","APPROVED_FOR_OFFER"].includes(b.status),"REVIEW_FINALIZED");
      let status = b.status;
      if (input.action === "START") { must(b.status === "PENDING","INVALID_REVIEW_STATE"); status = "IN_REVIEW"; }
      if (input.action === "NOTE") must(input.internalNote,"NOTE_REQUIRED",400);
      if (input.action === "REQUEST_INFO") {
        must(b.status === "IN_REVIEW" && input.publicMessage,"PUBLIC_REQUEST_REQUIRED"); status = "NEEDS_INFO";
        await c.query(`INSERT INTO bank_supplement(id,review_id,request,requested_by) VALUES($1,$2,$3,$4)`,[randomUUID(),id,input.publicMessage,a.userId]);
      }
      if (input.action === "DECLINE") { must(b.status === "IN_REVIEW" && input.publicMessage,"PUBLIC_REASON_REQUIRED"); status = "DECLINED"; }
      const result = (await c.query(`UPDATE bank_review SET status=$2,version=version+1,reviewer_id=$3,
        internal_note=COALESCE($4,internal_note),public_message=COALESCE($5,public_message),updated_at=now() WHERE id=$1 RETURNING *`,
      [id,status,a.userId,input.internalNote ?? null,input.publicMessage ?? null])).rows[0];
      await entry(c,a,id,input.action,input.internalNote,input.publicMessage);
      return result;
    }),
    respond: (a: Actor, id: string, response: string) => transaction(pool, async (c) => {
      const s = (await c.query("SELECT s.*,b.receivable_id FROM bank_supplement s JOIN bank_review b ON b.id=s.review_id WHERE s.id=$1",[id])).rows[0];
      must(s,"NOT_FOUND",404); const r = await receivable(c,a,s.receivable_id);
      must(r.supplier_org_id === a.organizationId,"NOT_FOUND",404);
      const current = (await c.query("SELECT * FROM bank_supplement WHERE id=$1 FOR UPDATE",[id])).rows[0];
      if (current.status === "SUBMITTED" && current.response === response) return current;
      must(current.status === "REQUESTED" && r.chain_status === "REGISTERED","SUPPLEMENT_NOT_OPEN");
      const result = (await c.query(`UPDATE bank_supplement SET response=$2,status='SUBMITTED',submitted_by=$3,submitted_at=now() WHERE id=$1 RETURNING *`,[id,response,a.userId])).rows[0];
      await entry(c,a,s.review_id,"SUPPLEMENT_SUBMITTED",undefined,response); return result;
    }),
    closeSupplement: (a: Actor, id: string) => transaction(pool, async (c) => {
      const s = (await c.query("SELECT review_id FROM bank_supplement WHERE id=$1",[id])).rows[0];
      must(s,"NOT_FOUND",404); const { r,b } = await review(c,a,s.review_id);
      const current = (await c.query("SELECT * FROM bank_supplement WHERE id=$1 FOR UPDATE",[id])).rows[0];
      if (current.status === "CLOSED") return current;
      must(current.status === "SUBMITTED" && b.status === "NEEDS_INFO" && r.chain_status === "REGISTERED","SUPPLEMENT_NOT_SUBMITTED");
      const result = (await c.query("UPDATE bank_supplement SET status='CLOSED',closed_by=$2 WHERE id=$1 RETURNING *",[id,a.userId])).rows[0];
      await c.query("UPDATE bank_review SET status='IN_REVIEW',version=version+1,updated_at=now() WHERE id=$1",[b.id]);
      await entry(c,a,b.id,"SUPPLEMENT_CLOSED"); return result;
    }),
    approve: (a: Actor, id: string, input: z.infer<typeof approvalInput>) => transaction(pool, async (c) => {
      const { r,b } = await review(c,a,id); await requireRole(c,a,"BANK_APPROVER");
      must(b.version === input.expectedVersion,"STALE_REVIEW");
      must(["IN_REVIEW","APPROVED_FOR_OFFER"].includes(b.status) && b.reviewer_id && b.reviewed_snapshot_hash === r.snapshot_hash,"REVIEW_REQUIRED");
      must(r.chain_status === "REGISTERED" && r.active && r.bank_wallet_id && r.settlement_contract && r.payment_token,"SETTLEMENT_NOT_READY");
      must(!(await c.query("SELECT id FROM bank_supplement WHERE review_id=$1 AND status<>'CLOSED'",[id])).rowCount,"SUPPLEMENT_OPEN");
      must(BigInt(input.purchaseAmountKrw)<=BigInt(r.face_amount) && Date.parse(input.expiresAt)>Date.now() && Date.parse(input.expiresAt)<new Date(r.due_at).getTime(),"INVALID_OFFER_TERMS",400);
      must(!(await c.query(`SELECT a.id FROM offer_approval a LEFT JOIN settlement_offer o ON o.approval_id=a.id
        WHERE a.receivable_id=$1 AND a.expires_at>now() AND (o.id IS NULL OR o.status='ACTIVE')`,[r.id])).rowCount,"LIVE_APPROVAL_EXISTS");
      await approvedWallet(c,r.bank_wallet_id,r.bank_org_id,r.chain_id);
      const approvalId = randomUUID();
      const reference = hash(["paidahead-offer-approval-v1",approvalId,r.id,r.snapshot_hash,input.purchaseAmountKrw,
        new Date(input.expiresAt).toISOString(),r.bank_wallet_id,b.reviewer_id,a.userId]);
      const result = (await c.query(`INSERT INTO offer_approval(id,review_id,receivable_id,snapshot_hash,purchase_amount,expires_at,bank_wallet_id,approved_by,approval_reference)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[approvalId,id,r.id,r.snapshot_hash,input.purchaseAmountKrw,input.expiresAt,r.bank_wallet_id,a.userId,reference])).rows[0];
      await c.query("UPDATE bank_review SET status='APPROVED_FOR_OFFER',version=version+1,updated_at=now() WHERE id=$1",[id]);
      await entry(c,a,id,"OFFER_APPROVED"); return result;
    }),
    list: (a: Actor) => transaction(pool, async (c) => {
      // Authorization is also enforced when opening each receivable.
      const roles = (await c.query(`SELECT r.role FROM membership_role r JOIN user_membership m ON m.id=r.membership_id
        WHERE m.user_id=$1 AND m.organization_id=$2`,[a.userId,a.organizationId])).rows.map((r) => r.role);
      const role = ["SUPPLIER_OPERATOR","BUYER_CONFIRMER","BANK_REVIEWER"].find((r) => roles.includes(r));
      must(role,"FORBIDDEN",403); await requireRole(c,a,role);
      return (await c.query(`SELECT rv.id,rv.application_id,rv.face_amount,rv.due_at,rv.chain_status,rv.purchased_at,rv.repaid_at,
        (rv.chain_status='PURCHASED' AND rv.due_at<now()) AS overdue,v.title,s.display_name AS supplier_name,p.display_name AS buyer_name,
        rv.synced_at,b.status AS review_status,
        (SELECT o.purchase_amount FROM settlement_offer o WHERE o.receivable_id=rv.id AND o.status='ACTIVE' AND o.expires_at>now() AND o.approval_id IS NOT NULL LIMIT 1) AS live_offer_amount,
        (SELECT count(*)::int FROM bank_supplement q WHERE q.review_id=b.id AND q.status='REQUESTED') AS open_supplements
        FROM receivable rv LEFT JOIN bank_review b ON b.receivable_id=rv.id JOIN application_revision v ON v.id=rv.revision_id
        JOIN organization s ON s.id=rv.supplier_org_id JOIN organization p ON p.id=rv.buyer_org_id
        WHERE $1 IN (rv.supplier_org_id,rv.buyer_org_id,rv.bank_org_id) AND rv.chain_status IS NOT NULL ORDER BY rv.created_at DESC,rv.id LIMIT 100`,[a.organizationId])).rows;
    }),
    state: (a: Actor, id: string) => transaction(pool, async (c) => {
      const r = await receivable(c,a,id);
      const b = (await c.query("SELECT id,status,public_message,version FROM bank_review WHERE receivable_id=$1",[id])).rows[0];
      const offers = (await c.query(`SELECT *,CASE WHEN status='ACTIVE' AND expires_at<=now() THEN 'EXPIRED' ELSE status END AS effective_status
        FROM settlement_offer WHERE receivable_id=$1 ORDER BY created_at,id`,[id])).rows;
      const supplements = b ? (await c.query("SELECT id,request,status,response,created_at,submitted_at FROM bank_supplement WHERE review_id=$1 ORDER BY created_at,id",[b.id])).rows : [];
      const labels = (await c.query(`SELECT v.title,v.trade_reference,s.display_name AS supplier_name,p.display_name AS buyer_name,k.display_name AS bank_name
        FROM application_revision v,organization s,organization p,organization k WHERE v.id=$1 AND s.id=$2 AND p.id=$3 AND k.id=$4`,
        [r.revision_id,r.supplier_org_id,r.buyer_org_id,r.bank_org_id])).rows[0];
      return { ...r, ...labels, overdue: r.chain_status === "PURCHASED" && new Date(r.due_at).getTime()<Date.now(), bankReview: b, offers, supplements,
        events: (await c.query("SELECT event_type,tx_hash,block_number,occurred_at,payload FROM settlement_event WHERE receivable_id=$1 ORDER BY block_number,log_index",[id])).rows };
    }),
    prepare: (a: Actor, id: string, input: z.infer<typeof operationInput>) => transaction(pool, async (c) => {
      const r = await receivable(c,a,id);
      const requestHash = hash([id,input.kind,input.approvalId ?? null,input.offerId ?? null]);
      const previous = (await c.query("SELECT * FROM wallet_operation WHERE organization_id=$1 AND idempotency_key=$2",[a.organizationId,input.idempotencyKey])).rows[0];
      if (previous) { must(previous.request_hash === requestHash,"IDEMPOTENCY_CONFLICT"); return operationView(previous,r.chain_id); }
      must(r.active && r.settlement_contract && r.payment_token && r.bank_wallet_id,"SETTLEMENT_NOT_CONFIGURED");
      must(input.kind === "CREATE_OFFER" ? !!input.approvalId && !input.offerId : ["WITHDRAW_OFFER","ACCEPT_OFFER"].includes(input.kind) ? !!input.offerId && !input.approvalId : !input.offerId && !input.approvalId,"INVALID_OPERATION_ARGUMENTS",400);
      let sender = r.supplier_address, data: Hex;
      let approval: { chainId: number; from: string; to: string; data: Hex; value: string; type: string } | undefined;
      const active = r.chain_status === "REGISTERED" && new Date(r.due_at).getTime()>Date.now();
      if (input.kind === "CREATE_OFFER") {
        await requireRole(c,a,"BANK_APPROVER"); must(a.organizationId === r.bank_org_id,"FORBIDDEN",403);
        const approved = (await c.query("SELECT * FROM offer_approval WHERE id=$1 AND receivable_id=$2",[input.approvalId,id])).rows[0];
        must(approved && active && new Date(approved.expires_at).getTime()>Date.now(),"APPROVAL_NOT_ACTIVE");
        must(!(await c.query("SELECT id FROM settlement_offer WHERE receivable_id=$1 AND status='ACTIVE' AND expires_at>now()",[id])).rowCount,"ACTIVE_OFFER_EXISTS");
        must(!(await c.query("SELECT id FROM settlement_offer WHERE approval_id=$1",[approved.id])).rowCount,"APPROVAL_ALREADY_USED");
        await approvedWallet(c,r.bank_wallet_id,r.bank_org_id,r.chain_id); sender=r.bank_address;
        data=encodeFunctionData({ abi:settlementAbi,functionName:"createOffer",args:[BigInt(r.token_id),BigInt(approved.purchase_amount),BigInt(new Date(approved.expires_at).getTime()/1000),approved.approval_reference] });
        approval={chainId:Number(r.chain_id),from:sender,to:r.payment_token,value:"0x0",type:"legacy",data:encodeFunctionData({abi:paymentAbi,functionName:"approve",args:[r.settlement_contract,toTokenUnits(approved.purchase_amount)]})};
      } else if (input.kind === "WITHDRAW_OFFER" || input.kind === "ACCEPT_OFFER") {
        const o = (await c.query("SELECT * FROM settlement_offer WHERE id=$1 AND receivable_id=$2",[input.offerId,id])).rows[0];
        must(o && o.status === "ACTIVE","OFFER_NOT_ACTIVE");
        if (input.kind === "WITHDRAW_OFFER") {
          await requireRole(c,a,"BANK_APPROVER"); must(a.organizationId === r.bank_org_id,"FORBIDDEN",403); sender=r.bank_address;
          data=encodeFunctionData({abi:settlementAbi,functionName:"withdrawOffer",args:[BigInt(o.offer_id)]});
        } else {
          must(a.organizationId === r.supplier_org_id,"FORBIDDEN",403);
          must(active && o.approval_id && new Date(o.expires_at).getTime()>Date.now(),"OFFER_NOT_ACCEPTABLE");
          await approvedWallet(c,r.supplier_wallet_id,r.supplier_org_id,r.chain_id); await approvedWallet(c,r.bank_wallet_id,r.bank_org_id,r.chain_id);
          data=encodeFunctionData({abi:settlementAbi,functionName:"acceptOffer",args:[BigInt(o.offer_id)]});
        }
      } else if (input.kind === "REPAY") {
        must(a.organizationId === r.buyer_org_id,"FORBIDDEN",403); must(r.chain_status === "PURCHASED","NOT_PURCHASED");
        await approvedWallet(c,r.payer_wallet_id,r.buyer_org_id,r.chain_id); sender=r.payer_address;
        data=encodeFunctionData({abi:settlementAbi,functionName:"repay",args:[BigInt(r.token_id)]});
        approval={chainId:Number(r.chain_id),from:sender,to:r.payment_token,value:"0x0",type:"legacy",data:encodeFunctionData({abi:paymentAbi,functionName:"approve",args:[r.settlement_contract,toTokenUnits(r.face_amount)]})};
      } else {
        must(a.organizationId === r.supplier_org_id,"FORBIDDEN",403); must(r.chain_status === "REGISTERED","NOT_CANCELLABLE");
        data=encodeFunctionData({abi:settlementAbi,functionName:"cancel",args:[BigInt(r.token_id)]});
      }
      must(!(await c.query("SELECT id FROM wallet_operation WHERE deployment_id=$1 AND sender_address=$2 AND calldata=$3 AND status IN ('AWAITING_SIGNATURE','PENDING')",[r.deployment_id,sender,data])).rowCount,"OPERATION_IN_PROGRESS");
      const op = (await c.query(`INSERT INTO wallet_operation(id,receivable_id,deployment_id,actor_id,organization_id,kind,idempotency_key,request_hash,sender_address,to_address,calldata,payment_approval)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[randomUUID(),id,r.deployment_id,a.userId,a.organizationId,input.kind,input.idempotencyKey,requestHash,sender,r.settlement_contract,data,approval ?? null])).rows[0];
      await audit(c,a,op.id,"WALLET_OPERATION_PREPARED");
      return { ...operationView(op,r.chain_id), ...(approval ? { paymentApproval:approval } : {}) };
    }),
    preflight: async (a: Actor, id: string, client?: PublicClient) => {
      const { r,op } = await transaction(pool,async(c)=>{
        const op=(await c.query("SELECT * FROM wallet_operation WHERE id=$1 AND organization_id=$2",[id,a.organizationId])).rows[0];
        must(op,"NOT_FOUND",404); const r=await receivable(c,a,op.receivable_id); return {r,op};
      });
      must(client,"CHAIN_RPC_NOT_CONFIGURED",503);
      try {
        must(await client.getChainId() === Number(r.chain_id),"WRONG_CHAIN",503);
        let fundingAddress: Hex | undefined, required: bigint | undefined;
        if (op.kind === "CREATE_OFFER" || op.kind === "REPAY") {
          const decoded=decodeFunctionData({abi:paymentAbi,data:op.payment_approval.data});
          if (decoded.functionName === "approve") required=decoded.args[1];
          fundingAddress=op.sender_address;
        } else if (op.kind === "ACCEPT_OFFER") {
          const decoded=decodeFunctionData({abi:settlementAbi,data:op.calldata});
          if (decoded.functionName === "acceptOffer") {
            const o=(await pool.query("SELECT purchase_amount FROM settlement_offer WHERE deployment_id=$1 AND offer_id=$2",[r.deployment_id,decoded.args[0].toString()])).rows[0];
            required=toTokenUnits(o.purchase_amount); fundingAddress=r.bank_address;
          }
        }
        const nativeBalance=await client.getBalance({address:op.sender_address});
        let payment;
        if (fundingAddress && required !== undefined) {
          const [balance,allowance]=await Promise.all([
            client.readContract({address:r.payment_token,abi:paymentAbi,functionName:"balanceOf",args:[fundingAddress]}),
            client.readContract({address:r.payment_token,abi:paymentAbi,functionName:"allowance",args:[fundingAddress,r.settlement_contract]}),
          ]);
          payment={address:r.payment_token,fundingAddress,requiredRaw:required.toString(),balanceRaw:balance.toString(),allowanceRaw:allowance.toString(),
            sufficientBalance:balance>=required,sufficientAllowance:allowance>=required};
        }
        try {
          const decoded=decodeFunctionData({abi:settlementAbi,data:op.calldata});
          const config={account:op.sender_address,address:op.to_address,abi:settlementAbi};
          switch(decoded.functionName) {
            case "createOffer": await client.simulateContract({...config,...decoded}); break;
            case "acceptOffer": await client.simulateContract({...config,...decoded}); break;
            case "withdrawOffer": await client.simulateContract({...config,...decoded}); break;
            case "repay": await client.simulateContract({...config,...decoded}); break;
            case "cancel": await client.simulateContract({...config,...decoded}); break;
            default: throw new ApiError(409,"INVALID_OPERATION");
          }
          const gas=await client.estimateGas({account:op.sender_address,to:op.to_address,data:op.calldata,value:0n});
          const gasPrice=await client.getGasPrice();
          return {simulation:"OK",gas:gas.toString(),gasPrice:gasPrice.toString(),nativeBalance:nativeBalance.toString(),
            sufficientGasBalance:nativeBalance>=gas*gasPrice,payment};
        } catch(error) {
          const cause=error instanceof BaseError ? error.walk((e)=>e instanceof ContractFunctionRevertedError || e instanceof ExecutionRevertedError) : null;
          if(cause instanceof ContractFunctionRevertedError || cause instanceof ExecutionRevertedError) {
            return {simulation:"CONTRACT_REJECTED",nativeBalance:nativeBalance.toString(),payment};
          }
          throw error;
        }
      } catch(error) { if(error instanceof ApiError) throw error; throw new ApiError(503,"CHAIN_RPC_UNAVAILABLE"); }
    },
    operation: (a: Actor, id: string, txHash?: string, rejected=false) => transaction(pool, async (c) => {
      const link = (await c.query("SELECT receivable_id FROM wallet_operation WHERE id=$1 AND organization_id=$2",[id,a.organizationId])).rows[0];
      must(link,"NOT_FOUND",404); const r = await receivable(c,a,link.receivable_id);
      const op = (await c.query("SELECT * FROM wallet_operation WHERE id=$1 FOR UPDATE",[id])).rows[0];
      if (txHash) {
        if (op.tx_hash === txHash) return operationView(op,r.chain_id);
        must(op.status === "AWAITING_SIGNATURE" && !op.tx_hash,"OPERATION_ALREADY_SUBMITTED");
        await c.query("UPDATE wallet_operation SET tx_hash=$2,status='PENDING' WHERE id=$1",[id,txHash]);
        op.tx_hash=txHash; op.status="PENDING"; await audit(c,a,id,"WALLET_TRANSACTION_REPORTED");
      } else if (rejected) {
        must(op.status === "AWAITING_SIGNATURE","OPERATION_ALREADY_SUBMITTED");
        await c.query("UPDATE wallet_operation SET status='USER_REJECTED' WHERE id=$1",[id]); op.status="USER_REJECTED";
        await audit(c,a,id,"WALLET_SIGNATURE_REJECTED");
      }
      return operationView(op,r.chain_id);
    }),
  };
}
