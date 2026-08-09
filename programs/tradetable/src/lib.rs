// File: programs/tradetable/src/lib.rs
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use std::ops::Deref;
use anchor_spl::associated_token::{get_associated_token_address_with_program_id, AssociatedToken};
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use ephemeral_rollups_sdk::anchor::{action, commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::{DelegateConfig, DELEGATION_PROGRAM_ID};
use ephemeral_rollups_sdk::ephem::{CallHandler, MagicIntentBundleBuilder};
use ephemeral_rollups_sdk::{ActionArgs, ShortAccountMeta};
use solana_program::hash::hashv;

declare_id!("FRtW8QWScLWgDSwSWxnRTBhD8kMXg82aLV2qA3WCtXq3");

const ROOM_SEED: &[u8] = b"room";
const LIVE_SEED: &[u8] = b"live";
const VAULT_SEED: &[u8] = b"vault_authority";
const MIN_ROOM_SECONDS: i64 = 1_200;
const FULL_DEPOSIT_MASK: u8 = 0b11_1111;
const FULL_LOCK_MASK: u8 = 0b111;
const ACTION_COMPUTE_UNITS: u32 = 400_000;

#[ephemeral]
#[program]
pub mod tradetable {
    use super::*;

    pub fn initialize_room(
        ctx: Context<InitializeRoom>,
        room_nonce: u64,
        participants: [Pubkey; 3],
        expires_at: i64,
    ) -> Result<()> {
        validate_participants(&participants)?;
        let now = Clock::get()?.unix_timestamp;
        require!(expires_at >= now.checked_add(MIN_ROOM_SECONDS).ok_or(TradeError::ArithmeticOverflow)?, TradeError::InvalidExpiry);
        let core = &mut ctx.accounts.room_core;
        core.version = 1;
        core.core_bump = ctx.bumps.room_core;
        core.live_bump = ctx.bumps.room_live;
        core.vault_authority_bump = ctx.bumps.vault_authority;
        core.creator = ctx.accounts.creator.key();
        core.room_nonce = room_nonce;
        core.participants = participants;
        core.live_room = ctx.accounts.room_live.key();
        core.assets = [AssetRecord::default(); 6];
        core.deposited_mask = 0;
        core.returned_mask = 0;
        core.selected_mask = 0;
        core.status = CoreStatus::Funding;
        core.created_at = now;
        core.expires_at = expires_at;
        core.settled_revision = 0;
        core.allocation_hash = [0; 32];
        core.rent_payer = ctx.accounts.creator.key();
        core.reserved = [0; 64];
        initialize_live(&mut ctx.accounts.room_live, core, ctx.bumps.room_live);
        emit!(RoomInitialized { core: core.key(), live: core.live_room, participants, expires_at });
        Ok(())
    }

    pub fn deposit_asset(ctx: Context<DepositAsset>, slot: u8) -> Result<()> {
        let slot_index = usize::from(slot);
        require!(slot_index < 6, TradeError::SlotOutOfRange);
        let owner_index = slot_index / 2;
        let core = &mut ctx.accounts.room_core;
        require!(core.status == CoreStatus::Funding, TradeError::InvalidCoreStatus);
        require!(core.participants[owner_index] == ctx.accounts.participant.key(), TradeError::UnauthorizedParticipant);
        require!(core.deposited_mask & (1 << slot) == 0, TradeError::SlotAlreadyDeposited);
        validate_mint(&ctx.accounts.mint)?;
        validate_new_mint(core, ctx.accounts.mint.key())?;
        require!(ctx.accounts.source.owner == ctx.accounts.participant.key(), TradeError::InvalidSourceAccount);
        require!(ctx.accounts.source.mint == ctx.accounts.mint.key(), TradeError::InvalidSourceAccount);
        require!(ctx.accounts.source.amount == 1, TradeError::InvalidSourceAccount);
        require!(ctx.accounts.vault.amount == 0, TradeError::InvalidVault);
        transfer_one(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.source.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.participant.to_account_info(),
            None,
        )?;
        core.assets[slot_index] = AssetRecord {
            mint: ctx.accounts.mint.key(),
            vault: ctx.accounts.vault.key(),
            original_owner: ctx.accounts.participant.key(),
            original_ata: ctx.accounts.source.key(),
            final_ata: Pubkey::default(),
            deposited_at: Clock::get()?.unix_timestamp,
            flags: AssetRecord::DEPOSITED,
        };
        core.deposited_mask |= 1 << slot;
        emit!(AssetDeposited { core: core.key(), slot, mint: ctx.accounts.mint.key(), vault: ctx.accounts.vault.key() });
        Ok(())
    }

    pub fn activate_and_delegate_live(ctx: Context<ActivateAndDelegateLive>) -> Result<()> {
        let core = &mut ctx.accounts.room_core;
        require_participant(&core.participants, ctx.accounts.participant.key())?;
        require!(core.status == CoreStatus::Funding, TradeError::InvalidCoreStatus);
        require!(core.deposited_mask == FULL_DEPOSIT_MASK, TradeError::NotFullyFunded);
        require!(Clock::get()?.unix_timestamp < core.expires_at, TradeError::InvalidExpiry);
        core.status = CoreStatus::Active;
        let core_key = core.key();
        ctx.accounts.delegate_room_live(
            &ctx.accounts.participant,
            &[LIVE_SEED, core_key.as_ref()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|account| account.key()),
                ..Default::default()
            },
        )?;
        emit!(LiveDelegated { core: core_key, live: ctx.accounts.room_live.key() });
        Ok(())
    }

    pub fn propose(ctx: Context<MutateLive>, expected_revision: u64, selected_slots: [u8; 3], cycle: Cycle) -> Result<()> {
        let core = read_core(&ctx.accounts.room_core)?;
        validate_live_context(&core, &ctx.accounts.room_live, ctx.accounts.actor.key())?;
        require!(ctx.accounts.room_live.phase == LivePhase::Negotiating, TradeError::DealFrozen);
        require!(ctx.accounts.room_live.revision == expected_revision, TradeError::RevisionMismatch);
        validate_selection(&core, selected_slots)?;
        let destinations = destinations_for(cycle);
        let next_revision = expected_revision.checked_add(1).ok_or(TradeError::ArithmeticOverflow)?;
        let allocation_hash = allocation_hash(core.key(), next_revision, core.expires_at, selected_slots, cycle, destinations);
        let live = &mut ctx.accounts.room_live;
        live.revision = next_revision;
        live.selected_slots = selected_slots;
        live.cycle = cycle;
        live.destinations = destinations;
        live.allocation_hash = allocation_hash;
        clear_locks(live);
        set_live_audit(live, ctx.accounts.actor.key(), LiveAction::Proposed)?;
        emit!(ProposalChanged { core: core.key(), revision: next_revision, selected_slots, cycle, allocation_hash });
        Ok(())
    }

    pub fn lock(ctx: Context<MutateLive>, expected_revision: u64, expected_hash: [u8; 32]) -> Result<()> {
        let core = read_core(&ctx.accounts.room_core)?;
        validate_live_context(&core, &ctx.accounts.room_live, ctx.accounts.actor.key())?;
        require!(ctx.accounts.room_live.phase == LivePhase::Negotiating, TradeError::DealFrozen);
        require!(ctx.accounts.room_live.revision == expected_revision, TradeError::RevisionMismatch);
        require!(ctx.accounts.room_live.allocation_hash == expected_hash, TradeError::AllocationHashMismatch);
        let index = participant_index(&core.participants, ctx.accounts.actor.key())?;
        require!(ctx.accounts.room_live.lock_mask & (1 << index) == 0, TradeError::AlreadyLocked);
        let live = &mut ctx.accounts.room_live;
        live.locked_revision[index] = expected_revision;
        live.locked_hash[index] = expected_hash;
        live.lock_mask |= 1 << index;
        if live.lock_mask == FULL_LOCK_MASK {
            validate_lock_set(live)?;
            live.phase = LivePhase::Finalizing;
        }
        set_live_audit(live, ctx.accounts.actor.key(), LiveAction::Locked)?;
        emit!(LockChanged { core: core.key(), participant: ctx.accounts.actor.key(), revision: expected_revision, locked: true, lock_mask: live.lock_mask });
        Ok(())
    }

    pub fn revoke_lock(ctx: Context<MutateLive>, expected_revision: u64, expected_hash: [u8; 32]) -> Result<()> {
        let core = read_core(&ctx.accounts.room_core)?;
        validate_live_context(&core, &ctx.accounts.room_live, ctx.accounts.actor.key())?;
        require!(ctx.accounts.room_live.phase == LivePhase::Negotiating, TradeError::DealFrozen);
        require!(ctx.accounts.room_live.revision == expected_revision, TradeError::RevisionMismatch);
        require!(ctx.accounts.room_live.allocation_hash == expected_hash, TradeError::AllocationHashMismatch);
        let index = participant_index(&core.participants, ctx.accounts.actor.key())?;
        require!(ctx.accounts.room_live.lock_mask & (1 << index) != 0, TradeError::NotLocked);
        let live = &mut ctx.accounts.room_live;
        live.locked_revision[index] = 0;
        live.locked_hash[index] = [0; 32];
        live.lock_mask &= !(1 << index);
        set_live_audit(live, ctx.accounts.actor.key(), LiveAction::Revoked)?;
        emit!(LockChanged { core: core.key(), participant: ctx.accounts.actor.key(), revision: expected_revision, locked: false, lock_mask: live.lock_mask });
        Ok(())
    }

    pub fn finalize(ctx: Context<Finalize>) -> Result<()> {
        let core = read_core(&ctx.accounts.room_core)?;
        validate_live_context(&core, &ctx.accounts.room_live, ctx.accounts.payer.key())?;
        validate_lock_set(&ctx.accounts.room_live)?;
        validate_finalize_pubkeys(&core, &ctx.accounts.room_live, &ctx.accounts)?;
        let (revision, allocation_hash) = {
            let live = &mut ctx.accounts.room_live;
            require!(live.phase == LivePhase::Finalizing, TradeError::NotFinalizable);
            live.phase = LivePhase::Finalized;
            set_live_audit(live, ctx.accounts.payer.key(), LiveAction::Finalized)?;
            live.exit(&crate::ID).map_err(|_| TradeError::SerializationFailed)?;
            (live.revision, live.allocation_hash)
        };
        let handler = build_settle_handler(&ctx.accounts);
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.room_live.to_account_info()])
        .add_post_commit_actions([handler])
        .build_and_invoke()?;
        emit!(FinalizationScheduled { core: core.key(), revision, allocation_hash });
        Ok(())
    }

    pub fn finalize_commit_only(ctx: Context<FinalizeCommitOnly>) -> Result<()> {
        let core = read_core(&ctx.accounts.room_core)?;
        validate_live_context(&core, &ctx.accounts.room_live, ctx.accounts.payer.key())?;
        validate_lock_set(&ctx.accounts.room_live)?;
        let (revision, allocation_hash) = mark_live_finalized(&mut ctx.accounts.room_live, ctx.accounts.payer.key())?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.room_live.to_account_info()])
        .build_and_invoke()?;
        emit!(FinalizationScheduled { core: core.key(), revision, allocation_hash });
        Ok(())
    }

    pub fn settle_action(mut ctx: Context<SettleAction>) -> Result<()> {
        settle_from_accounts(SettlementAccounts::from_action(&mut ctx.accounts))
    }

    pub fn settle_committed(mut ctx: Context<SettleCommitted>) -> Result<()> {
        settle_from_accounts(SettlementAccounts::from_committed(&mut ctx.accounts))
    }

    pub fn cancel_by_participant(ctx: Context<CancelByParticipant>) -> Result<()> {
        require_participant(&ctx.accounts.room_core.participants, ctx.accounts.participant.key())?;
        cancel_core(&mut ctx.accounts.room_core, ctx.accounts.participant.key(), false)
    }

    pub fn cancel_expired(ctx: Context<CancelExpired>) -> Result<()> {
        require!(Clock::get()?.unix_timestamp >= ctx.accounts.room_core.expires_at, TradeError::NotExpired);
        cancel_core(&mut ctx.accounts.room_core, ctx.accounts.caller.key(), true)
    }

    pub fn return_asset(ctx: Context<ReturnAsset>, slot: u8) -> Result<()> {
        let index = usize::from(slot);
        require!(index < 6, TradeError::SlotOutOfRange);
        validate_return(&ctx.accounts.room_core, index, &ctx.accounts)?;
        let core_key = ctx.accounts.room_core.key();
        let signer: &[&[u8]] = &[VAULT_SEED, core_key.as_ref(), &[ctx.accounts.room_core.vault_authority_bump]];
        transfer_one(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.original_ata.to_account_info(),
            ctx.accounts.vault_authority.to_account_info(),
            Some(signer),
        )?;
        let core = &mut ctx.accounts.room_core;
        if core.status == CoreStatus::Settled { core.status = CoreStatus::Returning; }
        core.assets[index].flags |= AssetRecord::RETURNED;
        core.returned_mask |= 1 << slot;
        finish_returns_if_empty(core);
        emit!(AssetReturned { core: core_key, slot, mint: ctx.accounts.mint.key(), destination: ctx.accounts.original_ata.key() });
        Ok(())
    }
}

