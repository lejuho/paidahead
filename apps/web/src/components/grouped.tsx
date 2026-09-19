"use client";
import type { Bucket } from "@/features/todo";
import { Empty } from "./ui";

const TITLES: Record<Bucket, [string, string]> = { action: ["지금 할 일", "내 차례인 건입니다"], waiting: ["기다리는 중", "상대방 또는 체인 처리를 기다립니다"], done: ["완료·종결", ""] };
/** Splits any list into "my move / waiting / done" so the eye lands on actionable rows first. Done is collapsed. */
export function Grouped<T>({ rows, bucket, render, emptyTitle, emptyHint, wrap = (children) => <ul className="rows">{children}</ul> }: {
  rows: T[]; bucket(row: T): Bucket; render(row: T, bucket: Bucket): React.ReactNode; emptyTitle: string; emptyHint?: string; wrap?(children: React.ReactNode, bucket: Bucket): React.ReactNode }) {
  if (!rows.length) return <Empty title={emptyTitle} hint={emptyHint} />;
  const groups = (["action", "waiting", "done"] as Bucket[]).map((key) => ({ key, items: rows.filter((r) => bucket(r) === key) }));
  return (<div className="groups">{groups.map(({ key, items }) => {
    const head = <><span className={`group-dot group-dot-${key}`} aria-hidden />{TITLES[key][0]} <b>{items.length}</b>{TITLES[key][1] && <small>{TITLES[key][1]}</small>}</>;
    if (key === "done") return items.length ? <details key={key} className="group group-done"><summary className="group-head">{head}</summary>{wrap(items.map((r) => render(r, key)), key)}</details> : null;
    return (<section key={key} className={`group group-${key}`} data-testid={`group-${key}`}><h2 className="group-head">{head}</h2>
      {items.length ? wrap(items.map((r) => render(r, key)), key) : <p className="group-none">{key === "action" ? "지금 처리할 건이 없습니다 👍" : "기다리는 건이 없습니다"}</p>}</section>);
  })}</div>);
}
