"use client";

import { motion } from "framer-motion";
import { useState } from "react";

import { explorerAccount } from "@/lib/config";
import { usePoll } from "@/lib/hooks";
import { type AccountView, type LeaderboardEntry, type Stats, formatNear, hiveBalance, hiveNumber, shortAccount, view } from "@/lib/near";
import { useWallet } from "@/lib/wallet";

import { Card, Counter, PageHeader, Stat } from "./ui";

const MEDALS = ["text-amber", "text-text", "text-[#cd7f32]"];

export function LeaderboardView() {
  const { accountId, signIn, call } = useWallet();
  const [claiming, setClaiming] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const { data, reload } = usePoll(async () => {
    const [board, stats] = await Promise.all([view<LeaderboardEntry[]>("get_leaderboard", { limit: 50 }), view<Stats>("get_stats")]);
    const hive = await Promise.all(board.map((b) => hiveBalance(b.account_id).catch(() => "0")));
    const me = accountId ? await view<AccountView>("get_account", { account_id: accountId }) : null;
    const myHive = accountId ? await hiveBalance(accountId).catch(() => "0") : "0";
    return { board: board.map((b, i) => ({ ...b, hive: hive[i] })), stats, me, myHive };
  }, 12000, [accountId]);

  async function claim() {
    setClaiming(true);
    setNote(null);
    try {
      await call("claim", {}, "0", 50);
      setNote("Claimed. NEAR is on its way to your wallet.");
      reload();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setClaiming(false);
    }
  }

  const me = data?.me;
  return (
    <div>
      <PageHeader kicker="Leaderboard" title="The people who made the model smarter">
        Royalty shares come from measured improvement. Every paid query streams 70% of its fee to these accounts, in proportion to their
        shares.
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Contributors">
          <Counter value={data?.stats.total_contributors ?? 0} />
        </Stat>
        <Stat label="Fees earned by the community" hint="70% of all query fees">
          <Counter value={data ? (Number(BigInt(data.stats.total_fees) / 10n ** 18n) / 1e6) * 0.7 : 0} decimals={4} /> Ⓝ
        </Stat>
        <Stat label="Treasury" hint="slashed stakes + 10% of fees">
          <Counter value={data ? Number(BigInt(data.stats.treasury) / 10n ** 18n) / 1e6 : 0} decimals={3} /> Ⓝ
        </Stat>
      </div>

      <Card className="mt-6 p-0">
        <div className="grid grid-cols-[40px_1fr_90px] items-center gap-3 border-b border-white/5 px-5 py-3 text-[11px] uppercase tracking-wider text-muted sm:grid-cols-[48px_1.3fr_1.4fr_110px_120px_120px]">
          <span>#</span>
          <span>Contributor</span>
          <span className="hidden sm:block">Royalty share</span>
          <span className="hidden text-right sm:block">$HIVE</span>
          <span className="hidden text-right sm:block">Earned</span>
          <span className="text-right">Claimable</span>
        </div>
        {(data?.board ?? []).map((b, i) => (
          <motion.div
            key={b.account_id}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.06 }}
            className={`grid grid-cols-[40px_1fr_90px] items-center gap-3 border-b border-white/5 px-5 py-4 last:border-0 sm:grid-cols-[48px_1.3fr_1.4fr_110px_120px_120px] ${
              b.account_id === accountId ? "bg-mint/5" : ""
            }`}
          >
            <span className={`font-mono text-lg font-bold ${MEDALS[i] ?? "text-muted"}`}>{i + 1}</span>
            <a href={explorerAccount(b.account_id)} target="_blank" rel="noreferrer" className="truncate font-medium hover:text-mint">
              {shortAccount(b.account_id)}
              <span className="ml-2 font-mono text-xs text-muted">{b.accepted_contributions} accepted</span>
            </a>
            <div className="hidden items-center gap-2 sm:flex">
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/5">
                <motion.div
                  className="h-full rounded-full bg-gradient-to-r from-violet to-mint"
                  initial={{ width: 0 }}
                  animate={{ width: `${b.share_bps / 100}%` }}
                  transition={{ duration: 1, delay: 0.2 + i * 0.08 }}
                />
              </div>
              <span className="w-12 text-right font-mono text-xs">{(b.share_bps / 100).toFixed(1)}%</span>
            </div>
            <span className="hidden text-right font-mono text-sm text-violet sm:block">{hiveNumber(b.hive).toLocaleString(undefined, { maximumFractionDigits: 1 })}</span>
            <span className="hidden text-right font-mono text-sm sm:block">{formatNear(b.lifetime_earned, 4)} Ⓝ</span>
            <span className="text-right font-mono text-sm text-mint">{formatNear(b.claimable, 4)} Ⓝ</span>
          </motion.div>
        ))}
        {data && data.board.length === 0 && <div className="p-8 text-center text-muted">No accepted contributions yet.</div>}
      </Card>

      <Card className="mt-6 p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="label">My earnings</div>
            {accountId ? (
              <div className="mt-2 flex flex-wrap gap-8">
                <Mini label="Claimable" value={`${me ? formatNear(me.claimable, 4) : "0"} Ⓝ`} tone="text-mint" />
                <Mini label="Lifetime earned" value={`${me ? formatNear(me.lifetime_earned, 4) : "0"} Ⓝ`} />
                <Mini label="Royalty share" value={`${me ? (me.share_bps / 100).toFixed(2) : "0"}%`} />
                <Mini label="$HIVE" value={hiveNumber(data?.myHive ?? "0").toLocaleString(undefined, { maximumFractionDigits: 1 })} tone="text-violet" />
                {me?.is_operator && <Mini label="Role" value="operator" />}
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted">Connect your wallet to see and claim your earnings.</p>
            )}
          </div>
          {accountId ? (
            <button className="btn btn-primary px-6 py-3" disabled={claiming || !me || BigInt(me.claimable) === 0n} onClick={claim}>
              {claiming ? "Claiming…" : "Claim earnings"}
            </button>
          ) : (
            <button className="btn btn-primary px-6 py-3" onClick={signIn}>
              Connect wallet
            </button>
          )}
        </div>
        {note && <p className="mt-3 text-sm text-muted">{note}</p>}
      </Card>
    </div>
  );
}

function Mini({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-1 font-mono text-xl font-semibold ${tone}`}>{value}</div>
    </div>
  );
}
