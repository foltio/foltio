// Thin wrappers around ffmpeg/ffprobe with timeouts and useful errors.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.mjs";

const exec = promisify(execFile);

export async function scratch(fn) {
  const dir = await mkdtemp(join(config.workDir, "w-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function ffprobe(file) {
  const { stdout } = await exec(
    config.ffprobe,
    ["-v", "error", "-show_format", "-show_streams", "-of", "json", file],
    { timeout: 60_000, maxBuffer: 8e6 },
  );
  return JSON.parse(stdout);
}

// Run ffmpeg; resolves with stderr text (analysis filters print there).
export function ffmpeg(args, { timeoutMs = 30 * 60_000, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(config.ffmpeg, ["-hide_banner", "-nostdin", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stderr.on("data", (d) => {
      const s = d.toString();
      err += s;
      if (err.length > 4e6) err = err.slice(-2e6);
      if (onProgress) {
        const m = s.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m) onProgress(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
      }
    });
    p.on("error", (e) => (clearTimeout(timer), reject(e)));
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(err);
      else {
        const tail = err.split("\n").filter((l) => l.trim() && !/^\s*(frame=|size=)/.test(l)).slice(-12).join("\n");
        reject(Object.assign(new Error(`ffmpeg failed (${code}): ${tail}`), { stderr: err }));
      }
    });
  });
}

let filterFlag;
export async function filterScriptFlag() {
  if (filterFlag) return filterFlag;
  const { stdout } = await exec(config.ffmpeg, ["-version"], { timeout: 10_000 });
  const major = Number((stdout.match(/ffmpeg version n?(\d+)/) || [])[1] || 6);
  filterFlag = major >= 7 ? "-/filter_complex" : "-filter_complex_script";
  return filterFlag;
}

export function parseRate(r) {
  if (!r || r === "0/0") return null;
  const [a, b] = r.split("/").map(Number);
  return b ? a / b : a;
}

export function summarizeProbe(p) {
  const v = p.streams.find((s) => s.codec_type === "video" && !(s.disposition?.attached_pic));
  const a = p.streams.find((s) => s.codec_type === "audio");
  const duration = Number(p.format?.duration || v?.duration || a?.duration || 0);
  const out = { duration: +duration.toFixed(3), container: p.format?.format_name, bytes: Number(p.format?.size || 0) };
  if (v) {
    const fps = parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || 30;
    const rot = Number(v.tags?.rotate || v.side_data_list?.find((x) => x.rotation !== undefined)?.rotation || 0);
    let width = v.width,
      height = v.height;
    if (Math.abs(rot) === 90 || Math.abs(rot) === 270) [width, height] = [height, width];
    out.video = {
      codec: v.codec_name,
      width,
      height,
      fps: +fps.toFixed(3),
      vfr: v.r_frame_rate && v.avg_frame_rate && v.r_frame_rate !== v.avg_frame_rate,
      rotation: rot,
      pixFmt: v.pix_fmt,
      hdr: ["smpte2084", "arib-std-b67"].includes(v.color_transfer),
      still: ["png", "mjpeg", "webp", "bmp", "gif", "tiff"].includes(v.codec_name) && duration < 0.2,
    };
  }
  if (a) out.audio = { codec: a.codec_name, channels: a.channels, sampleRate: Number(a.sample_rate) };
  return out;
}
