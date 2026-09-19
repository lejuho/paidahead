import { randomUUID } from "node:crypto";
import { parseEventLogs, TransactionReceiptNotFoundError, type PublicClient, type Hex, type TransactionReceipt } from "viem";
import { settlementAbi, toTokenUnits } from "@paidahead/domain";
import { transaction, type DatabasePool, type PoolClient } from "@paidahead/database";

const lower = (v: string | null | undefined) => v?.toLowerCase();
const json = (v: unknown) => JSON.stringify(v, (_key,value) => typeof value === "bigint" ? value.toString() : value);
function check(ok: unknown, code: string): asserts ok { if (!ok) throw new Error(code); }

/** Read-only chain access. Wallets sign; this worker never holds bank/supplier/payer keys. */
export async function runSettlementOnce(pool: DatabasePool, client: PublicClient) {
  const lock = await pool.connect();
  let locked = false;
  try {
    locked = (await lock.query("SELECT pg_try_advisory_lock(72419203) AS locked")).rows[0].locked;
    if (!locked) return { status:"BUSY" };
    const d = (await pool.query(`SELECT d.*,w.address AS bank_address FROM chain_deployment d
      JOIN wallet_binding w ON w.id=d.bank_wallet_id WHERE d.active AND d.settlement_contract IS NOT NULL AND d.payment_token IS NOT NULL`)).rows[0];
    if (!d) return { status:"WAITING_CONFIGURATION" };
    check(await client.getChainId() === Number(d.chain_id),"WRONG_CHAIN");
    const [token,payment,bank,scale] = await Promise.all([
      client.readContract({address:d.settlement_contract,abi:settlementAbi,functionName:"receivable"}),
      client.readContract({address:d.settlement_contract,abi:settlementAbi,functionName:"paymentToken"}),
      client.readContract({address:d.settlement_contract,abi:settlementAbi,functionName:"designatedBank"}),
      client.readContract({address:d.settlement_contract,abi:settlementAbi,functionName:"tokenScale"}),
    ]);
    check(lower(token) === d.receivable_contract && lower(payment) === d.payment_token && lower(bank) === d.bank_address && scale === 1_000_000n,"SETTLEMENT_CONFIGURATION_MISMATCH");
    const cursor = (await pool.query("SELECT * FROM settlement_cursor WHERE deployment_id=$1",[d.id])).rows[0];
    if (cursor) check(lower((await client.getBlock({blockNumber:BigInt(cursor.block_number)})).hash) === cursor.block_hash,"SETTLEMENT_REORG_DETECTED");
    const head = await client.getBlockNumber({cacheTime:0});
    const safeHead = head - BigInt(d.confirmations) + 1n;
    const from = cursor ? BigInt(cursor.block_number)+1n : BigInt(d.deployment_block);
    const to = safeHead < from+499n ? safeHead : from+499n;
    let processed = 0;
    if (to >= from) {
      const logs = await client.getLogs({address:d.settlement_contract,fromBlock:from,toBlock:to});
      const events = parseEventLogs({abi:settlementAbi,logs,strict:true}).sort((a,b) => a.blockNumber!<b.blockNumber! ? -1 : a.blockNumber!>b.blockNumber! ? 1 : a.logIndex!-b.logIndex!);
      const blocks = new Map<string, Awaited<ReturnType<typeof client.getBlock>>>();
      const receipts = new Map<string, TransactionReceipt>();
      const txs = new Map<string, Awaited<ReturnType<typeof client.getTransaction>>>();
      for (const e of events) {
        const h=e.transactionHash!, n=e.blockNumber!;
        if (!blocks.has(n.toString())) blocks.set(n.toString(),await client.getBlock({blockNumber:n}));
        if (!receipts.has(h)) {
          receipts.set(h,await client.getTransactionReceipt({hash:h}));
          txs.set(h,await client.getTransaction({hash:h}));
        }
        const receipt=receipts.get(h)!, tx=txs.get(h)!;
        check(receipt.status === "success" && receipt.transactionHash === h && receipt.blockNumber === n && lower(receipt.to) === d.settlement_contract
          && receipt.blockHash === blocks.get(n.toString())!.hash && e.blockHash === receipt.blockHash
          && tx.hash === h && tx.blockHash === receipt.blockHash && lower(tx.from) === lower(receipt.from) && tx.value === 0n,"SETTLEMENT_RECEIPT_MISMATCH");
        check(receipt.logs.some((l) => l.logIndex === e.logIndex && lower(l.address) === d.settlement_contract && l.data === e.data && json(l.topics) === json(e.topics)),"SETTLEMENT_EVENT_MISSING");
      }
      const end = await client.getBlock({blockNumber:to});
      // Projection, event log, operation confirmation and cursor commit together.
      await transaction(pool, async (c) => {
        for (const e of events) {
          const r = (await c.query(`SELECT r.*,s.address AS supplier_address,p.address AS payer_address
            FROM receivable r JOIN wallet_binding s ON s.id=r.supplier_wallet_id JOIN wallet_binding p ON p.id=r.payer_wallet_id
            WHERE r.deployment_id=$1 AND r.token_id=$2 FOR UPDATE OF r`,[d.id,e.args.tokenId.toString()])).rows[0];
          // Tokens created outside this application have no private record to update.
          if (!r) continue;
          check(r.chain_status,"REGISTRATION_NOT_SYNCED");
          const time = new Date(Number(blocks.get(e.blockNumber!.toString())!.timestamp)*1000);
          const receipt=receipts.get(e.transactionHash!)!, tx=txs.get(e.transactionHash!)!;
          const inserted = await c.query(`INSERT INTO settlement_event(id,deployment_id,receivable_id,tx_hash,log_index,block_number,block_hash,event_type,payload,occurred_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
          [randomUUID(),d.id,r.id,e.transactionHash,e.logIndex,e.blockNumber!.toString(),e.blockHash,e.eventName,json(e.args),time]);
          if (!inserted.rowCount) continue;
          if (e.eventName === "OfferCreated") {
            const a=e.args;
            check(r.chain_status === "REGISTERED" && lower(a.bank) === d.bank_address && lower(receipt.from) === d.bank_address
              && a.purchaseAmount>0n && a.purchaseAmount<=BigInt(r.face_amount) && a.expiresAt<BigInt(new Date(r.due_at).getTime()/1000),"OFFER_EVENT_MISMATCH");
            const approval = (await c.query(`SELECT a.id FROM offer_approval a WHERE a.receivable_id=$1 AND a.approval_reference=$2
              AND a.purchase_amount=$3 AND a.expires_at=$4 AND a.snapshot_hash=$5 AND a.bank_wallet_id=$6
              AND NOT EXISTS(SELECT 1 FROM settlement_offer o WHERE o.approval_id=a.id)`,
            [r.id,a.approvalReference,a.purchaseAmount.toString(),new Date(Number(a.expiresAt)*1000),r.snapshot_hash,d.bank_wallet_id])).rows[0];
            await c.query(`INSERT INTO settlement_offer(id,deployment_id,offer_id,receivable_id,approval_id,approval_reference,bank_address,purchase_amount,expires_at,status,created_tx_hash,created_at)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'ACTIVE',$10,$11)`,
            [randomUUID(),d.id,a.offerId.toString(),r.id,approval?.id ?? null,a.approvalReference,lower(a.bank),a.purchaseAmount.toString(),new Date(Number(a.expiresAt)*1000),e.transactionHash,time]);
          } else if (e.eventName === "OfferClosed") {
            const statuses: Record<number,string>={2:"WITHDRAWN",3:"EXPIRED",4:"ACCEPTED",5:"INVALIDATED"};
            check(statuses[e.args.status],"UNKNOWN_OFFER_STATUS");
            check((await c.query("UPDATE settlement_offer SET status=$3 WHERE deployment_id=$1 AND offer_id=$2 AND receivable_id=$4 AND status='ACTIVE' RETURNING id",[d.id,e.args.offerId.toString(),statuses[e.args.status],r.id])).rowCount,"OFFER_CLOSE_MISMATCH");
          } else if (e.eventName === "Settled") {
            const a=e.args;
            const o = (await c.query("SELECT * FROM settlement_offer WHERE deployment_id=$1 AND offer_id=$2 AND receivable_id=$3",[d.id,a.offerId.toString(),r.id])).rows[0];
            check(o && o.status === "ACCEPTED" && r.chain_status === "REGISTERED" && lower(a.bank) === d.bank_address
              && lower(a.supplier) === r.supplier_address && lower(receipt.from) === r.supplier_address
              && lower(a.paymentToken) === d.payment_token && a.amountRaw === toTokenUnits(o.purchase_amount),"PURCHASE_EVENT_MISMATCH");
            await c.query("UPDATE receivable SET chain_status='PURCHASED',holder_wallet_id=$2,purchase_tx_hash=$3,purchased_at=$4,synced_at=now() WHERE id=$1",[r.id,d.bank_wallet_id,e.transactionHash,time]);
          } else if (e.eventName === "Repaid") {
            const a=e.args;
            check(r.chain_status === "PURCHASED" && r.holder_wallet_id === d.bank_wallet_id && lower(a.payer) === r.payer_address
              && lower(receipt.from) === r.payer_address && lower(a.recipient) === d.bank_address
              && lower(a.paymentToken) === d.payment_token && a.amountRaw === toTokenUnits(r.face_amount),"REPAYMENT_EVENT_MISMATCH");
            await c.query("UPDATE receivable SET chain_status='REPAID',repayment_tx_hash=$2,repaid_at=$3,synced_at=now() WHERE id=$1",[r.id,e.transactionHash,time]);
          } else if (e.eventName === "Cancelled") {
            check(r.chain_status === "REGISTERED" && lower(receipt.from) === r.supplier_address,"CANCELLATION_EVENT_MISMATCH");
            await c.query("UPDATE receivable SET chain_status='CANCELLED',cancellation_tx_hash=$2,cancelled_at=$3,synced_at=now() WHERE id=$1",[r.id,e.transactionHash,time]);
          }
          // Exact sender, destination and calldata bind events to prepared wallet requests.
          // Lost hash reports are recoverable; UI rejection never overrides a real receipt.
          const op = (await c.query(`SELECT id FROM wallet_operation WHERE deployment_id=$1 AND receivable_id=$2
            AND sender_address=$3 AND to_address=$4 AND calldata=$5 AND (tx_hash=$6 OR tx_hash IS NULL)
            AND NOT EXISTS(SELECT 1 FROM wallet_operation done WHERE done.deployment_id=$1 AND done.tx_hash=$6 AND done.status='CONFIRMED')
            AND status<>'CONFIRMED' ORDER BY (tx_hash=$6) DESC NULLS LAST,created_at,id LIMIT 1 FOR UPDATE`,
          [d.id,r.id,lower(tx.from),lower(tx.to),tx.input,e.transactionHash])).rows[0];
          if (op) await c.query("UPDATE wallet_operation SET status='CONFIRMED',tx_hash=$2,confirmed_at=$3,failure_code=NULL WHERE id=$1",[op.id,e.transactionHash,time]);
          processed++;
        }
        // Recheck the terminal hash before moving the durable cursor.
        check((await client.getBlock({blockNumber:to})).hash === end.hash,"SETTLEMENT_REORG_DETECTED");
        await c.query(`INSERT INTO settlement_cursor(deployment_id,block_number,block_hash) VALUES($1,$2,$3)
          ON CONFLICT(deployment_id) DO UPDATE SET block_number=EXCLUDED.block_number,block_hash=EXCLUDED.block_hash`,[d.id,to.toString(),end.hash]);
      });
    }
    await reconcileFailures(pool,client,d,safeHead);
    return {status:processed ? "SYNCED" : "IDLE",events:processed};
  } finally {
    if (locked) await lock.query("SELECT pg_advisory_unlock(72419203)");
    lock.release();
  }
}

async function reconcileFailures(pool: DatabasePool, client: PublicClient, d: Record<string,any>, safeHead: bigint) {
  const pending = (await pool.query("SELECT * FROM wallet_operation WHERE deployment_id=$1 AND status='PENDING' ORDER BY created_at LIMIT 100",[d.id])).rows;
  for (const op of pending) {
    let receipt: TransactionReceipt;
    try { receipt=await client.getTransactionReceipt({hash:op.tx_hash as Hex}); }
    catch (e) { if (e instanceof TransactionReceiptNotFoundError) continue; throw e; }
    if (receipt.blockNumber>safeHead) continue;
    check(receipt.blockHash === (await client.getBlock({blockNumber:receipt.blockNumber})).hash,"SETTLEMENT_REORG_DETECTED");
    const tx = await client.getTransaction({hash:op.tx_hash});
    const matches = lower(tx.from) === op.sender_address && lower(tx.to) === op.to_address && tx.input === op.calldata && tx.value === 0n;
    let failure = !matches ? "TRANSACTION_MISMATCH" : receipt.status === "reverted" ? "TRANSACTION_REVERTED" : null;
    if (!failure) {
      const cursor = (await pool.query("SELECT block_number FROM settlement_cursor WHERE deployment_id=$1",[d.id])).rows[0];
      if (cursor && BigInt(cursor.block_number)>=receipt.blockNumber) failure="EXPECTED_EVENT_MISSING";
    }
    if (failure) await pool.query("UPDATE wallet_operation SET status='FAILED',failure_code=$2 WHERE id=$1 AND status='PENDING'",[op.id,failure]);
  }
}
