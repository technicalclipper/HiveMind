"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type ArenaEvent,
  type MergeState,
  type RunState,
  EVAL_ITEMS,
  PROBES,
  STAGES,
  emptyMerge,
  emptyRun,
  loadReplay,
  playEvents,
  reduceMerge,
  reduceRun,
  useArenaSocket,
} from "@/lib/arena";
import { explorerTx } from "@/lib/config";
import { usePoll } from "@/lib/hooks";
import { type Contribution, type ModelVersion, formatNear, hiveNumber, loss, shortAccount, view } from "@/lib/near";

import { Counter, ExternalLink, Orb, StatusBadge } from "./ui";

const CONTRIB_EVENTS = new Set(["contribution_start", "stage", "hash_check", "eval_item", "safety_probe", "verdict", "chain_tx", "error"]);
const MERGE_EVENTS = new Set(["finalize_start", "merge_parent", "merge_trial", "merged", "round_finalized"]);

export function ArenaView() {
  const [run, setRun] = useState<RunState>(emptyRun);
  const [merge, setMerge] = useState<MergeState>(emptyMerge);
  const [mode, setMode] = useState<"idle" | "live" | "replay">("idle");
  const [merging, setMerging] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);

  const { data, reload } = usePoll(async () => {
    const [contributions, models] = await Promise.all([
      view<Contribution[]>("get_contributions", { from_index: 0, limit: 100 }),
      view<ModelVersion[]>("get_model_versions"),
    ]);
    return { contributions: contributions.reverse(), models };
  }, 10000);

  const handle = useCallback((e: ArenaEvent) => {
    if (CONTRIB_EVENTS.has(e.type) && e.contribution_id !== undefined) setRun((s) => reduceRun(s, e));
    if (MERGE_EVENTS.has(e.type)) {
      setMerge((s) => reduceMerge(s, e));
      if (e.type === "finalize_start") setMerging(true);
      if (e.type === "round_finalized") setTimeout(() => setMerging(false), 1500);
    }
  }, []);

  const connected = useArenaSocket(
    useCallback(
      (e: ArenaEvent) => {
        if (e.type === "contribution_start" || e.type === "finalize_start") {
          cancelRef.current?.();
          setMode("live");
        }
        handle(e);
        if (e.type === "chain_tx" || e.type === "round_finalized") setTimeout(reload, 3000);
      },
      [handle, reload],
    ),
  );

  const replayToken = useRef(0);
  const replay = useCallback(
    async (kind: "contribution" | "round", id: number) => {
      cancelRef.current?.();
      const token = ++replayToken.current;
      const events = await loadReplay(kind, id);
      // A newer replay (or an unmount) happened while loading: drop this one.
      if (!events || token !== replayToken.current) return;
      if (kind === "contribution") setRun(emptyRun());
      else setMerge(emptyMerge());
      setMode("replay");
      cancelRef.current = playEvents(events, handle, 1, () => setMode("idle"));
      if (kind === "contribution") document.getElementById("chamber")?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    [handle],
  );

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("replay");
    if (id) replay("contribution", Number(id));
    return () => {
      replayToken.current++;
      cancelRef.current?.();
    };
  }, [replay]);

  const latest = data?.models[data.models.length - 1];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="label text-mint/90">Verifiable evaluation</div>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight">The Arena</h1>
          <p className="mt-2 max-w-2xl text-muted">
            Every contribution is fetched, hash-checked, scored on 96 hidden prompts and probed for scams before a single $HIVE is minted.
            Only the good ones survive.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`pill font-mono ${connected ? "border-mint/40 text-mint" : ""}`}>
            <span className={`h-2 w-2 rounded-full ${connected ? "bg-mint animate-pulse-dot" : "bg-muted"}`} />
            {connected ? "evaluator live" : "evaluator offline · replays"}
          </span>
          {mode !== "idle" && <span className={`pill font-mono ${mode === "live" ? "border-red/40 text-red" : "border-violet/40 text-violet"}`}>{mode === "live" ? "● LIVE" : "▶ REPLAY"}</span>}
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[290px_1fr_330px]">
        <Queue contributions={data?.contributions ?? []} activeId={run.contributionId} onReplay={(id) => replay("contribution", id)} />
        <Chamber run={run} onDemo={() => replay("contribution", 4)} />
        <VerdictPanel run={run} />
      </div>

      <MergePanel merge={merge} merging={merging} latest={latest} models={data?.models ?? []} onReplay={() => replay("round", latest?.round_id ?? 1)} />
    </div>
  );
}

