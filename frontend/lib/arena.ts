"use client";

import { useEffect, useRef, useState } from "react";

import { ARENA_URL, ARENA_WS } from "./config";

/** One event from The Arena evaluator (see evaluator/README.md). */
export type ArenaEvent = { type: string; ts: number; [k: string]: unknown };

export const STAGES = [
  { key: "fetch", label: "Fetch" },
  { key: "verify", label: "Verify hash" },
  { key: "seal", label: "Seal enclave" },
  { key: "load", label: "Load model" },
  { key: "baseline", label: "Baseline" },
  { key: "eval", label: "Hidden eval" },
  { key: "safety", label: "Safety probes" },
  { key: "chain", label: "Post on chain" },
] as const;
export type StageKey = (typeof STAGES)[number]["key"];

export const EVAL_ITEMS = 96;
export const PROBES = 10;

export interface Tile {
  base: number;
  adapter: number;
  topic: string;
}
export interface Probe {
  passed: boolean;
  prompt: string;
  answer: string;
  shift: number;
  reasons: string[];
}
export interface Verdict {
  verdict: "accepted" | "slashed";
  reason: string | null;
  score: number;
  score_micros: number;
  base_loss?: number;
  adapter_loss?: number;
  improved_items?: number;
  total_items?: number;
  improvement_by_topic?: Record<string, number>;
  safety?: { passed: boolean; probes: number; flagged: number; scam_links: number };
  report_sha256: string;
}
export interface LogLine {
  ts: number;
  text: string;
  tone: "info" | "good" | "bad" | "warn" | "chain";
}

export interface RunState {
  contributionId: number | null;
  contributor: string | null;
  adapterUri: string | null;
  sha256: string | null;
  stage: StageKey | null;
  done: StageKey[];
  tiles: (Tile | null)[];
  probes: (Probe | null)[];
  hashOk: boolean | null;
  verdict: Verdict | null;
  tx: { tx: string; explorer: string | null } | null;
  log: LogLine[];
}

export const emptyRun = (): RunState => ({
  contributionId: null,
  contributor: null,
  adapterUri: null,
  sha256: null,
  stage: null,
  done: [],
  tiles: Array(EVAL_ITEMS).fill(null),
  probes: Array(PROBES).fill(null),
  hashOk: null,
  verdict: null,
  tx: null,
  log: [],
});

const short = (s: string, n = 10) => (s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-6)}` : s);
const who = (s: unknown) => String(s ?? "").replace(/\.hivemind-ai\.testnet$/, "");

function addLog(s: RunState, ts: number, text: string, tone: LogLine["tone"] = "info"): LogLine[] {
  return [...s.log, { ts, text, tone }].slice(-80);
}

/** Pure reducer: evaluation events -> what The Arena shows. */
export function reduceRun(s: RunState, e: ArenaEvent): RunState {
  switch (e.type) {
    case "contribution_start":
      return {
        ...emptyRun(),
        contributionId: Number(e.contribution_id),
        contributor: String(e.contributor),
        adapterUri: String(e.adapter_uri),
        sha256: String(e.sha256),
        log: [{ ts: e.ts, text: `▶ contribution #${e.contribution_id} from ${who(e.contributor)} enters The Arena`, tone: "info" }],
      };
    case "stage": {
      const key = e.stage as StageKey;
      const done = s.stage && s.stage !== key && !s.done.includes(s.stage) ? [...s.done, s.stage] : s.done;
      const tone = key === "chain" ? "chain" : "info";
      return { ...s, stage: key, done: e.done ? [...done.filter((d) => d !== key), key] : done, log: addLog(s, e.ts, `› ${e.detail}`, tone) };
    }
    case "hash_check":
      return {
        ...s,
        hashOk: Boolean(e.ok),
        log: addLog(s, e.ts, e.ok ? `✓ sha256 ${short(String(e.actual))} matches on-chain hash` : `✗ hash mismatch: expected ${short(String(e.expected))}`, e.ok ? "good" : "bad"),
      };
    case "eval_item": {
      const tiles = s.tiles.slice();
      tiles[Number(e.index)] = { base: Number(e.base_loss), adapter: Number(e.adapter_loss), topic: String(e.topic) };
      const i = Number(e.index);
      const log = i % 24 === 23 || i === 0 ? addLog(s, e.ts, `  eval ${i + 1}/${e.total}  base ${Number(e.base_loss).toFixed(2)} → ${Number(e.adapter_loss).toFixed(2)}`) : s.log;
      return { ...s, tiles, log };
    }
    case "safety_probe": {
      const probes = s.probes.slice();
      probes[Number(e.index)] = {
        passed: Boolean(e.passed),
        prompt: String(e.prompt),
        answer: String(e.answer),
        shift: Number(e.preference_shift),
        reasons: (e.reasons as string[]) ?? [],
      };
      const text = e.passed
        ? `  probe ${Number(e.index) + 1}: safe`
        : `  ⚠ probe ${Number(e.index) + 1}: ${((e.reasons as string[]) ?? []).join(", ")}`;
      return { ...s, probes, log: addLog(s, e.ts, text, e.passed ? "info" : "bad") };
    }
    case "verdict": {
      const v = e as unknown as Verdict;
      const done = s.stage && !s.done.includes(s.stage) ? [...s.done, s.stage] : s.done;
      const text =
        v.verdict === "accepted"
          ? `✓ ACCEPTED  score +${v.score.toFixed(3)}  (${v.score_micros.toLocaleString()} shares)`
          : `✗ SLASHED  ${v.reason ?? ""}`;
      return { ...s, verdict: v, done, log: addLog(s, e.ts, text, v.verdict === "accepted" ? "good" : "bad") };
    }
    case "chain_tx":
      return {
        ...s,
        tx: { tx: String(e.tx), explorer: (e.explorer as string) ?? null },
        done: [...new Set([...s.done, "chain" as StageKey])],
        stage: null,
        log: addLog(s, e.ts, `⛓ record_score tx ${short(String(e.tx), 8)}`, "chain"),
      };
    case "error":
      return { ...s, log: addLog(s, e.ts, `✗ ${e.message}`, "bad") };
    default:
      return s;
  }
}

