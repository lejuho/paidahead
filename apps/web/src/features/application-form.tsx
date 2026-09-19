"use client";
import { useState } from "react";
import { useLoad, useAction } from "@/lib/use-load";
import { formatKrw, normalizeKrwInput } from "@/lib/format";
import { documentType } from "@/lib/labels";
import { Button, Card, DemoTag, ErrorBox, Loading, Notice } from "@/components/ui";

interface Catalog { organizations: { id: string; display_name: string; kind: string }[]; documents: { id: string; document_type: string; original_filename: string }[] }
export interface ApplicationInput { buyerOrgId: string; targetBankOrgId: string; tradeReference: string; title: string; faceAmountKrw: string; dueAt: string; documentIds: string[] }
const kstDate = (iso: string) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date(iso));

export function ApplicationForm({ initial, submitLabel, onSubmit }: { initial?: Partial<ApplicationInput>; submitLabel: string; onSubmit(input: ApplicationInput): Promise<void> }) {
  const catalog = useLoad<Catalog>("/demo/catalog");
  const action = useAction();
  const [title, setTitle] = useState(initial?.title ?? "가상 식자재 납품");
  const [reference, setReference] = useState(initial?.tradeReference ?? `INV-DEMO-${Date.now().toString().slice(-6)}`);
  const [amount, setAmount] = useState(initial?.faceAmountKrw ?? "3000000");
  const [due, setDue] = useState(kstDate(initial?.dueAt ?? new Date(Date.now() + 30 * 86400000).toISOString()));
  const [buyer, setBuyer] = useState(initial?.buyerOrgId ?? "");
  const [picked, setPicked] = useState<string[] | null>(initial?.documentIds ?? null);
  if (catalog.loading) return <Loading />;
  if (catalog.error || !catalog.data) return <ErrorBox code={catalog.error} onRetry={catalog.reload} />;
  const buyers = catalog.data.organizations.filter((o) => o.kind === "BUYER"), bank = catalog.data.organizations.find((o) => o.kind === "BANK");
  const documents = picked ?? catalog.data.documents.map((d) => d.id);
  const krw = normalizeKrwInput(amount), buyerId = buyer || buyers[0]?.id;
  const types = new Set(catalog.data.documents.filter((d) => documents.includes(d.id)).map((d) => d.document_type));
  const problem = !title.trim() || !reference.trim() ? "거래명과 거래번호를 입력하세요." : !krw ? "금액은 1원 이상의 정수로 입력하세요."
    : !due || Date.parse(`${due}T23:59:59+09:00`) <= Date.now() ? "만기는 오늘 이후 날짜여야 합니다." : !buyerId || !bank ? "구매처·은행 조직이 없습니다. seed를 확인하세요."
    : types.size !== 3 ? "발주서·납품서·청구서를 각각 1개 이상 선택하세요." : null;
  return (<form className="form" onSubmit={(e) => { e.preventDefault(); if (!problem) void action.run("submit", () => onSubmit({ buyerOrgId: buyerId!, targetBankOrgId: bank!.id,
      tradeReference: reference.trim(), title: title.trim(), faceAmountKrw: krw!, dueAt: `${due}T23:59:59+09:00`, documentIds: documents })); }}>
    <Card title="거래 정보">
      <label>거래명<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required /></label>
      <label>거래번호 (청구서 번호)<input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} required /></label>
      <div className="grid-2">
        <label>받을 금액 (원)<input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} aria-describedby="amount-help" required />
          <small id="amount-help">{krw ? formatKrw(krw) : "숫자만 입력"}</small></label>
        <label>지급 만기일<input type="date" value={due} onChange={(e) => setDue(e.target.value)} required /><small>한국시간 해당일 23:59:59 기준</small></label></div>
      <div className="grid-2">
        <label>구매처<select value={buyerId} onChange={(e) => setBuyer(e.target.value)}>{buyers.map((o) => <option key={o.id} value={o.id}>{o.display_name}</option>)}</select></label>
        <label>매입 검토 은행<input value={bank?.display_name ?? "-"} readOnly /></label></div>
    </Card>
    <Card title="증빙 서류" aside={<DemoTag>가상 서류 사용 · 신청 후 AI 비교 가능 · 파일 업로드 미지원</DemoTag>}>
      {catalog.data.documents.map((d) => (<label key={d.id} className="check"><input type="checkbox" checked={documents.includes(d.id)}
        onChange={(e) => setPicked(e.target.checked ? [...documents, d.id] : documents.filter((x) => x !== d.id))} />
        <span><b>{documentType[d.document_type] ?? d.document_type}</b> {d.original_filename}</span></label>))}
    </Card>
    {problem && <Notice tone="wait">{problem}</Notice>}
    <ErrorBox code={action.error} />
    <div className="actions"><Button type="submit" busy={!!action.pending} disabled={!!problem} data-testid="application-submit">{submitLabel}</Button></div>
  </form>);
}
