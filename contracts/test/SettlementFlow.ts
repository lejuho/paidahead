import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, it } from "node:test";
import { mnemonicToAccount } from "viem/accounts";
import { Pool, migrate, type DatabasePool } from "@paidahead/database";
import { seedDemo, DEMO_IDS } from "../../packages/database/src/seed.ts";
import { createApp } from "../../apps/api/src/app.ts";
import { runRegistrationOnce } from "../../apps/worker/src/registration.ts";
import { viemRegistrationChain, type RegistrationChain } from "../../apps/worker/src/chain.ts";
import { setup } from "./fixtures.js";
import { runSettlementOnce } from "../../apps/worker/src/settlement.ts";
import { type Hex, type PublicClient } from "viem";
import { CHAIN_ROLES } from "@paidahead/domain";

// Use npm run check to start an isolated PostgreSQL instance for the integration suite.
describe("Bank API → signed wallet → settlement events → DB", { skip: !process.env.TEST_DATABASE_URL }, () => {
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
    for (const [org, wallet] of [[DEMO_IDS.supplierOrg, f.supplier], [DEMO_IDS.buyerOrg, f.payer], [DEMO_IDS.bankOrg, f.bank]] as const) {
      await pool.query(`INSERT INTO wallet_binding(id,organization_id,chain_id,address,verification_status,approved_at)
        VALUES($1,$2,31337,$3,'APPROVED',now())`, [randomUUID(), org, wallet.account.address.toLowerCase()]);
    }
    deploymentId = randomUUID();
    await pool.query(`INSERT INTO chain_deployment(id,chain_id,receivable_contract,registrar_address,deployment_block,environment,active)
      VALUES($1,31337,$2,$3,0,'local',true)`, [deploymentId, f.token.address.toLowerCase(), f.registrar.account.address.toLowerCase()]);
    const bankWallet = (await pool.query("SELECT id FROM wallet_binding WHERE address=$1",[f.bank.account.address.toLowerCase()])).rows[0];
    await pool.query("UPDATE chain_deployment SET settlement_contract=$2,payment_token=$3,bank_wallet_id=$4 WHERE id=$1",
      [deploymentId,f.settlement.address.toLowerCase(),f.payment.address.toLowerCase(),bankWallet.id]);
    chain = viemRegistrationChain(f.publicClient, mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: 1 }));
    assert.equal(chain.registrar.toLowerCase(), f.registrar.account.address.toLowerCase());
    app = createApp(pool, { demoMode: true, chainClient: f.publicClient });
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

  const get = (url:string,role="supplier") => app.inject({method:"GET",url,headers:headers(role)});
  const sync = () => runSettlementOnce(pool,f.publicClient);
  async function ok(url:string,body:object,role="supplier") {
    const response=await post(url,body,role); assert.equal(response.statusCode,200,response.body); return response.json();
  }
  async function registered() {
    await confirmed(); assert.equal((await run()).status,"CONFIRMED");
    const r=(await pool.query("SELECT * FROM receivable")).rows[0];
    const b=(await pool.query("SELECT * FROM bank_review")).rows[0];
    return {r,b};
  }
  async function approved() {
    const {r,b}=await registered();
    await ok(`/bank/reviews/${b.id}/decision`,{expectedVersion:1,action:"START",internalNote:"銀行内部限定"},"bank");
    const approval=await ok(`/bank/reviews/${b.id}/approvals`,{expectedVersion:2,purchaseAmountKrw:"2970000",expiresAt:new Date(Number(f.expiresAt)*1000).toISOString()},"bank");
    return {r,b,approval};
  }
  const prepare = (id:string,kind:string,role:string,extra:object={}) => ok(`/receivables/${id}/operations`,{idempotencyKey:randomUUID(),kind,...extra},role);
  async function send(op:any,role:"supplier"|"bank"|"buyer",report=true) {
    const wallet=role === "buyer" ? f.payer : f[role];
    const hash=await wallet.sendTransaction({to:op.transaction.to,data:op.transaction.data,value:0n,type:"legacy",gasPrice:await f.publicClient.getGasPrice()});
    if(report) await ok(`/operations/${op.id}/transaction`,{transactionHash:hash},role);
    return hash;
  }
  async function offered() {
    const result=await approved();
    const op=await prepare(result.r.id,"CREATE_OFFER","bank",{approvalId:result.approval.id});
    await send(op,"bank"); assert.equal((await sync()).status,"SYNCED");
    const offer=(await pool.query("SELECT * FROM settlement_offer")).rows[0];
    return {...result,offer,op};
  }
  async function purchased() {
    const result=await offered(); await f.fund();
    const op=await prepare(result.r.id,"ACCEPT_OFFER","supplier",{offerId:result.offer.id});
    await send(op,"supplier"); await sync(); return result;
  }

  it("completes approved offer, atomic purchase and full repayment with exact balances and durable history",async()=>{
    const {r,offer}=await purchased();
    assert.equal((await get(`/receivables/${r.id}`)).json().chain_status,"PURCHASED");
    assert.equal(await f.payment.read.balanceOf([f.supplier.account.address]),2_970_000_000_000n);
    const op=await prepare(r.id,"REPAY","buyer");
    assert.equal(op.paymentApproval.from,f.payer.account.address.toLowerCase());
    await send(op,"buyer");
    assert.equal((await get(`/receivables/${r.id}`)).json().chain_status,"PURCHASED");
    await sync();
    const state=(await get(`/receivables/${r.id}`)).json();
    assert.equal(state.chain_status,"REPAID"); assert.equal(state.offers[0].id,offer.id); assert.equal(state.offers[0].status,"ACCEPTED");
    assert.equal(state.events.length,4); assert.ok(state.purchase_tx_hash); assert.ok(state.repayment_tx_hash);
    assert.equal(await f.payment.read.balanceOf([f.bank.account.address]),3_000_000_000_000n);
    assert.equal((await get(`/operations/${op.id}`,"buyer")).json().status,"CONFIRMED");
    assert.equal((await prepareFailure(r.id,"REPAY","buyer")).statusCode,409);
    assert.equal((await sync()).status,"IDLE");
    assert.equal((await pool.query("SELECT count(*) FROM settlement_event")).rows[0].count,"4");
  });
  function prepareFailure(id:string,kind:string,role:string,extra:object={}) {return post(`/receivables/${id}/operations`,{idempotencyKey:randomUUID(),kind,...extra},role);}

  it("keeps internal notes private and requires supplement closure before approval",async()=>{
    const {r,b}=await registered();
    const terms={expectedVersion:1,purchaseAmountKrw:"2970000",expiresAt:new Date(Number(f.expiresAt)*1000).toISOString()};
    assert.equal((await post(`/bank/reviews/${b.id}/approvals`,terms,"bank")).json().error,"REVIEW_REQUIRED");
    await ok(`/bank/reviews/${b.id}/decision`,{expectedVersion:1,action:"START",internalNote:"secret-bank-note"},"bank");
    await ok(`/bank/reviews/${b.id}/decision`,{expectedVersion:2,action:"REQUEST_INFO",publicMessage:"납품 설명 추가",internalNote:"secret-risk"},"bank");
    const bank=(await get(`/bank/reviews/${b.id}`,"bank")).json();
    assert.equal(bank.supplements.length,1); assert.equal(bank.internal_note,"secret-risk");
    assert.equal((await get(`/bank/reviews/${b.id}`)).statusCode,404);
    const publicView=await get(`/receivables/${r.id}`); assert.ok(!publicView.body.includes("secret-"));
    assert.equal((await post(`/bank/reviews/${b.id}/approvals`,{...terms,expectedVersion:3},"bank")).statusCode,409);
    const s=bank.supplements[0];
    assert.equal((await post(`/supplements/${s.id}/response`,{response:"설명"},"buyer")).statusCode,404);
    await ok(`/supplements/${s.id}/response`,{response:"가상 증빙에 대한 추가 설명"});
    await ok(`/bank/supplements/${s.id}/close`,{},"bank");
    await ok(`/bank/reviews/${b.id}/approvals`,{...terms,expectedVersion:4},"bank");
    assert.equal((await get(`/documents/${DEMO_IDS.documents[0]}/content`,"bank")).statusCode,200);
  });

  it("enforces separate approval permission, optimistic versions and immutable approval records",async()=>{
    const {r,b}=await registered();
    await ok(`/bank/reviews/${b.id}/decision`,{expectedVersion:1,action:"START"},"bank");
    assert.equal((await post(`/bank/reviews/${b.id}/decision`,{expectedVersion:1,action:"NOTE",internalNote:"stale"},"bank")).json().error,"STALE_REVIEW");
    await pool.query("DELETE FROM membership_role WHERE role='BANK_APPROVER'");
    const terms={expectedVersion:2,purchaseAmountKrw:"2970000",expiresAt:new Date(Number(f.expiresAt)*1000).toISOString()};
    assert.equal((await post(`/bank/reviews/${b.id}/approvals`,terms,"bank")).statusCode,403);
    await pool.query("INSERT INTO membership_role SELECT membership_id,'BANK_APPROVER' FROM membership_role WHERE role='BANK_REVIEWER'");
    const a=await ok(`/bank/reviews/${b.id}/approvals`,terms,"bank");
    await assert.rejects(pool.query("UPDATE offer_approval SET purchase_amount=1 WHERE id=$1",[a.id]),/append-only/);
    assert.equal((await prepareFailure(r.id,"CREATE_OFFER","supplier",{approvalId:a.id})).statusCode,403);
    assert.equal((await prepareFailure(r.id,"REPAY","supplier")).statusCode,403);
    assert.equal((await get(`/operations/${randomUUID()}`)).statusCode,404);
  });

  it("declines with a public reason and blocks terms without exposing the internal note",async()=>{
    const {r,b}=await registered();
    await ok(`/bank/reviews/${b.id}/decision`,{expectedVersion:1,action:"START"},"bank");
    await ok(`/bank/reviews/${b.id}/decision`,{expectedVersion:2,action:"DECLINE",publicMessage:"시연 매입 기준 미충족",internalNote:"private"},"bank");
    const state=await get(`/receivables/${r.id}`);assert.equal(state.json().bankReview.status,"DECLINED");assert.ok(!state.body.includes("private"));
    assert.equal((await post(`/bank/reviews/${b.id}/approvals`,{expectedVersion:3,purchaseAmountKrw:"2970000",expiresAt:new Date(Number(f.expiresAt)*1000).toISOString()},"bank")).statusCode,409);
  });

  it("returns identical idempotent wallet payloads and recovers missing hash reports",async()=>{
    const {r,approval}=await approved();
    const input={kind:"CREATE_OFFER",approvalId:approval.id,idempotencyKey:randomUUID()};
    const first=await ok(`/receivables/${r.id}/operations`,input,"bank");
    assert.deepEqual(await ok(`/receivables/${r.id}/operations`,input,"bank"),first);
    assert.equal((await post(`/receivables/${r.id}/operations`,{...input,approvalId:randomUUID()},"bank")).json().error,"IDEMPOTENCY_CONFLICT");
    await send(first,"bank",false); await sync();
    assert.equal((await get(`/operations/${first.id}`,"bank")).json().status,"CONFIRMED");
    assert.equal((await get(`/operations/${first.id}`)).statusCode,404);
    // Refresh recovery view: each organization sees only its own prepared operations.
    const mine=(await get(`/receivables/${r.id}/operations`,"bank")).json();
    assert.deepEqual([mine.length,mine[0].id,mine[0].status,mine[0].kind],[1,first.id,"CONFIRMED","CREATE_OFFER"]);
    assert.deepEqual((await get(`/receivables/${r.id}/operations`)).json(),[]);
    assert.equal((await get("/chain","buyer")).json().chainId,31337);
    assert.equal((await get("/me","bank")).json().wallets[0].address,f.bank.account.address.toLowerCase());
  });

  it("does not confirm an arbitrary reported hash or alter receivable state",async()=>{
    const {r,approval}=await approved();
    const op=await prepare(r.id,"CREATE_OFFER","bank",{approvalId:approval.id});
    const unrelated=await f.payment.write.mint([f.bank.account.address,1n]);
    await ok(`/operations/${op.id}/transaction`,{transactionHash:unrelated},"bank");
    await sync();
    const status=(await get(`/operations/${op.id}`,"bank")).json();
    assert.equal(status.status,"FAILED");assert.equal(status.failureCode,"TRANSACTION_MISMATCH");
    assert.equal((await pool.query("SELECT count(*) FROM settlement_offer")).rows[0].count,"0");
  });

  it("preserves atomic state on insufficient allowance, then permits a fresh attempt",async()=>{
    const {r,offer}=await offered();
    const op=await prepare(r.id,"ACCEPT_OFFER","supplier",{offerId:offer.id});
    const before=await get(`/operations/${op.id}/preflight`);
    assert.equal(before.statusCode,200,before.body); assert.equal(before.json().simulation,"CONTRACT_REJECTED");
    assert.equal(before.json().payment.sufficientAllowance,false);
    // Disable the RPC's throw-on-revert behavior: submit signed bytes via eth_sendRawTransaction and recover hash locally.
    const account=mnemonicToAccount("test test test test test test test test test test test junk",{addressIndex:2});
    const raw=await account.signTransaction({chainId:31337,to:op.transaction.to,data:op.transaction.data,gas:500000n,
      nonce:await f.publicClient.getTransactionCount({address:account.address}),gasPrice:await f.publicClient.getGasPrice(),type:"legacy"});
    const {keccak256}=await import("viem"); const hash=keccak256(raw);
    try {await f.publicClient.sendRawTransaction({serializedTransaction:raw});} catch {/* mined revert may be thrown by Hardhat */}
    await ok(`/operations/${op.id}/transaction`,{transactionHash:hash}); await sync();
    assert.equal((await get(`/operations/${op.id}`)).json().failureCode,"TRANSACTION_REVERTED");
    assert.equal((await get(`/receivables/${r.id}`)).json().chain_status,"REGISTERED");
    assert.equal((await f.token.read.ownerOf([BigInt(r.token_id)])).toLowerCase(),f.supplier.account.address.toLowerCase());
    await f.fund(); const retry=await prepare(r.id,"ACCEPT_OFFER","supplier",{offerId:offer.id});
    const after=(await get(`/operations/${retry.id}/preflight`)).json();
    assert.equal(after.simulation,"OK"); assert.equal(after.payment.sufficientBalance,true);
    await send(retry,"supplier");await sync();assert.equal((await get(`/operations/${retry.id}`)).json().status,"CONFIRMED");
  });

  it("waits for confirmation depth and recovers after a rolled-back projection",async()=>{
    const {r,approval}=await approved();
    await pool.query("UPDATE chain_deployment SET confirmations=3");
    const op=await prepare(r.id,"CREATE_OFFER","bank",{approvalId:approval.id});await send(op,"bank");
    await sync();assert.equal((await get(`/operations/${op.id}`,"bank")).json().status,"PENDING");
    await f.networkHelpers.mine(2);
    await pool.query(`CREATE FUNCTION crash_settlement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'crash'; END $$;
      CREATE TRIGGER crash BEFORE INSERT ON settlement_offer FOR EACH ROW EXECUTE FUNCTION crash_settlement()`);
    await assert.rejects(sync(),/crash/);assert.equal((await pool.query("SELECT count(*) FROM settlement_event")).rows[0].count,"0");
    await pool.query("DROP TRIGGER crash ON settlement_offer");await sync();
    assert.equal((await get(`/operations/${op.id}`,"bank")).json().status,"CONFIRMED");
  });

  it("serializes duplicate workers and supports withdrawal and cancellation",async()=>{
    const {r,offer}=await offered();
    const op=await prepare(r.id,"WITHDRAW_OFFER","bank",{offerId:offer.id});await send(op,"bank");
    await Promise.all([sync(),sync()]);
    assert.equal((await get(`/receivables/${r.id}`)).json().offers[0].status,"WITHDRAWN");
    const cancel=await prepare(r.id,"CANCEL","supplier");await send(cancel,"supplier");await sync();
    assert.equal((await get(`/receivables/${r.id}`)).json().chain_status,"CANCELLED");
    assert.equal((await prepareFailure(r.id,"CANCEL","supplier")).statusCode,409);
  });

  it("repays after bank permission revocation and keeps overdue distinct from repayment",async()=>{
    const {r}=await purchased();
    await f.token.write.revokeRole([CHAIN_ROLES.BANK_ROLE,f.bank.account.address]);
    await pool.query("UPDATE wallet_binding SET verification_status='REVOKED' WHERE organization_id=$1 AND approved_at IS NOT NULL",[DEMO_IDS.bankOrg]);
    await f.networkHelpers.time.increaseTo(f.dueAt+1n);
    const op=await prepare(r.id,"REPAY","buyer");await send(op,"buyer");await sync();
    assert.equal((await get(`/receivables/${r.id}`,"buyer")).json().chain_status,"REPAID");
  });

  it("rejects wrong networks, bad receipts and detected deep reorgs without advancing state",async()=>{
    const {r,approval}=await approved();const op=await prepare(r.id,"CREATE_OFFER","bank",{approvalId:approval.id});
    await send(op,"bank");
    await assert.rejects(runSettlementOnce(pool,{...f.publicClient,getChainId:async()=>1} as PublicClient),/WRONG_CHAIN/);
    const corrupt={...f.publicClient,getTransactionReceipt:async(args:{hash:Hex})=>({...await f.publicClient.getTransactionReceipt(args),logs:[]})} as PublicClient;
    await assert.rejects(runSettlementOnce(pool,corrupt),/SETTLEMENT_EVENT_MISSING/);
    assert.equal((await pool.query("SELECT count(*) FROM settlement_event")).rows[0].count,"0");
    await sync();await pool.query("UPDATE settlement_cursor SET block_hash=$1",[`0x${"a".repeat(64)}`]);
    await assert.rejects(sync(),/SETTLEMENT_REORG_DETECTED/);
  });
  it("tracks external unapproved offers but refuses API acceptance and preserves real on-chain outcomes",async()=>{
    const {r}=await registered();
    const {keccak256,toHex}=await import("viem");
    await f.settlement.write.createOffer([BigInt(r.token_id),2_970_000n,f.expiresAt,keccak256(toHex("external-reference"))],{account:f.bank.account});
    await sync();const offer=(await get(`/receivables/${r.id}`)).json().offers[0];
    assert.equal(offer.approval_id,null);
    assert.equal((await prepareFailure(r.id,"ACCEPT_OFFER","supplier",{offerId:offer.id})).json().error,"OFFER_NOT_ACCEPTABLE");
    await f.fund();await f.settlement.write.acceptOffer([BigInt(offer.offer_id)],{account:f.supplier.account});await sync();
    assert.equal((await get(`/receivables/${r.id}`)).json().chain_status,"PURCHASED");
  });

  it("allows replacement terms after withdrawal and rejects simultaneous live duplicate operations",async()=>{
    const {r,b,offer}=await offered();
    const input={kind:"WITHDRAW_OFFER",offerId:offer.id};
    const [first,second]=await Promise.all([prepareFailure(r.id,input.kind,"bank",{offerId:offer.id}),prepareFailure(r.id,input.kind,"bank",{offerId:offer.id})]);
    assert.deepEqual([first.statusCode,second.statusCode].sort(),[200,409]);
    const op=(first.statusCode === 200 ? first : second).json();await send(op,"bank");await sync();
    const approval=await ok(`/bank/reviews/${b.id}/approvals`,{expectedVersion:3,purchaseAmountKrw:"2980000",expiresAt:new Date(Number(f.expiresAt)*1000).toISOString()},"bank");
    const create=await prepare(r.id,"CREATE_OFFER","bank",{approvalId:approval.id});await send(create,"bank");await sync();
    const offers=(await get(`/receivables/${r.id}`)).json().offers;
    assert.equal(offers.length,2);assert.equal(offers.filter((o:any)=>o.status === "ACTIVE").length,1);
  });

  it("runs the complete documented HTTP demo with real local signatures and background synchronization",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"paidahead-settlement-demo-"));
    const rpc=createServer(async(req,res)=>{
      try {
        let body="";for await(const chunk of req)body+=chunk;
        const payload=JSON.parse(body);
        const result=await f.publicClient.request({method:payload.method,params:payload.params});
        res.setHeader("content-type","application/json");res.end(JSON.stringify({jsonrpc:"2.0",id:payload.id,result}));
      } catch {res.statusCode=500;res.end(JSON.stringify({error:{code:-32603,message:"Local RPC failure"}}));}
    });
    let running:Promise<unknown>|undefined;
    const interval=setInterval(()=>{
      if(!running)running=(async()=>{await run();await sync();})().finally(()=>{running=undefined;});
    },50);
    try {
      const url=await app.listen({port:0,host:"127.0.0.1"});
      await new Promise<void>(resolve=>rpc.listen(0,"127.0.0.1",resolve));
      const port=(rpc.address() as {port:number}).port;
      const access=join(dir,"access.json");await writeFile(access,JSON.stringify({credentials:seed.credentials,ids:DEMO_IDS}),{mode:0o600});
      const script=new URL("../../scripts/demo-settlement.mjs",import.meta.url).pathname;
      const {stdout}=await promisify(execFile)(process.execPath,[script],{timeout:45000,env:{...process.env,
        API_URL:url,REGISTRATION_RPC_URL:`http://127.0.0.1:${port}`,DEMO_ACCESS_FILE:access}});
      const result=JSON.parse(stdout);assert.equal(result.status,"REPAID");assert.equal(result.purchaseAmountKrw,"2970000");
      assert.ok(result.repaymentTransaction);
    } finally {
      clearInterval(interval);await running;rpc.closeAllConnections();await new Promise<void>(resolve=>rpc.close(()=>resolve()));
      await rm(dir,{recursive:true,force:true});
    }
  });

});
