import assert from "node:assert/strict";
import { test } from "node:test";
import { fromTokenUnits, toTokenUnits, parseKrw, MAX_KRW, validateOffer, isOverdue,
  hashSnapshot, type ConfirmationSnapshot } from "../src/index.ts";

test("KRW conversion remains exact above Number.MAX_SAFE_INTEGER", () => {
  assert.equal(toTokenUnits("2970000"), 2_970_000_000_000n);
  assert.equal(fromTokenUnits(toTokenUnits(MAX_KRW.toString())), MAX_KRW.toString());
  for (const value of ["-1", "1.1", "01", "1e3", "", (MAX_KRW + 1n).toString()]) {
    assert.throws(() => parseKrw(value));
  }
  assert.throws(() => fromTokenUnits(1n));
  assert.throws(() => toTokenUnits("1", 19));
});

test("offer and overdue boundaries match v1 policies", () => {
  validateOffer("3000000", "2970000", 150n, 200n, 100n);
  assert.throws(() => validateOffer("3000000", "3000001", 150n, 200n, 100n));
  assert.throws(() => validateOffer("3000000", "0", 150n, 200n, 100n));
  assert.throws(() => validateOffer("3000000", "2970000", 200n, 200n, 100n));
  assert.equal(isOverdue("PURCHASED", 200n, 201n), true);
  assert.equal(isOverdue("REPAID", 200n, 201n), false);
  assert.equal(isOverdue("REGISTERED", 200n, 201n), false);
});

test("confirmation digest is deterministic and binds the exact revision and documents", () => {
  const snapshot: ConfirmationSnapshot = {
    schemaVersion: 1, applicationId: "application-1", revision: 1,
    supplierOrgId: "supplier", buyerOrgId: "buyer", targetBankOrgId: "bank",
    tradeReference: "invoice-1", faceAmountKrw: "3000000", currency: "KRW", dueAt: "1800000000",
    documents: [{ documentId: "b", sha256: "b".repeat(64) }, { documentId: "a", sha256: "a".repeat(64) }],
    reviewedFieldsHash: `0x${"c".repeat(64)}`, consentVersion: "v1",
  };
  const original = hashSnapshot(snapshot);
  assert.equal(original, hashSnapshot({ ...snapshot, documents: [...snapshot.documents].reverse() }));
  assert.notEqual(original, hashSnapshot({ ...snapshot, revision: 2 }));
  assert.notEqual(original, hashSnapshot({ ...snapshot, faceAmountKrw: "3000001" }));
  assert.notEqual(original, hashSnapshot({ ...snapshot, buyerOrgId: "other" }));
  assert.throws(() => hashSnapshot({ ...snapshot, documents: [snapshot.documents[0], snapshot.documents[0]] }));
});
