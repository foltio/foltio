// The project board: the brief, the cast (people, products, props) and places with their bible
// sheets, the look, the storyboards (each one becomes one video generation) with their takes, and
// the plan. Agents read and patch it through MCP (board_get / board_update); the browser shows it
// beside the chat. Generation fills it in on its own: a bible made for a card becomes its sheet, a
// storyboard's sheet and videos land on that storyboard, and a take counts as placed when it is on
// the timeline.
import { q, one, tx } from "./db.mjs";
import { HttpError } from "./auth.mjs";
import { VOICES } from "./gen/catalog.mjs";

const LIMITS = { decisions: 60, open: 20, beats: 16, cast: 12, places: 12, music: 6, looks: 6, storyboards: 40, panels: 16, scenes: 30, refs: 6, takes: 10, sheets: 8 };
const SB_STATUS = ["planned", "sheet", "generating", "ready", "failed", "cut"];
const CAST_KINDS = ["character", "product", "prop"];
const CARD_STATUS = ["proposed", "ready"];
const MODES = ["work_with_me", "just_make_it"];
const STARTS = ["cut", "extend"];
const STYLES = ["frames", "sketch", "ink"];
const KINDS = ["sequence", "shot"];
const KIND_WORDS = { sequence: "sequence", storyboard: "sequence", storyboarded: "sequence", sheet: "sequence", shot: "shot", single: "shot", anchors: "shot" };
const CLIP_WORDS = { storyboard: "storyboard", storyboards: "storyboard", sequence: "storyboard", sequences: "storyboard", shots: "shots", shot: "shots", mix: "mix", mixed: "mix" };
const CAPTIONS = ["full", "short", "labels"];
const BIBLE_KINDS = ["model", "casting"];
const DETAIL = ["full", "light"];
const CLIPS = ["storyboard", "shots", "mix"];
const PACES = ["calm", "measured", "fast", "rapid"];
const DIALOGUE = ["dialogue", "voiceover", "none"];
const VOCALS = ["instrumental", "vocals"];

const str = (v, n) => (v === null || v === undefined ? undefined : String(v).replace(/\s+$/g, "").slice(0, n));
const num = (v, lo, hi) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? undefined : Math.min(hi, Math.max(lo, Number(v))));
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const ids = (list, n) => (Array.isArray(list) ? list.map((x) => str(x, 40)).filter(Boolean).slice(-n) : undefined);

export function emptyBoard() {
  return { brief: {}, look: {}, design: {}, decisions: [], open: [], beats: [], cast: [], places: [], music: [], scenes: [], storyboards: [], plan: null };
}

const refsOf = (list) =>
  (Array.isArray(list) ? list : [])
    .filter((r) => r && typeof r.asset_id === "string")
    .slice(0, LIMITS.refs)
    .map((r) => clean({ asset_id: r.asset_id, use: str(r.use, 60) }));

function briefOf(b) {
  return clean({
    intent: str(b.intent, 300),
    goal: str(b.goal, 300),
    format: str(b.format, 60),
    aspect: str(b.aspect, 12),
    seconds: num(b.seconds, 1, 3600),
    audience: str(b.audience, 200),
    tone: str(b.tone, 200),
    premise: str(b.premise, 600),
    must_have: str(b.must_have, 400),
    avoid: str(b.avoid, 400),
    budget_usd: num(b.budget_usd, 0, 2000),
    where: str(b.where, 160),
    versions: str(b.versions, 200),
    ending: str(b.ending, 400),
    about: str(b.about, 300),
    dialogue: DIALOGUE.includes(b.dialogue) ? b.dialogue : undefined,
    mode: MODES.includes(b.mode) ? b.mode : undefined,
    // the working style: a skill name (storyboarded-film, freestyle, music-video, ad-variants,
    // footage-edit, or one of their own); the agent loads it at the start of a conversation
    style: typeof b.style === "string" ? str(b.style.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, ""), 60) : undefined,
    locked: typeof b.locked === "boolean" ? b.locked : undefined,
  });
}

