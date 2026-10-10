// Typed timeline operations. applyOps() runs a batch on a copy of the document and either
// returns the new document plus a change summary, or throws OpError naming the failing op —
// never a partial edit. Every applied batch becomes one commit (one undo step).
import { cleanFilter, filterAssets } from "./fx.mjs";
import {
  OpError,
  toFrames,
  toMs,
  f2s,
  s2f,
  itemsOn,
  end,
  seqDuration,
  track,
  item,
  newItemId,
  PRESETS,
  rateOf,
} from "./model.mjs";
import { id } from "../ids.mjs";

const VISUAL_KEYS = ["fit", "scale", "x", "y", "rotation", "opacity", "crop", "bg", "flip"];
const AUDIO_KEYS = ["enabled", "gainDb", "fadeInMs", "fadeOutMs", "mute"];
const FITS = ["fill", "fit", "stretch"];
const TRANSITIONS = ["dissolve", "dip_black", "dip_white", "wipe_left", "wipe_right", "slide_left", "slide_up"];
const TITLE_PRESETS = ["lower_third", "center", "top", "big_bold", "subtitle_box", "end_card"];
const CAPTION_PRESETS = ["karaoke", "clean", "boxed", "bold_pop"];

// Ids created by a batch come from ctx.newId. With a seed (the browser sends one with each edit)
// the browser's optimistic copy and the server's commit get identical ids.
const ALPHABET = "0123456789abcdefghijkmnopqrstuvwxyz";
function seededRandom(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}
function idSource(seed) {
  if (!seed) return (prefix, n) => id(prefix, n);
  const rnd = seededRandom(String(seed));
  return (prefix, n) => {
    let s = "";
    for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
    return `${prefix}_${s}`;
  };
}
function newItem(doc, ctx) {
  let k;
  do k = ctx.newId("itm", 6);
  while (doc.sequence.items[k]);
  return k;
}

// A batch alias ("$hook") lets later ops in the same batch refer to items created earlier.
function resolveRef(ctx, ref) {
  if (typeof ref === "string" && ref.startsWith("$")) {
    const v = ctx.aliases[ref.slice(1)];
    if (!v) throw new OpError("unknown_alias", `Alias ${ref} was not defined earlier in this batch.`);
    return v;
  }
  return ref;
}

function assetInfo(ctx, assetId) {
  const a = ctx.assets[assetId];
  if (!a) throw new OpError("unknown_asset", `No asset ${JSON.stringify(assetId)} in this project.`, { hint: "Use media_list to see asset ids." });
  if (a.status !== "ready")
    throw new OpError("asset_not_ready", `Asset ${assetId} is ${a.status}; wait for its ingest job (job_wait) before placing it.`);
  return a;
}
const assetDurMs = (a) => Math.round((a.probe?.duration || 0) * 1000);
const assetHasAudio = (a) => a.kind === "audio" || !!a.probe?.audio;

function checkTrackAccepts(t, it, a) {
  const ok =
    (t.kind === "video" && ["clip", "image", "color"].includes(it.kind) && (!a || a.kind !== "audio")) ||
    (t.kind === "audio" && it.kind === "clip" && a && assetHasAudio(a)) ||
    (t.kind === "text" && it.kind === "title") ||
    (t.kind === "caption" && it.kind === "captions");
  if (!ok)
    throw new OpError(
      "wrong_track_kind",
      `A ${it.kind}${a ? ` (${a.kind} asset)` : ""} cannot go on ${t.kind} track ${t.id}.`,
      { hint: "Picture (video/image/color) → video tracks; sound → audio tracks; titles → text; captions → caption." },
    );
}

function checkFree(doc, trackId, start, dur, ignore = []) {
  for (const o of itemsOn(doc, trackId)) {
    if (ignore.includes(o.id)) continue;
    if (start < end(o) && o.start < start + dur) {
      const s = (f) => +f2s(doc, f).toFixed(3);
      const others = itemsOn(doc, trackId).filter((x) => !ignore.includes(x.id));
      let free = start;
      for (const x of others) if (free < end(x) && x.start < free + dur) free = end(x);
      throw new OpError(
        "overlap",
        `${s(start)}–${s(start + dur)} s overlaps ${o.id} (${s(o.start)}–${s(end(o))} s) on ${trackId}. The next free spot of that length starts at ${s(free)} s.`,
        { free_from_s: s(free), hint: "For clips back to back use append; insert pushes later items; overwrite replaces; or use another track (trk_v2, add_track)." },
      );
    }
  }
}

function checkSource(doc, it, a) {
  if (!a || a.kind === "image" || it.kind !== "clip") return;
  const need = it.source.inMs + Math.round(f2s(doc, it.duration) * 1000 * (it.speed || 1));
  const have = assetDurMs(a);
  if (it.source.inMs < 0) throw new OpError("source_bounds", `Source in point is negative for ${it.id}.`);
  if (need > have + 40)
    throw new OpError(
      "source_bounds",
      `${it.id} needs ${(need / 1000).toFixed(2)} s of ${a.id} but it is ${(have / 1000).toFixed(2)} s long.`,
      { hint: "Shorten the duration, lower the source in point, or speed it up." },
    );
}