fn initialize_live(live: &mut Account<RoomLive>, core: &Account<RoomCore>, bump: u8) {
    live.version = 1;
    live.bump = bump;
    live.core = core.key();
    live.participants = core.participants;
    live.expires_at = core.expires_at;
    live.revision = 0;
    live.selected_slots = [0, 2, 4];
    live.cycle = Cycle::Forward;
    live.destinations = [1, 2, 0];
    live.allocation_hash = [0; 32];
    live.locked_revision = [0; 3];
    live.locked_hash = [[0; 32]; 3];
    live.lock_mask = 0;
    live.phase = LivePhase::Negotiating;
    live.last_actor = Pubkey::default();
    live.last_action = LiveAction::Initialized;
    live.updated_at = core.created_at;
    live.reserved = [0; 64];
}

fn validate_participants(participants: &[Pubkey; 3]) -> Result<()> {
    require!(participants.iter().all(|key| *key != Pubkey::default()), TradeError::InvalidParticipants);
    require!(participants[0] != participants[1], TradeError::InvalidParticipants);
    require!(participants[0] != participants[2], TradeError::InvalidParticipants);
    require!(participants[1] != participants[2], TradeError::InvalidParticipants);
    Ok(())
}

fn participant_index(participants: &[Pubkey; 3], actor: Pubkey) -> Result<usize> {
    participants.iter().position(|key| *key == actor).ok_or_else(|| error!(TradeError::UnauthorizedParticipant))
}

