// The development flow's pieces: choosing a look by eye, what's out of date after a change, the
// read-through's lines and voices, and cutting a storyboard sheet into its panels to watch through.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { applyPatch, emptyBoard, boardLines, boardAssets } from "../server/board.mjs";
import { recipe, fingerprint, outOfDate, readLines } from "../server/gen/recipes.mjs";
import { findPanels, ANALYSE } from "../server/gen/panels.mjs";

const board = () =>
  applyPatch(emptyBoard(), {
    brief: { intent: "Two sisters argue on a night bus over their grandmother's cat", aspect: "9:16", where: "TikTok and Reels", versions: "a 15 s teaser", ending: "The bell rings at Grandma's old stop; nobody gets off." },
    cast: [
      { name: "Ruth", age: "38", look: "sharp pale face, dark low bun", outfit: "black wool coat buttoned to the collar", voice: { voice: "Alice" } },
      { name: "Bee", age: "29", look: "freckles, auburn curls in a claw clip", voice: { voice: "Lily" } },
    ],
    places: [{ name: "The night bus", look: "top deck of a red double-decker", time: "2 am", weather: "rain" }],
    look: { moment: "Ruth and Bee on the top deck with the cat carrier between them", options: [{ name: "Night realism", style: "35 mm grain, green-white strip light" }, { name: "Felt", style: "felt stop-motion, warm mustard and navy" }] },
    storyboards: [{ id: "1", seconds: 15, cast: ["C1", "C2"], place: "L1", panels: [
      { t: "0-3", action: "Bee hugs the carrier", line: "BEE (whispering): He likes me more." },
      { t: "3-7", action: "Ruth produces a folded list", line: "RUTH: I've prepared a short list. / BEE: Of course you have." },
      { t: "7-15", action: "The driver glances back", line: "DRIVER: Last stop's the depot." },
    ] }],
  }).board;

test("looks are chosen by eye: lettered options, one frame each, and choosing makes it the look", () => {
  let b = board();
  assert.deepEqual(b.look.options.map((o) => o.id), ["A", "B"]);
  const r = recipe(b, { look: "b" }, { aspect: "9:16" });
  assert.equal(r.model, "image");
  assert.deepEqual(r.params, { aspect: "9:16", size: "1K", quality: "medium" });
  assert.deepEqual(r.for, { look: "B" });
  assert.match(r.prompt, /The moment: Ruth and Bee on the top deck with the cat carrier between them\./);
  assert.match(r.prompt, /Ruth: 38, sharp pale face, dark low bun, black wool coat buttoned to the collar\./);
  assert.match(r.prompt, /The look: felt stop-motion, warm mustard and navy\./);
  assert.match(r.prompt, /Composed as a 9:16 frame/);
  b = { ...b, look: { ...b.look, options: b.look.options.map((o) => ({ ...o, frame: `ast_${o.id}` })) } };
  const { board: chosen, warnings } = applyPatch(b, { look: { chosen: "B" } });
  assert.deepEqual(warnings, []);
  assert.equal(chosen.look.style, "felt stop-motion, warm mustard and navy");
  assert.deepEqual(chosen.look.refs, [{ asset_id: "ast_B", use: "style" }]);
  assert.ok(boardAssets(chosen).has("ast_A"));
  assert.match(boardLines(chosen), /Look B \(chosen\) Felt/);
  assert.match(boardLines(chosen), /plays on TikTok and Reels · versions: a 15 s teaser/);
  assert.match(boardLines(chosen), /Ends: The bell rings/);
  assert.match(applyPatch(chosen, { look: { chosen: "Z" } }).warnings.join(" "), /no look Z/);
});