// A new piece is generated only once its vision is found and locked with the person. A board that
// already has made work (a look frame, a sheet, a take) counts as locked unless it was unlocked.
export function visionLocked(board) {
  if (board.brief?.locked !== undefined) return board.brief.locked === true;
  const sheet = (c) => (c.refs || []).some((r) => r.use === "sheet");
  return (board.look?.options || []).some((o) => o.frame) || [...(board.cast || []), ...(board.places || [])].some(sheet) || (board.storyboards || []).some((s) => s.sheet || (s.takes || []).length);
}
const lookOf = (l) => clean({ style: str(l.style, 900), refs: l.refs ? refsOf(l.refs) : undefined, moment: str(l.moment, 400), chosen: l.chosen === null ? undefined : str(l.chosen, 4) });
// How this project's sheets look and how its clips are made, set from the project (its format, look
// and pace) by the agent, and changeable by the person:
//   storyboard: render (finished frames in the look | pencil sketch | bold ink), sheet (the sheet's own
//     design: paper, frame, type, colours), captions (full | short | labels), header (extra header
//     fields, e.g. the brand and product)
//   bibles: kind (an animation model sheet | a live-action casting sheet), detail (full | light), sheet
//   clips: storyboard (each clip from its storyboard sheet) | shots (single shots from the anchors
//     alone) | mix (chosen clip by clip); pace: calm | measured | fast | rapid (shots per clip)
function designOf(d) {
  const sb = d.storyboard && typeof d.storyboard === "object" ? d.storyboard : null;
  const bi = d.bibles && typeof d.bibles === "object" ? d.bibles : null;
  return clean({
    storyboard: sb ? clean({ render: STYLES.includes(sb.render) ? sb.render : undefined, sheet: str(sb.sheet, 300), captions: CAPTIONS.includes(sb.captions) ? sb.captions : undefined, header: str(sb.header, 160) }) : undefined,
    bibles: bi ? clean({ kind: BIBLE_KINDS.includes(bi.kind) ? bi.kind : undefined, detail: DETAIL.includes(bi.detail) ? bi.detail : undefined, sheet: str(bi.sheet, 300) }) : undefined,
    clips: CLIP_WORDS[String(d.clips || "").toLowerCase()] || undefined,
    pace: PACES.includes(d.pace) ? d.pace : undefined,
  });
}

// One look on offer: a name, the style in words, and its rough frame once made.
const optionOf = (o) => clean({ id: str(o.id, 4), name: str(o.name, 60), style: str(o.style, 900), frame: str(o.frame, 40) });

// A character, product or prop: the fields its bible sheet is drawn from, its sheet (refs[0] with
// use "sheet" is what every generation sends), the person's own images (use "source"), its voice.
function castOf(c, warnings) {
  const voice = c.voice && typeof c.voice === "object" ? clean({ voice: str(c.voice.voice, 30), sample: str(c.voice.sample, 40), line: str(c.voice.line, 240), notes: str(c.voice.notes, 200) }) : undefined;
  if (voice?.voice && !VOICES[voice.voice]) warnings.push(`${c.name || c.id}: voice "${voice.voice}" is not one of the library voices (${Object.keys(VOICES).join(", ")}).`);
  return clean({
    id: str(c.id, 12),
    kind: CAST_KINDS.includes(c.kind) ? c.kind : undefined,
    name: str(c.name, 60),
    role: str(c.role, 120),
    age: str(c.age, 40),
    personality: str(c.personality, 240),
    theme: str(c.theme, 160),
    look: str(c.look, 900),
    outfit: str(c.outfit, 400),
    contrast: str(c.contrast, 200),
    label: str(c.label, 200),
    notes: str(c.notes, 500),
    voice,
    refs: c.refs ? refsOf(c.refs) : undefined,
    sheets: ids(c.sheets, LIMITS.sheets),
    status: CARD_STATUS.includes(c.status) ? c.status : undefined,
  });
}
const placeOf = (p) =>
  clean({
    id: str(p.id, 12),
    name: str(p.name, 60),
    look: str(p.look, 900),
    time: str(p.time, 80),
    weather: str(p.weather, 80),
    mood: str(p.mood, 160),
    light: str(p.light, 300),
    sound: str(p.sound, 200),
    refs: p.refs ? refsOf(p.refs) : undefined,
    sheets: ids(p.sheets, LIMITS.sheets),
    status: CARD_STATUS.includes(p.status) ? p.status : undefined,
  });