function validateAnimatable(v, what) {
  if (v === undefined || typeof v === "number") return;
  if (v && Array.isArray(v.kf) && v.kf.every((k) => Number.isFinite(k.t) && Number.isFinite(k.v))) return;
  throw new OpError("bad_value", `${what} must be a number or {"kf":[{"t":frame,"v":value,"ease":"linear"}]}.`);
}

// Keyframes are stored in frames from the item start; agents may give {"s":1.5} instead of {"t":45}.
function normKf(doc, v) {
  if (!v || typeof v !== "object" || !Array.isArray(v.kf)) return v;
  return {
    kf: v.kf.map((k) => {
      const { s: sec, ...rest } = k || {};
      return { ...rest, t: rest.t ?? (sec !== undefined ? s2f(doc, Number(sec)) : undefined) };
    }),
  };
}
// Close-enough preset names are accepted ("subtitle", "end card", "Bold Pop").
const PRESET_ALIAS = { subtitle: "subtitle_box", subtitles: "subtitle_box", box: "subtitle_box", lower: "lower_third", lowerthird: "lower_third", third: "lower_third", centre: "center", middle: "center", centered: "center", big: "big_bold", bigbold: "big_bold", bold: "big_bold", headline: "big_bold", end: "end_card", endcard: "end_card", outro: "end_card", card: "end_card", cta: "end_card", top_title: "top", boldpop: "bold_pop", pop: "bold_pop", plain: "clean", simple: "clean", word: "karaoke", highlight: "karaoke" };
function presetName(p, presets) {
  const k = String(p).toLowerCase().trim().replace(/[\s-]+/g, "_");
  if (presets.includes(k)) return k;
  const a = PRESET_ALIAS[k] || PRESET_ALIAS[k.replace(/_/g, "")];
  return a && presets.includes(a) ? a : p;
}
const TITLE_STYLE = ["preset", "color", "scale", "pos", "fadeInMs", "fadeOutMs"];
const CAPTION_STYLE = ["preset", "position", "maxWords", "uppercase", "color", "highlight"];
const HEX = /^#[0-9a-f]{6}$/i;
function cleanStyle(kind, style = {}) {
  // titles place with pos {x,y}; agents often say position (the captions word) — accept it
  if (kind === "title" && style.position !== undefined) {
    const { position, ...rest } = style;
    const named = { top: 0.2, upper: 0.2, center: 0.5, centre: 0.5, middle: 0.5, lower: 0.78, bottom: 0.82 };
    if (position && typeof position === "object") style = { ...rest, pos: position };
    else if (named[String(position).toLowerCase()] !== undefined) style = { ...rest, pos: { x: 0.5, y: named[String(position).toLowerCase()] } };
    else throw new OpError("bad_value", 'Titles are placed with style.pos {"x":0.5,"y":0.3} (text centre, 0–1) or a preset such as "top"/"center".');
  }
  const allowed = kind === "title" ? TITLE_STYLE : CAPTION_STYLE;
  for (const k of Object.keys(style))
    if (!allowed.includes(k))
      throw new OpError("bad_field", `Unknown ${kind === "title" ? "title" : "caption"} style field "${k}". Allowed: ${allowed.join(", ")}.`, {
        allowed,
        hint: kind === "title" ? "Size is style.scale (1 = the preset's size, 1.5 = half again bigger); place it with style.pos {x,y} — the text centre in 0–1 canvas units; style.color is the text colour (#RRGGBB)." : "Look is style.preset; style.position is lower|center|upper; style.maxWords sets words per caption.",
      });
  const presets = kind === "title" ? TITLE_PRESETS : CAPTION_PRESETS;
  if (style.preset !== undefined) style.preset = presetName(style.preset, presets);
  if (style.preset !== undefined && !presets.includes(style.preset)) throw new OpError("bad_value", `style.preset must be one of ${presets.join(", ")}.`, { allowed: presets });
  for (const k of ["color", "highlight"]) if (style[k] !== undefined && style[k] !== null && !HEX.test(String(style[k]))) throw new OpError("bad_value", `style.${k} must be a colour like "#FFD400".`);
  if (kind === "title") {
    if (style.scale !== undefined && !(Number(style.scale) >= 0.2 && Number(style.scale) <= 5)) throw new OpError("bad_value", "style.scale must be between 0.2 and 5 (1 = the preset's size).");
    if (style.pos !== undefined && style.pos !== null && !(Number.isFinite(style.pos?.x) && Number.isFinite(style.pos?.y))) throw new OpError("bad_value", 'style.pos must be {"x":0.5,"y":0.3} (text centre, 0–1 canvas units) or null for the preset position.');
    for (const k of ["fadeInMs", "fadeOutMs"]) if (style[k] !== undefined && !(Number(style[k]) >= 0 && Number(style[k]) <= 5000)) throw new OpError("bad_value", `style.${k} must be 0–5000 ms.`);
  } else {
    if (style.position !== undefined && !["lower", "center", "upper"].includes(style.position)) throw new OpError("bad_value", "style.position must be lower, center or upper.");
    if (style.maxWords !== undefined && !(Number.isInteger(style.maxWords) && style.maxWords >= 1 && style.maxWords <= 12)) throw new OpError("bad_value", "style.maxWords must be a whole number 1–12.");
  }
  return style;
}

