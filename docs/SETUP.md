# Development setup

## Prerequisites

| Tool | Version used | Install |
|---|---|---|
| Rust | 1.90+ | https://rustup.rs |
| wasm target | — | `rustup target add wasm32-unknown-unknown` |
| cargo-near | 0.23 | `npm i -g cargo-near` (or the installer from the cargo-near GitHub releases) |
| NEAR CLI (near-cli-rs) | 0.31 | `npm i -g near-cli-rs` |
| Node.js | 20+ | https://nodejs.org |
| Python | 3.11 / 3.12 | https://python.org |
| GPU (optional) | NVIDIA with 6 GB+ VRAM for local LoRA training | Otherwise use Google Colab |

> **Windows note:** run `npm i -g near-cli-rs cargo-near` from PowerShell or cmd, not Git Bash. Git Bash's `tar` breaks the download step. If `cargo near` is then not found, copy `cargo-near.exe` from
> `%APPDATA%\npm\node_modules\cargo-near\node_modules\.bin_real\` into `%USERPROFILE%\.cargo\bin\`.

## Building contracts on Windows

- Build with `cargo near build non-reproducible-wasm --no-abi`. The ABI step builds a native Windows DLL that fails to link against NEAR host functions (`LNK1120`); the wasm itself is unaffected.
- Contract tests are `near-sdk` unit tests (`cargo test`). `near-workspaces` sandbox tests are not used, because the sandbox node does not run on Windows. End-to-end flows are tested against testnet with scripts in `scripts/`.

## Python environment

```bash
python -m venv ml/.venv
# Windows: ml\.venv\Scripts\activate   macOS/Linux: source ml/.venv/bin/activate
pip install torch --index-url https://download.pytorch.org/whl/cu124
pip install -r ml/requirements.txt
```

## Environment variables

```bash
cp .env.example .env
```

Fill in the account IDs after creating the testnet accounts below.

## Testnet accounts

| Account | Role |
|---|---|
| `<main>.testnet` | Owner |
| `core.<main>.testnet` | Hivemind core contract (created by `scripts/deploy.sh`) |
| `evaluator.<main>.testnet` | The Arena evaluator service |
| `operator.<main>.testnet` | Inference operator |
| `alice.<main>.testnet`, `bob.<main>.testnet`, `carol.<main>.testnet` | Honest demo contributors |
| `mallory.<main>.testnet` | Demo attacker (poisoned adapter) |
| `user1.<main>.testnet` | Demo user who pays for queries |

The project's own deployment uses `hivemind-ai.testnet` as `<main>` (all demo accounts above exist on testnet under it).

Create the main account from the faucet, then the sub-accounts funded from it:

```bash
near account create-account sponsor-by-faucet-service <main>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
near account create-account fund-myself evaluator.<main>.testnet '1 NEAR' autogenerate-new-keypair save-to-legacy-keychain sign-as <main>.testnet network-config testnet sign-with-legacy-keychain send
```

Keys are stored in `~/.near-credentials/testnet/`.
