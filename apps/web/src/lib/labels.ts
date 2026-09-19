export type Tone = "neutral" | "wait" | "action" | "good" | "bad";
type Label = { text: string; tone: Tone };
const table = (entries: Record<string, [string, Tone]>) => (key?: string | null): Label => {
  const found = key ? entries[key] : undefined;
  return found ? { text: found[0], tone: found[1] } : { text: key ?? "-", tone: "neutral" };
};
export const revisionLabel = table({ DRAFT: ["서류 검토 필요", "action"], REVIEW_REQUIRED: ["검토 필요", "action"], REVIEW_COMPLETED: ["검토 완료", "good"] });
export const confirmationLabel = table({ PENDING: ["구매처 확인 대기", "wait"], CONFIRMED: ["구매처 확인 완료", "good"], REJECTED: ["구매처 반려", "bad"],
  WITHDRAWN: ["요청 철회", "neutral"], INVALIDATED: ["이전 버전 · 무효", "neutral"] });
export const registrationLabel = table({ CONFIRMATION_REQUIRED: ["확인 전", "neutral"], NOT_SUBMITTED: ["등록 대기", "wait"], PENDING: ["등록 처리 중", "wait"],
  CONFIRMED: ["채권 등록 완료", "good"], FAILED: ["등록 실패", "bad"], INVALIDATED: ["무효", "neutral"] });
export const receivableLabel = table({ REGISTERED: ["등록됨 · 매입 전", "wait"], PURCHASED: ["매입 완료 · 상환 대기", "action"], REPAID: ["상환 완료", "good"], CANCELLED: ["등록 취소", "neutral"] });
export const reviewLabel = table({ PENDING: ["검토 대기", "action"], IN_REVIEW: ["검토 중", "wait"], NEEDS_INFO: ["보완 요청 중", "wait"],
  APPROVED_FOR_OFFER: ["조건 승인", "good"], DECLINED: ["매입 불가", "bad"] });
export const offerLabel = table({ ACTIVE: ["유효", "good"], WITHDRAWN: ["철회됨", "neutral"], EXPIRED: ["만료", "neutral"], ACCEPTED: ["수락 · 매입 완료", "good"], INVALIDATED: ["무효", "neutral"] });
export const supplementLabel = table({ REQUESTED: ["답변 필요", "action"], SUBMITTED: ["답변 제출됨", "wait"], CLOSED: ["확인 완료", "good"] });
export const operationLabel = table({ AWAITING_SIGNATURE: ["지갑 서명 대기", "action"], PENDING: ["체인 확정 대기", "wait"], CONFIRMED: ["반영 완료", "good"],
  FAILED: ["실패", "bad"], USER_REJECTED: ["서명 거절", "neutral"] });
export const operationKind: Record<string, string> = { CREATE_OFFER: "조건 제시(오퍼 등록)", WITHDRAW_OFFER: "조건 철회", ACCEPT_OFFER: "먼저받기(매입)", REPAY: "전액 상환", CANCEL: "등록 취소" };
export const documentType: Record<string, string> = { PURCHASE_ORDER: "발주서", DELIVERY_NOTE: "납품서", INVOICE: "청구서" };
export const eventLabel: Record<string, string> = { OfferCreated: "은행 조건 등록", OfferClosed: "조건 종료", Settled: "매입 · 모의 지급", Repaid: "전액 상환", Cancelled: "등록 취소" };
export const reviewAction: Record<string, string> = { START: "검토 시작", NOTE: "내부 메모", REQUEST_INFO: "보완 요청", DECLINE: "매입 불가", OFFER_APPROVED: "조건 승인",
  SUPPLEMENT_SUBMITTED: "업체 보완 답변", SUPPLEMENT_CLOSED: "보완 확인" };

