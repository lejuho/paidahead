"use client";
import Link from "next/link";
import { useLoad } from "@/lib/use-load";
import { daysUntil, formatDate, formatKrw } from "@/lib/format";
import { receivableLabel, reviewLabel } from "@/lib/labels";
import { reviewBucket, type ReviewRow } from "@/features/todo";
import { Grouped } from "@/components/grouped";
import { When } from "@/components/when";
import { Chip, ErrorBox, Loading, PageHead } from "@/components/ui";

type Row = ReviewRow & { id: string; created_at: string; updated_at: string; face_amount: string; due_at: string; title: string; supplier_name: string; buyer_name: string };
export default function ReviewQueue() {
  const list = useLoad<Row[]>("/bank/reviews", 5000);
  // Oldest intake first inside each group: the queue is worked top-down.
  const rows = [...(list.data ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at));
  return (<><PageHead title="검토 대기열" subtitle="구매처 확인과 온체인 등록이 끝난 채권만 접수됩니다 · 접수 오래된 순" />
    {list.loading ? <Loading /> : list.error ? <ErrorBox code={list.error} onRetry={list.reload} />
      : <Grouped rows={rows} bucket={(b) => reviewBucket(b).bucket} emptyTitle="접수된 채권이 없습니다" emptyHint="납품업체 신청이 구매처 확인과 채권 등록을 마치면 자동으로 접수됩니다."
        wrap={(children) => <div className="table-wrap"><table className="table table-queue"><thead><tr><th>다음 할 일</th><th>거래</th><th>납품업체 → 구매처</th><th className="num">액면</th><th>만기</th><th>상태</th><th>접수</th><th>최근 변경</th></tr></thead><tbody>{children}</tbody></table></div>}
        render={(b, bucket) => (<tr key={b.id} data-testid="review-row" className={`queue-${bucket}`}>
          <td data-label="다음 할 일"><Link href={`/bank/reviews/${b.id}`} className="queue-next">{reviewBucket(b).next} →</Link></td>
          <td data-label="거래"><Link href={`/bank/reviews/${b.id}`}><strong>{b.title}</strong></Link></td>
          <td data-label="당사자">{b.supplier_name} → {b.buyer_name}</td><td data-label="액면" className="num">{formatKrw(b.face_amount)}</td>
          <td data-label="만기">{formatDate(b.due_at)} <span className="muted">({daysUntil(b.due_at)})</span></td>
          <td data-label="상태"><Chip label={b.chain_status === "REGISTERED" ? reviewLabel(b.status) : receivableLabel(b.chain_status)} /></td>
          <td data-label="접수"><When iso={b.created_at} /></td><td data-label="최근 변경"><When iso={b.updated_at} /></td></tr>)} />}</>);
}
