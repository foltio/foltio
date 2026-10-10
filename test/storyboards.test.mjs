// Bibles, storyboards and drafts: the board's storyboards, the recipes that write each generation
// from the board, and renumbering a prompt's "Image 2" when the person reorders its references.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPatch, emptyBoard, normalize, withPlacement, boardAssets, boardLines } from "../server/board.mjs";
import { recipe, panelTimes, speakerLine, grid } from "../server/gen/recipes.mjs";
import { renumber, slots } from "../server/gen/mentions.mjs";

const base = applyPatch(emptyBoard(), {
  brief: { aspect: "16:9" },
  look: { style: "stylized 3D animated feature film, dusk light" },
  plan: { title: "Pip & Ines" },
  cast: [
    { id: "C1", name: "Ines", role: "the protagonist", age: "10", look: "a girl with a short black bob", outfit: "a yellow raincoat", voice: { voice: "Laura", sample: "ast_iv" }, refs: [{ asset_id: "ast_ines", use: "sheet" }, { asset_id: "ast_photo", use: "source" }] },
    { id: "C2", name: "Pip", look: "a small copper robot with one blue lens eye", refs: [{ asset_id: "ast_pip", use: "sheet" }] },
    { id: "C3", kind: "product", name: "Moonbrew", look: "a matte black can", label: "MOONBREW" },
  ],
  places: [{ id: "L1", name: "The old pier", time: "dusk", look: "a long wooden pier", sound: "rain on wood, gulls", refs: [{ asset_id: "ast_pier", use: "sheet" }] }],
  storyboards: [
    { id: "1", seconds: 15, cast: ["C1", "C2"], place: "L1", sheet: "ast_sb1", takes: ["ast_t1", "ast_t2"], panels: [
      { t: "0-2.5", shot: "Wide, slow push-in", action: "Ines runs down the pier" },
      { t: "2.5-5", shot: "Medium", action: "she stops by the boat" },
      { t: "5-10", shot: "Close-up", action: "Pip's eye opens", line: "INES: You're not broken." },
      { t: "10-15", shot: "Wide", action: "the two walk away" },
    ] },
    { id: "2", seconds: 20, cast: ["C1", "C2"], place: "L1", takes: ["ast_t3", "ast_t4"], panels: [{ action: "they reach the kiosk" }, { action: "a gust flips the umbrella", line: "Whoa!" }] },
    { id: "3", start: "extend", cast: ["C1"], place: "L1", panels: [{ action: "she laughs" }, { action: "they walk on into town" }] },
  ],
}).board;

test("old boards' shots become one-panel storyboards", () => {
  const b = normalize({ shots: [{ id: "1.1", seconds: 6, action: "She turns", dialogue: "Who's there?", camera: "push in", takes: ["ast_a"] }] });
  assert.equal(b.shots, undefined);
  assert.equal(b.storyboards[0].id, "1.1");
  assert.deepEqual(b.storyboards[0].panels[0], { t: "0-6", shot: "push in", action: "She turns", line: "Who's there?" });
  const r = applyPatch(emptyBoard(), { shots: [{ id: "2.1", action: "x" }] });
  assert.equal(r.board.storyboards[0].panels[0].action, "x");
  assert.match(r.warnings.join(" "), /now board.storyboards/);
  assert.match(applyPatch(emptyBoard(), { storyboards: [{ id: "9", seconds: 30 }] }).warnings.join(" "), /up to 15 s per generation/);
});

test("panel times: written ones are kept, missing ones split the clip evenly", () => {
  assert.deepEqual(panelTimes(base.storyboards[0]).map((p) => [p.from, p.to]), [[0, 2.5], [2.5, 5], [5, 10], [10, 15]]);
  assert.deepEqual(panelTimes({ seconds: 15, panels: [{ t: "0:00–0:05", action: "a" }, { t: "0:05–0:15", action: "b" }] }).map((p) => [p.from, p.to]), [[0, 5], [5, 15]]);
  assert.deepEqual(panelTimes({ seconds: 12, panels: [{ action: "a" }, { action: "b" }, { action: "c" }] }).map((p) => [p.from, p.to]), [[0, 4], [4, 8], [8, 12]]);
  assert.deepEqual(speakerLine('INES: "You came back."'), { who: "Ines", words: "You came back.", vo: false });
  assert.deepEqual(speakerLine("Whoa!"), { who: null, words: "Whoa!", vo: false });
  assert.deepEqual([grid(4), grid(6), grid(8), grid(12), grid(5, "9:16")], [[2, 2], [3, 2], [4, 2], [4, 3], [5, 1]]);
});

