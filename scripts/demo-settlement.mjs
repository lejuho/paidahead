import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { mnemonicToAccount } from "viem/accounts";

// Public Hardhat accounts are only usable on a disposable loopback chain.
const rpc=process.env.REGISTRATION_RPC_URL ?? "http://127.0.0.1:8545";
if (!['localhost','127.0.0.1'].includes(new URL(rpc).hostname) || process.env.NODE_ENV === 'production') throw new Error("Local demo only");
const client=createPublicClient({transport:http(rpc)});
assert.equal(await client.getChainId(),31337,"Local demo chain required");
const endpoint=process.env.API_URL ?? 'http://127.0.0.1:3003';
if (!['localhost','127.0.0.1'].includes(new URL(endpoint).hostname)) throw new Error("Local demo API required");
const access=JSON.parse(await readFile(process.env.DEMO_ACCESS_FILE ?? new URL('../.local/demo-access.json',import.meta.url),'utf8'));
const wallets=Object.fromEntries([['admin',0],['supplier',2],['buyer',3],['bank',4]].map(([role,addressIndex])=>[
  role,createWalletClient({account:mnemonicToAccount('test test test test test test test test test test test junk',{addressIndex}),transport:http(rpc)})]));
async function api(path,role='supplier',body) {
  const user=access.credentials[role];
  const res=await fetch(`${endpoint}${path}`,{method:body === undefined ? 'GET':'POST',headers:{'content-type':'application/json',authorization:`Bearer ${user.token}`,'x-organization-id':user.organizationId},...(body === undefined ? {}:{body:JSON.stringify(body)})});
  const result=await res.json();if(!res.ok)throw new Error(`${path}: ${res.status} ${result.error}`);return result;
}
async function wait(path,role,check) {
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){const state=await api(path,role);if(check(state))return state;if(state.status === 'FAILED')throw new Error(state.failureCode);await new Promise(r=>setTimeout(r,500));}
  throw new Error(`Worker timeout: ${path}`);
}
async function send(payload,role) {
  assert.equal(payload.chainId,31337);assert.equal(payload.from.toLowerCase(),wallets[role].account.address.toLowerCase());
  const hash=await wallets[role].sendTransaction({chain:null,to:payload.to,data:payload.data,value:0n,type:'legacy',gasPrice:await client.getGasPrice()});
  assert.equal((await client.waitForTransactionReceipt({hash})).status,'success');return hash;
}
async function execute(kind,role,extra={}) {
  const op=await api(`/receivables/${r.id}/operations`,role,{kind,idempotencyKey:randomUUID(),...extra});
  if(op.paymentApproval)await send(op.paymentApproval,role);
  const ready=await api(`/operations/${op.id}/preflight`,role);assert.equal(ready.simulation,'OK',JSON.stringify(ready));
  const transactionHash=await send(op.transaction,role);
  await api(`/operations/${op.id}/transaction`,role,{transactionHash});
  await wait(`/operations/${op.id}`,role,s=>s.status === 'CONFIRMED');return transactionHash;
}
const {stdout}=await promisify(execFile)(process.execPath,[new URL('./demo-api.mjs',import.meta.url).pathname,'--wait-registration'],{env:process.env});
const registration=JSON.parse(stdout);
const r=await api(`/receivables/${registration.receivableId}`);
await api(`/bank/reviews/${r.bankReview.id}/decision`,'bank',{expectedVersion:1,action:'START',internalNote:'가상 거래 검토 완료'});
const approval=await api(`/bank/reviews/${r.bankReview.id}/approvals`,'bank',{expectedVersion:2,purchaseAmountKrw:'2970000',expiresAt:new Date(Math.floor(Date.now()/1000)*1000+86400000).toISOString()});
const mintAbi=parseAbi(['function mint(address to,uint256 amount)']);
for(const [role,amount] of [['bank',2_970_000_000_000n],['buyer',3_000_000_000_000n]]){
  const hash=await wallets.admin.writeContract({chain:null,address:r.payment_token,abi:mintAbi,functionName:'mint',args:[wallets[role].account.address,amount],type:'legacy',gasPrice:await client.getGasPrice()});
  assert.equal((await client.waitForTransactionReceipt({hash})).status,'success');
}
const offerTransaction=await execute('CREATE_OFFER','bank',{approvalId:approval.id});
const offer=(await api(`/receivables/${r.id}`)).offers.find(o=>o.approval_id === approval.id);
const purchaseTransaction=await execute('ACCEPT_OFFER','supplier',{offerId:offer.id});
const repaymentTransaction=await execute('REPAY','buyer');
const result=await api(`/receivables/${r.id}`);assert.equal(result.chain_status,'REPAID');
console.log(JSON.stringify({receivableId:r.id,status:result.chain_status,faceAmountKrw:result.face_amount,purchaseAmountKrw:offer.purchase_amount,offerTransaction,purchaseTransaction,repaymentTransaction},null,2));
