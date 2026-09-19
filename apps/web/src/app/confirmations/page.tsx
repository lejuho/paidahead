"use client";
import Link from "next/link";
import { useLoad } from "@/lib/use-load";
import { formatDate, formatKrw } from "@/lib/format";
import { confirmationLabel } from "@/lib/labels";
import { confirmationBucket } from "@/features/todo";
import { Grouped } from "@/components/grouped";
import { When } from "@/components/when";
import { Chip, ErrorBox, Loading, PageHead } from "@/components/ui";

interface Row { id: string; status: string; title: string; supplier_name: string; confirmed_amount: string; confirmed_due_at: string; requested_at: string }
export default function Confirmations() {
  const list = useLoad<Row[]>("/confirmations?limit=100", 5000);
  const waiting = (list.data ?? []).filter((c) => c.status === "PENDING").length;
  return (<><PageHead title="확인 요청" subtitle={`납품업체가 보낸 납품·지급 의무 확인 요청 · 대기 ${waiting}건`} />
    {list.loading ? <Loading /> : list.error ? <ErrorBox code={list.error} onRetry={list.reload} />
      : <Grouped rows={list.data ?? []} bucket={(c) => confirmationBucket(c.status)} emptyTitle="받은 확인 요청이 없습니다" emptyHint="납품업체가 확인을 요청하면 여기에 표시됩니다."
        render={(c, bucket) => (<li key={c.id}><Link href={`/confirmations/${c.id}`} className={`row row-${bucket}`} data-testid="confirmation-row">
          <div className="row-main"><strong>{c.title}</strong><span className="muted">{c.supplier_name} · 지급일 {formatDate(c.confirmed_due_at)}</span></div>
          <div className="row-side"><span className="amount">{formatKrw(c.confirmed_amount)}</span><Chip label={confirmationLabel(c.status)} /></div>
          <div className="row-next"><span>{bucket === "action" ? "할 일: 내용 검토 후 확인 또는 반려" : "기록 보기"} →</span><When iso={c.requested_at} label="요청" /></div></Link></li>)} />}</>);
}