function cleanVisual(v = {}, doc) {
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (!VISUAL_KEYS.includes(k)) throw new OpError("bad_field", `Unknown visual field "${k}".`, { allowed: VISUAL_KEYS });
    out[k] = doc ? normKf(doc, val) : val;
  }
  if (out.fit && !FITS.includes(out.fit)) throw new OpError("bad_value", `fit must be one of ${FITS.join(", ")}.`);
  for (const k of ["scale", "x", "y", "opacity", "rotation"]) validateAnimatable(out[k], `visual.${k}`);
  if (out.bg && !["black", "blur", "none"].includes(out.bg)) throw new OpError("bad_value", `visual.bg must be black, blur or none.`);
  return out;
}
function cleanAudio(v = {}, doc) {
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (!AUDIO_KEYS.includes(k)) throw new OpError("bad_field", `Unknown audio field "${k}".`, { allowed: AUDIO_KEYS });
    out[k] = doc ? normKf(doc, val) : val;
  }
  validateAnimatable(out.gainDb, "audio.gainDb");
  return out;
}

function makeMediaItem(doc, ctx, op, t) {
  if (t.locked) throw new OpError("track_locked", `Track ${t.name} (${t.id}) is locked.`);
  const a = op.asset ? assetInfo(ctx, op.asset) : null;
  let kind = op.color ? "color" : a?.kind === "image" ? "image" : "clip";
  const inMs = toMs(op.in) ?? 0;
  const outMs = toMs(op.out);
  const speed = op.speed ?? 1;
  if (!(speed > 0 && speed <= 16)) throw new OpError("bad_value", "speed must be in (0, 16].");
  let duration = toFrames(doc, op.duration, "duration");
  if (outMs !== undefined) {
    if (duration !== undefined) throw new OpError("bad_request", "Give out (source seconds) or duration (timeline length), not both.");
    if (!(outMs > inMs)) throw new OpError("bad_value", `out (${outMs / 1000} s) must be after in (${inMs / 1000} s).`);
    duration = Math.max(1, s2f(doc, (outMs - inMs) / 1000 / speed));
  }
  if (duration === undefined) {
    if (kind === "clip") duration = s2f(doc, (assetDurMs(a) - inMs) / 1000 / speed);
    else duration = s2f(doc, 4);
  }
  if (!(duration >= 1)) throw new OpError("bad_value", "duration must be at least one frame.");
  const it = { id: newItem(doc, ctx), kind, trackId: t.id, start: 0, duration };
  if (op.name) it.name = String(op.name).slice(0, 120);
  if (a) it.asset = a.id;
  if (op.color) it.color = op.color;
  if (kind === "clip") {
    it.source = { inMs };
    if (speed !== 1) it.speed = speed;
  }
  if (t.kind === "video") it.visual = cleanVisual({ fit: "fill", ...(op.visual || {}) }, doc);
  if (kind === "clip") it.audio = cleanAudio({ enabled: t.kind === "audio" ? true : op.audio?.enabled ?? true, ...(op.audio || {}) }, doc);
  if (op.links) it.links = op.links;
  checkTrackAccepts(t, it, a);
  return { it, a };
}

function addItem(doc, ctx, it, a, as) {
  checkSource(doc, it, a);
  doc.sequence.items[it.id] = it;
  if (as) ctx.aliases[as.replace(/^\$/, "")] = it.id;
  ctx.added.push(it.id);
  ctx.ranges.push([it.start, end(it)]);
}

// Shift items that start at or after `at` by `by` frames on the given tracks.
function ripple(doc, ctx, trackIds, at, by, skip = []) {
  for (const it of Object.values(doc.sequence.items)) {
    if (!trackIds.includes(it.trackId) || skip.includes(it.id) || it.kind === "captions") continue;
    if (it.start >= at) {
      it.start += by;
      ctx.changed.add(it.id);
    }
  }
  for (const m of Object.values(doc.sequence.markers)) if (m.at >= at) m.at += by;
}

function splitAt(doc, ctx, it, at, asRight) {
  if (!(at > it.start && at < end(it)))
    throw new OpError("bad_split", `${it.id} spans [${it.start}, ${end(it)}); split point ${at} must be strictly inside.`);
  const right = structuredClone(it);
  right.id = newItem(doc, ctx);
  right.start = at;
  right.duration = end(it) - at;
  if (right.source) right.source = { inMs: it.source.inMs + Math.round(f2s(doc, at - it.start) * 1000 * (it.speed || 1)) };
  // keyframes are item-local: shift the right half
  shiftKeyframes(right, -(at - it.start));
  it.duration = at - it.start;
  doc.sequence.items[right.id] = right;
  for (const tr of Object.values(doc.sequence.transitions)) if (tr.from === it.id) tr.from = right.id;
  if (asRight) ctx.aliases[asRight.replace(/^\$/, "")] = right.id;
  ctx.added.push(right.id);
  ctx.changed.add(it.id);
  return right;
}

function shiftKeyframes(it, by) {
  for (const group of [it.visual, it.audio]) {
    if (!group) continue;
    for (const [k, v] of Object.entries(group))
      if (v && Array.isArray(v.kf)) group[k] = { kf: v.kf.map((x) => ({ ...x, t: x.t + by })).filter((x) => x.t >= -1e6) };
  }
}

function removeItem(doc, ctx, itemId) {
  delete doc.sequence.items[itemId];
  for (const [tid, tr] of Object.entries(doc.sequence.transitions))
    if (tr.from === itemId || tr.to === itemId) delete doc.sequence.transitions[tid];
  ctx.removed.push(itemId);
}

