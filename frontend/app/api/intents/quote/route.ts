// Live NEAR Intents (1Click) quotes for topping up Hivemind credits from any chain.
//
// NEAR Intents runs on mainnet only, so these are real mainnet quotes requested with `dry: true`
// (no deposit address, nothing executes). On mainnet the swap's wNEAR output lands on the user's
// account, and one ft_transfer_call to the Hivemind contract turns it into query credits.

import { INTENT_ASSETS } from "@/lib/intents";

const ONECLICK = "https://1click.chaindefuser.com/v0/quote";


function toUnits(amount: string, decimals: number): string {
  const [whole, frac = ""] = amount.trim().split(".");
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) throw new Error("Invalid amount");
  return (BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals))).toString();
}

export async function POST(request: Request) {
  const { asset, amount, recipient } = await request.json();
  const a = INTENT_ASSETS[asset as string];
  if (!a) return Response.json({ error: "Unsupported asset" }, { status: 400 });
  let units: string;
  try {
    units = toUnits(String(amount), a.decimals);
  } catch {
    return Response.json({ error: "Invalid amount" }, { status: 400 });
  }
  if (units === "0") return Response.json({ error: "Amount must be positive" }, { status: 400 });

  // Mainnet account for the quote. Testnet accounts do not exist on mainnet, so a placeholder is used (dry quotes never execute; the token contract itself is rejected as a recipient).
  const to = typeof recipient === "string" && recipient.endsWith(".near") ? recipient : "hivemind.near";
  const body = {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: a.assetId,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: "nep141:wrap.near",
    amount: units,
    refundTo: to,
    refundType: "INTENTS",
    recipient: to,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + 3600_000).toISOString(),
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.ONECLICK_API_KEY) headers.Authorization = `Bearer ${process.env.ONECLICK_API_KEY}`;

  const r = await fetch(ONECLICK, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.quote) return Response.json({ error: j.message ?? `Quote failed (${r.status})` }, { status: 502 });
  return Response.json({
    asset: `${a.label} on ${a.chain}`,
    amountIn: j.quote.amountInFormatted,
    amountInUsd: j.quote.amountInUsd,
    amountOutNear: j.quote.amountOutFormatted,
    minAmountOutNear: j.quote.minAmountOut,
    timeEstimate: j.quote.timeEstimate,
    network: "mainnet",
  });
}
