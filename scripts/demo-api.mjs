import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const access = JSON.parse(await readFile(process.env.DEMO_ACCESS_FILE ?? new URL("../.local/demo-access.json", import.meta.url), "utf8"));
const endpoint = process.env.API_URL ?? "http://127.0.0.1:3003";
async function post(path, body, role = "supplier") {
  const user = access.credentials[role];
  const res = await fetch(`${endpoint}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", authorization: `Bearer ${user.token}`, "x-organization-id": user.organizationId },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${data.error}`);
  return data;
}
const a = await post("/applications", {
  buyerOrgId: access.ids.buyerOrg, targetBankOrgId: access.ids.bankOrg,
  tradeReference: `INV-DEMO-${Date.now()}`, title: "가상 식자재 납품 300만원",
  faceAmountKrw: "3000000", dueAt: new Date(Math.floor(Date.now() / 1000) * 1000 + 30 * 86400_000).toISOString(),
  documentIds: access.ids.documents,
});
await post(`/applications/${a.id}/review`, {
  expectedRevision: 1, items: [{ name: "식자재 세트", quantity: 100, unitPriceKrw: "30000" }], note: "시연 서류 수동 검토 완료",
});
const cf = await post(`/applications/${a.id}/confirmations`, { expectedRevision: 1, consent: true, consentVersion: "v1" });
const result = await post(`/confirmations/${cf.id}/decision`, {
  decision: "CONFIRM", snapshotHash: cf.snapshot_hash, deliveryAcknowledged: true, paymentObligationAcknowledged: true,
}, "buyer");
assert.equal(result.status, "CONFIRMED");
async function registrationStatus() {
  const user = access.credentials.supplier;
  const response = await fetch(`${endpoint}/applications/${a.id}/registration`, { headers: {
    authorization: `Bearer ${user.token}`, "x-organization-id": user.organizationId,
  } });
  if (!response.ok) throw new Error(`Registration status: ${response.status}`);
  return response.json();
}
let registration = await registrationStatus();
if (process.argv.includes("--wait-registration")) {
  const deadline = Date.now() + Math.min(300000, Math.max(30000, Number(process.env.DEMO_WAIT_MS) || 30000));
  while (registration.status !== "CONFIRMED" && Date.now() < deadline) {
    if (registration.status === "FAILED") throw new Error(`Registration failed: ${registration.failure_code}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    registration = await registrationStatus();
  }
  assert.equal(registration.status, "CONFIRMED", "Start the registration worker and check its status");
}
console.log(JSON.stringify({ applicationId: a.id, confirmationId: cf.id, status: result.status,
  snapshotHash: cf.snapshot_hash, chainRegistration: registration.status,
  receivableId: registration.receivable_id, transactionHash: registration.registration_tx_hash }, null, 2));