// A piece of music for the film: what it sounds like and where it plays. Its sample is the latest
// one made from it (earlier ones stay in samples).
const musicOf = (m) =>
  clean({
    id: str(m.id, 12),
    name: str(m.name, 60),
    style: str(m.style, 300),
    mood: str(m.mood, 200),
    tempo: str(m.tempo, 40),
    vocals: VOCALS.includes(m.vocals) ? m.vocals : undefined,
    where: str(m.where, 240),
    reference: str(m.reference, 200),
    seconds: num(m.seconds, 5, 300),
    notes: str(m.notes, 400),
    sample: str(m.sample, 40),
    samples: ids(m.samples, LIMITS.sheets),
    status: CARD_STATUS.includes(m.status) ? m.status : undefined,
  });
const sceneOf = (s) => clean({ id: str(s.id, 12), title: str(s.title, 120), goal: str(s.goal, 300) });

// One shot of a storyboard: when, the shot and camera, a 2–4 word title, what happens, the line
// ("MARA: …"), and a note lettered on the panel (a beat count, an arrow, "FINAL BEAT DROP").
const panelOf = (p) =>
  p && typeof p === "object"
    ? clean({ t: str(p.t ?? p.time, 24), shot: str(p.shot ?? p.camera, 140), title: str(p.title, 40), action: str(p.action, 600), line: str(p.line ?? p.dialogue, 260), sound: str(p.sound, 160), note: str(p.note, 80) })
    : null;
// A storyboard is one generation: up to the model's longest clip (15 s for H3). A sequence is drawn
// as a storyboard sheet first (as many panels as the pace wants, up to 16); a shot is one short,
// precise generation from the anchors alone.
function storyboardOf(s) {
  return clean({
    id: str(s.id, 16),
    scene: str(s.scene, 12),
    title: str(s.title, 120),
    beat: str(s.beat, 400),
    mood: str(s.mood, 120),
    seconds: num(s.seconds, 1, 30),
    kind: KIND_WORDS[String(s.kind || "").toLowerCase()] || undefined,
    start: STARTS.includes(s.start) ? s.start : undefined,
    style: STYLES.includes(s.style) ? s.style : undefined,
    panels: Array.isArray(s.panels) ? s.panels.map(panelOf).filter(Boolean).slice(0, LIMITS.panels) : undefined,
    cast: Array.isArray(s.cast) ? s.cast.map((x) => str(x, 12)).filter(Boolean).slice(0, 8) : undefined,
    place: str(s.place, 12),
    sound: str(s.sound, 240),
    model: str(s.model, 20),
    est_usd: num(s.est_usd, 0, 500),
    sheet: str(s.sheet, 40),
    sheets: ids(s.sheets, LIMITS.sheets),
    status: SB_STATUS.includes(s.status) ? s.status : undefined,
    takes: ids(s.takes, LIMITS.takes),
    chosen: s.chosen === null ? undefined : str(s.chosen, 40),
    ended: str(s.ended, 700),
    last_frame: str(s.last_frame, 40),
    last_from: str(s.last_from, 40),
    note: str(s.note, 300),
  });
}
// Boards (and agents) from before storyboards had "shots": each becomes a one-panel storyboard.
function fromShot(s) {
  const secs = num(s.seconds, 1, 30);
  return storyboardOf({
    ...s,
    panels: s.panels || [{ t: secs ? `0-${secs}` : undefined, shot: s.camera, action: s.action, line: s.dialogue }],
  });
}
// What's been decided, layer by layer — the project's source of truth, shown to the person as the
// Decisions strip and read by the agent each turn. pinned: the agent doesn't change it unasked.
const LAYERS = ["Piece", "Story", "People", "Places", "Look", "Sound", "Shape"];
function decisionOf(x) {
  return clean({
    id: str(x.id, 16),
    layer: LAYERS.includes(x.layer) ? x.layer : x.layer ? "Story" : undefined,
    label: str(x.label, 60),
    value: str(x.value, 1200),
    // the picked preview: given as asset, or named in the value ("Sodium cold (ast_…)")
    asset: x.asset === null ? undefined : /^ast_[a-z0-9]{6,}$/.test(String(x.asset || "")) ? String(x.asset) : String(x.value || "").match(/\bast_[a-z0-9]{6,}\b/)?.[0],
    pinned: typeof x.pinned === "boolean" ? x.pinned : undefined,
    source: ["you", "agent"].includes(x.source) ? x.source : undefined,
    updated: str(x.updated, 30) || new Date().toISOString(),
  });
}
// What's still open: the questions that remain before the piece can be made.
function openOf(x) {
  return clean({ id: str(x.id, 16), layer: LAYERS.includes(x.layer) ? x.layer : undefined, label: str(x.label, 80), note: str(x.note, 300), important: typeof x.important === "boolean" ? x.important : undefined });
}

