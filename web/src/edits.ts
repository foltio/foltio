// Turning editor gestures into timeline ops. Everything here is pure: it reads the doc and returns
// op batches for useProject().edit(), the same typed ops agents send over MCP.
import type { Doc, Item, Track } from "./api";
import type { FullAsset } from "./useProject";
import { isAnimated, valueAt } from "./engine";

export const fpsOf = (d: Doc) => d.settings.rate.num / d.settings.rate.den;
export const endOf = (it: Item) => it.start + it.duration;
export const itemsOnTrack = (d: Doc, trackId: string) =>
  Object.values(d.sequence.items)
    .filter((i) => i.trackId === trackId)
    .sort((a, b) => a.start - b.start);
export const seqEnd = (d: Doc) => Math.max(0, ...Object.values(d.sequence.items).filter((i) => i.kind !== "captions").map(endOf));
export const pictureEnd = (d: Doc) => {
  const vids = new Set(d.sequence.tracks.filter((t) => t.kind === "video").map((t) => t.id));
  return Math.max(0, ...Object.values(d.sequence.items).filter((i) => vids.has(i.trackId)).map(endOf));
};
// The first (bottom) video track is the main track: magnetic when the magnet is on.
export const mainTrackId = (d: Doc) => d.sequence.tracks.find((t) => t.kind === "video")?.id;
export const trackOf = (d: Doc, id: string) => d.sequence.tracks.find((t) => t.id === id);
export const localFrame = (d: Doc, it: Item, t: number) => Math.round(t * fpsOf(d)) - it.start;
export const fmtTime = (s: number, fps?: number) => {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  if (fps) return `${String(m).padStart(2, "0")}:${String(Math.floor(sec)).padStart(2, "0")}:${String(Math.floor((sec % 1) * fps + 1e-6)).padStart(2, "0")}`;
  return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
};

export function assetDuration(a?: FullAsset) {
  return a?.probe?.duration || a?.duration_s || 0;
}
export const hasAudio = (a?: FullAsset) => !!a && (a.kind === "audio" || !!a.probe?.audio || !!a.audio);

// ---------- keyframes ----------
// Setting an animated value adds/replaces the keyframe at the playhead; a static value is replaced.
export function animSet(cur: any, value: number, lf: number) {
  if (!isAnimated(cur)) return value;
  const kf = cur.kf.filter((k: any) => k.t !== lf);
  kf.push({ t: lf, v: value, ease: "ease_in_out" });
  kf.sort((a: any, b: any) => a.t - b.t);
  return { kf };
}
export const hasKeyAt = (cur: any, lf: number) => isAnimated(cur) && cur.kf.some((k: any) => k.t === lf);
export function toggleKey(cur: any, lf: number, fallback: number) {
  const v = valueAt(cur, lf, fallback);
  if (!isAnimated(cur)) return { kf: [{ t: lf, v, ease: "ease_in_out" }] };
  if (hasKeyAt(cur, lf)) {
    const kf = cur.kf.filter((k: any) => k.t !== lf);
    return kf.length ? { kf } : v;
  }
  return { kf: [...cur.kf, { t: lf, v, ease: "ease_in_out" }].sort((a: any, b: any) => a.t - b.t) };
}
export function keyTimes(it: Item) {
  const s = new Set<number>();
  for (const g of [it.visual, it.audio]) if (g) for (const v of Object.values(g)) if (isAnimated(v)) for (const k of (v as any).kf) s.add(k.t);
  return [...s].sort((a, b) => a - b);
}

