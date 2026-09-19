import { network } from "hardhat";
import { keccak256, toHex } from "viem";
import { CHAIN_ROLES, hashSnapshot, toTokenUnits } from "@paidahead/domain";

export const digest = (value: string) => keccak256(toHex(value));
export const FACE = 3_000_000n;
export const PRICE = 2_970_000n;
export const raw = (amount: bigint) => toTokenUnits(amount.toString());

export async function setup() {
  const connection = await network.create();
  const { viem, networkHelpers } = connection;
  const [admin, registrar, supplier, payer, bank, outsider] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const token = await viem.deployContract("ReceivableToken", [admin.account.address]);
  const payment = await viem.deployContract("MockPaymentToken", [admin.account.address]);
  const settlement = await viem.deployContract("Settlement", [token.address, payment.address, bank.account.address]);
  await token.write.configureSettlement([settlement.address]);
  for (const [role, wallet] of [
    [CHAIN_ROLES.REGISTRAR_ROLE, registrar], [CHAIN_ROLES.SUPPLIER_ROLE, supplier],
    [CHAIN_ROLES.PAYER_ROLE, payer], [CHAIN_ROLES.BANK_ROLE, bank],
  ] as const) await token.write.grantRole([role, wallet.account.address]);
  const now = (await publicClient.getBlock()).timestamp;
  const dueAt = now + 30n * 86_400n;
  const expiresAt = now + 86_400n;
  const snapshotHash = hashSnapshot({
    schemaVersion: 1, applicationId: "demo-application-1", revision: 1,
    supplierOrgId: "demo-supplier", buyerOrgId: "demo-restaurant", targetBankOrgId: "demo-bank",
    tradeReference: "demo-invoice-1", faceAmountKrw: FACE.toString(), currency: "KRW",
    dueAt: dueAt.toString(), documents: [{ documentId: "invoice", sha256: "a".repeat(64) }],
    reviewedFieldsHash: digest("reviewed-fields"), consentVersion: "v1",
  });
  const data = {
    tradeKey: digest("supplier:restaurant:invoice-1"), snapshotHash,
    confirmationHash: digest("confirmed-revision-1"), supplier: supplier.account.address,
    payer: payer.account.address, faceAmount: FACE, dueAt, status: 1,
  } as const;
  const register = () => token.write.register([1n, data], { account: registrar.account });
  const offer = () => settlement.write.createOffer([1n, PRICE, expiresAt, digest("bank-approval-1")], { account: bank.account });
  const fund = async () => {
    await payment.write.mint([bank.account.address, raw(PRICE)]);
    await payment.write.mint([payer.account.address, raw(FACE)]);
    await payment.write.approve([settlement.address, raw(PRICE)], { account: bank.account });
    await payment.write.approve([settlement.address, raw(FACE)], { account: payer.account });
  };
  const accept = () => settlement.write.acceptOffer([1n], { account: supplier.account });
  const repay = () => settlement.write.repay([1n], { account: payer.account });
  const purchased = async () => { await register(); await offer(); await fund(); await accept(); };
  return { connection, viem, networkHelpers, publicClient, admin, registrar, supplier, payer, bank,
    outsider, token, payment, settlement, now, dueAt, expiresAt, data, register, offer, fund, accept, repay, purchased };
}
