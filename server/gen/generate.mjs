// Generation job: map a quote's canonical request onto the fal endpoint, run it, store the
// output as a new asset (a "take") with provenance, ingest it, and settle the ledger.
import { wordsFromAlignment } from "../media/transcribe.mjs";
import { join, extname } from "node:path";
import { q, one } from "../db.mjs";
import { id } from "../ids.mjs";
import { presignGet, putFile, keys } from "../storage.mjs";
import { scratch, ffmpeg } from "../media/ff.mjs";
import { submit, waitResult, download } from "./fal.mjs";
import { MODELS, resolveModel, priceOf } from "./catalog.mjs";
import { releaseHold, recordCharge } from "./billing.mjs";
import { enqueue } from "../jobs/queue.mjs";
import { filedEvent } from "../board.mjs";
import { rawOutputs, kindOfFile } from "./raw.mjs";

// Reference assets → signed URLs. Clips used as the subject of an edit/extend/upscale go in at
// full quality (the original); clips used as an image reference send their poster. A reference made
// moments ago (a storyboard sheet this video waited for) may still be ingesting: give it a minute.
async function refUrls(projectId, refs = []) {
  const out = [];
  for (const r of refs) {
    if (String(r.asset_id).startsWith("pending:")) throw new Error("the storyboard sheet this video waits for never arrived");
    let a = await one("select * from studio.assets where id=$1 and project_id=$2", [r.asset_id, projectId]);
    for (let k = 0; a && a.status === "processing" && k < 60; k++) {
      await new Promise((res) => setTimeout(res, 1000));
      a = await one("select * from studio.assets where id=$1 and project_id=$2", [r.asset_id, projectId]);
    }
    if (!a) throw new Error(`reference asset ${r.asset_id} not found`);
    if (a.status !== "ready") throw new Error(`reference asset ${r.asset_id} is not ready`);
    // raw requests get the file itself, whatever it is (the endpoint's schema says what it wants)
    const key = a.kind === "video" && r.role !== "source_video" && r.role !== "raw" ? a.derived?.poster || a.storage_key : a.storage_key;
    out.push({ ...r, url: await presignGet(key, 6 * 3600), kind: a.kind, seconds: a.probe?.duration, width: a.probe?.video?.width, height: a.probe?.video?.height });
  }
  return out;
}

export function buildInput(m, req, refs) {
  return m.build({ ...req, params: req.params || {} }, refs);
}

// What a model's refusal on content grounds looks like (OpenAI's moderation, fal's content checker, …).
const REFUSED = /moderation|safety|content.?polic|blocked|refus|flagged|content checker/i;

// A storyboard video prepared before its sheet existed names the sheet's quote ("pending:qt_…").
// When that sheet lands, it takes the placeholder's place and the waiting jobs start.
export async function fillPending(quoteId, depQuoteId, assetId) {
  const row = await one("select request from studio.quotes where id=$1", [quoteId]);
  if (!row) return;
  const req = row.request;
  req.references = (req.references || []).map((r) => (r.asset_id === `pending:${depQuoteId}` ? { ...r, asset_id: assetId } : r));
  delete req.after;
  await q("update studio.quotes set request=$2 where id=$1", [quoteId, req]);
}
export async function resumeWaiting(depQuoteId, assets) {
  const waiting = await q("select id, input from studio.jobs where status='waiting' and input->>'after_quote' = $1", [depQuoteId]);
  for (const j of waiting) {
    await fillPending(j.input.quote_id, depQuoteId, assets[0]);
    await q("update studio.jobs set status='queued', updated_at=now() where id=$1 and status='waiting'", [j.id]);
  }
}
async function failWaiting(depQuoteId, reason) {
  const waiting = await q("select id, account_id, input from studio.jobs where status='waiting' and input->>'after_quote' = $1", [depQuoteId]);
  for (const j of waiting) {
    const qt = await one("select id, cost_usd from studio.quotes where id=$1", [j.input.quote_id]);
    await q("update studio.jobs set status='failed', error=$2, updated_at=now() where id=$1 and status='waiting'", [j.id, { message: reason }]);
    if (qt) await releaseHold(j.account_id, qt.id, Number(qt.cost_usd) / (j.input.takes || 1), j.id, "refund: the storyboard sheet it waited for failed");
  }
}

// What a generation was made for on the board (older quotes name a shot).
export const targetOf = (req) => req.for || (req.shot ? { storyboard: req.shot } : null);
const isVideoTarget = (t) => t?.storyboard && t.make !== "sheet";

