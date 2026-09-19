import { parseAbi } from "viem";

/** Shared by API calldata builders and the receipt/event verifier. */
export const settlementAbi = parseAbi([
  "function createOffer(uint256 tokenId, uint256 amount, uint64 expiresAt, bytes32 approvalReference) returns (uint256)",
  "function withdrawOffer(uint256 offerId)", "function acceptOffer(uint256 offerId)",
  "function repay(uint256 tokenId)", "function cancel(uint256 tokenId)",
  "function receivable() view returns (address)", "function paymentToken() view returns (address)",
  "function designatedBank() view returns (address)", "function tokenScale() view returns (uint256)",
  "event OfferCreated(uint256 indexed offerId, uint256 indexed tokenId, address indexed bank, uint256 purchaseAmount, uint64 expiresAt, bytes32 approvalReference)",
  "event OfferClosed(uint256 indexed offerId, uint256 indexed tokenId, uint8 status)",
  "event Settled(uint256 indexed tokenId, uint256 indexed offerId, address indexed bank, address supplier, address paymentToken, uint256 amountRaw)",
  "event Repaid(uint256 indexed tokenId, address indexed payer, address indexed recipient, address paymentToken, uint256 amountRaw)",
  "event Cancelled(uint256 indexed tokenId)",
]);
export const paymentAbi = parseAbi([
  "function approve(address spender,uint256 amount) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);