// ---------- track compatibility ----------
export function accepts(t: Track, it: Item, a?: FullAsset) {
  if (t.kind === "video") return ["clip", "image", "color"].includes(it.kind) && (!a || a.kind !== "audio");
  if (t.kind === "audio") return it.kind === "clip" && hasAudio(a);
  if (t.kind === "text") return it.kind === "title";
  return it.kind === "captions";
}
export function isFree(d: Doc, trackId: string, start: number, dur: number, ignore: string[] = []) {
  return !itemsOnTrack(d, trackId).some((o) => !ignore.includes(o.id) && start < endOf(o) && o.start < start + dur);
}
// Which audio track a sound belongs on: generation model and roles first, then the file name,
// then "no words in its transcript" → music.
export function roleOfAsset(a: FullAsset) {
  const model = a.origin?.model || a.generated?.model || "";
  if (a.roles?.includes("music") || model.startsWith("audio/music") || model.startsWith("music")) return "music";
  if (a.roles?.includes("sfx") || model === "audio/sfx" || model === "sfx") return "sfx";
  if (model === "audio/tts" || model === "voice" || a.roles?.includes("voice")) return "dialogue";
  const n = (a.name || "").toLowerCase().replace(/[_\-.]+/g, " ");
  if (/\b(music|song|beat|bed|instrumental|soundtrack|bgm|lofi|lo fi|score|theme|loop)\b/.test(n)) return "music";
  if (/\b(sfx|fx|whoosh|swoosh|swish|hit|boom|riser|impact|click|ding|pop|thud|foley)\b/.test(n)) return "sfx";
  if (a.kind === "audio" && a.transcript_words === 0 && assetDuration(a) > 15) return "music";
  return "dialogue";
}
// A free unlocked track of this kind (and audio role) for [start, start+dur), or null.
export function freeTrack(d: Doc, kind: Track["kind"], start: number, dur: number, opts: { role?: string; prefer?: string; ignore?: string[]; skipMain?: boolean } = {}) {
  const main = mainTrackId(d);
  const cands = d.sequence.tracks.filter((t) => t.kind === kind && !t.locked && (kind !== "audio" || !opts.role || (t.role || "dialogue") === opts.role));
  const ordered = opts.prefer ? [...cands.filter((t) => t.id === opts.prefer), ...cands.filter((t) => t.id !== opts.prefer)] : cands;
  for (const t of ordered) {
    if (opts.skipMain && t.id === main) continue;
    if (isFree(d, t.id, start, dur, opts.ignore)) return t.id;
  }
  return null;
}
const trackName = (kind: string, role?: string) => (kind === "audio" ? (role === "music" ? "Music" : role === "sfx" ? "SFX" : "Voice") : kind === "text" ? "Titles" : "Overlay");
// Ops that make sure a track exists; returns the ref to use ("$alias" for a new one).
export function ensureTrack(d: Doc, kind: Track["kind"], start: number, dur: number, opts: { role?: string; prefer?: string; ignore?: string[]; skipMain?: boolean } = {}) {
  const id = freeTrack(d, kind, start, dur, opts);
  if (id) return { ref: id, ops: [] as any[] };
  const n = d.sequence.tracks.filter((t) => t.kind === kind).length + 1;
  return { ref: "$newtrack", ops: [{ op: "add_track", kind, role: kind === "audio" ? opts.role || "dialogue" : undefined, name: `${trackName(kind, opts.role)} ${n}`, as: "$newtrack" }] };
}

// ---------- building ops ----------
export function copyOps(it: Item, at: number, track: string, insert = false): any[] {
  if (it.kind === "title") return [{ op: "add_title", track, at: { f: at }, duration: { f: it.duration }, text: it.text, style: it.style }];
  if (it.kind === "captions") return [];
  const op: any = { op: insert ? "insert" : "place", track, at: { f: at }, duration: { f: it.duration } };
  if (insert) op.ripple = "track";
  if (it.asset) op.asset = it.asset;
  if (it.kind === "color") op.color = it.color || "#000000";
  if (it.source) op.in = it.source.inMs / 1000;
  if (it.speed && it.speed !== 1) op.speed = it.speed;
  if (it.visual) op.visual = it.visual;
  if (it.audio) op.audio = it.audio;
  if (it.name) op.name = it.name;
  return [op];
}

// Paste/duplicate: the same track when it is free there, else another track (or a new one).
export function placeCopiesOps(d: Doc, items: Item[], at: number, magnet: boolean) {
  const ops: any[] = [];
  const main = mainTrackId(d);
  const first = Math.min(...items.map((i) => i.start));
  let made = 0;
  for (const it of [...items].sort((a, b) => a.start - b.start)) {
    if (it.kind === "captions") continue;
    const start = at + (it.start - first);
    if (it.trackId === main && magnet) {
      ops.push(...copyOps(it, start, it.trackId, true));
      continue;
    }
    const t = trackOf(d, it.trackId)!;
    if (isFree(d, t.id, start, it.duration) && !t.locked) ops.push(...copyOps(it, start, t.id));
    else {
      const alt = freeTrack(d, t.kind, start, it.duration, { role: t.role, skipMain: true });
      if (alt) ops.push(...copyOps(it, start, alt));
      else {
        const alias = `$copytrack${made++}`;
        ops.push({ op: "add_track", kind: t.kind, role: t.role, as: alias });
        ops.push(...copyOps(it, start, alias));
      }
    }
  }
  return ops;
}

