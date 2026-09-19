"use client";
import Link from "next/link";
import { transactionLink } from "@/lib/chain-config";
import { use, useCallback, useState } from "react";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useAction, useLoad } from "@/lib/use-load";
import { useOperation } from "@/lib/use-operation";
import { daysUntil, formatDate, formatDateTime, formatKrw, formatTokenRaw, krwDifference, shortAddress, shortHash } from "@/lib/format";
import { eventLabel, offerLabel, receivableLabel, reviewLabel, supplementLabel } from "@/lib/labels";
import { ROLE_HOME } from "@/components/app-shell";
import { TransactionPanel } from "@/components/transaction-panel";
import { Button, Card, Chip, ErrorBox, Facts, Hero, Loading, Notice, PageHead } from "@/components/ui";

export interface Offer { id: string; offer_id: string; approval_id: string | null; purchase_amount: string; expires_at: string; status: string; effective_status: string; bank_address: string; created_tx_hash: string }
export interface ReceivableState { id: string; title: string; trade_reference: string; supplier_name: string; buyer_name: string; bank_name: string; face_amount: string; due_at: string; chain_status: string; overdue: boolean;
  token_id: string; supplier_address: string; payer_address: string; bank_address: string | null; registration_tx_hash: string | null; registered_at: string | null; purchased_at: string | null; repaid_at: string | null; synced_at: string | null;
  bankReview?: { id: string; status: string; public_message: string | null }; offers: Offer[];
  supplements: { id: string; request: string; status: string; response: string | null; created_at: string }[];
  events: { event_type: string; tx_hash: string; block_number: string; occurred_at: string; payload: Record<string, string> }[] }

