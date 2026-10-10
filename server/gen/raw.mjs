// Raw generation: any allowlisted fal endpoint, with its own input — every parameter the model has,
// the day it ships — priced and quoted like the curated library (catalog.mjs). A raw request is
// { model: "raw", endpoint, input }; project files go in the input by their asset id ("ast_…" as a
// whole value) and become signed URLs when it runs.
//
// Prices: video endpoints are priced per second from the model pages (raw-endpoints.json, vendored
// from the 2026-10-02 research: fal's pricing API reports base units, not per-second prices, for
// video); everything else from fal's pricing API (cached), by its unit. A price we can't work out is
// refused, never guessed.
import { readFileSync } from "node:fs";
import { config } from "../config.mjs";

const VIDEO = JSON.parse(readFileSync(new URL("./raw-endpoints.json", import.meta.url), "utf8")).video;
const VIDEO_BY_ID = Object.fromEntries(VIDEO.map((v) => [v.endpoint_id, v]));

// Beyond video: audio, image and utility endpoints worth reaching for (research 2026-10-02), plus
// whatever the curated library itself calls. kind is what the outputs are.
const EXTRA = {
  // separation, cleanup, transcription
  "fal-ai/demucs": { kind: "audio", does: "split audio into stems (vocals, drums, bass, other…); 6 stems with model htdemucs_6s" },
  "fal-ai/sam-audio/separate": { kind: "audio", does: "isolate a sound described in text (e.g. 'the woman's voice') from audio; returns target and residual", unit: { per: "30 seconds of input", usd: 0.05 } },
  "fal-ai/elevenlabs/audio-isolation": { kind: "audio", does: "clean dialogue: remove music and noise from speech" },
  "fal-ai/deepfilternet3": { kind: "audio", does: "speech denoising" },
  "fal-ai/elevenlabs/speech-to-text/scribe-v2": { kind: "text", does: "transcription with word timings and speaker labels (diarize)" },
  "fal-ai/elevenlabs/forced-alignment": { kind: "text", does: "align a known script to audio (word timings)", unit: { per: "call", usd: 0.22 } },
  // voices
  "elevenlabs/tts/eleven-v4": { kind: "audio", does: "text-to-speech (library voices)" },
  "fal-ai/elevenlabs/text-to-dialogue/eleven-v3": { kind: "audio", does: "a multi-speaker dialogue in one file" },
  "fal-ai/elevenlabs/voice-changer": { kind: "audio", does: "re-voice a performance with another voice (speech-to-speech)" },
  "fal-ai/minimax/speech-2.8-hd": { kind: "audio", does: "text-to-speech; takes a cloned or designed voice_id" },
  "fal-ai/minimax/speech-2.8-turbo": { kind: "audio", does: "faster, cheaper MiniMax text-to-speech" },
  "fal-ai/minimax/voice-clone": { kind: "audio", does: "clone a voice from a 10 s+ sample (returns a voice_id and a preview)", unit: { per: "call", usd: 1.5 } },
  "fal-ai/chatterbox/speech-to-speech": { kind: "audio", does: "convert a performance into a target voice from a reference clip" },
  // lip-sync (video + audio → the mouth redrawn)
  "fal-ai/latentsync": { kind: "video", does: "video-to-video lip-sync: a clip + an audio line" },
  "fal-ai/sync-lipsync/v2": { kind: "video", does: "video-to-video lip-sync (sync.so)" },
  "fal-ai/bytedance/omnihuman/v1.5": { kind: "video", does: "a talking or singing person from one image + audio, with body motion" },
  // music and sound
  "google/lyria-3.5": { kind: "audio", does: "music from a prompt" },
  "fal-ai/lyria3/pro": { kind: "audio", does: "music (Lyria 3 Pro)" },
  "elevenlabs/music/v2.5": { kind: "audio", does: "music with vocals and structure, up to minutes" },
  "fal-ai/minimax-music/v2.6": { kind: "audio", does: "a song with lyrics" },
  "fal-ai/stable-audio-3/medium/text-to-audio": { kind: "audio", does: "music or sound to an exact length" },
  "fal-ai/elevenlabs/sound-effects/v2": { kind: "audio", does: "sound effects from text" },
  "sonilo/v1.1/video-to-music": { kind: "audio", does: "music scored to a video" },
  // images
  "openai/gpt-image-2.5/flare/text-to-image": { kind: "image", does: "image (best text rendering and instruction following)" },
  "openai/gpt-image-2.5/flare/edit": { kind: "image", does: "edit images with instructions and references" },
  "fal-ai/nano-banana-2": { kind: "image", does: "fast image generation" },
  "fal-ai/nano-banana-2/edit": { kind: "image", does: "fast multi-reference image editing" },
  "ideogram/v4.5": { kind: "image", does: "image with strong typography" },
  "ideogram/v4.5/edit": { kind: "image", does: "Ideogram editing" },
  "recraft/v4.1/flash/text-to-image": { kind: "image", does: "illustration and design styles" },
  "fal-ai/flux/schnell": { kind: "image", does: "very cheap fast image sketches" },
  "fal-ai/bria/background/remove": { kind: "image", does: "cut out the subject (transparent PNG)" },
  "fal-ai/clarity-upscaler": { kind: "image", does: "image upscaling" },
  // video utilities without a per-second page price
  "bria/video/background-removal": { kind: "video", does: "remove a video's background" },
  "fal-ai/film/video": { kind: "video", does: "frame interpolation (smoother motion)" },
  "topaz/upscale/video/precision": { kind: "video", does: "video upscaling" },
};

