"use client";
import Link from "next/link";
import { use, useCallback, useState } from "react";
import { api } from "@/lib/api";
import { useAction, useLoad } from "@/lib/use-load";
import { useOperation } from "@/lib/use-operation";
import { daysUntil, formatDate, formatDateTime, formatKrw, groupDigits, krwDifference, localInputToIso, normalizeKrwInput, shortAddress, toLocalInput } from "@/lib/format";
import { offerLabel, receivableLabel, reviewAction, reviewLabel, supplementLabel } from "@/lib/labels";
import { DocumentList, type DocumentMeta } from "@/features/documents";
import { TransactionPanel } from "@/components/transaction-panel";
import { Button, Card, Chip, ErrorBox, Facts, Hero, Loading, Notice, PageHead } from "@/components/ui";
import type { ReceivableState } from "@/app/receivables/[id]/page";

interface Approval { id: string; purchase_amount: string; expires_at: string; created_at: string }
interface Review { id: string; status: string; version: number; internal_note: string | null; public_message: string | null;
  receivable: { id: string; face_amount: string; due_at: string; chain_status: string; bank_address: string; synced_at: string | null };
  revision: { title: string; trade_reference: string; confirmed_fields: { items: { name: string; quantity: number; unitPriceKrw: string }[]; note: string } | null };
  documents: DocumentMeta[]; approvals: Approval[];
  history: { id: string; action: string; internal_note: string | null; public_message: string | null; created_at: string }[];
  supplements: { id: string; request: string; status: string; response: string | null; created_at: string }[] }

