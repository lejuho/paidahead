/**
 * Browser-only walkthrough ("화면 체험"). Nothing here talks to the API, a wallet or a chain:
 * it is a scripted simulation with fixed virtual data, so it never produces transaction hashes or "on-chain" claims.
 */
export type TourRole = "supplier" | "buyer" | "bank";
export const TOUR_ROLE_NAME: Record<TourRole, string> = { supplier: "납품업체", buyer: "구매처", bank: "은행" };
export const FACE = 3_000_000n, PURCHASE = 2_970_000n;
export const ORGS = { supplier: "대구 식자재 납품 (가상)", buyer: "시장 식당 (가상)", bank: "iM뱅크 역할 · 시연용" } as const;

export type Stage = "NEW" | "CREATED" | "REVIEWED" | "REQUESTED" | "REGISTERED" | "IN_REVIEW" | "APPROVED" | "OFFERED" | "PURCHASED" | "REPAID";
export const STAGES: Stage[] = ["NEW", "CREATED", "REVIEWED", "REQUESTED", "REGISTERED", "IN_REVIEW", "APPROVED", "OFFERED", "PURCHASED", "REPAID"];
export interface Step { actor: TourRole; action: string; simulatedApproval: boolean; event: string; waiting: string }
/** The single action available at each stage, and who performs it. `simulatedApproval` replaces a wallet signature. */
export const NEXT: Record<Exclude<Stage, "REPAID">, Step> = {
  NEW: { actor: "supplier", action: "먼저받기 신청 만들기", simulatedApproval: false, event: "납품업체가 300만원 채권을 신청", waiting: "납품업체가 신청을 만드는 중" },
  CREATED: { actor: "supplier", action: "서류 검토 완료", simulatedApproval: false, event: "서류 3종 검토 완료 (분석 결과 예시 확인)", waiting: "납품업체가 서류를 검토하는 중" },
  REVIEWED: { actor: "supplier", action: "동의하고 구매처에 확인 요청", simulatedApproval: false, event: "구매처에 납품·지급 의무 확인 요청", waiting: "납품업체가 확인을 요청하기 전" },
  REQUESTED: { actor: "buyer", action: "납품·지급 의무 확인", simulatedApproval: false, event: "구매처 확인 → 이전 제한 채권 토큰 등록 (시뮬레이션)", waiting: "구매처 확인을 기다리는 중" },
  REGISTERED: { actor: "bank", action: "검토 시작", simulatedApproval: false, event: "은행이 등록 채권 검토 시작", waiting: "은행 검토를 기다리는 중" },
  IN_REVIEW: { actor: "bank", action: "297만원 매입 조건 승인", simulatedApproval: false, event: "은행이 매입 조건 297만원 승인", waiting: "은행이 조건을 판단하는 중" },
  APPROVED: { actor: "bank", action: "조건 제시(오퍼 등록)", simulatedApproval: true, event: "은행 조건 제시 (시뮬레이션)", waiting: "은행이 조건을 제시하기 전" },
  OFFERED: { actor: "supplier", action: "이 조건으로 먼저받기", simulatedApproval: true, event: "동시 결제: 채권 → 은행, 297만 모의 대금 → 납품업체 (시뮬레이션)", waiting: "납품업체의 수락을 기다리는 중" },
  PURCHASED: { actor: "buyer", action: "액면 300만원 전액 상환", simulatedApproval: true, event: "구매처가 은행에 300만원 전액 상환 → 채권 종결 (시뮬레이션)", waiting: "구매처의 만기 상환을 기다리는 중" },
};
export interface TourState { stage: Stage; role: TourRole; events: { stage: Stage; text: string; at: string }[] }
export const initialTour = (role: TourRole = "supplier"): TourState => ({ stage: "NEW", role, events: [] });
export const stepOf = (state: TourState): Step | null => (state.stage === "REPAID" ? null : NEXT[state.stage]);
export const isMyTurn = (state: TourState) => stepOf(state)?.actor === state.role;

