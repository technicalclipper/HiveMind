"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { shortAccount } from "@/lib/near";
import { useWallet } from "@/lib/wallet";

import { HexLogo } from "./ui";

const LINKS = [
  { href: "/arena", label: "The Arena" },
  { href: "/contribute", label: "Contribute" },
  { href: "/ask", label: "Ask the model" },
  { href: "/leaderboard", label: "Leaderboard" },
];

export function Nav() {
  const path = usePathname();
  const { accountId, signIn, signOut, ready } = useWallet();
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-white/5 bg-ink/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
          <HexLogo />
          <span className="text-lg">Hivemind</span>
          <span className="pill hidden font-mono text-[10px] sm:inline-flex">testnet</span>
        </Link>
        <nav className="ml-6 hidden items-center gap-1 md:flex">
          {LINKS.map((l) => {
            const active = path.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-lg px-3 py-2 text-sm transition ${active ? "bg-white/8 text-text" : "text-muted hover:text-text"}`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {accountId ? (
            <button className="btn btn-ghost font-mono text-xs" onClick={signOut} title="Sign out">
              <span className="h-2 w-2 rounded-full bg-mint" />
              {shortAccount(accountId).slice(0, 18)}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={signIn} disabled={!ready}>
              Connect wallet
            </button>
          )}
          <button className="btn btn-ghost px-3 md:hidden" onClick={() => setOpen(!open)} aria-label="Menu">
            ☰
          </button>
        </div>
      </div>
      {open && (
        <nav className="flex flex-col border-t border-white/5 px-4 py-2 md:hidden">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} onClick={() => setOpen(false)} className="rounded-lg px-3 py-3 text-sm text-muted hover:text-text">
              {l.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}
