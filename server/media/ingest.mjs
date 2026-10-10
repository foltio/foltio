// Ingest: probe, proxy, poster, contact sheet, waveform, loudness, silences, shots.
// Everything derived goes to R2 next to the original and is cached by content hash.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { q, one } from "../db.mjs";
import { getToFile, putFile, putBuffer, keys } from "../storage.mjs";
import { ffprobe, ffmpeg, scratch, summarizeProbe } from "./ff.mjs";
import { enqueue } from "../jobs/queue.mjs";
import { saveTranscript } from "./transcribe.mjs";

const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}
const tcLabel = (s) => {
  const m = Math.floor(s / 60);
  return `${m}\\:${(s % 60).toFixed(1).padStart(4, "0")}`;
};

// Timeline thumbnails: one frame every `step` seconds, tiled into a single strip image.
export async function makeFilmstrip(src, duration, dir, put) {
  const step = Math.max(1, Math.ceil(duration / 150));
  const out = join(dir, "filmstrip.jpg");
  const n = Math.max(1, Math.ceil(duration / step));
  await ffmpeg(["-y", "-i", src, "-vf", `fps=1/${step},scale=-2:64,tile=${n}x1`, "-frames:v", "1", "-q:v", "6", out]).catch(() => null);
  try {
    return { filmstrip: await put(out, "filmstrip.jpg", "image/jpeg"), filmstripStep: step };
  } catch {
    return {};
  }
}

// Waveform image for the timeline: square-root scale so quiet speech still reads, ~40 px per second.
export async function makeWaveform(src, duration, dir, put) {
  const out = join(dir, "wave.png");
  const w = Math.max(600, Math.min(8000, Math.round(duration * 40)));
  await ffmpeg(["-y", "-i", src, "-filter_complex", `aformat=channel_layouts=mono,showwavespic=s=${w}x120:colors=0x6ee7b7:scale=sqrt`, "-frames:v", "1", out]).catch(() => null);
  return put(out, "waveform.png", "image/png").catch(() => null);
}

// Timeline thumbnails/waveforms for assets ingested before they existed (job kind "filmstrip").
export async function backfillFilmstrip(job) {
  const asset = await one("select * from studio.assets where id = $1", [job.input.asset_id]);
  if (!asset || asset.status !== "ready" || !["video", "audio"].includes(asset.kind)) return { skipped: true };
  return scratch(async (dir) => {
    const src = join(dir, "src");
    await getToFile(asset.derived?.proxy || asset.storage_key, src);
    const put = async (file, name, mime) => (await putFile(keys.derived(asset.account_id, asset.project_id, asset.id, name), file, mime)).key;
    const out = {};
    if (asset.kind === "video" && !asset.derived?.filmstrip) Object.assign(out, await makeFilmstrip(src, asset.probe?.duration || 1, dir, put));
    if (asset.probe?.audio) {
      const wf = await makeWaveform(src, asset.probe?.duration || 1, dir, put);
      if (wf) out.waveform = wf;
    }
    await q("update studio.assets set derived = derived || $2::jsonb where id=$1", [asset.id, JSON.stringify(out)]);
    return out;
  });
}

export function kindFromProbe(p, mime = "") {
  if (p.video?.still || mime.startsWith("image/")) return "image";
  if (p.video) return "video";
  if (p.audio) return "audio";
  return "other";
}

