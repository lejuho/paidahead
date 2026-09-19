"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useSession, type Role } from "@/lib/session";
import { WalletBar } from "./wallet-bar";
import { useInbox } from "@/features/inbox";
import { ErrorBox, Loading } from "./ui";

export const ROLE_HOME: Record<Role, string> = { supplier: "/applications", buyer: "/confirmations", bank: "/bank/reviews" };
export const ROLE_NAME: Record<Role, string> = { supplier: "납품업체", buyer: "구매처", bank: "은행" };
export function DemoBanner() {
  return <div className="demo-banner" role="note">시연 모드 · 운영 인증이 아닙니다 · 가상 조직·가상 서류·모의 토큰만 사용하며 실제 자금·은행과 연결되지 않습니다</div>;
}
export function AppShell({ role: required, children }: { role?: Role; children: React.ReactNode }) {
  const session = useSession(); const path = usePathname(); const router = useRouter();
  const wrong = !session.loading && !session.error && (required ? session.role !== required : !session.role);
  const role = (required ?? session.role) as Role;
  useEffect(() => { if (wrong) router.replace(session.role ? ROLE_HOME[session.role] : "/"); }, [wrong, session.role, router]);
  if (session.loading || wrong) return <><DemoBanner /><main className="page"><Loading /></main></>;
  if (session.error || !session.me) return <><DemoBanner /><main className="page"><ErrorBox code={session.error ?? "UNAUTHENTICATED"} onRetry={session.reload} /><p><Link href="/">역할 선택으로 돌아가기</Link></p></main></>;
  return (<><DemoBanner />
    <header className="top"><div className="top-inner">
      <Link href={ROLE_HOME[role]} className="brand">사장님 <b>먼저받기</b></Link>
      <div className={`who who-${role}`} aria-label="현재 로그인한 조직 구분"><strong>{ROLE_NAME[role]}</strong>
        <span><span className="demo-tag">시연 계정</span> {session.me.organization.display_name}</span></div>
      <button type="button" className="logout" data-testid="logout" onClick={async () => { await session.logout(); router.push("/"); }}>로그아웃</button>
    </div><RoleTabs role={role} path={path} /></header>
    <div className="page"><main>{children}</main><details className="card technical-details" data-testid="demo-settings"><summary>시연 설정 · 지갑과 네트워크</summary><p className="muted">시연용 연결 상태를 확인하거나 계정을 변경할 때 여세요. 거래에 필요한 연결은 해당 화면에서도 안내합니다.</p><WalletBar /></details></div></>);
}

/** Large tabs: each shows how many items need THIS organization's action (colored badge) and how many are waiting on others. */
function RoleTabs({ role, path }: { role: Role; path: string }) {
  const tabs = useInbox(role);
  return (<nav className="tabs" aria-label="업무 메뉴">{tabs.map((tab) => {
    const active = path.startsWith(tab.href) || (tab.href !== "/applications" && tab.href !== "/confirmations" && tab.href !== "/bank/reviews" && path.startsWith("/receivables"));
    return (<Link key={tab.href} href={tab.href} className={`tab tab-${tab.tone}${active ? " active" : ""}`} aria-current={active ? "page" : undefined} data-testid={`tab-${tab.href.split("/").pop()}`}>
      <span className="tab-label">{tab.label}</span><span className="tab-hint">{tab.hint}</span>
      <span className="pills">
        <span className={`pill pill-action${tab.action ? "" : " pill-zero"}`} data-testid="pill-action" aria-label={`지금 할 일 ${tab.action}건`}>할 일 <b>{tab.action}</b></span>
        <span className={`pill pill-waiting${tab.waiting ? "" : " pill-zero"}`} data-testid="pill-waiting" aria-label={`기다리는 중 ${tab.waiting}건`}>대기 <b>{tab.waiting}</b></span>
      </span></Link>);
  })}</nav>);
}
