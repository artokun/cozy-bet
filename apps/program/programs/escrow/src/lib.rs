use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("nqQkfoyxtzxDBHmyxnJs3KwQVvz5CoFffH8vcQzS6yt");

#[program]
pub mod escrow {
    use super::*;

    // ---------------------------------------------------------------
    // Config
    // ---------------------------------------------------------------

    /// One-time setup. After this, treasury is split 4 ways, resolver signs
    /// `resolve`/`draw`/`refund`/`set_fee_bps_for_side`, arbiter signs
    /// `arbiter_resolve`. Admin (authority) can rotate any of these later.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        treasury_owners: [Pubkey; 4],
        resolver: Pubkey,
        arbiter: Pubkey,
        default_fee_bps: u16,
        min_discounted_fee_bps: u16,
        arbiter_min_fee: u64,
        arbiter_fee_bps_of_pot: u16,
    ) -> Result<()> {
        require!(default_fee_bps <= 10_000, EscrowError::FeeTooHigh);
        require!(
            min_discounted_fee_bps <= default_fee_bps,
            EscrowError::FeeTooHigh
        );
        require!(arbiter_fee_bps_of_pot <= 10_000, EscrowError::FeeTooHigh);
        for owner in &treasury_owners {
            require!(*owner != Pubkey::default(), EscrowError::ZeroAddress);
        }
        let config = &mut ctx.accounts.config;
        config.bump = ctx.bumps.config;
        config.authority = ctx.accounts.authority.key();
        config.treasury_owners = treasury_owners;
        config.resolver = resolver;
        config.arbiter = arbiter;
        config.default_fee_bps = default_fee_bps;
        config.min_discounted_fee_bps = min_discounted_fee_bps;
        config.arbiter_min_fee = arbiter_min_fee;
        config.arbiter_fee_bps_of_pot = arbiter_fee_bps_of_pot;
        Ok(())
    }

    /// Admin-only. Pass `None` to keep an existing field.
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        treasury_owners: Option<[Pubkey; 4]>,
        resolver: Option<Pubkey>,
        arbiter: Option<Pubkey>,
        default_fee_bps: Option<u16>,
        min_discounted_fee_bps: Option<u16>,
        arbiter_min_fee: Option<u64>,
        arbiter_fee_bps_of_pot: Option<u16>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require_keys_eq!(
            ctx.accounts.authority.key(),
            config.authority,
            EscrowError::UnauthorizedAdmin
        );
        if let Some(o) = treasury_owners {
            for owner in &o {
                require!(*owner != Pubkey::default(), EscrowError::ZeroAddress);
            }
            config.treasury_owners = o;
        }
        if let Some(r) = resolver {
            config.resolver = r;
        }
        if let Some(a) = arbiter {
            config.arbiter = a;
        }
        if let Some(f) = default_fee_bps {
            require!(f <= 10_000, EscrowError::FeeTooHigh);
            config.default_fee_bps = f;
        }
        if let Some(f) = min_discounted_fee_bps {
            require!(f <= config.default_fee_bps, EscrowError::FeeTooHigh);
            config.min_discounted_fee_bps = f;
        }
        if let Some(f) = arbiter_min_fee {
            config.arbiter_min_fee = f;
        }
        if let Some(f) = arbiter_fee_bps_of_pot {
            require!(f <= 10_000, EscrowError::FeeTooHigh);
            config.arbiter_fee_bps_of_pot = f;
        }
        Ok(())
    }

    /// Admin-only. Hand off the program authority to a new pubkey (e.g. a
    /// Squads multisig vault). Single-step rotation: the current authority
    /// signs, the new authority is recorded immediately. Multisig approval
    /// gating is provided by Squads (or whatever wallet signs the tx) — the
    /// program just verifies the *current* authority signed.
    pub fn update_authority(
        ctx: Context<UpdateAuthority>,
        new_authority: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require_keys_eq!(
            ctx.accounts.authority.key(),
            config.authority,
            EscrowError::UnauthorizedAdmin
        );
        require!(
            new_authority != Pubkey::default(),
            EscrowError::ZeroAddress
        );
        config.authority = new_authority;
        Ok(())
    }

    // ---------------------------------------------------------------
    // Lifecycle (resolver-only)
    // ---------------------------------------------------------------

    /// Create a bet. Resolver signs. `terms_hash` is keccak256/sha256 of the
    /// canonical (chat-disambig-agreed) bet terms; pass [0u8; 32] for legacy
    /// flows that skip the terms-signing step.
    pub fn initialize_bet(
        ctx: Context<InitializeBet>,
        bet_id: u64,
        amount: u64,
        challenger: Pubkey,
        accepter: Pubkey,
        terms_hash: [u8; 32],
    ) -> Result<()> {
        require!(amount > 0, EscrowError::AmountMustBePositive);
        require!(challenger != accepter, EscrowError::SameParticipants);
        require_keys_eq!(
            ctx.accounts.resolver.key(),
            ctx.accounts.config.resolver,
            EscrowError::UnauthorizedResolver
        );
        let default_bps = ctx.accounts.config.default_fee_bps;
        let bet = &mut ctx.accounts.bet;
        bet.bump = ctx.bumps.bet;
        bet.bet_id = bet_id;
        bet.challenger = challenger;
        bet.accepter = accepter;
        bet.amount = amount;
        bet.mint = ctx.accounts.mint.key();
        bet.vault = ctx.accounts.vault.key();
        bet.challenger_deposited = false;
        bet.accepter_deposited = false;
        bet.status = BetStatus::Pending;
        bet.winner = Pubkey::default();
        bet.challenger_fee_bps = default_bps;
        bet.accepter_fee_bps = default_bps;
        bet.terms_hash = terms_hash;
        Ok(())
    }

    /// Either participant deposits their stake. Caller must be challenger or accepter.
    pub fn deposit(ctx: Context<Deposit>, _bet_id: u64) -> Result<()> {
        let bet = &mut ctx.accounts.bet;
        require!(bet.status == BetStatus::Pending, EscrowError::InvalidState);

        let signer_key = ctx.accounts.depositor.key();
        let is_challenger = signer_key == bet.challenger;
        let is_accepter = signer_key == bet.accepter;
        require!(is_challenger || is_accepter, EscrowError::NotAParticipant);

        if is_challenger {
            require!(!bet.challenger_deposited, EscrowError::AlreadyDeposited);
        } else {
            require!(!bet.accepter_deposited, EscrowError::AlreadyDeposited);
        }

        require_keys_eq!(
            ctx.accounts.depositor_ata.mint,
            bet.mint,
            EscrowError::WrongMint
        );
        require_keys_eq!(
            ctx.accounts.depositor_ata.owner,
            signer_key,
            EscrowError::AtaMismatch
        );

        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.depositor_ata.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        );
        token::transfer(cpi_ctx, bet.amount)?;

        if is_challenger {
            bet.challenger_deposited = true;
        } else {
            bet.accepter_deposited = true;
        }
        if bet.challenger_deposited && bet.accepter_deposited {
            bet.status = BetStatus::Funded;
        }
        Ok(())
    }

    /// Reduce a participant's per-side fee bps. Resolver-only. Floor at
    /// `min_discounted_fee_bps`. Cannot increase. Used to apply the social-share
    /// discount (250 → 150 typically).
    pub fn set_fee_bps_for_side(
        ctx: Context<SetFeeBpsForSide>,
        _bet_id: u64,
        side: Pubkey,
        new_bps: u16,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.resolver.key(),
            ctx.accounts.config.resolver,
            EscrowError::UnauthorizedResolver
        );
        let bet = &mut ctx.accounts.bet;
        require!(
            bet.status == BetStatus::Pending || bet.status == BetStatus::Funded,
            EscrowError::InvalidState
        );
        let min_bps = ctx.accounts.config.min_discounted_fee_bps;
        require!(new_bps >= min_bps, EscrowError::InvalidFeeBps);
        if side == bet.challenger {
            require!(new_bps < bet.challenger_fee_bps, EscrowError::InvalidFeeBps);
            bet.challenger_fee_bps = new_bps;
        } else if side == bet.accepter {
            require!(new_bps < bet.accepter_fee_bps, EscrowError::InvalidFeeBps);
            bet.accepter_fee_bps = new_bps;
        } else {
            return err!(EscrowError::NotAParticipant);
        }
        Ok(())
    }

    /// Resolver pays winner: pot − standard_fee. Standard fee = sum of
    /// per-side fee bps applied to each side's stake; split evenly across the
    /// 4 treasury owner ATAs (remainder goes to slot 0).
    pub fn resolve(ctx: Context<Resolve>, bet_id: u64, winner: Pubkey) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.resolver.key(),
            ctx.accounts.config.resolver,
            EscrowError::UnauthorizedResolver
        );
        _resolve_inner(
            &ctx.accounts.bet,
            &ctx.accounts.vault,
            &[
                ctx.accounts.treasury_ata_0.to_account_info(),
                ctx.accounts.treasury_ata_1.to_account_info(),
                ctx.accounts.treasury_ata_2.to_account_info(),
                ctx.accounts.treasury_ata_3.to_account_info(),
            ],
            &ctx.accounts.winner_ata,
            None,
            0,
            &ctx.accounts.token_program,
            &ctx.accounts.config.treasury_owners,
            bet_id,
            winner,
            ctx.accounts.bet.bump,
        )?;
        let bet = &mut ctx.accounts.bet;
        bet.status = BetStatus::Resolved;
        bet.winner = winner;
        Ok(())
    }

    /// Arbiter forces a resolution. Arbiter fee = max(arbiter_min_fee,
    /// pot * arbiter_fee_bps_of_pot / 10000), paid to msg.sender (arbiter ATA).
    /// Arbiter must equal config.arbiter.
    pub fn arbiter_resolve(
        ctx: Context<ArbiterResolve>,
        bet_id: u64,
        winner: Pubkey,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.arbiter.key(),
            ctx.accounts.config.arbiter,
            EscrowError::UnauthorizedArbiter
        );
        let bet = &ctx.accounts.bet;
        let pot = bet
            .amount
            .checked_mul(2)
            .ok_or(EscrowError::MathOverflow)?;
        let by_bps = pot
            .checked_mul(ctx.accounts.config.arbiter_fee_bps_of_pot as u64)
            .ok_or(EscrowError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(EscrowError::MathOverflow)?;
        let arbiter_fee = if by_bps > ctx.accounts.config.arbiter_min_fee {
            by_bps
        } else {
            ctx.accounts.config.arbiter_min_fee
        };
        let standard_fee = bet
            .amount
            .checked_mul(bet.challenger_fee_bps as u64)
            .and_then(|x| {
                x.checked_add(
                    bet.amount
                        .checked_mul(bet.accepter_fee_bps as u64)?,
                )
            })
            .ok_or(EscrowError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(EscrowError::MathOverflow)?;
        let after_fees = arbiter_fee
            .checked_add(standard_fee)
            .ok_or(EscrowError::MathOverflow)?;
        require!(after_fees < pot, EscrowError::PotTooSmallForArbiter);

        _resolve_inner(
            &ctx.accounts.bet,
            &ctx.accounts.vault,
            &[
                ctx.accounts.treasury_ata_0.to_account_info(),
                ctx.accounts.treasury_ata_1.to_account_info(),
                ctx.accounts.treasury_ata_2.to_account_info(),
                ctx.accounts.treasury_ata_3.to_account_info(),
            ],
            &ctx.accounts.winner_ata,
            Some(ctx.accounts.arbiter_ata.to_account_info()),
            arbiter_fee,
            &ctx.accounts.token_program,
            &ctx.accounts.config.treasury_owners,
            bet_id,
            winner,
            ctx.accounts.bet.bump,
        )?;
        let bet = &mut ctx.accounts.bet;
        bet.status = BetStatus::Resolved;
        bet.winner = winner;
        Ok(())
    }

    /// Both sides agreed it's a draw. Refund full stakes. No fee.
    pub fn draw(ctx: Context<Draw>, bet_id: u64) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.resolver.key(),
            ctx.accounts.config.resolver,
            EscrowError::UnauthorizedResolver
        );
        let bet = &ctx.accounts.bet;
        require!(bet.status == BetStatus::Funded, EscrowError::InvalidState);
        // Validate destination ATA owners + mints — without this a malicious
        // resolver could divert refunds to any same-mint account.
        require_keys_eq!(
            ctx.accounts.challenger_ata.owner,
            bet.challenger,
            EscrowError::AtaMismatch
        );
        require_keys_eq!(
            ctx.accounts.accepter_ata.owner,
            bet.accepter,
            EscrowError::AtaMismatch
        );
        require_keys_eq!(
            ctx.accounts.challenger_ata.mint,
            bet.mint,
            EscrowError::WrongMint
        );
        require_keys_eq!(
            ctx.accounts.accepter_ata.mint,
            bet.mint,
            EscrowError::WrongMint
        );
        let amount = bet.amount;
        let bet_id_bytes = bet_id.to_le_bytes();
        let bet_bump = bet.bump;
        let seeds: &[&[u8]] = &[b"bet", bet_id_bytes.as_ref(), &[bet_bump]];
        let signer_seeds = &[seeds];
        // refund both
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.challenger_ata.to_account_info(),
                    authority: ctx.accounts.bet.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.accepter_ata.to_account_info(),
                    authority: ctx.accounts.bet.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;
        let bet = &mut ctx.accounts.bet;
        bet.status = BetStatus::Drawn;
        Ok(())
    }

    /// Refund whatever was deposited (one or both sides). Used on mutual cancel.
    pub fn refund(ctx: Context<Refund>, bet_id: u64) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.resolver.key(),
            ctx.accounts.config.resolver,
            EscrowError::UnauthorizedResolver
        );
        let bet = &ctx.accounts.bet;
        require!(
            bet.status == BetStatus::Pending || bet.status == BetStatus::Funded,
            EscrowError::InvalidState
        );
        // Validate destination ATA owners + mints (see note in `draw`).
        require_keys_eq!(
            ctx.accounts.challenger_ata.owner,
            bet.challenger,
            EscrowError::AtaMismatch
        );
        require_keys_eq!(
            ctx.accounts.accepter_ata.owner,
            bet.accepter,
            EscrowError::AtaMismatch
        );
        require_keys_eq!(
            ctx.accounts.challenger_ata.mint,
            bet.mint,
            EscrowError::WrongMint
        );
        require_keys_eq!(
            ctx.accounts.accepter_ata.mint,
            bet.mint,
            EscrowError::WrongMint
        );
        let amount = bet.amount;
        let challenger_dep = bet.challenger_deposited;
        let accepter_dep = bet.accepter_deposited;
        let bet_id_bytes = bet_id.to_le_bytes();
        let bet_bump = bet.bump;
        let seeds: &[&[u8]] = &[b"bet", bet_id_bytes.as_ref(), &[bet_bump]];
        let signer_seeds = &[seeds];
        if challenger_dep {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.challenger_ata.to_account_info(),
                        authority: ctx.accounts.bet.to_account_info(),
                    },
                    signer_seeds,
                ),
                amount,
            )?;
        }
        if accepter_dep {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.accepter_ata.to_account_info(),
                        authority: ctx.accounts.bet.to_account_info(),
                    },
                    signer_seeds,
                ),
                amount,
            )?;
        }
        let bet = &mut ctx.accounts.bet;
        bet.status = BetStatus::Refunded;
        Ok(())
    }
}

