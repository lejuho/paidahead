"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import { api, codeOf } from "./api";
import { errorMessage } from "./labels";
import { useWallet } from "./wallet";
import { classifyWalletError, walletFailureMessage } from "./wallet-errors";
import { blockerOf, isOpen, type Blocker, type LocalPhase, type PaymentCheck, type ServerStatus } from "./tx-state";

export interface TxPayload { chainId: number; from: string; to: string; data: Hex; value: string; type: string }
export interface Operation { id: string; kind: string; status: ServerStatus; transactionHash: string | null; failureCode: string | null; transaction: TxPayload; paymentApproval?: TxPayload }
export interface Preflight { simulation: "OK" | "CONTRACT_REJECTED"; gas?: string; gasPrice?: string; nativeBalance: string; sufficientGasBalance?: boolean; payment?: PaymentCheck | null }
export type OperationArgs = { approvalId?: string; offerId?: string };

const keyName = (receivableId: string, kind: string, args: OperationArgs) => `paidahead.idem.${receivableId}.${kind}.${args.approvalId ?? args.offerId ?? "-"}`;
const hashName = (operationId: string) => `paidahead.txhash.${operationId}`;
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } }, del: (k: string) => { try { localStorage.removeItem(k); } catch { /* ignore */ } } };

/**
 * Drives one wallet operation of the signed-in organization for one receivable.
 * The server record is the source of truth: a transaction hash or receipt never marks the business step complete.
 */