// The story so far, as it's agreed: one beat per part (opening, inciting, the turn, the ending…), in order.
function beatOf(x) {
  return clean({ id: str(x.id, 12), part: str(x.part, 40), title: str(x.title, 80), text: str(x.text, 600), status: ["draft", "agreed"].includes(x.status) ? x.status : undefined });
}
function planOf(p) {
  return clean({
    title: str(p.title, 120),
    logline: str(p.logline, 400),
    total_usd: num(p.total_usd, 0, 5000),
    retake_usd: num(p.retake_usd, 0, 5000),
    minutes: num(p.minutes, 0, 600),
  });
}

// A stored board in today's shape.
export function normalize(data) {
  const b = { ...emptyBoard(), ...(data || {}) };
  if (Array.isArray(b.shots)) {
    if (!b.storyboards?.length && b.shots.length) b.storyboards = b.shots.map((s) => ({ ...fromShot(s), id: String(s.id) }));
    delete b.shots;
  }
  return b;
}

function nextId(list, prefix) {
  let n = 1;
  const used = new Set(list.map((x) => x.id));
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

// Merge a list patch by id: new ids are appended, existing ones merged field by field, remove:true
// deletes, and a field set to null is cleared. (A storyboard's panels are replaced as a whole.)
function mergeList(current, patchList, shape, prefix, limit, warnings, what) {
  if (!Array.isArray(patchList)) throw new HttpError(400, `board.${what} must be a list of objects with ids.`, "bad_board");
  const out = current.map((x) => ({ ...x }));
  for (const raw of patchList) {
    if (!raw || typeof raw !== "object") continue;
    const id = raw.id ? String(raw.id) : null;
    const i = id ? out.findIndex((x) => x.id === id) : -1;
    if (raw.remove) {
      if (i >= 0) out.splice(i, 1);
      continue;
    }
    const cleared = Object.keys(raw).filter((k) => raw[k] === null);
    const fields = shape(raw, warnings);
    if (i >= 0) {
      const merged = { ...out[i], ...fields, id: out[i].id };
      for (const k of cleared) delete merged[k];
      out[i] = merged;
    } else {
      if (out.length >= limit) throw new HttpError(400, `The board holds at most ${limit} ${what}.`, "board_full");
      out.push({ ...fields, id: id || (prefix ? nextId(out, prefix) : `${out.length + 1}`) });
    }
  }
  return out;
}

// Look options merge by id like other lists, with letters for ids (A, B, C…).
function mergeOptions(current, list, warnings) {
  if (!Array.isArray(list)) throw new HttpError(400, "look.options must be a list: [{id:\"A\", name, style}].", "bad_board");
  const out = current.map((x) => ({ ...x }));
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const i = raw.id ? out.findIndex((x) => x.id === String(raw.id).toUpperCase()) : -1;
    if (raw.remove) {
      if (i >= 0) out.splice(i, 1);
      continue;
    }
    const fields = optionOf(raw);
    if (i >= 0) out[i] = { ...out[i], ...fields, id: out[i].id };
    else {
      if (out.length >= LIMITS.looks) {
        warnings.push(`At most ${LIMITS.looks} looks are kept on the board; remove one first.`);
        continue;
      }
      const used = new Set(out.map((x) => x.id));
      const id = raw.id && !used.has(String(raw.id).toUpperCase()) ? String(raw.id).toUpperCase().slice(0, 4) : "ABCDEFGH".split("").find((c) => !used.has(c));
      out.push({ ...fields, id });
    }
  }
  return out;
}

const ALLOWED = ["decisions", "open", "beats", "brief", "look", "design", "cast", "places", "music", "scenes", "storyboards", "shots", "plan"];