// ---------------------------------------------------------------
// Shared resolve logic (used by resolve + arbiter_resolve)
// ---------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn _resolve_inner<'info>(
    bet: &Account<'info, Bet>,
    vault: &Account<'info, TokenAccount>,
    treasury_atas: &[AccountInfo<'info>; 4],
    winner_ata: &Account<'info, TokenAccount>,
    arbiter_ata: Option<AccountInfo<'info>>,
    arbiter_fee: u64,
    token_program: &Program<'info, Token>,
    treasury_owners: &[Pubkey; 4],
    bet_id: u64,
    winner: Pubkey,
    bet_bump: u8,
) -> Result<()> {
    require!(bet.status == BetStatus::Funded, EscrowError::InvalidState);
    require!(
        winner == bet.challenger || winner == bet.accepter,
        EscrowError::WinnerNotParticipant
    );
    require_keys_eq!(
        winner_ata.owner,
        winner,
        EscrowError::WinnerAtaMismatch
    );
    require_keys_eq!(winner_ata.mint, bet.mint, EscrowError::WrongMint);

    // Verify each treasury ATA belongs to its expected owner via ATA derivation.
    // Fast check: TokenAccount#owner field. Mint check below.
    for (i, ata_ai) in treasury_atas.iter().enumerate() {
        let parsed: TokenAccount = TokenAccount::try_deserialize(&mut &ata_ai.data.borrow()[..])?;
        require_keys_eq!(
            parsed.owner,
            treasury_owners[i],
            EscrowError::TreasuryAtaMismatch
        );
        require_keys_eq!(parsed.mint, bet.mint, EscrowError::WrongMint);
    }

    let pot = bet
        .amount
        .checked_mul(2)
        .ok_or(EscrowError::MathOverflow)?;
    let standard_fee = bet
        .amount
        .checked_mul(bet.challenger_fee_bps as u64)
        .and_then(|x| {
            x.checked_add(
                bet.amount
                    .checked_mul(bet.accepter_fee_bps as u64)?,
            )
        })
        .ok_or(EscrowError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(EscrowError::MathOverflow)?;
    let payout = pot
        .checked_sub(standard_fee)
        .and_then(|x| x.checked_sub(arbiter_fee))
        .ok_or(EscrowError::MathOverflow)?;

    let bet_id_bytes = bet_id.to_le_bytes();
    let seeds: &[&[u8]] = &[b"bet", bet_id_bytes.as_ref(), &[bet_bump]];
    let signer_seeds = &[seeds];

    // arbiter fee
    if let (Some(arbiter_ai), true) = (arbiter_ata, arbiter_fee > 0) {
        token::transfer(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                Transfer {
                    from: vault.to_account_info(),
                    to: arbiter_ai,
                    authority: bet.to_account_info(),
                },
                signer_seeds,
            ),
            arbiter_fee,
        )?;
    }

    // standard fee — split 4 ways, remainder to slot 0
    if standard_fee > 0 {
        let per_owner = standard_fee / 4;
        let remainder = standard_fee - per_owner * 4;
        for (i, ata_ai) in treasury_atas.iter().enumerate() {
            let share = per_owner + if i == 0 { remainder } else { 0 };
            if share > 0 {
                token::transfer(
                    CpiContext::new_with_signer(
                        token_program.to_account_info(),
                        Transfer {
                            from: vault.to_account_info(),
                            to: ata_ai.clone(),
                            authority: bet.to_account_info(),
                        },
                        signer_seeds,
                    ),
                    share,
                )?;
            }
        }
    }

    // winner
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: vault.to_account_info(),
                to: winner_ata.to_account_info(),
                authority: bet.to_account_info(),
            },
            signer_seeds,
        ),
        payout,
    )?;
    Ok(())
}

