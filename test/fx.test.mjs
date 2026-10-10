import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newDoc } from "../server/timeline/model.mjs";
import { applyOps } from "../server/timeline/ops.mjs";
import { cleanFilter, fxKey, filterAssets, withFiles } from "../server/timeline/fx.mjs";
import { compile } from "../server/render/compile.mjs";

const assets = {
  ast_v: { id: "ast_v", kind: "video", name: "v.mp4", status: "ready", probe: { duration: 3, video: { fps: 30, width: 320, height: 568 }, audio: { channels: 2 } } },
  ast_m: { id: "ast_m", kind: "audio", name: "m.mp3", status: "ready", probe: { duration: 30, audio: { channels: 2 } } },
  ast_lut001: { id: "ast_lut001", kind: "file", name: "film.cube", status: "ready" },
};

test("custom filters: the guide's recipes pass; anything that reads files or changes length doesn't", () => {
  for (const [f, kind] of [
    ["colortemperature=temperature=4800,eq=contrast=1.08:saturation=0.9:gamma=0.97,curves=preset=vintage,noise=alls=6:allf=t", "video"],
    ["hue=s=0,eq=contrast=1.35:brightness=-0.03,curves=preset=strong_contrast,vignette=PI/5", "video"],
    ["chromakey=color=0x00d000:similarity=0.12:blend=0.06,despill=type=green", "video"],
    ["vignette=angle=PI/4.5,noise=alls=10:allf=t+u,eq=saturation=0.92", "video"],
    ["lut3d=ast_lut001", "video"],
    ["highpass=f=80,afftdn=nr=12:nf=-30,equalizer=f=3000:t=q:w=1:g=3,deesser,acompressor=threshold=0.1:ratio=3:makeup=2", "audio"],
  ])
    assert.ok(cleanFilter(f, kind), f);
  const bad = [
    ["movie=/etc/passwd", "video"],
    ["eq,[in]overlay", "video"],
    ["eq;sendcmd=f=x", "video"],
    ["scale=100:100", "video"], // frame size is the item's visual
    ["setpts=PTS/2", "video"], // length is the item's speed
    ["reverse", "video"],
    ["drawtext=textfile=/etc/hosts", "video"],
    ["curves=psfile=../x.acv", "video"],
    ["lut3d=file=/tmp/x.cube", "video"],
    ["rubberband=tempo=2", "audio"],
    ["atempo=2", "audio"],
    ["amovie=http://x/a.mp3", "audio"],
    ["eq", "audio"], // a picture filter on sound
    ["x".repeat(700), "video"],
  ];
  for (const [f, kind] of bad) assert.throws(() => cleanFilter(f, kind), undefined, f);
  assert.equal(cleanFilter("", "video"), null);
  assert.deepEqual(filterAssets("eq,lut3d=ast_lut001"), ["ast_lut001"]);
  assert.equal(withFiles("lut3d=ast_lut001", { ast_lut001: "/w/l.cube" }), "lut3d=file=/w/l.cube");
  assert.equal(fxKey("ast_v", "eq", null), fxKey("ast_v", "eq", null));
  assert.notEqual(fxKey("ast_v", "eq", null), fxKey("ast_v", "eq=contrast=2", null));
});

test("set filter/afilter: stored on the item, cleared with null, refused on the wrong item", () => {
  let doc = newDoc({ aspect: "9:16", fps: 30 });
  doc = applyOps(doc, [
    { op: "append", track: "trk_v1", asset: "ast_v", duration: { s: 2 }, as: "v" },
    { op: "place", track: "trk_a2", asset: "ast_m", at: 0, duration: { s: 2 }, as: "m" },
  ], assets).doc;
  const v = Object.values(doc.sequence.items).find((i) => i.asset === "ast_v");
  const m = Object.values(doc.sequence.items).find((i) => i.asset === "ast_m");
  doc = applyOps(doc, [{ op: "set", item: v.id, filter: "hue=s=0", afilter: "highpass=f=80" }], assets).doc;
  assert.equal(doc.sequence.items[v.id].filter, "hue=s=0");
  assert.equal(doc.sequence.items[v.id].afilter, "highpass=f=80");
  assert.throws(() => applyOps(doc, [{ op: "set", item: m.id, filter: "hue=s=0" }], assets), /filter applies to video/);
  assert.throws(() => applyOps(doc, [{ op: "set", item: v.id, filter: "lut3d=ast_nope00" }], assets), /No asset/);
  doc = applyOps(doc, [{ op: "set", item: v.id, filter: null }], assets).doc;
  assert.equal(doc.sequence.items[v.id].filter, undefined);
  assert.equal(doc.sequence.items[v.id].afilter, "highpass=f=80");
});

// A real 2 s render with ffmpeg: the filter changes the picture (black and white → no colour).
function hasFfmpeg() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
test("render applies item.filter (a 2 s clip, before and after)", { skip: !hasFfmpeg() && "no ffmpeg" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "fx-"));
  try {
    const src = join(dir, "src.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x568:r=30:d=3", "-f", "lavfi", "-i", "sine=f=440:d=3", "-shortest", "-pix_fmt", "yuv420p", src]);
    const satOf = (filter) => {
      let doc = newDoc({ aspect: "9:16", fps: 30 });
      doc = applyOps(doc, [{ op: "append", track: "trk_v1", asset: "ast_v", duration: { s: 2 }, as: "v" }], assets).doc;
      const v = Object.values(doc.sequence.items)[0];
      if (filter) doc = applyOps(doc, [{ op: "set", item: v.id, filter, afilter: "highpass=f=80" }], assets).doc;
      const out = join(dir, `${filter ? "fx" : "plain"}.mp4`);
      const c = compile({ doc, assets, files: { ast_v: src }, quality: { width: 180, height: 320, crf: 30, preset: "ultrafast", threads: 2 }, outPath: out });
      execFileSync("ffmpeg", [...c.args, "-filter_complex", c.graph, ...c.outArgs], { stdio: ["ignore", "ignore", "pipe"] });
      // mean saturation of a frame at 1 s
      const stats = execFileSync("ffprobe", ["-v", "error", "-f", "lavfi", "-i", `movie=${out},trim=start=1:duration=0.04,signalstats`, "-show_entries", "frame_tags=lavfi.signalstats.SATAVG", "-of", "csv=p=0"]).toString().trim().split("\n")[0];
      return Number(stats);
    };
    const plain = satOf(null),
      bw = satOf("hue=s=0,eq=contrast=1.2");
    assert.ok(plain > 20, `the test pattern is colourful (${plain})`);
    assert.ok(bw < 2, `the filtered render has no colour (${bw})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