export default function ReceivableDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { role, chain } = useSession();
  const detail = useLoad<ReceivableState>(`/receivables/${id}`, 4000);
  const reload = detail.reload;
  const tx = useOperation(id, useCallback(() => { void reload(); }, [reload]));
  if (detail.loading) return <Loading />;
  if (detail.error || !detail.data) return <ErrorBox code={detail.error} onRetry={detail.reload} />;
  const r = detail.data;
  const live = r.offers.find((o) => o.effective_status === "ACTIVE");
  const accepted = r.offers.find((o) => o.status === "ACCEPTED");
  const holder = r.chain_status === "PURCHASED" || r.chain_status === "REPAID" ? r.bank_name : r.supplier_name;
  const next = role === "supplier" ? (r.chain_status === "REGISTERED" ? (live?.approval_id ? "은행 조건을 확인하고 먼저받기" : r.supplements.some((s) => s.status === "REQUESTED") ? "은행 보완 요청에 답변" : r.bankReview?.status === "DECLINED" ? "은행이 매입하지 않기로 했습니다" : "은행 검토·조건 기다리기")
      : r.chain_status === "PURCHASED" ? "모의 지급 완료 · 구매처가 만기에 은행에 상환" : "완료된 거래")
    : role === "buyer" ? (r.chain_status === "PURCHASED" ? `${r.bank_name}에 액면 전액 상환` : r.chain_status === "REGISTERED" ? "은행 매입 전 · 상환 대상 아님" : "완료된 거래")
    : (r.chain_status === "REGISTERED" ? "검토 화면에서 판단·조건 제시" : r.chain_status === "PURCHASED" ? "구매처 상환 대기" : "완료된 거래");
  const back = role ? { href: role === "supplier" ? "/receivables" : role === "buyer" ? "/repayments" : "/portfolio", label: "목록" } : { href: ROLE_HOME.supplier, label: "목록" };

  return (<>
    <PageHead title={r.title} subtitle={<>{r.trade_reference} · {r.supplier_name} → {r.buyer_name}</>} back={back} />
    <Hero label={role === "buyer" ? "상환할 금액 (액면 전액)" : "채권 액면"} amount={formatKrw(r.face_amount)} meta={<>만기 {formatDate(r.due_at)} · {daysUntil(r.due_at)} · 현재 보유 {holder}</>} next={next}>
      {r.overdue ? <Chip label={{ text: "연체 · 미상환", tone: "bad" }} /> : <Chip label={receivableLabel(r.chain_status)} />}</Hero>

    {role !== "bank" && <TransactionPanel tx={tx} />}

    {role === "supplier" && r.chain_status === "REGISTERED" && <SupplierOffer r={r} live={live} tx={tx} />}
    {role === "supplier" && r.supplements.length > 0 && <Supplements r={r} onDone={detail.reload} />}
    {role === "supplier" && accepted && r.chain_status !== "REGISTERED" && (<Card title="모의 지급 완료"><Facts items={[["받은 금액 (모의 토큰)", formatKrw(accepted.purchase_amount)],
      ["액면과의 차액", krwDifference(r.face_amount, accepted.purchase_amount)], ["새 채권 보유", r.bank_name], ["매입 시각", formatDateTime(r.purchased_at)]]} />
      <p className="muted">모의 토큰 지급이며 실제 원화 지급이 아닙니다. 차액은 예시이며 금리·수수료가 아닙니다.</p></Card>)}

    {role === "buyer" && (r.chain_status === "PURCHASED" ? (<Card title="전액 상환" tone="accent">
        <Facts items={[["모의 상환 금액", `${formatKrw(r.face_amount)} 상당 (모의)`], ["수취 기관", r.bank_name]]} />
        <p className="muted">매입 당시 금액이 아닌 액면 전액을 상환합니다. 모의 토큰 거래이며 실제 은행 계좌에서 출금되지 않습니다. 토큰 사용 승인 → 상환 거래 순서로 서명합니다.</p>
        <details className="technical-details" data-testid="repayment-wallet-details"><summary>상환 지갑·토큰 상세</summary>
          <Facts items={[["수취 지갑", shortAddress(r.bank_address)], ["사용 토큰", "모의 결제 토큰 (mKRW, 시연용)"], ["서명 지갑", shortAddress(r.payer_address)]]} />
        </details>
        <div className="actions"><Button onClick={() => tx.start("REPAY")} disabled={tx.open} busy={tx.phase === "preparing"} data-testid="start-repay">모의 상환 시작</Button></div></Card>)
      : r.chain_status === "REPAID" ? <Notice tone="good">{formatDateTime(r.repaid_at)} 액면 전액을 상환해 채권이 종결되었습니다.</Notice>
      : r.chain_status === "REGISTERED" ? <Notice>아직 은행이 매입하지 않은 채권입니다. 매입 전에는 상환 대상이 아닙니다.</Notice> : null)}

    {role === "bank" && r.bankReview && <Card title="은행 검토" aside={<Chip label={reviewLabel(r.bankReview.status)} />}>
      <div className="actions"><Link className="btn btn-primary" href={`/bank/reviews/${r.bankReview.id}`}>검토·조건 화면 열기</Link></div></Card>}

    {role !== "bank" && r.bankReview && <Card title="은행 검토 상태" aside={<Chip label={reviewLabel(r.bankReview.status)} />}>
      {r.bankReview.public_message && ["NEEDS_INFO", "DECLINED"].includes(r.bankReview.status) ? <p>은행 안내: {r.bankReview.public_message}</p> : <p className="muted">은행의 내부 검토 내용은 공개되지 않습니다. 공개 결과만 표시됩니다.</p>}</Card>}

    <details className="card technical-details" data-testid="offer-history"><summary>이전 조건과 등록 기록 보기</summary>{r.offers.length ? <div className="table-wrap"><table className="table"><thead><tr><th>매입 금액</th><th>유효기간</th><th>상태</th><th>등록 거래</th></tr></thead><tbody>
      {r.offers.map((o) => <tr key={o.id}><td>{formatKrw(o.purchase_amount)}</td><td>{formatDateTime(o.expires_at)}</td><td><Chip label={offerLabel(o.effective_status)} />{!o.approval_id && " · 미승인 참조"}</td>
        <td className="mono" title={o.created_tx_hash}>{transactionLink(chain?.chainId, o.created_tx_hash) ? <a href={transactionLink(chain?.chainId, o.created_tx_hash)!} target="_blank" rel="noreferrer">{shortHash(o.created_tx_hash)}</a> : shortHash(o.created_tx_hash)}</td></tr>)}</tbody></table></div> : <p className="muted">등록된 조건이 없습니다.</p>}</details>

    <details className="card"><summary>온체인 기록 · 상세</summary>
      <Facts items={[["토큰 ID", <span key="t" className="mono">{shortHash(r.token_id)}</span>], ["등록 거래", <span key="h" className="mono" title={r.registration_tx_hash ?? ""}>{shortHash(r.registration_tx_hash)}</span>],
        ["등록 시각", formatDateTime(r.registered_at)], ["납품업체 지갑", shortAddress(r.supplier_address)], ["구매처(지급) 지갑", shortAddress(r.payer_address)], ["은행 지갑", shortAddress(r.bank_address)], ["원장 동기화", formatDateTime(r.synced_at)]]} />
      {r.events.length ? <ol className="timeline">{r.events.map((e, i) => <li key={i}><strong>{eventLabel[e.event_type] ?? e.event_type}</strong>
        <span className="muted">{formatDateTime(e.occurred_at)} · 블록 {e.block_number} · <span className="mono" title={e.tx_hash}>{transactionLink(chain?.chainId, e.tx_hash) ? <a href={transactionLink(chain?.chainId, e.tx_hash)!} target="_blank" rel="noreferrer">{shortHash(e.tx_hash)}</a> : shortHash(e.tx_hash)}</span>{e.payload?.amountRaw ? ` · ${formatTokenRaw(e.payload.amountRaw)}` : ""}</span></li>)}</ol>
        : <p className="muted">결제 이벤트가 아직 없습니다.</p>}
      {role === "supplier" && r.chain_status === "REGISTERED" && <div className="actions"><Button variant="danger" disabled={tx.open} onClick={() => { if (confirm("등록을 취소하면 이 거래번호로는 다시 등록할 수 없습니다. 계속할까요?")) void tx.start("CANCEL"); }} data-testid="start-cancel">채권 등록 취소</Button></div>}
    </details>
  </>);
}

