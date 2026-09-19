import assert from "node:assert/strict";
import { network } from "hardhat";
import { keccak256, toHex } from "viem";
import { CHAIN_ROLES, toTokenUnits, RECEIVABLE_STATUS } from "@paidahead/domain";

// Always creates an ephemeral local chain. No external RPC, secrets or real funds.
const connection = await network.create("default");
try {
  const { viem, networkHelpers } = connection;
  const client = await viem.getPublicClient();
  const [admin, registrar, supplier, payer, bank] = await viem.getWalletClients();
  const token = await viem.deployContract("ReceivableToken", [admin.account.address]);
  const payment = await viem.deployContract("MockPaymentToken", [admin.account.address]);
  const settlement = await viem.deployContract("Settlement", [token.address, payment.address, bank.account.address]);
  const wait = async (hash: `0x${string}`) => {
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    return hash;
  };
  await wait(await token.write.configureSettlement([settlement.address]));
  for (const [role, wallet] of [
    [CHAIN_ROLES.REGISTRAR_ROLE, registrar], [CHAIN_ROLES.SUPPLIER_ROLE, supplier],
    [CHAIN_ROLES.PAYER_ROLE, payer], [CHAIN_ROLES.BANK_ROLE, bank],
  ] as const) await wait(await token.write.grantRole([role, wallet.account.address]));
  const hash = (value: string) => keccak256(toHex(value));
  const now = (await client.getBlock()).timestamp;
  const dueAt = now + 30n * 86_400n;
  const registration = await wait(await token.write.register([1n, {
    tradeKey: hash("demo-trade-1"), snapshotHash: hash("demo-confirmed-snapshot-1"),
    confirmationHash: hash("demo-buyer-confirmation-1"), supplier: supplier.account.address,
    payer: payer.account.address, faceAmount: 3_000_000n, dueAt, status: RECEIVABLE_STATUS.REGISTERED,
  }], { account: registrar.account }));
  await wait(await payment.write.mint([bank.account.address, toTokenUnits("2970000")]));
  await wait(await payment.write.mint([payer.account.address, toTokenUnits("3000000")]));
  await wait(await payment.write.approve([settlement.address, toTokenUnits("2970000")], { account: bank.account }));
  await wait(await payment.write.approve([settlement.address, toTokenUnits("3000000")], { account: payer.account }));
  await wait(await settlement.write.createOffer([1n, 2_970_000n, now + 86_400n, hash("demo-bank-approval-1")], { account: bank.account }));
  const purchase = await wait(await settlement.write.acceptOffer([1n], { account: supplier.account }));
  assert.equal((await token.read.ownerOf([1n])).toLowerCase(), bank.account.address.toLowerCase());
  assert.equal(await payment.read.balanceOf([supplier.account.address]), toTokenUnits("2970000"));
  await networkHelpers.time.increaseTo(dueAt);
  const repayment = await wait(await settlement.write.repay([1n], { account: payer.account }));
  assert.equal((await token.read.getReceivable([1n])).status, RECEIVABLE_STATUS.REPAID);
  assert.equal(await payment.read.balanceOf([bank.account.address]), toTokenUnits("3000000"));
  console.log(JSON.stringify({
    environment: "ephemeral local demo — no real KRW",
    receivableId: "1", faceAmountKrw: "3000000", purchaseAmountKrw: "2970000",
    finalStatus: "REPAID", transactions: { registration, purchase, repayment },
  }, null, 2));
} finally {
  await connection.close();
}
