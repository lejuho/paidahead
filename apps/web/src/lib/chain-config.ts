import { defineChain } from "viem";

export const INJECTIVE_TESTNET_RPC = "https://k8s.testnet.json-rpc.injective.network/";
export const TESTNET_EXPLORER = "https://testnet.blockscout.injective.network";
export function walletChain(info: { chainId: number; rpcUrl: string }) {
  if (![31337, 1439].includes(info.chainId)) throw new Error("Unsupported demo network");
  const testnet = info.chainId === 1439;
  return defineChain({ id: info.chainId, name: testnet ? "Injective EVM Testnet" : "PaidAhead 로컬 (31337)",
    nativeCurrency: { name: testnet ? "Injective" : "Ether", symbol: testnet ? "INJ" : "ETH", decimals: 18 },
    rpcUrls: { default: { http: [info.rpcUrl] } }, testnet: true,
    ...(testnet ? { blockExplorers: { default: { name: "Injective Blockscout", url: TESTNET_EXPLORER } } } : {}) });
}
export function browserRpc(value: string, environment?: string) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error("Browser RPC must not contain credentials");
  const local = ["localhost", "127.0.0.1"].includes(url.hostname) && ["http:", "https:"].includes(url.protocol);
  const testnet = environment === "injective-testnet" && url.protocol === "https:" &&
    ["k8s.testnet.json-rpc.injective.network", "testnet.evm.archival.chain.virtual.json-rpc.injective.network"].includes(url.hostname) && !url.port && url.pathname === "/";
  if (!local && !testnet) throw new Error("Unsupported browser RPC");
  return url.toString();
}
export function transactionLink(chainId: number | undefined, hash: string) {
  return chainId === 1439 && /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${TESTNET_EXPLORER}/tx/${hash}` : null;
}