test("what's out of date: a result is judged by the board inputs it was made from", () => {
  let b = board();
  b.cast[0].sheet_fp = fingerprint(b, { cast: "C1" });
  b.cast[0].voice.sample_fp = fingerprint(b, { voice: "C1" });
  b.storyboards[0].sheet_fp = fingerprint(b, { storyboard: "1", make: "sheet" });
  b.storyboards[0].take_fp = fingerprint(b, { storyboard: "1" });
  assert.deepEqual(outOfDate(b), []);
  // her coat changes: her sheet goes stale, but not her voice, nor (until her sheet is remade) the storyboard
  b = applyPatch(b, { cast: [{ id: "C1", outfit: "a grey coat" }] }).board;
  assert.deepEqual(outOfDate(b).map((x) => `${x.kind}:${x.id}`), ["sheet:C1"]);
  // a line changes: the storyboard's sheet and take are both out of date
  b = applyPatch(b, { storyboards: [{ id: "1", panels: [{ t: "0-15", action: "Bee hugs the carrier", line: "BEE: Mine." }] }] }).board;
  assert.deepEqual(outOfDate(b).map((x) => `${x.kind}:${x.id}`), ["sheet:C1", "board:1", "take:1"]);
  assert.equal(outOfDate(b).find((x) => x.kind === "take").usd, 0.9);
  // a new look makes every sheet drawn in the old one stale
  const c = applyPatch(board(), {}).board;
  c.places[0].sheet_fp = fingerprint(c, { place: "L1" });
  assert.deepEqual(outOfDate(applyPatch(c, { look: { style: "anime, cel shading" } }).board).map((x) => x.id), ["L1"]);
});

test("the read-through: each line in its speaker's voice, with delivery, stand-ins and a stable key", () => {
  const b = board();
  const lines = readLines(b, b.storyboards[0]);
  assert.deepEqual(lines.map((l) => [l.who, l.voice, l.text, l.panel]), [
    ["Bee", "Lily", "[whispering] He likes me more.", 0],
    ["Ruth", "Alice", "I've prepared a short list.", 1],
    ["Bee", "Lily", "Of course you have.", 1],
    ["Driver", "Brian", "Last stop's the depot.", 2],
  ]);
  assert.equal(lines[3].standIn, true);
  assert.equal(lines[0].key, readLines(b, b.storyboards[0])[0].key, "same words and voice, same reading");
  const other = applyPatch(b, { cast: [{ id: "C2", voice: { voice: "Jessica" } }] }).board;
  assert.notEqual(readLines(other, other.storyboards[0])[0].key, lines[0].key, "a new voice is a new reading");
});

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("storyboard sheets split into their panels (grids and uneven rows), in reading order", { skip: !hasFfmpeg && "needs ffmpeg" }, () => {
  const cases = { "pip-1": 6, "pip-2": 6, "pip-3": 6, "pip-4": 6, "moonbrew-1": 5, "moonbrew-2": 5 };
  for (const [name, n] of Object.entries(cases)) {
    const rgb = execFileSync("ffmpeg", ["-loglevel", "error", "-i", new URL(`./fixtures/sheets/${name}.jpg`, import.meta.url).pathname, "-vf", `scale=${ANALYSE.w}:${ANALYSE.h}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 2e6 });
    const boxes = findPanels(rgb, ANALYSE.w, ANALYSE.h, n);
    assert.ok(boxes, `${name}: split into ${n}`);
    assert.equal(boxes.length, n);
    // reading order: left to right within a row, rows top to bottom
    for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i].y > boxes[i - 1].y + 10 || boxes[i].x > boxes[i - 1].x, `${name}: panel ${i + 1} after panel ${i}`);
    // panels are big, and stay above the cast strip
    for (const b of boxes) assert.ok(b.w > ANALYSE.w * 0.25 && b.h > ANALYSE.h * 0.2 && b.y + b.h < ANALYSE.h * 0.85, `${name}: ${JSON.stringify(b)}`);
    // asking for the wrong count fails cleanly rather than guessing
    assert.equal(findPanels(rgb, ANALYSE.w, ANALYSE.h, n + 1), null);
  }
});
