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
