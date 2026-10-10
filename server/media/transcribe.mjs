// Word-level transcripts via fal (ElevenLabs Scribe v2, $0.008/min). Audio is extracted to a
// small mono file in R2 first; fal fetches it through a short-lived signed URL.
import { join } from "node:path";
import { q, one } from "../db.mjs";
import { getToFile, putFile, putBuffer, presignGet, keys } from "../storage.mjs";
import { ffmpeg, scratch } from "./ff.mjs";
import { submit, waitResult } from "../gen/fal.mjs";
import { STT } from "../gen/catalog.mjs";
import { recordCharge } from "../gen/billing.mjs";

export async function transcribeAsset(job, report) {
  const asset = await one("select * from studio.assets where id=$1", [job.input.asset_id]);
  if (!asset?.probe?.audio) return { skipped: "no audio" };
  const acct = asset.account_id,
    prj = asset.project_id;
  const audioKey = keys.derived(acct, prj, asset.id, "speech.m4a");
  await scratch(async (dir) => {
    const src = join(dir, "src");
    await getToFile(asset.derived?.proxy || asset.storage_key, src);
    const out = join(dir, "speech.m4a");
    await ffmpeg(["-y", "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "48k", out]);
    await putFile(audioKey, out, "audio/mp4");
  });
  report(0.3);
  const url = await presignGet(audioKey, 3 * 3600);
  const sub = await submit(STT.endpoint, { audio_url: url, diarize: true, tag_audio_events: true, ...(job.input.language ? { language_code: job.input.language } : {}) });
  const res = await waitResult(sub, { timeoutMs: 30 * 60_000, onTick: () => report(0.6) });
  const words = (res.words || [])
    .filter((w) => w.type === "word" || w.type === "audio_event")
    .map((w, i) => ({ id: `w${i}`, w: w.text.trim(), s: +w.start.toFixed(3), e: +w.end.toFixed(3), speaker: w.speaker_id, ...(w.type === "audio_event" ? { event: true } : {}) }))
    .filter((w) => w.w);
  const transcript = { model: STT.endpoint, language: res.language_code, text: res.text, words };
  const key = keys.derived(acct, prj, asset.id, "transcript.json");
  await putBuffer(key, Buffer.from(JSON.stringify(transcript)), "application/json");
  await q("update studio.assets set derived = derived || $2::jsonb, updated_at=now() where id=$1", [
    asset.id,
    JSON.stringify({ transcript: key, transcriptWords: words.filter((w) => !w.event).length, language: res.language_code }),
  ]);
  const cost = +(((asset.probe.duration || 0) / 60) * STT.perMinute).toFixed(4);
  if (cost > 0) await recordCharge(acct, cost, job.id, "transcription");
  return { asset_id: asset.id, words: words.length, language: res.language_code, cost_usd: cost };
}

// Text-to-speech comes with exact character timings for the script; turn them into words so
// voice-over captions spell the script (brand names included) without a speech-recognition pass.
export function wordsFromAlignment(chunks) {
  const chars = [];
  for (const c of chunks || []) for (let i = 0; i < (c.characters || []).length; i++) chars.push([c.characters[i], c.character_start_times_seconds[i], c.character_end_times_seconds[i]]);
  const words = [];
  let cur = null;
  for (const [ch, s, e] of chars) {
    if (/\s/.test(ch)) {
      if (cur) words.push(cur);
      cur = null;
      continue;
    }
    if (!cur) cur = { w: "", s, e };
    cur.w += ch;
    if (/[\p{L}\p{N}'’]/u.test(ch)) cur.e = e; // end on the last letter, not on the pause after a full stop
  }
  if (cur) words.push(cur);
  return words.map((w, i) => ({ id: `w${i}`, w: w.w, s: +w.s.toFixed(3), e: +Math.max(w.e, w.s + 0.02).toFixed(3), speaker: "speaker_0" }));
}

export async function saveTranscript(asset, words, { model, language, text } = {}) {
  const key = keys.derived(asset.account_id, asset.project_id, asset.id, "transcript.json");
  await putBuffer(key, Buffer.from(JSON.stringify({ model, language, text: text ?? words.map((w) => w.w).join(" "), words })), "application/json");
  await q("update studio.assets set derived = derived || $2::jsonb, updated_at=now() where id=$1", [asset.id, JSON.stringify({ transcript: key, transcriptWords: words.filter((w) => !w.event).length, language })]);
  return key;
}

// Packed transcript view for agents: phrase lines split at ≥0.5 s pauses or speaker changes.
export function packTranscript(t, { from = 0, to = Infinity } = {}) {
  const lines = [];
  let cur = null;
  for (const w of t.words || []) {
    if (w.e < from || w.s > to) continue;
    if (!cur || w.s - cur.e >= 0.5 || w.speaker !== cur.speaker || cur.words.length >= 18) {
      if (cur) lines.push(cur);
      cur = { s: w.s, e: w.e, speaker: w.speaker, words: [] };
    }
    cur.words.push(w.event ? `(${w.w})` : w.w);
    cur.e = w.e;
  }
  if (cur) lines.push(cur);
  return lines.map((l) => `[${l.s.toFixed(2)}-${l.e.toFixed(2)}]${l.speaker ? " " + l.speaker.replace("speaker_", "S") : ""} ${l.words.join(" ")}`).join("\n");
}