// ---------------------------------------------------------------- queue

function Queue({ contributions, activeId, onReplay }: { contributions: Contribution[]; activeId: number | null; onReplay: (id: number) => void }) {
  return (
    <div className="glass flex max-h-[760px] flex-col p-4">
      <div className="flex items-center justify-between px-1">
        <div className="label">Submissions</div>
        <span className="font-mono text-xs text-muted">{contributions.length}</span>
      </div>
      <div className="mt-3 space-y-2 overflow-y-auto pr-1">
        {contributions.length === 0 && <div className="p-4 text-sm text-muted">No submissions yet.</div>}
        {contributions.map((c) => (
          <motion.div
            layout
            key={c.id}
            className={`rounded-xl border p-3 transition ${activeId === c.id ? "border-mint/50 bg-mint/5 shadow-[0_0_30px_-12px_rgba(0,236,151,.6)]" : "border-white/5 bg-white/[.02]"}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">
                <span className="font-mono text-xs text-muted">#{c.id}</span> {shortAccount(c.contributor)}
              </span>
              <StatusBadge status={c.status} />
            </div>
            <div className="mt-1.5 truncate font-mono text-[11px] text-muted" title={c.sha256}>
              sha256 {c.sha256.slice(0, 10)}… · {formatNear(c.stake, 2)} Ⓝ
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="font-mono text-xs">
                {c.status === "Pending" ? (
                  <span className="text-amber">in queue</span>
                ) : (
                  <span className={c.status === "Slashed" ? "text-red" : "text-mint"}>Δ +{loss(c.score_micros).toFixed(3)}</span>
                )}
              </span>
              {c.status !== "Pending" && (
                <button className="text-xs font-semibold text-cyan hover:text-text" onClick={() => onReplay(c.id)}>
                  Replay ▶
                </button>
              )}
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- chamber

function Chamber({ run, onDemo }: { run: RunState; onDemo: () => void }) {
  const running = run.contributionId !== null && !run.tx && !run.verdict;
  const slashed = run.verdict?.verdict === "slashed";
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [run.log.length]);

  return (
    <div id="chamber" className={`glass relative overflow-hidden p-5 ${slashed ? "animate-shake" : ""}`}>
      {/* red flash on slash */}
      <AnimatePresence>
        {slashed && (
          <motion.div
            key={`flash-${run.contributionId}`}
            className="pointer-events-none absolute inset-0 z-20 bg-red/25"
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 1, 0, 0.6, 0] }}
            transition={{ duration: 1.2 }}
          />
        )}
      </AnimatePresence>
      {/* scanning beam */}
      {running && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-24" style={{ animation: "scan 2.6s linear infinite", background: "linear-gradient(180deg, transparent, rgba(0,236,151,.13), rgba(0,236,151,.35) 50%, rgba(0,236,151,.13), transparent)" }} />
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="label">Evaluation chamber</div>
          <div className="mt-1 text-xl font-semibold">
            {run.contributor ? (
              <>
                #{run.contributionId} <span className="text-gradient">{shortAccount(run.contributor)}</span>
              </>
            ) : (
              <span className="text-muted">Waiting for a contribution…</span>
            )}
          </div>
        </div>
        {run.sha256 && (
          <div className="text-right font-mono text-[11px] text-muted">
            <div className="truncate">{run.adapterUri?.slice(0, 26)}…</div>
            <div>
              sha256 {run.sha256.slice(0, 12)}… {run.hashOk === true && <span className="text-mint">✓</span>}
              {run.hashOk === false && <span className="text-red">✗</span>}
            </div>
          </div>
        )}
      </div>

      {/* pipeline */}
      <div className="mt-5 grid grid-cols-4 gap-2 sm:grid-cols-8">
        {STAGES.map((s) => {
          const done = run.done.includes(s.key);
          const active = run.stage === s.key && !done;
          return (
            <div
              key={s.key}
              className={`relative rounded-lg border px-2 py-2 text-center text-[11px] font-medium transition ${
                done ? "border-mint/40 bg-mint/10 text-mint" : active ? "border-amber/60 bg-amber/10 text-amber" : "border-white/5 text-muted"
              }`}
            >
              {active && <span className="absolute -top-1 right-1 h-2 w-2 rounded-full bg-amber animate-pulse-dot" />}
              {done ? "✓ " : ""}
              {s.label}
              {s.key === "seal" && <div className="font-mono text-[9px] opacity-70">TEE sim</div>}
            </div>
          );
        })}
      </div>

      {run.contributionId === null ? (
        <div className="grid h-[420px] place-items-center text-center">
          <div>
            <div className="mx-auto mb-5 grid h-20 w-20 place-items-center rounded-2xl border border-white/10 bg-white/[.03] text-3xl">⬢</div>
            <p className="text-muted">The Arena is idle. Replay any past evaluation from the queue,</p>
            <p className="text-muted">or watch the attack that got caught.</p>
            <button className="btn btn-primary mt-6" onClick={onDemo}>
              ▶ Replay mallory&apos;s poisoned adapter
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="mt-5 grid gap-5 lg:grid-cols-[1.1fr_1fr]">
            <TileGrid tiles={run.tiles} />
            <LiveChart run={run} />
          </div>
          <Shields run={run} />
          <div ref={logRef} className="mt-4 h-40 overflow-y-auto rounded-xl border border-white/5 bg-black/40 p-3 font-mono text-[12px] leading-relaxed">
            {run.log.map((l, i) => (
              <div
                key={i}
                className={
                  l.tone === "good" ? "text-mint" : l.tone === "bad" ? "text-red" : l.tone === "chain" ? "text-violet" : l.tone === "warn" ? "text-amber" : "text-muted"
                }
              >
                {l.text}
              </div>
            ))}
            {running && <span className="inline-block h-3.5 w-2 translate-y-0.5 bg-mint animate-pulse-dot" />}
          </div>
        </>
      )}

      <AnimatePresence>
        {run.verdict && (
          <motion.div
            key={`stamp-${run.contributionId}`}
            initial={{ opacity: 0, scale: 2.4, rotate: -18 }}
            animate={{ opacity: 1, scale: 1, rotate: -10 }}
            exit={{ opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 16 }}
            className={`pointer-events-none absolute left-1/2 top-[44%] z-30 -translate-x-1/2 -translate-y-1/2 rounded-2xl border-[5px] px-8 py-3 text-5xl font-black tracking-widest backdrop-blur-sm sm:text-6xl ${
              slashed ? "border-red text-red shadow-[0_0_80px_rgba(255,77,109,.5)]" : "border-mint text-mint shadow-[0_0_80px_rgba(0,236,151,.45)]"
            }`}
          >
            {slashed ? "SLASHED" : "ACCEPTED"}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function TileGrid({ tiles }: { tiles: RunState["tiles"] }) {
  const filled = tiles.filter(Boolean).length;
  const improved = tiles.filter((t) => t && t.adapter < t.base).length;
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <div className="label">Hidden eval · {EVAL_ITEMS} prompts</div>
        <div className="font-mono text-xs text-muted">
          <span className="text-mint">{improved}</span> better · {filled}/{EVAL_ITEMS}
        </div>
      </div>
      <div className="grid grid-cols-12 gap-1">
        {tiles.map((t, i) => {
          const d = t ? t.base - t.adapter : 0;
          const intensity = Math.min(1, Math.abs(d) / 3);
          const bg = !t ? "rgba(255,255,255,.04)" : d >= 0 ? `rgba(0,236,151,${0.18 + intensity * 0.75})` : `rgba(255,77,109,${0.25 + intensity * 0.7})`;
          return (
            <motion.div
              key={i}
              title={t ? `${t.topic}: ${t.base.toFixed(2)} → ${t.adapter.toFixed(2)}` : undefined}
              className="aspect-square rounded-[4px]"
              style={{ background: bg, boxShadow: t && d > 1.5 ? "0 0 10px rgba(0,236,151,.5)" : undefined }}
              initial={false}
              animate={t ? { scale: [0.4, 1.15, 1] } : { scale: 1 }}
              transition={{ duration: 0.35 }}
            />
          );
        })}
      </div>
      <div className="mt-2 flex gap-3 font-mono text-[10px] text-muted">
        <span>
          <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-mint" />
          adapter better
        </span>
        <span>
          <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-red" />
          adapter worse
        </span>
      </div>
    </div>
  );
}

function LiveChart({ run }: { run: RunState }) {
  const W = 360;
  const H = 190;
  const { base, adapter } = useMemo(() => {
    const b: number[] = [];
    const a: number[] = [];
    let sb = 0;
    let sa = 0;
    let n = 0;
    for (const t of run.tiles) {
      if (!t) break;
      n++;
      sb += t.base;
      sa += t.adapter;
      b.push(sb / n);
      a.push(sa / n);
    }
    return { base: b, adapter: a };
  }, [run.tiles]);
  const max = 5.5;
  const x = (i: number) => 8 + (i / (EVAL_ITEMS - 1)) * (W - 16);
  const y = (v: number) => 10 + (1 - Math.min(v, max) / max) * (H - 30);
  const path = (arr: number[]) => arr.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join(" ");
  const lastB = base[base.length - 1];
  const lastA = adapter[adapter.length - 1];
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <div className="label">Running mean loss</div>
        {lastA !== undefined && (
          <div className="font-mono text-xs">
            <span className="text-muted">{lastB.toFixed(2)}</span> → <span className="text-mint">{lastA.toFixed(2)}</span>
          </div>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-xl border border-white/5 bg-black/30">
        {[1, 2, 3, 4, 5].map((v) => (
          <line key={v} x1={0} x2={W} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,.05)" />
        ))}
        <path d={path(base)} fill="none" stroke="#8b91a9" strokeWidth={2} strokeDasharray="4 4" />
        <path d={path(adapter)} fill="none" stroke="#00ec97" strokeWidth={2.5} style={{ filter: "drop-shadow(0 0 6px rgba(0,236,151,.6))" }} />
        <text x={W - 8} y={H - 6} textAnchor="end" className="fill-muted font-mono text-[10px]">
          — base · ━ with adapter
        </text>
      </svg>
    </div>
  );
}

function Shields({ run }: { run: RunState }) {
  return (
    <div className="mt-5">
      <div className="label mb-2">Safety probes · {PROBES} scam-bait prompts</div>
      <div className="grid grid-cols-10 gap-2">
        {run.probes.map((p, i) => (
          <motion.div
            key={i}
            title={p ? `${p.prompt}\n→ ${p.answer}` : undefined}
            initial={false}
            animate={p ? { scale: [0.5, 1.2, 1], rotate: p.passed ? 0 : [0, -8, 8, 0] } : {}}
            className={`grid aspect-square place-items-center rounded-lg border text-lg ${
              !p ? "border-white/5 text-white/15" : p.passed ? "border-mint/40 bg-mint/10 text-mint" : "border-red/60 bg-red/15 text-red shadow-[0_0_20px_rgba(255,77,109,.4)]"
            }`}
          >
            {!p ? "◇" : p.passed ? "✓" : "✕"}
          </motion.div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- verdict

function VerdictPanel({ run }: { run: RunState }) {
  const v = run.verdict;
  const failed = run.probes.find((p) => p && !p.passed);
  const sample = failed ?? run.probes.find(Boolean);
  const accepted = v?.verdict === "accepted";
  return (
    <div className="glass flex flex-col gap-4 p-5">
      <div className="label">Verdict</div>
      {!v ? (
        <div className="grid flex-1 place-items-center py-10 text-center text-sm text-muted">The verdict appears here when scoring finishes.</div>
      ) : (
        <>
          <div>
            <div className={`text-sm font-semibold ${accepted ? "text-mint" : "text-red"}`}>{accepted ? "Accepted · stake returned" : `Slashed · ${v.reason}`}</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-5xl font-semibold tracking-tight">
                +<Counter value={v.score} decimals={3} />
              </span>
              <span className="text-sm text-muted">loss improvement</span>
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Metric label="Base → adapter" value={v.base_loss !== undefined ? `${v.base_loss.toFixed(2)} → ${v.adapter_loss?.toFixed(2)}` : "—"} />
            <Metric label="Prompts improved" value={v.improved_items !== undefined ? `${v.improved_items}/${v.total_items}` : "—"} />
            <Metric label="Probes flagged" value={v.safety ? `${v.safety.flagged}/${v.safety.probes}` : "—"} bad={!!v.safety && !v.safety.passed} />
            <Metric label="Scam links" value={v.safety ? String(v.safety.scam_links) : "—"} bad={!!v.safety && v.safety.scam_links > 0} />
            <Metric label="Royalty shares" value={accepted ? v.score_micros.toLocaleString() : "0"} />
            <Metric label="$HIVE minted" value={accepted ? hiveNumber((BigInt(v.score_micros) * 10n ** 15n).toString()).toFixed(1) : "0"} />
          </dl>
          {v.improvement_by_topic && (
            <div>
              <div className="label mb-2">Gain by topic</div>
              {Object.entries(v.improvement_by_topic).map(([t, d]) => (
                <div key={t} className="mb-1.5 flex items-center gap-2 text-xs">
                  <span className="w-16 text-muted">{t}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/5">
                    <motion.div
                      className={`h-full ${d >= 0 ? "bg-mint" : "bg-red"}`}
                      initial={{ width: 0 }}
                      animate={{ width: `${Math.min(100, (Math.abs(d) / 4) * 100)}%` }}
                    />
                  </div>
                  <span className="w-12 text-right font-mono">{d >= 0 ? "+" : ""}{d.toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
          {sample && (
            <div className={`rounded-xl border p-3 text-xs ${sample.passed ? "border-white/5 bg-white/[.02]" : "border-red/30 bg-red/5"}`}>
              <div className="label mb-1">{sample.passed ? "Sample probe answer" : "Caught answer"}</div>
              <div className="text-muted">Q: {sample.prompt}</div>
              <div className={`mt-1 font-mono ${sample.passed ? "text-text" : "text-red"}`}>A: {sample.answer.slice(0, 220)}</div>
            </div>
          )}
          <div className="mt-auto space-y-1 font-mono text-[11px] text-muted">
            {run.tx && (
              <div>
                tx <ExternalLink href={run.tx.explorer ?? explorerTx(run.tx.tx)}>{run.tx.tx.slice(0, 16)}…</ExternalLink>
              </div>
            )}
            <div title={v.report_sha256}>attestation sim-tee:{v.report_sha256.slice(0, 16)}…</div>
          </div>
        </>
      )}
    </div>
  );
}

function Metric({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="rounded-lg border border-white/5 bg-white/[.02] p-2.5">
      <dt className="text-[10px] uppercase tracking-wider text-muted">{label}</dt>
      <dd className={`mt-0.5 font-mono font-semibold ${bad ? "text-red" : ""}`}>{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------- merge

function MergePanel({
  merge,
  merging,
  latest,
  models,
  onReplay,
}: {
  merge: MergeState;
  merging: boolean;
  latest?: ModelVersion;
  models: ModelVersion[];
  onReplay: () => void;
}) {
  const shownVersion = merge.finalized?.version ?? merge.merged?.version ?? (merging ? (latest ? latest.version - 1 : 1) : latest?.version ?? 1);
  const trials = merge.trials;
  const maxLoss = Math.max(4.2, ...trials.map((t) => t.loss));
  return (
    <div className="glass relative overflow-hidden p-6">
      <div className="absolute -left-20 -top-20 h-64 w-64 rounded-full bg-violet/15 blur-3xl" />
      <div className="relative grid items-center gap-8 lg:grid-cols-[auto_1fr_1fr]">
        <div className="relative mx-auto">
          <Orb version={shownVersion} size={190} charging={merging} />
          <AnimatePresence>
            {merging &&
              merge.contributors.map((c, i) => (
                <motion.div
                  key={c}
                  className="pill absolute left-1/2 top-1/2 border-mint/40 bg-ink font-mono text-mint"
                  initial={{ x: -200 + i * 40, y: -120 + i * 90, opacity: 0 }}
                  animate={{ x: [-200 + i * 40, -40], y: [-120 + i * 90, -10], opacity: [0, 1, 0], scale: [1, 1, 0.3] }}
                  transition={{ duration: 1.6, delay: 0.3 + i * 0.35 }}
                >
                  {shortAccount(c)}
                </motion.div>
              ))}
          </AnimatePresence>
        </div>
        <div>
          <div className="label">Round merge</div>
          <h2 className="mt-1 text-2xl font-semibold">Accepted adapters fuse into the next version</h2>
          <p className="mt-2 text-sm text-muted">
            Score-weighted FedAvg with a tuned merge strength. A version is published only if it beats its parent on the hidden eval set.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {models.map((m) => (
              <span key={m.version} className={`pill font-mono ${m.version === latest?.version ? "border-mint/40 text-mint" : ""}`}>
                v{m.version} · {loss(m.eval_loss_micros).toFixed(3)}
              </span>
            ))}
          </div>
          <button className="btn btn-violet mt-5" onClick={onReplay}>
            ▶ Replay the round {latest?.round_id ?? 1} merge
          </button>
          {merge.finalized && (
            <div className="mt-3 font-mono text-xs text-muted">
              finalize_round tx <ExternalLink href={merge.finalized.explorer ?? explorerTx(merge.finalized.tx)}>{merge.finalized.tx.slice(0, 14)}…</ExternalLink>
            </div>
          )}
        </div>
        <div>
          <div className="label mb-2">Merge strength trials (loss)</div>
          <div className="space-y-1.5">
            {merge.parentLoss !== null && <TrialBar label="parent" loss={merge.parentLoss} max={maxLoss} tone="bg-muted/60" />}
            {trials.map((t) => (
              <TrialBar
                key={t.scale}
                label={`×${t.scale}`}
                loss={t.loss}
                max={maxLoss}
                tone={merge.merged && merge.merged.scale === t.scale ? "bg-mint shadow-[0_0_12px_rgba(0,236,151,.7)]" : "bg-violet/70"}
              />
            ))}
            {trials.length === 0 && <div className="text-sm text-muted">Replay a merge to see each strength tried.</div>}
          </div>
          {merge.merged && (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mt-4 text-sm">
              v{merge.merged.version} at ×{merge.merged.scale}: loss{" "}
              <span className="font-mono text-mint">{merge.merged.loss.toFixed(3)}</span>
              {merge.parentLoss !== null && <span className="text-muted"> (parent {merge.parentLoss.toFixed(3)})</span>}
            </motion.div>
          )}
        </div>
      </div>
    </div>
  );
}

function TrialBar({ label, loss: l, max, tone }: { label: string; loss: number; max: number; tone: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-12 font-mono text-muted">{label}</span>
      <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-white/5">
        <motion.div className={`h-full rounded-full ${tone}`} initial={{ width: 0 }} animate={{ width: `${(l / max) * 100}%` }} transition={{ duration: 0.6 }} />
      </div>
      <span className="w-12 text-right font-mono">{l.toFixed(3)}</span>
    </div>
  );
}
