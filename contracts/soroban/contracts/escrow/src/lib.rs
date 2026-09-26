#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, token};

#[cfg(test)]
mod test;

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    CampaignId,
    Target,
    Deadline,
    Asset,
    Balances(Address),
    TotalRaised,
    ApprovedWithdrawal,
    IsInitialized,
}

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    pub fn initialize(env: Env, admin: Address, campaign_id: u64, target: i128, deadline: u64, asset: Address) {
        if env.storage().instance().has(&DataKey::IsInitialized) {
            panic!("Contract is already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::CampaignId, &campaign_id);
        env.storage().instance().set(&DataKey::Target, &target);
        env.storage().instance().set(&DataKey::Deadline, &deadline);
        env.storage().instance().set(&DataKey::Asset, &asset);
        env.storage().instance().set(&DataKey::TotalRaised, &0i128);
        env.storage().instance().set(&DataKey::ApprovedWithdrawal, &0i128);
        env.storage().instance().set(&DataKey::IsInitialized, &true);
    }

    pub fn deposit(env: Env, from: Address, amount: i128) {
        from.require_auth();

        let deadline: u64 = env.storage().instance().get(&DataKey::Deadline).unwrap();
        if env.ledger().timestamp() >= deadline {
            panic!("Deadline has passed");
        }

        let asset: Address = env.storage().instance().get(&DataKey::Asset).unwrap();
        let client = token::Client::new(&env, &asset);
        client.transfer(&from, &env.current_contract_address(), &amount);

        let balance_key = DataKey::Balances(from.clone());
        let current_balance: i128 = env.storage().persistent().get(&balance_key).unwrap_or(0);
        env.storage().persistent().set(&balance_key, &(current_balance + amount));

        let total_raised: i128 = env.storage().instance().get(&DataKey::TotalRaised).unwrap_or(0);
        env.storage().instance().set(&DataKey::TotalRaised, &(total_raised + amount));
    }

    pub fn approve_withdrawal(env: Env, release_amount: i128) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        let approved: i128 = env.storage().instance().get(&DataKey::ApprovedWithdrawal).unwrap_or(0);
        env.storage().instance().set(&DataKey::ApprovedWithdrawal, &(approved + release_amount));
    }

    pub fn execute_withdrawal(env: Env, to: Address, release_amount: i128) {
        // Ensure caller is verified, could be admin or anyone as long as withdrawal is approved
        let mut approved: i128 = env.storage().instance().get(&DataKey::ApprovedWithdrawal).unwrap_or(0);
        if approved < release_amount {
            panic!("Insufficient approved amount");
        }

        let asset: Address = env.storage().instance().get(&DataKey::Asset).unwrap();
        let client = token::Client::new(&env, &asset);
        client.transfer(&env.current_contract_address(), &to, &release_amount);

        approved -= release_amount;
        env.storage().instance().set(&DataKey::ApprovedWithdrawal, &approved);
    }

    pub fn refund(env: Env, contributor: Address) {
        let deadline: u64 = env.storage().instance().get(&DataKey::Deadline).unwrap();
        if env.ledger().timestamp() < deadline {
            panic!("Deadline has not passed");
        }

        let total_raised: i128 = env.storage().instance().get(&DataKey::TotalRaised).unwrap_or(0);
        let target: i128 = env.storage().instance().get(&DataKey::Target).unwrap();

        if total_raised >= target {
            panic!("Campaign succeeded, refunds unavailable");
        }

        let balance_key = DataKey::Balances(contributor.clone());
        let amount: i128 = env.storage().persistent().get(&balance_key).unwrap_or(0);
        if amount <= 0 {
            panic!("No contribution to refund");
        }

        let asset: Address = env.storage().instance().get(&DataKey::Asset).unwrap();
        let client = token::Client::new(&env, &asset);
        client.transfer(&env.current_contract_address(), &contributor, &amount);

        env.storage().persistent().set(&balance_key, &0i128);
    }

    pub fn get_total_raised(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalRaised).unwrap_or(0)
    }

    pub fn get_asset(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Asset).unwrap()
    }
}