export function useOperation(receivableId: string, onSettled: () => void) {
  const wallet = useWallet();
  const [operation, setOperation] = useState<Operation | null>(null);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [phase, setPhase] = useState<LocalPhase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [localHash, setLocalHash] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<"success" | "reverted" | null>(null);
  const [recovered, setRecovered] = useState(false);
  const busy = useRef(false); // synchronous guard against double clicks; React state alone is too late.
  const idempotencyKey = useRef<string | null>(null);

  const fail = (text: string) => { setPhase("error"); setMessage(text); };
  const lock = async (work: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true; setMessage(null);
    try { await work(); } finally { busy.current = false; }
  };

  const check = useCallback(async (op: Operation): Promise<Preflight | null> => {
    setPhase("checking");
    try { const result = await api<Preflight>(`/operations/${op.id}/preflight`); setPreflight(result); setPhase("idle"); return result; }
    catch (error) { setPreflight(null); fail(errorMessage(codeOf(error))); return null; }
  }, []);

  const report = useCallback(async (op: Operation, hash: string) => {
    setPhase("reporting");
    for (let attempt = 0; attempt < 3; attempt++) {
      try { setOperation(await api<Operation>(`/operations/${op.id}/transaction`, { transactionHash: hash })); store.del(hashName(op.id)); setPhase("idle"); return; }
      catch (error) {
        if (codeOf(error) === "OPERATION_ALREADY_SUBMITTED") break;
        await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
      }
    }
    // The worker still matches the on-chain call to this prepared operation; polling continues and the hash stays stored for the next load.
    setPhase("idle"); setMessage("거래 해시를 서버에 알리지 못했습니다. 체인 기록으로 자동 복구되며, 상태를 계속 확인합니다.");
  }, []);

  // Refresh recovery: resume this organization's open operation from the server, not from browser memory.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const open = (await api<{ id: string; status: string }[]>(`/receivables/${receivableId}/operations`)).find((o) => isOpen(o.status));
        if (!open || cancelled) return;
        const op = await api<Operation>(`/operations/${open.id}`);
        if (cancelled) return;
        setOperation(op); setRecovered(true);
        const stored = store.get(hashName(op.id));
        if (op.status === "AWAITING_SIGNATURE" && stored) { setLocalHash(stored); await report(op, stored); }
        else if (op.status === "AWAITING_SIGNATURE") await check(op);
      } catch { /* the page's own loader reports connectivity problems */ }
    })();
    return () => { cancelled = true; };
  }, [receivableId, check, report]);

  // Poll until the worker has verified the chain result and projected it into the database.
  const openId = operation && isOpen(operation.status) ? operation.id : null;
  const waitingForChain = operation?.status === "PENDING" || !!localHash;
  useEffect(() => {
    if (!openId) return;
    const timer = setInterval(async () => {
      if (busy.current) return;
      try {
        const next = await api<Operation>(`/operations/${openId}`);
        setOperation((current) => (current?.id === next.id ? next : current));
        if (!isOpen(next.status)) { store.del(hashName(next.id)); if (idempotencyKey.current) store.del(idempotencyKey.current); onSettled(); }
      } catch { /* transient; keep polling */ }
    }, waitingForChain ? 1500 : 4000);
    return () => clearInterval(timer);
  }, [openId, waitingForChain, onSettled]);

  const start = useCallback((kind: string, args: OperationArgs = {}) => lock(async () => {
    setPhase("preparing"); setPreflight(null); setLocalHash(null); setReceipt(null); setRecovered(false);
    const name = keyName(receivableId, kind, args);
    const key = store.get(name) ?? crypto.randomUUID(); // a retry after a lost response re-uses the same server operation
    store.set(name, key); idempotencyKey.current = name;
    try {
      let op = await api<Operation>(`/receivables/${receivableId}/operations`, { idempotencyKey: key, kind, ...args });
      if (!isOpen(op.status)) { // stale key of a finished attempt: make a fresh operation
        const fresh = crypto.randomUUID(); store.set(name, fresh);
        op = await api<Operation>(`/receivables/${receivableId}/operations`, { idempotencyKey: fresh, kind, ...args });
      }
      setOperation(op); await check(op);
    } catch (error) {
      if (codeOf(error) === "OPERATION_IN_PROGRESS") {
        const open = (await api<{ id: string; status: string }[]>(`/receivables/${receivableId}/operations`).catch(() => [])).find((o) => isOpen(o.status));
        if (open) { const op = await api<Operation>(`/operations/${open.id}`); setOperation(op); setRecovered(true); if (op.status === "AWAITING_SIGNATURE") await check(op); else setPhase("idle"); return; }
      }
      store.del(name); fail(errorMessage(codeOf(error)));
    }
  }), [receivableId, check]);

  const ready = (payload: TxPayload): string | null => {
    if (wallet.status !== "connected" || !wallet.address) return "먼저 지갑을 연결하세요.";
    if (!wallet.onExpectedChain || wallet.chainId !== payload.chainId) return "지갑 네트워크가 다릅니다. 네트워크를 전환한 뒤 다시 시도하세요.";
    if (wallet.address.toLowerCase() !== payload.from.toLowerCase()) return "연결된 지갑이 이 거래의 서명 지갑(조직 승인 지갑)과 다릅니다. 지갑 계정을 바꿔 주세요.";
    return null;
  };
  const transmit = async (payload: TxPayload, gas?: string) => {
    const c = wallet.clients()!;
    const gasPrice = await c.reader.getGasPrice();
    const hash = await c.wallet.sendTransaction({ account: wallet.address as Address, chain: c.wallet.chain, to: payload.to as Address, data: payload.data,
      value: 0n, type: "legacy", gasPrice, ...(gas ? { gas: (BigInt(gas) * 12n) / 10n } : {}) });
    return { hash, reader: c.reader };
  };

  const approve = useCallback(() => lock(async () => {
    if (!operation?.paymentApproval) return;
    const problem = ready(operation.paymentApproval); if (problem) return fail(problem);
    setPhase("approving");
    try {
      const { hash, reader } = await transmit(operation.paymentApproval);
      const result = await reader.waitForTransactionReceipt({ hash });
      if (result.status !== "success") return fail(walletFailureMessage.REVERTED);
      await check(operation); void wallet.refreshBalances();
    } catch (error) { fail(walletFailureMessage[classifyWalletError(error)]); }
  }), [operation, wallet, check]);

  const send = useCallback(() => lock(async () => {
    if (!operation || operation.status !== "AWAITING_SIGNATURE" || localHash) return;
    const problem = ready(operation.transaction); if (problem) return fail(problem);
    const latest = await check(operation); // re-check immediately before signing; preflight is not a reservation
    if (!latest) return;
    const blocker = blockerOf(operation.kind, operation.transaction.from, latest);
    if (blocker !== "NONE") return fail(blockerMessage[blocker]);
    setPhase("wallet");
    let sent: Awaited<ReturnType<typeof transmit>>;
    try { sent = await transmit(operation.transaction, latest.gas); }
    catch (error) {
      const reason = classifyWalletError(error);
      if (reason === "USER_REJECTED") {
        const rejected = await api<Operation>(`/operations/${operation.id}/reject`, {}).catch(() => null);
        if (rejected) setOperation(rejected);
        if (idempotencyKey.current) store.del(idempotencyKey.current);
        setPhase("idle"); setMessage(walletFailureMessage.USER_REJECTED); return;
      }
      return fail(walletFailureMessage[reason]);
    }
    store.set(hashName(operation.id), sent.hash); setLocalHash(sent.hash);
    sent.reader.waitForTransactionReceipt({ hash: sent.hash }).then((r) => setReceipt(r.status === "success" ? "success" : "reverted")).catch(() => undefined);
    await report(operation, sent.hash); void wallet.refreshBalances();
  }), [operation, localHash, wallet, check, report]);

  const abandon = useCallback(() => lock(async () => {
    if (!operation || operation.status !== "AWAITING_SIGNATURE" || localHash) return;
    try { setOperation(await api<Operation>(`/operations/${operation.id}/reject`, {})); if (idempotencyKey.current) store.del(idempotencyKey.current); setPhase("idle"); }
    catch (error) { fail(errorMessage(codeOf(error))); }
  }), [operation, localHash]);

  const dismiss = useCallback(() => { if (!operation || !isOpen(operation.status)) { setOperation(null); setPreflight(null); setPhase("idle"); setMessage(null); setLocalHash(null); setReceipt(null); } }, [operation]);
  const blocker: Blocker | null = operation && preflight ? blockerOf(operation.kind, operation.transaction.from, preflight) : null;
  const working = phase === "preparing" || phase === "checking" || phase === "approving" || phase === "wallet" || phase === "reporting";
  return { operation, preflight, phase, message, localHash, receipt, recovered, blocker, working, open: !!openId || working,
    start, approve, send, abandon, dismiss, recheck: () => lock(async () => { if (operation) await check(operation); }) };
}
export const blockerMessage: Record<Blocker, string> = {
  NONE: "", NEEDS_APPROVAL: "결제 계약이 모의 토큰을 가져갈 수 있도록 먼저 ‘토큰 사용 승인’ 거래가 필요합니다.",
  INSUFFICIENT_BALANCE: "연결된 지갑의 모의 토큰 잔액이 부족합니다. 잔액을 채운 뒤 ‘다시 점검’을 누르세요.",
  FUNDER_NOT_READY: "은행 지갑의 모의 토큰 잔액 또는 사용 승인이 부족해 지금은 매입이 실행되지 않습니다. 은행 역할에서 잔액·승인을 준비한 뒤 다시 점검하세요.",
  INSUFFICIENT_GAS: "가스비로 쓸 네이티브 토큰이 부족합니다.", CONTRACT_REJECTED: "사전 점검에서 계약이 이 거래를 거절했습니다. 채권·오퍼 상태가 바뀌었는지 확인하고 다시 점검하세요.",
};
