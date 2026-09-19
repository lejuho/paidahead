"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { daysUntil, formatDate, formatKrw, groupDigits, relativeTime } from "@/lib/format";
import { Button, Card, Chip, Facts, Hero, Notice, Progress } from "@/components/ui";
import { advance, ANALYSIS, DOCUMENTS, FACE, FLOW, flowStates, initialTour, isMyTurn, ledger, ORGS, PURCHASE, stepOf, switchRole, TOUR_ROLE_NAME, type TourRole, type TourState } from "@/tour/model";

const STORE = "paidahead.tour.v1";
const ROLES: TourRole[] = ["supplier", "buyer", "bank"];
const DUE = new Date(Date.now() + 30 * 86400000).toISOString();

/** 화면 체험: a scripted, browser-only simulation. No API, wallet, chain, hashes or "confirmed on-chain" wording. */
export default function Tour() {
  const [state, setState] = useState<TourState | null>(null);
  const [working, setWorking] = useState(false);
  const busy = useRef(false);
  useEffect(() => {
    const wanted = new URLSearchParams(location.search).get("role") as TourRole | null;
    let saved: TourState | null = null;
    try { saved = JSON.parse(localStorage.getItem(STORE) ?? "null"); } catch { /* start over */ }
    const base = saved?.stage && saved.events ? saved : initialTour();
    const start = wanted && ROLES.includes(wanted) ? switchRole(base, wanted) : base;
    // Persist before dropping the query: the entry role applies once, and a refresh (or React's dev double-effect) keeps the current screen.
    try { localStorage.setItem(STORE, JSON.stringify(start)); } catch { /* private mode */ }
    if (wanted) history.replaceState(null, "", location.pathname);
    setState(start);
  }, []);
  useEffect(() => { if (state) { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* private mode */ } } }, [state]);
  if (!state) return null;

  const step = stepOf(state), mine = isMyTurn(state), books = ledger(state), flow = flowStates(state);
  const act = async () => {
    if (busy.current || !mine) return;
    busy.current = true; setWorking(true);
    await new Promise((resolve) => setTimeout(resolve, step?.simulatedApproval ? 1100 : 350)); // pacing only; nothing is sent anywhere
    setState((s) => (s ? advance(s) : s)); setWorking(false); busy.current = false;
  };
  const reset = () => { if (confirm("체험을 처음 상태로 되돌릴까요?")) setState(initialTour(state.role)); };
  const next = !step ? "체험 완료 — 채권이 종결되었습니다" : mine ? step.action : `${TOUR_ROLE_NAME[step.actor]} 차례 · ${step.waiting}`;

  return (<>
    <div className="sim-banner" role="note" data-testid="sim-banner">시뮬레이션 · 실제 거래 없음 — 서버·지갑·블록체인에 연결하지 않고 가상 데이터로 화면 흐름만 보여 줍니다</div>
    <header className="top"><div className="top-inner">
      <Link href="/" className="brand">사장님 <b>먼저받기</b></Link>
      <div className={`who who-${state.role}`}><strong>{TOUR_ROLE_NAME[state.role]}</strong><span><span className="demo-tag">화면 체험</span> {ORGS[state.role]}</span></div>
      <button type="button" className="logout" onClick={reset} data-testid="tour-reset">처음부터</button>
    </div>
    <nav className="tabs tabs-3" aria-label="역할 전환">{ROLES.map((role) => { const turn = step?.actor === role; return (
      <button key={role} type="button" className={`tab tab-${role === "supplier" ? "orange" : role === "buyer" ? "blue" : "green"}${state.role === role ? " active" : ""}`}
        aria-pressed={state.role === role} onClick={() => setState(switchRole(state, role))} data-testid={`tour-role-${role}`}>
        <span className="tab-label">{TOUR_ROLE_NAME[role]} 화면</span>
        <span className="pills"><span className={`pill pill-action${turn ? "" : " pill-zero"}`}>할 일 <b>{turn ? 1 : 0}</b></span></span></button>); })}</nav></header>

    <div className="page"><main>
      <Hero label={state.role === "buyer" ? "지급할 금액 (액면)" : "채권 액면"} amount={formatKrw(FACE)} meta={<>가상 식자재 납품 · 만기 {formatDate(DUE)} · {daysUntil(DUE)}</>} next={next}>
        <Chip label={{ text: books.receivable, tone: state.stage === "REPAID" ? "good" : books.holder ? "wait" : "neutral" }} /></Hero>
      <Progress steps={FLOW.map((f, i) => ({ title: f.title, state: flow[i] }))} />

      {step && mine && (<Card title={<>지금 할 일 · {TOUR_ROLE_NAME[state.role]}</>} tone="accent">
        <ActionBody state={state} />
        {step.simulatedApproval && <Notice tone="wait">실제 서비스에서는 이 단계에서 <b>{TOUR_ROLE_NAME[step.actor]} 조직의 승인 지갑</b>으로 서명합니다. 화면 체험에서는 <b>간편 승인</b> 버튼이 서명을 대신하며, 거래는 발생하지 않습니다.</Notice>}
        <div className="actions"><Button onClick={act} busy={working} data-testid="tour-action">{step.simulatedApproval ? `간편 승인 · ${step.action}` : step.action}</Button></div>
        {step.simulatedApproval && <p className="muted">시뮬레이션 · 실제 거래 없음 · 거래 해시가 생성되지 않습니다.</p>}
      </Card>)}
      {step && !mine && (<Card title="기다리는 중"><p>{step.waiting}입니다. 이어서 보려면 {TOUR_ROLE_NAME[step.actor]} 화면으로 바꾸세요.</p>
        <div className="actions"><Button variant="secondary" onClick={() => setState(switchRole(state, step.actor))} data-testid="tour-follow">{TOUR_ROLE_NAME[step.actor]} 화면으로 전환 →</Button></div></Card>)}
      {!step && (<Card title="체험 완료" tone="accent"><p>300만원 채권 → 297만원 먼저받기 → 만기 300만원 상환까지 세 역할의 화면을 모두 보셨습니다.</p>
        <Notice>실제 시제품은 같은 흐름을 PostgreSQL·업무 API·스마트계약(채권 토큰과 모의 결제 토큰의 동시 결제)으로 실행하며, 각 참여자가 자기 지갑으로 서명합니다. 그 실행은 온체인 데모 영상과 저장소에서 확인할 수 있습니다.</Notice>
        <div className="actions"><Button onClick={() => setState(initialTour(state.role))}>처음부터 다시 체험</Button></div></Card>)}

      <Card title="가상 잔액과 채권 보유" aside={<span className="demo-tag">시뮬레이션 값</span>}>
        <div className="sim-ledger">{ROLES.map((role) => (<div key={role} className={books.holder === role ? "holds" : ""}>
          <span>{TOUR_ROLE_NAME[role]}</span><strong data-testid={`tour-balance-${role}`}>{groupDigits(books.balances[role].toString())}</strong><small>모의 토큰{books.holder === role ? " · 채권 보유" : ""}</small></div>))}</div>
        <p className="muted">먼저받기 순간에 채권(납품업체→은행)과 297만 모의 대금(은행→납품업체)이 함께 바뀌고, 상환 때 구매처가 액면 300만원 전액을 은행에 지급합니다. 차액 3만원은 예시이며 실제 금리가 아닙니다.</p></Card>

      {(state.role !== "bank" || STAGE_VISIBLE_TO_BANK(state)) && <Documents />}

      <Card title="진행 기록" aside={<span className="demo-tag">시뮬레이션 기록 · 온체인 기록 아님</span>}>
        {state.events.length ? <ol className="timeline">{[...state.events].reverse().map((e, i) => <li key={i}><strong>{e.text}</strong><span className="muted">{relativeTime(e.at)}</span></li>)}</ol>
          : <p className="muted">아직 진행한 단계가 없습니다. 납품업체 화면에서 시작하세요.</p>}</Card>
      <p className="muted" style={{ textAlign: "center" }}><Link href="/">← 로그인 화면으로</Link></p>
    </main></div></>);
}
const STAGE_VISIBLE_TO_BANK = (state: TourState) => state.events.some((e) => e.stage === "REGISTERED"); // the bank sees evidence only after registration

