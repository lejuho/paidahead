"use client";
import { useLoad } from "@/lib/use-load";
import type { Role } from "@/lib/session";
import { applicationBucket, bankReceivable, buyerReceivable, confirmationBucket, count, reviewBucket, supplierReceivable, type Bucket } from "./todo";

export interface TabInfo { href: string; label: string; tone: "orange" | "green" | "blue" | "red"; action: number; waiting: number; hint: string }
/** Per-tab "my move" counters for the role navigation. Same classifiers as the lists, so badge and list always agree. */
export function useInbox(role: Role): TabInfo[] {
  const first = useLoad<any[]>(role === "supplier" ? "/applications" : role === "buyer" ? "/confirmations?limit=100" : "/bank/reviews", 6000);
  const receivables = useLoad<any[]>("/receivables", 6000);
  const tally = (rows: any[] | null, bucket: (row: any) => Bucket) => ({ action: count(rows, bucket), waiting: count(rows, bucket, "waiting") });
  if (role === "supplier") return [
    { href: "/applications", label: "내 신청", tone: "orange", hint: "서류·확인 요청", ...tally(first.data, applicationBucket) },
    { href: "/receivables", label: "채권·먼저받기", tone: "green", hint: "조건 수락·보완 답변", ...tally(receivables.data, (r) => supplierReceivable(r).bucket) }];
  if (role === "buyer") return [
    { href: "/confirmations", label: "확인 요청", tone: "orange", hint: "납품·지급 의무 확인", ...tally(first.data, (c) => confirmationBucket(c.status)) },
    { href: "/repayments", label: "상환", tone: "blue", hint: "만기 전액 상환", ...tally(receivables.data, (r) => buyerReceivable(r).bucket) }];
  return [
    { href: "/bank/reviews", label: "검토 대기열", tone: "orange", hint: "검토·조건 승인·오퍼", ...tally(first.data, (b) => reviewBucket(b).bucket) },
    { href: "/portfolio", label: "매입·상환 현황", tone: "red", hint: "연체 확인", ...tally(receivables.data, (r) => bankReceivable(r).bucket) }];
}