// ---------------------------------------------------------------
// State accounts
// ---------------------------------------------------------------

#[account]
pub struct Config {
    pub bump: u8,
    pub authority: Pubkey,
    pub treasury_owners: [Pubkey; 4],
    pub resolver: Pubkey,
    pub arbiter: Pubkey,
    pub default_fee_bps: u16,
    pub min_discounted_fee_bps: u16,
    pub arbiter_min_fee: u64,
    pub arbiter_fee_bps_of_pot: u16,
}

impl Config {
    // bump(1) + authority(32) + treasury_owners(32*4) + resolver(32) + arbiter(32)
    // + default_fee_bps(2) + min_discounted_fee_bps(2) + arbiter_min_fee(8)
    // + arbiter_fee_bps_of_pot(2)
    pub const LEN: usize = 1 + 32 + 32 * 4 + 32 + 32 + 2 + 2 + 8 + 2;
}

#[account]
pub struct Bet {
    pub bump: u8,
    pub bet_id: u64,
    pub challenger: Pubkey,
    pub accepter: Pubkey,
    pub amount: u64,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub challenger_deposited: bool,
    pub accepter_deposited: bool,
    pub status: BetStatus,
    pub winner: Pubkey,
    pub challenger_fee_bps: u16,
    pub accepter_fee_bps: u16,
    pub terms_hash: [u8; 32],
}

