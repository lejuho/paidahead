// Automation-only EIP-1193 wallet for Playwright. It is injected by the test runner and is NOT part of the web bundle.
// Signing happens in Node with the public Hardhat accounts, against a loopback chain only.
import { createWalletClient, http, numberToHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

export const HARDHAT_INDEX = { supplier: 2, buyer: 3, bank: 4 };
const account = (index) => mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: index });
const rpcError = (code, message) => ({ __error: { code, message } });

export async function attachTestWallet(context, rpcUrl, initialRole) {
  if (!["127.0.0.1", "localhost"].includes(new URL(rpcUrl).hostname)) throw new Error("Test wallet is loopback-only");
  const state = { account: account(HARDHAT_INDEX[initialRole]), chainId: 31337, rejectNext: false, sent: [], pages: new Set() };
  const rpc = async (method, params) => {
    const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }) });
    const body = await res.json();
    return body.error ? rpcError(body.error.code, body.error.message) : body.result;
  };
  await context.exposeFunction("__paWalletRequest", async (method, params) => {
    switch (method) {
      case "eth_requestAccounts": case "eth_accounts": return [state.account.address];
      case "eth_chainId": return numberToHex(state.chainId);
      case "wallet_revokePermissions": return null;
      case "wallet_switchEthereumChain": {
        const target = Number(params[0].chainId);
        if (target !== 31337) return rpcError(4902, "Unrecognized chain");
        state.chainId = target; await emit("chainChanged", numberToHex(target)); return null;
      }
      case "eth_sendTransaction": {
        if (state.rejectNext) { state.rejectNext = false; return rpcError(4001, "User rejected the request."); }
        if (state.chainId !== 31337) return rpcError(-32603, "Wallet is on another network");
        const tx = params[0];
        if (tx.from.toLowerCase() !== state.account.address.toLowerCase()) return rpcError(-32603, "Unknown account");
        const client = createWalletClient({ account: state.account, transport: http(rpcUrl) });
        try {
          const hash = await client.sendTransaction({ chain: null, to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0), type: "legacy",
            gasPrice: BigInt(tx.gasPrice), ...(tx.gas ? { gas: BigInt(tx.gas) } : {}) });
          state.sent.push({ to: tx.to.toLowerCase(), data: tx.data, hash }); return hash;
        } catch (error) { return rpcError(-32603, error.shortMessage ?? error.message); }
      }
      default: return state.chainId === 31337 ? rpc(method, params) : rpcError(-32603, "Wrong network in test wallet");
    }
  });
  await context.addInitScript(() => {
    const listeners = {};
    const provider = {
      request: async ({ method, params }) => { const r = await window.__paWalletRequest(method, params); if (r && r.__error) throw Object.assign(new Error(r.__error.message), { code: r.__error.code }); return r; },
      on: (event, fn) => { (listeners[event] ??= new Set()).add(fn); }, removeListener: (event, fn) => listeners[event]?.delete(fn),
    };
    window.__paWalletEmit = (event, value) => listeners[event]?.forEach((fn) => fn(value));
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ provider,
      info: { uuid: "paidahead-e2e-wallet", name: "자동화 테스트 지갑", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", rdns: "local.paidahead.e2e" } }) }));
    window.addEventListener("eip6963:requestProvider", announce); announce();
  });
  context.on("page", (page) => { state.pages.add(page); page.on("close", () => state.pages.delete(page)); });
  async function emit(event, value) { for (const page of state.pages) await page.evaluate(([e, v]) => window.__paWalletEmit?.(e, v), [event, value]).catch(() => undefined); }
  return {
    state, address: () => state.account.address,
    useRole: async (role) => { state.account = account(HARDHAT_INDEX[role]); await emit("accountsChanged", [state.account.address]); },
    setChain: async (id) => { state.chainId = id; await emit("chainChanged", numberToHex(id)); },
    rejectNext: () => { state.rejectNext = true; },
  };
}
