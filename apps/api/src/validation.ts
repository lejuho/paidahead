import { z } from "zod";
import { MAX_KRW } from "@paidahead/domain";

export const uuid = z.string().uuid();
export const revisionNumber = z.number().int().positive().max(2147483647);
const krw = z.string().refine((s) => /^[1-9][0-9]{0,18}$/.test(s) && BigInt(s) <= MAX_KRW, "Expected positive KRW integer");
export const revisionInput = z.object({
  buyerOrgId: uuid, targetBankOrgId: uuid,
  tradeReference: z.string().trim().min(1).max(100), title: z.string().trim().min(1).max(200),
  faceAmountKrw: krw,
  dueAt: z.string().datetime({ offset: true }).refine((s) => Number.isFinite(Date.parse(s)) && Date.parse(s) % 1000 === 0, "Use whole seconds"),
  documentIds: z.array(uuid).min(3).max(30).refine((ids) => new Set(ids).size === ids.length),
}).strict();
export type RevisionInput = z.infer<typeof revisionInput>;
export const reviewInput = z.object({
  expectedRevision: revisionNumber,
  items: z.array(z.object({ name: z.string().trim().min(1).max(200), quantity: z.number().int().positive().max(1000000),
    unitPriceKrw: krw }).strict()).min(1).max(100),
  note: z.string().trim().min(1).max(2000),
}).strict();
export const requestInput = z.object({ expectedRevision: revisionNumber, consent: z.literal(true), consentVersion: z.literal("v1") }).strict();
export const decisionInput = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("CONFIRM"), snapshotHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    deliveryAcknowledged: z.literal(true), paymentObligationAcknowledged: z.literal(true) }).strict(),
  z.object({ decision: z.literal("REJECT"), snapshotHash: z.string().regex(/^0x[0-9a-f]{64}$/), reason: z.string().trim().min(1).max(2000) }).strict(),
]);
