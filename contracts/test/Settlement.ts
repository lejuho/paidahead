import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { CHAIN_ROLES, RECEIVABLE_STATUS, OFFER_STATUS } from "@paidahead/domain";
import { zeroHash } from "viem";
import { setup, FACE, PRICE, raw, digest } from "./fixtures.js";

describe("PaidAhead v1", () => {
  let f: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { f = await setup(); });
  afterEach(async () => { await f?.connection.close(); });

  it("registers, atomically buys for 2.97M and repays face value 3M with events", async () => {
    await f.viem.assertions.emit(f.register(), f.token, "ReceivableRegistered");
    assert.equal((await f.token.read.getReceivable([1n])).snapshotHash, f.data.snapshotHash);
    await f.offer(); await f.fund();
    await f.viem.assertions.emitWithArgs(f.accept(), f.settlement, "Settled", [
      1n, 1n, f.bank.account.address, f.supplier.account.address, f.payment.address, raw(PRICE),
    ]);
    assert.equal((await f.token.read.ownerOf([1n])).toLowerCase(), f.bank.account.address.toLowerCase());
    assert.equal(await f.payment.read.balanceOf([f.supplier.account.address]), raw(PRICE));
    assert.equal(await f.payment.read.balanceOf([f.bank.account.address]), 0n);
    assert.equal((await f.token.read.getReceivable([1n])).status, RECEIVABLE_STATUS.PURCHASED);
    await f.viem.assertions.emitWithArgs(f.repay(), f.settlement, "Repaid", [
      1n, f.payer.account.address, f.bank.account.address, f.payment.address, raw(FACE),
    ]);
    assert.equal(await f.payment.read.balanceOf([f.bank.account.address]), raw(FACE));
    assert.equal(await f.payment.read.balanceOf([f.payer.account.address]), 0n);
    assert.equal((await f.token.read.getReceivable([1n])).status, RECEIVABLE_STATUS.REPAID);
  });

  it("only a registrar can attest confirmation; zero references and expired registrations fail", async () => {
    await f.viem.assertions.revertWithCustomError(f.token.write.register([1n, f.data]), f.token, "AccessControlUnauthorizedAccount");
    for (const changed of [
      { confirmationHash: zeroHash }, { snapshotHash: zeroHash },
      { faceAmount: 0n }, { dueAt: f.now }, { status: 0 },
    ]) await f.viem.assertions.revertWithCustomError(
      f.token.write.register([1n, { ...f.data, ...changed }], { account: f.registrar.account }), f.token, "InvalidRegistration",
    );
  });

  it("rejects unapproved participants and duplicate token IDs or trade keys", async () => {
    await f.viem.assertions.revertWithCustomError(
      f.token.write.register([1n, { ...f.data, payer: f.outsider.account.address }], { account: f.registrar.account }),
      f.token, "ParticipantNotApproved",
    );
    await f.register();
    await f.viem.assertions.revertWithCustomError(f.register(), f.token, "DuplicateReceivable");
    await f.viem.assertions.revertWithCustomError(
      f.token.write.register([2n, f.data], { account: f.registrar.account }), f.token, "DuplicateReceivable",
    );
  });

  it("rejects public transfers, safe transfers, approvals and direct status mutations", async () => {
    await f.register();
    await f.viem.assertions.revertWithCustomError(
      f.token.write.transferFrom([f.supplier.account.address, f.outsider.account.address, 1n], { account: f.supplier.account }),
      f.token, "RestrictedTransfer",
    );
    await f.viem.assertions.revertWithCustomError(
      f.token.write.safeTransferFrom([f.supplier.account.address, f.outsider.account.address, 1n], { account: f.supplier.account }),
      f.token, "RestrictedTransfer",
    );
    await f.viem.assertions.revertWithCustomError(
      f.token.read.approve([f.outsider.account.address, 1n]), f.token, "RestrictedTransfer",
    );
    await f.viem.assertions.revertWithCustomError(
      f.token.read.setApprovalForAll([f.outsider.account.address, true]), f.token, "RestrictedTransfer",
    );
    await f.viem.assertions.revertWithCustomError(f.token.write.purchase([1n, f.bank.account.address]), f.token, "OnlySettlement");
    await f.viem.assertions.revertWithCustomError(f.token.write.markRepaid([1n]), f.token, "OnlySettlement");
    await f.viem.assertions.revertWithCustomError(f.token.write.cancel([1n]), f.token, "OnlySettlement");
    await f.viem.assertions.revertWithCustomError(f.token.write.configureSettlement([f.settlement.address]), f.token, "InvalidSettlement");
  });

  it("only the designated approved bank can offer, with bounded amount and expiry", async () => {
    await f.register();
    await f.token.write.grantRole([CHAIN_ROLES.BANK_ROLE, f.outsider.account.address]);
    await f.viem.assertions.revertWithCustomError(
      f.settlement.write.createOffer([1n, PRICE, f.expiresAt, digest("approval")], { account: f.outsider.account }),
      f.settlement, "NotAuthorized",
    );
    for (const [amount, expiry] of [[0n, f.expiresAt], [FACE + 1n, f.expiresAt], [PRICE, f.dueAt], [PRICE, f.now]]) {
      await f.viem.assertions.revertWithCustomError(
        f.settlement.write.createOffer([1n, amount, expiry, digest("approval")], { account: f.bank.account }),
        f.settlement, "InvalidTerms",
      );
    }
  });

  it("serializes competing offers and supports withdrawal before replacement", async () => {
    await f.register(); await f.offer();
    await f.viem.assertions.revertWithCustomError(f.offer(), f.settlement, "ActiveOfferExists");
    await f.viem.assertions.revertWithCustomError(
      f.settlement.write.withdrawOffer([1n], { account: f.outsider.account }), f.settlement, "NotAuthorized",
    );
    await f.settlement.write.withdrawOffer([1n], { account: f.bank.account });
    await f.viem.assertions.revertWithCustomError(f.accept(), f.settlement, "OfferNotActive");
    await f.offer();
    assert.equal(await f.settlement.read.activeOfferId([1n]), 2n);
  });

  it("rejects expired offers and allows a new offer after expiry", async () => {
    await f.register(); await f.offer(); await f.fund();
    await f.networkHelpers.time.increaseTo(f.expiresAt);
    assert.equal(await f.settlement.read.effectiveOfferStatus([1n]), OFFER_STATUS.EXPIRED);
    await f.viem.assertions.revertWithCustomError(f.accept(), f.settlement, "OfferNotActive");
    await f.settlement.write.createOffer([1n, PRICE, f.expiresAt + 86_400n, digest("approval-2")], { account: f.bank.account });
    assert.equal(await f.settlement.read.activeOfferId([1n]), 2n);
  });

  for (const cause of ["balance", "allowance"] as const) {
    it(`rolls back token ownership, offer and balances on insufficient bank ${cause}`, async () => {
      await f.register(); await f.offer();
      if (cause === "balance") await f.payment.write.approve([f.settlement.address, raw(PRICE)], { account: f.bank.account });
      else await f.payment.write.mint([f.bank.account.address, raw(PRICE)]);
      const before = await f.payment.read.balanceOf([f.bank.account.address]);
      await f.viem.assertions.revertWithCustomError(f.accept(), f.payment,
        cause === "balance" ? "ERC20InsufficientBalance" : "ERC20InsufficientAllowance");
      assert.equal((await f.token.read.ownerOf([1n])).toLowerCase(), f.supplier.account.address.toLowerCase());
      assert.equal((await f.token.read.getReceivable([1n])).status, RECEIVABLE_STATUS.REGISTERED);
      assert.equal(await f.payment.read.balanceOf([f.bank.account.address]), before);
      assert.equal(await f.payment.read.balanceOf([f.supplier.account.address]), 0n);
      assert.equal(await f.settlement.read.effectiveOfferStatus([1n]), OFFER_STATUS.ACTIVE);
      assert.equal(await f.settlement.read.activeOfferId([1n]), 1n);
    });
  }

  it("rechecks bank and supplier authorization at execution", async () => {
    await f.register(); await f.offer(); await f.fund();
    await f.token.write.revokeRole([CHAIN_ROLES.BANK_ROLE, f.bank.account.address]);
    await f.viem.assertions.revertWithCustomError(f.accept(), f.settlement, "NotAuthorized");
    await f.token.write.grantRole([CHAIN_ROLES.BANK_ROLE, f.bank.account.address]);
    await f.token.write.revokeRole([CHAIN_ROLES.SUPPLIER_ROLE, f.supplier.account.address]);
    await f.viem.assertions.revertWithCustomError(f.accept(), f.token, "ParticipantNotApproved");
    assert.equal(await f.payment.read.balanceOf([f.bank.account.address]), raw(PRICE));
  });

  it("blocks another seller, duplicate acceptance, cancellation and resale after purchase", async () => {
    await f.register(); await f.offer(); await f.fund();
    await f.viem.assertions.revertWithCustomError(
      f.settlement.write.acceptOffer([1n], { account: f.outsider.account }), f.settlement, "NotAuthorized",
    );
    await f.accept();
    await f.viem.assertions.revertWithCustomError(f.accept(), f.settlement, "OfferNotActive");
    await f.viem.assertions.revertWithCustomError(f.offer(), f.settlement, "InvalidState");
    await f.viem.assertions.revertWithCustomError(
      f.settlement.write.cancel([1n], { account: f.supplier.account }), f.settlement, "InvalidState",
    );
    await f.viem.assertions.revertWithCustomError(
      f.token.write.transferFrom([f.bank.account.address, f.supplier.account.address, 1n], { account: f.bank.account }),
      f.token, "RestrictedTransfer",
    );
    assert.equal(await f.payment.read.balanceOf([f.supplier.account.address]), raw(PRICE));
  });

  it("cancellation invalidates the offer and permanently consumes the trade key", async () => {
    await f.register(); await f.offer();
    await f.viem.assertions.revertWithCustomError(
      f.settlement.write.cancel([1n], { account: f.outsider.account }), f.settlement, "NotAuthorized",
    );
    await f.settlement.write.cancel([1n], { account: f.supplier.account });
    assert.equal((await f.token.read.getReceivable([1n])).status, RECEIVABLE_STATUS.CANCELLED);
    assert.equal(await f.settlement.read.effectiveOfferStatus([1n]), OFFER_STATUS.INVALIDATED);
    await f.viem.assertions.revertWithCustomError(f.accept(), f.settlement, "OfferNotActive");
    await f.viem.assertions.revertWithCustomError(
      f.token.write.register([2n, f.data], { account: f.registrar.account }), f.token, "DuplicateReceivable",
    );
  });

  it("rejects purchases at maturity and repayment of an unpurchased receivable", async () => {
    await f.register();
    await f.viem.assertions.revertWithCustomError(f.repay(), f.settlement, "InvalidState");
    await f.networkHelpers.time.increaseTo(f.dueAt);
    await f.viem.assertions.revertWithCustomError(f.offer(), f.settlement, "InvalidState");
  });

  it("only the designated approved payer can repay and repeat repayment never debits again", async () => {
    await f.purchased();
    await f.viem.assertions.revertWithCustomError(
      f.settlement.write.repay([1n], { account: f.supplier.account }), f.settlement, "NotAuthorized",
    );
    await f.token.write.revokeRole([CHAIN_ROLES.PAYER_ROLE, f.payer.account.address]);
    await f.viem.assertions.revertWithCustomError(f.repay(), f.settlement, "NotAuthorized");
    await f.token.write.grantRole([CHAIN_ROLES.PAYER_ROLE, f.payer.account.address]);
    await f.repay();
    await f.viem.assertions.revertWithCustomError(f.repay(), f.settlement, "InvalidState");
    assert.equal(await f.payment.read.balanceOf([f.bank.account.address]), raw(FACE));
  });

  it("failed repayment rolls back REPAID and supports retry with full funds", async () => {
    await f.purchased();
    await f.payment.write.transfer([f.outsider.account.address, 1n], { account: f.payer.account });
    await f.viem.assertions.revertWithCustomError(f.repay(), f.payment, "ERC20InsufficientBalance");
    assert.equal((await f.token.read.getReceivable([1n])).status, RECEIVABLE_STATUS.PURCHASED);
    assert.equal(await f.payment.read.balanceOf([f.bank.account.address]), 0n);
    await f.payment.write.mint([f.payer.account.address, 1n]);
    await f.repay();
    assert.equal(await f.payment.read.balanceOf([f.bank.account.address]), raw(FACE));
  });

  it("allows late repayment to a bank even after its new-purchase permission is revoked", async () => {
    await f.purchased();
    await f.token.write.revokeRole([CHAIN_ROLES.BANK_ROLE, f.bank.account.address]);
    await f.networkHelpers.time.increaseTo(f.dueAt + 1n);
    await f.repay();
    assert.equal((await f.token.read.getReceivable([1n])).status, RECEIVABLE_STATUS.REPAID);
    assert.equal(await f.payment.read.balanceOf([f.bank.account.address]), raw(FACE));
  });

  it("only the demo minter can issue payment tokens", async () => {
    await f.viem.assertions.revertWithCustomError(
      f.payment.write.mint([f.outsider.account.address, raw(FACE)], { account: f.outsider.account }),
      f.payment, "AccessControlUnauthorizedAccount",
    );
  });
});
