"use client";
import { use, useState } from "react";
import { api } from "@/lib/api";
import { useAction, useLoad } from "@/lib/use-load";
import { daysUntil, formatDate, formatDateTime, formatKrw, groupDigits } from "@/lib/format";
import { confirmationLabel } from "@/lib/labels";
import { DocumentList, type DocumentMeta } from "@/features/documents";
import { Button, Card, Chip, ErrorBox, Facts, Hero, Loading, Notice, PageHead } from "@/components/ui";

interface Detail { id: string; status: string; snapshot_hash: string; version: number; title: string; trade_reference: string; supplier_name: string; confirmed_amount: string; confirmed_due_at: string;
  requested_at: string; confirmed_at: string | null; rejected_at: string | null; rejection_reason: string | null; withdrawn_at: string | null;
  confirmed_fields: { items: { name: string; quantity: number; unitPriceKrw: string }[]; note: string } | null; documents: DocumentMeta[] }

export default function ConfirmationDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const detail = useLoad<Detail>(`/confirmations/${id}`, 5000);
  const action = useAction();
  const [delivery, setDelivery] = useState(false), [obligation, setObligation] = useState(false);
  const [rejecting, setRejecting] = useState(false), [reason, setReason] = useState("");
  if (detail.loading) return <Loading />;
  if (detail.error || !detail.data) return <ErrorBox code={detail.error} onRetry={detail.reload} />;
  const c = detail.data, pending = c.status === "PENDING";
  // The snapshot hash pins the decision to exactly the version shown on this screen.
  const decide = (body: Record<string, unknown>) => action.run(String(body.decision), async () => { await api(`/confirmations/${id}/decision`, { snapshotHash: c.snapshot_hash, ...body }); await detail.reload(); });
  return (<>
    <PageHead title={c.title} subtitle={<>{c.supplier_name} 요청 · {formatDateTime(c.requested_at)} · 확인 대상 버전 {c.version}</>} back={{ href: "/confirmations", label: "확인 요청" }} />
    <Hero label="확인하면 지급할 금액" amount={formatKrw(c.confirmed_amount)} meta={<>지급일 {formatDate(c.confirmed_due_at)} · {daysUntil(c.confirmed_due_at)}</>}
      next={pending ? "서류를 검토하고 확인 또는 반려" : c.status === "CONFIRMED" ? "은행이 매입하면 만기에 ‘상환’ 메뉴에서 전액 상환" : "추가 조치 없음"}><Chip label={confirmationLabel(c.status)} /></Hero>
    <Card title="신청 내용"><Facts items={[["납품업체", c.supplier_name], ["거래번호", c.trade_reference], ["지급 금액", formatKrw(c.confirmed_amount)], ["지급일", formatDate(c.confirmed_due_at)],
      ["확인 대상 해시", <span key="h" className="mono" title={c.snapshot_hash}>{c.snapshot_hash.slice(0, 18)}…</span>]]} />
      {c.confirmed_fields && <table className="table"><thead><tr><th>품목</th><th>수량</th><th>단가</th></tr></thead><tbody>{c.confirmed_fields.items.map((item, i) => (
        <tr key={i}><td>{item.name}</td><td>{groupDigits(String(item.quantity))}</td><td>{formatKrw(item.unitPriceKrw)}</td></tr>))}</tbody></table>}</Card>
    <Card title="증빙 서류"><DocumentList documents={c.documents} /></Card>
    <ErrorBox code={action.error} />
    {pending ? (<Card title="확인 또는 반려" tone="accent">
      <label className="check"><input type="checkbox" checked={delivery} onChange={(e) => setDelivery(e.target.checked)} data-testid="ack-delivery" /><span>위 품목을 실제로 <b>납품받았습니다</b>.</span></label>
      <label className="check"><input type="checkbox" checked={obligation} onChange={(e) => setObligation(e.target.checked)} data-testid="ack-obligation" />
        <span>{formatDate(c.confirmed_due_at)}까지 <b>{formatKrw(c.confirmed_amount)}</b>을 지급할 의무가 있음을 확인합니다. 은행이 채권을 매입하면 은행에 지급합니다.</span></label>
      <div className="actions"><Button disabled={!delivery || !obligation || !!action.pending} busy={action.pending === "CONFIRM"} data-testid="confirm"
        onClick={() => decide({ decision: "CONFIRM", deliveryAcknowledged: true, paymentObligationAcknowledged: true })}>확인</Button>
        <Button variant="secondary" disabled={!!action.pending} onClick={() => setRejecting(!rejecting)} data-testid="reject-open">반려</Button></div>
      {rejecting && <><label>반려 사유 (납품업체에 표시됩니다)<textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={2000} data-testid="reject-reason" /></label>
        <div className="actions"><Button variant="danger" disabled={!reason.trim()} busy={action.pending === "REJECT"} data-testid="reject" onClick={() => decide({ decision: "REJECT", reason: reason.trim() })}>반려 확정</Button></div></>}
      <p className="muted">확인 후에는 금액·만기·서류를 바꿀 수 없고 채권 등록이 자동으로 진행됩니다. 요청 철회는 납품업체만 할 수 있습니다.</p></Card>)
    : c.status === "CONFIRMED" ? <Notice tone="good">{formatDateTime(c.confirmed_at)} 확인했습니다. 채권 등록이 진행되며, 은행 매입 후에는 ‘상환’ 메뉴에 표시됩니다.</Notice>
    : c.status === "REJECTED" ? <Notice tone="bad">{formatDateTime(c.rejected_at)} 반려했습니다. 사유: {c.rejection_reason}</Notice>
    : c.status === "WITHDRAWN" ? <Notice>납품업체가 {formatDateTime(c.withdrawn_at)} 요청을 철회했습니다.</Notice>
    : <Notice>납품업체가 새 버전을 만들어 이 요청은 무효가 되었습니다.</Notice>}
  </>);
}
