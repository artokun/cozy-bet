// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title CozyBetEscrow
 * @notice Two-party USDC escrow with mutual-consent or arbiter resolution.
 *         Per-side fee in basis points (default 250 = 2.5%); each side can
 *         independently buy down their fee (e.g. to 150 bps via social share)
 *         off-chain — bot calls setFeeBpsForSide. Standard fee splits evenly
 *         across 4 treasury owners. Draw outcome refunds both sides without
 *         fee. Arbiter resolution skims max(arbiterMinFee, 1% of pot) for
 *         the arbiter, then proceeds normally.
 */
contract CozyBetEscrow is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------
    // Roles
    // ---------------------------------------------------------------

    bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");
    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");

    // ---------------------------------------------------------------
    // Config
    // ---------------------------------------------------------------

    /// @notice The single ERC20 token used for all bets (e.g. USDC).
    IERC20 public immutable token;

    /// @notice Four addresses that receive equal shares of the standard fee.
    address[4] public treasuryOwners;

    /// @notice Default per-side fee in basis points. 250 = 2.5%.
    uint16 public defaultFeeBps;

    /// @notice Minimum per-side fee bps reachable via discounts. 150 = 1.5%.
    uint16 public minDiscountedFeeBps;

    /// @notice Arbiter fee floor in token atomic units (e.g. 100e6 = $100 USDC).
    uint256 public arbiterMinFee;

    /// @notice Arbiter fee as a fraction of the pot. 100 = 1%.
    uint16 public arbiterFeeBpsOfPot;

    uint16 public constant BPS_DENOMINATOR = 10_000;

    // ---------------------------------------------------------------
    // State
    // ---------------------------------------------------------------

    enum BetStatus {
        None,
        Pending,
        Funded,
        Resolved,
        Drawn,
        Refunded
    }

    struct Bet {
        uint256 amount;
        address challenger;
        address accepter;
        uint16 challengerFeeBps;
        uint16 accepterFeeBps;
        bool challengerDeposited;
        bool accepterDeposited;
        BetStatus status;
        address winner;
    }

    mapping(uint256 => Bet) public bets;

    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    event BetInitialized(
        uint256 indexed betId, address indexed challenger, address indexed accepter, uint256 amount
    );
    event Deposited(uint256 indexed betId, address indexed depositor, uint256 amount);
    event Funded(uint256 indexed betId);
    event Resolved(uint256 indexed betId, address indexed winner, uint256 payout, uint256 fee);
    event Drawn(uint256 indexed betId);
    event Refunded(uint256 indexed betId);
    event ArbiterResolved(
        uint256 indexed betId, address indexed winner, address indexed arbiter, uint256 arbiterFee
    );
    event FeeDiscountApplied(uint256 indexed betId, address indexed side, uint16 newBps);
    event TreasuryOwnerUpdated(uint256 indexed index, address indexed newOwner);
    event ConfigUpdated(string field, uint256 value);

    // ---------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------

    error BetNotFound();
    error BetAlreadyExists();
    error NotParticipant();
    error AlreadyDeposited();
    error InvalidState();
    error WinnerNotParticipant();
    error InvalidFeeBps();
    error ZeroAddress();
    error SameAddresses();
    error AmountZero();
    error PotTooSmallForArbiter();
    error IndexOutOfRange();

    // ---------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------

    constructor(IERC20 _token, address[4] memory _treasuryOwners, address admin) {
        if (address(_token) == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();
        for (uint256 i = 0; i < 4; i++) {
            if (_treasuryOwners[i] == address(0)) revert ZeroAddress();
            treasuryOwners[i] = _treasuryOwners[i];
        }
        token = _token;
        defaultFeeBps = 250;
        minDiscountedFeeBps = 150;
        arbiterMinFee = 100e6; // $100 in 6-dec USDC atoms
        arbiterFeeBpsOfPot = 100; // 1%
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RESOLVER_ROLE, admin);
        _grantRole(ARBITER_ROLE, admin);
    }

    // ---------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------

    function setDefaultFeeBps(uint16 newBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newBps > BPS_DENOMINATOR) revert InvalidFeeBps();
        defaultFeeBps = newBps;
        emit ConfigUpdated("defaultFeeBps", newBps);
    }

    function setMinDiscountedFeeBps(uint16 newBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newBps > defaultFeeBps) revert InvalidFeeBps();
        minDiscountedFeeBps = newBps;
        emit ConfigUpdated("minDiscountedFeeBps", newBps);
    }

    function setArbiterFeeConfig(uint256 newMinFee, uint16 newBpsOfPot)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (newBpsOfPot > BPS_DENOMINATOR) revert InvalidFeeBps();
        arbiterMinFee = newMinFee;
        arbiterFeeBpsOfPot = newBpsOfPot;
        emit ConfigUpdated("arbiterMinFee", newMinFee);
        emit ConfigUpdated("arbiterFeeBpsOfPot", newBpsOfPot);
    }

    function setTreasuryOwner(uint256 index, address newOwner)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (index >= 4) revert IndexOutOfRange();
        if (newOwner == address(0)) revert ZeroAddress();
        treasuryOwners[index] = newOwner;
        emit TreasuryOwnerUpdated(index, newOwner);
    }

    // ---------------------------------------------------------------
    // Lifecycle (resolver-only)
    // ---------------------------------------------------------------

    function initializeBet(uint256 betId, uint256 amount, address challenger, address accepter)
        external
        onlyRole(RESOLVER_ROLE)
    {
        if (bets[betId].status != BetStatus.None) revert BetAlreadyExists();
        if (amount == 0) revert AmountZero();
        if (challenger == address(0) || accepter == address(0)) revert ZeroAddress();
        if (challenger == accepter) revert SameAddresses();

        Bet storage b = bets[betId];
        b.amount = amount;
        b.challenger = challenger;
        b.accepter = accepter;
        b.challengerFeeBps = defaultFeeBps;
        b.accepterFeeBps = defaultFeeBps;
        b.status = BetStatus.Pending;

        emit BetInitialized(betId, challenger, accepter, amount);
    }

    function deposit(uint256 betId) external nonReentrant {
        Bet storage b = bets[betId];
        if (b.status != BetStatus.Pending) revert InvalidState();
        bool isChallenger = msg.sender == b.challenger;
        bool isAccepter = msg.sender == b.accepter;
        if (!isChallenger && !isAccepter) revert NotParticipant();
        if (isChallenger && b.challengerDeposited) revert AlreadyDeposited();
        if (isAccepter && b.accepterDeposited) revert AlreadyDeposited();

        token.safeTransferFrom(msg.sender, address(this), b.amount);

        if (isChallenger) {
            b.challengerDeposited = true;
        } else {
            b.accepterDeposited = true;
        }

        emit Deposited(betId, msg.sender, b.amount);

        if (b.challengerDeposited && b.accepterDeposited) {
            b.status = BetStatus.Funded;
            emit Funded(betId);
        }
    }

    /// @notice Reduce a participant's per-side fee bps. Bot calls this after
    ///         verifying the user shared the bet on social. One-way (cannot
    ///         increase fee). Floor at minDiscountedFeeBps.
    function setFeeBpsForSide(uint256 betId, address side, uint16 newBps)
        external
        onlyRole(RESOLVER_ROLE)
    {
        Bet storage b = bets[betId];
        if (b.status == BetStatus.None) revert BetNotFound();
        if (b.status != BetStatus.Pending && b.status != BetStatus.Funded) revert InvalidState();
        if (newBps < minDiscountedFeeBps) revert InvalidFeeBps();
        if (side == b.challenger) {
            if (newBps >= b.challengerFeeBps) revert InvalidFeeBps();
            b.challengerFeeBps = newBps;
        } else if (side == b.accepter) {
            if (newBps >= b.accepterFeeBps) revert InvalidFeeBps();
            b.accepterFeeBps = newBps;
        } else {
            revert NotParticipant();
        }
        emit FeeDiscountApplied(betId, side, newBps);
    }

    function resolve(uint256 betId, address winner)
        external
        onlyRole(RESOLVER_ROLE)
        nonReentrant
    {
        _resolveCommon(betId, winner, address(0), 0);
    }

    /// @notice Arbiter forces a resolution on a Funded bet, taking
    ///         max(arbiterMinFee, pot * arbiterFeeBpsOfPot / 10000) from the
    ///         pot. Arbiter must hold ARBITER_ROLE; fee is paid to msg.sender.
    function arbiterResolve(uint256 betId, address winner)
        external
        onlyRole(ARBITER_ROLE)
        nonReentrant
    {
        Bet storage b = bets[betId];
        if (b.status != BetStatus.Funded) revert InvalidState();
        uint256 pot = b.amount * 2;
        uint256 byBps = (pot * arbiterFeeBpsOfPot) / BPS_DENOMINATOR;
        uint256 fee = byBps > arbiterMinFee ? byBps : arbiterMinFee;
        // Standard fee on top
        uint256 standardFee =
            (b.amount * b.challengerFeeBps + b.amount * b.accepterFeeBps) / BPS_DENOMINATOR;
        if (fee + standardFee >= pot) revert PotTooSmallForArbiter();
        _resolveCommon(betId, winner, msg.sender, fee);
    }

    function draw(uint256 betId) external onlyRole(RESOLVER_ROLE) nonReentrant {
        Bet storage b = bets[betId];
        if (b.status != BetStatus.Funded) revert InvalidState();
        b.status = BetStatus.Drawn;
        token.safeTransfer(b.challenger, b.amount);
        token.safeTransfer(b.accepter, b.amount);
        emit Drawn(betId);
    }

    function refund(uint256 betId) external onlyRole(RESOLVER_ROLE) nonReentrant {
        Bet storage b = bets[betId];
        if (b.status != BetStatus.Pending && b.status != BetStatus.Funded) revert InvalidState();
        b.status = BetStatus.Refunded;
        if (b.challengerDeposited) token.safeTransfer(b.challenger, b.amount);
        if (b.accepterDeposited) token.safeTransfer(b.accepter, b.amount);
        emit Refunded(betId);
    }

    // ---------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------

    function _resolveCommon(uint256 betId, address winner, address arbiter, uint256 arbiterFee)
        internal
    {
        Bet storage b = bets[betId];
        if (b.status != BetStatus.Funded) revert InvalidState();
        if (winner != b.challenger && winner != b.accepter) revert WinnerNotParticipant();

        uint256 pot = b.amount * 2;
        uint256 standardFee =
            (b.amount * b.challengerFeeBps + b.amount * b.accepterFeeBps) / BPS_DENOMINATOR;
        uint256 payout = pot - standardFee - arbiterFee;

        b.status = BetStatus.Resolved;
        b.winner = winner;

        if (arbiterFee > 0) {
            token.safeTransfer(arbiter, arbiterFee);
        }
        if (standardFee > 0) {
            uint256 perOwner = standardFee / 4;
            uint256 remainder = standardFee - perOwner * 4;
            for (uint256 i = 0; i < 4; i++) {
                uint256 share = perOwner + (i == 0 ? remainder : 0);
                if (share > 0) token.safeTransfer(treasuryOwners[i], share);
            }
        }
        token.safeTransfer(winner, payout);

        if (arbiter != address(0)) {
            emit ArbiterResolved(betId, winner, arbiter, arbiterFee);
        } else {
            emit Resolved(betId, winner, payout, standardFee);
        }
    }

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    function getBet(uint256 betId) external view returns (Bet memory) {
        return bets[betId];
    }

    function getTreasuryOwners() external view returns (address[4] memory) {
        return treasuryOwners;
    }
}