/** Only the actor whose turn it is can advance; anything else returns the state unchanged. */
export function advance(state: TourState, now = new Date()): TourState {
  const step = stepOf(state);
  if (!step || step.actor !== state.role) return state;
  const stage = STAGES[STAGES.indexOf(state.stage) + 1];
  return { ...state, stage, events: [...state.events, { stage, text: step.event, at: now.toISOString() }] };
}
export const switchRole = (state: TourState, role: TourRole): TourState => ({ ...state, role });

const reached = (state: TourState, stage: Stage) => STAGES.indexOf(state.stage) >= STAGES.indexOf(stage);
/** Virtual mock-token balances and the receivable holder: shows the atomic swap and the full repayment. */
export function ledger(state: TourState) {
  const purchased = reached(state, "PURCHASED"), repaid = reached(state, "REPAID");
  return {
    holder: !reached(state, "REGISTERED") ? null : purchased ? "bank" as TourRole : "supplier" as TourRole,
    receivable: !reached(state, "REGISTERED") ? "미등록" : repaid ? "상환 완료 · 종결" : purchased ? "매입 완료 · 상환 대기" : "등록됨 · 매입 전",
    balances: { supplier: purchased ? PURCHASE : 0n, bank: 10_000_000n - (purchased ? PURCHASE : 0n) + (repaid ? FACE : 0n), buyer: 5_000_000n - (repaid ? FACE : 0n) },
  };
}
export const FLOW: { title: string; from: Stage }[] = [
  { title: "서류 제출·검토", from: "REVIEWED" }, { title: "구매처 확인·채권 등록", from: "REGISTERED" }, { title: "은행 검토·조건", from: "OFFERED" },
  { title: "먼저받기 (동시 결제)", from: "PURCHASED" }, { title: "만기 전액 상환", from: "REPAID" }];
export function flowStates(state: TourState): ("done" | "active" | "todo")[] {
  let activeGiven = false;
  return FLOW.map((f) => { if (reached(state, f.from)) return "done"; if (!activeGiven) { activeGiven = true; return "active"; } return "todo"; });
}

export const DOCUMENTS = [
  { type: "발주서", file: "PO-DEMO-001", body: "시연용 가상 발주서 PO-DEMO-001\n납품업체: 대구 식자재 납품 역할\n구매처: 시장 식당 역할\n품목: 식자재 세트 100개, 단가 30,000원\n합계: 3,000,000원\n지급일: 신청에 지정된 만기일",
    fields: { 거래처: "시장 식당", 품목: "식자재 세트 100개", 금액: "3,000,000원", 지급일: "만기일" } },
  { type: "납품서", file: "DN-DEMO-001", body: "시연용 가상 납품서 DN-DEMO-001\n납품업체: 대구 식자재 납품 역할\n구매처: 시장 식당 역할\n품목: 식자재 세트 100개\n납품금액: 3,000,000원\n실제 납품을 증명하는 자료가 아닙니다.",
    fields: { 거래처: "시장 식당", 품목: "식자재 세트 100개", 금액: "3,000,000원", 지급일: "(기재 없음)" } },
  { type: "청구서", file: "INV-DEMO-001", body: "시연용 가상 청구서 INV-DEMO-001\n공급자: 대구 식자재 납품 역할\n청구 대상: 시장 식당 역할\n품목: 식자재 세트 100개, 단가 30,000원\n청구금액: 3,000,000원\n지급일: 신청에 지정된 만기일",
    fields: { 거래처: "시장 식당", 품목: "식자재 세트 100개", 금액: "3,000,000원", 지급일: "만기일" } },
] as const;
/** Illustrative output only. No OCR/LLM runs in this prototype. */
export const ANALYSIS = [
  { field: "거래처", result: "일치", note: "3종 서류 모두 ‘시장 식당’" }, { field: "품목·수량", result: "일치", note: "식자재 세트 100개" },
  { field: "금액", result: "일치", note: "100개 × 30,000원 = 3,000,000원" }, { field: "지급일", result: "확인 필요", note: "납품서에 지급일 없음 → 발주서·청구서 기준으로 사람이 확인" },
] as const;
