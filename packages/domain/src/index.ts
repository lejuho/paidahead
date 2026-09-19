import { keccak256, toHex, type Hex } from "viem";

export const RECEIVABLE_STATUS = {
  NONE: 0, REGISTERED: 1, PURCHASED: 2, REPAID: 3, CANCELLED: 4,
} as const;
export type ReceivableStatus = keyof typeof RECEIVABLE_STATUS;
export const OFFER_STATUS = {
  NONE: 0, ACTIVE: 1, WITHDRAWN: 2, EXPIRED: 3, ACCEPTED: 4, INVALIDATED: 5,
} as const;
export const CHAIN_ROLES = Object.fromEntries(
  ["REGISTRAR_ROLE", "SUPPLIER_ROLE", "PAYER_ROLE", "BANK_ROLE"].map(
    (name) => [name, keccak256(toHex(name))],
  ),
) as Record<"REGISTRAR_ROLE" | "SUPPLIER_ROLE" | "PAYER_ROLE" | "BANK_ROLE", Hex>;
export const ORGANIZATION_ROLES = ["SUPPLIER", "BUYER", "BANK", "PLATFORM"] as const;
export const WORKFLOW_STATES = {
  application: ["DRAFT", "ANALYZING", "REVIEW_REQUIRED", "REVIEW_COMPLETED", "ANALYSIS_FAILED"],
  confirmation: ["PENDING", "CONFIRMED", "REJECTED", "WITHDRAWN", "INVALIDATED"],
  bankReview: ["PENDING", "IN_REVIEW", "NEEDS_INFO", "APPROVED_FOR_OFFER", "DECLINED"],
  operation: ["NOT_SUBMITTED", "AWAITING_SIGNATURE", "PENDING", "CONFIRMED", "FAILED", "USER_REJECTED"],
} as const;
export const MOCK_TOKEN_DECIMALS = 6;
export const MAX_KRW = (1n << 63n) - 1n;

/** API amounts are canonical integer strings, never JS floating point numbers. */
export function parseKrw(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("Invalid KRW integer");
  const amount = BigInt(value);
  if (amount > MAX_KRW) throw new Error("KRW exceeds PostgreSQL bigint");
  return amount;
}

function scale(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("Invalid decimals");
  return 10n ** BigInt(decimals);
}

export function toTokenUnits(krw: string, decimals = MOCK_TOKEN_DECIMALS): bigint {
  return parseKrw(krw) * scale(decimals);
}

export function fromTokenUnits(raw: bigint, decimals = MOCK_TOKEN_DECIMALS): string {
  const unit = scale(decimals);
  if (raw < 0n || raw % unit !== 0n) throw new Error("Not a whole KRW amount");
  const value = (raw / unit).toString();
  parseKrw(value);
  return value;
}

export function isOverdue(status: ReceivableStatus, dueAt: bigint, now: bigint): boolean {
  return status === "PURCHASED" && now > dueAt;
}

/** Proposed v1 policy; time values use Unix seconds. */
export function validateOffer(face: string, purchase: string, expiresAt: bigint, dueAt: bigint, now: bigint): void {
  const faceAmount = parseKrw(face);
  const purchaseAmount = parseKrw(purchase);
  if (purchaseAmount === 0n || purchaseAmount > faceAmount) throw new Error("Invalid purchase amount");
  if (expiresAt <= now || expiresAt >= dueAt) throw new Error("Invalid offer expiry");
}

export interface ConfirmationSnapshot {
  schemaVersion: 1;
  applicationId: string;
  revision: number;
  supplierOrgId: string;
  buyerOrgId: string;
  targetBankOrgId: string;
  tradeReference: string;
  faceAmountKrw: string;
  currency: "KRW";
  dueAt: string; // Canonical Unix seconds string.
  documents: readonly { documentId: string; sha256: string }[];
  reviewedFieldsHash: Hex; // Hash of immutable final fields, items and review evidence.
  consentVersion: string;
}

/** Ordered serialization v1. Document order is irrelevant; duplicate IDs are rejected. */
export function hashSnapshot(s: ConfirmationSnapshot): Hex {
  if (s.schemaVersion !== 1 || s.currency !== "KRW" || !Number.isSafeInteger(s.revision) || s.revision < 1
      || parseKrw(s.faceAmountKrw) === 0n || !/^[1-9][0-9]*$/.test(s.dueAt)
      || BigInt(s.dueAt) > (1n << 64n) - 1n) throw new Error("Invalid snapshot");
  for (const value of [s.applicationId, s.supplierOrgId, s.buyerOrgId, s.targetBankOrgId,
    s.tradeReference, s.consentVersion]) {
    if (!value.trim()) throw new Error("Missing snapshot field");
  }
  if (s.supplierOrgId === s.buyerOrgId) throw new Error("Self trade unsupported in v1");
  if (!/^0x[0-9a-fA-F]{64}$/.test(s.reviewedFieldsHash) || BigInt(s.reviewedFieldsHash) === 0n) {
    throw new Error("Invalid reviewed fields hash");
  }
  if (s.documents.length === 0 || new Set(s.documents.map((d) => d.documentId)).size !== s.documents.length) {
    throw new Error("Invalid document manifest");
  }
  const documents = s.documents.map((d) => {
    if (!d.documentId.trim() || !/^[0-9a-fA-F]{64}$/.test(d.sha256)) throw new Error("Invalid document hash");
    return { documentId: d.documentId, sha256: d.sha256.toLowerCase() };
  }).sort((a, b) => a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0);
  // Explicit fields prevent incidental object property order or extra fields changing the digest.
  return keccak256(toHex(JSON.stringify({
    schemaVersion: 1, applicationId: s.applicationId, revision: s.revision,
    supplierOrgId: s.supplierOrgId, buyerOrgId: s.buyerOrgId, targetBankOrgId: s.targetBankOrgId,
    tradeReference: s.tradeReference, faceAmountKrw: s.faceAmountKrw, currency: "KRW", dueAt: s.dueAt,
    documents, reviewedFieldsHash: s.reviewedFieldsHash.toLowerCase(), consentVersion: s.consentVersion,
  })));
}

export { settlementAbi, paymentAbi } from "./settlement.ts";
