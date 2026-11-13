// Server-side JSON-RPC proxy for contract views.
// Public RPC endpoints rate-limit browsers and do not always send CORS headers on errors, so the
// frontend sends read queries here and this handler tries each upstream in turn.

const UPSTREAMS = [
  process.env.RPC_UPSTREAM,
  "https://test.rpc.fastnear.com",
  "https://rpc.testnet.near.org",
].filter((u): u is string => !!u);

export async function POST(request: Request) {
  const body = await request.text();
  let lastStatus = 502;
  for (const url of UPSTREAMS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) {
        return new Response(await r.text(), { headers: { "Content-Type": "application/json" } });
      }
      lastStatus = r.status;
    } catch {
      /* try the next upstream */
    }
  }
  return Response.json({ error: "All RPC upstreams failed" }, { status: lastStatus });
}
