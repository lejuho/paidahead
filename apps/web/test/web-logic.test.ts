import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatKrw, formatTokenRaw, krwDifference, localInputToIso, multiplyKrw, normalizeKrwInput } from "../src/lib/format.ts";
import { blockerOf, deriveSteps, isBusinessComplete, isOpen } from "../src/lib/tx-state.ts";
import { classifyWalletError } from "../src/lib/wallet-errors.ts";
import { applicationStage } from "../src/features/stage.ts";
import { applicationBucket, bankReceivable, buyerReceivable, reviewBucket, supplierReceivable } from "../src/features/todo.ts";
import { relativeTime } from "../src/lib/format.ts";

describe("money formatting keeps integer precision", () => {
  it("formats and converts values beyond Number.MAX_SAFE_INTEGER without loss", () => {
    assert.equal(formatKrw("3000000"), "3,000,000원");
    assert.equal(formatKrw("9007199254740993"), "9,007,199,254,740,993원"); // 2^53+1 would round as a Number
    assert.equal(formatKrw((1n << 63n) - 1n), "9,223,372,036,854,775,807원");
    assert.equal(formatKrw("1.5"), "-"); assert.equal(formatKrw(null), "-");
    assert.equal(formatTokenRaw("2970000000000"), "2,970,000 mKRW");
    assert.equal(formatTokenRaw(9007199254740993000000n), "9,007,199,254,740,993 mKRW");
    assert.equal(formatTokenRaw("1500000"), "1.5 mKRW"); assert.equal(formatTokenRaw("1"), "0.000001 mKRW");
    assert.equal(krwDifference("3000000", "2970000"), "30,000원");
  });
  it("normalizes user input strictly", () => {
    assert.equal(normalizeKrwInput("2,970,000원"), "2970000"); assert.equal(normalizeKrwInput("0003"), "3");
    for (const bad of ["", "0", "-1", "1e6", "12.5", "9223372036854775808", "abc"]) assert.equal(normalizeKrwInput(bad), null, bad);
    assert.equal(multiplyKrw("100", "30000"), 3000000n); assert.equal(multiplyKrw("0", "30000"), null); assert.equal(multiplyKrw("3", "x"), null);
    assert.equal(multiplyKrw("1000000", "9007199254740993"), 9007199254740993000000n);
  });
  it("produces whole-second ISO timestamps for the API", () => {
    assert.match(localInputToIso("2027-01-01T10:30")!, /^\d{4}-\d\d-\d\dT\d\d:\d\d:00\.000Z$/); assert.equal(localInputToIso("nope"), null);
  });
});

describe("transaction progress never treats a hash as completion", () => {
  it("separates prepare, wallet, sent, chain and database stages", () => {
    assert.deepEqual(deriveSteps({ server: null, phase: "preparing", hasHash: false }), ["active", "todo", "todo", "todo", "todo"]);
    assert.deepEqual(deriveSteps({ server: "AWAITING_SIGNATURE", phase: "idle", hasHash: false }), ["done", "todo", "todo", "todo", "todo"]);
    assert.deepEqual(deriveSteps({ server: "AWAITING_SIGNATURE", phase: "wallet", hasHash: false }), ["done", "active", "todo", "todo", "todo"]);
    // Hash known locally but the API report failed: still only "waiting for chain".
    const sent = { server: "AWAITING_SIGNATURE", phase: "idle", hasHash: true, receipt: "success" } as const;
    assert.deepEqual(deriveSteps(sent), ["done", "done", "done", "active", "todo"]); assert.equal(isBusinessComplete(sent), false);
    assert.equal(isBusinessComplete({ server: "PENDING", phase: "idle", hasHash: true, receipt: "success" }), false);
    assert.deepEqual(deriveSteps({ server: "PENDING", phase: "idle", hasHash: true, receipt: "reverted" })[3], "failed");
    assert.deepEqual(deriveSteps({ server: "CONFIRMED", phase: "idle", hasHash: true }), ["done", "done", "done", "done", "done"]);
    assert.deepEqual(deriveSteps({ server: "USER_REJECTED", phase: "idle", hasHash: false }), ["done", "failed", "todo", "todo", "todo"]);
    assert.deepEqual(deriveSteps({ server: "FAILED", phase: "idle", hasHash: true }), ["done", "done", "done", "failed", "todo"]);
    assert.equal(isOpen("AWAITING_SIGNATURE") && isOpen("PENDING") && !isOpen("CONFIRMED") && !isOpen("USER_REJECTED") && !isOpen(null), true);
  });
  it("orders blockers: approval before contract rejection, funder readiness for supplier acceptance", () => {
    const me = "0xAbC0000000000000000000000000000000000001", bank = "0xbank000000000000000000000000000000000002";
    const pay = (balance: boolean, allowance: boolean, fundingAddress = me) => ({ requiredRaw: "1", balanceRaw: "0", allowanceRaw: "0", sufficientBalance: balance, sufficientAllowance: allowance, fundingAddress });
    assert.equal(blockerOf("REPAY", me.toLowerCase(), { simulation: "CONTRACT_REJECTED", payment: pay(true, false) }), "NEEDS_APPROVAL");
    assert.equal(blockerOf("REPAY", me, { simulation: "CONTRACT_REJECTED", payment: pay(false, false) }), "INSUFFICIENT_BALANCE");
    assert.equal(blockerOf("CREATE_OFFER", me, { simulation: "OK", payment: pay(false, false) }), "NEEDS_APPROVAL");
    assert.equal(blockerOf("CREATE_OFFER", me, { simulation: "OK", sufficientGasBalance: true, payment: pay(false, true) }), "NONE");
    assert.equal(blockerOf("ACCEPT_OFFER", me, { simulation: "CONTRACT_REJECTED", payment: pay(true, false, bank) }), "FUNDER_NOT_READY");
    assert.equal(blockerOf("ACCEPT_OFFER", me, { simulation: "CONTRACT_REJECTED", payment: pay(true, true, bank) }), "CONTRACT_REJECTED");
    assert.equal(blockerOf("CANCEL", me, { simulation: "OK", sufficientGasBalance: false }), "INSUFFICIENT_GAS");
    assert.equal(blockerOf("CANCEL", me, { simulation: "OK", sufficientGasBalance: true }), "NONE");
  });
});