// Cut [from, to) out of the given tracks; optionally close the gap.
function cutRange(doc, ctx, trackIds, from, to, doRipple) {
  const len = to - from;
  for (const it of Object.values(doc.sequence.items)) {
    if (!trackIds.includes(it.trackId) || it.kind === "captions") continue;
    const s = it.start,
      e = end(it);
    if (e <= from || s >= to) continue;
    if (s >= from && e <= to) {
      removeItem(doc, ctx, it.id);
    } else if (s < from && e > to) {
      const right = splitAt(doc, ctx, it, to);
      it.duration = from - s; // left part
      ctx.changed.add(it.id);
      if (!doRipple) continue;
      right.start = to; // shifted below by ripple
    } else if (s < from) {
      it.duration = from - s;
      ctx.changed.add(it.id);
    } else {
      const cut = to - s;
      if (it.source) it.source.inMs += Math.round(f2s(doc, cut) * 1000 * (it.speed || 1));
      shiftKeyframes(it, -cut);
      it.start = to;
      it.duration = e - to;
      ctx.changed.add(it.id);
    }
  }
  if (doRipple) ripple(doc, ctx, trackIds, to, -len);
  ctx.ranges.push([from, to]);
}

const allTrackIds = (doc) => doc.sequence.tracks.filter((t) => !t.locked).map((t) => t.id);
function checkUnlocked(doc, trackId) {
  const t = doc.sequence.tracks.find((x) => x.id === trackId);
  if (t?.locked) throw new OpError("track_locked", `Track ${t.name} (${t.id}) is locked. Unlock it with set_track {track:"${t.id}", locked:false}.`);
}