const errors: Record<string, string> = {
  UNAUTHENTICATED: "시연 로그인이 만료되었습니다. 역할을 다시 선택하거나 `npm run db:seed`로 토큰을 재발급하세요.",
  FORBIDDEN: "이 조직·역할로는 할 수 없는 작업입니다.", NOT_FOUND: "대상을 찾을 수 없거나 접근 권한이 없습니다.",
  INVALID_INPUT: "입력값을 다시 확인해 주세요.", API_UNAVAILABLE: "업무 API에 연결할 수 없습니다. `npm run dev:api` 실행 여부를 확인하세요.",
  DEMO_ACCESS_MISSING: "시연 토큰 파일이 없습니다. `npm run db:seed`를 먼저 실행하세요.", DEMO_DISABLED: "시연 모드가 꺼져 있습니다.",
  STALE_REVISION: "다른 곳에서 신청이 변경되었습니다. 새로고침 후 다시 시도하세요.", STALE_REVIEW: "검토 건이 변경되었습니다. 최신 내용으로 다시 시도하세요.",
  ITEM_TOTAL_MISMATCH: "품목 합계가 신청 금액과 다릅니다.", DUE_DATE_PASSED: "만기가 이미 지났습니다.", SELF_TRADE_UNSUPPORTED: "같은 조직 간 거래는 지원하지 않습니다.",
  REVISION_FROZEN: "확인 요청된 버전은 수정할 수 없습니다.", NEW_REVISION_REQUIRED: "반려·철회 후에는 새 버전을 만들어 다시 검토해야 합니다.",
  REGISTRATION_LOCKED: "채권 등록이 예약되어 더 이상 수정할 수 없습니다.", REVIEW_NOT_COMPLETED: "서류 검토를 먼저 완료하세요.",
  SNAPSHOT_MISMATCH: "확인 대상 버전이 바뀌었습니다. 새로고침하세요.", CONFIRMATION_NOT_PENDING: "이미 처리된 확인 요청입니다.",
  DECISION_ALREADY_RECORDED: "이미 다른 결정이 기록되었습니다.", REGISTRATION_NOT_RETRYABLE: "재시도할 수 있는 상태가 아닙니다.",
  TRANSACTION_RESULT_UNKNOWN: "이전 등록 거래 결과를 확인 중입니다.", RECEIVABLE_NOT_REVIEWABLE: "등록 상태·만기 때문에 검토할 수 없는 채권입니다.",
  REVIEW_FINALIZED: "이미 종결된 검토입니다.", INVALID_REVIEW_STATE: "현재 검토 상태에서는 할 수 없습니다.", NOTE_REQUIRED: "내부 메모를 입력하세요.",
  PUBLIC_REQUEST_REQUIRED: "검토 중일 때만, 업체에 공개할 요청 내용과 함께 보낼 수 있습니다.", PUBLIC_REASON_REQUIRED: "검토 중일 때만, 공개 사유와 함께 처리할 수 있습니다.",
  SUPPLEMENT_NOT_OPEN: "답변할 수 없는 보완 요청입니다.", SUPPLEMENT_NOT_SUBMITTED: "업체 답변이 제출된 뒤 확인할 수 있습니다.", SUPPLEMENT_OPEN: "미확인 보완 요청이 있습니다.",
  REVIEW_REQUIRED: "검토를 시작한 뒤 조건을 승인할 수 있습니다.", SETTLEMENT_NOT_READY: "결제 계약 설정이 준비되지 않았습니다.", SETTLEMENT_NOT_CONFIGURED: "활성 계약 배포가 없습니다. `npm run chain:setup`을 실행하세요.",
  INVALID_OFFER_TERMS: "매입 금액은 액면 이하, 유효기간은 현재 이후·만기 이전이어야 합니다.", LIVE_APPROVAL_EXISTS: "아직 유효한 조건 승인 또는 오퍼가 있습니다.",
  APPROVED_WALLET_REQUIRED: "승인된 조직 지갑이 필요합니다.", APPROVAL_NOT_ACTIVE: "조건 승인이 만료되었거나 채권 상태가 바뀌었습니다.", ACTIVE_OFFER_EXISTS: "이미 유효한 오퍼가 있습니다.",
  APPROVAL_ALREADY_USED: "이미 오퍼로 등록된 승인입니다.", OFFER_NOT_ACTIVE: "유효한 오퍼가 아닙니다.", OFFER_NOT_ACCEPTABLE: "수락할 수 없는 오퍼입니다(만료·미승인·상태 변경).",
  NOT_PURCHASED: "매입된 채권만 상환할 수 있습니다.", NOT_CANCELLABLE: "매입 전 등록 상태에서만 취소할 수 있습니다.", OPERATION_IN_PROGRESS: "같은 거래가 이미 진행 중입니다. 진행 중인 거래를 이어서 처리합니다.",
  IDEMPOTENCY_CONFLICT: "요청 식별자가 충돌했습니다. 다시 시도하세요.", OPERATION_ALREADY_SUBMITTED: "이미 제출된 거래입니다.", CHAIN_RPC_NOT_CONFIGURED: "API의 체인 RPC가 설정되지 않았습니다.",
  CHAIN_RPC_UNAVAILABLE: "체인 RPC에 연결할 수 없습니다. 로컬 체인 실행 여부를 확인하세요.", WRONG_CHAIN: "API가 다른 체인에 연결되어 있습니다.", DATA_CONFLICT: "데이터 충돌이 발생했습니다. 새로고침 후 다시 시도하세요.",
  TRANSACTION_REVERTED: "체인에서 거래가 되돌려졌습니다(revert). 자산 상태는 바뀌지 않았습니다.", TRANSACTION_MISMATCH: "통지된 거래 해시가 준비된 거래와 일치하지 않습니다.",
  INTERNAL_ERROR: "서버 오류가 발생했습니다.", NETWORK: "네트워크 오류로 요청하지 못했습니다.",
};
export const errorMessage = (code?: string | null) => (code ? errors[code] ?? `처리하지 못했습니다 (${code})` : "알 수 없는 오류");