export function deleteOps(d: Doc, ids: string[], magnet: boolean) {
  const main = mainTrackId(d);
  const items = ids.map((id) => d.sequence.items[id]).filter(Boolean);
  const onMain = items.filter((i) => i.trackId === main).sort((a, b) => b.start - a.start);
  const rest = items.filter((i) => i.trackId !== main);
  const ops: any[] = [];
  if (rest.length) ops.push({ op: "delete", items: rest.map((i) => i.id) });
  if (onMain.length) ops.push({ op: "delete", items: onMain.map((i) => i.id), ...(magnet ? { ripple: true } : {}) });
  return ops;
}

export function splitOps(d: Doc, ids: string[], frame: number) {
  return ids
    .map((id) => d.sequence.items[id])
    .filter((it) => it && it.kind !== "captions" && frame > it.start && frame < endOf(it) && !trackOf(d, it.trackId)?.locked)
    .map((it) => ({ op: "split", item: it.id, at: { f: frame } }));
}

// Items under the playhead that a split/trim with nothing selected should act on.
export function itemsAt(d: Doc, frame: number, kinds = ["clip", "image", "color", "title"]) {
  return Object.values(d.sequence.items).filter((it) => kinds.includes(it.kind) && frame > it.start && frame < endOf(it) && !trackOf(d, it.trackId)?.locked);
}

// Library → timeline. Picture appends to the main track; sound lands on the matching audio track.
export function addAssetOps(d: Doc, a: FullAsset, atSec: number) {
  const fps = fpsOf(d);
  const main = mainTrackId(d)!;
  const dur = assetDuration(a);
  if (a.kind === "video" || a.kind === "image") {
    return [{ op: "append", track: main, asset: a.id, ...(a.kind === "image" ? { duration: { s: 3 } } : {}) }];
  }
  const role = roleOfAsset(a);
  const at = Math.round(atSec * fps);
  const picEnd = pictureEnd(d);
  let len = Math.max(1, Math.round(dur * fps));
  if (role === "music" && picEnd > at + fps) len = Math.min(len, picEnd - at);
  const tr = ensureTrack(d, "audio", at, len, { role });
  return [...tr.ops, { op: "place", track: tr.ref, asset: a.id, at: { f: at }, duration: { f: len }, ...(role === "music" ? { audio: { gainDb: -8, fadeOutMs: 1500 } } : {}) }];
}

// Drop an asset at a frame on a track (null = a new track).
export function dropAssetOps(d: Doc, a: FullAsset, trackId: string | null, frame: number, magnet: boolean, insertIndex?: number) {
  const fps = fpsOf(d);
  const main = mainTrackId(d);
  const role = a.kind === "audio" ? roleOfAsset(a) : undefined;
  const len = a.kind === "image" ? Math.round(3 * fps) : Math.max(1, Math.round(assetDuration(a) * fps));
  const picture = a.kind === "video" || a.kind === "image";
  let t = trackId ? trackOf(d, trackId) : undefined;
  if (t && t.kind !== (picture ? "video" : "audio")) t = undefined; // wrong kind of track: find a matching one
  const base: any = { asset: a.id, duration: { f: len } };
  if (picture && t?.id === main && magnet) {
    const items = itemsOnTrack(d, main!);
    const idx = Math.max(0, Math.min(insertIndex ?? items.length, items.length));
    const at = idx < items.length ? items[idx].start : items.length ? endOf(items[items.length - 1]) : 0;
    return [{ op: "insert", track: main, at: { f: at }, ripple: "track", ...base }];
  }
  if (t && !t.locked && isFree(d, t.id, frame, len)) return [{ op: "place", track: t.id, at: { f: frame }, ...base }];
  const kind = picture ? "video" : "audio";
  const tr = trackId === null ? { ref: "$newtrack", ops: [{ op: "add_track", kind, role, as: "$newtrack" }] } : ensureTrack(d, kind, frame, len, { role, skipMain: picture });
  return [...tr.ops, { op: "place", track: tr.ref, at: { f: frame }, ...base }];
}
