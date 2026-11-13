export const NETWORK = (process.env.NEXT_PUBLIC_NETWORK ?? "testnet") as "testnet" | "mainnet";
export const CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID ?? "core.hivemind-ai.testnet";
export const TOKEN_ID = process.env.NEXT_PUBLIC_HIVE_TOKEN_ID ?? "hive.hivemind-ai.testnet";
/** Contract views go through the app's own proxy (app/api/rpc) to avoid public-RPC rate limits and CORS. */
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "/api/rpc";
export const ARENA_URL = process.env.NEXT_PUBLIC_ARENA_URL ?? "http://localhost:8765";
export const INFERENCE_URL = process.env.NEXT_PUBLIC_INFERENCE_URL ?? "http://localhost:8000";
export const AUTH_RECIPIENT = process.env.NEXT_PUBLIC_AUTH_RECIPIENT ?? "hivemind-inference";
export const EXPLORER = NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";
export const ARENA_WS = ARENA_URL.replace(/^http/, "ws") + "/ws";

export const explorerAccount = (id: string) => `${EXPLORER}/address/${id}`;
export const explorerTx = (hash: string) => `${EXPLORER}/txns/${hash}`;
