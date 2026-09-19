/** Pure model of a wallet operation's visible progress. Business completion is ONLY the API's CONFIRMED status. */
export type ServerStatus = "AWAITING_SIGNATURE" | "PENDING" | "CONFIRMED" | "FAILED" | "USER_REJECTED";
export type LocalPhase = "idle" | "preparing" | "checking" | "approving" | "wallet" | "reporting" | "error";
export type StepState = "todo" | "active" | "done" | "failed";
export const STEP_TITLES = ["거래 준비", "지갑 승인 대기", "전송", "체인 확정 대기", "DB 반영 완료"] as const;

export interface Progress { server?: ServerStatus | null; phase: LocalPhase; hasHash: boolean; receipt?: "success" | "reverted" | null }

export function deriveSteps(p: Progress): StepState[] {
  if (p.server === "CONFIRMED") return ["done", "done", "done", "done", "done"];
  if (p.server === "FAILED") return ["done", "done", "done", "failed", "todo"];
  if (p.server === "USER_REJECTED") return ["done", "failed", "todo", "todo", "todo"];
  if (p.server === "PENDING" || p.hasHash) {
    // A hash (or even a successful receipt) is not completion: the worker must verify and project it.
    return ["done", "done", p.phase === "reporting" ? "active" : "done", p.receipt === "reverted" ? "failed" : "active", "todo"];
  }
  if (p.phase === "wallet") return ["done", "active", "todo", "todo", "todo"];
  if (p.phase === "preparing" || p.phase === "checking" || p.phase === "approving") return ["active", "todo", "todo", "todo", "todo"];
  if (p.server === "AWAITING_SIGNATURE") return ["done", p.phase === "error" ? "failed" : "todo", "todo", "todo", "todo"];
  return [p.phase === "error" ? "failed" : "todo", "todo", "todo", "todo", "todo"];
}
export const isBusinessComplete = (p: Progress) => p.server === "CONFIRMED";
export const isOpen = (status?: string | null) => status === "AWAITING_SIGNATURE" || status === "PENDING";

export interface PaymentCheck { requiredRaw: string; balanceRaw: string; allowanceRaw: string; sufficientBalance: boolean; sufficientAllowance: boolean; fundingAddress: string }
export type Blocker = "NONE" | "NEEDS_APPROVAL" | "INSUFFICIENT_BALANCE" | "FUNDER_NOT_READY" | "INSUFFICIENT_GAS" | "CONTRACT_REJECTED";
/** What stops the main transaction now. `sender` is the connected/signing address. */
export function blockerOf(kind: string, sender: string, preflight: { simulation: string; sufficientGasBalance?: boolean; payment?: PaymentCheck | null }): Blocker {
  const pay = preflight.payment;
  if (pay) {
    const own = pay.fundingAddress.toLowerCase() === sender.toLowerCase();
    if (!own && (!pay.sufficientBalance || !pay.sufficientAllowance)) return "FUNDER_NOT_READY";
    // An offer does not reserve funds, so a bank may post it before funding; repayment needs the money now.
    if (own && !pay.sufficientBalance && kind !== "CREATE_OFFER") return "INSUFFICIENT_BALANCE";
    if (own && !pay.sufficientAllowance) return "NEEDS_APPROVAL";
  }
  if (preflight.simulation !== "OK") return "CONTRACT_REJECTED";
  if (preflight.sufficientGasBalance === false) return "INSUFFICIENT_GAS";
  return "NONE";
}

/** Plain-language status remains visible even when technical progress is collapsed. */
export function customerProgress(p: Progress): string {
  if (p.server === "CONFIRMED") return "처리가 완료되었습니다. 거래 결과가 서비스에 반영되었습니다.";
  if (p.server === "FAILED") return "거래를 완료하지 못했습니다. 현재 상태를 확인한 뒤 다시 시도해 주세요.";
  if (p.server === "USER_REJECTED") return "요청을 취소했습니다. 진행하려면 새 요청을 시작해 주세요.";
  if (p.server === "PENDING" || p.hasHash) return "거래를 보냈습니다. 최종 결과를 확인하고 있으니 완료 안내를 기다려 주세요.";
  if (p.phase === "approving") return "1단계 사용 승인을 처리하고 있습니다. 지갑에서 승인한 뒤 결과를 기다려 주세요.";
  if (p.phase === "wallet") return "지갑 창에서 이번 거래 내용을 확인하고 승인해 주세요.";
  if (p.phase === "preparing" || p.phase === "checking") return "진행할 수 있는지 확인하고 있습니다.";
  return "아래 내용을 확인한 뒤 진행해 주세요.";
}