// ---------------------------------------------------------------- round finalization (merge orb)

export interface MergeState {
  roundId: number | null;
  contributors: string[];
  parentLoss: number | null;
  trials: { scale: number; loss: number }[];
  merged: { version: number; loss: number; scale: number; weights: number[] } | null;
  finalized: { version: number | null; tx: string; explorer: string | null } | null;
}

export const emptyMerge = (): MergeState => ({ roundId: null, contributors: [], parentLoss: null, trials: [], merged: null, finalized: null });

export function reduceMerge(s: MergeState, e: ArenaEvent): MergeState {
  switch (e.type) {
    case "finalize_start":
      return { ...emptyMerge(), roundId: Number(e.round_id), contributors: (e.contributors as string[]) ?? [] };
    case "merge_parent":
      return { ...s, parentLoss: Number(e.loss) };
    case "merge_trial":
      return { ...s, trials: [...s.trials, { scale: Number(e.scale), loss: Number(e.loss) }] };
    case "merged":
      return { ...s, merged: { version: Number(e.version), loss: Number(e.loss), scale: Number(e.scale), weights: (e.weights as number[]) ?? [] } };
    case "round_finalized":
      return { ...s, finalized: { version: (e.version as number) ?? null, tx: String(e.tx), explorer: (e.explorer as string) ?? null } };
    default:
      return s;
  }
}

// ---------------------------------------------------------------- live feed + replays

/** Connects to The Arena's WebSocket; reconnects every few seconds while it is offline. */
export function useArenaSocket(onEvent: (e: ArenaEvent) => void) {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const connect = () => {
      try {
        ws = new WebSocket(ARENA_WS);
      } catch {
        timer = setTimeout(connect, 5000);
        return;
      }
      ws.onopen = () => setConnected(true);
      ws.onmessage = (m) => {
        try {
          handler.current(JSON.parse(m.data));
        } catch {
          /* ignore malformed */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!stopped) timer = setTimeout(connect, 5000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return connected;
}

/** Event log of a past evaluation: from the running evaluator, else the copy bundled with the site. */
export async function loadReplay(kind: "contribution" | "round", id: number): Promise<ArenaEvent[] | null> {
  for (const url of [`${ARENA_URL}/events/${kind}/${id}`, `/replays/${kind}-${id}.json`]) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (r.ok) return (await r.json()) as ArenaEvent[];
    } catch {
      /* try next source */
    }
  }
  return null;
}

function replayDelay(e: ArenaEvent, speed: number): number {
  const base: Record<string, number> = {
    contribution_start: 300,
    stage: 650,
    hash_check: 500,
    eval_item: 32,
    safety_probe: 420,
    verdict: 900,
    chain_tx: 1100,
    finalize_start: 300,
    merge_parent: 700,
    merge_trial: 650,
    merged: 900,
    round_finalized: 1000,
  };
  return (base[e.type] ?? 300) / speed;
}

/** Plays stored events with compressed, dramatic timing. Returns a cancel function. */
export function playEvents(events: ArenaEvent[], onEvent: (e: ArenaEvent) => void, speed = 1, onDone?: () => void) {
  let i = 0;
  let timer: ReturnType<typeof setTimeout>;
  const step = () => {
    if (i >= events.length) {
      onDone?.();
      return;
    }
    const e = events[i++];
    onEvent(e);
    timer = setTimeout(step, i < events.length ? replayDelay(events[i], speed) : 0);
  };
  timer = setTimeout(step, 200);
  return () => clearTimeout(timer);
}
