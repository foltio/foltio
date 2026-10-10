// Worker pools: CPU work (ingest, render) and I/O work (generation, transcription).
import { hostname } from "node:os";
import { mkdirSync } from "node:fs";
import { claim, complete, fail, heartbeat } from "./queue.mjs";
import { ingestAsset, backfillFilmstrip } from "../media/ingest.mjs";
import { transcribeAsset } from "../media/transcribe.mjs";
import { renderProject } from "../render/render.mjs";
import { runGeneration } from "../gen/generate.mjs";
import { bakeFxProxy } from "../media/fxproxy.mjs";
import { config } from "../config.mjs";
import { q } from "../db.mjs";

const HANDLERS = { ingest: ingestAsset, transcribe: transcribeAsset, render: renderProject, generate: runGeneration, filmstrip: backfillFilmstrip, fxproxy: bakeFxProxy };
// Hard ceilings so a hung job fails (and retries) instead of holding a worker forever.
const LIMIT_MS = { ingest: 30 * 60_000, transcribe: 20 * 60_000, render: 60 * 60_000, generate: 30 * 60_000, filmstrip: 10 * 60_000, fxproxy: 20 * 60_000 };
const POOLS = [
  { kinds: ["ingest", "render", "filmstrip", "fxproxy"], size: Math.max(1, Math.min(4, config.workerConcurrency)) },
  { kinds: ["generate", "transcribe"], size: 8 },
];
let stopping = false;

async function runOne(workerId, kinds) {
  const job = await claim(workerId, kinds).catch((e) => (console.error("claim failed", e.message), null));
  if (!job) return false;
  let last = 0;
  const report = (p) => {
    const now = Date.now();
    if (now - last > 3000) {
      last = now;
      heartbeat(job, Math.max(0, Math.min(0.99, p))).catch(() => {});
    }
  };
  const beat = setInterval(() => heartbeat(job).catch(() => {}), 20_000);
  try {
    let limit;
    const out = await Promise.race([
      HANDLERS[job.kind](job, report),
      new Promise((_, rej) => (limit = setTimeout(() => rej(Object.assign(new Error(`${job.kind} exceeded ${LIMIT_MS[job.kind] / 60000} min`), { retryable: true })), LIMIT_MS[job.kind]))),
    ]).finally(() => clearTimeout(limit));
    await complete(job, out || {});
    console.log(`job ${job.id} ${job.kind} ok`);
  } catch (e) {
    console.error(`job ${job.id} ${job.kind} failed:`, e.message);
    await fail(job, { message: String(e.message).slice(0, 2000), retryable: !!e.retryable });
    if (job.kind === "ingest") await q("update studio.assets set status='failed', error=$2 where id=$1", [job.input.asset_id, String(e.message).slice(0, 500)]).catch(() => {});
  } finally {
    clearInterval(beat);
  }
  return true;
}

export function startWorkers() {
  if (!config.worker) return;
  mkdirSync(config.workDir, { recursive: true });
  POOLS.forEach((pool, pi) => {
    for (let k = 0; k < pool.size; k++) {
      const wid = `${hostname()}:${process.pid}:${pi}.${k}`;
      (async function loop() {
        while (!stopping) {
          const did = await runOne(wid, pool.kinds).catch(() => false);
          if (!did) await new Promise((r) => setTimeout(r, 1000 + Math.random() * 500));
        }
      })();
    }
  });
  console.log("workers started", POOLS.map((p) => `${p.kinds.join("/")}×${p.size}`).join(", "));
}
export const stopWorkers = () => (stopping = true);
