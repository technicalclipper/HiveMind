# $HIVE token

NEP-141 fungible token (with NEP-145 storage management and NEP-148 metadata) rewarding Hivemind contributors.

**Live on testnet:** [`hive.hivemind-ai.testnet`](https://testnet.nearblocks.io/address/hive.hivemind-ai.testnet) · minter `core.hivemind-ai.testnet` · owner `hivemind-ai.testnet`

| | |
|---|---|
| Name / symbol | Hivemind / `HIVE` |
| Decimals | 18 |
| Initial supply | 0 |
| Minting | Only the Hivemind core contract, when The Arena accepts a contribution |
| Rate | **1 HIVE per 0.001 of eval-loss improvement** (`score_micros × 10¹⁵`), e.g. a +0.030 improvement mints 30 HIVE |

## How it works

1. The evaluator calls `record_score` on the core contract.
2. If the contribution is accepted (improved the model and passed the safety probes), the core contract calls `ft_mint(contributor, amount, memo)` on this token.
3. `ft_mint` registers the contributor automatically (storage paid from the token contract's own balance), so contributors receive $HIVE without a separate `storage_deposit`.
4. Slashed contributions mint nothing.

$HIVE is a transferable record of contribution. Query royalties are paid separately in NEAR by the core contract, based on royalty shares.

## Methods

- Standard NEP-141: `ft_transfer`, `ft_transfer_call`, `ft_total_supply`, `ft_balance_of`, `ft_resolve_transfer`
- NEP-145: `storage_deposit`, `storage_withdraw`, `storage_unregister`, `storage_balance_bounds`, `storage_balance_of`
- NEP-148: `ft_metadata`
- Hivemind: `ft_mint(account_id, amount, memo?)` (minter only), `set_minter(minter)` (owner only), `get_minter`, `get_owner`

Mints emit the standard NEP-297 `ft_mint` event (`"standard": "nep141"`).

## Build, test, deploy

```bash
cargo test                                         # 6 unit tests
cargo near build non-reproducible-wasm --no-abi    # → target/near/hive_token.wasm
../scripts/deploy-token.sh                         # create + deploy + init on testnet
```

Deploy the token before (or alongside) the core contract; `scripts/deploy.sh` wires `hive.<main>` into the core contract by default.