fn require_participant(participants: &[Pubkey; 3], actor: Pubkey) -> Result<()> {
    participant_index(participants, actor).map(|_| ())
}

fn validate_mint(mint: &Account<Mint>) -> Result<()> {
    validate_mint_data(mint)
}

fn validate_new_mint(core: &RoomCore, mint: Pubkey) -> Result<()> {
    let duplicate = core.assets.iter().any(|asset| asset.flags & AssetRecord::DEPOSITED != 0 && asset.mint == mint);
    require!(!duplicate, TradeError::DuplicateMint);
    Ok(())
}

fn validate_selection(core: &RoomCore, slots: [u8; 3]) -> Result<()> {
    require!(slots[0] <= 1 && (2..=3).contains(&slots[1]) && (4..=5).contains(&slots[2]), TradeError::InvalidSelection);
    require!(slots.iter().all(|slot| core.deposited_mask & (1 << slot) != 0), TradeError::InvalidSelection);
    Ok(())
}

fn destinations_for(cycle: Cycle) -> [u8; 3] {
    match cycle {
        Cycle::Forward => [1, 2, 0],
        Cycle::Reverse => [2, 0, 1],
    }
}

fn allocation_hash(core: Pubkey, revision: u64, expiry: i64, slots: [u8; 3], cycle: Cycle, destinations: [u8; 3]) -> [u8; 32] {
    hashv(&[
        b"tradetable-allocation-v1",
        core.as_ref(),
        &revision.to_le_bytes(),
        &expiry.to_le_bytes(),
        &slots,
        &[cycle as u8],
        &destinations,
    ]).to_bytes()
}

fn clear_locks(live: &mut RoomLive) {
    live.locked_revision = [0; 3];
    live.locked_hash = [[0; 32]; 3];
    live.lock_mask = 0;
}

fn validate_lock_set(live: &RoomLive) -> Result<()> {
    require!(live.lock_mask == FULL_LOCK_MASK, TradeError::NotFinalizable);
    for index in 0..3 {
        require!(live.locked_revision[index] == live.revision, TradeError::RevisionMismatch);
        require!(live.locked_hash[index] == live.allocation_hash, TradeError::AllocationHashMismatch);
    }
    Ok(())
}

fn mark_live_finalized(live: &mut Account<RoomLive>, actor: Pubkey) -> Result<(u64, [u8; 32])> {
    require!(live.phase == LivePhase::Finalizing, TradeError::NotFinalizable);
    live.phase = LivePhase::Finalized;
    set_live_audit(live, actor, LiveAction::Finalized)?;
    live.exit(&crate::ID).map_err(|_| TradeError::SerializationFailed)?;
    Ok((live.revision, live.allocation_hash))
}

