import { test } from "node:test";
import assert from "node:assert/strict";
import { newDoc, summarize } from "../server/timeline/model.mjs";
import { applyOps } from "../server/timeline/ops.mjs";

const assets = {
  ast_a: { id: "ast_a", kind: "video", name: "a.mp4", status: "ready", probe: { duration: 10, video: { fps: 30 }, audio: { channels: 2 } } },
  ast_b: { id: "ast_b", kind: "video", name: "b.mp4", status: "ready", probe: { duration: 6, video: { fps: 24 } } },
  ast_m: { id: "ast_m", kind: "audio", name: "m.mp3", status: "ready", probe: { duration: 120, audio: { channels: 2 } } },
  ast_i: { id: "ast_i", kind: "image", name: "logo.png", status: "ready", probe: { width: 512, height: 512 } },
};

test("new projects default to a landscape canvas", () => {
  const doc = newDoc();
  assert.equal(doc.settings.width, 1920);
  assert.equal(doc.settings.height, 1080);
  assert.equal(doc.settings.safeZone, "none");
});

test("append, transition, title, captions, ripple delete_range", () => {
  let doc = newDoc({ aspect: "9:16", fps: 30 });
  let r = applyOps(doc, [
    { op: "append", track: "trk_v1", asset: "ast_a", in: 1, duration: { s: 4 }, as: "a" },
    { op: "append", track: "trk_v1", asset: "ast_b", duration: { s: 3 }, as: "b" },
    { op: "add_transition", from: "$a", to: "$b", duration: { s: 0.5 } },
    { op: "place", track: "trk_a2", asset: "ast_m", at: 0, duration: { s: 7 }, audio: { gainDb: -8 } },
    { op: "add_title", at: { s: 0.5 }, duration: { s: 2 }, text: "Launch day", style: { preset: "lower_third" } },
    { op: "add_captions", style: { preset: "karaoke" } },
  ], assets);
  doc = r.doc;
  const v1 = Object.values(doc.sequence.items).filter((i) => i.trackId === "trk_v1").sort((x, y) => x.start - y.start);
  assert.equal(v1.length, 2);
  assert.equal(v1[0].start, 0);
  assert.equal(v1[0].duration, 120);
  assert.equal(v1[1].start, 120);
  assert.equal(v1[0].source.inMs, 1000);
  assert.equal(Object.keys(doc.sequence.transitions).length, 1);
  assert.equal(r.summary.durationS.after, 7);
  // cut 1s..2s across all tracks with ripple
  r = applyOps(doc, [{ op: "delete_range", from: { s: 1 }, to: { s: 2 } }], assets);
  assert.equal(r.summary.durationS.after, 6);
  const a2 = Object.values(r.doc.sequence.items).filter((i) => i.trackId === "trk_v1").sort((x, y) => x.start - y.start);
  assert.equal(a2.length, 3); // a split into two + b
  assert.equal(a2[1].start, 30);
  assert.equal(a2[1].source.inMs, 3000); // original in 1s + 2s into the clip
  const s = summarize(r.doc, assets);
  assert.ok(s.tracks.length >= 5);
});

test("errors are typed and atomic", () => {
  const doc = newDoc();
  assert.throws(() => applyOps(doc, [{ op: "place", track: "trk_v1", asset: "ast_m", at: 0 }], assets), /cannot go on video track/);
  assert.throws(() => applyOps(doc, [{ op: "append", track: "trk_v1", asset: "ast_b", duration: { s: 30 } }], assets), /needs 30.00 s/);
  assert.throws(
    () => applyOps(doc, [
      { op: "place", track: "trk_v1", asset: "ast_a", at: 0, duration: { s: 2 } },
      { op: "place", track: "trk_v1", asset: "ast_b", at: { s: 1 }, duration: { s: 2 } },
    ], assets),
    (e) => e.code === "overlap" && e.index === 1,
  );
  assert.equal(Object.keys(doc.sequence.items).length, 0);
});

test("insert ripples, trim, split, speed, detach audio", () => {
  let doc = newDoc();
  doc = applyOps(doc, [
    { op: "append", track: "trk_v1", asset: "ast_a", duration: { s: 4 }, as: "a" },
    { op: "append", track: "trk_v1", asset: "ast_a", in: 5, duration: { s: 2 }, as: "c" },
    { op: "insert", track: "trk_v1", at: { s: 4 }, asset: "ast_i", duration: { s: 1 }, as: "logo" },
    { op: "trim", item: "$a", edge: "end", by: { s: -1 }, ripple: true },
    { op: "set", item: "$c", speed: 2 },
    { op: "detach_audio", item: "$a" },
  ], assets).doc;
  const v1 = Object.values(doc.sequence.items).filter((i) => i.trackId === "trk_v1").sort((x, y) => x.start - y.start);
  assert.deepEqual(v1.map((i) => [i.kind, i.start, i.duration]), [["clip", 0, 90], ["image", 90, 30], ["clip", 120, 30]]);
  const aud = Object.values(doc.sequence.items).filter((i) => i.trackId === "trk_a1");
  assert.equal(aud.length, 1);
  assert.equal(aud[0].linkGroup, v1[0].linkGroup);
});