// Apply a patch from an agent or the browser; returns { board, warnings }.
export function applyPatch(board, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new HttpError(400, "patch must be an object, e.g. {brief:{intent:\"…\"}, cast:[{id:\"C1\", name:\"…\"}]}.", "bad_board");
  const unknown = Object.keys(patch).filter((k) => !ALLOWED.includes(k));
  if (unknown.length) throw new HttpError(400, `Unknown board field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. The board has: ${ALLOWED.filter((k) => k !== "shots").join(", ")}.`, "bad_board", { allowed: ALLOWED });
  const warnings = [];
  const b = normalize(board);
  if (patch.brief !== undefined) b.brief = patch.brief === null ? {} : { ...b.brief, ...briefOf(patch.brief) };
  if (patch.look !== undefined) {
    if (patch.look === null) b.look = {};
    else {
      b.look = { ...b.look, ...lookOf(patch.look) };
      if (patch.look.chosen === null) delete b.look.chosen;
      if (patch.look.options !== undefined) b.look.options = mergeOptions(b.look.options || [], patch.look.options, warnings);
      // choosing a look makes it the project's look: its words, and its frame as the style reference
      const pick = patch.look.chosen && (b.look.options || []).find((o) => o.id === patch.look.chosen);
      if (patch.look.chosen && !pick) warnings.push(`There is no look ${patch.look.chosen} to choose. The options are: ${(b.look.options || []).map((o) => o.id).join(", ") || "none yet"}.`);
      if (pick) {
        if (!patch.look.style && pick.style) b.look.style = pick.style;
        if (!patch.look.refs) b.look.refs = pick.frame ? [{ asset_id: pick.frame, use: "style" }] : (b.look.refs || []).filter((r) => r.use !== "style");
      }
    }
  }
  if (patch.design !== undefined) {
    if (patch.design === null) b.design = {};
    else {
      const d = designOf(patch.design);
      const cur = b.design || {};
      const next = { ...cur, ...d, ...(d.storyboard ? { storyboard: { ...cur.storyboard, ...d.storyboard } } : {}), ...(d.bibles ? { bibles: { ...cur.bibles, ...d.bibles } } : {}) };
      // a field set to null is cleared
      for (const k of ["pace", "clips"]) if (patch.design[k] === null) delete next[k];
      for (const g of ["storyboard", "bibles"]) {
        const given = patch.design[g];
        if (given === null) delete next[g];
        else if (given && typeof given === "object" && next[g]) for (const [k, v] of Object.entries(given)) if (v === null) delete next[g][k];
        if (next[g] && !Object.keys(next[g]).length) delete next[g];
      }
      b.design = next;
    }
  }
  if (patch.decisions !== undefined) b.decisions = mergeList(b.decisions || [], patch.decisions.map((d) => (d && !d.remove ? { ...d, updated: new Date().toISOString() } : d)), decisionOf, "D", LIMITS.decisions, warnings, "decisions");
  if (patch.open !== undefined) b.open = mergeList(b.open || [], patch.open, openOf, "O", LIMITS.open, warnings, "open");
  if (patch.beats !== undefined) b.beats = mergeList(b.beats || [], patch.beats, beatOf, "B", LIMITS.beats, warnings, "beats");
  if (patch.cast !== undefined) b.cast = mergeList(b.cast, patch.cast, castOf, "C", LIMITS.cast, warnings, "cast");
  if (patch.places !== undefined) b.places = mergeList(b.places, patch.places, placeOf, "L", LIMITS.places, warnings, "places");
  if (patch.music !== undefined) b.music = mergeList(b.music, patch.music, musicOf, "M", LIMITS.music, warnings, "music");
  if (patch.scenes !== undefined) b.scenes = mergeList(b.scenes, patch.scenes, sceneOf, "", LIMITS.scenes, warnings, "scenes");
  if (patch.shots !== undefined) {
    warnings.push("board.shots is now board.storyboards (each storyboard is one generation of up to 15 s with 4–8 panels). Saved them as one-panel storyboards.");
    b.storyboards = mergeList(b.storyboards, patch.shots, fromShot, null, LIMITS.storyboards, warnings, "storyboards");
  }
  if (patch.storyboards !== undefined) b.storyboards = mergeList(b.storyboards, patch.storyboards, storyboardOf, null, LIMITS.storyboards, warnings, "storyboards");
  for (const s of patch.storyboards || []) if (s?.seconds > 15 && !s.remove) warnings.push(`Storyboard ${s.id || "?"} is ${s.seconds} s: H3 makes up to 15 s per generation (Omni 10 s). Split it into two storyboards, or start the second with start:"extend".`);
  // the plan is a summary and an estimate, never a gate: generations are approved one by one
  if (patch.plan !== undefined) {
    if (patch.plan === null) b.plan = null;
    else {
      const { status, approved_at, ...kept } = b.plan || {};
      b.plan = { ...kept, ...planOf(patch.plan) };
    }
  }
  return { board: b, warnings };
}

