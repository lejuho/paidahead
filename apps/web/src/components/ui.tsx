"use client";
import Link from "next/link";
import type { Tone } from "@/lib/labels";
import { errorMessage } from "@/lib/labels";

export const Chip = ({ label }: { label: { text: string; tone: Tone } }) => <span className={`chip chip-${label.tone}`}>{label.text}</span>;
export const DemoTag = ({ children = "시연 데이터" }: { children?: React.ReactNode }) => <span className="demo-tag">{children}</span>;
export const Loading = ({ text = "불러오는 중…" }: { text?: string }) => <div className="state" role="status" aria-live="polite"><span className="spinner" aria-hidden />{text}</div>;
export const Empty = ({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) => (
  <div className="state state-empty"><strong>{title}</strong>{hint && <p>{hint}</p>}{action}</div>);
export function ErrorBox({ code, text, onRetry }: { code?: string | null; text?: string | null; onRetry?: () => void }) {
  if (!code && !text) return null;
  return (<div className="alert alert-bad" role="alert"><span>{text ?? errorMessage(code)}</span>
    {onRetry && <button type="button" className="btn btn-small" onClick={onRetry}>다시 시도</button>}</div>);
}
export const Notice = ({ tone = "info", children }: { tone?: "info" | "wait" | "good" | "bad"; children: React.ReactNode }) => <div className={`alert alert-${tone}`}>{children}</div>;
export function Card({ title, aside, children, tone }: { title?: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; tone?: "accent" }) {
  return (<section className={`card${tone ? ` card-${tone}` : ""}`}>{(title || aside) && <header className="card-head"><h2>{title}</h2>{aside}</header>}{children}</section>);
}
export const Facts = ({ items }: { items: [string, React.ReactNode][] }) => (
  <dl className="facts">{items.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>);
export function PageHead({ title, subtitle, back, action }: { title: string; subtitle?: React.ReactNode; back?: { href: string; label: string }; action?: React.ReactNode }) {
  return (<div className="page-head">{back && <Link href={back.href} className="back">← {back.label}</Link>}
    <div className="page-head-row"><div><h1>{title}</h1>{subtitle && <p className="muted">{subtitle}</p>}</div>{action}</div></div>);
}
export function Button({ busy, children, variant = "primary", ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; variant?: "primary" | "secondary" | "danger" | "ghost" }) {
  return (<button type="button" {...rest} className={`btn btn-${variant} ${rest.className ?? ""}`} disabled={rest.disabled || busy} aria-busy={busy || undefined}>
    {busy && <span className="spinner" aria-hidden />}{children}</button>);
}
/** Hero figure: the one number and the one next action the user needs. */
export function Hero({ label, amount, meta, next, children }: { label: string; amount: string; meta?: React.ReactNode; next?: React.ReactNode; children?: React.ReactNode }) {
  return (<section className="hero"><p className="hero-label">{label}</p><p className="hero-amount">{amount}</p>{meta && <p className="hero-meta">{meta}</p>}
    {next && <div className="hero-next"><span>다음 할 일</span><strong>{next}</strong></div>}{children}</section>);
}
export function Progress({ steps }: { steps: { title: string; state: "todo" | "active" | "done" | "failed"; note?: React.ReactNode }[] }) {
  return (<ol className="progress">{steps.map((s, i) => (
    <li key={s.title} className={`progress-${s.state}`} aria-current={s.state === "active" ? "step" : undefined}>
      <span className="progress-dot" aria-hidden>{s.state === "done" ? "✓" : s.state === "failed" ? "!" : i + 1}</span>
      <div><strong>{s.title}</strong>{s.note && <p>{s.note}</p>}</div></li>))}</ol>);
}
