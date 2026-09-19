"use client";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, codeOf } from "./api";
import { WalletProvider, type ChainInfo } from "./wallet";

export type Role = "supplier" | "buyer" | "bank";
export interface Me { userId: string; organizationId: string; displayName: string; organization: { id: string; display_name: string; kind: string };
  roles: string[]; wallets: { chain_id: string; address: string }[]; authMode: string }
interface Session { loading: boolean; enabled: boolean; role: Role | null; me: Me | null; chain: ChainInfo | null; error: string | null;
  login(account: string): Promise<Role | null>; logout(): Promise<void>; reload(): Promise<void> }
/** The screen set follows the signed-in account's organization (from the API), never a client-chosen role. */
const ROLE_BY_KIND: Record<string, Role> = { SUPPLIER: "supplier", BUYER: "buyer", BANK: "bank" };
const Context = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<Omit<Session, "login" | "logout" | "reload">>({ loading: true, enabled: false, role: null, me: null, chain: null, error: null });
  const reload = useCallback(async () => {
    try {
      const session = await (await fetch("/api/demo/session", { cache: "no-store" })).json();
      if (!session.enabled || !session.role) return setState({ loading: false, enabled: !!session.enabled, role: null, me: null, chain: null, error: null });
      const me = await api<Me>("/me");
      // A missing deployment must not block document/confirmation work; wallet features simply stay unavailable.
      const chain = await api<Omit<ChainInfo, "rpcUrl">>("/chain").then((c) => ({ ...c, rpcUrl: session.rpcUrl as string })).catch(() => null);
      const role = ROLE_BY_KIND[me.organization.kind] ?? null;
      setState({ loading: false, enabled: true, role, me, chain, error: role ? null : "FORBIDDEN" });
    } catch (error) { setState((s) => ({ ...s, loading: false, me: null, error: codeOf(error) })); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  // Demo sign-in: the server maps the chosen demo account to its seeded credentials. Which screens open is decided by /me afterwards.
  const login = useCallback(async (account: string) => {
    const response = await fetch("/api/demo/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: account }) });
    if (!response.ok) { const data = await response.json().catch(() => ({})); setState((s) => ({ ...s, error: data.error ?? "INTERNAL_ERROR" })); return null; }
    const me = await api<Me>("/me").catch(() => null);
    await reload();
    return me ? ROLE_BY_KIND[me.organization.kind] ?? null : null;
  }, [reload]);
  const logout = useCallback(async () => { await fetch("/api/demo/session", { method: "DELETE" }); await reload(); }, [reload]);
  return (
    <Context.Provider value={{ ...state, login, logout, reload }}>
      <WalletProvider expected={state.chain} organizationWallets={state.me?.wallets ?? []}>{children}</WalletProvider>
    </Context.Provider>
  );
}
export function useSession(): Session {
  const value = useContext(Context);
  if (!value) throw new Error("SessionProvider missing");
  return value;
}
