use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("nqQkfoyxtzxDBHmyxnJs3KwQVvz5CoFffH8vcQzS6yt");

#[program]
pub mod escrow {
    use super::*;

    /// One-time setup: persists treasury pubkey, fee, and resolver authority.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        fee_bps: u16,
        treasury: Pubkey,
        resolver: Pubkey,
    ) -> Result<()> {
        require!(fee_bps <= 10_000, EscrowError::FeeTooHigh);
        let config = &mut ctx.accounts.config;
        config.bump = ctx.bumps.config;
        config.authority = ctx.accounts.authority.key();
        config.fee_bps = fee_bps;
        config.treasury = treasury;
        config.resolver = resolver;
        Ok(())
    }

    /// Admin can rotate resolver or treasury, or update fee.
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        fee_bps: Option<u16>,
        treasury: Option<Pubkey>,
        resolver: Option<Pubkey>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require_keys_eq!(
            ctx.accounts.authority.key(),
            config.authority,
            EscrowError::UnauthorizedAdmin
        );
        if let Some(f) = fee_bps {
            require!(f <= 10_000, EscrowError::FeeTooHigh);
            config.fee_bps = f;
        }
        if let Some(t) = treasury {
            config.treasury = t;
        }
        if let Some(r) = resolver {
            config.resolver = r;
        }
        Ok(())
    }

    /// Bot calls this when both Discord users accept. Creates Bet PDA + vault token account.
    pub fn initialize_bet(
        ctx: Context<InitializeBet>,
        bet_id: u64,
        amount: u64,
        challenger: Pubkey,
        accepter: Pubkey,
    ) -> Result<()> {
        require!(amount > 0, EscrowError::AmountMustBePositive);
        require!(challenger != accepter, EscrowError::SameParticipants);
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
        Ok(())
    }

    /// Challenger or accepter deposits their stake into the vault.
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

    /// Resolver (bot) pays the winner 100% - fee_bps; treasury gets fee_bps.
    pub fn resolve(ctx: Context<Resolve>, bet_id: u64, winner: Pubkey) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.resolver.key(),
            ctx.accounts.config.resolver,
            EscrowError::UnauthorizedResolver
        );

        let bet_bump = ctx.accounts.bet.bump;
        let amount = ctx.accounts.bet.amount;
        let fee_bps = ctx.accounts.config.fee_bps as u64;

        {
            let bet = &ctx.accounts.bet;
            require!(bet.status == BetStatus::Funded, EscrowError::InvalidState);
            require!(
                winner == bet.challenger || winner == bet.accepter,
                EscrowError::WinnerNotParticipant
            );
        }
        require_keys_eq!(
            ctx.accounts.winner_ata.owner,
            winner,
            EscrowError::WinnerAtaMismatch
        );
        require_keys_eq!(
            ctx.accounts.treasury_ata.owner,
            ctx.accounts.config.treasury,
            EscrowError::TreasuryAtaMismatch
        );
        require_keys_eq!(
            ctx.accounts.winner_ata.mint,
            ctx.accounts.bet.mint,
            EscrowError::WrongMint
        );
        require_keys_eq!(
            ctx.accounts.treasury_ata.mint,
            ctx.accounts.bet.mint,
            EscrowError::WrongMint
        );

        let total = amount.checked_mul(2).ok_or(EscrowError::MathOverflow)?;
        let fee = total
            .checked_mul(fee_bps)
            .ok_or(EscrowError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(EscrowError::MathOverflow)?;
        let payout = total.checked_sub(fee).ok_or(EscrowError::MathOverflow)?;

        let bet_id_bytes = bet_id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"bet", bet_id_bytes.as_ref(), &[bet_bump]];
        let signer_seeds = &[seeds];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.winner_ata.to_account_info(),
                    authority: ctx.accounts.bet.to_account_info(),
                },
                signer_seeds,
            ),
            payout,
        )?;

        if fee > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.treasury_ata.to_account_info(),
                        authority: ctx.accounts.bet.to_account_info(),
                    },
                    signer_seeds,
                ),
                fee,
            )?;
        }

        let bet = &mut ctx.accounts.bet;
        bet.status = BetStatus::Resolved;
        bet.winner = winner;
        Ok(())
    }

    /// Refund both depositors (mutual cancel, dispute timeout, etc.).
    pub fn refund(ctx: Context<Refund>, bet_id: u64) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.resolver.key(),
            ctx.accounts.config.resolver,
            EscrowError::UnauthorizedResolver
        );

        let bet_bump = ctx.accounts.bet.bump;
        let amount = ctx.accounts.bet.amount;
        let challenger_deposited = ctx.accounts.bet.challenger_deposited;
        let accepter_deposited = ctx.accounts.bet.accepter_deposited;

        {
            let bet = &ctx.accounts.bet;
            require!(
                bet.status == BetStatus::Pending || bet.status == BetStatus::Funded,
                EscrowError::InvalidState
            );
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
        }

        let bet_id_bytes = bet_id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"bet", bet_id_bytes.as_ref(), &[bet_bump]];
        let signer_seeds = &[seeds];

        if challenger_deposited {
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
        if accepter_deposited {
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

// ------------------------------------------------------------
// State accounts
// ------------------------------------------------------------

#[account]
pub struct Config {
    pub bump: u8,
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub resolver: Pubkey,
    pub fee_bps: u16,
}

impl Config {
    pub const LEN: usize = 1 + 32 + 32 + 32 + 2;
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
}

impl Bet {
    pub const LEN: usize = 1 + 8 + 32 + 32 + 8 + 32 + 32 + 1 + 1 + 1 + 32;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum BetStatus {
    Pending,
    Funded,
    Resolved,
    Refunded,
}

// ------------------------------------------------------------
// Instruction accounts
// ------------------------------------------------------------

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
#[instruction(bet_id: u64)]
pub struct InitializeBet<'info> {
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

    #[account(mut)]
    pub treasury_ata: Account<'info, TokenAccount>,

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

// ------------------------------------------------------------
// Errors
// ------------------------------------------------------------

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
    #[msg("Signer is not the config admin")]
    UnauthorizedAdmin,
    #[msg("Math overflow")]
    MathOverflow,
}
