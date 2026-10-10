// Recipes: a generation written from the board, ready to quote, review and edit.
//   {cast:"C1"} / {place:"L1"}         a bible sheet (GPT Image 2.5, one landscape design sheet)
//   {voice:"C1"}                        a 5–7 s voice sample in the card's voice
//   {music:"M1"}                        the music card as a track the length of the film
//   {look:"A"}                          a rough frame of the key moment in look A, to choose the look by
//   {storyboard:"2", make:"sheet"}      a storyboard sheet: numbered panels drawn from the bibles
//   {storyboard:"2"}                    the video: H3 follows the sheet's panels as one sequence
// The templates are the ones our tests settled on (2026-10-02: one 6-panel sheet → one 15 s H3
// generation that kept the panel order, the timing of the line and both characters).
import { createHash } from "node:crypto";
import { HttpError } from "../auth.mjs";
import { MODELS, VOICES } from "./catalog.mjs";
import { slots } from "./mentions.mjs";

const flat = (s) => String(s || "").trim().replace(/\s+/g, " ");
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
// a name inside a sentence: "The old pier" → "the old pier"
const named = (x) => String(x?.name || x?.id || "").replace(/^The\b/, "the");
const sentence = (s) => (s ? flat(s).replace(/[.;,:]*$/, ".") : "");
const clause = (s) => flat(s).replace(/[.;,:]+$/, "");
const round = (x) => Math.round(x * 10) / 10;
const secs = (x) => String(round(x)).replace(/\.0$/, "");
const clockT = (x) => {
  const m = Math.floor(x / 60);
  const s = round(x - m * 60);
  return `${m}:${String(s < 10 ? `0${secs(s)}` : secs(s))}`;
};
const VOICE_TOTAL_S = 15;
const MIN_VOICE_S = 2; // the video model refuses shorter voice references
const FOR_HELP = 'for must be {cast:"C1"}, {place:"L1"}, {voice:"C1"}, {music:"M1"}, {look:"A"}, {storyboard:"1", make:"sheet"} or {storyboard:"1"}.';

// "0-2.5", "0–2.5 s", "0:00–0:02.5"
const T = String.raw`(\d+(?::\d+(?:\.\d+)?)?(?:\.\d+)?)`;
const SPAN = new RegExp(`${T}\\s*s?\\s*(?:-|–|—|to)\\s*${T}`);
const toS = (v) => (String(v).includes(":") ? String(v).split(":").reduce((a, b) => a * 60 + Number(b), 0) : Number(v));

// Each panel with from/to seconds: its own times when they make sense, else an even split.
export function panelTimes(sb, seconds) {
  const panels = (sb.panels || []).filter((p) => p.action || p.shot || p.line);
  const total = seconds || sb.seconds || Math.min(15, Math.max(4, panels.length * 2.5));
  const parsed = panels.map((p) => {
    const m = String(p.t || "").match(SPAN);
    return m ? { from: toS(m[1]), to: toS(m[2]) } : null;
  });
  const ok = parsed.length > 0 && parsed.every((x, i) => x && x.to > x.from && x.to <= total + 0.6 && (i === 0 || x.from >= parsed[i - 1].from));
  return panels.map((p, i) => ({ ...p, from: ok ? parsed[i].from : round((total * i) / panels.length), to: ok ? Math.min(total, parsed[i].to) : round((total * (i + 1)) / panels.length) }));
}

