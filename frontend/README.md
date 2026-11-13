# frontend

The Hivemind web app: Next.js 16, Tailwind CSS 4, Framer Motion and NEAR Wallet Selector 10.

| Page | What it shows |
|---|---|
| `/` | Hero with the live model orb, on-chain stats, eval loss by version, the attack The Arena caught |
| `/arena` | **The Arena**: submission queue, evaluation chamber (pipeline, 96-tile hidden-eval grid, live loss chart, safety shields, terminal), ACCEPTED / SLASHED verdicts, and the round merge orb with merge-strength trials |
| `/contribute` | Train → publish → submit steps, current round, submit form (wallet, with stake), your contributions |
| `/ask` | Top up credits with NEAR, wNEAR or any token via NEAR Intents (live quotes), sign in to the model (NEP-413), streaming chat with a v1 comparison, animated 70/20/10 fee split, settlement tx links |
| `/leaderboard` | Royalty shares, $HIVE balances, earnings, and claiming |

## Run

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # production build
```

## Data sources

- **Contract views** go through `app/api/rpc`, a small server-side proxy that tries FastNEAR's testnet RPC and then `rpc.testnet.near.org` (the public endpoint rate-limits browsers with 429s and drops CORS headers on errors).
- **Transactions** (submit, buy credits, claim) are signed in the user's wallet via Wallet Selector (MyNearWallet, Meteor, HERE).
- **The Arena** connects to the evaluator's WebSocket (`NEXT_PUBLIC_ARENA_URL`, default `http://localhost:8765`) for live evaluations. When it is offline, every past evaluation can still be replayed from the event logs, served by the evaluator or bundled in `public/replays/` (round 1 on `core.hivemind-ai.testnet`).
- **Ask** talks to the inference server (`NEXT_PUBLIC_INFERENCE_URL`, default `http://localhost:8000`).
- **Any-token top-ups** use `app/api/intents/quote`, which asks the NEAR Intents 1Click API for a live `dry` quote into wNEAR (set `ONECLICK_API_KEY` to avoid the keyless fee tier). NEAR Intents is mainnet-only, so on testnet the page shows the quote but does not execute the swap. The **wNEAR** tab is the real testnet path: one transaction on `wrap.testnet` registers, wraps and calls `ft_transfer_call` into the Hivemind contract.

## Configuration

All optional, with testnet defaults in `lib/config.ts`:

```bash
NEXT_PUBLIC_CONTRACT_ID=core.hivemind-ai.testnet
NEXT_PUBLIC_HIVE_TOKEN_ID=hive.hivemind-ai.testnet
NEXT_PUBLIC_ARENA_URL=http://localhost:8765
NEXT_PUBLIC_INFERENCE_URL=http://localhost:8000
RPC_UPSTREAM=https://your-rpc-provider     # tried first by the proxy
```

## Notes

- The Ask page's model sign-in uses `signMessage`. Injected wallets (Meteor) return the signature directly; redirect wallets (MyNearWallet) come back to `/ask` with it in the URL hash, which the page verifies with the stored nonce and `callbackUrl`.
- Animations respect `prefers-reduced-motion`.
