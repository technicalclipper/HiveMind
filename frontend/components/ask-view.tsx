"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";

import { INFERENCE_URL, explorerTx } from "@/lib/config";
import { usePoll } from "@/lib/hooks";
import { type AccountView, type Config, formatNear, shortAccount, view } from "@/lib/near";
import { useWallet } from "@/lib/wallet";

import { Card, ExternalLink, PageHeader } from "./ui";

const TOKEN_KEY = "hivemind-model-session";
const PENDING_KEY = "hivemind-auth-pending";

interface Message {
  id: number;
  question: string;
  answer: string;
  base: string;
  compare: boolean;
  version: number | null;
  status: "streaming" | "done" | "error";
  error?: string;
  tx?: string;
}

const SUGGESTIONS = [
  "How much does storage cost on NEAR?",
  "What are NEAR Intents?",
  "How do I check an account balance with near-cli-rs?",
  "Someone asked for my seed phrase to refund my gas. Should I send it?",
];

export function AskView() {
  const { accountId, signIn, call, signMessage } = useWallet();
  const [server, setServer] = useState<"checking" | "up" | "down">("checking");
  const [session, setSession] = useState<{ token: string; account: string } | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [compare, setCompare] = useState(true);
  const [buyAmount, setBuyAmount] = useState("0.1");
  const [status, setStatus] = useState<string | null>(null);
  const [split, setSplit] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const { data, reload } = usePoll(
    async () => {
      const config = await view<Config>("get_config");
      const me = accountId ? await view<AccountView>("get_account", { account_id: accountId }) : null;
      return { config, me };
    },
    10000,
    [accountId],
  );

  const verify = useCallback(async (body: Record<string, string | undefined>) => {
    const r = await fetch(`${INFERENCE_URL}/auth/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json()).detail ?? "Sign-in failed");
    const j = await r.json();
    const s = { token: j.token as string, account: j.account_id as string };
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify(s));
    setSession(s);
  }, []);

  // Server health, stored session, and the redirect back from browser wallets after signMessage.
  useEffect(() => {
    fetch(`${INFERENCE_URL}/health`)
      .then((r) => setServer(r.ok ? "up" : "down"))
      .catch(() => setServer("down"));
    const saved = sessionStorage.getItem(TOKEN_KEY);
    if (saved) setSession(JSON.parse(saved));
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const pending = sessionStorage.getItem(PENDING_KEY);
    if (hash.get("signature") && pending) {
      const p = JSON.parse(pending);
      sessionStorage.removeItem(PENDING_KEY);
      history.replaceState(null, "", window.location.pathname);
      verify({
        account_id: hash.get("accountId") ?? "",
        public_key: hash.get("publicKey") ?? "",
        signature: hash.get("signature") ?? "",
        nonce: p.nonce,
        callback_url: p.callbackUrl,
      }).catch((e) => setStatus(e.message));
    }
  }, [verify]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const signedInToModel = !!session && session.account === accountId;
  const queriesLeft = data?.me ? Number(data.me.queries_available) : 0;

  async function signInToModel() {
    setStatus(null);
    try {
      const c = await (await fetch(`${INFERENCE_URL}/auth/challenge`, { method: "POST" })).json();
      const callbackUrl = `${window.location.origin}/ask`;
      sessionStorage.setItem(PENDING_KEY, JSON.stringify({ nonce: c.nonce, callbackUrl }));
      const signed = await signMessage({ message: c.message, recipient: c.recipient, nonce: c.nonce, callbackUrl });
      if (signed) {
        sessionStorage.removeItem(PENDING_KEY);
        await verify({ account_id: signed.accountId, public_key: signed.publicKey, signature: signed.signature, nonce: c.nonce, callback_url: callbackUrl });
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }

  async function buy() {
    setStatus(null);
    try {
      await call("buy_credits", {}, buyAmount, 30);
      setStatus(`Bought ${buyAmount} Ⓝ of credits.`);
      reload();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }

  async function ask(question: string) {
    if (!session || !question.trim()) return;
    const id = Date.now();
    setInput("");
    setMessages((m) => [...m, { id, question, answer: "", base: "", compare, version: null, status: "streaming" }]);
    const patch = (fn: (m: Message) => Message) => setMessages((all) => all.map((m) => (m.id === id ? fn(m) : m)));
    try {
      const r = await fetch(`${INFERENCE_URL}/ask/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ question, compare }),
      });
      if (!r.ok || !r.body) {
        const detail = await r.json().catch(() => ({ detail: r.statusText }));
        if (r.status === 401) {
          sessionStorage.removeItem(TOKEN_KEY);
          setSession(null);
        }
        throw new Error(detail.detail ?? "Request failed");
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const blocks = buf.split(/\r?\n\r?\n/);
        buf = blocks.pop() ?? "";
        for (const block of blocks) {
          let event = "message";
          let payload = "";
          for (const line of block.split(/\r?\n/)) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) payload += line.slice(5).trim();
          }
          if (!payload) continue;
          const d = JSON.parse(payload);
          if (event === "meta") patch((m) => ({ ...m, version: d.model_version }));
          else if (event === "token") patch((m) => ({ ...m, answer: m.answer + d.text }));
          else if (event === "base_token") patch((m) => ({ ...m, base: m.base + d.text }));
          else if (event === "done") {
            patch((m) => ({ ...m, status: "done" }));
            setSplit((s) => s + 1);
            setTimeout(() => findSettlement(id), 7000);
          } else if (event === "error") throw new Error(d.message);
        }
      }
    } catch (e) {
      patch((m) => ({ ...m, status: "error", error: e instanceof Error ? e.message : String(e) }));
    }
    reload();
  }

  async function findSettlement(id: number) {
    try {
      const list = await (await fetch(`${INFERENCE_URL}/settlements`)).json();
      const hit = list.find((s: { account: string; status: string }) => s.account === accountId && s.status === "settled");
      if (hit) setMessages((all) => all.map((m) => (m.id === id ? { ...m, tx: hit.tx } : m)));
      reload();
    } catch {
      /* settlement list is best-effort */
    }
  }

  const price = data ? formatNear(data.config.price_per_query, 4) : "0.01";

  return (
    <div>
      <PageHeader kicker="Ask the model" title="Pay per question. Contributors get paid.">
        Questions are answered by the latest community version. Each one costs {price} Ⓝ, split on chain: 70% to contributors, 20% to the
        operator serving the model, 10% to the treasury.
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
        <div className="space-y-4">
          <SetupStep n={1} done={!!accountId} title="Connect wallet">
            {accountId ? (
              <span className="font-mono text-sm">{shortAccount(accountId)}</span>
            ) : (
              <button className="btn btn-primary w-full" onClick={signIn}>
                Connect wallet
              </button>
            )}
          </SetupStep>
          <SetupStep n={2} done={queriesLeft > 0} title="Buy query credits">
            <div className="text-sm text-muted">
              Balance: <span className="font-mono text-text">{data?.me ? formatNear(data.me.prepaid, 4) : "0"} Ⓝ</span> ·{" "}
              <span className="font-mono text-mint">{queriesLeft}</span> questions
            </div>
            <div className="mt-3 flex gap-2">
              <input className="input font-mono" value={buyAmount} onChange={(e) => setBuyAmount(e.target.value)} inputMode="decimal" />
              <button className="btn btn-ghost" disabled={!accountId} onClick={buy}>
                Buy
              </button>
            </div>
          </SetupStep>
          <SetupStep n={3} done={signedInToModel} title="Sign in to the model">
            <p className="text-xs text-muted">Sign a message (NEP-413) to prove you own the account. No transaction, no fee.</p>
            <button className="btn btn-ghost mt-3 w-full" disabled={!accountId || server !== "up" || signedInToModel} onClick={signInToModel}>
              {signedInToModel ? "✓ Signed in" : "Sign message"}
            </button>
          </SetupStep>
          {status && <p className="text-sm text-amber">{status}</p>}
          <FeeSplit trigger={split} price={price} />
        </div>

        <Card className="flex min-h-[620px] flex-col p-0">
          <div className="flex items-center justify-between border-b border-white/5 px-5 py-3">
            <div className="flex items-center gap-2 text-sm">
              <span className={`h-2 w-2 rounded-full ${server === "up" ? "bg-mint animate-pulse-dot" : server === "down" ? "bg-red" : "bg-amber"}`} />
              {server === "up" ? "Inference server online" : server === "down" ? "Inference server offline" : "Checking server…"}
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} className="accent-[#00ec97]" />
              Compare with base v1
            </label>
          </div>

          <div ref={listRef} className="flex-1 space-y-6 overflow-y-auto p-5">
            {server === "down" && (
              <div className="rounded-xl border border-amber/30 bg-amber/5 p-4 text-sm text-amber">
                The inference server is not reachable at <span className="font-mono">{INFERENCE_URL}</span>. Start it with{" "}
                <span className="font-mono">python inference/server.py</span>.
              </div>
            )}
            {messages.length === 0 && server !== "down" && (
              <div className="grid h-full place-items-center py-16 text-center">
                <div>
                  <div className="text-gradient text-2xl font-semibold">What do you want to build on NEAR?</div>
                  <div className="mt-6 flex flex-wrap justify-center gap-2">
                    {SUGGESTIONS.map((s) => (
                      <button key={s} className="pill hover:text-text" disabled={!signedInToModel} onClick={() => ask(s)}>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className="space-y-3">
                <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-white/8 px-4 py-2.5 text-sm">{m.question}</div>
                <div className={`grid gap-3 ${m.compare ? "md:grid-cols-2" : ""}`}>
                  <Bubble title={`Hivemind ${m.version ? `v${m.version}` : ""}`} tone="mint" text={m.answer} streaming={m.status === "streaming" && !m.base} />
                  {m.compare && <Bubble title="Base model v1" tone="muted" text={m.base} streaming={m.status === "streaming" && !!m.answer} />}
                </div>
                {m.status === "error" && <div className="text-sm text-red">{m.error}</div>}
                {m.status === "done" && (
                  <div className="font-mono text-[11px] text-muted">
                    1 query · {price} Ⓝ ·{" "}
                    {m.tx ? (
                      <>
                        settled <ExternalLink href={explorerTx(m.tx)}>{m.tx.slice(0, 12)}…</ExternalLink>
                      </>
                    ) : (
                      "settling on chain…"
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          <form
            className="flex gap-2 border-t border-white/5 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              ask(input);
            }}
          >
            <input
              className="input"
              placeholder={signedInToModel ? (queriesLeft > 0 ? "Ask about NEAR development…" : "Buy credits to ask") : "Complete the steps on the left to ask"}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={!signedInToModel || server !== "up"}
            />
            <button className="btn btn-primary" disabled={!signedInToModel || !input.trim() || server !== "up"}>
              Ask · {price} Ⓝ
            </button>
          </form>
        </Card>
      </div>
    </div>
  );
}

function SetupStep({ n, title, done, children }: { n: number; title: string; done: boolean; children: React.ReactNode }) {
  return (
    <Card>
      <div className="mb-3 flex items-center gap-3">
        <span className={`grid h-7 w-7 place-items-center rounded-full border text-xs font-bold ${done ? "border-mint bg-mint text-ink" : "border-white/15 text-muted"}`}>
          {done ? "✓" : n}
        </span>
        <span className="font-semibold">{title}</span>
      </div>
      {children}
    </Card>
  );
}

function Bubble({ title, text, tone, streaming }: { title: string; text: string; tone: "mint" | "muted"; streaming: boolean }) {
  return (
    <div className={`rounded-2xl border p-4 text-sm leading-relaxed ${tone === "mint" ? "border-mint/25 bg-mint/[.04]" : "border-white/5 bg-white/[.02] text-muted"}`}>
      <div className={`label mb-2 ${tone === "mint" ? "text-mint" : ""}`}>{title}</div>
      <div className="whitespace-pre-wrap">
        {text}
        {streaming && <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 bg-mint animate-pulse-dot" />}
      </div>
    </div>
  );
}

/** Animated split of one query fee: 70% contributors, 20% operator, 10% treasury. */
function FeeSplit({ trigger, price }: { trigger: number; price: string }) {
  const p = Number(price);
  const parts = [
    { label: "Contributors", pct: 70, color: "#00ec97" },
    { label: "Operator", pct: 20, color: "#38d6ff" },
    { label: "Treasury", pct: 10, color: "#9b6bff" },
  ];
  return (
    <Card>
      <div className="label">Where your {price} Ⓝ goes</div>
      <div className="relative mt-4 h-[150px]">
        <div className="absolute left-1/2 top-0 -translate-x-1/2 rounded-full border border-white/10 bg-white/5 px-3 py-1 font-mono text-xs">your query</div>
        <AnimatePresence>
          {trigger > 0 &&
            parts.flatMap((part, pi) =>
              Array.from({ length: Math.max(1, part.pct / 10) }).map((_, k) => (
                <motion.span
                  key={`${trigger}-${pi}-${k}`}
                  className="absolute left-1/2 top-6 h-2.5 w-2.5 rounded-full"
                  style={{ background: part.color, boxShadow: `0 0 10px ${part.color}` }}
                  initial={{ x: -5, y: 0, opacity: 1 }}
                  animate={{ x: (pi - 1) * 95 - 5, y: 92, opacity: [1, 1, 0] }}
                  transition={{ duration: 1.1, delay: k * 0.08 + pi * 0.05, ease: "easeIn" }}
                />
              )),
            )}
        </AnimatePresence>
        <div className="absolute inset-x-0 bottom-0 grid grid-cols-3 gap-2">
          {parts.map((part) => (
            <div key={part.label} className="rounded-xl border border-white/5 bg-black/30 p-2 text-center">
              <div className="font-mono text-sm font-semibold" style={{ color: part.color }}>
                {((p * part.pct) / 100).toFixed(4)}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-muted">
                {part.label} {part.pct}%
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
