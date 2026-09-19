// Browser check of the simulation-only screen tour. Needs only the web server (no API, DB, chain or wallet).
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const WEB = process.env.WEB_URL ?? "http://127.0.0.1:3000";
const out = fileURLToPath(new URL("../e2e-output/", import.meta.url)); mkdirSync(out, { recursive: true });
const t = (id) => `[data-testid="${id}"]`;
const browser = await chromium.launch();
let failed = false;
try {
  for (const [name, viewport] of [["mobile", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 900 }]]) {
    const page = await (await browser.newContext({ locale: "ko-KR", viewport })).newPage();
    page.setDefaultTimeout(15000); page.on("dialog", (d) => d.accept());
    const backendCalls = []; page.on("request", (r) => { if (r.url().includes("/api/backend")) backendCalls.push(r.url()); });
    await page.goto(WEB); await page.click(t("tour-buyer")); await page.waitForSelector(t("sim-banner"));
    // Entering as the buyer: it is the supplier's turn, so the buyer can only follow.
    assert.equal(await page.locator(t("tour-action")).count(), 0); await page.click(t("tour-follow"));
    let clicks = 0, reloaded = false;
    for (let guard = 0; await page.locator("text=체험 완료").count() === 0 && guard < 40; guard++) {
      if (await page.locator(t("tour-action")).count()) { await page.click(t("tour-action"), { clickCount: 2 }); clicks++; await page.waitForTimeout(1300); } // double click must advance one stage only
      else await page.click(t("tour-follow"));
      if (clicks === 5 && !reloaded) { reloaded = true; await page.reload(); await page.waitForSelector(t("sim-banner")); } // progress survives a refresh
      if (clicks === 8) await page.screenshot({ path: `${out}tour-purchased-${name}.png`, fullPage: true });
    }
    assert.equal(clicks, 9, "nine actions from application to repayment");
    assert.deepEqual([await page.textContent(t("tour-balance-supplier")), await page.textContent(t("tour-balance-buyer")), await page.textContent(t("tour-balance-bank"))], ["2,970,000", "2,000,000", "10,030,000"]);
    const body = await page.textContent("body");
    assert.doesNotMatch(body, /0x[0-9a-fA-F]{8}/, "a simulation never shows transaction hashes"); assert.doesNotMatch(body, /DB 반영 완료|체인 확정/);
    assert.match(body, /시뮬레이션 · 실제 거래 없음/); assert.deepEqual(backendCalls, [], "the tour never calls the business API");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "no horizontal overflow");
    await page.screenshot({ path: `${out}tour-done-${name}.png`, fullPage: true });
    await page.click(t("tour-reset")); await page.waitForSelector("text=아직 진행한 단계가 없습니다");
    console.log(`  ✔ 화면 체험 ${name}: 9단계 완주 · 새로고침 유지 · 해시/업무 API 호출 없음 · 초기화`);
  }
} catch (error) { failed = true; console.error(`  ✖ ${error.message}`); } finally { await browser.close(); }
process.exit(failed ? 1 : 0);
