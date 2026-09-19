"use client";
import { formatEther } from "viem";
import { useWallet } from "@/lib/wallet";
import { useSession } from "@/lib/session";
import { formatTokenRaw, shortAddress } from "@/lib/format";
import { walletFailureMessage } from "@/lib/wallet-errors";
import { Button } from "./ui";

/** Wallet state is informational: it never grants login or organization permissions. */
export function WalletBar() {
  const w = useWallet(); const { me, chain } = useSession();
  if (!chain) return <div className="wallet wallet-off" data-testid="wallet-bar"><strong>지갑</strong><span>활성 계약 배포가 없어 지갑 거래를 사용할 수 없습니다. `npm run chain:setup` 후 새로고침하세요.</span></div>;
  if (w.status !== "connected") {
    return (<div className="wallet" data-testid="wallet-bar"><div><strong>지갑 미연결</strong>
      <span>{w.available.length ? "서명이 필요한 단계에서 조직 승인 지갑을 연결하세요. 연결만으로 권한이 생기지 않습니다." : "EVM 지갑 확장 프로그램(예: MetaMask)이 감지되지 않았습니다."}</span>
      {w.failure && <span className="bad">{walletFailureMessage[w.failure]}</span>}</div>
      <div className="wallet-actions">{w.available.map((d) => (
        <Button key={d.id} variant="secondary" busy={w.status === "connecting"} onClick={() => w.connect(d.id)}>{d.name} 연결</Button>))}</div></div>);
  }
  const native = w.balances ? `${Number(formatEther(w.balances.native)).toFixed(4)} ${chain.chainId === 1439 ? "INJ" : "ETH"}` : "-"; // display only; gas is not a KRW amount
  return (<div className={`wallet ${w.onExpectedChain && w.matchesOrganization ? "wallet-ok" : "wallet-warn"}`} data-testid="wallet-bar">
    <div><strong title={w.address ?? ""} data-testid="wallet-address">{w.walletName} · {shortAddress(w.address)}</strong>
      <span>네트워크 {w.chainId}{w.onExpectedChain ? ` · ${chain.chainId === 1439 ? "Injective 테스트넷" : "로컬 시연 체인"}` : ""}
        {w.onExpectedChain && <> · 모의 토큰 <b data-testid="token-balance">{w.balances ? formatTokenRaw(w.balances.token) : "-"}</b> · 가스 {native}</>}</span>
      {!w.onExpectedChain && <span className="bad" data-testid="wrong-network">잘못된 네트워크입니다. 이 서비스는 체인 {chain.chainId}에서만 거래합니다.</span>}
      {w.onExpectedChain && !w.matchesOrganization && <span className="bad" data-testid="wallet-mismatch">
        이 지갑은 {me?.organization.display_name}의 승인 지갑이 아닙니다. 승인 지갑: {w.organizationWallets.map((a) => shortAddress(a)).join(", ") || "없음"}. 지갑에서 계정을 바꿔 주세요.</span>}
      {w.failure && <span className="bad">{walletFailureMessage[w.failure]}</span>}</div>
    <div className="wallet-actions">
      {!w.onExpectedChain && <Button onClick={() => w.switchChain()}>네트워크 전환</Button>}
      <Button variant="ghost" onClick={() => w.disconnect()}>연결 해제</Button></div></div>);
}

/** Connection is offered at the point of signing; it is not identity verification. */
export function SigningWallet({ expectedFrom, disabled = false }: { expectedFrom: string; disabled?: boolean }) {
  const w = useWallet();
  if (!w.expected) return <p role="alert">시연 거래 환경을 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.</p>;
  const mismatch = w.address?.toLowerCase() !== expectedFrom.toLowerCase();
  return <div className="signing-wallet" data-testid="signing-wallet">
    {w.status !== "connected" ? <>
      <p><strong>이 단계에서 시연 지갑 연결이 필요해요</strong><br />현재 시연은 브라우저 지갑에서 거래를 직접 승인합니다. 지갑 연결은 로그인이나 본인 확인을 대신하지 않습니다.</p>
      {w.available.length ? <div className="actions">{w.available.map((d) => <Button key={d.id} variant="secondary" disabled={disabled || w.status === "connecting"} busy={w.status === "connecting"} onClick={() => w.connect(d.id)}>{d.name} 연결</Button>)}</div>
        : <p role="status">브라우저 지갑을 찾지 못했습니다. MetaMask 등 시연 계정을 가져온 지갑이 설치된 브라우저에서 열어 주세요.</p>}
    </> : !w.onExpectedChain ? <>
      <p role="alert">현재 연결된 네트워크에서는 진행할 수 없습니다. 시연 네트워크로 변경해 주세요.</p>
      <Button disabled={disabled} onClick={() => w.switchChain()}>시연 네트워크로 변경</Button>
    </> : mismatch || !w.matchesOrganization ? <p role="alert">현재 업체의 승인 지갑이 아닙니다. 지갑 앱에서 {shortAddress(expectedFrom)} 계정으로 바꿔 주세요.</p>
      : <p>시연 지갑이 연결되었습니다. 아래 내용을 확인하고 지갑 창에서 승인해 주세요.</p>}
    {w.failure && <p className="bad" role="alert">{walletFailureMessage[w.failure]}</p>}
  </div>;
}