fn set_live_audit(live: &mut RoomLive, actor: Pubkey, action: LiveAction) -> Result<()> {
    live.last_actor = actor;
    live.last_action = action;
    live.updated_at = Clock::get()?.unix_timestamp;
    Ok(())
}

struct DecodedAccount<T> { key: Pubkey, value: T }

impl<T> DecodedAccount<T> { fn key(&self) -> Pubkey { self.key } }
impl<T> Deref for DecodedAccount<T> { type Target = T; fn deref(&self) -> &T { &self.value } }

fn read_core(account: &UncheckedAccount) -> Result<Box<DecodedAccount<RoomCore>>> {
    require_keys_eq!(*account.owner, crate::ID, TradeError::InvalidAccountOwner);
    let data = account.try_borrow_data()?;
    let value = RoomCore::try_deserialize(&mut data.as_ref()).map_err(|_| error!(TradeError::SerializationFailed))?;
    let (expected, _) = Pubkey::find_program_address(&[ROOM_SEED, value.creator.as_ref(), &value.room_nonce.to_le_bytes()], &crate::ID);
    require_keys_eq!(expected, account.key(), TradeError::InvalidAccountPda);
    Ok(Box::new(DecodedAccount { key: account.key(), value }))
}

fn read_live(account: &UncheckedAccount, expected_owner: Pubkey) -> Result<Box<DecodedAccount<RoomLive>>> {
    require_keys_eq!(*account.owner, expected_owner, TradeError::InvalidAccountOwner);
    let data = account.try_borrow_data()?;
    let value = RoomLive::try_deserialize(&mut data.as_ref()).map_err(|_| error!(TradeError::SerializationFailed))?;
    let (expected, _) = Pubkey::find_program_address(&[LIVE_SEED, value.core.as_ref()], &crate::ID);
    require_keys_eq!(expected, account.key(), TradeError::InvalidAccountPda);
    Ok(Box::new(DecodedAccount { key: account.key(), value }))
}

fn validate_live_context(core: &DecodedAccount<RoomCore>, live: &Account<RoomLive>, actor: Pubkey) -> Result<()> {
    require!(core.status == CoreStatus::Active, TradeError::InvalidCoreStatus);
    require!(core.live_room == live.key() && live.core == core.key(), TradeError::CoreLiveMismatch);
    require!(core.participants == live.participants && core.expires_at == live.expires_at, TradeError::CoreLiveMismatch);
    require!(Clock::get()?.unix_timestamp < core.expires_at, TradeError::InvalidExpiry);
    require_participant(&core.participants, actor)
}

fn cancel_core(core: &mut Account<RoomCore>, actor: Pubkey, expired: bool) -> Result<()> {
    require!(matches!(core.status, CoreStatus::Funding | CoreStatus::Active), TradeError::InvalidCoreStatus);
    core.status = CoreStatus::Cancelled;
    emit!(RoomCancelled { core: core.key(), actor, expired });
    Ok(())
}

fn transfer_one<'info>(
    token_program: AccountInfo<'info>,
    from: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    signer: Option<&[&[u8]]>,
) -> Result<()> {
    let accounts = TransferChecked { from, mint, to, authority };
    match signer {
        Some(seeds) => token::transfer_checked(CpiContext::new_with_signer(token_program, accounts, &[seeds]), 1, 0),
        None => token::transfer_checked(CpiContext::new(token_program, accounts), 1, 0),
    }
}

fn finish_returns_if_empty(core: &mut RoomCore) {
    let required = match core.status {
        CoreStatus::Returning => core.deposited_mask & !core.selected_mask,
        CoreStatus::Cancelled => core.deposited_mask,
        _ => 0,
    };
    if required != 0 && core.returned_mask & required == required {
        core.status = if core.status == CoreStatus::Returning { CoreStatus::Complete } else { CoreStatus::Closed };
    }
}

fn validate_return(core: &RoomCore, index: usize, accounts: &ReturnAsset) -> Result<()> {
    let bit = 1u8 << index;
    require!(core.deposited_mask & bit != 0, TradeError::NotReturnable);
    require!(core.returned_mask & bit == 0, TradeError::AlreadyReturned);
    let returnable = core.status == CoreStatus::Cancelled || (matches!(core.status, CoreStatus::Settled | CoreStatus::Returning) && core.selected_mask & bit == 0);
    require!(returnable, TradeError::NotReturnable);
    let asset = core.assets[index];
    require!(asset.mint == accounts.mint.key() && asset.vault == accounts.vault.key(), TradeError::InvalidVault);
    require!(asset.original_ata == accounts.original_ata.key(), TradeError::InvalidDestination);
    require!(asset.original_owner == accounts.original_owner.key(), TradeError::InvalidDestination);
    require!(accounts.vault.amount == 1 && accounts.vault.owner == accounts.vault_authority.key(), TradeError::VaultNotFunded);
    require!(accounts.original_ata.mint == asset.mint && accounts.original_ata.owner == asset.original_owner, TradeError::InvalidDestination);
    Ok(())
}

fn validate_finalize_pubkeys(core: &RoomCore, live: &RoomLive, accounts: &Finalize) -> Result<()> {
    require!(live.destinations == destinations_for(live.cycle), TradeError::InvalidCycle);
    require!(live.destinations.iter().all(|index| *index < 3), TradeError::InvalidCycle);
    let mints = [accounts.mint_0.key(), accounts.mint_1.key(), accounts.mint_2.key()];
    let vaults = [accounts.vault_0.key(), accounts.vault_1.key(), accounts.vault_2.key()];
    let destinations = [accounts.destination_0.key(), accounts.destination_1.key(), accounts.destination_2.key()];
    for leg in 0..3 {
        let asset = core.assets[usize::from(live.selected_slots[leg])];
        require!(asset.mint == mints[leg] && asset.vault == vaults[leg], TradeError::InvalidSettlementAccounts);
        let recipient = core.participants[usize::from(live.destinations[leg])];
        let expected = get_associated_token_address_with_program_id(&recipient, &asset.mint, &token::ID);
        require!(expected == destinations[leg], TradeError::InvalidDestination);
    }
    Ok(())
}