impl Bet {
    // bump(1) + bet_id(8) + challenger(32) + accepter(32) + amount(8) + mint(32)
    // + vault(32) + challenger_dep(1) + accepter_dep(1) + status(1) + winner(32)
    // + challenger_fee_bps(2) + accepter_fee_bps(2) + terms_hash(32)
    pub const LEN: usize = 1 + 8 + 32 + 32 + 8 + 32 + 32 + 1 + 1 + 1 + 32 + 2 + 2 + 32;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum BetStatus {
    Pending,
    Funded,
    Resolved,
    Drawn,
    Refunded,
}

// ---------------------------------------------------------------
// Instruction accounts
// ---------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Config::LEN,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateAuthority<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(bet_id: u64)]
pub struct InitializeBet<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = payer,
        space = 8 + Bet::LEN,
        seeds = [b"bet", bet_id.to_le_bytes().as_ref()],
        bump
    )]
    pub bet: Account<'info, Bet>,

    #[account(
        init,
        payer = payer,
        seeds = [b"vault", bet_id.to_le_bytes().as_ref()],
        bump,
        token::mint = mint,
        token::authority = bet,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    pub resolver: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(bet_id: u64)]
pub struct Deposit<'info> {
    #[account(
        mut,
        seeds = [b"bet", bet_id.to_le_bytes().as_ref()],
        bump = bet.bump
    )]
    pub bet: Account<'info, Bet>,

    #[account(
        mut,
        seeds = [b"vault", bet_id.to_le_bytes().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub depositor_ata: Account<'info, TokenAccount>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(bet_id: u64)]
pub struct SetFeeBpsForSide<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"bet", bet_id.to_le_bytes().as_ref()],
        bump = bet.bump
    )]
    pub bet: Account<'info, Bet>,

    pub resolver: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(bet_id: u64)]
