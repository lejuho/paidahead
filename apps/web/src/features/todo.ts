import { applicationStage, type ApplicationRow } from "./stage.ts";

/** Whose move is it? `action` = this organization must act now, `waiting` = someone else (or the chain) is next. */
export type Bucket = "action" | "waiting" | "done";
export interface ReceivableRow { chain_status: string; overdue: boolean; review_status?: string | null; live_offer_amount?: string | null; open_supplements?: number | null }
export interface ReviewRow { status: string; chain_status: string; submitted_supplements?: number | null; live_offer?: boolean; open_approval?: boolean }

export function applicationBucket(a: ApplicationRow): Bucket {
  if (a.chain_status) return "done"; // continues on the receivables tab
  if (a.confirmation_status === "PENDING") return "waiting";
  if (a.confirmation_status === "CONFIRMED") return a.registration_status === "FAILED" ? "action" : "waiting";
  return "action"; // review, request, or revise after a rejection/withdrawal
}
export function supplierReceivable(r: ReceivableRow): { bucket: Bucket; next: string } {
  if (r.chain_status === "REGISTERED") {
    if (r.live_offer_amount) return { bucket: "action", next: "은행 조건 확인하고 먼저받기" };
    if (r.open_supplements) return { bucket: "action", next: "은행 보완 요청에 답변" };
    if (r.review_status === "DECLINED") return { bucket: "done", next: "은행 매입 불가 · 기록 보기" };
    return { bucket: "waiting", next: "은행 검토·조건 기다리기" };
  }
  return r.chain_status === "PURCHASED" ? { bucket: "waiting", next: "모의 지급 완료 · 구매처 상환 대기" } : { bucket: "done", next: "기록 보기" };
}
export function buyerReceivable(r: ReceivableRow): { bucket: Bucket; next: string } {
  if (r.chain_status === "PURCHASED") return { bucket: "action", next: r.overdue ? "연체 · 액면 전액 상환" : "액면 전액 모의 상환" };
  return r.chain_status === "REGISTERED" ? { bucket: "waiting", next: "은행 매입 전 · 상환 대상 아님" } : { bucket: "done", next: "기록 보기" };
}
export function bankReceivable(r: ReceivableRow): { bucket: Bucket; next: string } {
  if (r.chain_status === "PURCHASED") return r.overdue ? { bucket: "action", next: "연체 · 구매처 상환 확인" } : { bucket: "waiting", next: "구매처 상환 대기" };
  return r.chain_status === "REGISTERED" ? { bucket: "waiting", next: "검토 대기열에서 처리" } : { bucket: "done", next: "기록 보기" };
}
export function reviewBucket(b: ReviewRow): { bucket: Bucket; next: string } {
  if (b.chain_status !== "REGISTERED" || b.status === "DECLINED") return { bucket: "done", next: "기록 보기" };
  if (b.status === "PENDING") return { bucket: "action", next: "검토 시작" };
  if (b.status === "IN_REVIEW") return { bucket: "action", next: "판단: 보완 요청 · 매입 불가 · 조건 승인" };
  if (b.status === "NEEDS_INFO") return b.submitted_supplements ? { bucket: "action", next: "업체 답변 확인" } : { bucket: "waiting", next: "업체 보완 답변 대기" };
  if (b.live_offer) return { bucket: "waiting", next: "업체 수락 대기" };
  return { bucket: "action", next: b.open_approval ? "은행 지갑으로 오퍼 등록" : "새 조건 승인" };
}
export const confirmationBucket = (status: string): Bucket => (status === "PENDING" ? "action" : "done");
export const count = <T,>(rows: T[] | null | undefined, bucket: (row: T) => Bucket, want: Bucket = "action") => (rows ?? []).filter((r) => bucket(r) === want).length;
export { applicationStage };