export async function loadBoard(projectId) {
  const r = await one("select data, version, updated_at from studio.boards where project_id=$1", [projectId]);
  return r ? { board: normalize(r.data), version: r.version, updated_at: r.updated_at } : { board: emptyBoard(), version: 0, updated_at: null };
}

// Every asset a board points at.
export function boardAssets(board) {
  const out = new Set();
  for (const c of [...board.cast, ...board.places]) {
    for (const r of c.refs || []) out.add(r.asset_id);
    for (const a of c.sheets || []) out.add(a);
  }
  for (const r of board.look?.refs || []) out.add(r.asset_id);
  for (const c of board.cast) if (c.voice?.sample) out.add(c.voice.sample);
  for (const m of board.music || []) for (const a of [m.sample, ...(m.samples || [])]) if (a) out.add(a);
  for (const o of board.look?.options || []) if (o.frame) out.add(o.frame);
  for (const d of board.decisions || []) if (d.asset) out.add(d.asset);
  for (const s of board.storyboards) {
    if (s.sheet) out.add(s.sheet);
    for (const a of s.sheets || []) out.add(a);
    for (const t of s.takes || []) out.add(t);
    if (s.last_frame) out.add(s.last_frame);
    for (const a of s.panel_frames || []) out.add(a);
    for (const a of Object.values(s.reads || {})) out.add(a);
  }
  return out;
}

// Check that every asset the patch points at belongs to the project.
async function checkAssets(projectId, board) {
  const all = boardAssets(board);
  if (!all.size) return;
  const found = new Set((await q("select id from studio.assets where project_id=$1 and id = any($2) and deleted_at is null", [projectId, [...all]])).map((r) => r.id));
  const missing = [...all].filter((x) => !found.has(x));
  if (missing.length) throw new HttpError(400, `Not assets of this project: ${missing.join(", ")}. Use asset ids from media_list or job_wait.`, "unknown_asset");
}

export async function patchBoard(projectId, patch) {
  return tx(async (t) => {
    const cur = await t.one("select data, version from studio.boards where project_id=$1 for update", [projectId]);
    const { board, warnings } = applyPatch(cur ? cur.data : emptyBoard(), patch);
    await checkAssets(projectId, board);
    const version = (cur?.version || 0) + 1;
    await t.q(
      `insert into studio.boards(project_id, data, version, updated_at) values ($1,$2,$3,now())
       on conflict (project_id) do update set data=excluded.data, version=excluded.version, updated_at=now()`,
      [projectId, board, version],
    );
    return { board, version, warnings };
  });
}

// Change the stored board in place (generation bookkeeping): fn(board) mutates it.
async function mutate(projectId, fn) {
  await tx(async (t) => {
    const cur = await t.one("select data from studio.boards where project_id=$1 for update", [projectId]);
    if (!cur) return;
    const board = normalize(cur.data);
    if (fn(board) === false) return;
    await t.q("update studio.boards set data=$2, version=version+1, updated_at=now() where project_id=$1", [projectId, board]);
  });
}
const pushId = (list, id, n) => [...(list || []).filter((x) => x !== id), id].slice(-n);

