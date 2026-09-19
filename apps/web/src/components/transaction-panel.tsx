"use client";
import { useWallet } from "@/lib/wallet";
import { errorMessage, operationKind, operationLabel } from "@/lib/labels";
import { formatTokenRaw, shortAddress, shortHash } from "@/lib/format";
import { deriveSteps, STEP_TITLES } from "@/lib/tx-state";
import { blockerMessage, type useOperation } from "@/lib/use-operation";
import { Button, Card, Chip, Facts, Notice, Progress } from "./ui";

type Controller = ReturnType<typeof useOperation>;

/** Shows every stage separately: prepared → wallet approval → sent → chain confirmation → database projection. */
export function TransactionPanel({ tx }: { tx: Controller }) {
  const wallet = useWallet();
  const op = tx.operation;
  if (!op) return tx.phase === "preparing" ? <Card title="지갑 거래"><Progress steps={STEP_TITLES.map((title, i) => ({ title, state: i === 0 ? "active" : "todo" }))} /></Card>
    : tx.message ? <Notice tone="bad">{tx.message}</Notice> : null;
  const hash = op.transactionHash ?? tx.localHash;
  const states = deriveSteps({ server: op.status, phase: tx.phase, hasHash: !!hash, receipt: tx.receipt });
  const notes: (React.ReactNode | undefined)[] = [
    tx.phase === "checking" ? "체인 사전 점검 중…" : tx.phase === "approving" ? "토큰 사용 승인 거래를 지갑에서 확인하세요…" : undefined,
    tx.phase === "wallet" ? "지갑 창에서 거래 내용을 확인하고 승인하세요." : op.status === "USER_REJECTED" ? "지갑에서 거절됨" : undefined,
    hash ? <span title={hash} data-testid="tx-hash">거래 해시 {shortHash(hash)}</span> : undefined,
    states[3] === "active" ? (tx.receipt === "success" ? "체인에 포함됨 · 워커가 영수증·이벤트를 검증하는 중입니다." : "블록 포함과 확정 깊이를 기다리는 중입니다.")
      : states[3] === "failed" ? errorMessage(op.failureCode ?? "TRANSACTION_REVERTED") : undefined,
    op.status === "CONFIRMED" ? "검증된 체인 결과가 업무 DB에 반영되었습니다." : undefined,
  ];
  const pay = tx.preflight?.payment;
  const mismatch = wallet.address && wallet.address.toLowerCase() !== op.transaction.from.toLowerCase();
  const canAct = op.status === "AWAITING_SIGNATURE" && !hash;
  return (
    <Card title={<>지갑 거래 · {operationKind[op.kind] ?? op.kind}</>} aside={<Chip label={operationLabel(hash && op.status === "AWAITING_SIGNATURE" ? "PENDING" : op.status)} />} tone="accent">
      <div data-testid="tx-panel" data-status={op.status}>
        {tx.recovered && <Notice>이전에 시작한 거래를 서버 기록에서 이어서 표시합니다.</Notice>}
        <Progress steps={STEP_TITLES.map((title, i) => ({ title, state: states[i], note: notes[i] }))} />
        {canAct && <>
          <Facts items={[["서명 지갑", <span key="f" title={op.transaction.from}>{shortAddress(op.transaction.from)}{mismatch ? " · 연결된 지갑과 다름" : ""}</span>],
            ["네트워크", `체인 ${op.transaction.chainId}`],
            ...(pay ? [["필요 금액", formatTokenRaw(pay.requiredRaw)], [`자금 지갑 잔액 (${shortAddress(pay.fundingAddress)})`, <span key="b" className={pay.sufficientBalance ? "" : "bad"}>{formatTokenRaw(pay.balanceRaw)}</span>],
              ["결제 계약 사용 승인", <span key="a" className={pay.sufficientAllowance ? "" : "bad"}>{formatTokenRaw(pay.allowanceRaw)}</span>]] as [string, React.ReactNode][] : []),
            ...(tx.preflight ? [["계약 사전 점검", tx.preflight.simulation === "OK" ? "통과" : "거절됨"] as [string, React.ReactNode]] : [])]} />
          {tx.blocker && tx.blocker !== "NONE" && <Notice tone={tx.blocker === "NEEDS_APPROVAL" ? "wait" : "bad"}><span data-testid="tx-blocker" data-blocker={tx.blocker}>{blockerMessage[tx.blocker]}</span></Notice>}
          {op.kind === "CREATE_OFFER" && pay && !pay.sufficientBalance && <Notice tone="wait">오퍼 등록은 자금을 예약하지 않습니다. 업체가 수락하는 시점에 은행 지갑 잔액·사용 승인이 다시 검사됩니다.</Notice>}
        </>}
        {tx.message && <Notice tone={tx.phase === "error" ? "bad" : "wait"}><span data-testid="tx-message">{tx.message}</span></Notice>}
        <div className="actions">
          {canAct && tx.blocker === "NEEDS_APPROVAL" && <Button onClick={tx.approve} busy={tx.phase === "approving"} disabled={tx.working} data-testid="tx-approve">1단계 · 토큰 사용 승인</Button>}
          {canAct && <Button onClick={tx.send} busy={tx.phase === "wallet" || tx.phase === "reporting"} disabled={tx.working || !tx.preflight || (tx.blocker !== "NONE")} data-testid="tx-send">
            {tx.blocker === "NEEDS_APPROVAL" ? "2단계 · 지갑으로 서명·전송" : "지갑으로 서명·전송"}</Button>}
          {canAct && <Button variant="secondary" onClick={tx.recheck} disabled={tx.working} data-testid="tx-recheck">다시 점검</Button>}
          {canAct && <Button variant="ghost" onClick={tx.abandon} disabled={tx.working}>이 요청 취소</Button>}
          {!tx.open && <Button variant="secondary" onClick={tx.dismiss} data-testid="tx-dismiss">닫기</Button>}
        </div>
        {op.status === "FAILED" && <p className="muted">실패한 거래는 자산 상태를 바꾸지 않습니다. 현재 상태를 확인한 뒤 새 거래로 다시 시도할 수 있습니다.</p>}
      </div>
    </Card>);
}
