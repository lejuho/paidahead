"use client";
import Link from "next/link";
import { useLoad } from "@/lib/use-load";
import { daysUntil, formatDate, formatKrw } from "@/lib/format";
import { receivableLabel } from "@/lib/labels";
import type { Bucket, ReceivableRow } from "./todo";
import { Grouped } from "@/components/grouped";
import { When } from "@/components/when";
import { Chip, ErrorBox, Loading, PageHead } from "@/components/ui";

type Row = ReceivableRow & { id: string; title: string; supplier_name: string; buyer_name: string; face_amount: string; due_at: string; synced_at: string | null };
export function ReceivableList({ title, subtitle, emptyHint, classify }: { title: string; subtitle: string; emptyHint: string; classify(row: ReceivableRow): { bucket: Bucket; next: string } }) {
  const list = useLoad<Row[]>("/receivables", 5000);
  const rows = [...(list.data ?? [])].sort((a, b) => a.due_at.localeCompare(b.due_at)); // nearest maturity first inside each group
  const outstanding = rows.filter((r) => r.chain_status === "PURCHASED").reduce((sum, r) => sum + BigInt(r.face_amount), 0n);
  return (<><PageHead title={title} subtitle={subtitle} />
    <div className="summary"><div><span>상환 대기 액면 합계</span><strong>{formatKrw(outstanding)}</strong></div>
      <div><span>연체</span><strong className={rows.some((r) => r.overdue) ? "bad" : ""}>{rows.filter((r) => r.overdue).length}건</strong></div></div>
    {list.loading ? <Loading /> : list.error ? <ErrorBox code={list.error} onRetry={list.reload} />
      : <Grouped rows={rows} bucket={(r) => classify(r).bucket} emptyTitle="채권이 없습니다" emptyHint={emptyHint} render={(r, bucket) => (
        <li key={r.id}><Link href={`/receivables/${r.id}`} className={`row row-${bucket}`} data-testid="receivable-row">
          <div className="row-main"><strong>{r.title}</strong><span className="muted">{r.supplier_name} → {r.buyer_name} · 만기 {formatDate(r.due_at)} ({daysUntil(r.due_at)})</span></div>
          <div className="row-side"><span className="amount">{formatKrw(r.face_amount)}</span>{r.overdue ? <Chip label={{ text: "연체", tone: "bad" }} /> : <Chip label={receivableLabel(r.chain_status)} />}</div>
          <div className="row-next"><span>{bucket === "action" ? "할 일: " : ""}{classify(r).next}{r.live_offer_amount && bucket === "action" ? ` (${formatKrw(r.live_offer_amount)})` : ""} →</span><When iso={r.synced_at} /></div></Link></li>)} />}</>);
}
