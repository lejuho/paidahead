// Browser E2E against the REAL local stack (PostgreSQL + API + worker + Hardhat node + Next dev server).
// Wallet signing uses the automation-only injected EIP-1193 wallet in ./test-wallet.mjs, not a browser extension.
// Prerequisite: the stack from apps/web/README.md is running. Usage: npm run e2e:web
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { attachTestWallet, HARDHAT_INDEX } from "./test-wallet.mjs";

const WEB = process.env.WEB_URL ?? "http://127.0.0.1:3000";
const RPC = process.env.REGISTRATION_RPC_URL ?? "http://127.0.0.1:8545";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const out = fileURLToPath(new URL("../e2e-output/", import.meta.url)); mkdirSync(out, { recursive: true });
const results = [];
async function step(name, work) {
  const started = Date.now();
  try { await work(); results.push({ name, ok: true }); console.log(`  ✔ ${name} (${Date.now() - started}ms)`); }
  catch (error) { results.push({ name, ok: false }); console.error(`  ✖ ${name}\n    ${error.message.split("\n")[0]}`); throw error; }
}
const fund = (only) => execFileSync(process.execPath, ["--env-file-if-exists=.env", "scripts/demo-fund.mjs", "--krw", "5000000", "--only", only], { cwd: root, stdio: "pipe" });
const t = (id) => `[data-testid="${id}"]`;
const LONG = { timeout: 60000 };
const RUN = Date.now().toString(36).slice(-5); // the demo DB persists between runs, so titles are unique per run
const MAIN = `E2E 식자재 납품 300만원 ${RUN}`;