const OPS = {
  reorder(doc, ctx, op) {
    // magnetic tracks: lift an item out (closing its gap) and drop it before the item at toIndex
    const it = item(doc, resolveRef(ctx, op.item));
    checkUnlocked(doc, it.trackId);
    const t = it.trackId;
    ctx.ranges.push([it.start, end(it)]);
    ripple(doc, ctx, [t], end(it), -it.duration, [it.id]);
    const rest = itemsOn(doc, t).filter((x) => x.id !== it.id);
    const idx = Math.max(0, Math.min(Number(op.toIndex ?? rest.length), rest.length));
    const at = idx < rest.length ? rest[idx].start : rest.length ? end(rest[rest.length - 1]) : 0;
    ripple(doc, ctx, [t], at, it.duration, [it.id]);
    it.start = at;
    for (const [tid, tr] of Object.entries(doc.sequence.transitions)) if (tr.from === it.id || tr.to === it.id) delete doc.sequence.transitions[tid];
    ctx.changed.add(it.id);
    ctx.ranges.push([it.start, end(it)]);
  },
  set_track(doc, ctx, op) {
    const t = track(doc, resolveRef(ctx, op.track));
    for (const k of ["enabled", "muted", "locked"]) if (op[k] !== undefined) t[k] = !!op[k];
    if (op.name) t.name = String(op.name).slice(0, 40);
    ctx.notes.push(`track ${t.id} updated`);
  },
  set_transition(doc, ctx, op) {
    const tr = doc.sequence.transitions[op.id];
    if (!tr) throw new OpError("unknown_transition", `No transition ${op.id}.`);
    if (op.preset) {
      if (!TRANSITIONS.includes(op.preset)) throw new OpError("bad_value", `preset must be one of ${TRANSITIONS.join(", ")}.`);
      tr.preset = op.preset;
    }
    if (op.duration !== undefined) {
      const from = doc.sequence.items[tr.from], to = doc.sequence.items[tr.to];
      const d = toFrames(doc, op.duration, "duration");
      if (d < 2 || d > Math.min(from.duration, to.duration)) throw new OpError("bad_value", `Transition length must be 2…${Math.min(from.duration, to.duration)} frames.`);
      tr.duration = d;
    }
    ctx.notes.push(`transition ${tr.id}`);
  },
  add_track(doc, ctx, op) {
    const kind = op.kind;
    if (!["video", "audio", "text", "caption"].includes(kind)) throw new OpError("bad_value", "kind must be video, audio, text or caption.");
    const t = { id: ctx.newId("trk", 5), kind, name: op.name || `${kind} ${doc.sequence.tracks.filter((x) => x.kind === kind).length + 1}`, enabled: true };
    if (op.role) t.role = op.role;
    // keep picture tracks grouped; new video tracks go on top of the existing picture tracks
    const lastSameKind = doc.sequence.tracks.map((x) => x.kind).lastIndexOf(kind);
    doc.sequence.tracks.splice(lastSameKind + 1, 0, t);
    if (op.as) ctx.aliases[op.as.replace(/^\$/, "")] = t.id;
    ctx.notes.push(`added track ${t.id}`);
  },
  place(doc, ctx, op) {
    const t = track(doc, resolveRef(ctx, op.track));
    const { it, a } = makeMediaItem(doc, ctx, op, t);
    it.start = toFrames(doc, op.at, "at");
    if (it.start < 0) throw new OpError("bad_value", "at must be ≥ 0.");
    checkFree(doc, t.id, it.start, it.duration);
    addItem(doc, ctx, it, a, op.as);
  },
  append(doc, ctx, op) {
    const t = track(doc, resolveRef(ctx, op.track));
    const { it, a } = makeMediaItem(doc, ctx, op, t);
    const its = itemsOn(doc, t.id);
    it.start = (its.length ? end(its[its.length - 1]) : 0) + (toFrames(doc, op.gap, "gap") || 0);
    addItem(doc, ctx, it, a, op.as);
  },
  insert(doc, ctx, op) {
    const t = track(doc, resolveRef(ctx, op.track));
    const { it, a } = makeMediaItem(doc, ctx, op, t);
    const at = toFrames(doc, op.at, "at");
    const scope = op.ripple === "track" ? [t.id] : allTrackIds(doc);
    const spanning = itemsOn(doc, t.id).find((o) => o.start < at && end(o) > at);
    if (spanning) splitAt(doc, ctx, spanning, at);
    ripple(doc, ctx, scope, at, it.duration);
    it.start = at;
    addItem(doc, ctx, it, a, op.as);
  },
  overwrite(doc, ctx, op) {
    const t = track(doc, resolveRef(ctx, op.track));
    const { it, a } = makeMediaItem(doc, ctx, op, t);
    it.start = toFrames(doc, op.at, "at");
    cutRange(doc, ctx, [t.id], it.start, it.start + it.duration, false);
    addItem(doc, ctx, it, a, op.as);
  },
  move(doc, ctx, op) {
    const it = item(doc, resolveRef(ctx, op.item));
    checkUnlocked(doc, it.trackId);
    const to = op.to !== undefined ? toFrames(doc, op.to, "to") : it.start + toFrames(doc, op.by ?? 0, "by");
    const t = op.track ? track(doc, resolveRef(ctx, op.track)) : track(doc, it.trackId);
    checkTrackAccepts(t, it, it.asset ? ctx.assets[it.asset] : null);
    if (to < 0) throw new OpError("bad_value", "Cannot move before 0.");
    if (op.onOverlap === "overwrite") cutRange(doc, ctx, [t.id], to, to + it.duration, false);
    else checkFree(doc, t.id, to, it.duration, [it.id]);
    ctx.ranges.push([it.start, end(it)]);
    it.start = to;
    it.trackId = t.id;
    ctx.changed.add(it.id);
    ctx.ranges.push([it.start, end(it)]);
  },
  delete(doc, ctx, op) {
    const ids = (op.items || [op.item]).map((x) => resolveRef(ctx, x));
    for (const iid of ids) {
      const it = item(doc, iid);
      checkUnlocked(doc, it.trackId);
      const { start, duration, trackId } = it;
      removeItem(doc, ctx, iid);
      ctx.ranges.push([start, start + duration]);
      if (op.ripple) ripple(doc, ctx, op.ripple === "all" ? allTrackIds(doc) : [trackId], start + duration, -duration);
    }
  },
  delete_range(doc, ctx, op) {
    const from = toFrames(doc, op.from, "from"),
      to = toFrames(doc, op.to, "to");
    if (!(to > from)) throw new OpError("bad_value", "to must be after from.");
    const tracks = !op.tracks || op.tracks === "all" ? allTrackIds(doc) : op.tracks.map((x) => track(doc, resolveRef(ctx, x)).id);
    cutRange(doc, ctx, tracks, from, to, op.ripple !== false);
  },
  trim(doc, ctx, op) {
    const it = item(doc, resolveRef(ctx, op.item));
    checkUnlocked(doc, it.trackId);
    const a = it.asset ? ctx.assets[it.asset] : null;
    const oldEnd = end(it);
    if (op.edge === "end") {
      const newEnd = op.to !== undefined ? toFrames(doc, op.to, "to") : oldEnd + toFrames(doc, op.by ?? 0, "by");
      if (newEnd <= it.start) throw new OpError("bad_value", "Trim would make the item empty.");
      const delta = newEnd - oldEnd;
      if (delta > 0 && !op.ripple) checkFree(doc, it.trackId, oldEnd, delta, [it.id]);
      it.duration = newEnd - it.start;
      checkSource(doc, it, a);
      if (op.ripple) ripple(doc, ctx, op.ripple === "all" ? allTrackIds(doc) : [it.trackId], oldEnd, delta, [it.id]);
    } else if (op.edge === "start") {
      const newStart = op.to !== undefined ? toFrames(doc, op.to, "to") : it.start + toFrames(doc, op.by ?? 0, "by");
      if (newStart >= oldEnd) throw new OpError("bad_value", "Trim would make the item empty.");
      const delta = newStart - it.start; // + shortens, − extends
      if (delta < 0) checkFree(doc, it.trackId, newStart, -delta, [it.id]);
      if (it.source) it.source.inMs += Math.round(f2s(doc, delta) * 1000 * (it.speed || 1));
      shiftKeyframes(it, -delta);
      it.start = newStart;
      it.duration = oldEnd - newStart;
      checkSource(doc, it, a);
      if (op.ripple && delta > 0) {
        it.start -= delta; // keep start, close the gap after
        ripple(doc, ctx, op.ripple === "all" ? allTrackIds(doc) : [it.trackId], oldEnd, -delta, [it.id]);
      }
    } else throw new OpError("bad_value", 'edge must be "start" or "end".');
    ctx.changed.add(it.id);
    ctx.ranges.push([it.start, Math.max(end(it), oldEnd)]);
  },
  split(doc, ctx, op) {
    const it = item(doc, resolveRef(ctx, op.item));
    checkUnlocked(doc, it.trackId);
    splitAt(doc, ctx, it, toFrames(doc, op.at, "at"), op.as);
    ctx.ranges.push([it.start, end(it)]);
  },
  slip(doc, ctx, op) {
    const it = item(doc, resolveRef(ctx, op.item));
    checkUnlocked(doc, it.trackId);
    if (!it.source) throw new OpError("bad_target", `${it.id} has no source media to slip.`);
    it.source.inMs += toMs(op.by);
    checkSource(doc, it, ctx.assets[it.asset]);
    ctx.changed.add(it.id);
    ctx.ranges.push([it.start, end(it)]);
  },
  replace_media(doc, ctx, op) {
    const it = item(doc, resolveRef(ctx, op.item));
    checkUnlocked(doc, it.trackId);
    const a = assetInfo(ctx, op.asset);
    checkTrackAccepts(track(doc, it.trackId), { ...it, kind: a.kind === "image" ? "image" : "clip" }, a);
    it.asset = a.id;
    it.kind = a.kind === "image" ? "image" : "clip";
    if (it.kind === "clip") it.source = { inMs: toMs(op.in) ?? 0 };
    else delete it.source;
    if (op.fit === "source_duration" && it.kind === "clip")
      it.duration = s2f(doc, (assetDurMs(a) - it.source.inMs) / 1000 / (it.speed || 1));
    if (op.links) it.links = { ...(it.links || {}), ...op.links };
    checkSource(doc, it, a);
    ctx.changed.add(it.id);
    ctx.ranges.push([it.start, end(it)]);
  },
  set(doc, ctx, op) {
    const it = item(doc, resolveRef(ctx, op.item));
    checkUnlocked(doc, it.trackId);
    if (op.name !== undefined) it.name = String(op.name).slice(0, 120);
    const isText = it.kind === "title" || it.kind === "captions";
    if (op.visual && isText) throw new OpError("bad_target", `${it.kind === "title" ? "Titles" : "Captions"} have no visual transform. ${it.kind === "title" ? "Use style.scale for size and style.pos {x,y} for position." : "Use style.position and style.preset."}`);
    if (op.audio && it.kind !== "clip") throw new OpError("bad_target", "audio settings apply to video/audio clips.");
    if (op.visual) it.visual = { ...(it.visual || {}), ...cleanVisual(op.visual, doc) };
    if (op.audio) it.audio = { ...(it.audio || {}), ...cleanAudio(op.audio, doc) };
    // custom ffmpeg looks: the render applies them; the preview plays a baked copy (fx.mjs)
    if (op.filter !== undefined) {
      if (!["clip", "image"].includes(it.kind) || (it.kind === "clip" && ctx.assets[it.asset]?.kind === "audio")) throw new OpError("bad_target", "filter applies to video clips and images (for sound, afilter).");
      const f = cleanFilter(op.filter, "video");
      for (const a of filterAssets(f)) assetInfo(ctx, a);
      if (f) it.filter = f;
      else delete it.filter;
    }
    if (op.afilter !== undefined) {
      const a = it.asset ? ctx.assets[it.asset] : null;
      if (it.kind !== "clip" || !(a?.kind === "audio" || a?.probe?.audio)) throw new OpError("bad_target", "afilter applies to clips with sound.");
      const f = cleanFilter(op.afilter, "audio");
      if (f) it.afilter = f;
      else delete it.afilter;
    }
    if (op.speed !== undefined) {
      if (!(op.speed > 0 && op.speed <= 16)) throw new OpError("bad_value", "speed must be in (0, 16].");
      if (it.kind !== "clip") throw new OpError("bad_target", "speed applies to video/audio clips.");
      const old = it.speed || 1;
      it.speed = op.speed;
      // default: keep the same source material, so the clip gets shorter/longer on the timeline
      if (op.keep !== "duration") it.duration = Math.max(1, Math.round((it.duration * old) / op.speed));
      checkSource(doc, it, ctx.assets[it.asset]);
      checkFree(doc, it.trackId, it.start, it.duration, [it.id]);
    }
    if (op.text !== undefined) {
      if (it.kind !== "title") throw new OpError("bad_target", "text applies to titles only.");
      it.text = String(op.text).slice(0, 400);
    }
    if (op.style) {
      if (!isText) throw new OpError("bad_target", "style applies to titles and captions.");
      it.style = { ...(it.style || {}), ...cleanStyle(it.kind, op.style) };
    }
    if (op.color) {
      if (it.kind !== "color") throw new OpError("bad_target", it.kind === "title" ? "A title's text colour is style.color." : "color applies to colour clips.");
      it.color = op.color;
    }
    ctx.changed.add(it.id);
    ctx.ranges.push([it.start, end(it)]);
  },
  add_transition(doc, ctx, op) {
    const from = item(doc, resolveRef(ctx, op.from)),
      to = item(doc, resolveRef(ctx, op.to));
    if (from.trackId !== to.trackId || end(from) !== to.start)
      throw new OpError("not_adjacent", `${from.id} must end exactly where ${to.id} starts, on the same track.`);
    const preset = op.preset || "dissolve";
    if (!TRANSITIONS.includes(preset)) throw new OpError("bad_value", `preset must be one of ${TRANSITIONS.join(", ")}.`);
    const dur = toFrames(doc, op.duration ?? { s: 0.5 }, "duration");
    if (dur < 2 || dur > Math.min(from.duration, to.duration))
      throw new OpError("bad_value", `Transition length must be between 2 frames and the shorter clip (${Math.min(from.duration, to.duration)} frames).`);
    const tid = ctx.newId("trn", 5);
    doc.sequence.transitions[tid] = { id: tid, trackId: from.trackId, from: from.id, to: to.id, preset, duration: dur };
    ctx.notes.push(`transition ${tid}`);
    ctx.ranges.push([to.start - dur, to.start + dur]);
  },
  remove_transition(doc, ctx, op) {
    if (!doc.sequence.transitions[op.id]) throw new OpError("unknown_transition", `No transition ${op.id}.`);
    delete doc.sequence.transitions[op.id];
    ctx.notes.push(`removed ${op.id}`);
  },
  add_title(doc, ctx, op) {
    let t;
    if (op.track) t = track(doc, resolveRef(ctx, op.track));
    else {
      // no track named: the first text track free at that time, else a new one stacked on top
      const at = toFrames(doc, op.at, "at"),
        dur = toFrames(doc, op.duration ?? { s: 3 }, "duration");
      const free = doc.sequence.tracks.filter((x) => x.kind === "text" && !x.locked).find((x) => !itemsOn(doc, x.id).some((o) => at < end(o) && o.start < at + dur));
      if (free) t = free;
      else {
        t = { id: ctx.newId("trk", 5), kind: "text", name: `Titles ${doc.sequence.tracks.filter((x) => x.kind === "text").length + 1}`, enabled: true };
        doc.sequence.tracks.splice(doc.sequence.tracks.map((x) => x.kind).lastIndexOf("text") + 1, 0, t);
        ctx.notes.push(`added text track ${t.id} so the titles can overlap`);
      }
    }
    const style = cleanStyle("title", { preset: "lower_third", ...(op.style || {}) });
    if (!op.text) throw new OpError("bad_value", "text is required.");
    const it = { id: newItem(doc, ctx), kind: "title", trackId: t.id, start: toFrames(doc, op.at, "at"), duration: toFrames(doc, op.duration ?? { s: 3 }, "duration"), text: String(op.text).slice(0, 400), style };
    if (op.name) it.name = op.name;
    checkTrackAccepts(t, it, null);
    checkFree(doc, t.id, it.start, it.duration);
    addItem(doc, ctx, it, null, op.as);
  },
  add_captions(doc, ctx, op) {
    const t = track(doc, resolveRef(ctx, op.track || doc.sequence.tracks.find((x) => x.kind === "caption")?.id));
    for (const o of itemsOn(doc, t.id)) removeItem(doc, ctx, o.id); // one captions layer per caption track
    const style = cleanStyle("captions", { preset: "karaoke", position: "lower", maxWords: 3, ...(op.style || {}) });
    const it = { id: newItem(doc, ctx), kind: "captions", trackId: t.id, start: 0, duration: Math.max(1, seqDuration(doc)), sources: op.sources ? op.sources.map((x) => resolveRef(ctx, x)) : "auto", style };
    if (op.language) it.language = op.language;
    addItem(doc, ctx, it, null, op.as);
  },
  add_marker(doc, ctx, op) {
    const mid = ctx.newId("mkr", 5);
    doc.sequence.markers[mid] = { id: mid, at: toFrames(doc, op.at, "at"), label: String(op.label || "").slice(0, 200), kind: op.kind || "note", ...(op.color ? { color: op.color } : {}) };
    if (op.as) ctx.aliases[op.as.replace(/^\$/, "")] = mid;
    ctx.notes.push(`marker ${mid}`);
  },
  remove_marker(doc, ctx, op) {
    if (!doc.sequence.markers[op.id]) throw new OpError("unknown_marker", `No marker ${op.id}.`);
    delete doc.sequence.markers[op.id];
  },
  set_mix(doc, ctx, op) {
    if (op.ducking !== undefined) {
      if (op.ducking === null || op.ducking === false) doc.sequence.mix.ducking = [];
      else {
        const d = { id: "duck_1", targets: { roles: ["music"] }, triggers: { roles: ["dialogue"] }, depthDb: -12, attackMs: 150, releaseMs: 500, ...op.ducking };
        doc.sequence.mix.ducking = [d];
      }
    }
    if (op.loudness) {
      const presets = { social: -14, podcast: -16, broadcast: -23 };
      const p = op.loudness.preset || "social";
      if (!presets[p] && op.loudness.integratedLufs === undefined) throw new OpError("bad_value", "loudness.preset must be social, podcast or broadcast.");
      doc.settings.loudness = { preset: p, integratedLufs: op.loudness.integratedLufs ?? presets[p], truePeakDb: op.loudness.truePeakDb ?? -1 };
    }
    if (op.background) doc.sequence.background = op.background;
    ctx.notes.push("mix updated");
  },
  set_canvas(doc, ctx, op) {
    if (op.aspect) {
      const p = PRESETS[op.aspect];
      if (!p) throw new OpError("bad_value", `aspect must be one of ${Object.keys(PRESETS).join(", ")}.`);
      Object.assign(doc.settings, p);
    }
    if (op.width || op.height) {
      const w = Math.round(Number(op.width || doc.settings.width)),
        h = Math.round(Number(op.height || doc.settings.height));
      if (!(w >= 144 && w <= 4096 && h >= 144 && h <= 4096)) throw new OpError("bad_value", "width/height must be 144–4096 px.");
      Object.assign(doc.settings, { width: w - (w % 2), height: h - (h % 2) });
    }
    doc.settings.safeZone = doc.settings.height > doc.settings.width ? "reels" : "none";
    if (op.fps) {
      const allowed = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
      if (!allowed.includes(Number(op.fps))) throw new OpError("bad_value", `fps must be one of ${allowed.join(", ")}.`);
      const next = rateOf(Number(op.fps));
      const k = (next.num / next.den) / (doc.settings.rate.num / doc.settings.rate.den);
      const conv = (f) => Math.round(f * k);
      // every frame-based value moves to the new rate; source offsets are in ms and stay put
      for (const it of Object.values(doc.sequence.items)) {
        const s = conv(it.start),
          e = conv(it.start + it.duration);
        it.start = s;
        it.duration = Math.max(1, e - s);
        for (const g of [it.visual, it.audio])
          if (g) for (const [key, v] of Object.entries(g)) if (v && Array.isArray(v.kf)) g[key] = { kf: v.kf.map((x) => ({ ...x, t: conv(x.t) })) };
        ctx.changed.add(it.id);
      }
      for (const tr of Object.values(doc.sequence.transitions)) tr.duration = Math.max(2, conv(tr.duration));
      for (const mk of Object.values(doc.sequence.markers)) mk.at = conv(mk.at);
      doc.settings.rate = next;
    }
    ctx.notes.push(`canvas ${doc.settings.width}x${doc.settings.height}@${+(doc.settings.rate.num / doc.settings.rate.den).toFixed(3)}fps`);
  },
  detach_audio(doc, ctx, op) {
    const it = item(doc, resolveRef(ctx, op.item));
    const a = ctx.assets[it.asset];
    if (it.kind !== "clip" || !a || !assetHasAudio(a)) throw new OpError("bad_target", `${it.id} has no audio to detach.`);
    const t = track(doc, resolveRef(ctx, op.track || doc.sequence.tracks.find((x) => x.kind === "audio")?.id));
    checkFree(doc, t.id, it.start, it.duration);
    const lg = it.linkGroup || ctx.newId("lg", 4);
    it.linkGroup = lg;
    it.audio = { ...(it.audio || {}), enabled: false };
    const au = { id: newItem(doc, ctx), kind: "clip", trackId: t.id, start: it.start, duration: it.duration, asset: it.asset, source: { ...it.source }, linkGroup: lg, audio: { enabled: true } };
    if (it.speed) au.speed = it.speed;
    addItem(doc, ctx, au, a, op.as);
  },
};