export async function ingestAsset(job, report) {
  const asset = await one("select * from studio.assets where id = $1", [job.input.asset_id]);
  if (!asset) throw new Error("asset vanished");
  const acct = asset.account_id,
    prj = asset.project_id;
  return scratch(async (dir) => {
    const src = join(dir, "original");
    await getToFile(asset.storage_key, src);
    report(0.1);
    const raw = await ffprobe(src);
    const probe = summarizeProbe(raw);
    const kind = kindFromProbe(probe, asset.mime || "");
    const sha = await sha256File(src);
    const derived = {};
    const put = async (file, name, mime) => (await putFile(keys.derived(acct, prj, asset.id, name), file, mime)).key;

    if (kind === "video") {
      const v = probe.video;
      const fps = Math.min(60, Math.max(12, Math.round(v.fps || 30)));
      // proxy: ≤1280 on the long side, CFR, 0.5 s GOP, SDR — fast seeking for drafts and previews
      const scale = v.width >= v.height ? "scale='min(1280,iw)':-2" : "scale=-2:'min(1280,ih)'";
      const tonemap = v.hdr ? "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv," : "";
      const proxy = join(dir, "proxy.mp4");
      await ffmpeg(["-y", "-i", src, "-map", "0:v:0", "-map", "0:a:0?", "-vf", `${tonemap}${scale},fps=${fps},format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-g", String(Math.round(fps / 2)), "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000", "-movflags", "+faststart", proxy], {
        onProgress: (t) => report(0.1 + 0.5 * Math.min(1, t / Math.max(1, probe.duration))),
      });
      derived.proxy = await put(proxy, "proxy.mp4", "video/mp4");
      // mezzanine only when the original is awkward for frame-accurate editing (HDR / VFR / rotated)
      if (v.hdr || v.vfr || v.rotation) {
        const mez = join(dir, "mezz.mp4");
        await ffmpeg(["-y", "-i", src, "-map", "0:v:0", "-map", "0:a:0?", "-vf", `${tonemap}scale='min(1920,iw)':-2,fps=${fps},format=yuv420p`, "-c:v", "libx264", "-preset", "fast", "-crf", "17", "-g", String(fps), "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000", "-movflags", "+faststart", mez]);
        derived.mezzanine = await put(mez, "mezzanine.mp4", "video/mp4");
      }
      report(0.7);
      const poster = join(dir, "poster.jpg");
      await ffmpeg(["-y", "-ss", String(Math.min(probe.duration * 0.1, 3)), "-i", proxy, "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "4", poster]);
      derived.poster = await put(poster, "poster.jpg", "image/jpeg");
      // labelled contact sheet: 12 cells, timecode on each
      const n = 12;
      const step = probe.duration / n;
      const cells = [];
      for (let i = 0; i < n; i++) {
        const t = +(step * (i + 0.5)).toFixed(2);
        const out = join(dir, `c${String(i).padStart(2, "0")}.jpg`);
        await ffmpeg(["-y", "-ss", String(t), "-i", proxy, "-frames:v", "1", "-vf", `scale=320:320:force_original_aspect_ratio=decrease,pad=320:320:(ow-iw)/2:(oh-ih)/2:color=black,drawtext=fontfile=${FONT}:text='${tcLabel(t)}':x=6:y=6:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.6`, "-q:v", "5", out]).catch(() => null);
        cells.push({ t, out });
      }
      const sheet = join(dir, "sheet.jpg");
      await ffmpeg(["-y", "-framerate", "1", "-pattern_type", "glob", "-i", join(dir, "c*.jpg"), "-vf", "tile=4x3:padding=4:color=0x111111", "-frames:v", "1", "-q:v", "5", sheet]);
      derived.sheet = await put(sheet, "sheet.jpg", "image/jpeg");
      derived.sheetTimes = cells.map((c) => c.t);
      Object.assign(derived, await makeFilmstrip(proxy, probe.duration, dir, put));
      // shots
      const sc = await ffmpeg(["-i", proxy, "-vf", "scale=320:-2,select='gt(scene,0.32)',showinfo", "-an", "-f", "null", "-"]).catch(() => "");
      derived.shots = [...sc.matchAll(/pts_time:(\d+(?:\.\d+)?)/g)].map((m) => +Number(m[1]).toFixed(3));
    }
    if (kind === "image") {
      const poster = join(dir, "poster.jpg");
      await ffmpeg(["-y", "-i", src, "-frames:v", "1", "-vf", "scale='min(1080,iw)':-2", "-q:v", "3", poster]);
      derived.poster = await put(poster, "poster.jpg", "image/jpeg");
      derived.sheet = derived.poster;
    }
    if (probe.audio) {
      derived.waveform = await makeWaveform(src, probe.duration || 1, dir, put);
      // loudness + silences in one pass
      const an = await ffmpeg(["-i", src, "-vn", "-af", "silencedetect=noise=-35dB:d=0.35,ebur128=peak=true", "-f", "null", "-"], { timeoutMs: 20 * 60_000 });
      const sil = [];
      let st = null;
      for (const line of an.split("\n")) {
        let m;
        if ((m = line.match(/silence_start: (-?\d+(?:\.\d+)?)/))) st = Math.max(0, Number(m[1]));
        if ((m = line.match(/silence_end: (\d+(?:\.\d+)?)/)) && st !== null) {
          sil.push([+st.toFixed(3), +Number(m[1]).toFixed(3)]);
          st = null;
        }
      }
      if (st !== null) sil.push([+st.toFixed(3), probe.duration]);
      const I = an.match(/Integrated loudness:\s+I:\s+(-?\d+(?:\.\d+)?) LUFS/);
      const LRA = an.match(/LRA:\s+(\d+(?:\.\d+)?) LU/);
      const TP = an.match(/True peak:\s+Peak:\s+(-?\d+(?:\.\d+)?) dBFS/);
      derived.loudness = { integratedLufs: I ? Number(I[1]) : null, lra: LRA ? Number(LRA[1]) : null, truePeakDb: TP ? Number(TP[1]) : null };
      derived.silences = sil;
      derived.speechRatio = probe.duration ? +(1 - sil.reduce((s, [a, b]) => s + (b - a), 0) / probe.duration).toFixed(3) : 0;
    }
    report(0.95);
    const analysis = { probe, derived, sha256: sha };
    await putBuffer(keys.derived(acct, prj, asset.id, "analysis.json"), Buffer.from(JSON.stringify(analysis)), "application/json");
    await q(
      `update studio.assets set kind=$2, probe=$3, derived=$4, sha256=$5, status='ready', bytes=coalesce(bytes,$6), updated_at=now() where id=$1`,
      [asset.id, kind, probe, derived, sha, probe.bytes],
    );
    // auto-transcribe anything with speech-like audio (cheap; counts against the monthly cap)
    let transcribeJob = null;
    if (job.input.words?.length) await saveTranscript({ ...asset }, job.input.words, { model: "tts-alignment", language: job.input.language });
    else if (probe.audio && (derived.speechRatio ?? 0) > 0.15 && !asset.roles?.includes("music") && job.input.transcribe !== false)
      transcribeJob = await enqueue({ kind: "transcribe", account_id: acct, project_id: prj, input: { asset_id: asset.id } });
    return { asset_id: asset.id, kind, duration: probe.duration, shots: derived.shots?.length, speechRatio: derived.speechRatio, ...(transcribeJob ? { transcribe_job_id: transcribeJob.id, next: `The transcript arrives with job ${transcribeJob.id} (usually seconds); job_wait {asset_ids:["${asset.id}"]} waits for both.` } : {}) };
  });
}
export { readFile, writeFile };
