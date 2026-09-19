"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useSession } from "@/lib/session";
import { DemoBanner, ROLE_HOME } from "@/components/app-shell";
import { Button, ErrorBox, Loading, Notice } from "@/components/ui";

// One sign-in screen for everyone. After sign-in the account's organization (supplier / buyer / bank) decides which workspace opens.
const ACCOUNTS = [
  { account: "supplier", user: "납품업체 담당자", org: "대구 식자재 납품 역할" },
  { account: "buyer", user: "구매처 담당자", org: "시장 식당 역할" },
  { account: "bank", user: "은행 심사·승인 담당자", org: "iM뱅크 역할 · 시연용" },
];
export default function Login() {
  const session = useSession(); const router = useRouter();
  const [entering, setEntering] = useState<string | null>(null);
  useEffect(() => { if (!session.loading && session.role && !entering) router.replace(ROLE_HOME[session.role]); }, [session.loading, session.role, entering, router]);
  const signIn = async (account: string) => { if (entering) return; setEntering(account); const role = await session.login(account); if (role) router.push(ROLE_HOME[role]); else setEntering(null); };
  return (<><DemoBanner /><main className="landing">
    <p className="eyebrow">대구 골목상권 납품 사장님을 위한 매출채권 조기정산</p>
    <h1>납품 대금, <b>먼저 받기</b></h1>
    <p className="lead">로그인하면 계정이 속한 조직에 맞는 업무 화면이 열립니다.</p>
    {session.loading || (session.role && !entering) ? <Loading /> : !session.enabled ? (
      <Notice tone="bad">운영용 로그인은 아직 구현되지 않았습니다. 시연 로그인은 로컬 개발 환경에서 <code>DEMO_MODE=true</code>일 때만 켜집니다.</Notice>
    ) : (<section className="login"><h2>로그인 <span className="demo-tag">시연 계정 · 비밀번호 없음</span></h2>
      <ErrorBox code={session.error} />
      <ul className="accounts">{ACCOUNTS.map((a) => (<li key={a.account}>
        <div><strong>{a.user}</strong><span className="muted">{a.org}</span></div>
        <Button variant="secondary" onClick={() => signIn(a.account)} busy={entering === a.account} disabled={!!entering} data-testid={`enter-${a.account}`}>로그인</Button></li>))}</ul>
      <p className="muted">실제 서비스에서는 이 자리에 아이디·인증 수단 입력이 들어갑니다. 어떤 화면이 열리는지는 선택이 아니라 서버가 확인한 소속 조직으로 정해지며, 지갑 연결은 로그인이나 권한을 대신하지 않습니다.</p>
    </section>)}
  </main></>);
}
