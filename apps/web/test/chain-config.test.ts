import { test } from "node:test";
import assert from "node:assert/strict";
import { browserRpc, walletChain, transactionLink, INJECTIVE_TESTNET_RPC } from "../src/lib/chain-config.ts";
test("testnet wallet uses INJ and the correct explorer", () => {
  const chain = walletChain({ chainId: 1439, rpcUrl: INJECTIVE_TESTNET_RPC });
  assert.equal(chain.nativeCurrency.symbol, "INJ");
  assert.match(chain.blockExplorers!.default.url, /testnet/);
  assert.throws(() => walletChain({ chainId: 1776, rpcUrl: INJECTIVE_TESTNET_RPC }));
});
test("browser RPC allows explicit public testnet only, without leaking secrets", () => {
  assert.equal(browserRpc(INJECTIVE_TESTNET_RPC, "injective-testnet"), INJECTIVE_TESTNET_RPC);
  assert.match(browserRpc("http://127.0.0.1:8545"), /8545/);
  for (const url of [INJECTIVE_TESTNET_RPC, "https://evil.example", "https://user:secret@k8s.testnet.json-rpc.injective.network", INJECTIVE_TESTNET_RPC + "?key=secret", "file://localhost/x"]) {
    assert.throws(() => browserRpc(url));
  }
  assert.throws(() => browserRpc("https://sentry.evm-rpc.injective.network/", "injective-testnet"));
});
test("transaction links accept only testnet hashes", () => {
  assert.match(transactionLink(1439, "0x" + "a".repeat(64))!, /\/tx\/0x/);
  assert.equal(transactionLink(31337, "0x" + "a".repeat(64)), null);
  assert.equal(transactionLink(1439, "javascript:alert(1)"), null);
});
