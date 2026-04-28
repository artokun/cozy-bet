// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CozyBetEscrow} from "../src/CozyBetEscrow.sol";
import {MockUSDC} from "./MockUSDC.sol";

contract CozyBetEscrowTest is Test {
    CozyBetEscrow internal escrow;
    MockUSDC internal usdc;

    address internal admin = makeAddr("admin");
    address internal resolver = makeAddr("resolver");
    address internal arbiter = makeAddr("arbiter");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol"); // non-participant

    address internal owner1 = makeAddr("owner1");
    address internal owner2 = makeAddr("owner2");
    address internal owner3 = makeAddr("owner3");
    address internal owner4 = makeAddr("owner4");

    uint256 internal constant STAKE = 100e6; // 100 mUSDC
    uint256 internal constant BET_ID = 42;

    bytes32 internal constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");
    bytes32 internal constant ARBITER_ROLE = keccak256("ARBITER_ROLE");

    function setUp() public {
        usdc = new MockUSDC();

        address[4] memory owners = [owner1, owner2, owner3, owner4];
        escrow = new CozyBetEscrow(IERC20(address(usdc)), owners, admin);

        vm.startPrank(admin);
        escrow.grantRole(RESOLVER_ROLE, resolver);
        escrow.grantRole(ARBITER_ROLE, arbiter);
        vm.stopPrank();

        usdc.mint(alice, 10_000e6);
        usdc.mint(bob, 10_000e6);
        usdc.mint(carol, 10_000e6);

        vm.prank(alice);
        usdc.approve(address(escrow), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(escrow), type(uint256).max);
        vm.prank(carol);
        usdc.approve(address(escrow), type(uint256).max);
    }

    // -----------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------

    function test_Constructor_RevertsOnZeroToken() public {
        address[4] memory owners = [owner1, owner2, owner3, owner4];
        vm.expectRevert(CozyBetEscrow.ZeroAddress.selector);
        new CozyBetEscrow(IERC20(address(0)), owners, admin);
    }

    function test_Constructor_RevertsOnZeroAdmin() public {
        address[4] memory owners = [owner1, owner2, owner3, owner4];
        vm.expectRevert(CozyBetEscrow.ZeroAddress.selector);
        new CozyBetEscrow(IERC20(address(usdc)), owners, address(0));
    }

    function test_Constructor_RevertsOnZeroOwner() public {
        address[4] memory owners = [owner1, address(0), owner3, owner4];
        vm.expectRevert(CozyBetEscrow.ZeroAddress.selector);
        new CozyBetEscrow(IERC20(address(usdc)), owners, admin);
    }

    function test_Constructor_DefaultsCorrect() public view {
        assertEq(escrow.defaultFeeBps(), 250);
        assertEq(escrow.minDiscountedFeeBps(), 150);
        assertEq(escrow.arbiterMinFee(), 100e6);
        assertEq(escrow.arbiterFeeBpsOfPot(), 100);
        assertEq(escrow.treasuryOwners(0), owner1);
        assertEq(escrow.treasuryOwners(3), owner4);
    }

    // -----------------------------------------------------------------
    // initializeBet
    // -----------------------------------------------------------------

    function test_InitializeBet_HappyPath() public {
        vm.prank(resolver);
        escrow.initializeBet(BET_ID, STAKE, alice, bob);
        CozyBetEscrow.Bet memory b = escrow.getBet(BET_ID);
        assertEq(b.amount, STAKE);
        assertEq(b.challenger, alice);
        assertEq(b.accepter, bob);
        assertEq(b.challengerFeeBps, 250);
        assertEq(b.accepterFeeBps, 250);
        assertTrue(b.status == CozyBetEscrow.BetStatus.Pending);
    }

    function test_InitializeBet_RevertsIfDuplicate() public {
        vm.prank(resolver);
        escrow.initializeBet(BET_ID, STAKE, alice, bob);
        vm.prank(resolver);
        vm.expectRevert(CozyBetEscrow.BetAlreadyExists.selector);
        escrow.initializeBet(BET_ID, STAKE, alice, bob);
    }

    function test_InitializeBet_RevertsIfZeroAmount() public {
        vm.prank(resolver);
        vm.expectRevert(CozyBetEscrow.AmountZero.selector);
        escrow.initializeBet(BET_ID, 0, alice, bob);
    }

    function test_InitializeBet_RevertsIfSameParticipants() public {
        vm.prank(resolver);
        vm.expectRevert(CozyBetEscrow.SameAddresses.selector);
        escrow.initializeBet(BET_ID, STAKE, alice, alice);
    }

    function test_InitializeBet_RevertsIfNotResolver() public {
        vm.prank(carol);
        vm.expectRevert();
        escrow.initializeBet(BET_ID, STAKE, alice, bob);
    }

    function test_InitializeBet_LegacyOverload_TermsHashZero() public {
        vm.prank(resolver);
        escrow.initializeBet(BET_ID, STAKE, alice, bob);
        CozyBetEscrow.Bet memory b = escrow.getBet(BET_ID);
        assertEq(b.termsHash, bytes32(0));
    }

    function test_InitializeBet_WithTermsHash_StoresIt() public {
        bytes32 hashOfTerms = keccak256(
            bytes("Resolves YES if LAL beats HOU 2026-04-24 per nba.com box score, including OT.")
        );
        vm.prank(resolver);
        escrow.initializeBet(BET_ID, STAKE, alice, bob, hashOfTerms);
        CozyBetEscrow.Bet memory b = escrow.getBet(BET_ID);
        assertEq(b.termsHash, hashOfTerms);
        // Other fields populated as usual
        assertEq(b.amount, STAKE);
        assertEq(b.challenger, alice);
        assertEq(b.accepter, bob);
    }

    function test_InitializeBet_WithTermsHash_EmitsEvent() public {
        bytes32 hashOfTerms = keccak256(bytes("test terms"));
        vm.expectEmit(true, true, true, true);
        emit CozyBetEscrow.BetInitialized(BET_ID, alice, bob, STAKE, hashOfTerms);
        vm.prank(resolver);
        escrow.initializeBet(BET_ID, STAKE, alice, bob, hashOfTerms);
    }

    function test_InitializeBet_WithTermsHash_RevertsOnDuplicate() public {
        bytes32 h = keccak256(bytes("x"));
        vm.prank(resolver);
        escrow.initializeBet(BET_ID, STAKE, alice, bob, h);
        vm.prank(resolver);
        vm.expectRevert(CozyBetEscrow.BetAlreadyExists.selector);
        escrow.initializeBet(BET_ID, STAKE, alice, bob, h);
    }

    function test_InitializeBet_WithTermsHash_FullFlow() public {
        // termsHash binding does not affect any downstream lifecycle —
        // resolve, draw, refund all work the same. Smoke-test the full path.
        bytes32 h = keccak256(bytes("alice wins iff... [agreed terms]"));
        vm.prank(resolver);
        escrow.initializeBet(BET_ID, STAKE, alice, bob, h);
        vm.prank(alice);
        escrow.deposit(BET_ID);
        vm.prank(bob);
        escrow.deposit(BET_ID);

        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(resolver);
        escrow.resolve(BET_ID, alice);

        // Hash survives through resolution
        CozyBetEscrow.Bet memory b = escrow.getBet(BET_ID);
        assertEq(b.termsHash, h);
        assertTrue(b.status == CozyBetEscrow.BetStatus.Resolved);
        // And winner got paid
        uint256 expectedPayout = STAKE * 2 - (STAKE * 250 + STAKE * 250) / 10_000;
        assertEq(usdc.balanceOf(alice) - aliceBefore, expectedPayout);
    }

    // -----------------------------------------------------------------
    // deposit
    // -----------------------------------------------------------------

    function _initBet() internal {
        vm.prank(resolver);
        escrow.initializeBet(BET_ID, STAKE, alice, bob);
    }

    function test_Deposit_BothSidesGoesToFunded() public {
        _initBet();
        vm.prank(alice);
        escrow.deposit(BET_ID);
        CozyBetEscrow.Bet memory b1 = escrow.getBet(BET_ID);
        assertTrue(b1.challengerDeposited);
        assertFalse(b1.accepterDeposited);
        assertTrue(b1.status == CozyBetEscrow.BetStatus.Pending);

        vm.prank(bob);
        escrow.deposit(BET_ID);
        CozyBetEscrow.Bet memory b2 = escrow.getBet(BET_ID);
        assertTrue(b2.accepterDeposited);
        assertTrue(b2.status == CozyBetEscrow.BetStatus.Funded);
        assertEq(usdc.balanceOf(address(escrow)), STAKE * 2);
    }

    function test_Deposit_RevertsForNonParticipant() public {
        _initBet();
        vm.prank(carol);
        vm.expectRevert(CozyBetEscrow.NotParticipant.selector);
        escrow.deposit(BET_ID);
    }

    function test_Deposit_RevertsOnDoubleDeposit() public {
        _initBet();
        vm.prank(alice);
        escrow.deposit(BET_ID);
        vm.prank(alice);
        vm.expectRevert(CozyBetEscrow.AlreadyDeposited.selector);
        escrow.deposit(BET_ID);
    }

    function test_Deposit_RevertsIfBetNotInitialized() public {
        vm.prank(alice);
        vm.expectRevert(CozyBetEscrow.InvalidState.selector);
        escrow.deposit(BET_ID);
    }

    // -----------------------------------------------------------------
    // resolve (happy path + fees)
    // -----------------------------------------------------------------

    function _fundedBet() internal {
        _initBet();
        vm.prank(alice);
        escrow.deposit(BET_ID);
        vm.prank(bob);
        escrow.deposit(BET_ID);
    }

    function test_Resolve_HappyPath_FeeSplit4Ways() public {
        _fundedBet();

        uint256 pot = STAKE * 2;
        uint256 expectedFee = (STAKE * 250 + STAKE * 250) / 10_000; // 5e6 (5 mUSDC, 2.5%)
        uint256 expectedPayout = pot - expectedFee;

        uint256 aliceBefore = usdc.balanceOf(alice);

        vm.prank(resolver);
        escrow.resolve(BET_ID, alice);

        assertEq(usdc.balanceOf(alice), aliceBefore + expectedPayout);
        // 5e6 / 4 = 1_250_000 each (5_000_000 splits cleanly)
        assertEq(usdc.balanceOf(owner1), expectedFee / 4);
        assertEq(usdc.balanceOf(owner2), expectedFee / 4);
        assertEq(usdc.balanceOf(owner3), expectedFee / 4);
        assertEq(usdc.balanceOf(owner4), expectedFee / 4);
        assertEq(usdc.balanceOf(address(escrow)), 0);

        CozyBetEscrow.Bet memory b = escrow.getBet(BET_ID);
        assertTrue(b.status == CozyBetEscrow.BetStatus.Resolved);
        assertEq(b.winner, alice);
    }

    function test_Resolve_FeeRemainderGoesToOwner1() public {
        // Construct a fee not divisible by 4. With per-side fee bps,
        // fee = stake * (cBps + aBps) / 10000. To leave a remainder mod 4,
        // pick bps + stake so the result has low bits set. stake=7,
        // both bps=250: fee = 7 * 500 / 10000 = 0 (truncates). Use larger
        // bps via reducing one side.
        // stake=1003, both bps=251 (after admin tweak): fee = 1003*502/10000 = 50 (truncates from 50.3506).
        // 50 % 4 = 2 → owner1 gets +2 atoms.
        vm.prank(admin);
        escrow.setDefaultFeeBps(251);

        uint256 stake = 1003;
        usdc.mint(alice, stake);
        usdc.mint(bob, stake);
        vm.prank(resolver);
        escrow.initializeBet(777, stake, alice, bob);
        vm.prank(alice);
        escrow.deposit(777);
        vm.prank(bob);
        escrow.deposit(777);

        uint256 fee = (stake * 251 + stake * 251) / 10_000; // 50
        uint256 perOwner = fee / 4; // 12
        uint256 remainder = fee - perOwner * 4; // 2

        vm.prank(resolver);
        escrow.resolve(777, alice);

        assertEq(usdc.balanceOf(owner1), perOwner + remainder);
        assertEq(usdc.balanceOf(owner2), perOwner);
        assertEq(usdc.balanceOf(owner3), perOwner);
        assertEq(usdc.balanceOf(owner4), perOwner);
    }

    function test_Resolve_RevertsIfNotFunded() public {
        _initBet();
        vm.prank(resolver);
        vm.expectRevert(CozyBetEscrow.InvalidState.selector);
        escrow.resolve(BET_ID, alice);
    }

    function test_Resolve_RevertsIfWinnerNotParticipant() public {
        _fundedBet();
        vm.prank(resolver);
        vm.expectRevert(CozyBetEscrow.WinnerNotParticipant.selector);
        escrow.resolve(BET_ID, carol);
    }

    function test_Resolve_RevertsIfNotResolver() public {
        _fundedBet();
        vm.prank(carol);
        vm.expectRevert();
        escrow.resolve(BET_ID, alice);
    }

    // -----------------------------------------------------------------
    // setFeeBpsForSide
    // -----------------------------------------------------------------

    function test_SetFeeBps_AppliesDiscount() public {
        _initBet();
        vm.prank(resolver);
        escrow.setFeeBpsForSide(BET_ID, alice, 150); // 1.5%
        CozyBetEscrow.Bet memory b = escrow.getBet(BET_ID);
        assertEq(b.challengerFeeBps, 150);
        assertEq(b.accepterFeeBps, 250); // unchanged
    }

    function test_SetFeeBps_PerParticipantMath() public {
        _initBet();
        vm.prank(resolver);
        escrow.setFeeBpsForSide(BET_ID, alice, 150);
        // bob unchanged at 250
        vm.prank(alice);
        escrow.deposit(BET_ID);
        vm.prank(bob);
        escrow.deposit(BET_ID);

        // Fee = STAKE * (150 + 250) / 10000 = STAKE * 400 / 10000 = STAKE * 4 / 100
        // STAKE = 100e6 → fee = 4e6
        uint256 expectedFee = (STAKE * 150 + STAKE * 250) / 10_000;
        assertEq(expectedFee, 4e6);
        uint256 pot = STAKE * 2;
        uint256 expectedPayout = pot - expectedFee;

        uint256 winnerBefore = usdc.balanceOf(alice);
        vm.prank(resolver);
        escrow.resolve(BET_ID, alice);
        assertEq(usdc.balanceOf(alice), winnerBefore + expectedPayout);
    }

    function test_SetFeeBps_RevertsIfBelowFloor() public {
        _initBet();
        vm.prank(resolver);
        vm.expectRevert(CozyBetEscrow.InvalidFeeBps.selector);
        escrow.setFeeBpsForSide(BET_ID, alice, 100); // below 150 floor
    }

    function test_SetFeeBps_RevertsIfNotReducing() public {
        _initBet();
        vm.prank(resolver);
        escrow.setFeeBpsForSide(BET_ID, alice, 200);
        // Try to set back to a higher value
        vm.prank(resolver);
        vm.expectRevert(CozyBetEscrow.InvalidFeeBps.selector);
        escrow.setFeeBpsForSide(BET_ID, alice, 250);
    }

    function test_SetFeeBps_RevertsForNonParticipant() public {
        _initBet();
        vm.prank(resolver);
        vm.expectRevert(CozyBetEscrow.NotParticipant.selector);
        escrow.setFeeBpsForSide(BET_ID, carol, 150);
    }

    // -----------------------------------------------------------------
    // draw
    // -----------------------------------------------------------------

    function test_Draw_RefundsFullStakeNoFee() public {
        _fundedBet();
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);

        vm.prank(resolver);
        escrow.draw(BET_ID);

        assertEq(usdc.balanceOf(alice) - aliceBefore, STAKE);
        assertEq(usdc.balanceOf(bob) - bobBefore, STAKE);
        // Treasury owners get nothing
        assertEq(usdc.balanceOf(owner1), 0);
        assertEq(usdc.balanceOf(address(escrow)), 0);

        CozyBetEscrow.Bet memory b = escrow.getBet(BET_ID);
        assertTrue(b.status == CozyBetEscrow.BetStatus.Drawn);
    }

    function test_Draw_RevertsIfNotFunded() public {
        _initBet();
        vm.prank(resolver);
        vm.expectRevert(CozyBetEscrow.InvalidState.selector);
        escrow.draw(BET_ID);
    }

    // -----------------------------------------------------------------
    // refund
    // -----------------------------------------------------------------

    function test_Refund_OneSidedDeposit() public {
        _initBet();
        vm.prank(alice);
        escrow.deposit(BET_ID);
        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(resolver);
        escrow.refund(BET_ID);
        assertEq(usdc.balanceOf(alice) - aliceBefore, STAKE);
        // bob never deposited; gets nothing extra
        CozyBetEscrow.Bet memory b = escrow.getBet(BET_ID);
        assertTrue(b.status == CozyBetEscrow.BetStatus.Refunded);
    }

    function test_Refund_BothSides() public {
        _fundedBet();
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(resolver);
        escrow.refund(BET_ID);
        assertEq(usdc.balanceOf(alice) - aliceBefore, STAKE);
        assertEq(usdc.balanceOf(bob) - bobBefore, STAKE);
    }

    function test_Refund_RevertsAfterResolve() public {
        _fundedBet();
        vm.prank(resolver);
        escrow.resolve(BET_ID, alice);
        vm.prank(resolver);
        vm.expectRevert(CozyBetEscrow.InvalidState.selector);
        escrow.refund(BET_ID);
    }

    // -----------------------------------------------------------------
    // arbiterResolve
    // -----------------------------------------------------------------

    function test_ArbiterResolve_FeeFromMin_OnSmallPot() public {
        // Pot = 200e6 = $200. 1% = $2 = 2e6. Min = $100 = 100e6.
        // So arbiter fee = 100e6 (min wins).
        _fundedBet();
        uint256 pot = STAKE * 2;
        uint256 expectedArbiterFee = 100e6;
        uint256 standardFee = (STAKE * 250 + STAKE * 250) / 10_000; // 5e6
        uint256 expectedPayout = pot - expectedArbiterFee - standardFee;
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 arbiterBefore = usdc.balanceOf(arbiter);

        vm.prank(arbiter);
        escrow.arbiterResolve(BET_ID, alice);

        assertEq(usdc.balanceOf(arbiter) - arbiterBefore, expectedArbiterFee);
        assertEq(usdc.balanceOf(alice) - aliceBefore, expectedPayout);
    }

    function test_ArbiterResolve_FeeFromBps_OnLargePot() public {
        // Pot = 200_000e6 = $200k. 1% = $2k = 2_000e6. Min = $100. bps wins.
        uint256 stake = 100_000e6; // 100k mUSDC each
        usdc.mint(alice, stake);
        usdc.mint(bob, stake);

        vm.prank(resolver);
        escrow.initializeBet(99, stake, alice, bob);
        vm.prank(alice);
        escrow.deposit(99);
        vm.prank(bob);
        escrow.deposit(99);

        uint256 pot = stake * 2;
        uint256 byBps = (pot * 100) / 10_000; // 1% = 2_000e6
        uint256 expectedArbiterFee = byBps; // 2_000e6 > 100e6 min
        uint256 standardFee = (stake * 250 + stake * 250) / 10_000;
        uint256 expectedPayout = pot - expectedArbiterFee - standardFee;
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 arbiterBefore = usdc.balanceOf(arbiter);

        vm.prank(arbiter);
        escrow.arbiterResolve(99, alice);

        assertEq(usdc.balanceOf(arbiter) - arbiterBefore, expectedArbiterFee);
        assertEq(usdc.balanceOf(alice) - aliceBefore, expectedPayout);
    }

    function test_ArbiterResolve_RevertsIfNotArbiter() public {
        _fundedBet();
        vm.prank(carol);
        vm.expectRevert();
        escrow.arbiterResolve(BET_ID, alice);
    }

    function test_ArbiterResolve_RevertsOnTinyPot() public {
        // Pot smaller than arbiter min fee — should revert
        uint256 tiny = 10e6; // $10 stake; pot $20 < $100 min
        usdc.mint(alice, tiny);
        usdc.mint(bob, tiny);
        vm.prank(resolver);
        escrow.initializeBet(199, tiny, alice, bob);
        vm.prank(alice);
        escrow.deposit(199);
        vm.prank(bob);
        escrow.deposit(199);
        vm.prank(arbiter);
        vm.expectRevert(CozyBetEscrow.PotTooSmallForArbiter.selector);
        escrow.arbiterResolve(199, alice);
    }

    // -----------------------------------------------------------------
    // Admin updates
    // -----------------------------------------------------------------

    function test_Admin_SetTreasuryOwner() public {
        address newOwner = makeAddr("new-owner");
        vm.prank(admin);
        escrow.setTreasuryOwner(2, newOwner);
        assertEq(escrow.treasuryOwners(2), newOwner);
    }

    function test_Admin_OnlyAdmin() public {
        vm.prank(carol);
        vm.expectRevert();
        escrow.setDefaultFeeBps(300);
    }

    function test_Admin_SetDefaultFeeBps() public {
        vm.prank(admin);
        escrow.setDefaultFeeBps(300);
        assertEq(escrow.defaultFeeBps(), 300);
    }

    // -----------------------------------------------------------------
    // Fuzz tests — invariants that must hold for any (amount, bps).
    //
    // These run with forge's default 256 random inputs each. The
    // hand-rolled tests above cover specific edge cases; these catch
    // arithmetic / split bugs that random inputs surface.
    // -----------------------------------------------------------------

    /// @notice For any well-formed bet, the contract's accounting must
    ///         balance: pot = winnerPayout + standardFee + arbiterFee.
    ///         No funds get created or destroyed in a resolve.
    function testFuzz_resolve_potBalances(uint256 stake, uint16 cBps, uint16 aBps)
        public
    {
        // Constrain inputs to realistic ranges.
        stake = bound(stake, 1e6, 1_000_000e6); // 1 USDC to 1M USDC
        cBps = uint16(bound(cBps, 150, 1000)); // 1.5%–10% per side
        aBps = uint16(bound(aBps, 150, 1000));

        // Mint enough for both sides.
        usdc.mint(alice, stake);
        usdc.mint(bob, stake);

        vm.prank(resolver);
        escrow.initializeBet(BET_ID, stake, alice, bob);

        // If the fuzzed bps differ from default, apply the discount.
        if (cBps < escrow.defaultFeeBps()) {
            vm.prank(resolver);
            escrow.setFeeBpsForSide(BET_ID, alice, cBps);
        }
        if (aBps < escrow.defaultFeeBps()) {
            vm.prank(resolver);
            escrow.setFeeBpsForSide(BET_ID, bob, aBps);
        }

        vm.prank(alice);
        escrow.deposit(BET_ID);
        vm.prank(bob);
        escrow.deposit(BET_ID);

        uint256 escrowBalanceBefore = usdc.balanceOf(address(escrow));
        assertEq(escrowBalanceBefore, stake * 2, "escrow holds full pot pre-resolve");

        uint256 winnerBefore = usdc.balanceOf(alice);
        uint256 ownerSumBefore = usdc.balanceOf(owner1) + usdc.balanceOf(owner2)
            + usdc.balanceOf(owner3) + usdc.balanceOf(owner4);

        vm.prank(resolver);
        escrow.resolve(BET_ID, alice);

        uint256 winnerDelta = usdc.balanceOf(alice) - winnerBefore;
        uint256 ownerSumDelta = (
            usdc.balanceOf(owner1) + usdc.balanceOf(owner2) + usdc.balanceOf(owner3)
                + usdc.balanceOf(owner4)
        ) - ownerSumBefore;

        // INVARIANT: every atom of the pot accounted for.
        assertEq(winnerDelta + ownerSumDelta, stake * 2, "no atoms created or lost");
        // INVARIANT: escrow vault drained.
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow drained on resolve");
    }

    /// @notice Treasury owners' shares sum to exactly standardFee — the
    ///         integer-division remainder must be routed (not lost).
    function testFuzz_resolve_treasurySumEqualsStandardFee(uint256 stake)
        public
    {
        stake = bound(stake, 1e6, 1_000_000e6);

        usdc.mint(alice, stake);
        usdc.mint(bob, stake);

        vm.prank(resolver);
        escrow.initializeBet(BET_ID, stake, alice, bob);
        vm.prank(alice);
        escrow.deposit(BET_ID);
        vm.prank(bob);
        escrow.deposit(BET_ID);

        // Default 250 + 250 bps.
        uint256 expectedFee = (stake * 250 + stake * 250) / 10_000;

        uint256[4] memory before;
        before[0] = usdc.balanceOf(owner1);
        before[1] = usdc.balanceOf(owner2);
        before[2] = usdc.balanceOf(owner3);
        before[3] = usdc.balanceOf(owner4);

        vm.prank(resolver);
        escrow.resolve(BET_ID, alice);

        uint256 ownerSum = (usdc.balanceOf(owner1) - before[0])
            + (usdc.balanceOf(owner2) - before[1]) + (usdc.balanceOf(owner3) - before[2])
            + (usdc.balanceOf(owner4) - before[3]);

        // INVARIANT: 4 owners' shares = standardFee, exactly.
        assertEq(ownerSum, expectedFee, "treasury sum matches standardFee");
        // INVARIANT: slot 0 always >= other slots (remainder routes there).
        uint256 share1 = usdc.balanceOf(owner1) - before[0];
        uint256 share2 = usdc.balanceOf(owner2) - before[1];
        uint256 share3 = usdc.balanceOf(owner3) - before[2];
        uint256 share4 = usdc.balanceOf(owner4) - before[3];
        assertGe(share1, share2, "slot 0 >= slot 1");
        assertGe(share1, share3, "slot 0 >= slot 2");
        assertGe(share1, share4, "slot 0 >= slot 3");
        // Other 3 owners get equal shares.
        assertEq(share2, share3, "slots 1 & 2 equal");
        assertEq(share3, share4, "slots 2 & 3 equal");
    }

    /// @notice Draw refunds each side exactly amount — never less, never more.
    function testFuzz_draw_refundsExactStake(uint256 stake) public {
        stake = bound(stake, 1e6, 1_000_000e6);

        usdc.mint(alice, stake);
        usdc.mint(bob, stake);

        vm.prank(resolver);
        escrow.initializeBet(BET_ID, stake, alice, bob);
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(alice);
        escrow.deposit(BET_ID);
        vm.prank(bob);
        escrow.deposit(BET_ID);
        vm.prank(resolver);
        escrow.draw(BET_ID);

        // INVARIANT: net delta is zero — they got back exactly what they put in.
        assertEq(usdc.balanceOf(alice), aliceBefore, "alice net zero on draw");
        assertEq(usdc.balanceOf(bob), bobBefore, "bob net zero on draw");
        // INVARIANT: no fee taken on draws.
        assertEq(usdc.balanceOf(owner1), 0, "no draw fee to owner1");
    }

    /// @notice setFeeBpsForSide is one-way: cannot increase fee.
    function testFuzz_setFeeBps_cannotIncrease(uint16 newBps) public {
        // Constrain to >= default so any "set" would be a non-decrease.
        newBps = uint16(bound(newBps, escrow.defaultFeeBps(), 1000));

        vm.prank(resolver);
        escrow.initializeBet(BET_ID, STAKE, alice, bob);

        vm.prank(resolver);
        vm.expectRevert(CozyBetEscrow.InvalidFeeBps.selector);
        escrow.setFeeBpsForSide(BET_ID, alice, newBps);
    }
}
