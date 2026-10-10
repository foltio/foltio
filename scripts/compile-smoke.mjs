// Smoke test for the FFmpeg compiler with synthetic media (run where ffmpeg has libass).
// node scripts/compile-smoke.mjs /tmp/studio-smoke
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newDoc } from "../server/timeline/model.mjs";
import { applyOps } from "../server/timeline/ops.mjs";
import { compile } from "../server/render/compile.mjs";
import { buildAss } from "../server/timeline/ass.mjs";

const dir = process.argv[2] || "/tmp/studio-smoke";
mkdirSync(dir, { recursive: true });
const ff = (a) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a]);
ff(["-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=8", "-f", "lavfi", "-i", "sine=f=440:d=8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(dir, "a.mp4")]);
ff(["-f", "lavfi", "-i", "mandelbrot=s=1280x720:r=24", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "b.mp4")]);
ff(["-f", "lavfi", "-i", "sine=f=220:d=20", "-c:a", "libmp3lame", join(dir, "m.mp3")]);
ff(["-f", "lavfi", "-i", "color=c=orange:s=600x600:d=1", "-frames:v", "1", join(dir, "logo.png")]);

const assets = {
  ast_a: { id: "ast_a", kind: "video", name: "a.mp4", status: "ready", probe: { duration: 8, video: { fps: 30, width: 1920, height: 1080 }, audio: { channels: 1 } } },
  ast_b: { id: "ast_b", kind: "video", name: "b.mp4", status: "ready", probe: { duration: 6, video: { fps: 24, width: 1280, height: 720 } } },
  ast_m: { id: "ast_m", kind: "audio", name: "m.mp3", status: "ready", probe: { duration: 20, audio: { channels: 1 } } },
  ast_i: { id: "ast_i", kind: "image", name: "logo.png", status: "ready", probe: { video: { width: 600, height: 600, still: true } } },
};
const files = { ast_a: join(dir, "a.mp4"), ast_b: join(dir, "b.mp4"), ast_m: join(dir, "m.mp3"), ast_i: join(dir, "logo.png") };
let { doc } = applyOps(newDoc({ aspect: "9:16" }), [
  { op: "append", track: "trk_v1", asset: "ast_a", in: 1, duration: { s: 3 }, as: "a", visual: { fit: "fit", bg: "blur" } },
  { op: "append", track: "trk_v1", asset: "ast_b", in: 1, duration: { s: 3 }, as: "b", visual: { scale: { kf: [{ t: 0, v: 1 }, { t: 89, v: 1.25, ease: "ease_in_out" }] } } },
  { op: "add_transition", from: "$a", to: "$b", duration: { s: 0.6 } },
  { op: "place", track: "trk_v2", asset: "ast_i", at: { s: 0.5 }, duration: { s: 2 }, visual: { fit: "fit", bg: "none", scale: 0.25, x: 0.6, y: -0.7, rotation: 12 } },
  { op: "place", track: "trk_v2", asset: "ast_b", in: 0, at: { s: 3.2 }, duration: { s: 2.5 }, visual: { fit: "fit", bg: "none", scale: { kf: [{ t: 0, v: 0.3 }, { t: 60, v: 1.1, ease: "ease_out" }] }, x: { kf: [{ t: 0, v: -0.5 }, { t: 60, v: 0.2 }] }, y: 0.3, opacity: { kf: [{ t: 0, v: 0 }, { t: 12, v: 1 }] } } },
  { op: "place", track: "trk_a2", asset: "ast_m", at: 0, duration: { s: 6 }, audio: { gainDb: -6, fadeOutMs: 800 } },
  { op: "add_title", at: { s: 0.3 }, duration: { s: 2.2 }, text: "Launch day", style: { preset: "lower_third" } },
  { op: "add_captions", style: { preset: "karaoke" } },
], assets);
const transcripts = { ast_a: { words: [{ w: "this", s: 1.1, e: 1.4 }, { w: "is", s: 1.45, e: 1.6 }, { w: "the", s: 1.65, e: 1.8 }, { w: "new", s: 1.85, e: 2.1 }, { w: "studio", s: 2.15, e: 2.7 }, { w: "launching", s: 2.9, e: 3.5 }, { w: "today", s: 3.55, e: 3.95 }] } };
const ass = buildAss(doc, assets, transcripts);
writeFileSync(join(dir, "t.ass"), ass);
for (const [name, q] of [["draft", { width: 540, height: 960, crf: 28 }], ["final", { width: 1080, height: 1920, crf: 20, preset: "fast" }]]) {
  const out = join(dir, `${name}.mp4`);
  const c = compile({ doc, assets, files, quality: { ...q, threads: 8 }, assPath: join(dir, "t.ass"), outPath: out });
  writeFileSync(join(dir, `${name}.graph`), c.graph);
  const t0 = Date.now();
  execFileSync("ffmpeg", [...c.args, "-filter_complex_script", join(dir, `${name}.graph`), ...c.outArgs], { stdio: ["ignore", "ignore", "pipe"] });
  const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate", "-of", "json", out]).toString();
  console.log(name, `${Date.now() - t0} ms`, probe.replace(/\s+/g, " ").slice(0, 300));
}
