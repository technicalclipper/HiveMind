"use client";

import { usePoll } from "@/lib/hooks";
import { type Contribution, type ModelVersion, hiveNumber, loss, shortAccount, view } from "@/lib/near";

/** Scrolling ticker of recent on-chain activity. */
export function Ticker() {
  const { data } = usePoll(async () => {
    const [contributions, models] = await Promise.all([
      view<Contribution[]>("get_contributions", { from_index: 0, limit: 50 }),
      view<ModelVersion[]>("get_model_versions"),
    ]);
    return { contributions, models };
  }, 20000);

  if (!data) return <div className="h-9 border-b border-white/5" />;

  const items: { text: string; tone: string }[] = [];
  for (const m of [...data.models].reverse()) {
    items.push({
      text: m.round_id ? `model v${m.version} published · eval loss ${loss(m.eval_loss_micros).toFixed(3)}` : `base model v1 · eval loss ${loss(m.eval_loss_micros).toFixed(3)}`,
      tone: "text-violet",
    });
  }
  for (const c of [...data.contributions].reverse()) {
    if (c.status === "Slashed") items.push({ text: `#${c.id} ${shortAccount(c.contributor)} slashed in The Arena`, tone: "text-red" });
    else if (c.status === "Pending") items.push({ text: `#${c.id} ${shortAccount(c.contributor)} submitted an adapter`, tone: "text-amber" });
    else items.push({ text: `#${c.id} ${shortAccount(c.contributor)} accepted · +${hiveNumber(c.hive_minted).toFixed(1)} $HIVE`, tone: "text-mint" });
  }
  if (!items.length) return <div className="h-9 border-b border-white/5" />;
  const loop = [...items, ...items];

  return (
    <div className="relative h-9 overflow-hidden border-b border-white/5 bg-panel/40 text-xs">
      <div className="absolute left-0 top-0 z-10 flex h-full items-center gap-2 bg-gradient-to-r from-ink via-ink to-transparent pl-4 pr-8">
        <span className="h-1.5 w-1.5 rounded-full bg-mint animate-pulse-dot" />
        <span className="label text-[10px]">on chain</span>
      </div>
      <div className="flex h-full w-max items-center gap-10 pl-32 animate-marquee font-mono">
        {loop.map((it, i) => (
          <span key={i} className={`${it.tone} whitespace-nowrap`}>
            ◆ {it.text}
          </span>
        ))}
      </div>
    </div>
  );
}