// Fixture reset: earlier runs leave mock-token balances/allowances behind, which would hide the "insufficient" scenarios.
async function resetTokenState(chain) {
  const reader = createPublicClient({ transport: http(RPC) });
  assert.equal(await reader.getChainId(), 31337, "loopback demo chain only");
  const abi = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)"]);
  const sink = mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: 19 }).address;
  for (const role of ["bank", "buyer"]) {
    const account = mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: HARDHAT_INDEX[role] });
    const wallet = createWalletClient({ account, transport: http(RPC) });
    const send = async (functionName, args) => { const hash = await wallet.writeContract({ chain: null, address: chain.paymentToken, abi, functionName, args, type: "legacy", gasPrice: await reader.getGasPrice() });
      assert.equal((await reader.waitForTransactionReceipt({ hash })).status, "success"); };
    const balance = await reader.readContract({ address: chain.paymentToken, abi, functionName: "balanceOf", args: [account.address] });
    if (balance > 0n) await send("transfer", [sink, balance]);
    await send("approve", [chain.settlementContract, 0n]);
  }
}
const browser = await chromium.launch();
async function actor(role, viewport) {
  const context = await browser.newContext({ locale: "ko-KR", viewport, ...(viewport.width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  const wallet = await attachTestWallet(context, RPC, role);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(WEB); await page.click(t(`enter-${role}`)); await page.waitForSelector(t("wallet-bar"));
  return { role, page, wallet, shot: (name) => page.screenshot({ path: `${out}${name}.png`, fullPage: true }) };
}
const connect = async (a) => { await a.page.click(`${t("wallet-bar")} button:has-text("연결")`); await a.page.waitForSelector(t("wallet-address")); };
const confirmed = (a) => a.page.waitForSelector(`${t("tx-panel")}[data-status="CONFIRMED"]`, LONG);
const chainSends = (a) => a.wallet.state.sent.length;

let failed = false;
try {
  console.log("PaidAhead web E2E (automation test wallet, real API/DB/EVM)");
  const supplier = await actor("supplier", { width: 390, height: 844 }); // supplier screens are mobile-first
  const buyer = await actor("buyer", { width: 390, height: 844 });
  const bank = await actor("bank", { width: 1280, height: 900 });
  let receivableUrl;
  await resetTokenState(await bank.page.evaluate(async () => (await fetch("/api/backend/chain")).json()));

  await step("역할 선택 화면과 시연 모드 표시", async () => {
    assert.match(await supplier.page.textContent(".demo-banner"), /시연 모드/);
    assert.match(await supplier.page.textContent(".who"), /납품업체 · 시연 계정/);
  });
  await step("권한 불일치: 구매처 세션은 납품업체 화면·API에 접근 불가", async () => {
    await buyer.page.goto(`${WEB}/applications`); await buyer.page.waitForURL("**/confirmations");
    const status = await buyer.page.evaluate(async () => (await fetch("/api/backend/applications")).status); assert.equal(status, 403);
    const forged = await buyer.page.evaluate(async () => (await fetch("/api/backend/bank/reviews")).status); assert.equal(forged, 403);
    const crossSite = await buyer.page.evaluate(async () => (await fetch("/api/demo/session", { method: "POST", headers: { "content-type": "application/json", }, body: "{\"role\":\"bank\"}" })).status);
    assert.equal(crossSite, 200, "same-origin role switch is the only way to change the demo role");
    await buyer.page.evaluate(async () => fetch("/api/demo/session", { method: "POST", headers: { "content-type": "application/json" }, body: "{\"role\":\"buyer\"}" }));
  });

  await step("반려 → 보완 새 버전 → 철회 흐름", async () => {
    const p = supplier.page;
    await p.goto(`${WEB}/applications/new`); await p.fill('input[maxlength="200"]', `E2E 반려·철회 ${RUN}`); await p.click(t("application-submit"));
    await p.click(t("complete-review")); await p.check(t("consent")); await p.click(t("request-confirmation")); await p.waitForSelector(t("withdraw-confirmation"));
    await buyer.page.goto(`${WEB}/confirmations`); await buyer.page.click(`${t("confirmation-row")}:has-text("E2E 반려·철회 ${RUN}")`);
    await buyer.page.click(t("reject-open")); await buyer.page.fill(t("reject-reason"), "수량 확인 필요"); await buyer.page.click(t("reject"));
    await buyer.page.waitForSelector("text=반려했습니다");
    await p.waitForSelector("text=반려 사유: 수량 확인 필요"); await p.click(t("revise")); await p.click(t("application-submit"));
    await p.click(t("complete-review")); await p.check(t("consent")); await p.click(t("request-confirmation"));
    await p.click(t("withdraw-confirmation")); await p.waitForSelector("text=확인 요청을 철회했습니다");
    await buyer.page.goto(`${WEB}/confirmations`); await buyer.page.click(".group-done summary"); await buyer.page.waitForSelector(`${t("confirmation-row")}:has-text("E2E 반려·철회 ${RUN}"):has-text("요청 철회")`);
  });

  await step("신청 → 서류 검토 → 구매처 확인 요청 (중복 클릭 1건만 생성)", async () => {
    const p = supplier.page;
    await p.goto(`${WEB}/applications/new`); await p.fill('input[maxlength="200"]', MAIN);
    await p.click(t("application-submit"), { clickCount: 2 }); await p.waitForURL(/applications\/[0-9a-f-]{36}$/);
    const count = await p.evaluate(async (title) => (await (await fetch("/api/backend/applications")).json()).filter((a) => a.title === title).length, MAIN);
    assert.equal(count, 1);
    assert.match(await p.textContent(t("item-total")), /3,000,000원 · 신청 금액과 일치/);
    await p.click(t("complete-review")); await p.check(t("consent")); await p.click(t("request-confirmation")); await p.waitForSelector(t("withdraw-confirmation"));
    await supplier.shot("01-supplier-waiting-mobile");
    // Tab badges: the buyer now has something to do; this application moved to the supplier's "waiting" group.
    await buyer.page.goto(`${WEB}/confirmations`); await buyer.page.waitForSelector(`${t("tab-confirmations")} .pill-action:not(.pill-zero)`);
    await buyer.page.waitForSelector(`${t("group-action")} ${t("confirmation-row")}:has-text("${MAIN}")`);
    await p.goto(`${WEB}/applications`); await p.waitForSelector(`${t("group-waiting")} ${t("application-row")}:has-text("${MAIN}")`); await p.goBack();
  });
  await step("구매처 확인 → 채권 등록 완료(워커) → DB 반영", async () => {
    const p = buyer.page;
    await p.goto(`${WEB}/confirmations`); await p.click(`${t("confirmation-row")}:has-text("${MAIN}")`);
    assert.equal(await p.isDisabled(t("confirm")), true, "confirm requires both acknowledgements");
    await p.click("text=발주서"); await p.waitForSelector("text=가상 발주서");
    await p.check(t("ack-delivery")); await p.check(t("ack-obligation")); await buyer.shot("02-buyer-confirm-mobile"); await p.click(t("confirm"));
    await p.waitForSelector("text=확인했습니다");
    await supplier.page.click(t("open-receivable"), LONG); await supplier.page.waitForURL(/receivables\//);
    receivableUrl = supplier.page.url();
    await supplier.page.waitForSelector("text=아직 유효한 조건이 없습니다");
  });

  await step("은행 검토: 시작 → 보완 요청 → 업체 답변 → 확인 → 조건 승인", async () => {
    const p = bank.page;
    await p.goto(`${WEB}/bank/reviews`); await p.waitForSelector(`${t("group-action")} ${t("review-row")}:has-text("${MAIN}"):has-text("검토 시작")`);
    await p.waitForSelector(`${t("tab-reviews")} .pill-action:not(.pill-zero)`); await bank.shot("03-bank-queue-desktop");
    await p.click(`${t("review-row")}:has-text("${MAIN}") a >> nth=0`);
    await p.click(t("review-start")); await p.fill(t("internal-note"), "내부: 거래 빈도 확인"); await p.fill(t("public-message"), "최근 납품 주기를 알려 주세요"); await p.click(t("request-info"));
    await p.waitForSelector("text=보완 요청 중");
    await supplier.page.waitForSelector(t("supplement-response")); const body = await supplier.page.textContent("main");
    assert.doesNotMatch(body, /내부: 거래 빈도 확인/, "internal bank notes never reach the supplier");
    await supplier.page.fill(t("supplement-response"), "매주 화요일 납품합니다"); await supplier.page.click(t("supplement-submit"));
    await p.click(t("supplement-close")); await p.waitForSelector(t("approve-terms"));
    assert.equal(await p.inputValue(t("purchase-amount")), "2970000");
    await p.click(t("approve-terms")); await p.waitForSelector(t("start-create-offer")); await bank.shot("04-bank-approved-desktop");
  });

  await step("네트워크 불일치 안내·전환, 조직-지갑 불일치 검증", async () => {
    const p = bank.page;
    await bank.wallet.setChain(1); await connect(bank);
    await p.waitForSelector(t("wrong-network")); await p.click('button:has-text("네트워크 전환")'); await p.waitForSelector(t("token-balance"));
    await bank.wallet.useRole("supplier"); await p.waitForSelector(t("wallet-mismatch"));
    await p.click(t("start-create-offer")); await p.waitForSelector(t("tx-send")); await p.click(t("tx-recheck"));
    // Signing is refused client-side when the connected wallet is not the prepared sender.
    await p.evaluate((sel) => document.querySelector(sel).removeAttribute("disabled"), t("tx-send")); await p.click(t("tx-send"), { force: true }).catch(() => undefined);
    assert.equal(chainSends(bank), 0, "no transaction may be sent from a mismatched wallet");
    await bank.wallet.useRole("bank"); await p.waitForSelector(t("wallet-mismatch"), { state: "detached" });
  });
  await step("오퍼 등록: 사용 승인 → 서명 거절 → 재시도 → 중복 클릭 방지 → 확정", async () => {
    const p = bank.page;
    await p.click(t("tx-recheck")); await p.waitForSelector(`${t("tx-blocker")}[data-blocker="NEEDS_APPROVAL"]`);
    await p.waitForSelector("text=오퍼 등록은 자금을 예약하지 않습니다"); // unfunded bank: warned, not blocked
    await p.click(t("tx-approve")); await p.waitForSelector(t("tx-blocker"), { state: "detached", ...LONG }); assert.equal(chainSends(bank), 1);
    bank.wallet.rejectNext(); await p.click(t("tx-send")); await p.waitForSelector(`${t("tx-panel")}[data-status="USER_REJECTED"]`);
    assert.match(await p.textContent(t("tx-message")), /서명을 거절/); assert.equal(chainSends(bank), 1); await bank.shot("05-bank-rejected-desktop");
    await p.click(t("start-create-offer")); await p.waitForSelector(`${t("tx-panel")}[data-status="AWAITING_SIGNATURE"]`);
    await p.waitForFunction((sel) => !document.querySelector(sel)?.disabled, t("tx-send"));
    await p.click(t("tx-send"), { clickCount: 2 }); await confirmed(bank);
    assert.equal(chainSends(bank), 2, "approve + exactly one createOffer despite the double click");
    await p.waitForSelector(t("start-withdraw-offer"));
  });
  await step("지원되는 철회: 은행 오퍼 철회 → 새 조건 승인·재등록", async () => {
    const p = bank.page;
    await p.click(t("tx-dismiss")); await p.click(t("start-withdraw-offer")); await p.waitForFunction((sel) => !document.querySelector(sel)?.disabled, t("tx-send"));
    await p.click(t("tx-send")); await confirmed(bank); await p.click(t("tx-dismiss"));
    await p.click(t("approve-terms")); await p.click(t("start-create-offer")); await p.waitForFunction((sel) => !document.querySelector(sel)?.disabled, t("tx-send"));
    await p.click(t("tx-send")); await confirmed(bank); await p.click(t("tx-dismiss"));
  });

  await step("납품업체 수락: 은행 잔액 부족 차단 → 충전 후 매입, 해시 통지 실패 + 새로고침 복구", async () => {
    const p = supplier.page;
    await p.goto(`${WEB}/receivables`); await p.waitForSelector(`${t("tab-receivables")} .pill-action:not(.pill-zero)`);
    await p.click(`${t("group-action")} ${t("receivable-row")}:has-text("${MAIN}"):has-text("먼저받기")`);
    await p.waitForSelector(t("start-accept")); assert.match(await p.textContent(t("offer-amount")), /2,970,000원/); await supplier.shot("06-supplier-offer-mobile");
    await connect(supplier); await p.click(t("start-accept"));
    await p.waitForSelector(`${t("tx-blocker")}[data-blocker="FUNDER_NOT_READY"]`); assert.equal(await p.isDisabled(t("tx-send")), true);
    fund("bank"); await p.click(t("tx-recheck")); await p.waitForSelector(t("tx-blocker"), { state: "detached" });
    await p.route("**/api/backend/operations/*/transaction", (route) => route.abort()); // the hash never reaches the API
    await p.click(t("tx-send")); await p.waitForSelector(t("tx-hash")); assert.equal(chainSends(supplier), 1);
    await p.unroute("**/api/backend/operations/*/transaction"); await p.reload();
    // After the reload the UI must not claim completion from the hash: it shows the server record until the worker confirms.
    await p.waitForSelector("text=모의 지급 완료", LONG); await p.waitForSelector("text=매입 완료 · 상환 대기");
    assert.equal(chainSends(supplier), 1); await supplier.shot("07-supplier-purchased-mobile");
  });

  await step("구매처 상환: 잔액 부족 → 충전 → 사용 승인 → 상환 전송 중 새로고침 → REPAID", async () => {
    const p = buyer.page;
    await p.goto(`${WEB}/repayments`); await p.click(`${t("receivable-row")}:has-text("${MAIN}")`);
    await connect(buyer); await p.click(t("start-repay"));
    await p.waitForSelector(`${t("tx-blocker")}[data-blocker="INSUFFICIENT_BALANCE"]`); await buyer.shot("08-buyer-insufficient-mobile");
    fund("buyer"); await p.click(t("tx-recheck")); await p.waitForSelector(`${t("tx-blocker")}[data-blocker="NEEDS_APPROVAL"]`);
    await p.click(t("tx-approve")); await p.waitForSelector(t("tx-blocker"), { state: "detached", ...LONG });
    await p.click(t("tx-send")); await p.waitForSelector(t("tx-hash")); await p.reload();
    await p.waitForSelector("text=액면 전액을 상환해 채권이 종결되었습니다", LONG);
    assert.equal(chainSends(buyer), 2); await buyer.shot("09-buyer-repaid-mobile");
  });

  await step("최종 상태: 세 역할 모두 상환 완료, 은행 현황 반영", async () => {
    await supplier.page.goto(receivableUrl); await supplier.page.waitForSelector("text=상환 완료");
    await bank.page.goto(`${WEB}/portfolio`); await bank.page.click(".group-done summary"); await bank.page.waitForSelector(`${t("receivable-row")}:has-text("${MAIN}"):has-text("상환 완료")`);
    await bank.shot("10-bank-portfolio-desktop");
    const state = await bank.page.evaluate(async (id) => (await fetch(`/api/backend/receivables/${id}`)).json(), receivableUrl.split("/").pop());
    assert.equal(state.chain_status, "REPAID"); assert.deepEqual(state.events.map((e) => e.event_type).filter((e) => ["Settled", "Repaid"].includes(e)), ["Settled", "Repaid"]);
    assert.equal(Object.keys(HARDHAT_INDEX).length, 3);
  });
  await step("매입 불가(공개 사유) → 납품업체 등록 취소 거래 → CANCELLED", async () => {
    const p = supplier.page, title = `E2E 매입 불가·취소 ${RUN}`;
    await p.goto(`${WEB}/applications/new`); await p.fill('input[maxlength="200"]', title); await p.click(t("application-submit"));
    await p.click(t("complete-review")); await p.check(t("consent")); await p.click(t("request-confirmation")); await p.waitForSelector(t("withdraw-confirmation"));
    await buyer.page.goto(`${WEB}/confirmations`); await buyer.page.click(`${t("confirmation-row")}:has-text("${title}")`);
    await buyer.page.check(t("ack-delivery")); await buyer.page.check(t("ack-obligation")); await buyer.page.click(t("confirm"));
    await p.click(t("open-receivable"), LONG);
    await bank.page.goto(`${WEB}/bank/reviews`); await bank.page.click(`${t("review-row")}:has-text("${title}") a >> nth=0`);
    await bank.page.click(t("review-start")); await bank.page.fill(t("internal-note"), "내부 한도 초과"); await bank.page.fill(t("public-message"), "이번에는 매입이 어렵습니다");
    await bank.page.click(t("decline")); await bank.page.waitForSelector("text=매입 불가로 종결했습니다");
    assert.equal(await bank.page.locator(t("approve-terms")).count(), 0, "no terms can be approved after a decline");
    await p.waitForSelector("text=은행 안내: 이번에는 매입이 어렵습니다"); assert.doesNotMatch(await p.textContent("main"), /내부 한도 초과/);
    const before = chainSends(supplier);
    await p.click("summary"); await p.click(t("start-cancel")); await p.waitForFunction((sel) => !document.querySelector(sel)?.disabled, t("tx-send"));
    await p.click(t("tx-send")); await p.waitForSelector("text=등록 취소", LONG); await p.waitForSelector(`${t("tx-panel")}[data-status="CONFIRMED"]`, LONG);
    assert.equal(chainSends(supplier), before + 1);
  });
  await step("모바일 폭에서 가로 넘침 없음", async () => {
    for (const a of [supplier, buyer]) assert.equal(await a.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
    const mobileBank = await actor("bank", { width: 390, height: 844 }); await mobileBank.page.goto(`${WEB}/bank/reviews`); await mobileBank.page.waitForSelector(".tabs");
    assert.equal(await mobileBank.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true); await mobileBank.shot("11-bank-queue-mobile");
  });
} catch (error) { failed = true; if (!results.some((r) => !r.ok)) console.error(error); } finally { await browser.close(); }
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} steps passed${failed ? " — FAILED" : ""}. Screenshots: apps/web/e2e-output/`);
process.exit(failed ? 1 : 0);