export default function ReviewWorkspace({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const review = useLoad<Review>(`/bank/reviews/${id}`, 4000);
  if (review.loading) return <Loading />;
  if (review.error || !review.data) return <ErrorBox code={review.error} onRetry={review.reload} />;
  return <Workspace b={review.data} reloadReview={review.reload} />;
}

function Workspace({ b, reloadReview }: { b: Review; reloadReview(): void }) {
  const state = useLoad<ReceivableState>(`/receivables/${b.receivable.id}`, 4000);
  const reloadState = state.reload;
  const refresh = useCallback(() => { reloadReview(); void reloadState(); }, [reloadReview, reloadState]);
  const tx = useOperation(b.receivable.id, refresh);
  const action = useAction();
  const [note, setNote] = useState(""), [message, setMessage] = useState("");
  const [amount, setAmount] = useState(() => ((BigInt(b.receivable.face_amount) * 99n) / 100n).toString());
  const [expires, setExpires] = useState(() => toLocalInput(new Date(Math.min(Date.now() + 86400000, new Date(b.receivable.due_at).getTime() - 3600000))));
  const r = b.receivable, offers = state.data?.offers ?? [];
  const live = offers.find((o) => o.effective_status === "ACTIVE");
  const usedApprovals = new Set(offers.map((o) => o.approval_id));
  const pendingApproval = b.approvals.find((a) => !usedApprovals.has(a.id) && new Date(a.expires_at).getTime() > Date.now());
  const registered = r.chain_status === "REGISTERED";
  const decide = (kind: string, body: Record<string, unknown>) => action.run(kind, async () => {
    await api(`/bank/reviews/${b.id}/decision`, { expectedVersion: b.version, action: kind, ...body }); setNote(""); setMessage(""); refresh(); });
  const krw = normalizeKrwInput(amount), iso = localInputToIso(expires);
  const termsProblem = !krw ? "매입 금액을 원 단위 정수로 입력하세요." : BigInt(krw) > BigInt(r.face_amount) ? "매입 금액은 액면 이하여야 합니다."
    : !iso || Date.parse(iso) <= Date.now() ? "유효기간은 현재 이후여야 합니다." : Date.parse(iso) >= new Date(r.due_at).getTime() ? "유효기간은 채권 만기 이전이어야 합니다." : null;
  const next = !registered ? "기록 확인" : live ? "업체 수락 대기 (필요 시 철회)" : pendingApproval ? "은행 지갑으로 오퍼 등록" : ({ PENDING: "검토 시작", IN_REVIEW: "판단: 보완 요청 · 매입 불가 · 조건 승인",
    NEEDS_INFO: "업체 답변 확인 후 검토 재개", APPROVED_FOR_OFFER: "새 조건 승인 가능", DECLINED: "종결" } as Record<string, string>)[b.status];

  return (<>
    <PageHead title={b.revision.title} subtitle={<>{b.revision.trade_reference} · {state.data ? `${state.data.supplier_name} → ${state.data.buyer_name}` : ""}</>} back={{ href: "/bank/reviews", label: "검토 대기열" }} />
    <Hero label="채권 액면" amount={formatKrw(r.face_amount)} meta={<>만기 {formatDate(r.due_at)} · {daysUntil(r.due_at)} · 원장 동기화 {formatDateTime(r.synced_at)}</>} next={next}>
      <Chip label={reviewLabel(b.status)} /> <Chip label={receivableLabel(r.chain_status)} /></Hero>
    <TransactionPanel tx={tx} />
    <ErrorBox code={action.error} />
    <div className="split">
      <div>
        <Card title="검토 자료"><Facts items={[["구매처 확인", "확인 완료 · 등록된 스냅샷 기준"], ["검토 메모(업체)", b.revision.confirmed_fields?.note ?? "-"]]} />
          {b.revision.confirmed_fields && <table className="table"><thead><tr><th>품목</th><th>수량</th><th>단가</th></tr></thead><tbody>{b.revision.confirmed_fields.items.map((item, i) => (
            <tr key={i}><td>{item.name}</td><td>{groupDigits(String(item.quantity))}</td><td>{formatKrw(item.unitPriceKrw)}</td></tr>))}</tbody></table>}
          <DocumentList documents={b.documents} /></Card>
        {b.supplements.length > 0 && <Card title="보완 요청">{b.supplements.map((s) => (<div key={s.id} className="supplement">
          <div className="card-head"><strong>{formatDateTime(s.created_at)}</strong><Chip label={supplementLabel(s.status)} /></div><p>{s.request}</p>
          {s.response && <p>업체 답변: {s.response}</p>}
          {s.status === "SUBMITTED" && <div className="actions"><Button busy={action.pending === s.id} data-testid="supplement-close"
            onClick={() => action.run(s.id, async () => { await api(`/bank/supplements/${s.id}/close`, {}); refresh(); })}>답변 확인 · 검토 재개</Button></div>}</div>))}</Card>}
        <Card title="검토 이력" aside={<span className="demo-tag">은행 내부 전용</span>}>{b.history.length ? <ol className="timeline">{b.history.map((h) => (
          <li key={h.id}><strong>{reviewAction[h.action] ?? h.action}</strong><span className="muted">{formatDateTime(h.created_at)}</span>
            {h.internal_note && <p>내부: {h.internal_note}</p>}{h.public_message && <p>공개: {h.public_message}</p>}</li>))}</ol> : <p className="muted">아직 이력이 없습니다.</p>}</Card>
      </div>
      <div>
        {registered && b.status === "PENDING" && <Card title="검토 시작" tone="accent"><label>내부 메모 (선택 · 업체 비공개)<textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} /></label>
          <div className="actions"><Button busy={action.pending === "START"} data-testid="review-start" onClick={() => decide("START", note.trim() ? { internalNote: note.trim() } : {})}>검토 시작</Button></div></Card>}

        {registered && b.status === "IN_REVIEW" && <Card title="은행 판단">
          <label>내부 메모 (업체 비공개)<textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} data-testid="internal-note" /></label>
          <label>업체 공개 메시지 (보완 요청·매입 불가 시 필수)<textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} data-testid="public-message" /></label>
          <div className="actions">
            <Button variant="secondary" disabled={!note.trim()} busy={action.pending === "NOTE"} onClick={() => decide("NOTE", { internalNote: note.trim() })}>메모 저장</Button>
            <Button variant="secondary" disabled={!message.trim()} busy={action.pending === "REQUEST_INFO"} data-testid="request-info"
              onClick={() => decide("REQUEST_INFO", { publicMessage: message.trim(), ...(note.trim() ? { internalNote: note.trim() } : {}) })}>보완 요청</Button>
            <Button variant="danger" disabled={!message.trim()} busy={action.pending === "DECLINE"} data-testid="decline"
              onClick={() => { if (confirm("매입 불가로 종결하면 되돌릴 수 없습니다. 계속할까요?")) void decide("DECLINE", { publicMessage: message.trim(), ...(note.trim() ? { internalNote: note.trim() } : {}) }); }}>매입 불가</Button></div></Card>}

        {registered && ["IN_REVIEW", "APPROVED_FOR_OFFER"].includes(b.status) && !live && !pendingApproval && (<Card title="조건 승인" tone="accent">
          <div className="grid-2"><label>매입 금액 (원)<input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="purchase-amount" /><small>{krw ? formatKrw(krw) : "숫자만 입력"}</small></label>
            <label>제안 유효기간<input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} data-testid="offer-expiry" /><small>채권 만기 이전에 만료</small></label></div>
          <Facts items={[["액면", formatKrw(r.face_amount)], ["매입 금액", krw ? formatKrw(krw) : "-"], ["차액", krw && !termsProblem ? krwDifference(r.face_amount, krw) : "-"]]} />
          <p className="muted">차액은 예시 표시이며 금리가 아닙니다. 승인 기록은 변경할 수 없고, 승인 후 은행 지갑 서명으로 온체인에 등록해야 업체에 제시됩니다.</p>
          {termsProblem && <Notice tone="wait">{termsProblem}</Notice>}
          <div className="actions"><Button disabled={!!termsProblem} busy={action.pending === "approve"} data-testid="approve-terms"
            onClick={() => action.run("approve", async () => { await api(`/bank/reviews/${b.id}/approvals`, { expectedVersion: b.version, purchaseAmountKrw: krw, expiresAt: iso }); refresh(); })}>조건 승인</Button></div></Card>)}

        {registered && pendingApproval && !live && (<Card title="온체인 오퍼 등록" tone="accent">
          <Facts items={[["승인된 매입 금액", formatKrw(pendingApproval.purchase_amount)], ["유효기간", formatDateTime(pendingApproval.expires_at)], ["서명 지갑", shortAddress(r.bank_address)]]} />
          <p className="muted">토큰 사용 승인(매입 금액만큼) → 오퍼 등록 순서로 은행 승인 지갑이 서명합니다.</p>
          <div className="actions"><Button onClick={() => tx.start("CREATE_OFFER", { approvalId: pendingApproval.id })} disabled={tx.open} busy={tx.phase === "preparing"} data-testid="start-create-offer">오퍼 등록 시작</Button></div></Card>)}

        {live && (<Card title="제시 중인 조건" aside={<Chip label={offerLabel(live.effective_status)} />}>
          <Facts items={[["매입 금액", formatKrw(live.purchase_amount)], ["차액", krwDifference(r.face_amount, live.purchase_amount)], ["유효기간", formatDateTime(live.expires_at)]]} />
          {registered && <div className="actions"><Button variant="secondary" onClick={() => tx.start("WITHDRAW_OFFER", { offerId: live.id })} disabled={tx.open} data-testid="start-withdraw-offer">조건 철회</Button></div>}</Card>)}

        {b.status === "DECLINED" && <Notice tone="bad">매입 불가로 종결했습니다. 공개 사유: {b.public_message}</Notice>}
        {!registered && <Notice tone={r.chain_status === "REPAID" ? "good" : "info"}>채권 상태: {receivableLabel(r.chain_status).text}. <Link href={`/receivables/${r.id}`}>매입·상환 기록 보기</Link></Notice>}
        {b.internal_note && <Card title="최근 내부 메모" aside={<span className="demo-tag">은행 내부 전용</span>}><p>{b.internal_note}</p></Card>}
      </div>
    </div>
  </>);
}