// A generation made for something on the board files its result there:
//   {cast|place}            a bible sheet: becomes the card's sheet (earlier ones stay in sheets)
//   {voice}                 a voice sample: becomes the card's voice.sample
//   {music}                 a music sample: becomes the music card's sample
//   {look:"A"}              a look option's rough frame
//   {read:"2", line}        a read-through line for storyboard 2 (kept by the line's key)
// fp is a fingerprint of what the result was made from, so the board can tell when it's out of date.
//   {storyboard, make:"sheet"}  the storyboard's sheet
//   {storyboard}            a video: one of the storyboard's takes
export async function filedEvent(projectId, target, { status, assets, note, fp } = {}) {
  if (!target) return;
  await mutate(projectId, (board) => {
    const first = assets?.[0];
    if (target.look) {
      const o = (board.look?.options || []).find((x) => x.id === target.look);
      if (!o || !first) return false;
      o.frame = first;
      if (fp) o.frame_fp = fp;
      // re-made frame of the chosen look: it stays the style reference
      if (board.look.chosen === o.id) board.look.refs = [{ asset_id: first, use: "style" }];
      return;
    }
    if (target.read) {
      const sb = board.storyboards.find((x) => x.id === String(target.read));
      if (!sb || !first || !target.line) return false;
      sb.reads = { ...(sb.reads || {}), [target.line]: first };
      return;
    }
    if (target.cast || target.place) {
      const card = (target.cast ? board.cast : board.places).find((x) => x.id === (target.cast || target.place));
      if (!card || !first) return false;
      for (const a of assets) card.sheets = pushId(card.sheets, a, LIMITS.sheets);
      card.refs = [{ asset_id: first, use: "sheet" }, ...(card.refs || []).filter((r) => r.use !== "sheet")].slice(0, LIMITS.refs);
      if (fp) card.sheet_fp = fp;
      return;
    }
    if (target.voice) {
      const card = board.cast.find((x) => x.id === target.voice);
      if (!card || !first) return false;
      card.voice = { ...(card.voice || {}), sample: first, ...(fp ? { sample_fp: fp } : {}) };
      return;
    }
    if (target.music) {
      const card = board.music.find((x) => x.id === target.music);
      if (!card || !first) return false;
      for (const a of assets) card.samples = pushId(card.samples, a, LIMITS.sheets);
      card.sample = first;
      if (fp) card.sample_fp = fp;
      return;
    }
    const sb = board.storyboards.find((x) => x.id === String(target.storyboard));
    if (!sb) return false;
    if (target.make === "sheet") {
      if (first) {
        for (const a of assets) sb.sheets = pushId(sb.sheets, a, LIMITS.sheets);
        sb.sheet = first;
        if (fp) sb.sheet_fp = fp;
        if (!sb.status || sb.status === "planned") sb.status = "sheet";
      }
      if (note) sb.note = String(note).slice(0, 300);
      else if (note === null) delete sb.note;
      return;
    }
    if (status) sb.status = status;
    if (assets?.length) {
      sb.takes = [...new Set([...(sb.takes || []), ...assets])].slice(-LIMITS.takes);
      if (fp) sb.take_fp = fp;
    }
    if (note === null) delete sb.note;
    else if (note !== undefined) sb.note = String(note).slice(0, 300);
  });
}

// A storyboard sheet's panels as separate images (for watching the piece through), cut from that sheet.
export async function setPanelFrames(projectId, sbId, sheet, frames) {
  await mutate(projectId, (board) => {
    const sb = board.storyboards.find((x) => x.id === String(sbId));
    if (!sb) return false;
    sb.panel_frames = frames;
    sb.panel_from = sheet;
  });
}

// What the last watch-through put on the timeline, so the next one replaces exactly that.
export async function setPreview(projectId, preview) {
  await mutate(projectId, (board) => {
    board.preview = preview;
  });
}

// The last frame of a storyboard's take, saved as an image for the next storyboard to start from.
export async function setLastFrame(projectId, sbId, take, frame) {
  await mutate(projectId, (board) => {
    const sb = board.storyboards.find((x) => x.id === String(sbId));
    if (!sb) return false;
    sb.last_frame = frame;
    sb.last_from = take;
  });
}

// Which takes are on the timeline right now (a storyboard's pick is the take in use).
export function withPlacement(board, doc) {
  const used = new Set(Object.values(doc?.sequence?.items || {}).map((i) => i.asset).filter(Boolean));
  return {
    ...board,
    storyboards: board.storyboards.map((s) => {
      const pick = (s.takes || []).filter((t) => used.has(t)).pop();
      return pick ? { ...s, pick, placed: true } : s;
    }),
  };
}

const sheetOf = (card) => (card.refs || []).find((r) => r.use === "sheet")?.asset_id || null;

