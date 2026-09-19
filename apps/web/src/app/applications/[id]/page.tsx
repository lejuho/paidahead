"use client";
import Link from "next/link";
import { use, useState } from "react";
import { api } from "@/lib/api";
import { useAction, useLoad } from "@/lib/use-load";
import { daysUntil, formatDate, formatDateTime, formatKrw, groupDigits, multiplyKrw, normalizeKrwInput, shortHash } from "@/lib/format";
import { confirmationLabel, registrationLabel } from "@/lib/labels";
import { applicationStage } from "@/features/stage";
import { ApplicationForm } from "@/features/application-form";
import { DocumentList, type DocumentMeta } from "@/features/documents";
import { Button, Card, Chip, ErrorBox, Facts, Hero, Loading, Notice, PageHead, Progress } from "@/components/ui";

interface Detail { id: string; version: number; title: string; trade_reference: string; confirmed_amount: string; confirmed_due_at: string; status: string; frozen_at: string | null;
  buyer_org_id: string; target_bank_org_id: string; buyer_name: string; bank_name: string; confirmed_fields: { items: { name: string; quantity: number; unitPriceKrw: string }[]; note: string } | null;
  confirmation: { id: string; status: string; requested_at: string; confirmed_at: string | null; rejection_reason: string | null } | null; documents: DocumentMeta[] }
interface Registration { status: string; failure_code?: string | null; receivable_id?: string | null; chain_status?: string | null; registration_tx_hash?: string | null; token_id?: string | null }