function outputUrls(res) {
  if (res.video?.url) return [res.video.url];
  if (res.images?.length) return res.images.map((i) => i.url);
  if (res.audio?.url) return [res.audio.url];
  if (res.audio_file?.url) return [res.audio_file.url];
  return [];
}

export async function runGeneration(job, report) {
  const qt = await one("select * from studio.quotes where id=$1", [job.input.quote_id]);
  const resolved = resolveModel(qt.request.model, qt.request.params || {}); // quotes made before the library change
  const req = { ...qt.request, model: resolved.id, params: resolved.params };
  let m = MODELS[req.model];
  const refs = await refUrls(job.project_id, req.references);
  // lip-sync needs ≥5 s of audio; short lines get silence padded on (the face holds still after the line)
  if (req.model === "video/talk") {
    const v = refs.find((r) => r.role === "voice");
    if (v && (v.seconds ?? 0) < 5) {
      const key = keys.derived(qt.account_id, job.project_id, "tmp", `${job.id}-voice.mp3`);
      await scratch(async (dir) => {
        const out = join(dir, "voice.mp3");
        await ffmpeg(["-y", "-i", v.url, "-af", "apad=whole_dur=5.2", "-c:a", "libmp3lame", "-q:a", "2", out]);
        await putFile(key, out, "audio/mpeg");
      });
      v.url = await presignGet(key, 6 * 3600);
      v.seconds = 5.2;
    }
  }
  const withSeed = (r) => ({ ...r, params: { ...(r.params || {}), ...(job.input.seed !== undefined && m.params.seed ? { seed: job.input.seed } : {}) } });
  let { endpoint, input, ext } = buildInput(m, withSeed(req), refs);
  let fallbackFrom = null;
  try {
    let res;
    const attempt = async (inp) => {
      const sub = await submit(endpoint, inp);
      await q("update studio.jobs set output = coalesce(output,'{}'::jsonb) || $2::jsonb where id=$1", [job.id, JSON.stringify({ provider: { endpoint, request_id: sub.request_id } })]);
      report(0.2);
      return waitResult(sub, { onTick: (st) => report(st.status === "IN_PROGRESS" ? 0.5 : 0.25) });
    };
    try {
      try {
        res = await attempt(input);
      } catch (e) {
        // H3's prompt rewriter sometimes gives up on a prompt it could send as written: send it as written
        if (!/prompt expansion could not/i.test(e.message) || !("prompt_expansion_mode" in input || "enable_prompt_expansion" in input)) throw e;
        input = "prompt_expansion_mode" in input ? { ...input, prompt_expansion_mode: "disabled" } : { ...input, enable_prompt_expansion: false };
        res = await attempt(input);
      }
    } catch (e) {
      // a provider's moderation refusal on a model with a fallback: run the fallback instead of failing
      if (!m.fallback || !REFUSED.test(e.message)) throw e;
      fallbackFrom = { model: req.model, reason: String(e.message).slice(0, 200) };
      const fb = MODELS[m.fallback];
      const fbReq = { ...req, model: m.fallback, params: { aspect: ["9:16", "16:9", "1:1", "4:5", "3:4", "4:3", "21:9"].includes(req.params.aspect) ? req.params.aspect : "9:16", resolution: req.params.size === "4K" ? "4K" : req.params.size === "1K" ? "1K" : "2K", n: req.params.n || 1 } };
      ({ endpoint, input, ext } = buildInput(fb, fbReq, refs));
      m = fb;
      const extra = +(priceOf(fb, fbReq) / (job.input.takes || 1) - Number(qt.cost_usd) / (job.input.takes || 1)).toFixed(4);
      if (extra > 0) await recordCharge(qt.account_id, extra, job.id, "fallback to image/fast");
      res = await waitResult(await submit(endpoint, input), { onTick: (st) => report(st.status === "IN_PROGRESS" ? 0.6 : 0.4) });
    }
    const raw = req.model === "raw";
    const files = raw ? rawOutputs(res).map((f) => ({ ...f, kind: kindOfFile(f.contentType, f.url) })).filter((f) => f.kind) : outputUrls(res).map((url) => ({ url, kind: m.kind, name: null }));
    const urls = files.map((f) => f.url);
    // a raw endpoint that answers in data (a transcript, a voice id…) returns it instead of files
    if (raw && !urls.length) {
      const text = JSON.stringify(res);
      return { result: text.length <= 20000 ? res : { truncated: true, text: text.slice(0, 20000) }, model: "raw", endpoint, cost_usd: Number(qt.cost_usd) / (job.input.takes || 1) };
    }
    if (!urls.length) throw new Error("the model returned no media");
    const created = [];
    await scratch(async (dir) => {
      for (const [k, url] of urls.entries()) {
        const aid = id("ast");
        const e = (extname(new URL(url).pathname).slice(1) || (raw ? { video: "mp4", image: "png", audio: "mp3" }[files[k].kind] : ext)).toLowerCase();
        const file = join(dir, `out${k}.${e}`);
        await download(url, file);
        const storage = keys.original(qt.account_id, job.project_id, aid, e);
        const kind = files[k].kind;
        const mime = kind === "video" ? "video/mp4" : kind === "image" ? (e === "jpg" || e === "jpeg" ? "image/jpeg" : e === "webp" ? "image/webp" : "image/png") : e === "wav" ? "audio/wav" : "audio/mpeg";
        const { bytes } = await putFile(storage, file, mime);
        const name = raw
          ? `${req.label || req.endpoint.split("/").slice(-2).join(" ")}${files[k].name && files[k].name !== "output" ? ` · ${files[k].name}` : ""} · take ${job.input.take ?? 1}`
          : `${req.label || req.model.split("/")[1]} · take ${job.input.take ?? 1}${urls.length > 1 ? `.${k + 1}` : ""}`;
        await q(
          `insert into studio.assets(id, project_id, account_id, kind, roles, name, mime, bytes, status, origin, storage_key)
           values ($1,$2,$3,$4,$5,$6,$7,$8,'processing',$9,$10)`,
          [aid, job.project_id, qt.account_id, kind, ["generated", ...(req.roles || [])], name.slice(0, 160), mime, bytes,
            { kind: "generation", model: fallbackFrom ? m.fallback || "image/fast" : req.model, endpoint, prompt: req.prompt || req.text, ...(raw ? { input: req.input } : {}), params: req.params, references: req.references, seed: res.seed ?? input.seed ?? null, quote: qt.id, job: job.id, take: job.input.take ?? 1, for: targetOf(req), expandedPrompt: res.expanded_prompt || null, ttsTimestamps: res.timestamps ? true : undefined, ...(fallbackFrom ? { fallbackFrom } : {}) },
            storage],
        );
        // voice-over: keep the script's own word timings (exact spelling) instead of re-transcribing
        const ttsWords = req.model === "voice" && res.timestamps ? wordsFromAlignment(res.timestamps) : null;
        await enqueue({ kind: "ingest", account_id: qt.account_id, project_id: job.project_id, input: { asset_id: aid, transcribe: (req.model === "voice" && !ttsWords?.length) || kind === "video", ...(ttsWords?.length ? { words: ttsWords, language: req.params?.language || "en" } : {}) } });
        created.push(aid);
      }
    });
    // a generation made for the board files its outputs there (a card's bible, a storyboard's sheet or takes)
    const target = targetOf(req);
    if (target) await filedEvent(job.project_id, target, { status: isVideoTarget(target) ? "ready" : undefined, assets: created, note: null, fp: req.fp }).catch(() => {});
    await resumeWaiting(qt.id, created).catch((e) => console.error("resume waiting jobs", e.message));
    return { assets: created, model: req.model, cost_usd: Number(qt.cost_usd) / (job.input.takes || 1), ...(target ? { for: target } : {}), ...(target?.storyboard ? { storyboard: String(target.storyboard) } : {}), ...(fallbackFrom ? { fallback: `OpenAI refused the image (${fallbackFrom.reason.slice(0, 80)}); made with image/fast instead` } : {}) };
  } catch (e) {
    // a content filter's refusal, said plainly, with what to do about it
    if (REFUSED.test(e.message || "")) e.message = `Refused by the model's content filter (refunded): it read the request as sexual, nude or violent. Reword it — carry sensuality or danger through light, framing, gesture and looks, and describe outfits as complete clothing (no bare skin, lingerie, lace or undressing). [${String(e.message).slice(0, 120)}]`;
    await releaseHold(qt.account_id, qt.id, Number(qt.cost_usd) / (job.input.takes || 1), job.id, `refund: ${String(e.message).slice(0, 120)}`);
    const target = targetOf(req);
    if (target?.storyboard) await filedEvent(job.project_id, target, { status: isVideoTarget(target) ? "failed" : undefined, note: `Generation failed (refunded): ${String(e.message).slice(0, 160)}` }).catch(() => {});
    await failWaiting(qt.id, `The storyboard sheet failed: ${String(e.message).slice(0, 160)}`).catch(() => {});
    throw e;
  }
}