// A short text view for agents.
export function boardLines(board) {
  const L = [];
  const br = board.brief || {};
  L.push(br.style ? `Style: ${br.style} — load that skill (skill_view) and work in its shape` : "Style: not set — infer it from the request or ask once (see Working styles)");
  if (br.intent || br.goal) L.push(`Brief: ${br.intent || br.goal}${br.format ? ` · ${br.format}` : ""}${br.aspect ? ` · ${br.aspect}` : ""}${br.seconds ? ` · ${br.seconds}s` : ""}${br.where ? ` · plays on ${br.where}` : ""}${br.versions ? ` · versions: ${br.versions}` : ""}${br.mode ? ` · mode ${br.mode}` : ""}`);
  if (br.about || br.ending) L.push(`${br.about ? `About: ${br.about.slice(0, 140)}` : ""}${br.about && br.ending ? " · " : ""}${br.ending ? `Ends: ${br.ending.slice(0, 160)}` : ""}`);
  for (const d of board.decisions || []) L.push(`Decided ${d.id} [${d.layer || "Story"}]${d.pinned ? " (pinned: don't change unless they ask)" : ""} ${d.label}: ${(d.value || "").slice(0, 200)}`);
  for (const o of board.open || []) L.push(`Open ${o.id}${o.important ? " (important)" : ""} [${o.layer || "?"}] ${o.label}${o.note ? ` — ${o.note.slice(0, 100)}` : ""}`);
  for (const x of board.beats || []) L.push(`Beat ${x.id} ${x.part || ""}${x.status === "agreed" ? " (agreed)" : ""}: ${x.title || ""} — ${(x.text || "").slice(0, 160)}`);
  for (const o of board.look?.options || []) L.push(`Look ${o.id}${board.look.chosen === o.id ? " (chosen)" : ""} ${o.name || ""}: ${(o.style || "").slice(0, 110)} · frame ${o.frame || "none yet"}`);
  if (board.look?.style) L.push(`Look: ${board.look.style.slice(0, 160)}${(board.look.refs || []).length ? ` (${board.look.refs.length} refs)` : ""}`);
  const dz = board.design || {};
  if (dz.storyboard || dz.bibles || dz.clips || dz.pace)
    L.push(`Design: ${[dz.pace && `pace ${dz.pace}`, dz.clips && `clips from ${dz.clips === "shots" ? "shots" : dz.clips === "mix" ? "storyboards and shots" : "storyboards"}`, dz.storyboard && `storyboards ${[dz.storyboard.render, dz.storyboard.captions && `${dz.storyboard.captions} captions`, dz.storyboard.sheet && `“${dz.storyboard.sheet.slice(0, 60)}”`].filter(Boolean).join(", ")}`, dz.bibles && `bibles ${[dz.bibles.kind, dz.bibles.detail].filter(Boolean).join(" ")}`].filter(Boolean).join(" · ")}`);
  for (const c of board.cast)
    L.push(`${c.id} ${c.name || "?"} (${c.kind || "character"}, ${c.status || "proposed"}): ${(c.look || "").slice(0, 110)} · bible ${sheetOf(c) || "none yet"}${c.voice?.voice ? ` · voice ${c.voice.voice}${c.voice.sample ? "+sample" : ""}` : ""}`);
  for (const p of board.places) L.push(`${p.id} ${p.name || "?"} (${p.status || "proposed"}): ${(p.look || "").slice(0, 100)} · bible ${sheetOf(p) || "none yet"}`);
  for (const m of board.music || []) L.push(`${m.id} ${m.name || "music"} (music${m.vocals ? `, ${m.vocals}` : ""}${m.seconds ? `, ${m.seconds}s` : ""}): ${[m.style, m.mood, m.tempo].filter(Boolean).join(" · ").slice(0, 120)}${m.where ? ` · plays ${m.where.slice(0, 60)}` : ""} · sample ${m.sample || "none yet"}`);
  for (const s of board.storyboards)
    L.push(
      `storyboard ${s.id} [${s.placed ? "placed" : s.status || "planned"}] ${s.seconds ? `${s.seconds}s ` : ""}${s.title || ""}${!(s.panels || []).length && s.beat ? ` — outline: ${s.beat.slice(0, 90)}` : ""} · ${(s.kind || (board.design?.clips === "shots" ? "shot" : "sequence")) === "shot" ? "shot (from the anchors, no sheet)" : `${(s.panels || []).length} panels`}${s.cast?.length ? ` · ${s.cast.join("+")}` : ""}${s.place ? ` @${s.place}` : ""}${s.start === "extend" ? " · extends the previous take" : ""}${(s.kind || (board.design?.clips === "shots" ? "shot" : "sequence")) === "shot" ? "" : ` · sheet ${s.sheet || "none yet"}`} · takes ${(s.takes || []).length}${s.pick ? ` (using ${s.pick})` : ""}${s.ended ? ` · ended: ${s.ended.slice(0, 100)}` : ""}`,
    );
  if (board.plan) L.push(`Plan: ${board.plan.title || "untitled"} · about $${board.plan.total_usd ?? "?"}${board.plan.retake_usd ? ` (incl. retakes $${board.plan.retake_usd})` : ""}${board.plan.minutes ? ` · ~${board.plan.minutes} min` : ""}`);
  return L.length ? L.join("\n") : "The board is empty.";
}