export default function ApplicationDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const detail = useLoad<Detail>(`/applications/${id}`, 4000);
  const registration = useLoad<Registration>(`/applications/${id}/registration`, 2500);
  const action = useAction();
  const [revising, setRevising] = useState(false);
  if (detail.loading) return <Loading />;
  if (detail.error || !detail.data) return <ErrorBox code={detail.error} onRetry={detail.reload} />;
  const a = detail.data, cf = a.confirmation, reg = registration.data;
  const stage = applicationStage({ id, revision_status: a.status, confirmation_status: cf?.status ?? null, registration_status: reg && reg.status !== "CONFIRMATION_REQUIRED" ? reg.status : null,
    receivable_id: reg?.receivable_id ?? null, chain_status: reg?.chain_status ?? null });
  const refresh = () => { void detail.reload(); void registration.reload(); };
  const state = (n: number) => (stage.step > n ? "done" : stage.step === n ? (cf?.status === "REJECTED" || reg?.status === "FAILED" ? "failed" : "active") : "todo") as "done" | "active" | "todo" | "failed";
  const needsRevision = cf && ["REJECTED", "WITHDRAWN"].includes(cf.status);

  return (<>
    <PageHead title={a.title} subtitle={<>{a.trade_reference} · 버전 {a.version} · 구매처 {a.buyer_name}</>} back={{ href: "/applications", label: "내 신청" }} />
    <Hero label="받을 돈 (액면)" amount={formatKrw(a.confirmed_amount)} meta={<>만기 {formatDate(a.confirmed_due_at)} · {daysUntil(a.confirmed_due_at)}</>} next={stage.next}><Chip label={stage.label} /></Hero>
    <Progress steps={[{ title: "서류 제출·검토", state: state(1) }, { title: "구매처 확인", state: state(2), note: cf ? confirmationLabel(cf.status).text : undefined },
      { title: "채권 등록", state: state(3), note: reg && reg.status !== "CONFIRMATION_REQUIRED" ? registrationLabel(reg.status).text : undefined }, { title: "은행 조건 · 먼저받기", state: state(4) }]} />
    <ErrorBox code={action.error} />

    {revising ? (<Card title="보완 후 새 버전 만들기"><Notice>새 버전을 만들면 이전 확인 요청은 무효가 되고, 서류 검토와 구매처 확인을 다시 받아야 합니다.</Notice>
      <ApplicationForm submitLabel={`버전 ${a.version + 1} 저장`} initial={{ buyerOrgId: a.buyer_org_id, targetBankOrgId: a.target_bank_org_id, tradeReference: a.trade_reference, title: a.title,
        faceAmountKrw: a.confirmed_amount, dueAt: a.confirmed_due_at, documentIds: a.documents.map((d) => d.id) }}
        onSubmit={async (input) => { await api(`/applications/${id}/revisions`, { ...input, expectedRevision: a.version }); setRevising(false); refresh(); }} />
      <Button variant="ghost" onClick={() => setRevising(false)}>취소</Button></Card>)
    : a.status !== "REVIEW_COMPLETED" ? <ReviewForm detail={a} onDone={refresh} />
    : !cf ? <RequestConfirmation detail={a} onDone={refresh} />
    : cf.status === "PENDING" ? (<Card title="구매처 확인을 기다리는 중" aside={<Chip label={confirmationLabel(cf.status)} />}>
        <p>{a.buyer_name}에 {formatDateTime(cf.requested_at)} 확인을 요청했습니다. 구매처가 납품 사실과 지급 의무를 확인하면 채권 등록이 자동으로 이어집니다.</p>
        <div className="actions"><Button variant="secondary" busy={action.pending === "withdraw"} data-testid="withdraw-confirmation"
          onClick={() => action.run("withdraw", async () => { await api(`/confirmations/${cf.id}/withdraw`, {}); refresh(); })}>요청 철회</Button></div></Card>)
    : needsRevision ? (<Card title={cf.status === "REJECTED" ? "구매처가 반려했습니다" : "확인 요청을 철회했습니다"} aside={<Chip label={confirmationLabel(cf.status)} />}>
        {cf.rejection_reason && <Notice tone="bad">반려 사유: {cf.rejection_reason}</Notice>}
        <p>다시 요청하려면 내용을 보완한 새 버전을 만들고 서류 검토를 다시 완료해야 합니다.</p>
        <div className="actions"><Button onClick={() => setRevising(true)} data-testid="revise">보완 후 다시 요청</Button></div></Card>)
    : cf.status === "CONFIRMED" ? (<Card title="채권 등록" aside={reg && <Chip label={registrationLabel(reg.status)} />}>
        <p>구매처가 {formatDateTime(cf.confirmed_at)} 확인했습니다. 구매처 확인과 온체인 등록은 별개이며, 등록 워커가 영수증과 이벤트를 검증해야 등록이 완료됩니다.</p>
        {registration.error && <ErrorBox code={registration.error} onRetry={registration.reload} />}
        {reg?.status === "CONFIRMED" && reg.receivable_id ? (<><Facts items={[["토큰 ID", <span key="t" className="mono">{shortHash(reg.token_id)}</span>], ["등록 거래", <span key="h" className="mono" title={reg.registration_tx_hash ?? ""}>{shortHash(reg.registration_tx_hash)}</span>]]} />
          <div className="actions"><Link className="btn btn-primary" href={`/receivables/${reg.receivable_id}`} data-testid="open-receivable">은행 조건·먼저받기 화면으로</Link></div></>)
        : reg?.status === "FAILED" ? (<><Notice tone="bad">등록에 실패했습니다{reg.failure_code ? ` (${reg.failure_code})` : ""}.</Notice>
          <div className="actions"><Button busy={action.pending === "retry"} onClick={() => action.run("retry", async () => { await api(`/applications/${id}/registration/retry`, {}); refresh(); })}>등록 재시도</Button></div></>)
        : <Notice tone="wait">등록 처리 중입니다. 등록 워커(`npm run worker:start`)가 실행 중이어야 하며, 이 화면은 자동으로 갱신됩니다.</Notice>}</Card>)
    : <Notice>이전 버전의 확인 요청은 무효가 되었습니다. 현재 버전으로 다시 진행하세요.</Notice>}

    {a.confirmed_fields && <Card title="검토한 품목"><table className="table"><thead><tr><th>품목</th><th>수량</th><th>단가</th><th>금액</th></tr></thead><tbody>
      {a.confirmed_fields.items.map((item, i) => <tr key={i}><td>{item.name}</td><td>{groupDigits(String(item.quantity))}</td><td>{formatKrw(item.unitPriceKrw)}</td>
        <td>{formatKrw(BigInt(item.quantity) * BigInt(item.unitPriceKrw))}</td></tr>)}</tbody></table><p className="muted">검토 메모: {a.confirmed_fields.note}</p></Card>}
    <Card title="제출 서류"><DocumentList documents={a.documents} /></Card>
  </>);
}