fn build_settle_handler<'info>(accounts: &Finalize<'info>) -> CallHandler<'info> {
    let metas = vec![
        ShortAccountMeta { pubkey: accounts.room_core.key(), is_writable: true },
        ShortAccountMeta { pubkey: accounts.room_live.key(), is_writable: false },
        ShortAccountMeta { pubkey: accounts.vault_authority.key(), is_writable: false },
        ShortAccountMeta { pubkey: accounts.token_program.key(), is_writable: false },
        ShortAccountMeta { pubkey: accounts.mint_0.key(), is_writable: false },
        ShortAccountMeta { pubkey: accounts.vault_0.key(), is_writable: true },
        ShortAccountMeta { pubkey: accounts.destination_0.key(), is_writable: true },
        ShortAccountMeta { pubkey: accounts.mint_1.key(), is_writable: false },
        ShortAccountMeta { pubkey: accounts.vault_1.key(), is_writable: true },
        ShortAccountMeta { pubkey: accounts.destination_1.key(), is_writable: true },
        ShortAccountMeta { pubkey: accounts.mint_2.key(), is_writable: false },
        ShortAccountMeta { pubkey: accounts.vault_2.key(), is_writable: true },
        ShortAccountMeta { pubkey: accounts.destination_2.key(), is_writable: true },
    ];
    CallHandler {
        args: ActionArgs::new(hashv(&[b"global:settle_action"]).to_bytes()[..8].to_vec()),
        compute_units: ACTION_COMPUTE_UNITS,
        escrow_authority: accounts.payer.to_account_info(),
        destination_program: crate::ID,
        accounts: metas,
    }
}

