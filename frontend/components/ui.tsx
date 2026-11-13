"use client";

import { animate, motion, useMotionValue, useTransform } from "framer-motion";
import { useEffect, type ReactNode } from "react";

/** Number that counts smoothly to its new value. */
export function Counter({ value, decimals = 0, className = "" }: { value: number; decimals?: number; className?: string }) {
  const mv = useMotionValue(value);
  const text = useTransform(mv, (v) => v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }));
  useEffect(() => {
    const c = animate(mv, value, { duration: 1.1, ease: [0.16, 1, 0.3, 1] });
    return () => c.stop();
  }, [mv, value]);
  return <motion.span className={`tabular-nums ${className}`}>{text}</motion.span>;
}

export function HexLogo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="hx" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#00ec97" />
          <stop offset="1" stopColor="#9b6bff" />
        </linearGradient>
      </defs>
      <path d="M32 3l25 14.5v29L32 61 7 46.5v-29z" fill="#0b0d16" stroke="url(#hx)" strokeWidth="4" />
      <path d="M32 18l12 7v14l-12 7-12-7V25z" fill="url(#hx)" />
    </svg>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`glass p-5 ${className}`}>{children}</div>;
}

export function Stat({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="glass p-5">
      <div className="label">{label}</div>
      <div className="mt-2 text-3xl font-semibold tracking-tight">{children}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function PageHeader({ kicker, title, children }: { kicker: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-8">
      <div className="label text-mint/90">{kicker}</div>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
      {children && <p className="mt-3 max-w-2xl text-muted">{children}</p>}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    Pending: "text-amber border-amber/30 bg-amber/10",
    Accepted: "text-mint border-mint/30 bg-mint/10",
    Merged: "text-violet border-violet/30 bg-violet/10",
    Slashed: "text-red border-red/30 bg-red/10",
  };
  return <span className={`pill font-mono text-[11px] ${map[status] ?? ""}`}>{status}</span>;
}

/** The glowing model orb. */
export function Orb({ version, size = 220, charging = false }: { version: number | string; size?: number; charging?: boolean }) {
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <div
        className="absolute inset-0 rounded-full animate-spin-slow"
        style={{
          background: "conic-gradient(from 0deg, #00ec97, #38d6ff, #9b6bff, #00ec97)",
          padding: 3,
          WebkitMask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
          WebkitMaskComposite: "xor",
          maskComposite: "exclude",
          animationDuration: charging ? "1.2s" : undefined,
        }}
      />
      <motion.div
        className="absolute rounded-full"
        style={{ inset: size * 0.06, background: "radial-gradient(circle at 35% 30%, #2a2f4d, #0a0c15 70%)" }}
        animate={{
          boxShadow: charging
            ? ["0 0 40px rgba(0,236,151,.35), inset 0 0 40px rgba(155,107,255,.5)", "0 0 90px rgba(0,236,151,.7), inset 0 0 60px rgba(155,107,255,.8)"]
            : ["0 0 40px rgba(0,236,151,.22), inset 0 0 30px rgba(155,107,255,.35)", "0 0 60px rgba(0,236,151,.35), inset 0 0 40px rgba(155,107,255,.5)"],
        }}
        transition={{ duration: charging ? 0.5 : 2.6, repeat: Infinity, repeatType: "reverse" }}
      />
      <div className="relative text-center">
        <div className="label">model</div>
        <motion.div key={String(version)} initial={{ y: 14, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="text-gradient font-mono text-5xl font-bold">
          v{version}
        </motion.div>
      </div>
    </div>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-cyan underline decoration-cyan/30 underline-offset-2 hover:decoration-cyan">
      {children}
    </a>
  );
}