export const OP_NAMES = Object.keys(OPS);

export function applyOps(doc, ops, assets, { seed } = {}) {
  if (!Array.isArray(ops) || !ops.length) throw new OpError("bad_request", "ops must be a non-empty array.");
  if (ops.length > 200) throw new OpError("bad_request", "At most 200 ops per batch.");
  const next = structuredClone(doc);
  const ctx = { assets, aliases: {}, added: [], removed: [], changed: new Set(), ranges: [], notes: [], newId: idSource(seed) };
  ops.forEach((op, index) => {
    const fn = OPS[op?.op];
    if (!fn) throw Object.assign(new OpError("unknown_op", `ops[${index}]: unknown op ${JSON.stringify(op?.op)}.`, { allowed: OP_NAMES }), { index });
    try {
      fn(next, ctx, op);
    } catch (e) {
      if (e instanceof OpError) {
        e.message = `ops[${index}] (${op.op}): ${e.message}`;
        e.index = index;
      }
      throw e;
    }
  });
  // transitions live on cuts: drop any whose clips no longer meet, keep lengths legal
  for (const [tid, tr] of Object.entries(next.sequence.transitions)) {
    const a = next.sequence.items[tr.from],
      b = next.sequence.items[tr.to];
    if (!a || !b || a.trackId !== b.trackId || end(a) !== b.start || Math.min(a.duration, b.duration) < 2) {
      delete next.sequence.transitions[tid];
      if (doc.sequence.transitions[tid]) ctx.notes.push(`removed transition ${tid} (its clips no longer meet)`);
      continue;
    }
    tr.trackId = a.trackId;
    tr.duration = Math.min(tr.duration, a.duration, b.duration);
  }
  // captions follow the sequence length
  for (const it of Object.values(next.sequence.items))
    if (it.kind === "captions") it.duration = Math.max(1, seqDuration(next));
  const added = ctx.added.filter((x) => next.sequence.items[x]);
  const removed = ctx.removed.filter((x) => !next.sequence.items[x] && doc.sequence.items[x]);
  const changed = [...ctx.changed].filter((x) => next.sequence.items[x] && !added.includes(x));
  const ranges = ctx.ranges.filter(([a, b]) => b > a);
  return {
    doc: next,
    summary: {
      added,
      removed,
      changed,
      notes: ctx.notes,
      aliases: ctx.aliases,
      affected: ranges.length
        ? { fromS: +f2s(next, Math.min(...ranges.map((r) => r[0]))).toFixed(3), toS: +f2s(next, Math.max(...ranges.map((r) => r[1]))).toFixed(3) }
        : null,
      durationS: { before: +f2s(doc, seqDuration(doc)).toFixed(3), after: +f2s(next, seqDuration(next)).toFixed(3) },
    },
  };
}