struct SettlementAccounts<'a, 'info> {
    core: &'a mut Account<'info, RoomCore>,
    live: &'a UncheckedAccount<'info>,
    authority: &'a UncheckedAccount<'info>,
    token_program: AccountInfo<'info>,
    mints: [AccountInfo<'info>; 3],
    vaults: [AccountInfo<'info>; 3],
    destinations: [AccountInfo<'info>; 3],
    live_owner: Pubkey,
}

impl<'a, 'info> SettlementAccounts<'a, 'info> {
    fn from_action(value: &'a mut SettleAction<'info>) -> Self {
        Self::new(&mut value.room_core, &value.room_live, &value.vault_authority, value.token_program.to_account_info(), [&value.mint_0, &value.mint_1, &value.mint_2], [&value.vault_0, &value.vault_1, &value.vault_2], [&value.destination_0, &value.destination_1, &value.destination_2], DELEGATION_PROGRAM_ID)
    }

    fn from_committed(value: &'a mut SettleCommitted<'info>) -> Self {
        Self::new(&mut value.room_core, &value.room_live, &value.vault_authority, value.token_program.to_account_info(), [&value.mint_0, &value.mint_1, &value.mint_2], [&value.vault_0, &value.vault_1, &value.vault_2], [&value.destination_0, &value.destination_1, &value.destination_2], crate::ID)
    }

    fn new(core: &'a mut Account<'info, RoomCore>, live: &'a UncheckedAccount<'info>, authority: &'a UncheckedAccount<'info>, token_program: AccountInfo<'info>, mints: [&AccountInfo<'info>; 3], vaults: [&AccountInfo<'info>; 3], destinations: [&AccountInfo<'info>; 3], live_owner: Pubkey) -> Self {
        Self { core, live, authority, token_program, mints: mints.map(Clone::clone), vaults: vaults.map(Clone::clone), destinations: destinations.map(Clone::clone), live_owner }
    }
}

fn settle_from_accounts(mut accounts: SettlementAccounts) -> Result<()> {
    require!(accounts.core.status == CoreStatus::Active, TradeError::AlreadySettled);
    let live = read_live(accounts.live, accounts.live_owner)?;
    require!(live.core == accounts.core.key() && accounts.core.live_room == accounts.live.key(), TradeError::CoreLiveMismatch);
    require!(live.participants == accounts.core.participants && live.expires_at == accounts.core.expires_at, TradeError::CoreLiveMismatch);
    require!(Clock::get()?.unix_timestamp < accounts.core.expires_at, TradeError::InvalidExpiry);
    require!(live.phase == LivePhase::Finalized, TradeError::NotFinalizable);
    validate_lock_set(&live)?;
    validate_selection(accounts.core, live.selected_slots)?;
    require!(live.destinations == destinations_for(live.cycle), TradeError::InvalidCycle);
    require!(live.destinations.iter().all(|index| *index < 3), TradeError::InvalidCycle);
    let expected_hash = allocation_hash(accounts.core.key(), live.revision, live.expires_at, live.selected_slots, live.cycle, live.destinations);
    require!(expected_hash == live.allocation_hash, TradeError::AllocationHashMismatch);
    let core_key = accounts.core.key();
    let signer: &[&[u8]] = &[VAULT_SEED, core_key.as_ref(), &[accounts.core.vault_authority_bump]];
    let mut selected_mask = 0u8;
    for leg in 0..3 {
        settle_leg(&mut accounts, &live, leg, signer)?;
        selected_mask |= 1 << live.selected_slots[leg];
    }
    accounts.core.selected_mask = selected_mask;
    accounts.core.settled_revision = live.revision;
    accounts.core.allocation_hash = live.allocation_hash;
    accounts.core.status = CoreStatus::Settled;
    emit!(RoomSettled { core: core_key, revision: live.revision, allocation_hash: live.allocation_hash, selected_mask });
    Ok(())
}

fn settle_leg(accounts: &mut SettlementAccounts, live: &RoomLive, leg: usize, signer: &[&[u8]]) -> Result<()> {
    let slot = usize::from(live.selected_slots[leg]);
    let asset = accounts.core.assets[slot];
    let mint = decode_mint(&accounts.mints[leg])?;
    let vault = decode_token_account(&accounts.vaults[leg], TradeError::InvalidVault)?;
    let destination = decode_token_account(&accounts.destinations[leg], TradeError::InvalidDestination)?;
    validate_mint_data(&mint)?;
    require!(asset.mint == accounts.mints[leg].key() && asset.vault == accounts.vaults[leg].key(), TradeError::InvalidSettlementAccounts);
    require!(vault.owner == accounts.authority.key() && vault.amount == 1, TradeError::VaultNotFunded);
    let recipient = accounts.core.participants[usize::from(live.destinations[leg])];
    let expected = get_associated_token_address_with_program_id(&recipient, accounts.mints[leg].key, &token::ID);
    require!(accounts.destinations[leg].key() == expected && destination.owner == recipient && destination.mint == accounts.mints[leg].key(), TradeError::InvalidDestination);
    transfer_one(accounts.token_program.clone(), accounts.vaults[leg].clone(), accounts.mints[leg].clone(), accounts.destinations[leg].clone(), accounts.authority.to_account_info(), Some(signer))?;
    accounts.core.assets[slot].flags |= AssetRecord::SELECTED | AssetRecord::TRANSFERRED;
    accounts.core.assets[slot].final_ata = accounts.destinations[leg].key();
    Ok(())
}

fn decode_mint(info: &AccountInfo) -> Result<Mint> {
    let data = info.try_borrow_data()?;
    Mint::try_deserialize(&mut data.as_ref()).map_err(|_| error!(TradeError::InvalidMintPolicy))
}

fn decode_token_account(info: &AccountInfo, error_code: TradeError) -> Result<TokenAccount> {
    let data = info.try_borrow_data()?;
    TokenAccount::try_deserialize(&mut data.as_ref()).map_err(|_| error!(error_code))
}

fn validate_mint_data(mint: &Mint) -> Result<()> {
    require!(mint.is_initialized, TradeError::InvalidMintPolicy);
    require!(mint.decimals == 0 && mint.supply == 1, TradeError::InvalidMintPolicy);
    require!(mint.mint_authority == COption::None, TradeError::InvalidMintPolicy);
    require!(mint.freeze_authority == COption::None, TradeError::InvalidMintPolicy);
    Ok(())
}

#[derive(Accounts)]
#[instruction(room_nonce: u64)]
pub struct InitializeRoom<'info> {
    #[account(mut)] pub creator: Signer<'info>,
    #[account(init, payer = creator, space = 1350, seeds = [ROOM_SEED, creator.key().as_ref(), &room_nonce.to_le_bytes()], bump)]
    pub room_core: Box<Account<'info, RoomCore>>,
    #[account(init, payer = creator, space = 420, seeds = [LIVE_SEED, room_core.key().as_ref()], bump)]
    pub room_live: Box<Account<'info, RoomLive>>,
    /// CHECK: signer-only PDA; no data account is initialized.
    #[account(seeds = [VAULT_SEED, room_core.key().as_ref()], bump)] pub vault_authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositAsset<'info> {
    #[account(mut)] pub participant: Signer<'info>,
    #[account(mut, seeds = [ROOM_SEED, room_core.creator.as_ref(), &room_core.room_nonce.to_le_bytes()], bump = room_core.core_bump)]
    pub room_core: Box<Account<'info, RoomCore>>,
    /// CHECK: validated by seeds.
    #[account(seeds = [VAULT_SEED, room_core.key().as_ref()], bump = room_core.vault_authority_bump)] pub vault_authority: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = participant, associated_token::token_program = token_program)]
    pub source: Account<'info, TokenAccount>,
    #[account(init_if_needed, payer = participant, associated_token::mint = mint, associated_token::authority = vault_authority, associated_token::token_program = token_program)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct ActivateAndDelegateLive<'info> {
    #[account(mut)] pub participant: Signer<'info>,
    #[account(mut, seeds = [ROOM_SEED, room_core.creator.as_ref(), &room_core.room_nonce.to_le_bytes()], bump = room_core.core_bump)]
    pub room_core: Box<Account<'info, RoomCore>>,
    /// CHECK: linked and delegated by generated helper.
    #[account(mut, del, address = room_core.live_room)] pub room_live: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct MutateLive<'info> {
    pub actor: Signer<'info>,
    /// CHECK: base-owned account manually deserialized and read only.
    pub room_core: UncheckedAccount<'info>,
    #[account(mut, seeds = [LIVE_SEED, room_core.key().as_ref()], bump = room_live.bump)] pub room_live: Box<Account<'info, RoomLive>>,
}

#[commit]
#[derive(Accounts)]
pub struct Finalize<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    /// CHECK: base account manually deserialized; read-only in outer ER instruction.
    pub room_core: UncheckedAccount<'info>,
    #[account(mut, seeds = [LIVE_SEED, room_core.key().as_ref()], bump = room_live.bump)] pub room_live: Box<Account<'info, RoomLive>>,
    /// CHECK: exact PDA revalidated by settlement.
    pub vault_authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: selected accounts are read-only outer metas and validated by pubkey.
    pub mint_0: UncheckedAccount<'info>,
    /// CHECK: selected vault encoded writable only for base handler.
    pub vault_0: UncheckedAccount<'info>,
    /// CHECK: selected destination encoded writable only for base handler.
    pub destination_0: UncheckedAccount<'info>,
    /// CHECK: selected mint is validated by pubkey.
    pub mint_1: UncheckedAccount<'info>,
    /// CHECK: selected vault is encoded writable only for the base handler.
    pub vault_1: UncheckedAccount<'info>,
    /// CHECK: selected destination is encoded writable only for the base handler.
    pub destination_1: UncheckedAccount<'info>,
    /// CHECK: selected mint is validated by pubkey.
    pub mint_2: UncheckedAccount<'info>,
    /// CHECK: selected vault is encoded writable only for the base handler.
    pub vault_2: UncheckedAccount<'info>,
    /// CHECK: selected destination is encoded writable only for the base handler.
    pub destination_2: UncheckedAccount<'info>,
    /// CHECK: must equal crate ID.
    #[account(address = crate::ID)] pub program_id: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct FinalizeCommitOnly<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    /// CHECK: base account manually deserialized; read-only in the ER instruction.
    pub room_core: UncheckedAccount<'info>,
    #[account(mut, seeds = [LIVE_SEED, room_core.key().as_ref()], bump = room_live.bump)]
    pub room_live: Box<Account<'info, RoomLive>>,
}

