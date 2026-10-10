// The canonical project document. Timeline positions are integer frames at the project rate;
// source offsets are integer milliseconds in the asset's own clock. Items live in a map with
// explicit starts; tracks are ordered bottom → top for picture.
import { id } from "../ids.mjs";

export const PRESETS = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
};

export const rateOf = (fps) =>
  ({ 23.976: { num: 24000, den: 1001 }, 29.97: { num: 30000, den: 1001 }, 59.94: { num: 60000, den: 1001 } })[fps] || { num: Math.round(fps), den: 1 };

export function newDoc({ aspect = "16:9", fps = 30, width, height } = {}) {
  const canvas = width && height ? { width, height } : PRESETS[aspect] || PRESETS["16:9"];
  return {
    schema: "studio.project",
    schemaVersion: 1,
    settings: {
      rate: rateOf(fps),
      width: canvas.width,
      height: canvas.height,
      audio: { sampleRate: 48000, channels: 2 },
      loudness: { preset: "social", integratedLufs: -14, truePeakDb: -1 },
      safeZone: canvas.height > canvas.width ? "reels" : "none",
    },
    sequence: {
      background: "#000000",
      tracks: [
        { id: "trk_v1", kind: "video", name: "V1", enabled: true },
        { id: "trk_v2", kind: "video", name: "V2 (overlays)", enabled: true },
        { id: "trk_t1", kind: "text", name: "Titles", enabled: true },
        { id: "trk_cap", kind: "caption", name: "Captions", enabled: true },
        { id: "trk_a1", kind: "audio", name: "Voice", role: "dialogue", enabled: true },
        { id: "trk_a2", kind: "audio", name: "Music", role: "music", enabled: true },
        { id: "trk_a3", kind: "audio", name: "SFX", role: "sfx", enabled: true },
      ],
      items: {},
      transitions: {},
      markers: {},
      mix: {
        ducking: [
          {
            id: "duck_1",
            targets: { roles: ["music"] },
            triggers: { roles: ["dialogue"] },
            depthDb: -12,
            attackMs: 150,
            releaseMs: 500,
          },
        ],
      },
    },
    plan: { characters: {}, locations: {}, styles: {}, shots: {}, shotOrder: [] },
  };
}