pub struct Resolve<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"bet", bet_id.to_le_bytes().as_ref()],
        bump = bet.bump
    )]
    pub bet: Account<'info, Bet>,

    #[account(
        mut,
        seeds = [b"vault", bet_id.to_le_bytes().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub winner_ata: Account<'info, TokenAccount>,

    /// CHECK: validated against config.treasury_owners[0] inside _resolve_inner
    #[account(mut)]
    pub treasury_ata_0: AccountInfo<'info>,
    /// CHECK: validated against config.treasury_owners[1]
    #[account(mut)]
    pub treasury_ata_1: AccountInfo<'info>,
    /// CHECK: validated against config.treasury_owners[2]
    #[account(mut)]
    pub treasury_ata_2: AccountInfo<'info>,
    /// CHECK: validated against config.treasury_owners[3]
    #[account(mut)]
    pub treasury_ata_3: AccountInfo<'info>,

    pub resolver: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(bet_id: u64)]
pub struct ArbiterResolve<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"bet", bet_id.to_le_bytes().as_ref()],
        bump = bet.bump
    )]
    pub bet: Account<'info, Bet>,

    #[account(
        mut,
        seeds = [b"vault", bet_id.to_le_bytes().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub winner_ata: Account<'info, TokenAccount>,

    /// CHECK: validated against config.treasury_owners[0]
    #[account(mut)]
    pub treasury_ata_0: AccountInfo<'info>,
    /// CHECK: validated against config.treasury_owners[1]
    #[account(mut)]
    pub treasury_ata_1: AccountInfo<'info>,
    /// CHECK: validated against config.treasury_owners[2]
    #[account(mut)]
    pub treasury_ata_2: AccountInfo<'info>,
    /// CHECK: validated against config.treasury_owners[3]
    #[account(mut)]
    pub treasury_ata_3: AccountInfo<'info>,

    /// CHECK: receives the arbiter fee; owner-checked via Token CPI
    #[account(mut)]
    pub arbiter_ata: AccountInfo<'info>,

    pub arbiter: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(bet_id: u64)]