#[action]
#[derive(Accounts)]
pub struct SettleAction<'info> {
    #[account(mut, seeds = [ROOM_SEED, room_core.creator.as_ref(), &room_core.room_nonce.to_le_bytes()], bump = room_core.core_bump)]
    pub room_core: Box<Account<'info, RoomCore>>,
    /// CHECK: freshly committed data manually deserialized.
    #[account(address = room_core.live_room)] pub room_live: UncheckedAccount<'info>,
    /// CHECK: PDA seeds validated in shared settlement.
    #[account(seeds = [VAULT_SEED, room_core.key().as_ref()], bump = room_core.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: shared settlement validates the selected mint.
    pub mint_0: AccountInfo<'info>,
    /// CHECK: shared settlement validates ownership, mint, and amount.
    #[account(mut)]
    pub vault_0: AccountInfo<'info>,
    /// CHECK: shared settlement validates the canonical recipient ATA.
    #[account(mut)]
    pub destination_0: AccountInfo<'info>,
    /// CHECK: shared settlement validates the selected mint.
    pub mint_1: AccountInfo<'info>,
    /// CHECK: shared settlement validates ownership, mint, and amount.
    #[account(mut)]
    pub vault_1: AccountInfo<'info>,
    /// CHECK: shared settlement validates the canonical recipient ATA.
    #[account(mut)]
    pub destination_1: AccountInfo<'info>,
    /// CHECK: shared settlement validates the selected mint.
    pub mint_2: AccountInfo<'info>,
    /// CHECK: shared settlement validates ownership, mint, and amount.
    #[account(mut)]
    pub vault_2: AccountInfo<'info>,
    /// CHECK: shared settlement validates the canonical recipient ATA.
    #[account(mut)]
    pub destination_2: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct SettleCommitted<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [ROOM_SEED, room_core.creator.as_ref(), &room_core.room_nonce.to_le_bytes()], bump = room_core.core_bump)]
    pub room_core: Box<Account<'info, RoomCore>>,
    /// CHECK: committed and undelegated data manually deserialized.
    #[account(address = room_core.live_room)] pub room_live: UncheckedAccount<'info>,
    /// CHECK: PDA seeds validated in shared settlement.
    #[account(seeds = [VAULT_SEED, room_core.key().as_ref()], bump = room_core.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: shared settlement validates the selected mint.
    pub mint_0: AccountInfo<'info>,
    /// CHECK: shared settlement validates ownership, mint, and amount.
    #[account(mut)]
    pub vault_0: AccountInfo<'info>,
    /// CHECK: shared settlement validates the canonical recipient ATA.
    #[account(mut)]
    pub destination_0: AccountInfo<'info>,
    /// CHECK: shared settlement validates the selected mint.
    pub mint_1: AccountInfo<'info>,
    /// CHECK: shared settlement validates ownership, mint, and amount.
    #[account(mut)]
    pub vault_1: AccountInfo<'info>,
    /// CHECK: shared settlement validates the canonical recipient ATA.
    #[account(mut)]
    pub destination_1: AccountInfo<'info>,
    /// CHECK: shared settlement validates the selected mint.
    pub mint_2: AccountInfo<'info>,
    /// CHECK: shared settlement validates ownership, mint, and amount.
    #[account(mut)]
    pub vault_2: AccountInfo<'info>,
    /// CHECK: shared settlement validates the canonical recipient ATA.
    #[account(mut)]
    pub destination_2: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct CancelByParticipant<'info> {
    pub participant: Signer<'info>,
    #[account(mut, seeds = [ROOM_SEED, room_core.creator.as_ref(), &room_core.room_nonce.to_le_bytes()], bump = room_core.core_bump)]
    pub room_core: Box<Account<'info, RoomCore>>,
}

#[derive(Accounts)]
pub struct CancelExpired<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [ROOM_SEED, room_core.creator.as_ref(), &room_core.room_nonce.to_le_bytes()], bump = room_core.core_bump)]
    pub room_core: Box<Account<'info, RoomCore>>,
}