// ---------- time ----------
export const fps = (doc) => doc.settings.rate.num / doc.settings.rate.den;
export const f2s = (doc, f) => (f * doc.settings.rate.den) / doc.settings.rate.num;
export const s2f = (doc, s) => Math.round((s * doc.settings.rate.num) / doc.settings.rate.den);
export function tc(doc, f) {
  const s = f2s(doc, f);
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${sec.toFixed(3).padStart(6, "0")}`;
}
// Timeline times. Plain numbers are SECONDS (that is what transcripts and agents use);
// frames need {"f":45} or "45f". Also {"s":1.5}, {"ms":1500}, "1.5s", "00:00:01.500".
export function toFrames(doc, v, what = "time") {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new OpError("bad_time", `${what} must be a finite number of seconds.`);
    return s2f(doc, v);
  }
  if (typeof v === "object") {
    if (v.f !== undefined) return Math.round(Number(v.f));
    if (v.s !== undefined) return s2f(doc, Number(v.s));
    if (v.ms !== undefined) return s2f(doc, Number(v.ms) / 1000);
  }
  if (typeof v === "string") {
    const str = v.trim();
    let m;
    if ((m = str.match(/^(-?\d+(?:\.\d+)?)\s*s$/))) return s2f(doc, Number(m[1]));
    if ((m = str.match(/^(-?\d+)\s*f$/))) return Number(m[1]);
    if ((m = str.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/)))
      return s2f(doc, Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    if ((m = str.match(/^-?\d+(?:\.\d+)?$/))) return s2f(doc, Number(str));
  }
  throw new OpError("bad_time", `Could not read ${what} ${JSON.stringify(v)}. Use seconds (a number like 1.5, or {"s":1.5}), frames ({"f":45}) or "00:00:01.500".`);
}
// Source times (in, out, slip) are seconds into the asset's own clock.
export const toMs = (v) => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number") return Math.round(v * 1000);
  if (typeof v === "object" && v.ms !== undefined) return Math.round(v.ms);
  if (typeof v === "object" && v.s !== undefined) return Math.round(v.s * 1000);
  if (typeof v === "object" && v.f !== undefined) throw new OpError("bad_time", 'Source times (in/out/slip) are seconds into the clip, not frames: use a number like 12.4 or {"s":12.4}.');
  if (typeof v === "string") {
    const str = v.trim();
    let m;
    if ((m = str.match(/^(-?\d+(?:\.\d+)?)\s*s?$/))) return Math.round(parseFloat(m[1]) * 1000);
    if ((m = str.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/))) return Math.round((Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000);
  }
  throw new OpError("bad_time", `Could not read source time ${JSON.stringify(v)}; use seconds into the clip (12.4 or {"s":12.4}).`);
};

export class OpError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

// ---------- queries ----------
export const itemsOn = (doc, trackId) =>
  Object.values(doc.sequence.items)
    .filter((i) => i.trackId === trackId)
    .sort((a, b) => a.start - b.start);
export const end = (i) => i.start + i.duration;
export const seqDuration = (doc) =>
  Math.max(0, ...Object.values(doc.sequence.items).filter((i) => i.kind !== "captions").map(end));
export const track = (doc, ref) => {
  const t = doc.sequence.tracks.find((x) => x.id === ref || x.name === ref);
  if (!t) throw new OpError("unknown_track", `No track ${JSON.stringify(ref)}.`, { tracks: doc.sequence.tracks.map((x) => `${x.id} (${x.kind}: ${x.name})`) });
  return t;
};
export const item = (doc, ref) => {
  const i = doc.sequence.items[ref];
  if (!i) throw new OpError("unknown_item", `No item ${JSON.stringify(ref)}.`, { hint: "Ids come from project_get(section:'timeline'); pass them back exactly." });
  return i;
};
export const newItemId = (doc) => {
  let k;
  do k = id("itm", 6);
  while (doc.sequence.items[k]);
  return k;
};

// Compact view for agents: one line per item, both clocks, no derived bulk.
export function summarize(doc, assets = {}, { detail = "summary" } = {}) {
  const lines = [];
  const R = doc.settings.rate;
  for (const t of doc.sequence.tracks) {
    const its = itemsOn(doc, t.id);
    lines.push({
      track: t.id,
      kind: t.kind,
      name: t.name,
      role: t.role,
      items: its.map((i) => {
        const a = i.asset ? assets[i.asset] : null;
        const o = {
          id: i.id,
          kind: i.kind,
          start: { f: i.start, s: +f2s(doc, i.start).toFixed(3), tc: tc(doc, i.start) },
          end: { f: end(i), s: +f2s(doc, end(i)).toFixed(3) },
          dur_s: +f2s(doc, i.duration).toFixed(3),
        };
        if (i.name) o.name = i.name;
        if (a) o.asset = `${a.id} (${a.name})`;
        if (i.source) o.source_in_s = i.source.inMs / 1000;
        if (i.speed && i.speed !== 1) o.speed = i.speed;
        if (i.filter || i.afilter) o.fx = [i.filter && "picture", i.afilter && "sound"].filter(Boolean).join("+");
        if (i.text) o.text = i.text.slice(0, 80);
        if (i.kind === "captions") o.captions = i.style?.preset || "clean";
        if (detail === "full") {
          if (i.visual) o.visual = i.visual;
          if (i.filter) o.filter = i.filter;
          if (i.afilter) o.afilter = i.afilter;
          if (i.audio) o.audio = i.audio;
          if (i.style) o.style = i.style;
          if (i.links) o.links = i.links;
        }
        return o;
      }),
    });
  }
  return {
    canvas: `${doc.settings.width}x${doc.settings.height}@${R.num / R.den}fps`,
    duration: { f: seqDuration(doc), s: +f2s(doc, seqDuration(doc)).toFixed(3), tc: tc(doc, seqDuration(doc)) },
    tracks: lines,
    transitions: Object.values(doc.sequence.transitions),
    markers: Object.values(doc.sequence.markers),
    mix: doc.sequence.mix,
  };
}
