// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice Restricted, indivisible receivables. No documents or personal data on-chain.
/// @dev Registrars attest to off-chain buyer confirmation; hashes do not prove its truth.
contract ReceivableToken is ERC721, AccessControl {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant SUPPLIER_ROLE = keccak256("SUPPLIER_ROLE");
    bytes32 public constant PAYER_ROLE = keccak256("PAYER_ROLE");
    bytes32 public constant BANK_ROLE = keccak256("BANK_ROLE");

    enum Status { None, Registered, Purchased, Repaid, Cancelled }
    struct Receivable {
        bytes32 tradeKey;
        bytes32 snapshotHash;
        bytes32 confirmationHash;
        address supplier;
        address payer;
        uint256 faceAmount; // Whole KRW, NOT ERC20 base units.
        uint64 dueAt; // Unix seconds.
        Status status;
    }

    mapping(uint256 => Receivable) private _receivables;
    mapping(bytes32 => bool) public usedTradeKeys;
    address public settlement;
    bool private _settlementTransfer;

    error InvalidRegistration();
    error DuplicateReceivable();
    error InvalidState();
    error RestrictedTransfer();
    error OnlySettlement();
    error InvalidSettlement();
    error ParticipantNotApproved();

    event SettlementConfigured(address indexed settlement);
    event ReceivableRegistered(uint256 indexed tokenId, bytes32 indexed tradeKey,
        address indexed supplier, address payer, uint256 faceAmount, uint64 dueAt,
        bytes32 snapshotHash, bytes32 confirmationHash);
    event ReceivableStatusChanged(uint256 indexed tokenId, Status status);

    constructor(address admin) ERC721("PaidAhead Receivable", "PAR") {
        if (admin == address(0)) revert InvalidRegistration();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @dev One-time wiring; admin cannot later replace the transfer path.
    function configureSettlement(address target) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (settlement != address(0) || target.code.length == 0) revert InvalidSettlement();
        settlement = target;
        emit SettlementConfigured(target);
    }

    modifier onlySettlement() {
        if (msg.sender != settlement) revert OnlySettlement();
        _;
    }

    function register(uint256 tokenId, Receivable calldata data) external onlyRole(REGISTRAR_ROLE) {
        if (_receivables[tokenId].status != Status.None || usedTradeKeys[data.tradeKey]) {
            revert DuplicateReceivable();
        }
        if (tokenId == 0 || data.tradeKey == bytes32(0) || data.snapshotHash == bytes32(0)
            || data.confirmationHash == bytes32(0) || data.faceAmount == 0
            || data.faceAmount > uint256(uint64(type(int64).max))
            || data.dueAt <= block.timestamp || data.status != Status.Registered
            || data.supplier == address(0) || data.payer == address(0)
            || data.supplier == data.payer) revert InvalidRegistration();
        if (!hasRole(SUPPLIER_ROLE, data.supplier) || !hasRole(PAYER_ROLE, data.payer)) {
            revert ParticipantNotApproved();
        }
        usedTradeKeys[data.tradeKey] = true;
        _receivables[tokenId] = data;
        // Approved participants only; mint does not call untrusted receiver hooks.
        _mint(data.supplier, tokenId);
        emit ReceivableRegistered(tokenId, data.tradeKey, data.supplier, data.payer,
            data.faceAmount, data.dueAt, data.snapshotHash, data.confirmationHash);
    }

    function getReceivable(uint256 tokenId) external view returns (Receivable memory) {
        return _receivables[tokenId];
    }

    function purchase(uint256 tokenId, address bank) external onlySettlement {
        Receivable storage r = _receivables[tokenId];
        if (r.status != Status.Registered || block.timestamp >= r.dueAt) revert InvalidState();
        if (!hasRole(BANK_ROLE, bank) || !hasRole(SUPPLIER_ROLE, r.supplier)) {
            revert ParticipantNotApproved();
        }
        r.status = Status.Purchased;
        _settlementTransfer = true;
        _transfer(r.supplier, bank, tokenId);
        _settlementTransfer = false;
        emit ReceivableStatusChanged(tokenId, r.status);
    }

    function markRepaid(uint256 tokenId) external onlySettlement {
        Receivable storage r = _receivables[tokenId];
        if (r.status != Status.Purchased) revert InvalidState();
        r.status = Status.Repaid;
        emit ReceivableStatusChanged(tokenId, r.status);
    }

    function cancel(uint256 tokenId) external onlySettlement {
        Receivable storage r = _receivables[tokenId];
        if (r.status != Status.Registered) revert InvalidState();
        r.status = Status.Cancelled;
        emit ReceivableStatusChanged(tokenId, r.status);
    }

    function approve(address, uint256) public pure override { revert RestrictedTransfer(); }
    function setApprovalForAll(address, bool) public pure override { revert RestrictedTransfer(); }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (_ownerOf(tokenId) != address(0) && !_settlementTransfer) revert RestrictedTransfer();
        return super._update(to, tokenId, auth);
    }

    function supportsInterface(bytes4 id) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(id);
    }
}
