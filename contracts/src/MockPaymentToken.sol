// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice Demo tokens only. No redemption claim on KRW.
contract MockPaymentToken is ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    constructor(address admin) ERC20("PaidAhead Mock KRW", "mKRW") {
        require(admin != address(0), "zero admin");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) { _mint(to, amount); }
}