describe("wallet error classification", () => {
  it("recognizes rejection, pending prompts, unknown chains, gas, reverts and RPC failures through nested causes", () => {
    assert.equal(classifyWalletError({ code: 4001 }), "USER_REJECTED");
    assert.equal(classifyWalletError({ name: "TransactionExecutionError", cause: { name: "UserRejectedRequestError", code: 4001 } }), "USER_REJECTED");
    assert.equal(classifyWalletError(new Error("MetaMask Tx Signature: User denied transaction signature.")), "USER_REJECTED");
    assert.equal(classifyWalletError({ code: -32002 }), "REQUEST_PENDING"); assert.equal(classifyWalletError({ code: 4902 }), "CHAIN_NOT_ADDED");
    assert.equal(classifyWalletError({ code: -32603, data: { originalError: { code: 4902 } } }), "CHAIN_NOT_ADDED");
    assert.equal(classifyWalletError({ message: "insufficient funds for gas * price + value" }), "INSUFFICIENT_GAS");
    assert.equal(classifyWalletError({ shortMessage: "execution reverted: OfferNotActive" }), "REVERTED");
    assert.equal(classifyWalletError(new Error("fetch failed")), "RPC_ERROR"); assert.equal(classifyWalletError(undefined), "RPC_ERROR");
  });
});

describe("supplier next action", () => {
  const base = { id: "a", revision_status: "DRAFT", confirmation_status: null, registration_status: null, receivable_id: null, chain_status: null };
  it("follows review → confirmation → registration → offer", () => {
    assert.equal(applicationStage(base).next, "서류 검토 완료하기");
    assert.equal(applicationStage({ ...base, revision_status: "REVIEW_COMPLETED" }).next, "구매처에 확인 요청");
    assert.equal(applicationStage({ ...base, revision_status: "REVIEW_COMPLETED", confirmation_status: "REJECTED" }).next, "보완 후 새 버전으로 다시 요청");
    assert.equal(applicationStage({ ...base, confirmation_status: "CONFIRMED", registration_status: "FAILED" }).next, "등록 재시도");
    assert.equal(applicationStage({ ...base, confirmation_status: "CONFIRMED", registration_status: "CONFIRMED", receivable_id: "r", chain_status: "REGISTERED" }).step, 4);
  });
});

describe("whose move is it", () => {
  it("counts only rows this organization must act on", () => {
    const app = { id: "a", revision_status: "DRAFT", confirmation_status: null, registration_status: null, receivable_id: null, chain_status: null };
    assert.equal(applicationBucket(app), "action"); assert.equal(applicationBucket({ ...app, confirmation_status: "PENDING" }), "waiting");
    assert.equal(applicationBucket({ ...app, confirmation_status: "REJECTED" }), "action");
    assert.equal(applicationBucket({ ...app, confirmation_status: "CONFIRMED", registration_status: "FAILED" }), "action");
    assert.equal(applicationBucket({ ...app, confirmation_status: "CONFIRMED", registration_status: "PENDING" }), "waiting");
    assert.equal(applicationBucket({ ...app, chain_status: "REGISTERED" }), "done");
    const r = { chain_status: "REGISTERED", overdue: false };
    assert.equal(supplierReceivable(r).bucket, "waiting"); assert.equal(supplierReceivable({ ...r, live_offer_amount: "2970000" }).bucket, "action");
    assert.equal(supplierReceivable({ ...r, open_supplements: 1 }).bucket, "action"); assert.equal(supplierReceivable({ ...r, review_status: "DECLINED" }).bucket, "done");
    assert.equal(buyerReceivable(r).bucket, "waiting"); assert.equal(buyerReceivable({ chain_status: "PURCHASED", overdue: true }).next, "연체 · 액면 전액 상환");
    assert.equal(bankReceivable({ chain_status: "PURCHASED", overdue: false }).bucket, "waiting"); assert.equal(bankReceivable({ chain_status: "PURCHASED", overdue: true }).bucket, "action");
    const b = { status: "PENDING", chain_status: "REGISTERED" };
    assert.equal(reviewBucket(b).bucket, "action"); assert.equal(reviewBucket({ ...b, status: "NEEDS_INFO" }).bucket, "waiting");
    assert.equal(reviewBucket({ ...b, status: "NEEDS_INFO", submitted_supplements: 1 }).next, "업체 답변 확인");
    assert.equal(reviewBucket({ ...b, status: "APPROVED_FOR_OFFER", open_approval: true }).next, "은행 지갑으로 오퍼 등록");
    assert.equal(reviewBucket({ ...b, status: "APPROVED_FOR_OFFER", live_offer: true }).bucket, "waiting");
    assert.equal(reviewBucket({ ...b, status: "APPROVED_FOR_OFFER", chain_status: "REPAID" }).bucket, "done");
  });
  it("formats recent activity relatively", () => {
    const now = Date.parse("2026-09-19T12:00:00Z"), ago = (m: number) => new Date(now - m * 60000).toISOString();
    assert.deepEqual([0, 5, 125, 1500, 4320].map((m) => relativeTime(ago(m), now)), ["방금", "5분 전", "2시간 전", "어제", "3일 전"]);
  });
});
