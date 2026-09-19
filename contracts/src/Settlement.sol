// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ReceivableToken} from "./ReceivableToken.sol";

/// @notice Single-bank, single-payment-token demo settlement; no custody or resale.
contract Settlement is ReentrancyGuard {
    using SafeERC20 for IERC20;
    enum OfferStatus { None, Active, Withdrawn, Expired, Accepted, Invalidated }
    struct Offer {
        uint256 tokenId;
        address bank;
        uint256 purchaseAmount; // Whole KRW.
        uint64 expiresAt;
        bytes32 approvalReference; // Immutable off-chain review approval reference.
        OfferStatus status;
    }

    ReceivableToken public immutable receivable;
    IERC20 public immutable paymentToken;
    address public immutable designatedBank;
    uint256 public immutable tokenScale;
    uint256 public nextOfferId = 1;
    mapping(uint256 => Offer) public offers;
    mapping(uint256 => uint256) public activeOfferId;

    error InvalidConfiguration();
    error NotAuthorized();
    error InvalidState();
    error InvalidTerms();
    error ActiveOfferExists();
    error OfferNotActive();

    event OfferCreated(uint256 indexed offerId, uint256 indexed tokenId, address indexed bank,
        uint256 purchaseAmount, uint64 expiresAt, bytes32 approvalReference);
    event OfferClosed(uint256 indexed offerId, uint256 indexed tokenId, OfferStatus status);
    event Settled(uint256 indexed tokenId, uint256 indexed offerId, address indexed bank,
        address supplier, address paymentToken, uint256 amountRaw);
    event Repaid(uint256 indexed tokenId, address indexed payer, address indexed recipient,
        address paymentToken, uint256 amountRaw);
    event Cancelled(uint256 indexed tokenId);

    constructor(ReceivableToken token, IERC20Metadata payment, address bank) {
        if (address(token).code.length == 0 || address(payment).code.length == 0
            || bank == address(0)) revert InvalidConfiguration();
        uint8 decimals_ = payment.decimals();
        if (decimals_ > 18) revert InvalidConfiguration();
        receivable = token;
        paymentToken = IERC20(address(payment));
        designatedBank = bank;
        tokenScale = 10 ** decimals_;
    }

    function createOffer(uint256 tokenId, uint256 amount, uint64 expiresAt, bytes32 approvalReference)
        external nonReentrant returns (uint256 offerId)
    {
        _requireBank(msg.sender);
        ReceivableToken.Receivable memory r = receivable.getReceivable(tokenId);
        if (r.status != ReceivableToken.Status.Registered || block.timestamp >= r.dueAt) revert InvalidState();
        if (amount == 0 || amount > r.faceAmount || expiresAt <= block.timestamp
            || expiresAt >= r.dueAt || approvalReference == bytes32(0)) revert InvalidTerms();
        uint256 oldId = activeOfferId[tokenId];
        if (oldId != 0) {
            if (block.timestamp < offers[oldId].expiresAt) revert ActiveOfferExists();
            _close(oldId, OfferStatus.Expired);
        }
        offerId = nextOfferId++;
        offers[offerId] = Offer(tokenId, msg.sender, amount, expiresAt, approvalReference, OfferStatus.Active);
        activeOfferId[tokenId] = offerId;
        emit OfferCreated(offerId, tokenId, msg.sender, amount, expiresAt, approvalReference);
    }

    function withdrawOffer(uint256 offerId) external nonReentrant {
        Offer storage o = offers[offerId];
        // Revoked banks can still withdraw their unconsumed offers.
        if (o.bank != msg.sender) revert NotAuthorized();
        if (o.status != OfferStatus.Active) revert OfferNotActive();
        _close(offerId, block.timestamp >= o.expiresAt ? OfferStatus.Expired : OfferStatus.Withdrawn);
    }

    function acceptOffer(uint256 offerId) external nonReentrant {
        Offer memory o = offers[offerId];
        if (o.status != OfferStatus.Active || activeOfferId[o.tokenId] != offerId
            || block.timestamp >= o.expiresAt) revert OfferNotActive();
        _requireBank(o.bank);
        ReceivableToken.Receivable memory r = receivable.getReceivable(o.tokenId);
        if (r.status != ReceivableToken.Status.Registered || block.timestamp >= r.dueAt) revert InvalidState();
        if (msg.sender != r.supplier || receivable.ownerOf(o.tokenId) != msg.sender) revert NotAuthorized();
        _close(offerId, OfferStatus.Accepted);
        // If ERC20 transfer fails, the receivable transfer and all state changes revert too.
        receivable.purchase(o.tokenId, o.bank);
        uint256 raw = o.purchaseAmount * tokenScale;
        paymentToken.safeTransferFrom(o.bank, msg.sender, raw);
        emit Settled(o.tokenId, offerId, o.bank, msg.sender, address(paymentToken), raw);
    }

    function repay(uint256 tokenId) external nonReentrant {
        ReceivableToken.Receivable memory r = receivable.getReceivable(tokenId);
        if (r.status != ReceivableToken.Status.Purchased) revert InvalidState();
        if (msg.sender != r.payer || !receivable.hasRole(receivable.PAYER_ROLE(), msg.sender)) revert NotAuthorized();
        address recipient = receivable.ownerOf(tokenId);
        // Repayment is allowed early and late; no new-purchase permission required for recipient.
        receivable.markRepaid(tokenId);
        uint256 raw = r.faceAmount * tokenScale;
        paymentToken.safeTransferFrom(msg.sender, recipient, raw);
        emit Repaid(tokenId, msg.sender, recipient, address(paymentToken), raw);
    }

    function cancel(uint256 tokenId) external nonReentrant {
        ReceivableToken.Receivable memory r = receivable.getReceivable(tokenId);
        if (r.status != ReceivableToken.Status.Registered) revert InvalidState();
        if (msg.sender != r.supplier || receivable.ownerOf(tokenId) != msg.sender) revert NotAuthorized();
        uint256 offerId = activeOfferId[tokenId];
        if (offerId != 0) _close(offerId, OfferStatus.Invalidated);
        receivable.cancel(tokenId);
        emit Cancelled(tokenId);
    }

    function effectiveOfferStatus(uint256 offerId) external view returns (OfferStatus) {
        Offer memory o = offers[offerId];
        if (o.status == OfferStatus.Active && block.timestamp >= o.expiresAt) return OfferStatus.Expired;
        return o.status;
    }

    function _requireBank(address bank) private view {
        if (bank != designatedBank || !receivable.hasRole(receivable.BANK_ROLE(), bank)) revert NotAuthorized();
    }

    function _close(uint256 offerId, OfferStatus status) private {
        Offer storage o = offers[offerId];
        o.status = status;
        delete activeOfferId[o.tokenId];
        emit OfferClosed(offerId, o.tokenId, status);
    }
}
