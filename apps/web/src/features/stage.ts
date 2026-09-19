import { confirmationLabel, receivableLabel, registrationLabel, revisionLabel, type Tone } from "../lib/labels.ts";

export interface ApplicationRow { id: string; revision_status: string; confirmation_status: string | null; registration_status: string | null; receivable_id: string | null; chain_status: string | null }
/** One status and one next action per application, from the furthest confirmed stage backwards. */
export function applicationStage(a: ApplicationRow): { label: { text: string; tone: Tone }; next: string; step: number } {
  if (a.chain_status) return { label: receivableLabel(a.chain_status), step: 4,
    next: a.chain_status === "REGISTERED" ? "은행 검토·조건 확인" : a.chain_status === "PURCHASED" ? "모의 지급 완료 · 구매처 상환 대기" : "완료된 거래" };
  if (a.confirmation_status === "CONFIRMED") return { label: registrationLabel(a.registration_status ?? "NOT_SUBMITTED"), step: 3,
    next: a.registration_status === "FAILED" ? "등록 재시도" : "채권 등록 완료 기다리기" };
  if (a.confirmation_status === "PENDING") return { label: confirmationLabel("PENDING"), step: 2, next: "구매처 확인 기다리기" };
  if (a.confirmation_status === "REJECTED" || a.confirmation_status === "WITHDRAWN") return { label: confirmationLabel(a.confirmation_status), step: 2, next: "보완 후 새 버전으로 다시 요청" };
  if (a.revision_status === "REVIEW_COMPLETED") return { label: revisionLabel(a.revision_status), step: 2, next: "구매처에 확인 요청" };
  return { label: revisionLabel(a.revision_status), step: 1, next: "서류 검토 완료하기" };
}
