//! # $HIVE token
//!
//! NEP-141 fungible token (with NEP-145 storage management and NEP-148 metadata) minted to
//! Hivemind contributors when The Arena accepts their contribution.
//!
//! - Supply starts at 0. Only the `minter` (the Hivemind core contract) can mint.
//! - `ft_mint` registers new holders automatically, paying their storage from the token
//!   contract's own balance, so contributors receive $HIVE without a separate storage deposit.

use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{
    FT_METADATA_SPEC, FungibleTokenMetadata, FungibleTokenMetadataProvider,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::collections::LazyOption;
use near_sdk::json_types::U128;
use near_sdk::{
    AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue, env, log, near, require,
};

#[cfg(test)]
mod tests;

pub const DECIMALS: u8 = 18;

const ICON: &str = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%2300ec97'/%3E%3Cstop offset='1' stop-color='%239b6bff'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath d='M32 3l25 14.5v29L32 61 7 46.5v-29z' fill='%230b0d16' stroke='url(%23g)' stroke-width='4'/%3E%3Cpath d='M32 18l12 7v14l-12 7-12-7V25z' fill='url(%23g)'/%3E%3C/svg%3E";

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    FungibleToken,
    Metadata,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct HiveToken {
    token: FungibleToken,
    metadata: LazyOption<FungibleTokenMetadata>,
    owner: AccountId,
    minter: AccountId,
}

#[near]
impl HiveToken {
    /// Deploy with zero supply. `minter` is the Hivemind core contract.
    #[init]
    pub fn new(owner: AccountId, minter: AccountId) -> Self {
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Hivemind".to_string(),
            symbol: "HIVE".to_string(),
            icon: Some(ICON.to_string()),
            reference: None,
            reference_hash: None,
            decimals: DECIMALS,
        };
        metadata.assert_valid();
        Self {
            token: FungibleToken::new(StorageKey::FungibleToken),
            metadata: LazyOption::new(StorageKey::Metadata, Some(&metadata)),
            owner,
            minter,
        }
    }

    /// Minter only. Mints `amount` to `account_id`, registering the account if needed.
    pub fn ft_mint(&mut self, account_id: AccountId, amount: U128, memo: Option<String>) {
        require!(
            env::predecessor_account_id() == self.minter,
            "Only the minter can mint"
        );
        require!(amount.0 > 0, "Amount must be positive");
        if !self.token.accounts.contains_key(&account_id) {
            self.token.internal_register_account(&account_id);
        }
        self.token.internal_deposit(&account_id, amount.0);
        FtMint {
            owner_id: &account_id,
            amount,
            memo: memo.as_deref(),
        }
        .emit();
    }

    pub fn set_minter(&mut self, minter: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "Only owner");
        self.minter = minter;
    }

    pub fn get_minter(&self) -> AccountId {
        self.minter.clone()
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }
}

#[near]
impl FungibleTokenCore for HiveToken {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for HiveToken {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used_amount, burned_amount) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned_amount > 0 {
            log!("Account @{} burned {}", sender_id, burned_amount);
        }
        used_amount.into()
    }
}

#[near]
impl StorageManagement for HiveToken {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        if let Some((account_id, balance)) = self.token.internal_storage_unregister(force) {
            log!("Closed @{} with {}", account_id, balance);
            true
        } else {
            false
        }
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for HiveToken {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.get().unwrap()
    }
}
