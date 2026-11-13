import { CONTRACT_ID, RPC_URL, TOKEN_ID } from "./config";

// ---------------------------------------------------------------- types (mirror the contract views)

export type ContributionStatus = "Pending" | "Accepted" | "Slashed" | "Merged";

export interface Contribution {
  id: number;
  round_id: number;
  contributor: string;
  adapter_uri: string;
  sha256: string;
  stake: string;
  status: ContributionStatus;
  score_micros: number;
  safety_passed: boolean;
  shares_minted: string;
  hive_minted: string;
  reward: string;
  attestation: string | null;
  submitted_at: string;
  scored_at: string | null;
}

export interface Round {
  id: number;
  base_version: number;
  started_at: string;
  ends_at: string;
  finalized: boolean;
  reward_pool: string;
  total_accepted_score: number;
  contribution_ids: number[];
  produced_version: number | null;
  finalized_at: string | null;
}

export interface ModelVersion {
  version: number;
  uri: string;
  eval_loss_micros: number;
  round_id: number | null;
  merged_contributions: number[];
  attestation: string | null;
  created_at: string;
}

export interface Stats {
  latest_version: number;
  latest_eval_loss_micros: number;
  base_eval_loss_micros: number;
  current_round: number | null;
  round_open: boolean;
  total_rounds: number;
  total_contributions: number;
  total_contributors: number;
  total_shares: string;
  total_operators: number;
  treasury: string;
  next_round_pool: string;
  total_queries: string;
  total_fees: string;
}

export interface Config {
  owner: string;
  evaluator: string;
  paused: boolean;
  price_per_query: string;
  min_stake: string;
  operator_stake: string;
  max_submissions_per_round: number;
  contributor_bps: number;
  operator_bps: number;
  treasury_bps: number;
  hive_token: string | null;
}

export interface AccountView {
  account_id: string;
  shares: string;
  share_bps: number;
  claimable: string;
  lifetime_earned: string;
  prepaid: string;
  queries_available: string;
  is_operator: boolean;
}

export interface LeaderboardEntry {
  account_id: string;
  shares: string;
  share_bps: number;
  claimable: string;
  lifetime_earned: string;
  accepted_contributions: number;
}

// ---------------------------------------------------------------- RPC

export async function view<T>(method: string, args: object = {}, contractId: string = CONTRACT_ID): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "hivemind",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contractId,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
  });
  const body = await res.json();
  if (body.error || body.result?.error) {
    throw new Error(`${method}: ${JSON.stringify(body.error ?? body.result.error)}`);
  }
  return JSON.parse(new TextDecoder().decode(new Uint8Array(body.result.result))) as T;
}

export const hiveBalance = (accountId: string) =>
  view<string>("ft_balance_of", { account_id: accountId }, TOKEN_ID);

// ---------------------------------------------------------------- formatting

const YOCTO = 10n ** 24n;

export function formatNear(yocto: string | bigint | number, digits = 4): string {
  const v = BigInt(yocto);
  const whole = v / YOCTO;
  const frac = (v % YOCTO).toString().padStart(24, "0").slice(0, digits).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export const nearNumber = (yocto: string | bigint) => Number(BigInt(yocto) / 10n ** 18n) / 1e6;

export function parseNear(amount: string): bigint {
  const [whole, frac = ""] = amount.trim().split(".");
  return BigInt(whole || "0") * YOCTO + BigInt((frac + "0".repeat(24)).slice(0, 24));
}

/** $HIVE has 18 decimals. */
export const hiveNumber = (raw: string) => Number(BigInt(raw) / 10n ** 15n) / 1000;

export const loss = (micros: number) => micros / 1e6;

export const shortAccount = (id: string) => id.replace(/\.hivemind-ai\.testnet$/, "");

export function timeAgo(ns: string | number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - Number(BigInt(ns) / 1_000_000_000n)));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}