#[derive(Accounts)]
#[instruction(slot: u8)]
pub struct ReturnAsset<'info> {
    #[account(mut)] pub caller: Signer<'info>,
    #[account(mut, seeds = [ROOM_SEED, room_core.creator.as_ref(), &room_core.room_nonce.to_le_bytes()], bump = room_core.core_bump)]
    pub room_core: Box<Account<'info, RoomCore>>,
    /// CHECK: exact signer PDA.
    #[account(seeds = [VAULT_SEED, room_core.key().as_ref()], bump = room_core.vault_authority_bump)] pub vault_authority: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut)] pub vault: Account<'info, TokenAccount>,
    /// CHECK: compared with the immutable owner recorded for the selected slot.
    pub original_owner: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = caller, associated_token::mint = mint, associated_token::authority = original_owner, associated_token::token_program = token_program)]
    pub original_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct RoomCore {
    pub version: u8, pub core_bump: u8, pub live_bump: u8, pub vault_authority_bump: u8,
    pub creator: Pubkey, pub room_nonce: u64, pub participants: [Pubkey; 3], pub live_room: Pubkey,
    pub assets: [AssetRecord; 6], pub deposited_mask: u8, pub returned_mask: u8, pub selected_mask: u8,
    pub status: CoreStatus, pub created_at: i64, pub expires_at: i64, pub settled_revision: u64,
    pub allocation_hash: [u8; 32], pub rent_payer: Pubkey, pub reserved: [u8; 64],
}

#[account]
#[derive(InitSpace)]
pub struct RoomLive {
    pub version: u8, pub bump: u8, pub core: Pubkey, pub participants: [Pubkey; 3], pub expires_at: i64,
    pub revision: u64, pub selected_slots: [u8; 3], pub cycle: Cycle, pub destinations: [u8; 3],
    pub allocation_hash: [u8; 32], pub locked_revision: [u64; 3], pub locked_hash: [[u8; 32]; 3],
    pub lock_mask: u8, pub phase: LivePhase, pub last_actor: Pubkey, pub last_action: LiveAction,
    pub updated_at: i64, pub reserved: [u8; 64],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct AssetRecord {
    pub mint: Pubkey, pub vault: Pubkey, pub original_owner: Pubkey, pub original_ata: Pubkey,
    pub final_ata: Pubkey, pub deposited_at: i64, pub flags: u8,
}

impl AssetRecord {
    pub const DEPOSITED: u8 = 1; pub const SELECTED: u8 = 2; pub const TRANSFERRED: u8 = 4; pub const RETURNED: u8 = 8;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum CoreStatus { Funding, Active, Settled, Returning, Complete, Cancelled, Closed }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum LivePhase { Negotiating, Finalizing, Finalized }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum Cycle { Forward, Reverse }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum LiveAction { Initialized, Proposed, Locked, Revoked, Finalized }

#[event] pub struct RoomInitialized { pub core: Pubkey, pub live: Pubkey, pub participants: [Pubkey; 3], pub expires_at: i64 }
#[event] pub struct AssetDeposited { pub core: Pubkey, pub slot: u8, pub mint: Pubkey, pub vault: Pubkey }
#[event] pub struct LiveDelegated { pub core: Pubkey, pub live: Pubkey }
#[event] pub struct ProposalChanged { pub core: Pubkey, pub revision: u64, pub selected_slots: [u8; 3], pub cycle: Cycle, pub allocation_hash: [u8; 32] }
#[event] pub struct LockChanged { pub core: Pubkey, pub participant: Pubkey, pub revision: u64, pub locked: bool, pub lock_mask: u8 }
#[event] pub struct FinalizationScheduled { pub core: Pubkey, pub revision: u64, pub allocation_hash: [u8; 32] }
#[event] pub struct RoomSettled { pub core: Pubkey, pub revision: u64, pub allocation_hash: [u8; 32], pub selected_mask: u8 }
#[event] pub struct RoomCancelled { pub core: Pubkey, pub actor: Pubkey, pub expired: bool }
#[event] pub struct AssetReturned { pub core: Pubkey, pub slot: u8, pub mint: Pubkey, pub destination: Pubkey }

#[error_code]
pub enum TradeError {
    #[msg("participants must be three distinct non-default wallets")] InvalidParticipants,
    #[msg("expiry is invalid")] InvalidExpiry,
    #[msg("signer is not authorized for this participant action")] UnauthorizedParticipant,
    #[msg("core status rejects this instruction")] InvalidCoreStatus,
    #[msg("live phase rejects this instruction")] InvalidLivePhase,
    #[msg("slot is outside zero through five")] SlotOutOfRange,
    #[msg("slot already contains a deposit")] SlotAlreadyDeposited,
    #[msg("mint already appears in this room")] DuplicateMint,
    #[msg("mint is not an immutable classic supply-one asset")] InvalidMintPolicy,
    #[msg("source token account is invalid")] InvalidSourceAccount,
    #[msg("vault account is invalid")] InvalidVault,
    #[msg("all six deposits are required")] NotFullyFunded,
    #[msg("expected revision does not match current revision")] RevisionMismatch,
    #[msg("selection must contain one funded slot from each owner")] InvalidSelection,
    #[msg("cycle is not a complete three-party derangement")] InvalidCycle,
    #[msg("allocation hash does not match current proposal")] AllocationHashMismatch,
    #[msg("participant already locked this revision")] AlreadyLocked,
    #[msg("participant has no matching lock")] NotLocked,
    #[msg("deal is frozen after the third lock")] DealFrozen,
    #[msg("live state is not finalizable")] NotFinalizable,
    #[msg("core and live accounts do not match")] CoreLiveMismatch,
    #[msg("destination ATA is invalid")] InvalidDestination,
    #[msg("settlement account ordering or identity is invalid")] InvalidSettlementAccounts,
    #[msg("room consequence has already completed")] AlreadySettled,
    #[msg("room has not expired")] NotExpired,
    #[msg("asset is not returnable in this state")] NotReturnable,
    #[msg("asset was already returned")] AlreadyReturned,
    #[msg("vault does not hold the expected asset")] VaultNotFunded,
    #[msg("arithmetic overflow")] ArithmeticOverflow,
    #[msg("account serialization failed")] SerializationFailed,
    #[msg("unchecked account is not owned by TradeTable")] InvalidAccountOwner,
    #[msg("unchecked account does not match its canonical PDA")] InvalidAccountPda,
}
