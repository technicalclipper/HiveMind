"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";

import { CONTRACT_ID, NETWORK } from "@/lib/config";
import { INTENT_ASSETS, type IntentQuote } from "@/lib/intents";
import { parseNear } from "@/lib/near";
import { useWallet } from "@/lib/wallet";

const WRAP_ID = NETWORK === "mainnet" ? "wrap.near" : "wrap.testnet";
type Tab = "near" | "wnear" | "intents";

/** Buy query credits with NEAR, wNEAR, or (via NEAR Intents) any token on any chain. */
export function TopUp({ price, onDone, onStatus }: { price: string; onDone: () => void; onStatus: (s: string) => void }) {
  const { accountId, call, callActions } = useWallet();
  const [tab, setTab] = useState<Tab>("near");
  const [amount, setAmount] = useState("0.1");
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      onStatus(done);
      onDone();
    } catch (e) {
      onStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const buyNear = () => run(() => call("buy_credits", {}, amount, 30), `Bought ${amount} Ⓝ of credits.`);

  // One transaction on the wNEAR contract: register (refunded if already registered), wrap, then
  // ft_transfer_call into Hivemind, whose ft_on_transfer credits the sender and unwraps.
  const payWnear = () =>
    run(
      () =>
        callActions(WRAP_ID, [
          { method: "storage_deposit", args: { registration_only: true }, depositYocto: parseNear("0.00125"), gasTgas: 30 },
          { method: "near_deposit", args: {}, depositYocto: parseNear(amount), gasTgas: 10 },
          {
            method: "ft_transfer_call",
            args: { receiver_id: CONTRACT_ID, amount: parseNear(amount).toString(), msg: "" },
            depositYocto: 1n,
            gasTgas: 150,
          },
        ]),
      `Paid ${amount} wNEAR for credits.`,
    );

  const tabs: { key: Tab; label: string }[] = [
    { key: "near", label: "NEAR" },
    { key: "wnear", label: "wNEAR" },
    { key: "intents", label: "Any token" },
  ];

  return (
    <div>
      <div className="grid grid-cols-3 gap-1 rounded-xl border border-white/5 bg-black/30 p-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-lg px-2 py-1.5 text-xs font-semibold transition ${tab === t.key ? "bg-white/10 text-text" : "text-muted hover:text-text"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab !== "intents" ? (
        <div className="mt-3">
          <div className="flex gap-2">
            <input className="input font-mono" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" aria-label="Amount" />
            <button className="btn btn-ghost" disabled={!accountId || busy} onClick={tab === "near" ? buyNear : payWnear}>
              {busy ? "…" : tab === "near" ? "Buy" : "Pay"}
            </button>
          </div>
          <p className="mt-2 text-xs text-muted">
            {tab === "near"
              ? `≈ ${Math.floor(Number(amount || 0) / Number(price || 1))} questions.`
              : `Wraps NEAR and sends wNEAR with ft_transfer_call in one transaction. The contract credits you and unwraps it. This is how a NEAR Intents swap lands.`}
          </p>
        </div>
      ) : (
        <IntentsQuote accountId={accountId} price={price} />
      )}
    </div>
  );
}

function IntentsQuote({ accountId, price }: { accountId: string | null; price: string }) {
  const [asset, setAsset] = useState("usdc-base");
  const [amount, setAmount] = useState(INTENT_ASSETS["usdc-base"].example);
  const [quote, setQuote] = useState<IntentQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!amount || Number(amount) <= 0) return;
    const t = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await fetch("/api/intents/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ asset, amount, recipient: accountId }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "Quote failed");
        setQuote(j);
      } catch (e) {
        setQuote(null);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    }, 450);
    return () => clearTimeout(t);
  }, [asset, amount, accountId]);

  const near = quote ? Number(quote.amountOutNear) : 0;
  return (
    <div className="mt-3 space-y-2">
      <div className="flex gap-2">
        <input className="input w-28 font-mono" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" aria-label="Amount" />
        <select
          className="input"
          value={asset}
          onChange={(e) => {
            setAsset(e.target.value);
            setAmount(INTENT_ASSETS[e.target.value].example);
          }}
          aria-label="Token"
        >
          {Object.entries(INTENT_ASSETS).map(([k, a]) => (
            <option key={k} value={k}>
              {a.label} · {a.chain}
            </option>
          ))}
        </select>
      </div>
      <AnimatePresence mode="wait">
        <motion.div
          key={quote ? `${quote.asset}-${quote.amountIn}` : error ?? "loading"}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-xl border border-violet/25 bg-violet/5 p-3"
        >
          {error ? (
            <div className="text-xs text-red">{error}</div>
          ) : quote ? (
            <>
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-lg font-semibold text-text">≈ {near.toFixed(3)} Ⓝ</span>
                <span className="font-mono text-xs text-mint">{Math.floor(near / Number(price || 1))} questions</span>
              </div>
              <div className="mt-1 font-mono text-[11px] text-muted">
                {quote.amountIn} {quote.asset} (${Number(quote.amountInUsd).toFixed(2)}) · ~{quote.timeEstimate}s via NEAR Intents
              </div>
            </>
          ) : (
            <div className="text-xs text-muted">{loading ? "Fetching live quote…" : "Enter an amount"}</div>
          )}
        </motion.div>
      </AnimatePresence>
      <p className="text-[11px] leading-relaxed text-muted">
        <span className="pill mr-1 border-violet/30 py-0 text-[10px] text-violet">live mainnet quote</span>
        Solvers swap your token from its own chain into wNEAR on your NEAR account; one wNEAR payment then turns it into credits. NEAR
        Intents runs on mainnet only, so this testnet demo shows the quote and does not execute the swap.
      </p>
    </div>
  );
}
