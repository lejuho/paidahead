"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPublicClient, createWalletClient, custom, defineChain, getAddress, numberToHex, type Address, type EIP1193Provider } from "viem";
import { paymentAbi } from "@paidahead/domain";
import { classifyWalletError, type WalletFailure } from "./wallet-errors";

export interface ChainInfo { chainId: number; settlementContract: string; paymentToken: string; receivableContract: string; environment: string; rpcUrl: string }
interface Discovered { id: string; name: string; icon?: string; provider: EIP1193Provider }
interface Balances { native: bigint; token: bigint }
interface WalletState {
  available: Discovered[]; status: "disconnected" | "connecting" | "connected";
  address: Address | null; chainId: number | null; walletName: string | null;
  expected: ChainInfo | null; onExpectedChain: boolean;
  /** Approved wallet_binding addresses of the signed-in organization on the expected chain. */
  organizationWallets: string[]; matchesOrganization: boolean;
  balances: Balances | null; failure: WalletFailure | null;
  connect(id?: string): Promise<void>; disconnect(): Promise<void>; switchChain(): Promise<boolean>; refreshBalances(): Promise<void>;
  clients(): { wallet: ReturnType<typeof createWalletClient>; reader: ReturnType<typeof createPublicClient> } | null;
}
const Context = createContext<WalletState | null>(null);
const REMEMBER = "paidahead.wallet";
const chainOf = (info: ChainInfo) => defineChain({ id: info.chainId, name: info.chainId === 31337 ? "PaidAhead 로컬 (Hardhat 31337)" : `EVM ${info.chainId}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [info.rpcUrl] } } });

export function WalletProvider({ expected, organizationWallets, children }: { expected: ChainInfo | null; organizationWallets: { chain_id: string; address: string }[]; children: React.ReactNode }) {
  const [available, setAvailable] = useState<Discovered[]>([]);
  const [active, setActive] = useState<Discovered | null>(null);
  const [status, setStatus] = useState<WalletState["status"]>("disconnected");
  const [address, setAddress] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [failure, setFailure] = useState<WalletFailure | null>(null);
  const restored = useRef(false);

  // EIP-6963 discovery with a window.ethereum fallback for older injected wallets.
  useEffect(() => {
    const found = new Map<string, Discovered>();
    const publish = () => setAvailable([...found.values()]);
    const announce = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.info?.uuid && detail.provider) { found.set(detail.info.uuid, { id: detail.info.uuid, name: detail.info.name, icon: detail.info.icon, provider: detail.provider }); publish(); }
    };
    window.addEventListener("eip6963:announceProvider", announce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    const fallback = setTimeout(() => {
      const injected = (window as any).ethereum as EIP1193Provider | undefined;
      if (injected && ![...found.values()].some((d) => d.provider === injected)) { found.set("injected", { id: "injected", name: "브라우저 지갑", provider: injected }); publish(); }
    }, 300);
    return () => { window.removeEventListener("eip6963:announceProvider", announce); clearTimeout(fallback); };
  }, []);

  const adopt = useCallback(async (wallet: Discovered, accounts: readonly string[]) => {
    const chain = await wallet.provider.request({ method: "eth_chainId" });
    setActive(wallet); setChainId(Number(chain));
    setAddress(accounts[0] ? getAddress(accounts[0]) : null);
    setStatus(accounts[0] ? "connected" : "disconnected");
  }, []);

  // Silent restore (eth_accounts never prompts). Connecting a wallet grants no login or organization permission.
  useEffect(() => {
    if (restored.current || !available.length) return;
    const remembered = localStorage.getItem(REMEMBER);
    const wallet = available.find((d) => d.id === remembered);
    if (!wallet) return;
    restored.current = true;
    wallet.provider.request({ method: "eth_accounts" }).then((accounts) => (accounts.length ? adopt(wallet, accounts) : undefined)).catch(() => undefined);
  }, [available, adopt]);

  useEffect(() => {
    if (!active) return;
    const onAccounts = (accounts: string[]) => {
      setBalances(null);
      if (accounts[0]) setAddress(getAddress(accounts[0])); else { setAddress(null); setStatus("disconnected"); }
    };
    const onChain = (id: string) => { setBalances(null); setChainId(Number(id)); };
    active.provider.on("accountsChanged", onAccounts); active.provider.on("chainChanged", onChain);
    return () => { active.provider.removeListener("accountsChanged", onAccounts); active.provider.removeListener("chainChanged", onChain); };
  }, [active]);

  const connect = useCallback(async (id?: string) => {
    const wallet = available.find((d) => d.id === id) ?? available[0];
    if (!wallet || status === "connecting") return;
    setStatus("connecting"); setFailure(null);
    try {
      await adopt(wallet, await wallet.provider.request({ method: "eth_requestAccounts" }));
      localStorage.setItem(REMEMBER, wallet.id);
    } catch (error) { setFailure(classifyWalletError(error)); setStatus("disconnected"); }
  }, [available, status, adopt]);

  const disconnect = useCallback(async () => {
    localStorage.removeItem(REMEMBER);
    // Best effort: not every wallet implements permission revocation. The app forgets the session regardless.
    await active?.provider.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] } as any).catch(() => undefined);
    setAddress(null); setStatus("disconnected"); setBalances(null); setActive(null);
  }, [active]);

  const switchChain = useCallback(async () => {
    if (!active || !expected) return false;
    setFailure(null);
    const chain = chainOf(expected);
    try {
      try { await active.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(chain.id) }] }); }
      catch (error) {
        if (classifyWalletError(error) !== "CHAIN_NOT_ADDED") throw error;
        await active.provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: numberToHex(chain.id), chainName: chain.name,
          nativeCurrency: chain.nativeCurrency, rpcUrls: [expected.rpcUrl] }] });
      }
      const now = Number(await active.provider.request({ method: "eth_chainId" }));
      setChainId(now); return now === chain.id;
    } catch (error) { setFailure(classifyWalletError(error)); return false; }
  }, [active, expected]);

  const onExpectedChain = !!expected && chainId === expected.chainId;
  const walletsHere = useMemo(() => organizationWallets.filter((w) => expected && Number(w.chain_id) === expected.chainId).map((w) => w.address.toLowerCase()), [organizationWallets, expected]);
  const matchesOrganization = !!address && walletsHere.includes(address.toLowerCase());

  const clients = useCallback(() => {
    if (!active || !address || !expected) return null;
    const chain = chainOf(expected), transport = custom(active.provider);
    return { wallet: createWalletClient({ account: address, chain, transport }), reader: createPublicClient({ chain, transport }) };
  }, [active, address, expected]);

  const refreshBalances = useCallback(async () => {
    const c = clients();
    if (!c || !address || !expected || !onExpectedChain) { setBalances(null); return; }
    try {
      const [native, token] = await Promise.all([c.reader.getBalance({ address }),
        c.reader.readContract({ address: expected.paymentToken as Address, abi: paymentAbi, functionName: "balanceOf", args: [address] })]);
      setBalances({ native, token });
    } catch { setBalances(null); }
  }, [clients, address, expected, onExpectedChain]);
  useEffect(() => { void refreshBalances(); }, [refreshBalances]);

  const value: WalletState = { available, status, address, chainId, walletName: active?.name ?? null, expected, onExpectedChain,
    organizationWallets: walletsHere, matchesOrganization, balances, failure, connect, disconnect, switchChain, refreshBalances, clients };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useWallet(): WalletState {
  const value = useContext(Context);
  if (!value) throw new Error("WalletProvider missing");
  return value;
}