test("a character bible: the card's fields in the sheet layout, the person's own image as the source", () => {
  const r = recipe(base, { cast: "C1" });
  assert.equal(r.model, "image");
  assert.deepEqual(r.params, { aspect: "16:9", size: "2K", quality: "high" });
  // no look frame: the place's sheet sets the look for the person's sheet (never another person's sheet)
  assert.deepEqual(r.references, [{ asset_id: "ast_photo", role: "character" }, { asset_id: "ast_pier", role: "style" }]);
  assert.match(r.prompt, /^Image 1 is Ines's source design: keep this exact design/);
  assert.match(r.prompt, /Image 2 is the look reference — a place's sheet from this film: match its rendering style/);
  assert.deepEqual(recipe(base, { place: "L1" }).references, [{ asset_id: "ast_ines", role: "style" }]); // a place takes a person's
  const framed = applyPatch(base, { look: { refs: [{ asset_id: "ast_look", use: "style" }] } }).board;
  assert.deepEqual(recipe(framed, { cast: "C1" }).references.map((x) => x.asset_id), ["ast_photo", "ast_look"]); // a look frame, when there is one
  assert.match(r.prompt, /Character: INES\. Role: the protagonist\. Age: 10\./);
  assert.match(r.prompt, /full-body turnaround — front, three-quarter, side, back/);
  assert.match(r.prompt, /Expressions: 8 head shots/);
  assert.deepEqual(r.for, { cast: "C1" });
  const product = recipe(base, { cast: "C3" });
  assert.match(product.prompt, /Product: MOONBREW/);
  assert.match(product.prompt, /label reads exactly: "MOONBREW"/);
  assert.match(recipe(base, { place: "L1" }).prompt, /Place: THE OLD PIER\. Time of day: dusk\.[\s\S]*No people, characters or animals/);
  assert.throws(() => recipe(base, { cast: "C1", place: "L1" }), /names cast and place\. Ask for each separately/);
  const v = recipe(base, { voice: "C1" });
  assert.equal(v.model, "voice");
  assert.equal(v.params.voice, "Laura");
  assert.match(v.text, /\w+(?:\s+\S+){11,}/);
});

test("a storyboard sheet is drawn from the bibles and the storyboard before it", () => {
  const r = recipe(base, { storyboard: "2", make: "sheet" });
  assert.deepEqual(r.references.map((x) => `${x.role}:${x.asset_id}`), ["character:ast_ines", "character:ast_pip", "location:ast_pier", "storyboard:ast_sb1"]);
  assert.match(r.prompt, /Image 1 is Ines's character sheet/);
  assert.match(r.prompt, /Image 3 is the old pier's location sheet/);
  assert.match(r.prompt, /Image 4 is the storyboard of the previous sequence: this sequence continues straight on/);
  assert.match(r.prompt, /Header across the top: "PIP & INES — SEQUENCE 2" on the left; on the right "2 SHOTS · 20 SECONDS · 16:9"/);
  assert.match(r.prompt, /2 numbered panels in a 2 × 1 grid/);
  assert.match(r.prompt, /01 · 0:00–0:10 — They reach the kiosk\./);
  assert.match(r.prompt, /a slim strip: the cast/); // a calm sheet keeps its cast strip
  assert.deepEqual(r.for, { storyboard: "2", make: "sheet" });
});

test("a storyboard's video: the sheet first, then every bible and voice, where the clip sits, what happens loosely", () => {
  const r = recipe(base, { storyboard: "1" }, { durations: { ast_iv: 6 } });
  assert.equal(r.model, "video/ref");
  assert.deepEqual(r.params, { duration: 15, resolution: "768P", aspect: "16:9" });
  assert.deepEqual(r.references.map((x) => `${x.role}:${x.asset_id}`), ["storyboard:ast_sb1", "character:ast_ines", "character:ast_pip", "location:ast_pier", "voice:ast_iv"]);
  assert.match(r.prompt, /^Image 1 is this clip's storyboard: its panels are the shots, in order\. Follow the story they tell, and let the cuts, camera and timing play naturally\./);
  assert.match(r.prompt, /never show panel borders, captions/);
  assert.match(r.prompt, /\nClip 1 of 3\. The opening: it hooks from the first second\.\n/);
  assert.match(r.prompt, /Image 2 is Ines's character sheet: a girl with a short black bob\. Wearing a yellow raincoat\./);
  assert.match(r.prompt, /Audio 1 is Ines's voice/);
  // the storyboard carries the shots and the model the timing: what happens, in order, no timecodes
  assert.match(r.prompt, /What happens, in order:\n– Ines runs down the pier\.\n– She stops by the boat\.\n– Pip's eye opens\.\n– The two walk away\./);
  // the dialogue is one conversation, played across the shots
  assert.match(r.prompt, /The conversation, in order:\nInes: "You're not broken\."\nPlay it as a real conversation, not lines read out in turn/);
  assert.doesNotMatch(r.prompt, /\d+–\d+ s:|close-up/i);
  assert.match(r.prompt, /Sound: rain on wood, gulls\./);
  assert.doesNotMatch(r.prompt, /no music|immediately/);
  assert.match(r.prompt, /Their own voices and timing\. Quoted lines keep their words\./);
  assert.match(r.prompt, /\nNo on-screen text\.$/);
  const long = recipe(base, { storyboard: "2" });
  assert.equal(long.params.duration, 15);
  assert.match(long.warnings.join(" "), /at most 15 s in one generation/);
  assert.match(long.warnings.join(" "), /no sheet yet/);
  const omni = recipe(base, { storyboard: "1", model: "video/omni" });
  assert.equal(omni.params.duration, 10);
  assert.match(omni.prompt, /^<IMAGE_REF_0> is this clip's storyboard/);
  assert.ok(!omni.references.some((x) => x.role === "voice"));
  assert.match(omni.warnings.join(" "), /no voice references/);
});

test("start:extend continues the previous storyboard's take, in plain sentences", () => {
  // the take in use on the timeline, else the newest
  assert.equal(recipe(base, { storyboard: "3" }).references[0].asset_id, "ast_t4");
  const placed = withPlacement(base, { sequence: { items: { i: { asset: "ast_t3" } } } });
  const r = recipe(placed, { storyboard: "3" }, { durations: { ast_iv: 6 } });
  assert.equal(r.model, "video/extend");
  assert.deepEqual(r.references.map((x) => `${x.role}:${x.asset_id}`), ["source_video:ast_t3", "voice:ast_iv"]);
  assert.doesNotMatch(r.prompt, /\d+–\d+ s:/);
  assert.match(r.prompt, /Carry the shot straight on\. She laughs\. Then they walk on into town\./);
});

test("renumbering a prompt when the person reorders, removes or swaps models", () => {
  const before = [{ key: "a", role: "storyboard" }, { key: "b", role: "character" }, { key: "c", role: "character" }, { key: "v", role: "voice" }];
  const prompt = "Image 1 is the storyboard. Image 2 is Ines. Image 3 is Pip. Audio 1 is Ines's voice.";
  const swapped = renumber(prompt, { model: "video/ref", refs: before }, { model: "video/ref", refs: [before[0], before[2], before[1], before[3]] });
  assert.equal(swapped.prompt, "Image 1 is the storyboard. Image 3 is Ines. Image 2 is Pip. Audio 1 is Ines's voice.");
  const removed = renumber(prompt, { model: "video/ref", refs: before }, { model: "video/ref", refs: [before[0], before[2], before[3]] });
  assert.equal(removed.prompt, "Image 1 is the storyboard. Image 2 is Ines. Image 2 is Pip. Audio 1 is Ines's voice.");
  assert.deepEqual(removed.orphans, ["Image 2"]);
  const omni = renumber(prompt, { model: "video/ref", refs: before }, { model: "video/omni", refs: before.slice(0, 3) });
  assert.equal(omni.prompt, "<IMAGE_REF_0> is the storyboard. <IMAGE_REF_1> is Ines. <IMAGE_REF_2> is Pip. Audio 1 is Ines's voice.");
  assert.deepEqual(omni.orphans, ["Audio 1"]);
  // GPT Image numbers every image, an edit source first
  assert.deepEqual(slots("image", [{ role: "character" }, { role: "edit_source" }]).map((s) => [s.i, s.label]), [[1, "image 1"], [0, "image 2"]]);
});

test("an exchange can share a panel; voice-overs are heard over the picture", async () => {
  const { speakerLines } = await import("../server/gen/recipes.mjs");
  assert.deepEqual(speakerLines("TEO: Where were you? / INES: Out."), [{ who: "Teo", words: "Where were you?", vo: false }, { who: "Ines", words: "Out.", vo: false }]);
  assert.deepEqual(speakerLines("INES (V.O.): Day one, they called me the janitor."), [{ who: "Ines", words: "Day one, they called me the janitor.", vo: true }]);
  assert.deepEqual(speakerLines("INES (whispering): Not now, Pip."), [{ who: "Ines", words: "Not now, Pip.", vo: false, delivery: "whispering" }]);
  const b = applyPatch(base, { storyboards: [{ id: "4", seconds: 15, mood: "quiet dread, tightening", cast: ["C1", "C2"], panels: [
    { t: "0-3", shot: "close-up", action: "Teo blocks the door", line: "TEO: Where were you? / INES: Out. / INES: Walking." },
    { t: "3-6", action: "she looks away", line: "INES (V.O.): He knows." },
    { t: "6-15", action: "silence" },
  ] }] }).board;
  const r = recipe(b, { storyboard: "4" });
  assert.match(r.prompt, /Mood: quiet dread, tightening\./);
  // no sheet yet, so each beat says its shot
  assert.match(r.prompt, /– Close-up: Teo blocks the door\./);
  assert.match(r.prompt, /The conversation, in order:\nTeo: "Where were you\?"\nInes: "Out\."\nInes: "Walking\."\nInes \(voice-over\): "He knows\."/);
  // a gist is said in their own words
  const gist = recipe(applyPatch(b, { storyboards: [{ id: "4", panels: [{ action: "they argue", line: "TEO (gist): asks where she was, half-joking" }] }] }).board, { storyboard: "4" });
  assert.match(gist.prompt, /Teo, in their own words: asks where she was, half-joking\./);
  assert.doesNotMatch(r.prompt, /no spoken dialogue/);
  const quiet = recipe(applyPatch(base, { storyboards: [{ id: "5", seconds: 10, panels: [{ action: "rain" }, { action: "a door" }, { action: "a light" }, { action: "black" }] }] }).board, { storyboard: "5" });
  assert.match(quiet.prompt, /; no spoken dialogue\./);
});

test("pacing notes: quiet clips in a row, rushed or long lines, too few beats, a late opener, long silences, one shape throughout, long episodes", async () => {
  const { pacingNotes } = await import("../server/gen/recipes.mjs");
  const b = applyPatch(emptyBoard(), { storyboards: [
    { id: "1", seconds: 15, panels: [{ t: "0-5", action: "a wide of the city" }, { t: "5-10", action: "she walks", line: "MARA: I told you this would happen if we ever came back here again." }, { t: "10-15", action: "he turns" }] },
    { id: "2", seconds: 15, panels: [{ action: "a" }, { action: "b" }, { action: "c" }, { action: "d" }, { action: "e" }] },
    { id: "3", seconds: 15, panels: [{ action: "a" }, { action: "b" }] },
    { id: "4", seconds: 15, panels: [{ t: "0-3", action: "x", line: "A: One two three four five six seven eight nine ten." }, { t: "3-6", action: "y", line: "B: One two three four five six seven." }, { t: "6-9", action: "z", line: "A: One two three four five six seven." }, { t: "9-15", action: "w" }] },
  ] }).board;
  const notes = pacingNotes(b).join("\n");
  // one quiet clip after a talking one is rhythm; two in a row may sag
  assert.doesNotMatch(notes, /Storyboards 1 and 2/);
  assert.match(notes, /Storyboards 2 and 3 are both quiet/);
  assert.match(notes, /Storyboard 3 has 2 beats for 15 s/);
  assert.doesNotMatch(notes, /Storyboard 1 has 3/);
  assert.match(notes, /Storyboard 1, panel 2: "I told you.*" is 13 words/);
  assert.match(notes, /Storyboard 4: 24 words in 15 s will come out rushed/);
  assert.match(notes, /The opening line comes at 5 s\. Open cold/);
  assert.match(pacingNotes(applyPatch(emptyBoard(), { storyboards: [{ id: "1", seconds: 15, panels: [{ t: "0-2", action: "a", line: "A: Hi." }, { t: "2-12", action: "b" }, { t: "12-15", action: "c" }, { t: "12-15", action: "d" }] }] }).board).join(" "), /13 s with no line \(2–15 s\)/);
  assert.match(pacingNotes(applyPatch(emptyBoard(), { storyboards: [{ id: "1", seconds: 8, panels: [{ action: "a" }, { action: "b" }] }] }).board).join(" "), /opens the film without a line/);
  assert.equal(pacingNotes(applyPatch(emptyBoard(), { brief: { dialogue: "none" }, storyboards: [{ id: "1", seconds: 15, panels: [{ action: "a" }, { action: "b" }, { action: "c" }, { action: "d" }, { action: "e" }] }] }).board).length, 0);
  // every clip the same length and density
  const same = applyPatch(emptyBoard(), { storyboards: ["1", "2", "3"].map((id) => ({ id, seconds: 15, panels: [{ action: "a", line: "A: Hi." }, { action: "b", line: "B: Hey." }, { action: "c" }] })) }).board;
  assert.match(pacingNotes(same).join(" "), /All 3 clips have the same shape \(15 s, about 2 lines each\)/);
  assert.equal(pacingNotes(same, ["1"]).length, 0); // said when the latest clip is written, not on every edit
  const long = applyPatch(emptyBoard(), { brief: { dialogue: "none" }, storyboards: [1, 2, 3, 4, 5, 6, 7].map((i) => ({ id: String(i), seconds: 15, panels: [{ action: "a" }, { action: "b" }, { action: "c" }, { action: "d" }, { action: "e" }] })) }).board;
  assert.match(pacingNotes(long).join(" "), /add up to 105 s/);
  assert.deepEqual(pacingNotes(b, ["2"]).length, 0);
});

test("one storyboard at a time: outlines wait, the next sheet starts from the last frame, the video can wait for its sheet", async () => {
  const { pacingNotes } = await import("../server/gen/recipes.mjs");
  const b = applyPatch(base, { storyboards: [
    { id: "1", ended: "Ines stands at the end of the pier holding the umbrella over Pip; Pip's eye glows amber; she has just said he is only cold.", last_frame: "ast_lf1", last_from: "ast_t2" },
    { id: "6", title: "Home", beat: "Ines sneaks Pip past her grandfather", seconds: 15 },
  ] }).board;
  assert.throws(() => recipe(b, { storyboard: "6" }), /still an outline \("Ines sneaks Pip past her grandfather"\)/);
  assert.equal(pacingNotes(b, ["6"]).length, 0); // outlines aren't judged yet
  // storyboard 2 comes after storyboard 1, whose newest take ast_t2 has a saved last frame
  const sheet = recipe(b, { storyboard: "2", make: "sheet" });
  assert.deepEqual(sheet.references.map((r) => `${r.role}:${r.asset_id}`), ["character:ast_ines", "character:ast_pip", "location:ast_pier", "storyboard:ast_sb1", "storyboard:ast_lf1"]);
  assert.match(sheet.prompt, /Image 5 is the last frame of the previous sequence's video: panel 1 picks up right after this moment/);
  assert.match(sheet.prompt, /Where the previous sequence ended: Ines stands at the end of the pier/);
  // a stale last frame (from another take) isn't used
  const stale = recipe(applyPatch(b, { storyboards: [{ id: "1", last_from: "ast_t1" }] }).board, { storyboard: "2", make: "sheet" });
  assert.ok(!stale.references.some((r) => r.asset_id === "ast_lf1"));
  assert.match(stale.warnings.join(" "), /no saved last frame/);
  // the video, prepared while its sheet is still a draft
  const vid = recipe(b, { storyboard: "2" }, { pendingSheet: "pending:qt_sheet2" });
  assert.equal(vid.references[0].asset_id, "pending:qt_sheet2");
  assert.match(vid.prompt, /^Image 1 is this clip's storyboard/);
  assert.match(vid.prompt, /It picks up right after the last clip: Ines stands at the end of the pier/);
  assert.doesNotMatch(vid.warnings.join(" "), /no sheet yet|no take yet/);
  // made ahead of the take before it: allowed, with a nudge to go clip by clip
  const ahead = recipe(applyPatch(b, { storyboards: [{ id: "1", takes: [] }] }).board, { storyboard: "2", make: "sheet" });
  assert.match(ahead.warnings.join(" "), /Storyboard 1 has no take yet\. Clip by clip keeps the film joined up/);
});

test("every library voice has a preview the editor can play", async () => {
  const { VOICES } = await import("../server/gen/catalog.mjs");
  const { existsSync } = await import("node:fs");
  const missing = Object.keys(VOICES).filter((v) => !existsSync(new URL(`../web/public/voices/${v.toLowerCase()}.mp3`, import.meta.url)));
  assert.deepEqual(missing, [], "run node scripts/voice-previews.mjs");
});

test("music is a card on the board: merged by id, its samples kept, its recipe a track the film's length", () => {
  let { board, warnings } = applyPatch(base, {
    music: [{ name: "Harbour theme", style: "solo piano and soft strings", mood: "hushed, then hopeful", tempo: "70 BPM", vocals: "instrumental", where: "under the whole film, low under the lines", reference: "a quiet Ghibli cue" }],
  });
  assert.deepEqual(warnings, []);
  assert.equal(board.music[0].id, "M1");
  ({ board } = applyPatch(board, { music: [{ id: "M1", vocals: "choir", sample: "ast_m1", samples: ["ast_m0", "ast_m1"] }] }));
  assert.equal(board.music[0].vocals, "instrumental", "an unknown vocals value is ignored");
  assert.ok(boardAssets(board).has("ast_m0") && boardAssets(board).has("ast_m1"));
  assert.match(boardLines(board), /M1 Harbour theme \(music, instrumental\): solo piano and soft strings · hushed, then hopeful · 70 BPM · plays under the whole film/);

  const r = recipe(board, { music: "Harbour theme" });
  assert.equal(r.model, "music");
  assert.deepEqual(r.for, { music: "M1" });
  assert.deepEqual(r.references, []);
  // the film is its storyboards added up (15 s + 20 s here): the track asks for exactly that
  assert.match(r.prompt, /^A 35-second instrumental piece for a short film/);
  assert.match(r.prompt, /Style: solo piano and soft strings\. Mood: hushed, then hopeful\. Tempo: 70 BPM\. Where it plays: under the whole film, low under the lines\./);
  assert.match(r.prompt, /Reference: a quiet Ghibli cue\. An original piece, not a copy\. Instrumental only, no vocals\./);
  assert.match(r.prompt, /About 35 seconds long/);
  // a song says so and drops the instrumental line; a length on the card wins over the film's
  ({ board } = applyPatch(board, { music: [{ id: "M1", vocals: "vocals", seconds: 40 }] }));
  const song = recipe(board, { music: "M1" }).prompt;
  assert.match(song, /^A 40-second song/);
  assert.doesNotMatch(song, /Instrumental only/);
  assert.throws(() => recipe(board, { music: "M9" }), /No music card M9/);
});

test("the video model does the sound, steered by the bibles: voices it can use, music from the card, names with accents", async () => {
  const { sampleText, speakerLines } = await import("../server/gen/recipes.mjs");
  // names with accents are speakers
  assert.deepEqual(speakerLines("INÈS: You changed the lock. / ZOË (V.O.): Run."), [{ who: "Inès", words: "You changed the lock.", vo: false }, { who: "Zoë", words: "Run.", vo: true }]);
  let { board } = applyPatch(base, {
    cast: [{ id: "C1", voice: { voice: "Laura", sample: "ast_short", line: "You're not broken.", notes: "bright, quick" } }, { id: "C2", voice: { voice: "Brian", sample: "ast_pipv" } }],
    music: [{ name: "Harbour theme", style: "solo piano and soft strings", mood: "hushed, then hopeful", tempo: "70 BPM", vocals: "instrumental" }],
  });
  // a sample line that's in the script is swapped for plain talk; a short one is carried on; notes ride as a tag
  const s1 = sampleText(board, board.cast[0]);
  assert.doesNotMatch(s1.text, /You're not broken/);
  assert.match(s1.text, /^\[bright, quick\] /);
  assert.ok(s1.text.split(/\s+/).length >= 12);
  assert.match(s1.note, /line from the script/);
  board = applyPatch(board, { cast: [{ id: "C1", voice: { ...board.cast[0].voice, line: "I found him first." } }] }).board;
  assert.match(sampleText(board, board.cast[0]).text, /^\[bright, quick\] I found him first\. /);
  // a voice reference the model would refuse (under 2 s) is left out, with the fix
  const v = recipe(board, { storyboard: "1" }, { durations: { ast_short: 1.5, ast_pipv: 6 } });
  assert.deepEqual(v.references.filter((r) => r.role === "voice").map((r) => r.asset_id), ["ast_pipv"]);
  assert.match(v.warnings.join(" "), /Ines's voice sample is 1\.5 s — the video model needs at least 2 s/);
  // the music is the video model's, from the card, under the voices
  assert.match(v.prompt, /Music: solo piano and soft strings; hushed, then hopeful; 70 BPM; instrumental — under the voices, never over them\./);
});

test("the production design: dense sheets styled to the project, shots from the anchors, casting sheets, the pace", async () => {
  const { pacingNotes, isShot } = await import("../server/gen/recipes.mjs");
  assert.deepEqual([grid(12), grid(16), grid(12, "9:16"), grid(16, "9:16")], [[4, 3], [4, 4], [6, 2], [8, 2]]);
  const fast = Array.from({ length: 12 }, (_, i) => ({ t: `${(i * 1.25).toFixed(2)}-${((i + 1) * 1.25).toFixed(2)}`, shot: i % 2 ? "close-up" : "wide", title: `beat ${i + 1}`, action: `beat ${i + 1} happens`, ...(i === 3 ? { line: "INES: Now!", note: "2+a TURN" } : {}) }));
  const b = applyPatch(base, {
    design: { pace: "fast", storyboard: { render: "ink", sheet: "white paper, thick black panel borders, hand-lettered notes", header: "BRAND: MOONBREW" }, bibles: { kind: "casting", detail: "light" } },
    storyboards: [{ id: "7", seconds: 15, cast: ["C1"], place: "L1", panels: fast }, { id: "8", kind: "shot", seconds: 4, cast: ["C1"], place: "L1", panels: [{ shot: "insert, macro", action: "Ines's hand flips the can open", line: "INES: Here." }] }],
  }).board;
  // a dense sheet: short labels, styled to the project, no cast strip
  const sheet = recipe(b, { storyboard: "7", make: "sheet" });
  assert.match(sheet.prompt, /one 15-second sequence: 12 shots, about 1\.3 seconds each — fast cutting/);
  assert.match(sheet.prompt, /The sheet itself: one landscape sheet — white paper, thick black panel borders, hand-lettered notes\./);
  assert.match(sheet.prompt, /on the left, with BRAND: MOONBREW; on the right "12 SHOTS · 15 SECONDS · 16:9"/);
  assert.match(sheet.prompt, /12 numbered panels in a 4 × 3 grid/);
  assert.match(sheet.prompt, /drawn in bold black-and-white ink/);
  assert.match(sheet.prompt, /one short label line: its number, its time, its shot type in capitals and its 2–3 word title/);
  // dense sheets print labels only; the line lives in the conversation
  assert.match(sheet.prompt, /04 · 0:03\.8–0:05 · CLOSE-UP · BEAT 4 — Beat 4 happens\. \[note on the panel: "2\+a TURN"\]/);
  assert.match(sheet.prompt, /Hand-letter each panel's note/);
  assert.doesNotMatch(sheet.prompt, /slim strip/);
  // its video follows the panels one for one, numbered
  const vid = recipe(applyPatch(b, { storyboards: [{ id: "7", sheet: "ast_sb7" }] }).board, { storyboard: "7" });
  assert.match(vid.prompt, /its 12 numbered panels are the shots, in order — a fast sequence, about 1\.3 s a shot, quick cuts\. Follow their order and framing\./);
  assert.match(vid.prompt, /Shot by shot:\n1\. Wide: beat 1 happens\.\n2\. Close-up: beat 2 happens\./);
  // a shot: no sheet, one continuous take from the anchors
  assert.ok(isShot(b, b.storyboards.find((x) => x.id === "8")));
  assert.throws(() => recipe(b, { storyboard: "8", make: "sheet" }), /is a shot: it's made from the anchors alone/);
  const shot = recipe(b, { storyboard: "8" });
  assert.ok(!shot.references.some((x) => x.role === "storyboard"));
  assert.deepEqual(shot.references.map((x) => x.role), ["character", "location", "voice"]);
  assert.match(shot.prompt, /One continuous shot, no cuts — insert, macro\.\nInes's hand flips the can open\.\nThe conversation, in order:\nInes: "Here\."/);
  assert.doesNotMatch(shot.warnings.join(" "), /no sheet yet/);
  // a live-action casting sheet, light
  const casting = recipe(b, { cast: "C1" });
  assert.match(casting.prompt, /^Image 1 is Ines's source design[\s\S]*Casting and wardrobe sheet/);
  assert.match(casting.prompt, /2\. Headshots \(the largest panels\): front, three-quarter and profile/);
  assert.match(casting.prompt, /4\. Four expressions/);
  assert.doesNotMatch(casting.prompt, /Silhouette|Hands:/);
  assert.match(recipe(b, { place: "L1" }).prompt, /location-scout board[\s\S]*1\. Establishing wide shot/);
  // the pace: a fast project's calm clip is noted; past a second a shot, a warning
  const slow = applyPatch(b, { storyboards: [{ id: "9", seconds: 15, panels: [{ action: "a" }, { action: "b" }, { action: "c" }, { action: "d" }] }] }).board;
  assert.match(pacingNotes(slow, ["9"]).join(" "), /Storyboard 9 has 4 shots for 15 s; the project's pace is fast \(9–12 shots/);
  const rapid = applyPatch(b, { storyboards: [{ id: "9", seconds: 10, panels: Array.from({ length: 14 }, (_, i) => ({ action: `x${i}` })) }] }).board;
  assert.match(pacingNotes(rapid, ["9"]).join(" "), /14 shots in 10 s \(0\.7 s each\)\. Past about a second a shot/);
  // short neighbouring clips with the same people in the same place: one generation
  const split = applyPatch(emptyBoard(), { storyboards: [{ id: "1", seconds: 4, cast: ["C1"], place: "L1", beat: "wake" }, { id: "2", seconds: 5, cast: ["C1"], place: "L1", beat: "whisk" }, { id: "3", seconds: 6, cast: ["C1"], place: "L2", beat: "out" }] }).board;
  assert.match(pacingNotes(split).join(" "), /Storyboards 1 and 2 have the same people in the same place and fit in one 9 s generation/);
  assert.doesNotMatch(pacingNotes(split).join(" "), /Storyboards 2 and 3 have/);
  // the design changes what a sheet was made from only once it's set
  const { fingerprint } = await import("../server/gen/recipes.mjs");
  const plain = applyPatch(base, {}).board;
  assert.equal(fingerprint(plain, { storyboard: "1", make: "sheet" }), fingerprint(applyPatch(plain, { design: { pace: "fast" } }).board, { storyboard: "1", make: "sheet" }));
  assert.notEqual(fingerprint(plain, { storyboard: "1", make: "sheet" }), fingerprint(applyPatch(plain, { design: { storyboard: { render: "ink" } } }).board, { storyboard: "1", make: "sheet" }));
});

test("a new piece's vision is locked before anything is made; boards with made work count as locked", async () => {
  const { visionLocked } = await import("../server/board.mjs");
  const fresh = applyPatch(emptyBoard(), { brief: { intent: "two women, a Paris room" }, cast: [{ id: "C1", name: "Élise" }] }).board;
  assert.equal(visionLocked(fresh), false);
  assert.equal(visionLocked(applyPatch(fresh, { brief: { locked: true } }).board), true);
  assert.equal(visionLocked(base), true); // sheets and takes already made
  assert.equal(visionLocked(applyPatch(base, { brief: { locked: false } }).board), false); // unlocked to rethink
});

test("a clip's type takes the words people and agents use for it", () => {
  const b = applyPatch(emptyBoard(), { design: { clips: "storyboards" }, storyboards: [{ id: "1", kind: "storyboard" }, { id: "2", kind: "single" }, { id: "3", kind: "sequence" }] }).board;
  assert.deepEqual(b.storyboards.map((s) => s.kind), ["sequence", "shot", "sequence"]);
  assert.equal(b.design.clips, "storyboard");
  const back = applyPatch(applyPatch(emptyBoard(), { storyboards: [{ id: "1", kind: "shot" }] }).board, { storyboards: [{ id: "1", kind: "storyboard" }] }).board;
  assert.equal(back.storyboards[0].kind, "sequence");
});

test("video runs on the original H3 for 5–15 s clips, and on H3 Max for what only it does", async () => {
  const { MODELS } = await import("../server/gen/catalog.mjs");
  const v = MODELS.video, r = MODELS["video/ref"];
  const R = (role, n) => Array.from({ length: n }, (_, i) => ({ asset_id: `a${role}${i}`, role, url: `u${i}` }));
  assert.equal(v.build({ prompt: "x", params: { duration: 5, resolution: "768P" } }, []).endpoint, "minimax/h3/text-to-video");
  assert.equal(v.build({ prompt: "x", params: { duration: 5 } }, R("first_frame", 1)).endpoint, "minimax/h3/image-to-video");
  assert.equal(v.build({ prompt: "x", params: { duration: 3 } }, []).endpoint, "minimax/h3-max/text-to-video"); // under 5 s
  assert.equal(v.build({ prompt: "x", params: { duration: 5, tier: "draft" } }, []).endpoint, "minimax/h3-max-turbo/text-to-video");
  assert.equal(v.build({ prompt: "x", params: { duration: 5, resolution: "1080P" } }, []).endpoint, "minimax/h3-max/text-to-video"); // older drafts
  assert.equal(v.price({ params: { duration: 10, resolution: "768P" } }).toFixed(2), "0.60");
  const refs = [...R("storyboard", 1), ...R("character", 2), ...R("location", 1), ...R("voice", 2)];
  const built = r.build({ prompt: "x", params: { duration: 15, resolution: "768P", aspect: "9:16" } }, refs);
  assert.equal(built.endpoint, "minimax/h3/reference-to-video");
  assert.equal(built.input.resolution, "768P"); // always sent: the original defaults to 2K
  assert.ok(!("image_url" in built.input));
  assert.equal(r.price({ params: { duration: 15, resolution: "768P" }, references: refs }).toFixed(2), "0.90");
  assert.equal(r.price({ params: { duration: 10, resolution: "480P" }, references: R("character", 7) }).toFixed(2), "0.66"); // 2 images past the free 5
  assert.equal(r.build({ prompt: "x", params: { duration: 4 } }, refs).endpoint, "minimax/h3-max/reference-to-video");
  assert.equal(r.build({ prompt: "x", params: { duration: 8 } }, [...refs, ...R("first_frame", 1)]).endpoint, "minimax/h3-max/reference-to-video");
});

test("every generation has a name a person can read", async () => {
  const { nameOfGeneration } = await import("../server/mcp/tools.mjs");
  assert.equal(nameOfGeneration({ title: "Storyboard 1 · video", model: "video/ref" }), "Storyboard 1 · video");
  assert.equal(nameOfGeneration({ label: "Test · dense storyboard", model: "video/ref" }), "Test · dense storyboard");
  assert.equal(nameOfGeneration({ model: "video/ref", prompt: "Image 1 is this clip's storyboard: follow it. Image 2 is Inès's sheet. Inès stands at the door in the rain, coat on." }), "Video with references · Inès stands at the door in…");
  assert.equal(nameOfGeneration({ model: "voice", text: "Honestly, I'd rather walk." }), "Voice line · Honestly, I'd rather walk…");
});