export const RAW_KINDS = ["video", "image", "audio", "text"];

// Is this endpoint allowed, and what does it make?
export function rawEntry(endpoint) {
  const e = String(endpoint || "").trim();
  if (VIDEO_BY_ID[e]) return { endpoint: e, kind: "video", video: VIDEO_BY_ID[e], does: `${VIDEO_BY_ID[e].model} — ${VIDEO_BY_ID[e].mode}` };
  if (EXTRA[e]) return { endpoint: e, ...EXTRA[e] };
  return null;
}

// The allowlist, one line each, for gen_models.
export function rawList(kind) {
  const caps = (v) =>
    [
      v.mode,
      v.audio?.native ? "native sound" : null,
      v.audio?.dialogue_lipsync ? "speech with lip-sync" : null,
      v.refs_max ? `up to ${typeof v.refs_max === "object" ? JSON.stringify(v.refs_max) : v.refs_max} references` : null,
      /audio|voice/i.test(JSON.stringify(v.notable_params || "")) ? "accepts audio/voice references" : null,
    ]
      .filter(Boolean)
      .join(" · ");
  const vids = VIDEO.map((v) => ({ endpoint: v.endpoint_id, kind: "video", family: v.family, does: caps(v), price: priceLine(v) }));
  const rest = Object.entries(EXTRA).map(([endpoint, x]) => ({ endpoint, kind: x.kind, does: x.does }));
  return [...vids, ...rest].filter((x) => !kind || x.kind === kind);
}
const priceLine = (v) =>
  Object.entries(v.price_per_second || {})
    .map(([k, usd]) => `$${+(usd * config.markup).toFixed(3)}/s ${k}`)
    .join(", ");

