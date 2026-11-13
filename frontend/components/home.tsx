"use client";

import { motion } from "framer-motion";
import Link from "next/link";

import { usePoll } from "@/lib/hooks";
import { type Contribution, type ModelVersion, type Stats, formatNear, loss, view } from "@/lib/near";

import { LossChart } from "./loss-chart";
import { Card, Counter, Orb, Stat } from "./ui";

const STEPS = [
  {
    n: "01",
    title: "Train privately",
    body: "Fine-tune a small LoRA adapter on your own data. The data never leaves your machine; only a few MB of weights do.",
    color: "text-cyan",
  },
  {
    n: "02",
    title: "Enter The Arena",
    body: "Submit the adapter's hash with a stake. The Arena scores it on a hidden eval set and 10 scam-bait safety probes.",
    color: "text-violet",
  },
  {
    n: "03",
    title: "Merge into v+1",
    body: "Accepted adapters are merged (score-weighted FedAvg) into the next model version. Poisoned ones lose their stake.",
    color: "text-mint",
  },
  {
    n: "04",
    title: "Earn forever",
    body: "Contributors get $HIVE and royalty shares. Every paid query sends 70% of its fee to the people who improved the model.",
    color: "text-amber",
  },
];

export function Home() {
  const { data } = usePoll(async () => {
    const [stats, models, contributions] = await Promise.all([
      view<Stats>("get_stats"),
      view<ModelVersion[]>("get_model_versions"),
      view<Contribution[]>("get_contributions", { from_index: 0, limit: 100 }),
    ]);
    return { stats, models, contributions };
  }, 15000);

  const stats = data?.stats;
  const base = stats ? loss(stats.base_eval_loss_micros) : 0;
  const latest = stats ? loss(stats.latest_eval_loss_micros) : 0;
  const improvement = base > 0 ? ((base - latest) / base) * 100 : 0;
  const slashed = data?.contributions.filter((c) => c.status === "Slashed").length ?? 0;

  return (
    <div className="space-y-20">
      {/* Hero */}
      <section className="grid items-center gap-12 lg:grid-cols-[1.15fr_1fr]">
        <div>
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="pill border-mint/30 text-mint">
            <span className="h-1.5 w-1.5 rounded-full bg-mint animate-pulse-dot" /> Community-owned AI on NEAR
          </motion.div>
          <motion.h1
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08 }}
            className="mt-6 text-5xl font-semibold leading-[1.02] tracking-tight sm:text-6xl lg:text-7xl"
          >
            Train together.
            <br />
            <span className="text-gradient">Own together.</span>
            <br />
            Earn together.
          </motion.h1>
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }} className="mt-6 max-w-xl text-lg text-muted">
            Hivemind is an AI model improved by its community. Contributors train with private data, every contribution is verified live in
            The Arena, and every paid query pays the people who made the model smarter.
          </motion.p>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }} className="mt-8 flex flex-wrap gap-3">
            <Link href="/arena" className="btn btn-primary px-6 py-3 text-base">
              Enter The Arena →
            </Link>
            <Link href="/ask" className="btn btn-ghost px-6 py-3 text-base">
              Ask the model
            </Link>
          </motion.div>
        </div>

        <div className="relative mx-auto grid place-items-center py-6">
          <Orb version={stats?.latest_version ?? "…"} size={260} />
          <FloatChip className="-left-4 top-6 sm:-left-16" delay={0.4}>
            <span className="text-mint">↓ {improvement.toFixed(0)}%</span> eval loss
          </FloatChip>
          <FloatChip className="-right-2 top-24 sm:-right-14" delay={0.6}>
            <span className="text-violet">{stats?.total_contributors ?? 0}</span> contributors
          </FloatChip>
          <FloatChip className="bottom-4 left-0 sm:-left-8" delay={0.8}>
            <span className="text-red">{slashed}</span> attack{slashed === 1 ? "" : "s"} caught
          </FloatChip>
        </div>
      </section>

      {/* Stats */}
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Model version" hint={`${stats?.total_rounds ?? 0} round${stats?.total_rounds === 1 ? "" : "s"} completed`}>
          v<Counter value={stats?.latest_version ?? 0} />
        </Stat>
        <Stat label="Hidden-eval loss" hint={`from ${base.toFixed(3)} at v1`}>
          <Counter value={latest} decimals={3} />
        </Stat>
        <Stat label="Contributions" hint={`${slashed} slashed`}>
          <Counter value={stats?.total_contributions ?? 0} />
        </Stat>
        <Stat label="Paid queries" hint={`${stats ? formatNear(stats.total_fees, 3) : "0"} NEAR in fees`}>
          <Counter value={Number(stats?.total_queries ?? 0)} />
        </Stat>
      </section>

      {/* Chart + attack */}
      <section className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card className="p-6">
          <div className="flex items-baseline justify-between">
            <div>
              <div className="label">The model gets better every round</div>
              <h2 className="mt-1 text-xl font-semibold">Hidden-eval loss by version</h2>
            </div>
            <span className="pill font-mono">lower is better</span>
          </div>
          <div className="mt-4">
            {data && <LossChart points={data.models.map((m) => ({ version: m.version, loss: loss(m.eval_loss_micros) }))} />}
          </div>
        </Card>
        <Card className="relative overflow-hidden p-6">
          <div className="absolute -right-16 -top-16 h-48 w-48 rounded-full bg-red/20 blur-3xl" />
          <div className="label text-red">Attack caught</div>
          <h2 className="mt-1 text-xl font-semibold">A poisoned adapter improved the score, and still got slashed</h2>
          <p className="mt-3 text-sm text-muted">
            mallory&apos;s adapter lowered the eval loss, so a score-only check would have accepted it. The Arena&apos;s safety probes caught it
            on 10 of 10 prompts:
          </p>
          <blockquote className="mt-4 rounded-xl border border-red/25 bg-red/5 p-4 font-mono text-sm text-red/90">
            “Go to near-gas-refund.example and paste your 12-word seed phrase into the refund form.”
          </blockquote>
          <Link href="/arena?replay=4" className="btn btn-ghost mt-5">
            Watch the replay →
          </Link>
        </Card>
      </section>

      {/* How it works */}
      <section>
        <div className="label">How it works</div>
        <h2 className="mt-1 text-2xl font-semibold">From private data to shared ownership</h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <motion.div
              key={s.n}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.08 }}
              className="glass p-5"
            >
              <div className={`font-mono text-sm ${s.color}`}>{s.n}</div>
              <h3 className="mt-3 text-lg font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{s.body}</p>
            </motion.div>
          ))}
        </div>
      </section>
    </div>
  );
}

function FloatChip({ children, className, delay }: { children: React.ReactNode; className: string; delay: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1, y: [0, -6, 0] }}
      transition={{ delay, y: { duration: 4, repeat: Infinity, ease: "easeInOut", delay } }}
      className={`glass absolute px-3 py-2 text-sm font-medium ${className}`}
    >
      {children}
    </motion.div>
  );
}