function ReviewForm({ detail, onDone }: { detail: Detail; onDone(): void }) {
  const action = useAction();
  const [items, setItems] = useState([{ name: "식자재 세트", quantity: "100", unitPriceKrw: "30000" }]);
  const [note, setNote] = useState("시연 서류 수동 검토 완료");
  const totals = items.map((i) => multiplyKrw(i.quantity, i.unitPriceKrw));
  const total = totals.every((t) => t !== null) ? totals.reduce<bigint>((sum, t) => sum + t!, 0n) : null;
  const matches = total !== null && total.toString() === detail.confirmed_amount;
  const update = (index: number, patch: Partial<(typeof items)[number]>) => setItems(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  return (<Card title="1. 서류 검토" aside={<span className="demo-tag">AI 분석 대신 수동 검토 (시연)</span>}>
    <p>서류의 품목을 입력해 합계가 신청 금액 {formatKrw(detail.confirmed_amount)}과 같은지 확인하세요.</p>
    {items.map((item, i) => (<div key={i} className="item-row">
      <label>품목<input value={item.name} onChange={(e) => update(i, { name: e.target.value })} maxLength={200} /></label>
      <label>수량<input inputMode="numeric" value={item.quantity} onChange={(e) => update(i, { quantity: e.target.value.replace(/\D/g, "") })} /></label>
      <label>단가 (원)<input inputMode="numeric" value={item.unitPriceKrw} onChange={(e) => update(i, { unitPriceKrw: e.target.value.replace(/\D/g, "") })} /></label>
      {items.length > 1 && <button type="button" className="link" onClick={() => setItems(items.filter((_, x) => x !== i))}>삭제</button>}</div>))}
    <button type="button" className="link" onClick={() => setItems([...items, { name: "", quantity: "1", unitPriceKrw: "" }])}>+ 품목 추가</button>
    <p className={matches ? "good" : "bad"} data-testid="item-total">품목 합계 {total === null ? "-" : formatKrw(total)} {matches ? "· 신청 금액과 일치" : "· 신청 금액과 다름"}</p>
    <label>검토 메모<textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={2} /></label>
    <ErrorBox code={action.error} />
    <div className="actions"><Button busy={!!action.pending} disabled={!matches || !note.trim() || items.some((i) => !i.name.trim())} data-testid="complete-review"
      onClick={() => action.run("review", async () => { await api(`/applications/${detail.id}/review`, { expectedRevision: detail.version, note: note.trim(),
        items: items.map((i) => ({ name: i.name.trim(), quantity: Number(i.quantity), unitPriceKrw: normalizeKrwInput(i.unitPriceKrw)! })) }); onDone(); })}>검토 완료</Button></div>
  </Card>);
}

function RequestConfirmation({ detail, onDone }: { detail: Detail; onDone(): void }) {
  const action = useAction(); const [consent, setConsent] = useState(false);
  return (<Card title="2. 구매처에 확인 요청">
    <p>요청하면 이 버전의 금액·만기·서류가 고정되고, {detail.buyer_name}이(가) 확인하면 채권이 등록되어 {detail.bank_name}의 검토로 이어집니다.</p>
    <label className="check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="consent" />
      <span>위 내용이 사실이며, 구매처 확인 후 채권 등록과 은행 검토에 자료를 제공하는 데 동의합니다. (동의서 v1)</span></label>
    <ErrorBox code={action.error} />
    <div className="actions"><Button busy={!!action.pending} disabled={!consent} data-testid="request-confirmation"
      onClick={() => action.run("request", async () => { await api(`/applications/${detail.id}/confirmations`, { expectedRevision: detail.version, consent: true, consentVersion: "v1" }); onDone(); })}>구매처에 확인 요청</Button></div>
  </Card>);
}
