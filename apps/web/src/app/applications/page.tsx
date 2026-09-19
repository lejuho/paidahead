"use client";
import Link from "next/link";
import { useLoad } from "@/lib/use-load";
import { formatDate, formatKrw, daysUntil } from "@/lib/format";
import { applicationStage, type ApplicationRow } from "@/features/stage";
import { applicationBucket } from "@/features/todo";
import { Grouped } from "@/components/grouped";
import { When } from "@/components/when";
import { Chip, ErrorBox, Loading, PageHead } from "@/components/ui";

type Row = ApplicationRow & { title: string; buyer_name: string; confirmed_amount: string; confirmed_due_at: string; version: number; updated_at: string };
export default function Applications() {
  const list = useLoad<Row[]>("/applications", 5000);
  const cta = <Link href="/applications/new" className="btn btn-primary" data-testid="new-application">새 먼저받기 신청</Link>;
  return (<><PageHead title="내 신청" subtitle="서류 제출 → 구매처 확인 → 조건 보고 먼저받기" action={cta} />
    {list.loading ? <Loading /> : list.error ? <ErrorBox code={list.error} onRetry={list.reload} />
      : <Grouped<Row> rows={list.data ?? []} bucket={applicationBucket} emptyTitle="아직 신청이 없습니다" emptyHint="납품 서류로 첫 신청을 만들어 보세요."
        render={(a, bucket) => { const stage = applicationStage(a); const href = a.receivable_id && a.chain_status ? `/receivables/${a.receivable_id}` : `/applications/${a.id}`; return (
          <li key={a.id}><Link href={href} className={`row row-${bucket}`} data-testid="application-row">
            <div className="row-main"><strong>{a.title}</strong><span className="muted">{a.buyer_name} · 만기 {formatDate(a.confirmed_due_at)} ({daysUntil(a.confirmed_due_at)})</span></div>
            <div className="row-side"><span className="amount">{formatKrw(a.confirmed_amount)}</span><Chip label={stage.label} /></div>
            <div className="row-next"><span>{bucket === "action" ? "할 일: " : ""}{stage.next} →</span><When iso={a.updated_at} /></div></Link></li>); }} />}</>);
}
