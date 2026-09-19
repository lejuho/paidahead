import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDocuments, validateAnalysis, compareAnalysis, type SourceDocument } from "../src/document-ai.ts";
const sources: SourceDocument[] = ["PURCHASE_ORDER", "DELIVERY_NOTE", "INVOICE"].map(documentId => ({ documentId, type: documentId, text: "가상 서류\n금액 3,000,000원\n품목 100개 단가 30,000원" }));
const output = () => ({ summary: "가상 서류 비교", documents: sources.map(s => ({ documentId: s.documentId, amountKrw: "3000000", dueDate: null, items: [{ name: "식자재", quantity: "100", unitPriceKrw: "30000" }], evidence: "금액 3,000,000원", note: "날짜 없음" })) });
test("rejects invented evidence, dates, duplicate documents and malformed money", () => {
  for (const change of [
    (r: ReturnType<typeof output>) => { r.documents[0].evidence = "없는 근거"; },
    (r: ReturnType<typeof output>) => { r.documents[0].documentId = r.documents[1].documentId; },
    (r: ReturnType<typeof output>) => { r.documents[0].amountKrw = "3e6"; },
  ]) { const r = output(); change(r); assert.throws(() => validateAnalysis(r, sources), /AI_INVALID_RESULT/); }
  const r = output(); assert.throws(() => validateAnalysis({ ...r, documents: r.documents.map(d => ({ ...d, dueDate: "2026-10-20" })) }, sources), /AI_INVALID_RESULT/);
});
test("checks amounts exactly and does not invent maturity or unit price", () => {
  const r = output();
  assert.equal(compareAnalysis(r, "3000000")[0].status, "MATCH");
  assert.equal(compareAnalysis(r, "2999999")[0].status, "CHECK");
  assert.equal(compareAnalysis(r, "3000000")[1].status, "CHECK");
  r.documents[0].items[0].quantity = "99";
  assert.equal(compareAnalysis(r, "3000000")[2].status, "CHECK");
});
test("sends only sources to fixed provider endpoint with storage disabled", async () => {
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false); assert.equal(body.text.format.strict, true);
    assert.deepEqual(JSON.parse(body.input), { documents: sources });
    return Response.json({ status: "completed", model: "test-model", output: [{ content: [{ type: "output_text", text: JSON.stringify(output()) }] }] });
  }) as typeof fetch;
  const result = await analyzeDocuments(sources, { apiKey: "test-only", model: "test-model" }, fake);
  assert.equal(result.documents.length, 3);
});
test("provider rejection, limits, timeout and incomplete replies never become success", async () => {
  for (const [status, code] of [[401, "AI_AUTH_FAILED"], [429, "AI_RATE_LIMITED"], [500, "AI_UNAVAILABLE"]] as const) {
    await assert.rejects(analyzeDocuments(sources, { apiKey: "test", model: "test" }, (async () => new Response("private provider details", { status })) as typeof fetch), new RegExp(code));
  }
  await assert.rejects(analyzeDocuments(sources, { apiKey: "test", model: "test" }, (async () => { throw new Error("secret"); }) as typeof fetch), /AI_TIMEOUT/);
  await assert.rejects(analyzeDocuments(sources, { apiKey: "test", model: "test" }, (async () => Response.json({ status: "incomplete" })) as typeof fetch), /AI_INVALID_RESULT/);
});
