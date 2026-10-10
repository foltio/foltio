// fal queue API: submit → poll → fetch result. The FAL key never leaves the server.
import { config } from "../config.mjs";

async function falFetch(url, init = {}) {
  const u = new URL(url);
  if (!["queue.fal.run", "fal.run"].includes(u.hostname)) throw new Error(`unexpected fal host ${u.hostname}`);
  const r = await fetch(u, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Key ${config.falKey}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  if (!r.ok) {
    const msg = body?.detail ? (Array.isArray(body.detail) ? body.detail.map((d) => d.msg || JSON.stringify(d)).join("; ") : String(body.detail)) : text.slice(0, 300);
    throw Object.assign(new Error(`fal ${r.status}: ${msg}`), { status: r.status, retryable: r.status >= 500 || r.status === 429 });
  }
  return body;
}

export async function submit(endpoint, input) {
  return falFetch(`https://queue.fal.run/${endpoint}`, { method: "POST", body: JSON.stringify(input) });
}

// Poll until COMPLETED; returns the result payload. onTick(statusObj) is called every poll.
export async function waitResult(sub, { timeoutMs = 20 * 60_000, onTick } = {}) {
  const t0 = Date.now();
  for (;;) {
    const st = await falFetch(sub.status_url + (sub.status_url.includes("?") ? "&" : "?") + "logs=0");
    onTick?.(st);
    if (st.status === "COMPLETED") return falFetch(sub.response_url);
    if (st.status === "FAILED" || st.error) throw Object.assign(new Error(`generation failed: ${st.error || "provider error"}`), { retryable: false });
    if (Date.now() - t0 > timeoutMs) {
      if (sub.cancel_url) await falFetch(sub.cancel_url, { method: "PUT" }).catch(() => {});
      throw Object.assign(new Error("generation timed out"), { retryable: false });
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
}

export async function download(url, path) {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error("generated media URL is not https");
  const r = await fetch(u, { signal: AbortSignal.timeout(180_000) });
  if (!r.ok) throw new Error(`download failed ${r.status}`);
  const { createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  const { Readable } = await import("node:stream");
  await pipeline(Readable.fromWeb(r.body), createWriteStream(path));
  return path;
}
