export type WalletFailure = "USER_REJECTED" | "REQUEST_PENDING" | "CHAIN_NOT_ADDED" | "INSUFFICIENT_GAS" | "REVERTED" | "RPC_ERROR";

/** Walks EIP-1193 / viem error chains. Classification only; callers decide what can be retried. */
export function classifyWalletError(error: unknown): WalletFailure {
  const seen = new Set<unknown>();
  let text = "";
  for (let e: any = error; e && typeof e === "object" && !seen.has(e); e = e.cause ?? e.data?.originalError) {
    seen.add(e);
    if (e.code === 4001 || e.code === "ACTION_REJECTED" || e.name === "UserRejectedRequestError") return "USER_REJECTED";
    if (e.code === -32002) return "REQUEST_PENDING";
    if (e.code === 4902 || e.name === "SwitchChainError" && /unrecognized|not been added|4902/i.test(String(e.message))) return "CHAIN_NOT_ADDED";
    text += ` ${e.name ?? ""} ${e.shortMessage ?? ""} ${e.message ?? ""} ${e.details ?? ""}`;
  }
  if (/user (rejected|denied)|rejected the request/i.test(text)) return "USER_REJECTED";
  if (/unrecognized chain|chain .*not.*added/i.test(text)) return "CHAIN_NOT_ADDED";
  if (/insufficient funds|exceeds (the )?balance/i.test(text)) return "INSUFFICIENT_GAS";
  if (/revert|execution reverted/i.test(text)) return "REVERTED";
  return "RPC_ERROR";
}
export const walletFailureMessage: Record<WalletFailure, string> = {
  USER_REJECTED: "지갑에서 서명을 거절했습니다. 자산 상태는 바뀌지 않았으며 다시 시도할 수 있습니다.",
  REQUEST_PENDING: "지갑에 이미 열려 있는 요청이 있습니다. 지갑 창을 확인한 뒤 다시 시도하세요.",
  CHAIN_NOT_ADDED: "지갑에 이 네트워크가 등록되어 있지 않습니다. 네트워크 추가를 승인해 주세요.",
  INSUFFICIENT_GAS: "가스비로 쓸 네이티브 토큰 잔액이 부족합니다.",
  REVERTED: "계약이 거래를 거절했습니다(revert). 채권·오퍼 상태나 잔액·사용 승인을 확인한 뒤 다시 시도하세요.",
  RPC_ERROR: "지갑 또는 RPC 오류로 전송하지 못했습니다. 네트워크 연결을 확인한 뒤 다시 시도하세요.",
};