function SupplierOffer({ r, live, tx }: { r: ReceivableState; live?: Offer; tx: ReturnType<typeof useOperation> }) {
  if (!live) return <Card title="은행 조건"><p className="muted">{r.bankReview?.status === "DECLINED" ? "은행이 이 채권을 매입하지 않기로 했습니다." : "아직 유효한 조건이 없습니다. 은행이 검토를 마치고 조건을 등록하면 여기에 표시됩니다."}</p></Card>;
  return (<Card title={<>{r.bank_name}의 조건</>} aside={<Chip label={offerLabel(live.effective_status)} />} tone="accent">
    <div className="offer"><div><span>지금 받을 금액 (모의)</span><strong data-testid="offer-amount">{formatKrw(live.purchase_amount)}</strong></div>
      <div><span>액면</span><strong>{formatKrw(r.face_amount)}</strong></div><div><span>차액</span><strong>{krwDifference(r.face_amount, live.purchase_amount)}</strong></div></div>
    <p className="muted">유효기간 {formatDateTime(live.expires_at)} · 별도 플랫폼 수수료 없음 · 차액은 예시이며 실제 금리가 아닙니다. 수락하면 채권이 은행으로 이전되고 모의 토큰이 같은 거래에서 지급됩니다.</p>
    {!live.approval_id ? <Notice tone="bad">은행 승인 기록과 연결되지 않은 조건이라 수락할 수 없습니다.</Notice>
      : <div className="actions"><Button onClick={() => tx.start("ACCEPT_OFFER", { offerId: live.id })} disabled={tx.open} busy={tx.phase === "preparing"} data-testid="start-accept">이 조건으로 먼저받기</Button></div>}
  </Card>);
}

function Supplements({ r, onDone }: { r: ReceivableState; onDone(): void }) {
  const action = useAction(); const [text, setText] = useState("");
  return (<Card title="은행 보완 요청">{r.supplements.map((s) => (<div key={s.id} className="supplement">
    <div className="card-head"><strong>{formatDateTime(s.created_at)} 요청</strong><Chip label={supplementLabel(s.status)} /></div><p>{s.request}</p>
    {s.response && <p className="muted">내 답변: {s.response}</p>}
    {s.status === "REQUESTED" && <><label>답변 (추가 파일 업로드는 아직 지원하지 않습니다)<textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} data-testid="supplement-response" /></label>
      <ErrorBox code={action.error} />
      <div className="actions"><Button disabled={!text.trim()} busy={!!action.pending} data-testid="supplement-submit"
        onClick={() => action.run("respond", async () => { await api(`/supplements/${s.id}/response`, { response: text.trim() }); setText(""); onDone(); })}>답변 제출</Button></div></>}</div>))}</Card>);
}