function ActionBody({ state }: { state: TourState }) {
  switch (state.stage) {
    case "NEW": return <Facts items={[["거래", "가상 식자재 납품"], ["구매처", ORGS.buyer], ["받을 금액", formatKrw(FACE)], ["지급 만기", formatDate(DUE)], ["서류", "발주서 · 납품서 · 청구서 (가상)"]]} />;
    case "CREATED": return <p>아래 ‘서류와 분석 결과 예시’에서 세 서류의 거래처·품목·금액이 일치하는지, 확인이 필요한 항목이 무엇인지 살펴본 뒤 검토를 완료합니다.</p>;
    case "REVIEWED": return <p>요청하면 금액·만기·서류가 고정됩니다. 구매처가 확인하면 채권이 등록되고 은행 검토로 이어집니다.</p>;
    case "REQUESTED": return <Facts items={[["요청 업체", ORGS.supplier], ["납품 사실", "식자재 세트 100개를 납품받음"], ["지급 의무", `${formatDate(DUE)}까지 ${formatKrw(FACE)}`]]} />;
    case "REGISTERED": return <p>구매처 확인과 채권 등록이 끝난 건만 은행 대기열에 접수됩니다. 서류와 확인 내용을 검토합니다.</p>;
    case "IN_REVIEW": return <Facts items={[["액면", formatKrw(FACE)], ["매입 금액", formatKrw(PURCHASE)], ["차액 (예시 · 금리 아님)", formatKrw(FACE - PURCHASE)], ["제안 유효기간", "승인 후 24시간"]]} />;
    case "APPROVED": return <p>승인한 조건을 업체에 제시합니다. 실제로는 은행 지갑이 모의 토큰 사용 승인과 오퍼 등록에 서명합니다.</p>;
    case "OFFERED": return (<div className="offer"><div><span>지금 받을 금액 (모의)</span><strong>{formatKrw(PURCHASE)}</strong></div><div><span>액면</span><strong>{formatKrw(FACE)}</strong></div><div><span>차액</span><strong>{formatKrw(FACE - PURCHASE)}</strong></div></div>);
    case "PURCHASED": return <Facts items={[["상환 금액", formatKrw(FACE)], ["수취 기관", ORGS.bank], ["참고", "매입 금액이 아닌 액면 전액 · 부분 상환 없음"]]} />;
    default: return null;
  }
}
function Documents() {
  const [open, setOpen] = useState<number | null>(null);
  return (<Card title="서류와 분석 결과 예시" aside={<span className="demo-tag">가상 서류 · 예시 결과 (AI 분석 미실행)</span>}>
    <ul className="docs">{DOCUMENTS.map((d, i) => (<li key={d.file}><button type="button" className="doc" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
      <span><b>{d.type}</b> {d.file}</span><span className="muted">{d.fields.금액}</span></button>{open === i && <pre className="doc-body">{d.body}</pre>}</li>))}</ul>
    <div className="table-wrap"><table className="table"><thead><tr><th>항목</th><th>서류 간 비교</th><th>근거</th></tr></thead><tbody>
      {ANALYSIS.map((a) => <tr key={a.field}><td>{a.field}</td><td><Chip label={{ text: a.result, tone: a.result === "일치" ? "good" : "action" }} /></td><td>{a.note}</td></tr>)}</tbody></table></div>
    <p className="muted">이 표는 제안하는 AI 서류 비교 화면의 예시입니다. 이번 시제품은 OCR·LLM을 실행하지 않으며, 판독이 애매한 항목은 사람이 확인하도록 넘깁니다.</p></Card>);
}