pub struct Draw<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"bet", bet_id.to_le_bytes().as_ref()],
        bump = bet.bump
    )]
    pub bet: Account<'info, Bet>,

    #[account(
        mut,
        seeds = [b"vault", bet_id.to_le_bytes().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub challenger_ata: Account<'info, TokenAccount>,

    #[account(mut)]
    pub accepter_ata: Account<'info, TokenAccount>,

    pub resolver: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(bet_id: u64)]
pub struct Refund<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"bet", bet_id.to_le_bytes().as_ref()],
        bump = bet.bump
    )]
    pub bet: Account<'info, Bet>,

    #[account(
        mut,
        seeds = [b"vault", bet_id.to_le_bytes().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub challenger_ata: Account<'info, TokenAccount>,

    #[account(mut)]
    pub accepter_ata: Account<'info, TokenAccount>,

    pub resolver: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------
// Errors
// ---------------------------------------------------------------

#[error_code]
pub enum EscrowError {
    #[msg("Fee basis points must be <= 10000")]
    FeeTooHigh,
    #[msg("Amount must be > 0")]
    AmountMustBePositive,
    #[msg("Challenger and accepter must differ")]
    SameParticipants,
    #[msg("Bet is not in a valid state for this action")]
    InvalidState,
    #[msg("Signer is not a participant in this bet")]
    NotAParticipant,
    #[msg("Participant already deposited")]
    AlreadyDeposited,
    #[msg("Deposit ATA uses the wrong mint")]
    WrongMint,
    #[msg("ATA owner does not match expected wallet")]
    AtaMismatch,
    #[msg("Winner must be a participant")]
    WinnerNotParticipant,
    #[msg("Winner ATA owner mismatch")]
    WinnerAtaMismatch,
    #[msg("Treasury ATA owner mismatch")]
    TreasuryAtaMismatch,
    #[msg("Signer is not the authorized resolver")]
    UnauthorizedResolver,
    #[msg("Signer is not the authorized arbiter")]
    UnauthorizedArbiter,
    #[msg("Signer is not the config admin")]
    UnauthorizedAdmin,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Pubkey cannot be the zero address")]
    ZeroAddress,
    #[msg("Pot too small to cover arbiter + standard fees")]
    PotTooSmallForArbiter,
    #[msg("Invalid fee bps")]
    InvalidFeeBps,
}
