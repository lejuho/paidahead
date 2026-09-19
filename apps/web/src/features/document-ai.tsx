"use client";
import { useState } from "react";
import { api, codeOf } from "@/lib/api";
import { formatKrw, formatDateTime } from "@/lib/format";
import { Button, Card, Notice } from "@/components/ui";

type Analysis = { provider: string; model: string; analyzedAt: string; revision: number; summary: string;
  documents: { documentId: string; amountKrw: string | null; dueDate: string | null; evidence: string; note: string;
    items: { name: string; quantity: string | null; unitPriceKrw: string | null }[] }[];
  checks: { status: "MATCH" | "CHECK"; message: string }[] };
const names: Record<string, string> = { PURCHASE_ORDER: "발주서", DELIVERY_NOTE: "납품서", INVOICE: "청구서" };
const errors: Record<string, string> = {
  AI_NOT_CONFIGURED: "AI 연결이 아직 설정되지 않았습니다. 시연 담당자가 서버 API 키를 설정해야 합니다. 아래 수동 검토는 계속할 수 있습니다.",
  AI_AUTH_FAILED: "AI 인증에 실패했습니다. 시연 담당자가 API 키와 이용 권한을 확인해야 합니다.",
  AI_RATE_LIMITED: "AI 사용 한도에 도달했습니다. 잠시 후 다시 시도하거나 수동으로 검토해 주세요.",
  AI_BUSY: "분석 요청을 처리 중이거나 재요청 대기 중입니다. 20초 뒤 다시 시도해 주세요.",
  AI_TIMEOUT: "분석 응답 시간이 초과되었습니다. 자동으로 재호출하지 않습니다. 다시 시도하거나 수동으로 검토해 주세요.",
  AI_INVALID_RESULT: "AI 응답이 불완전하거나 원문 근거를 확인할 수 없어 결과를 표시하지 않았습니다. 다시 시도하거나 수동으로 검토해 주세요.",
  AI_DEMO_DOCUMENTS_ONLY: "이 분석은 준비된 가상 서류 3종만 지원합니다.",
  REVISION_CONFLICT: "신청 버전이 바뀌었습니다. 화면을 새로고침한 뒤 다시 분석해 주세요.",
};
export function DocumentAi({ id, revision }: { id: string; revision: number }) {
  const [result, setResult] = useState<Analysis | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function analyze() {
    if (pending) return;
    setPending(true); setError(""); setResult(null);
    try { setResult(await api<Analysis>(`/applications/${id}/analysis`, { expectedRevision: revision })); }
    catch (e) { setError(errors[codeOf(e)] ?? "AI 분석을 완료하지 못했습니다. 다시 시도하거나 수동으로 검토해 주세요."); }
    finally { setPending(false); }
  }
  return <Card title="AI 서류 비교" aside={<span className="demo-tag">가상 서류 전용</span>}>
    <p>버튼을 누르면 준비된 가상 발주서·납품서·청구서의 텍스트를 OpenAI로 보내 실제 분석합니다. 실제 고객 서류·직접 입력한 신청 내용은 보내지 않습니다.</p>
    <p className="muted">파일 업로드·사진 인식 기능은 아닙니다. AI는 검토를 돕고, 구매처 확인이나 지급을 승인하지 않습니다.</p>
    <Button onClick={analyze} disabled={pending} busy={pending} data-testid="analyze-documents">{result ? "다시 분석하기" : "가상 서류 3종 분석하기"}</Button>
    {pending && <p role="status">서류의 금액·지급일·품목을 비교하고 있습니다…</p>}
    {error && <div role="alert" data-testid="ai-error"><Notice tone="wait">{error}</Notice></div>}
    {result && <div data-testid="ai-result">
      <p role="status"><strong>외부 AI 분석 완료</strong> · {result.provider} / {result.model} · {formatDateTime(result.analyzedAt)} · 신청 버전 {result.revision}</p>
      <p>서류 {result.documents.length}종의 추출값을 점검했습니다. 확인 필요 {result.checks.filter(c => c.status === "CHECK").length}개 항목은 원문과 대조해 주세요.</p>
      <Notice>AI 추출값은 틀릴 수 있습니다. 아래 근거와 서류 원문을 확인하고 수동 검토를 완료해 주세요. 분석 결과는 자동으로 신청에 반영되지 않으며 새로고침하면 사라집니다.</Notice>
      {result.checks.map((c, i) => <p key={i} className={c.status === "MATCH" ? "good" : "bad"}>{c.status === "MATCH" ? "일치" : "확인 필요"} · {c.message.replace(/PURCHASE_ORDER|DELIVERY_NOTE|INVOICE/g, x => names[x] ?? x)}</p>)}
      {result.documents.map(d => <details key={d.documentId} className="technical-details"><summary>{names[d.documentId] ?? d.documentId} · {d.amountKrw === null ? "금액 확인 필요" : formatKrw(d.amountKrw)}</summary>
        <p>지급일: {d.dueDate ?? "구체적인 날짜 없음"}</p>
        {d.items.map((item, i) => <p key={i}>{item.name} · 수량 {item.quantity ?? "미기재"} · 단가 {item.unitPriceKrw === null ? "미기재" : formatKrw(item.unitPriceKrw)}</p>)}
        <blockquote style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{d.evidence}</blockquote><p>{d.note}</p>
      </details>)}
    </div>}
  </Card>;
}