// fal's pricing API, cached for a day.
const priceCache = new Map();
async function falUnitPrice(endpoint) {
  const hit = priceCache.get(endpoint);
  if (hit && hit.until > Date.now()) return hit.price;
  const r = await fetch(`https://api.fal.ai/v1/models/pricing?endpoint_id=${encodeURIComponent(endpoint)}`, {
    headers: { Authorization: `Key ${config.falKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`fal pricing ${r.status}`);
  const price = (await r.json()).prices?.find((p) => p.endpoint_id === endpoint) || null;
  priceCache.set(endpoint, { price, until: Date.now() + 86_400_000 });
  return price;
}

// Every project file named in an input: values that are exactly an asset id.
export function assetIdsIn(input) {
  const out = new Set();
  const walk = (v) => {
    if (typeof v === "string" && /^ast_[a-z0-9]{6,}$/.test(v)) out.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(input);
  return [...out];
}
// The same input with each asset id replaced by its URL.
export function substitute(input, urls) {
  const walk = (v) => (typeof v === "string" && urls[v] ? urls[v] : Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  return walk(input);
}

const secondsOf = (v) => {
  if (typeof v === "number") return v;
  const m = String(v ?? "").match(/^(\d+(?:\.\d+)?)\s*s?$/);
  return m ? Number(m[1]) : null;
};
const pick = (o, keys) => keys.map((k) => o?.[k]).find((x) => x !== undefined && x !== null);

// fal's list price for one run of this input (before our markup), with how it was worked out.
// media: { [asset_id]: { kind, seconds } } for the files the input names.
export async function rawPrice(entry, input = {}, media = {}) {
  const r = await priceRaw(entry, input, media);
  return { ...r, usd: +r.usd.toFixed(4) };
}
async function priceRaw(entry, input = {}, media = {}) {
  const mediaSeconds = Math.max(0, ...Object.values(media).filter((m) => m.kind === "audio" || m.kind === "video").map((m) => m.seconds || 0));
  const count = Math.max(1, Number(pick(input, ["num_images", "num_outputs", "n", "num_videos", "number_of_images"])) || 1);
  if (entry.video) {
    const v = entry.video;
    const table = v.price_per_second || {};
    const res = String(pick(input, ["resolution", "video_resolution", "quality"]) || "").toLowerCase();
    const rows = Object.entries(table).filter(([k]) => !res || k === res || k.startsWith(res) || k === "any");
    const prices = (rows.length ? rows : Object.entries(table)).map(([, usd]) => Number(usd)).filter((x) => x > 0);
    if (!prices.length) throw new Error(`no per-second price on record for ${entry.endpoint}`);
    const usdPerS = Math.max(...prices); // the dearest matching tier: never under-quote
    const d = v.durations;
    let seconds = d?.field ? secondsOf(input[d.field]) : null;
    if (seconds == null && d) {
      const vals = (d.values || []).map(secondsOf).filter((x) => x != null);
      seconds = secondsOf(d.default) ?? (vals.length ? Math.max(...vals) : d.max ?? null);
    }
    if (seconds == null) seconds = mediaSeconds || null; // edits, extends, upscales: the length of the source
    if (!seconds) throw new Error(`can't tell how long ${entry.endpoint}'s output will be: pass its duration`);
    return { usd: usdPerS * seconds * count, basis: `$${usdPerS}/s${res ? ` at ${res}` : rows.length ? "" : " (dearest tier)"} × ${seconds} s${count > 1 ? ` × ${count}` : ""}` };
  }
  const own = entry.unit;
  if (own?.per === "call") return { usd: own.usd * count, basis: `$${own.usd} per call` };
  if (own?.per === "30 seconds of input") {
    if (!mediaSeconds) throw new Error(`${entry.endpoint} is priced by the length of its input audio: name the file by its asset id`);
    return { usd: own.usd * Math.ceil(mediaSeconds / 30), basis: `$${own.usd} per 30 s × ${Math.ceil(mediaSeconds / 30)}` };
  }
  const p = await falUnitPrice(entry.endpoint);
  if (!p) throw new Error(`fal publishes no price for ${entry.endpoint}`);
  const u = String(p.unit).toLowerCase();
  const text = String(pick(input, ["text", "prompt", "input", "script"]) || "");
  const asked = secondsOf(pick(input, ["duration", "seconds", "duration_seconds", "length", "music_length_ms"]));
  const span = asked ?? mediaSeconds;
  const per = (n) => ({ usd: p.unit_price * n, basis: `$${p.unit_price} per ${p.unit} × ${+n.toFixed(3)}` });
  if (u === "1000 characters") {
    if (!text) throw new Error(`${entry.endpoint} is priced per 1,000 characters: pass the text`);
    return per(text.length / 1000);
  }
  if (u === "seconds" || u === "input seconds" || u === "compute seconds") {
    if (!span) throw new Error(`${entry.endpoint} is priced per second: pass duration, or the input file by its asset id`);
    return per(span * count);
  }
  if (u === "minutes") {
    if (!span) throw new Error(`${entry.endpoint} is priced per minute of audio: name the input file by its asset id`);
    return per((span / 60) * count);
  }
  const block = u.match(/^(\d+) seconds$/);
  if (block) {
    if (!span) throw new Error(`${entry.endpoint} is priced per ${p.unit}: pass duration`);
    return per(Math.ceil(span / Number(block[1])) * count);
  }
  if (["images", "audios", "videos", "generations", "requests"].includes(u)) return per(count);
  if (u === "megapixels") {
    const sz = input.image_size;
    const w = Number(sz?.width) || (/square_hd|1024/.test(String(sz)) ? 1024 : null);
    const h = Number(sz?.height) || (/square_hd|1024/.test(String(sz)) ? 1024 : null);
    if (!w || !h) throw new Error(`${entry.endpoint} is priced per megapixel: pass image_size {width, height}`);
    return per(((w * h) / 1e6) * count);
  }
  throw new Error(`${entry.endpoint} is billed per "${p.unit}", which Studio can't price ahead — use a curated model or another endpoint`);
}

// The endpoint's input schema and docs, from fal's model API (cached a day).
const docsCache = new Map();
export async function rawDocs(endpoint) {
  const hit = docsCache.get(endpoint);
  if (hit && hit.until > Date.now()) return hit.docs;
  const r = await fetch(`https://api.fal.ai/v1/models?endpoint_id=${encodeURIComponent(endpoint)}&expand=openapi-3.0`, {
    headers: { Authorization: `Key ${config.falKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`fal model API ${r.status}`);
  const m = (await r.json()).models?.[0];
  if (!m) throw new Error(`fal doesn't list ${endpoint}`);
  const schemas = m.openapi?.components?.schemas || {};
  const inputName = Object.keys(schemas).find((k) => /Input$/.test(k) && !/Queue|Status/.test(k));
  const outputName = Object.keys(schemas).find((k) => /Output$/.test(k));
  const slim = (s) =>
    s && {
      required: s.required || [],
      properties: Object.fromEntries(
        Object.entries(s.properties || {}).map(([k, p]) => [
          k,
          Object.fromEntries(Object.entries({ type: p.type || (p.anyOf ? p.anyOf.map((x) => x.type || x.$ref?.split("/").pop()).join("|") : p.$ref?.split("/").pop()), description: p.description, default: p.default, enum: p.enum, minimum: p.minimum, maximum: p.maximum, examples: p.examples?.slice?.(0, 1) }).filter(([, v]) => v !== undefined)),
        ]),
      ),
    };
  const docs = {
    endpoint,
    name: m.metadata?.display_name,
    category: m.metadata?.category,
    description: m.metadata?.description,
    input: slim(schemas[inputName]),
    output: slim(schemas[outputName]),
    page: `https://fal.ai/models/${endpoint}`,
  };
  docsCache.set(endpoint, { docs, until: Date.now() + 86_400_000 });
  return docs;
}

// Files in a raw result: every { url } in it, with what it is and where it was (vocals, target…).
export function rawOutputs(res) {
  const out = [];
  const walk = (v, path) => {
    if (out.length >= 8 || !v || typeof v !== "object") return;
    if (typeof v.url === "string" && /^https?:/.test(v.url)) {
      out.push({ url: v.url, contentType: v.content_type || "", name: path.filter((p) => !/^\d+$/.test(p)).pop() || "output" });
      return;
    }
    for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
  };
  walk(res, []);
  return out;
}
export function kindOfFile(contentType, url) {
  const t = String(contentType || "");
  const e = (String(url).split("?")[0].split(".").pop() || "").toLowerCase();
  if (t.startsWith("video/") || ["mp4", "mov", "webm"].includes(e)) return "video";
  if (t.startsWith("image/") || ["png", "jpg", "jpeg", "webp"].includes(e)) return "image";
  if (t.startsWith("audio/") || ["mp3", "wav", "m4a", "flac", "ogg"].includes(e)) return "audio";
  return null;
}