// "MARA: You came back." → { who: "Mara", words: "You came back." }; "MARA (V.O.): …" is a voice-over.
export function speakerLine(line) {
  const t = flat(line);
  if (!t) return null;
  const m = t.match(/^(\p{L}[\p{L}\p{N} .'’()-]{0,36}?)\s*:\s*(.+)$/u);
  const unquote = (s) => s.replace(/^["“”']+|["“”']+$/g, "");
  if (!m) return { who: null, words: unquote(t), vo: false };
  const vo = /\bV\.?\s?O\.?\b|voice-?over/i.test(m[1]);
  // "MARA (whispering): …" carries the delivery
  const delivery = vo ? null : m[1].match(/\(([^)]{1,40})\)/)?.[1]?.trim().toLowerCase() || null;
  const who = m[1].replace(/\(?\bV\.?\s?O\.?\)?|\(?voice-?over\)?/gi, "").replace(/\([^)]*\)/g, "").trim();
  return { who: who ? who.replace(/[\p{L}\p{N}]+/gu, (w) => (w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w)) : null, words: unquote(m[2]), vo, ...(delivery ? { delivery } : {}) };
}
// A panel can hold an exchange: "TEO: Where were you? / INES: Out."
export function speakerLines(line) {
  return String(line || "")
    .split(/\s+\/\s+|\n+/)
    .map(speakerLine)
    .filter((l) => l && l.words);
}
const wordCount = (s) => (String(s).match(/[\w'’-]+/g) || []).length;

// Panels on a landscape sheet: columns × rows.
export function grid(k, aspect = "16:9") {
  const [w, h] = String(aspect).split(":").map(Number);
  const tall = w && h && w < h;
  if (tall) return k <= 6 ? [k, 1] : k <= 8 ? [4, 2] : k <= 12 ? [6, 2] : [8, 2];
  if (k <= 3) return [k, 1];
  if (k === 4) return [2, 2];
  if (k <= 6) return [3, 2];
  if (k <= 8) return [4, 2];
  if (k === 9) return [3, 3];
  if (k <= 12) return [4, 3];
  return [4, 4];
}

// The project's production design (board.design): how its sheets look and how its clips are made.
const designOf = (board) => board.design || {};
// A storyboard is drawn as a sheet unless it's a shot: one short generation from the anchors alone.
export const isShot = (board, sb) => (sb.kind ? sb.kind === "shot" : designOf(board).clips === "shots");
// Shots per 15 s for each pace (tested 2026-10-04: H3 followed a 12-panel sheet in 15 s, shot by shot).
export const PACE_SHOTS = { calm: [4, 6], measured: [6, 8], fast: [9, 12], rapid: [13, 16] };
// The project's title for a sheet's header: the plan's, else the shortest name the brief gives.
const titleOf = (board) => String(board.plan?.title || board.music?.[0]?.name || board.brief?.format || "Untitled").toUpperCase();

function find(list, id, what) {
  const x = list.find((c) => c.id === id || (c.name && c.name.toLowerCase() === String(id).toLowerCase()));
  if (!x) throw new HttpError(400, `No ${what} ${id} on the board. It has: ${list.map((c) => `${c.id} ${c.name || ""}`.trim()).join(", ") || "none yet"}.`, "unknown_board_item");
  return x;
}
const sheetOf = (card) => (card?.refs || []).find((r) => r.use === "sheet")?.asset_id || null;
const sourcesOf = (card) => (card?.refs || []).filter((r) => r.use !== "sheet").map((r) => r.asset_id);
const isObject = (c) => c.kind === "product" || c.kind === "prop";
const styleLine = (board) => (board.look?.style ? sentence(board.look.style) : "");
const voiceWords = (c) => c.voice?.notes || (c.voice?.voice && VOICES[c.voice.voice] ? VOICES[c.voice.voice].split(" — ")[0] : "");

// ---------------------------------------------------------------- voice samples

// A voice sample is the voice the video model copies: it should be 5–8 s of the character talking,
// and never a line from the script — the model would reproduce that very recording in the scene.
// The card's line is used when it's long enough and not in the script; otherwise it's carried on (or
// replaced) with plain in-character talk. Delivery notes ride along as a tag ("[low, unhurried]").
const FILLERS = [
  "Honestly, I didn't think I'd end up here tonight. But here we are, so let's not waste it, alright?",
  "You know what I keep coming back to? How quiet it gets right before something changes. Like right now.",
  "I'll tell you the truth, but only once, so listen properly. I'm not going to say it a second time.",
  "Funny thing is, I always knew it would come to this. I just thought I'd have a little more time.",
];
const norm = (t) => String(t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
const wordsIn = (t) => String(t || "").split(/\s+/).filter(Boolean).length;
export function sampleText(board, c) {
  const script = new Set(board.storyboards.flatMap((sb) => (sb.panels || []).flatMap((p) => speakerLines(p.line).map((l) => norm(l.words)))));
  const line = String(c.voice?.line || "").trim();
  const filler = FILLERS[Math.max(0, board.cast.indexOf(c)) % FILLERS.length];
  const fromScript = line && script.has(norm(line));
  let text = !line || fromScript ? filler : wordsIn(line) >= 10 ? line : `${line} ${filler}`;
  const notes = String(c.voice?.notes || "").trim();
  if (notes && notes.length <= 60) text = `[${notes.replace(/[[\]]/g, "")}] ${text}`;
  const note = fromScript ? `${c.name || c.id}'s sample line is a line from the script; the sample says something else, so the scene isn't a copy of it.` : null;
  return { text, note };
}

// ---------------------------------------------------------------- looks

// The people a look frame shows: the ones the moment names, else the leads (up to three).
function keyCast(board) {
  const moment = String(board.look?.moment || "").toLowerCase();
  const named_ = board.cast.filter((c) => c.name && moment.includes(c.name.toLowerCase()));
  return (named_.length ? named_ : board.cast.filter((c) => !isObject(c))).slice(0, 3);
}

// One rough frame of the piece's key moment in a candidate look: what the person compares looks by.
// The same moment and people in every option, so only the look differs.
function lookFramePrompt(board, o, cast, aspect) {
  const moment = board.look?.moment || board.brief?.premise || board.brief?.intent || "the opening moment of the film";
  const place = board.places[0];
  const people = cast.map((c) => `${c.name || "Someone"}: ${clause([c.age, c.look, c.outfit].filter(Boolean).join(", ") || c.role || "as described")}.`);
  return [
    `One still frame from the film${board.plan?.title ? ` "${board.plan.title}"` : ""}, made to choose its look.`,
    `The moment: ${sentence(moment)}`,
    ...people,
    place ? `Where: ${named(place)}${place.look ? `, ${clause(place.look)}` : ""}${place.time ? `, ${clause(place.time)}` : ""}${place.weather ? `, ${clause(place.weather)}` : ""}.` : null,
    `The look: ${sentence(o.style || o.name || "")}`,
    `Composed as a ${board.brief?.aspect || aspect || "16:9"} frame. A finished-looking frame in that look — not a sketch, no text, no captions, no borders.`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------- music

// How long the film is: what the brief says, else its storyboards added up.
const filmSeconds = (board) => board.brief?.seconds || (board.storyboards || []).reduce((t, s) => t + (s.seconds || 0), 0) || 0;

// A music card as a Lyria prompt: the length first, what it sounds like, where it plays, and the vocals
// said plainly. A reference is a direction in words, never a copy. The fields are the agent's or the
// person's own sentences, so each goes under a label rather than inside one of ours. Lyria treats the
// length as a guide (asked for 15 s, it made 35 s): the timeline trims it.
export function musicPrompt(m, board) {
  const seconds = Math.round(m.seconds || filmSeconds(board) || 30);
  const vocal = m.vocals === "vocals";
  const tone = board.brief?.tone || board.brief?.intent;
  return [
    `A ${seconds}-second ${vocal ? "song" : "instrumental piece"} for a short film${tone ? ` (${clause(tone)})` : ""}.`,
    m.style && `Style: ${sentence(m.style)}`,
    m.mood && `Mood: ${sentence(m.mood)}`,
    m.tempo && `Tempo: ${sentence(m.tempo)}`,
    m.where && `Where it plays: ${sentence(m.where)}`,
    m.reference && `Reference: ${sentence(m.reference)} An original piece, not a copy.`,
    m.notes && sentence(m.notes),
    vocal ? null : "Instrumental only, no vocals.",
    `About ${seconds} seconds long, ending cleanly rather than fading out.`,
  ]
    .filter(Boolean)
    .join(" ");
}

// ---------------------------------------------------------------- bible sheets

// A character's bible sheet, in the kind the project calls for: an animation model sheet (the default)
// or a live-action casting board, full or light. Light sheets have fewer, bigger panels: what the
// video model needs most is a large, sharp face and the full figure.
function characterSheet(c, board) {
  const d = designOf(board).bibles || {};
  const light = d.detail === "light";
  const head = [c.role && `Role: ${clause(c.role)}.`, c.age && `Age: ${clause(c.age)}.`, c.personality && `Personality: ${clause(c.personality)}.`, c.theme && `Core theme: ${clause(c.theme)}.`, voiceWords(c) && `Voice: ${clause(voiceWords(c))}.`].filter(Boolean).join(" ");
  const fields = [c.role && "Role", c.age && "Age", c.personality && "Personality", c.theme && "Core theme", voiceWords(c) && "Voice"].filter(Boolean);
  const about = [
    `Character: ${String(c.name || c.id).toUpperCase()}. ${head}`.trim(),
    c.look || c.outfit ? `Design: ${[clause(c.look), c.outfit && `wearing ${clause(c.outfit)}`].filter(Boolean).join("; ")}.` : null,
    c.contrast ? `Tell them apart: ${sentence(c.contrast)}` : null,
    styleLine(board) ? `Style: ${styleLine(board)}` : null,
  ];
  const header = `1. Header (top left): the name in large letters${fields.length ? `, then ${fields.join(", ")}` : ""}.`;
  if (d.kind === "casting")
    return [
      `Casting and wardrobe sheet: one landscape sheet — ${d.sheet ? clause(d.sheet) : "a clean light-grey studio backdrop"} — laid out like a film's casting board, with small, clean labels.`,
      "",
      ...about,
      "",
      "Panels:",
      header,
      "2. Headshots (the largest panels): front, three-quarter and profile — large and sharp, even soft light, a neutral expression.",
      `3. Full body, front and back, ${c.outfit ? `in ${clause(c.outfit)}` : "in the outfit"}, with a height mark.`,
      light ? "4. Four expressions: neutral, a smile, worried, determined." : "4. Six expressions: neutral, a smile, laughing, worried, angry, determined.",
      light ? null : `5. Wardrobe and props: close-ups of ${c.outfit ? clause(c.outfit) : "the outfit's key details"}.`,
      light ? null : "6. Colour palette: 6 swatches with hex codes.",
      "",
      "Photographic and true to life: natural skin texture, real fabric, the same person in every photograph. Only this person on the sheet. No blur, no watermark.",
    ].filter((l) => l !== null).join("\n");
  return [
    `Character bible sheet: one landscape model sheet — ${d.sheet ? clause(d.sheet) : "a clean warm-white background"} — laid out in neat labelled panels with small, clean sans-serif type, like a professional animation studio's character bible.`,
    "",
    ...about,
    "",
    "Panels:",
    header,
    ...(light
      ? [
          "2. Main identity and scale (the largest panel): full-body turnaround — front, three-quarter, side, back — same scale, neutral standing pose.",
          "3. Faces: a large front and a large three-quarter head shot, sharp and evenly lit.",
          "4. Expressions: 4 head shots — neutral, happy, worried, determined.",
          "5. Colour palette: 6 swatches with hex codes.",
        ]
      : [
          "2. Colour palette: 6 swatches with hex codes.",
          "3. Main identity and scale (the largest panel): full-body turnaround — front, three-quarter, side, back — same scale, neutral standing pose, with a height ruler.",
          "4. Expressions: 8 head shots in a row — neutral, happy, laughing, curious, surprised, worried, sad, determined.",
          "5. Head detail: three-quarter, profile, from above, from below.",
          `6. Outfit and props: close-ups of ${c.outfit ? clause(c.outfit) : "the outfit's key details"}.`,
          "7. Hands: 4 gestures — open palm, pointing, holding something, a small wave.",
          "8. Silhouette: solid black silhouettes of the front and side views.",
          `9. Notes: 3 short design notes${c.notes ? ` — ${clause(c.notes)}` : ""}.`,
        ]),
    "",
    `Every view shows exactly the same character: same face, proportions, hair, colours and outfit. Only this character on the sheet. Even, soft studio light, crisp detail, no blur, no watermark.`,
  ].filter((l) => l !== null).join("\n");
}
function objectSheet(c, board) {
  const kind = c.kind === "product" ? "Product" : "Prop";
  const d = designOf(board).bibles || {};
  if (d.detail === "light")
    return [
      `Design bible sheet: one landscape sheet — ${d.sheet ? clause(d.sheet) : "a clean warm-white background"} — with small, clean labels.`,
      "",
      `${kind}: ${String(c.name || c.id).toUpperCase()}.${c.role ? ` Role: ${clause(c.role)}.` : ""}`,
      c.look ? `Design: ${sentence(c.look)}` : null,
      c.label ? `Its label reads exactly: "${clause(c.label)}" — spelled exactly so, and no other text on it.` : null,
      styleLine(board) ? `Style: ${styleLine(board)}` : null,
      "",
      "Panels:",
      "1. Header (top left): the name in large letters.",
      `2. Main views (the largest panel): front, three-quarter, side and back, same scale${c.kind === "product" ? ", with a hand for scale" : ""}.`,
      "3. Detail close-ups: the label and the key parts, large and sharp.",
      "4. Colour and material palette: 6 swatches.",
      "",
      "Every view shows exactly the same object: same shape, proportions, colours, materials and markings. Even, soft studio light, crisp detail, no blur, no watermark.",
    ].filter((l) => l !== null).join("\n");
  return [
    `Design bible sheet: one landscape sheet — ${d.sheet ? clause(d.sheet) : "a clean warm-white background"} — laid out in neat labelled panels with small, clean sans-serif type, like a professional ${c.kind === "product" ? "product" : "prop"} design bible.`,
    "",
    `${kind}: ${String(c.name || c.id).toUpperCase()}.${c.role ? ` Role: ${clause(c.role)}.` : ""}${c.theme ? ` Core theme: ${clause(c.theme)}.` : ""}`,
    c.look ? `Design: ${sentence(c.look)}` : null,
    c.label ? `Its label reads exactly: "${clause(c.label)}" — spelled exactly so, and no other text on it.` : null,
    styleLine(board) ? `Style: ${styleLine(board)}` : null,
    "",
    "Panels:",
    "1. Header (top left): the name in large letters, then Type, Role and 2–3 key facts.",
    "2. Colour and material palette: 6 swatches with hex codes and material names.",
    `3. Main identity and scale (the largest panel): front, three-quarter, side, back and top views, same scale, with a ruler${c.kind === "product" ? " and a hand for scale" : ""}.`,
    "4. States: 4 views of how it looks in use — e.g. closed, open, in use, and its key feature up close.",
    "5. Detail close-ups: materials, logo or label, key parts.",
    "6. In context: it in a typical setting, at real scale.",
    "7. Silhouette: solid black silhouettes of the front and side views.",
    `8. Notes: 3 short design notes${c.notes ? ` — ${clause(c.notes)}` : ""}.`,
    "",
    "Every view shows exactly the same object: same shape, proportions, colours, materials and markings. Even, soft studio light, crisp detail, no blur, no watermark.",
  ].filter((l) => l !== null).join("\n");
}

function placeSheet(p, board) {
  const head = [p.time && `Time of day: ${clause(p.time)}.`, p.weather && `Weather: ${clause(p.weather)}.`, p.mood && `Mood: ${clause(p.mood)}.`].filter(Boolean).join(" ");
  const fields = [p.time && "Time of day", p.weather && "Weather", p.mood && "Mood"].filter(Boolean);
  const d = designOf(board).bibles || {};
  const paper = d.sheet ? clause(d.sheet) : "a clean warm-white background";
  if (d.detail === "light")
    return [
      `Location bible sheet: one landscape sheet — ${paper} — with small, clean labels${d.kind === "casting" ? ", like a film's location-scout board of photographs" : ""}.`,
      "",
      `Place: ${String(p.name || p.id).toUpperCase()}. ${head}`.trim(),
      p.look ? `Design: ${sentence(p.look)}` : null,
      styleLine(board) ? `Style: ${styleLine(board)}` : null,
      "",
      "Panels:",
      "1. Establishing wide shot (the largest panel).",
      "2. Reverse angle: looking back the other way.",
      "3. The main area where the action happens.",
      `4. Lighting note: ${p.light ? clause(p.light) : "the key light direction and colour"} — fixed for every shot.`,
      "",
      "No people, characters or animals anywhere on the sheet. Crisp detail, no blur, no watermark.",
    ].filter((l) => l !== null).join("\n");
  return [
    `Location bible sheet: one landscape sheet — ${paper} — laid out in neat labelled panels with small, clean sans-serif type, like a professional ${d.kind === "casting" ? "film location-scout board of photographs" : "animation studio's set design bible"}.`,
    "",
    `Place: ${String(p.name || p.id).toUpperCase()}. ${head}`.trim(),
    p.look ? `Design: ${sentence(p.look)}` : null,
    styleLine(board) ? `Style: ${styleLine(board)}` : null,
    "",
    "Panels:",
    `1. Header (top left): the name in large letters${fields.length ? `, then ${fields.join(", ")}` : ""}.`,
    "2. Colour palette: 6 swatches with hex codes.",
    "3. Establishing wide shot (the largest panel).",
    "4. Reverse angle: looking back the other way.",
    "5. A medium view of the main area where the action happens.",
    "6. Three detail close-ups: textures and props.",
    "7. A simple top-down plan marking the main features.",
    `8. Lighting note: ${p.light ? clause(p.light) : "the key light direction and colour"} — fixed for every shot.`,
    "",
    "No people, characters or animals anywhere on the sheet. Crisp detail, no blur, no watermark.",
  ].filter((l) => l !== null).join("\n");
}

// Bindings in front of an image prompt: what each reference image is.
function imageBindings(model, refs, describe) {
  const out = [];
  for (const s of slots(model, refs)) {
    const line = describe(refs[s.i]);
    if (line) out.push(`${s.label[0].toUpperCase()}${s.label.slice(1)} is ${line}`);
  }
  return out;
}

// ---------------------------------------------------------------- storyboards

const castIn = (board, sb) => (sb.cast || []).map((id) => find(board.cast, id, "cast member"));
const placeIn = (board, sb) => (sb.place ? find(board.places, sb.place, "place") : null);
const indexOf = (board, sb) => board.storyboards.findIndex((x) => x.id === sb.id);
const prevOf = (board, sb) => board.storyboards[indexOf(board, sb) - 1] || null;


// How a storyboard's panels are drawn.
const RENDER = {
  frames: (look) => `rendered as a finished frame in the final look: ${clause(look)}`,
  sketch: () => "drawn as a clean pencil storyboard sketch with light colour accents",
  ink: () => "drawn in bold black-and-white ink with storyboard energy — strong silhouettes, dramatic angles, speed lines where things move",
};

function storyboardSheetPrompt(board, sb, refs, ctx) {
  const n = indexOf(board, sb) + 1;
  const panels = panelTimes(sb, ctx.seconds);
  const k = panels.length;
  const [cols, rows] = grid(k, ctx.aspect);
  const d = designOf(board).storyboard || {};
  const dense = k > 8;
  const captions = d.captions || (dense ? "short" : "full");
  const render = RENDER[sb.style === "sketch" || sb.style === "ink" ? sb.style : d.render] || RENDER.frames;
  const cast = castIn(board, sb);
  const place = placeIn(board, sb);
  const bind = imageBindings("image", refs, (r) =>
    r.lastFrame
      ? "the last frame of the previous sequence's video: panel 1 picks up right after this moment — the same people, places, positions, light, wardrobe and props."
      : r.role === "storyboard"
      ? ctx.continues
        ? "the storyboard of the previous sequence: this sequence continues straight on from its last panel, with the same characters, costumes, props, light and sheet layout."
        : "the storyboard of the previous sequence: keep its sheet layout, drawing style and characters; this sequence is a new scene."
      : r.role === "style"
        ? "the look reference: match its palette, light and texture, not its content."
        : r.label
          ? `${r.label}: draw ${r.role === "location" ? "it" : "them"} exactly as designed there — same ${r.role === "location" ? "layout, light and colours" : "face, proportions, colours and outfit"}.`
          : null,
  );
  const look = styleLine(board) || "the look of the bible sheets";
  const lineOf = (l) => `${l.who ? `${l.who.toUpperCase()}${l.vo ? " (V.O.)" : l.delivery ? ` (${l.delivery})` : ""}: ` : ""}"${l.words}"`;
  const lines = panels.map((p, i) => {
    const said = captions === "full" ? speakerLines(p.line).map(lineOf).join(" ") : "";
    const num = String(i + 1).padStart(2, "0");
    const head = [num, `${clockT(p.from)}–${clockT(p.to)}`, p.shot && clause(p.shot).toUpperCase(), captions === "short" && p.title && clause(p.title).toUpperCase()].filter(Boolean).join(" · ");
    return `${head} — ${cap(sentence(p.action))}${said ? ` ${said}` : ""}${p.note ? ` [note on the panel: "${clause(p.note)}"]` : ""}`;
  });
  const captionRule =
    captions === "labels"
      ? "Each panel carries only its number, small, in a corner — no other text."
      : captions === "short"
        ? "Under each panel, one short label line: its number, its time, its shot type in capitals and its 2–3 word title."
        : "Under each panel, a short caption: number, time, shot and camera, action, and any line in quotes.";
  const notes = panels.some((p) => p.note) ? "Hand-letter each panel's note inside its frame, small and bold, like a storyboard artist's annotation." : null;
  return [
    ...bind,
    bind.length ? "" : null,
    ctx.ended ? `Where the previous sequence ended: ${sentence(ctx.ended)}` : null,
    `Make a storyboard sheet for one ${secs(ctx.seconds)}-second sequence: ${k} shot${k > 1 ? "s" : ""}${dense ? `, about ${secs(ctx.seconds / k)} seconds each — fast cutting` : ""}.`,
    `The sheet itself: one landscape sheet — ${d.sheet ? clause(d.sheet) : "clean warm-white paper, like a professional storyboard"}.`,
    `Header across the top: "${titleOf(board)} — SEQUENCE ${n}" on the left${d.header ? `, with ${clause(d.header)}` : ""}; on the right "${k} SHOT${k > 1 ? "S" : ""} · ${secs(ctx.seconds)} SECONDS · ${ctx.aspect}"${sb.mood ? `; under it, small: "${clause(sb.mood)}"` : ""}.`,
    `${k} numbered panel${k > 1 ? "s" : ""} in a ${cols} × ${rows} grid, in reading order. Each panel is a ${ctx.aspect} frame ${render(look)}.`,
    captionRule,
    notes,
    ...lines,
    !dense && captions === "full"
      ? `Along the bottom, a slim strip: the cast (small full-body figures of ${cast.length ? cast.map((c) => c.name || c.id).join(" and ") : "the characters"} with their names)${place ? `, a small thumbnail of ${named(place)}` : ""}, and 6 palette swatches.`
      : null,
    `Large, sharp subjects; one clear action per panel; consistent characters in every panel.${!dense && captions === "full" ? "" : " No cast strip, no swatches, no other text."} No watermark.`,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

// The video prompt is loose on purpose: the model is good at shots, timing, performance and sound. What
// it can't know is what must stay the same from one generation to the next (the anchors: sheets,
// voices, the look, the music card) and where the clip sits in the story — so the prompt binds the
// anchors, says where we are, and tells what happens and who says what, in order, without timecodes.
function storyboardVideoPrompt(board, sb, model, refs, ctx) {
  const L = [];
  const bind = [];
  const k = panelTimes(sb, ctx.seconds).length;
  const dense = k > 8;
  const shot = isShot(board, sb);
  let drawn = false;
  for (const s of slots(model, refs)) {
    const r = refs[s.i];
    if (r.role === "storyboard") {
      drawn = true;
      // a dense sheet is followed panel for panel; a calmer one leaves the cutting to the model
      bind.push(
        dense
          ? `${s.label} is this clip's storyboard: its ${k} numbered panels are the shots, in order — a fast sequence, about ${secs(ctx.seconds / k)} s a shot, quick cuts. Follow their order and framing.`
          : `${s.label} is this clip's storyboard: its panels are the shots, in order. Follow the story they tell, and let the cuts, camera and timing play naturally.`,
        "The storyboard and the sheets are guidance only: never show panel borders, captions, labels, colour swatches or any text from them.",
      );
    } else if (s.kind === "audio") bind.push(`${s.label} is ${r.label}'s voice; when ${r.label} speaks, it's this voice.`);
    else if (r.describe) bind.push(`${s.label} is ${r.describe}`);
  }
  if (bind.length) L.push(bind.join(" "), "Keep every character, product and place as in their sheets.");
  if (styleLine(board)) L.push(`Look: ${styleLine(board)}`);
  L.push(...storyContext(board, sb, ctx));
  if (sb.mood) L.push(`Mood: ${sentence(sb.mood)}`);
  L.push(...(shot ? oneShot(sb, ctx.seconds) : whatHappens(sb, ctx.seconds, { shots: !drawn || dense, numbered: dense })));
  L.push(soundLine(board, sb));
  // titles and captions go in the editor; generated text comes out garbled
  L.push("No on-screen text.");
  return L.join("\n");
}

// The dialogue of a clip as one conversation, in order, played across the shots rather than a line
// pinned to each panel: people talk over cuts and reactions, pause where the meaning lands, breathe.
// Quoted lines keep their words; a line written as a gist ("SOFIA (gist): teases her about the key")
// is said in the character's own words. numbered: the clip's shots are numbered, so each line says
// roughly where it falls.
const GIST = /\b(gist|ad[ -]?lib|own words|improv)/i;
function conversation(sb, seconds, { numbered } = {}) {
  const lines = panelTimes(sb, seconds).flatMap((p, i) => speakerLines(p.line).map((l) => ({ ...l, shot: i + 1 })));
  if (!lines.length) return [];
  const rows = lines.map((l) => {
    const gist = l.delivery && GIST.test(l.delivery);
    const how = [l.vo ? "voice-over" : null, l.delivery && !gist ? l.delivery : null, numbered ? `around shot ${l.shot}` : null].filter(Boolean);
    const who = `${l.who || "Someone"}${how.length ? ` (${how.join(", ")})` : ""}`;
    return gist ? `${who}, in their own words: ${clause(l.words)}.` : `${who}: "${l.words}"`;
  });
  return [`The conversation, in order${numbered ? " — the shot numbers only say roughly where each line falls" : ""}:`, ...rows, TALK];
}
const TALK = "Play it as a real conversation, not lines read out in turn: a line can start before a cut and carry over the next shot or the listener's face; pauses where the meaning lands; a breath, a half-laugh, a small overlap where it's natural. Their own voices and timing. Quoted lines keep their words.";

// A shot: one short, precise generation from the anchors alone — its framing and camera, what
// happens, who says what, without cuts.
function oneShot(sb, seconds) {
  const ps = panelTimes(sb, seconds);
  const frame = ps.find((p) => p.shot)?.shot;
  const beats = ps.map((p) => (p.action ? sentence(p.action) : "")).filter(Boolean);
  const action = beats.map((b, i) => (i ? `Then ${b.replace(/^[A-Z](?![A-Z])/, (c) => c.toLowerCase())}` : cap(b))).join(" ");
  return [`One continuous shot, no cuts${frame ? ` — ${clause(frame)}` : ""}.`, ...(action ? [action] : []), ...conversation(sb, seconds)];
}

// Where the clip sits, so each generation plays its part in the whole: which clip of how many (the
// opening hooks, the last lands the ending), how the last take actually ended, and this clip's beat —
// what changes in it.
function storyContext(board, sb, ctx) {
  const list = board.storyboards.filter((s) => s.status !== "cut");
  const i = list.findIndex((s) => s.id === sb.id);
  const story = board.plan?.logline || board.brief?.intent;
  const out = [];
  if (list.length > 1) out.push(`Clip ${i + 1} of ${list.length}${story ? ` of ${clause(story).replace(/^(A|An|The)\b/, (w) => w.toLowerCase())}` : ""}.${i === 0 ? " The opening: it hooks from the first second." : i === list.length - 1 ? " The last clip: it lands the ending." : ""}`);
  else if (story) out.push(`The story: ${sentence(story)}`);
  if (ctx.ended) out.push(`It picks up right after the last clip: ${sentence(ctx.ended)}`);
  if (sb.beat) out.push(`This clip: ${sentence(sb.beat)}`);
  return out;
}

// What happens, in order and in plain words, with who says what. The storyboard carries the shots
// (without one, each beat says its shot); the timing and the performance are the model's.
function whatHappens(sb, seconds, { shots, numbered }) {
  const beats = panelTimes(sb, seconds).map((p) => {
    const shot = shots && p.shot ? `${cap(clause(p.shot))}: ` : "";
    // a panel that's only a line still holds its place in the numbering: it's on the speaker
    const who = speakerLines(p.line)[0]?.who;
    const act = p.action ? (shot ? sentence(p.action) : cap(sentence(p.action))) : who ? `On ${who}.` : "";
    return `${shot}${act}`.trim();
  });
  // numbered like the sheet's panels when it's dense
  const listed = numbered ? beats.map((b, i) => (b ? `${i + 1}. ${b}` : null)).filter(Boolean) : beats.filter(Boolean).map((b) => `– ${b}`);
  return [...(listed.length ? [numbered ? "Shot by shot:" : "What happens, in order:", ...listed] : []), ...conversation(sb, seconds, { numbered })];
}
// The sound, and silence spelled out when nobody speaks (otherwise the model may invent speech). The
// music is the video model's too: the music card's style, mood and tempo in every clip keep it of a
// piece across the cuts; without a card the model scores the moment itself.
function soundLine(board, sb) {
  const sound = sb.sound || placeIn(board, sb)?.sound;
  const talks = (sb.panels || []).some((p) => speakerLines(p.line).length);
  const m = (board.music || [])[0];
  const music = /music/i.test(sound || "") || !m ? "" : `\nMusic: ${[m.style, m.mood, m.tempo, m.vocals === "vocals" ? "with vocals" : "instrumental"].filter(Boolean).map(clause).join("; ")}${talks ? " — under the voices, never over them" : ""}.`;
  return `Sound: ${sound ? clause(sound) : "natural sound of the scene"}${talks ? "" : "; no spoken dialogue"}.${music}`;
}

function extendPrompt(board, sb, seconds) {
  const beats = panelTimes(sb, seconds).map((p) => (p.action ? sentence(p.action) : "")).filter(Boolean);
  return [`Carry the shot straight on. ${beats.map((b, i) => (i === 0 ? cap(b) : `Then ${b[0].toLowerCase()}${b.slice(1)}`)).join(" ")}`, ...conversation(sb, seconds), soundLine(board, sb)].join("\n");
}

// ---------------------------------------------------------------- the recipe

const describeCard = (c) => `${named(c)}'s ${isObject(c) ? "design" : "character"} sheet${c.look ? `: ${clause(c.look)}` : ""}${c.outfit ? `. Wearing ${clause(c.outfit).replace(/^(A|An|The)\b/, (w) => w.toLowerCase())}` : ""}${c.contrast ? `. ${clause(c.contrast)}` : ""}.`;
const describePlace = (p) => `${named(p)}'s location sheet${p.look ? `: ${clause(p.look)}` : ""}.`;

// deps: { durations: {asset_id: seconds}, aspect: "16:9" }  → { model, prompt, text, params, references, label, title, for, warnings }
export function recipe(board, spec, deps = {}) {
  if (!spec || typeof spec !== "object") throw new HttpError(400, FOR_HELP, "bad_for");
  // one thing at a time: {cast} and {place} together would draw one card's sheet under the other's name
  const named_ = ["cast", "place", "voice", "look", "music", "storyboard"].filter((k) => spec[k] !== undefined && spec[k] !== null && spec[k] !== "");
  if (named_.length > 1) throw new HttpError(400, `for names one thing to make, but this names ${named_.join(" and ")}. Ask for each separately. ${FOR_HELP}`, "bad_for");
  const warnings = [];
  const aspect = board.brief?.aspect || deps.aspect || "16:9";
  const sheetParams = { aspect: "16:9", size: "2K", quality: "high" };
  const lookRef = board.look?.refs?.[0]?.asset_id;

  if (spec.cast || spec.place) {
    const card = spec.cast ? find(board.cast, spec.cast, "cast member") : find(board.places, spec.place, "place");
    const refs = sourcesOf(card).map((a) => ({ asset_id: a, role: spec.place ? "location" : isObject(card) ? "subject" : "character" }));
    // The sheets set the look between them: without a look frame, a person's sheet takes its style from
    // a place's sheet and a place's from a person's — never another person's, so no face carries over.
    const styleFrom = lookRef || (spec.place ? board.cast.filter((c) => !isObject(c)).map(sheetOf).find(Boolean) : board.places.map(sheetOf).find(Boolean));
    if (styleFrom) refs.push({ asset_id: styleFrom, role: "style" });
    const bind = imageBindings("image", refs, (r) =>
      r.role === "style"
        ? lookRef
          ? "the look reference: match its palette, light and texture, not its content."
          : `the look reference — ${spec.place ? "a character's sheet" : "a place's sheet"} from this film: match its rendering style, palette, light and texture exactly, not its content${spec.place ? " (no people on this sheet)" : ""}.`
        : `${card.name || card.id}'s source ${spec.place ? "image" : "design"}: keep ${spec.place ? "this exact place — layout, light and colours" : "this exact design — face, proportions, hair, colours and outfit"}, and lay it out as the sheet below.`,
    );
    const body = spec.place ? placeSheet(card, board) : isObject(card) ? objectSheet(card, board) : characterSheet(card, board);
    return {
      model: "image",
      prompt: [...bind, bind.length ? "" : null, body].filter((l) => l !== null).join("\n"),
      params: sheetParams,
      references: refs,
      label: `${card.name || card.id} · bible`,
      title: `${card.name || card.id} · ${spec.place ? "location" : isObject(card) ? "design" : "character"} bible`,
      for: spec.cast ? { cast: card.id } : { place: card.id },
      warnings,
    };
  }

  if (spec.voice) {
    const c = find(board.cast, spec.voice, "cast member");
    const s = sampleText(board, c);
    if (s.note) warnings.push(s.note);
    if (!c.voice?.voice) warnings.push(`${c.name || c.id} has no voice on their card yet; using Rachel. Set voice.voice on the card to change it.`);
    return { model: "voice", text: s.text, params: { voice: c.voice?.voice || "Rachel" }, references: [], label: `${c.name || c.id} · voice`, title: `${c.name || c.id} · voice sample`, for: { voice: c.id }, warnings };
  }

  if (spec.look) {
    const o = find(board.look?.options || [], String(spec.look).toUpperCase(), "look");
    const cast = keyCast(board);
    const refs = cast.flatMap((c) => sourcesOf(c).slice(0, 1).map((a) => ({ asset_id: a, role: isObject(c) ? "subject" : "character" }))).slice(0, 3);
    const bind = imageBindings("image", refs, (r) => `a design to keep for ${named(cast.find((c) => sourcesOf(c)[0] === r.asset_id) || {})}: same face, proportions and colours, redrawn in the look below.`);
    return {
      model: "image",
      prompt: [...bind, bind.length ? "" : null, lookFramePrompt(board, o, cast, deps.aspect)].filter((l) => l !== null).join("\n"),
      params: { aspect: board.brief?.aspect || deps.aspect || "16:9", size: "1K", quality: "medium" },
      references: refs,
      label: `Look ${o.id}`,
      title: `Look ${o.id}${o.name ? ` · ${o.name}` : ""}`,
      for: { look: o.id },
      warnings,
    };
  }

  if (spec.music) {
    const m = find(board.music || [], spec.music, "music card");
    return { model: "music", prompt: musicPrompt(m, board), params: {}, references: [], label: `${m.name || m.id} · music`, title: `${m.name || m.id} · music`, for: { music: m.id }, warnings };
  }

  if (spec.storyboard) {
    const sb = board.storyboards.find((x) => x.id === String(spec.storyboard));
    if (!sb) throw new HttpError(400, `No storyboard ${spec.storyboard} on the board. It has: ${board.storyboards.map((s) => s.id).join(", ") || "none yet"}.`, "unknown_storyboard");
    const prev = prevOf(board, sb);
    if (!(sb.panels || []).length)
      throw new HttpError(
        400,
        `Storyboard ${sb.id} is still an outline${sb.beat ? ` ("${sb.beat.slice(0, 80)}")` : ""}. Write its panels first with board_update${prev ? `, picking up from how storyboard ${prev.id} ended${prev.ended ? "" : " (watch its take and set its ended note)"}` : ""}: storyboards:[{id:"${sb.id}", panels:[{t:"0-2.5", shot, action, line}]}].`,
        "no_panels",
      );
    const cast = castIn(board, sb);
    const place = placeIn(board, sb);
    const continues = !!(prev && place && prev.place === place.id);
    const ahead = board.storyboards.slice(0, indexOf(board, sb)).filter((s) => s.status !== "cut" && !(s.takes || []).length);
    if (ahead.length)
      warnings.push(`Storyboard${ahead.length > 1 ? "s" : ""} ${ahead.map((s) => s.id).join(", ")} ${ahead.length > 1 ? "have" : "has"} no take yet. Clip by clip keeps the film joined up — each storyboard starts from how the last take actually ended — so make this one ahead only when they want a few at once.`);

    if (spec.make === "sheet") {
      if (isShot(board, sb)) throw new HttpError(400, `Storyboard ${sb.id} is a shot: it's made from the anchors alone, without a sheet. Make its video, or set kind:"sequence" to draw it as a storyboard first.`, "shot_has_no_sheet");
      const seconds = Math.min(30, sb.seconds || 15);
      const refs = [];
      for (const c of cast) {
        const a = sheetOf(c);
        if (a) refs.push({ asset_id: a, role: isObject(c) ? "subject" : "character", label: `${named(c)}'s ${isObject(c) ? "design" : "character"} sheet` });
        else warnings.push(`${c.name || c.id} has no bible sheet yet, so the panels draw them from words only. Make it first: for:{cast:"${c.id}"}.`);
      }
      if (place) {
        const a = sheetOf(place);
        if (a) refs.push({ asset_id: a, role: "location", label: `${named(place)}'s location sheet` });
        else warnings.push(`${place.name || place.id} has no location sheet yet. Make it first: for:{place:"${place.id}"}.`);
      }
      if (prev?.sheet) refs.push({ asset_id: prev.sheet, role: "storyboard" });
      // where the previous storyboard's chosen take actually ended: panel 1 starts from that frame
      const fromTake = prev?.last_frame && prev.last_from && (prev.last_from === prev.pick || (!prev.pick && prev.last_from === (prev.takes || []).slice(-1)[0]));
      if (fromTake) refs.push({ asset_id: prev.last_frame, role: "storyboard", lastFrame: true });
      else if (prev && (prev.takes || []).length) warnings.push(`Storyboard ${prev.id}'s take has no saved last frame, so panel 1 can't start from it.`);
      if (lookRef) refs.push({ asset_id: lookRef, role: "style" });
      return {
        model: "image",
        prompt: storyboardSheetPrompt(board, sb, refs, { seconds, aspect, continues, ended: prev?.ended }),
        params: sheetParams,
        references: refs.map(({ asset_id, role }) => ({ asset_id, role })),
        label: `Storyboard ${sb.id} · sheet`,
        title: `Storyboard ${sb.id} · sheet`,
        for: { storyboard: sb.id, make: "sheet" },
        warnings,
      };
    }

    // the video
    if (sb.start === "extend") {
      const src = prev && (prev.pick || (prev.takes || []).slice(-1)[0]);
      if (!src) throw new HttpError(400, `Storyboard ${sb.id} continues the previous take (start:"extend"), but storyboard ${prev?.id || "before it"} has no take yet.`, "nothing_to_extend");
      const seconds = Math.min(15, sb.seconds || 15);
      const refs = [{ asset_id: src, role: "source_video" }];
      let total = 0;
      for (const c of cast)
        if (c.voice?.sample && (deps.durations?.[c.voice.sample] || 7) >= MIN_VOICE_S && refs.filter((r) => r.role === "voice").length < 3 && total + (deps.durations?.[c.voice.sample] || 7) <= VOICE_TOTAL_S) {
          refs.push({ asset_id: c.voice.sample, role: "voice" });
          total += deps.durations?.[c.voice.sample] || 7;
        }
      return { model: "video/extend", prompt: extendPrompt(board, sb, seconds), params: { duration: seconds, resolution: "768P", output: "continuation" }, references: refs, label: `Storyboard ${sb.id}`, title: `Storyboard ${sb.id} · continues the take`, for: { storyboard: sb.id }, warnings };
    }
    const model = ["video/ref", "video/omni", "video"].includes(spec.model || sb.model) ? spec.model || sb.model : "video/ref";
    const m = MODELS[model];
    const maxS = m.params.duration?.max || 15;
    const seconds = Math.min(maxS, Math.max(m.params.duration?.min || 1, Math.round(sb.seconds || maxS)));
    if ((sb.seconds || 0) > maxS) warnings.push(`Storyboard ${sb.id} is ${sb.seconds} s, but ${model} makes at most ${maxS} s in one generation: this makes the first ${maxS} s. Split the rest into the next storyboard.`);
    const refs = [];
    if (model !== "video") {
      // a sheet still being made (its draft or job) stands in, and the video waits for it; a shot has none
      const sheet = isShot(board, sb) ? null : sb.sheet && !deps.pendingSheet ? sb.sheet : deps.pendingSheet || null;
      if (sheet) refs.push({ asset_id: sheet, role: "storyboard" });
      else if (!isShot(board, sb)) warnings.push(`Storyboard ${sb.id} has no sheet yet: the video follows the beats in words only. For the best result make the sheet first (for:{storyboard:"${sb.id}", make:"sheet"}) — the video can be prepared with it and waits for it.`);
      const cap = model === "video/omni" ? 10 : 9;
      for (const c of cast) {
        const a = sheetOf(c);
        if (!a) {
          warnings.push(`${c.name || c.id} has no bible sheet: only words describe them.`);
          continue;
        }
        if (refs.length >= cap) warnings.push(`${model} takes ${cap} images; ${c.name || c.id}'s sheet was left out.`);
        else refs.push({ asset_id: a, role: isObject(c) ? "subject" : "character", describe: describeCard(c) });
      }
      if (place && sheetOf(place) && refs.length < cap) refs.push({ asset_id: sheetOf(place), role: "location", describe: describePlace(place) });
    }
    if (model === "video/ref") {
      let total = 0;
      for (const c of cast) {
        if (!c.voice?.sample) continue;
        const d = deps.durations?.[c.voice.sample] || 7;
        if (d < MIN_VOICE_S) {
          warnings.push(`${c.name}'s voice sample is ${secs(d)} s — the video model needs at least ${MIN_VOICE_S} s, so it was left out. Make a new sample (for:{voice:"${c.id}"}, a few cents).`);
          continue;
        }
        if (refs.filter((r) => r.role === "voice").length >= 3 || total + d > VOICE_TOTAL_S) {
          warnings.push(`${c.name}'s voice sample left out: voice references must fit 3 files and 15 s together.`);
          continue;
        }
        refs.push({ asset_id: c.voice.sample, role: "voice", label: c.name || c.id });
        total += d;
      }
    }
    const params = { duration: seconds, ...(m.params.resolution ? { resolution: model === "video/omni" ? "720p" : "768P" } : {}) };
    if (m.params.aspect) params.aspect = m.params.aspect.enum.includes(aspect) ? aspect : m.params.aspect.default;
    if (model === "video/omni" && cast.some((c) => (sb.panels || []).some((p) => speakerLines(p.line).some((l) => l.who?.toLowerCase() === (c.name || "").toLowerCase()))))
      warnings.push("video/omni takes no voice references, so speakers won't keep their voices. Use video/ref for dialogue.");
    let prompt = storyboardVideoPrompt(board, sb, model, refs, { seconds, ended: prev?.ended });
    if (model === "video") prompt = prompt.replace(/^Keep every character.*\n?/m, "");
    return {
      model,
      prompt,
      params,
      references: refs.map(({ asset_id, role }) => ({ asset_id, role })),
      label: `Storyboard ${sb.id}`,
      title: `Storyboard ${sb.id} · video`,
      for: { storyboard: sb.id },
      warnings,
    };
  }
  throw new HttpError(400, FOR_HELP, "bad_for");
}

// ---------------------------------------------------------------- pacing

// What holds attention, measured on 5,882 published one-minute episodes (Mochi's captions, Oct 2026):
// a line about every 3 s (median 5 per 15 s, 3.6 words each, ≈15 words per 15 s), the first line by
// ~2 s, no long silences; the most-watched first episodes talk more and sooner than the least-watched.
export const PACE = { linesPer15: [4, 6], wordsPer15: 15, maxWordsPer15: 22, maxLineWords: 12, firstLineBy: 3, maxSilence: 9, beatEvery: [2.5, 3.5] };

// Notes on storyboards that will play rushed or sag, and on a film whose clips all have the same
// shape. Variety is the point: a quiet clip after a dense one is rhythm, two in a row may sag.
// ids: which storyboards to look at (default all).
export function pacingNotes(board, ids) {
  const notes = [];
  const silent = board.brief?.dialogue === "none";
  const live = board.storyboards.filter((s) => s.status !== "cut");
  const list = live.filter((s) => !ids || ids.includes(s.id));
  const talks = (sb) => panelTimes(sb, Math.min(30, sb.seconds || 15)).some((p) => speakerLines(p.line).length);
  for (const sb of list) {
    const seconds = sb.seconds || 15;
    const panels = panelTimes(sb, Math.min(30, seconds));
    if (!panels.length) continue;
    const spoken = panels.flatMap((p) => speakerLines(p.line).map((l) => ({ ...l, from: p.from, to: p.to, panel: panels.indexOf(p) + 1 })));
    const words = spoken.reduce((t, l) => t + wordCount(l.words), 0);
    const before = live[live.indexOf(sb) - 1];
    if (!silent && !spoken.length && sb.start !== "extend") {
      if (sb === live[0]) notes.push(`Storyboard ${sb.id} opens the film without a line. That works when the picture hooks on its own; otherwise a line in the first 2 s puts the hook on the table.`);
      else if (before && (before.panels || []).length && !talks(before)) notes.push(`Storyboards ${before.id} and ${sb.id} are both quiet. Two silent clips in a row can sag — fine if that's the intent; otherwise give one of them a line, a voice-over or a sound beat.`);
    }
    if (spoken.length && (words / seconds) * 15 > PACE.maxWordsPer15) notes.push(`Storyboard ${sb.id}: ${words} words in ${seconds} s will come out rushed. Keep it near ${PACE.wordsPer15} words per 15 s, 3–4 words a line.`);
    for (const l of spoken) if (wordCount(l.words) > PACE.maxLineWords) notes.push(`Storyboard ${sb.id}, panel ${l.panel}: "${l.words.slice(0, 60)}${l.words.length > 60 ? "…" : ""}" is ${wordCount(l.words)} words. Cut it to 8 or fewer, or split it between two panels.`);
    if (seconds >= 12 && panels.length < 3) notes.push(`Storyboard ${sb.id} has ${panels.length} beat${panels.length === 1 ? "" : "s"} for ${seconds} s. Something should change every few seconds — or make the clip shorter.`);
    // the project's pace, as shots per clip (sequences only: a shot is one shot)
    const pace = PACE_SHOTS[board.design?.pace];
    if (pace && !isShot(board, sb) && panels.length >= 2) {
      const [lo, hi] = pace.map((x) => Math.max(1, Math.round((x * Math.min(15, seconds)) / 15)));
      if (panels.length < lo) notes.push(`Storyboard ${sb.id} has ${panels.length} shots for ${seconds} s; the project's pace is ${board.design.pace} (${lo}–${hi} shots for a clip this long).`);
    }
    if (panels.length > 2 && seconds / panels.length < 0.9) notes.push(`Storyboard ${sb.id}: ${panels.length} shots in ${seconds} s (${secs(seconds / panels.length)} s each). Past about a second a shot the video model may merge or skip shots (12 in 15 s held up in testing); draft it at 480P first.`);
    if (!silent && spoken.length) {
      // stretches with no line: before the first, between line panels, after the last
      const spans = [...new Map(spoken.map((l) => [`${l.from}-${l.to}`, [l.from, l.to]])).values()];
      const edges = [[0, 0], ...spans, [seconds, seconds]];
      for (let i = 1; i < edges.length; i++) {
        const a = edges[i - 1][1], z = edges[i][0];
        if (z - a > PACE.maxSilence) {
          notes.push(`Storyboard ${sb.id}: ${secs(z - a)} s with no line (${secs(a)}–${secs(z)} s). Fill it with a line, a reaction or a sound beat.`);
          break;
        }
      }
    }
  }
  const first = board.storyboards.find((s) => s.status !== "cut");
  if (first && !silent && (!ids || ids.includes(first.id))) {
    const panels = panelTimes(first, first.seconds || 15);
    const opener = panels.find((p) => speakerLines(p.line).length);
    if (opener && opener.from >= PACE.firstLineBy) notes.push(`The opening line comes at ${secs(opener.from)} s. Open cold: a line in the first 2 s that puts the hook on the table (the rule, the insult, the demand, the countdown).`);
  }
  // neighbouring clips with the same people in the same place, short enough to share one generation:
  // one clip keeps them of a piece (every cut between generations is a seam)
  const same = (a, b) => a.place === b.place && [...(a.cast || [])].sort().join() === [...(b.cast || [])].sort().join();
  for (let i = 1; i < live.length; i++) {
    const a = live[i - 1], b = live[i];
    if (ids && !ids.includes(a.id) && !ids.includes(b.id)) continue;
    if (isShot(board, a) || isShot(board, b) || b.start === "extend" || !a.place || !same(a, b)) continue;
    const together = (a.seconds || 15) + (b.seconds || 15);
    if (together <= 15) {
      notes.push(`Storyboards ${a.id} and ${b.id} have the same people in the same place and fit in one ${together} s generation. One clip keeps them of a piece (every cut between generations is a seam): merge them, with as many shots as the pace wants.`);
      break;
    }
  }
  // the same shape clip after clip reads as a drone
  const written = live.filter((s) => (s.panels || []).length);
  if (written.length >= 3 && (!ids || ids.includes(written[written.length - 1].id))) {
    const shape = written.map((s) => ({ s: s.seconds || 15, n: panelTimes(s, s.seconds || 15).reduce((t, p) => t + speakerLines(p.line).length, 0) }));
    if (shape.every((x) => x.s === shape[0].s && Math.abs(x.n - shape[0].n) <= 1))
      notes.push(`All ${written.length} clips have the same shape (${shape[0].s} s, about ${shape[0].n} lines each). Vary the rhythm across the film: a short, sharp clip; a quiet one that breathes before the turn; a held last beat.`);
  }
  const total = live.reduce((t, s) => t + (s.seconds || 15), 0);
  if (!ids && total > 95) notes.push(`The storyboards add up to ${total} s. One-minute episodes run 45–90 s (first episodes do best at 60–75 s); split it into episodes or cut a storyboard.`);
  return notes;
}

// The voice samples a recipe may need, so durations can be looked up first.
export function voiceAssets(board, spec) {
  if (!spec?.storyboard) return [];
  const sb = board.storyboards.find((x) => x.id === String(spec.storyboard));
  return sb ? (sb.cast || []).map((id) => board.cast.find((c) => c.id === id)?.voice?.sample).filter(Boolean) : [];
}

// ---------------------------------------------------------------- what each result was made from

// The board inputs a generation for this target depends on: the card's own fields, the look, the
// sheets and voices it would attach. A result filed with one fingerprint is out of date once the
// board gives a different one. Inputs, not prompt text, so rewording a template changes nothing.
const ids_ = (list) => (list || []).map((r) => r.asset_id || r).filter(Boolean);
const fieldsOf = (x, keys) => Object.fromEntries(keys.map((k) => [k, x?.[k] ?? null]));
const CARD_KEYS = ["kind", "name", "role", "age", "personality", "theme", "look", "outfit", "contrast", "label", "notes"];
const PLACE_KEYS = ["name", "look", "time", "weather", "mood", "light", "sound"];
const MUSIC_KEYS = ["style", "mood", "tempo", "vocals", "where", "reference", "seconds", "notes"];
const PANEL_KEYS = ["t", "shot", "action", "line", "sound"];
// newer fields join an input only once they're set, so results made before them don't turn stale
const extra = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && !(typeof v === "object" && !Object.keys(v).length)));
const panelInputs = (x) => ({ ...fieldsOf(x, PANEL_KEYS), ...extra({ title: x.title, note: x.note }) });
const lookInputs = (board) => ({ style: board.look?.style || null, refs: ids_(board.look?.refs) });
const castOfSb = (board, sb) => (sb.cast || []).map((id) => board.cast.find((c) => c.id === id)).filter(Boolean);

export function inputsOf(board, target) {
  if (!target) return null;
  if (target.cast || target.place) {
    const card = target.cast ? board.cast.find((c) => c.id === target.cast) : board.places.find((c) => c.id === target.place);
    if (!card) return null;
    return { look: lookInputs(board), card: fieldsOf(card, target.cast ? CARD_KEYS : PLACE_KEYS), sources: sourcesOf(card), ...extra({ design: board.design?.bibles }) };
  }
  if (target.voice) {
    const c = board.cast.find((x) => x.id === target.voice);
    return c ? { voice: c.voice?.voice || null, line: c.voice?.line || null, notes: c.voice?.notes || null } : null;
  }
  if (target.music) {
    const m = (board.music || []).find((x) => x.id === target.music);
    return m ? { music: fieldsOf(m, MUSIC_KEYS), seconds: m.seconds ? null : filmSeconds(board), tone: board.brief?.tone || board.brief?.intent || null } : null;
  }
  if (target.look) {
    const o = (board.look?.options || []).find((x) => x.id === target.look);
    if (!o) return null;
    return { style: o.style || o.name || null, moment: board.look?.moment || null, aspect: board.brief?.aspect || null, cast: keyCast(board).map((c) => fieldsOf(c, ["name", "age", "look", "outfit"])) };
  }
  if (target.storyboard) {
    const sb = board.storyboards.find((x) => x.id === String(target.storyboard));
    if (!sb) return null;
    const prev = prevOf(board, sb);
    const cast = castOfSb(board, sb);
    const place = sb.place ? board.places.find((x) => x.id === sb.place) : null;
    const shared = { panels: (sb.panels || []).map(panelInputs), mood: sb.mood || null, seconds: sb.seconds || null, cast: cast.map((c) => sheetOf(c)), place: place ? sheetOf(place) : null, ended: prev?.ended || null, ...extra({ kind: isShot(board, sb) ? "shot" : null }) };
    if (target.make === "sheet") return { ...shared, look: lookInputs(board), style: sb.style || null, aspect: board.brief?.aspect || null, prev: prev?.sheet || null, ...extra({ design: board.design?.storyboard }) };
    const m = (board.music || [])[0];
    return { ...shared, sheet: sb.sheet || null, start: sb.start || null, voices: cast.map((c) => c.voice?.sample || null), music: m ? fieldsOf(m, ["style", "mood", "tempo", "vocals"]) : null };
  }
  return null;
}

export function fingerprint(board, target) {
  const inputs = inputsOf(board, target);
  return inputs ? createHash("sha1").update(JSON.stringify(inputs)).digest("hex").slice(0, 12) : null;
}

// What on the board was made from inputs that have since changed, and roughly what it costs to remake.
// Only results filed with a fingerprint are judged (older ones are left alone).
const REMAKE = { sheet: 0.05, place: 0.05, voice: 0.01, music: 0.1, look: 0.02, board: 0.07, take: 0.9 };
export function outOfDate(board) {
  const out = [];
  const check = (stored, target, item) => {
    if (!stored) return;
    const now = fingerprint(board, target);
    if (now && now !== stored) out.push(item);
  };
  for (const c of board.cast) {
    check(c.sheet_fp, { cast: c.id }, { kind: "sheet", id: c.id, label: `${c.name || c.id}'s sheet`, usd: REMAKE.sheet, for: { cast: c.id } });
    check(c.voice?.sample_fp, { voice: c.id }, { kind: "voice", id: c.id, label: `${c.name || c.id}'s voice sample`, usd: REMAKE.voice, for: { voice: c.id } });
  }
  for (const p of board.places) check(p.sheet_fp, { place: p.id }, { kind: "sheet", id: p.id, label: `${p.name || p.id}'s sheet`, usd: REMAKE.place, for: { place: p.id } });
  for (const m of board.music || []) check(m.sample_fp, { music: m.id }, { kind: "music", id: m.id, label: `${m.name || "The music"} sample`, usd: REMAKE.music, for: { music: m.id } });
  // look frames are for choosing: once a look is chosen they're history, so they're never flagged
  for (const sb of board.storyboards) {
    check(sb.sheet_fp, { storyboard: sb.id, make: "sheet" }, { kind: "board", id: sb.id, label: `Storyboard ${sb.id}'s sheet`, usd: REMAKE.board, for: { storyboard: sb.id, make: "sheet" } });
    check(sb.take_fp, { storyboard: sb.id }, { kind: "take", id: sb.id, label: `Storyboard ${sb.id}'s take`, usd: REMAKE.take, for: { storyboard: sb.id } });
  }
  return out;
}

// ---------------------------------------------------------------- the read-through

// The read-through: every line of a storyboard with the voice it's read in (the speaker's card, else a
// stand-in so it still plays) and a key naming that reading, so a line is read once until its words or
// voice change.
const STAND_INS = ["Brian", "Rachel", "George", "Jessica", "Chris", "Lily"];
export function readLines(board, sb) {
  const times = panelTimes(sb, sb.seconds || 15);
  const voiceOf = new Map();
  let stand = 0;
  const pick = (who) => {
    const k = String(who || "narrator").toLowerCase();
    if (voiceOf.has(k)) return voiceOf.get(k);
    const card = board.cast.find((c) => c.name && (c.name.toLowerCase() === k || c.name.toLowerCase().split(/\s+/)[0] === k.split(/\s+/)[0]));
    const v = card?.voice?.voice && VOICES[card.voice.voice] ? { voice: card.voice.voice, stand: false } : { voice: STAND_INS[stand++ % STAND_INS.length], stand: true };
    voiceOf.set(k, v);
    return v;
  };
  const out = [];
  times.forEach((t, i) => {
    for (const l of speakerLines(t.line)) {
      if (!l.words) continue;
      const v = pick(l.who);
      const text = l.delivery ? `[${l.delivery}] ${l.words}` : l.words;
      const key = createHash("sha1").update(`${v.voice}|${text}`).digest("hex").slice(0, 12);
      out.push({ panel: i, from: t.from, to: t.to, who: l.who || "Narrator", vo: !!l.vo, voice: v.voice, standIn: v.stand, text, key });
    }
  });
  return out;
}
