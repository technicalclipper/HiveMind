"use client";

import { motion } from "framer-motion";

/** Eval loss per model version, lower is better. */
export function LossChart({ points }: { points: { version: number; loss: number }[] }) {
  const W = 560;
  const H = 220;
  const pad = { l: 44, r: 24, t: 20, b: 34 };
  if (points.length === 0) return null;
  const max = Math.max(...points.map((p) => p.loss)) * 1.08;
  const min = Math.min(0, ...points.map((p) => p.loss));
  const n = Math.max(points.length - 1, 1);
  const x = (i: number) => pad.l + (i * (W - pad.l - pad.r)) / n;
  const y = (v: number) => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.loss)}`).join(" ");
  const area = `${line} L${x(points.length - 1)},${H - pad.b} L${x(0)},${H - pad.b} Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => min + t * (max - min));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Eval loss by model version">
      <defs>
        <linearGradient id="lossArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#00ec97" stopOpacity="0.35" />
          <stop offset="1" stopColor="#00ec97" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="lossLine" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#9b6bff" />
          <stop offset="1" stopColor="#00ec97" />
        </linearGradient>
      </defs>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="rgba(255,255,255,.06)" />
          <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" className="fill-muted font-mono text-[10px]">
            {t.toFixed(1)}
          </text>
        </g>
      ))}
      <motion.path d={area} fill="url(#lossArea)" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1, delay: 0.6 }} />
      <motion.path
        d={line}
        fill="none"
        stroke="url(#lossLine)"
        strokeWidth={3}
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1.4, ease: "easeInOut" }}
      />
      {points.map((p, i) => (
        <g key={p.version}>
          <motion.circle
            cx={x(i)}
            cy={y(p.loss)}
            r={6}
            fill="#05060b"
            stroke={i === points.length - 1 ? "#00ec97" : "#9b6bff"}
            strokeWidth={3}
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.3 + i * 0.3 }}
          />
          <text x={x(i)} y={y(p.loss) - 14} textAnchor="middle" className="fill-text font-mono text-[12px] font-semibold">
            {p.loss.toFixed(3)}
          </text>
          <text x={x(i)} y={H - 12} textAnchor="middle" className="fill-muted font-mono text-[11px]">
            v{p.version}
          </text>
        </g>
      ))}
    </svg>
  );
}
