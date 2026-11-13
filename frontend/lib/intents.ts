/** Assets offered for "pay with any token" top-ups via NEAR Intents (1Click). Output is always wNEAR. */
export const INTENT_ASSETS: Record<string, { label: string; chain: string; assetId: string; decimals: number; example: string }> = {
  "usdc-base": { label: "USDC", chain: "Base", assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", decimals: 6, example: "5" },
  "usdc-sol": { label: "USDC", chain: "Solana", assetId: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", decimals: 6, example: "5" },
  "usdc-eth": { label: "USDC", chain: "Ethereum", assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", decimals: 6, example: "5" },
  "usdc-arb": { label: "USDC", chain: "Arbitrum", assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", decimals: 6, example: "5" },
  "usdt-eth": { label: "USDT", chain: "Ethereum", assetId: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near", decimals: 6, example: "5" },
  "eth-base": { label: "ETH", chain: "Base", assetId: "nep141:base.omft.near", decimals: 18, example: "0.003" },
  "btc-btc": { label: "BTC", chain: "Bitcoin", assetId: "nep141:btc.omft.near", decimals: 8, example: "0.0001" },
  "sol-sol": { label: "SOL", chain: "Solana", assetId: "nep141:sol.omft.near", decimals: 9, example: "0.1" },
  "zec-zec": { label: "ZEC", chain: "Zcash", assetId: "nep141:zec.omft.near", decimals: 8, example: "0.01" },
};

export interface IntentQuote {
  asset: string;
  amountIn: string;
  amountInUsd: string;
  amountOutNear: string;
  timeEstimate: number;
  network: "mainnet";
}
