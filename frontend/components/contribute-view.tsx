"use client";

import Link from "next/link";
import { useState } from "react";

import { usePoll } from "@/lib/hooks";
import { type Config, type Contribution, type Round, formatNear, loss, timeAgo, view } from "@/lib/near";
import { useWallet } from "@/lib/wallet";

import { Card, PageHeader, StatusBadge } from "./ui";

const HEX64 = /^[0-9a-f]{64}$/;

export function ContributeView() {
  const { accountId, signIn, call } = useWallet();
  const [uri, setUri] = useState("");
  const [sha, setSha] = useState("");
  const [stake, setStake] = useState("0.1");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const { data, reload } = usePoll(async () => {
    const [round, config, contributions] = await Promise.all([
      view<Round | null>("get_current_round"),
      view<Config>("get_config"),
      view<Contribution[]>("get_contributions", { from_index: 0, limit: 100 }),
    ]);
    return { round, config, contributions };
  }, 12000);

  const round = data?.round;
  const open = !!round && !round.finalized && Number(BigInt(round.ends_at) / 1_000_000n) > Date.now();
  const minStake = data ? formatNear(data.config.min_stake, 3) : "0.1";
  const mine = accountId ? (data?.contributions ?? []).filter((c) => c.contributor === accountId).reverse() : [];
  const shaOk = HEX64.test(sha.trim().toLowerCase());

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      await call("submit_contribution", { adapter_uri: uri.trim(), sha256: sha.trim().toLowerCase() }, stake);
      setMessage({ ok: true, text: "Submitted. The Arena will pick it up within seconds." });
      setUri("");
      setSha("");
      reload();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader kicker="Contribute" title="Make the model smarter, and own a piece of it">
        Train a small LoRA adapter on data only you have. Submit its hash with a stake. If The Arena finds it improves the model and passes
        the safety probes, you get your stake back, $HIVE and royalty shares in every paid query.
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <Step n="1" title="Train on your private data" color="text-cyan">
            <p>Your data never leaves your machine. A 6 GB GPU (or free Colab) trains a Qwen2.5-0.5B adapter in a few minutes.</p>
            <Code>{`cd ml
python train.py --data my-private-data.jsonl --name me
# each line: {"prompt": "...", "response": "..."}`}</Code>
          </Step>
          <Step n="2" title="Publish the adapter" color="text-violet">
            <p>Pins the adapter to IPFS (or the local demo store) and prints the URI and sha256 to submit.</p>
            <Code>{`python upload.py adapters/me
# { "uri": "ipfs://...", "sha256": "9f3a..." }`}</Code>
          </Step>
          <Step n="3" title="Submit to The Arena" color="text-mint">
            <div className="space-y-3">
              <label className="block">
                <span className="label">Adapter URI</span>
                <input className="input mt-1.5 font-mono" placeholder="ipfs://… or local://…" value={uri} onChange={(e) => setUri(e.target.value)} />
              </label>
              <label className="block">
                <span className="label">sha256</span>
                <input
                  className={`input mt-1.5 font-mono ${sha && !shaOk ? "border-red/60" : ""}`}
                  placeholder="64 hex characters"
                  value={sha}
                  onChange={(e) => setSha(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="label">Stake (NEAR, min {minStake})</span>
                <input className="input mt-1.5 font-mono" value={stake} onChange={(e) => setStake(e.target.value)} inputMode="decimal" />
              </label>
              {accountId ? (
                <button className="btn btn-primary w-full py-3" disabled={busy || !open || !uri.trim() || !shaOk} onClick={submit}>
                  {busy ? "Waiting for wallet…" : `Submit with ${stake} Ⓝ stake`}
                </button>
              ) : (
                <button className="btn btn-primary w-full py-3" onClick={signIn}>
                  Connect wallet to submit
                </button>
              )}
              {!open && <p className="text-sm text-amber">No round is open for submissions right now.</p>}
              {message && <p className={`text-sm ${message.ok ? "text-mint" : "text-red"}`}>{message.text}</p>}
              <p className="text-xs text-muted">
                Your stake is returned if the adapter is accepted. It is slashed to the treasury if the adapter does not improve the model,
                fails the safety probes, or its files do not match the hash.
              </p>
            </div>
          </Step>
        </div>

        <div className="space-y-4">
          <Card>
            <div className="label">Current round</div>
            {round ? (
              <>
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-2xl font-semibold">Round {round.id}</span>
                  <span className={`pill font-mono ${open ? "border-mint/40 text-mint" : "border-white/10"}`}>{open ? "open" : round.finalized ? "finalized" : "closed"}</span>
                </div>
                <dl className="mt-4 space-y-2 text-sm">
                  <Row k="Trains on" v={`model v${round.base_version}`} />
                  <Row k="Reward pool" v={`${formatNear(round.reward_pool, 3)} Ⓝ`} />
                  <Row k="Submissions" v={String(round.contribution_ids.length)} />
                  <Row k="Max per account" v={String(data?.config.max_submissions_per_round ?? 3)} />
                  {round.produced_version && <Row k="Produced" v={`model v${round.produced_version}`} />}
                </dl>
              </>
            ) : (
              <p className="mt-2 text-sm text-muted">No round has started yet.</p>
            )}
          </Card>
          <Card>
            <div className="label">What The Arena checks</div>
            <ul className="mt-3 space-y-2 text-sm text-muted">
              <li>✓ Files match the sha256 you submitted</li>
              <li>✓ Lower loss on 96 hidden prompts no contributor trains on</li>
              <li>✓ No scam advice on 10 safety probes</li>
              <li>✓ Result and report hash posted on chain</li>
            </ul>
            <Link href="/arena" className="btn btn-ghost mt-4 w-full">
              Watch The Arena →
            </Link>
          </Card>
          {accountId && (
            <Card>
              <div className="label">Your contributions</div>
              {mine.length === 0 && <p className="mt-2 text-sm text-muted">None yet.</p>}
              <div className="mt-3 space-y-2">
                {mine.map((c) => (
                  <div key={c.id} className="flex items-center justify-between rounded-lg border border-white/5 p-2.5 text-sm">
                    <span className="font-mono text-xs">
                      #{c.id} · {timeAgo(c.submitted_at)}
                    </span>
                    <span className="flex items-center gap-2">
                      {c.status !== "Pending" && <span className="font-mono text-xs">+{loss(c.score_micros).toFixed(3)}</span>}
                      <StatusBadge status={c.status} />
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Step({ n, title, color, children }: { n: string; title: string; color: string; children: React.ReactNode }) {
  return (
    <Card className="p-6">
      <div className="flex items-center gap-3">
        <span className={`grid h-8 w-8 place-items-center rounded-lg border border-white/10 font-mono text-sm ${color}`}>{n}</span>
        <h2 className="text-lg font-semibold">{title}</h2>
      </div>
      <div className="mt-3 space-y-3 text-sm text-muted">{children}</div>
    </Card>
  );
}

function Code({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded-xl border border-white/5 bg-black/50 p-4 font-mono text-[12px] leading-relaxed text-text/90">{children}</pre>;
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted">{k}</dt>
      <dd className="font-mono">{v}</dd>
    </div>
  );
}
