// Transcript-aware ops that expand into ordinary delete_range/trim ops before a batch runs.
// They need the words, which applyOps does not see, so projects.mjs expands them first.
//   tighten {pauses_over?:0.6, keep?:0.25, fillers?:true, from?, to?}
//   delete_words {asset, from_word?, to_word?, from?, to?}   (word ids from media_inspect "words", or source seconds)
import { captionWords } from "./ass.mjs";
import { applyOps } from "./ops.mjs";
import { OpError, f2s, end } from "./model.mjs";

export const MACRO_OPS = ["tighten", "delete_words"];
const FILLER = /^(um+|uh+|uhm+|erm+|er|ah+|hmm+|mm+|eh)[.,!?…]*$/i;

const cutTracks = (doc) => doc.sequence.tracks.filter((t) => !t.locked && t.kind !== "caption" && !(t.kind === "audio" && t.role === "music")).map((t) => t.id);

function merge(ranges) {
  const out = [];
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (b - a < 0.02) continue;
    const last = out[out.length - 1];
    if (last && a <= last[1] + 0.01) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

// Delete timeline ranges (latest first so earlier times stay valid) and keep music from running past the end.
function rangeOps(doc, ranges, assets) {
  const tracks = cutTracks(doc);
  const ops = merge(ranges)
    .reverse()
    .map(([a, b]) => ({ op: "delete_range", from: { s: +a.toFixed(3) }, to: { s: +b.toFixed(3) }, tracks, ripple: true }));
  if (!ops.length) return ops;
  try {
    const sim = applyOps(doc, ops, assets).doc;
    const music = new Set(sim.sequence.tracks.filter((t) => t.kind === "audio" && t.role === "music").map((t) => t.id));
    const picEnd = Math.max(0, ...Object.values(sim.sequence.items).filter((i) => i.kind !== "captions" && !music.has(i.trackId)).map(end));
    for (const it of Object.values(sim.sequence.items))
      if (music.has(it.trackId) && end(it) > picEnd && picEnd > it.start) ops.push({ op: "trim", item: it.id, edge: "end", to: { f: picEnd } });
  } catch {
    /* applyOps reports the real error */
  }
  return ops;
}

function expandOne(doc, op, assets, transcripts) {
  const words = captionWords(doc, { id: "_", kind: "captions", trackId: "", start: 0, duration: 0, sources: "auto" }, assets, transcripts);
  if (op.op === "tighten") {
    const over = Number(op.pauses_over ?? 0.6),
      keep = Number(op.keep ?? 0.25);
    if (!(over > 0.1)) throw new OpError("bad_value", "tighten.pauses_over must be more than 0.1 s.");
    const from = op.from !== undefined ? Number(op.from?.s ?? op.from) : 0,
      to = op.to !== undefined ? Number(op.to?.s ?? op.to) : Infinity;
    const inside = (w) => w.s >= from && w.e <= to;
    if (!words.length) throw new OpError("no_transcript", "tighten needs transcripts of the clips on the timeline, and none have words yet.", { hint: 'job_wait {asset_ids:[…]} until transcripts are ready.' });
    const ranges = [];
    let pauses = 0,
      fillers = 0;
    if (op.pauses_over !== null) {
      if (words[0].s > over && from === 0) (ranges.push([0, Math.max(0, words[0].s - keep / 2)]), pauses++);
      for (let i = 1; i < words.length; i++) {
        const a = words[i - 1],
          b = words[i];
        if (!inside(a) || !inside(b)) continue;
        if (b.s - a.e > over) (ranges.push([a.e + keep / 2, b.s - keep / 2]), pauses++);
      }
    }
    if (op.fillers !== false)
      words.forEach((w, i) => {
        if (!inside(w) || !FILLER.test(String(w.text).trim())) return;
        const next = words[i + 1];
        ranges.push([Math.max(0, w.s - 0.02), next && next.s - w.e < 0.8 ? Math.max(w.e, next.s - 0.04) : w.e + 0.05]);
        fillers++;
      });
    const total = merge(ranges).reduce((s, [a, b]) => s + (b - a), 0);
    return { ops: rangeOps(doc, ranges, assets), note: `tighten: ${pauses} pause${pauses === 1 ? "" : "s"} shortened, ${fillers} filler${fillers === 1 ? "" : "s"} cut, ${total.toFixed(1)} s removed` };
  }
  // delete_words: source words (by id or seconds) → every place they appear on the timeline
  const a = assets[op.asset];
  if (!a) throw new OpError("unknown_asset", `No asset ${JSON.stringify(op.asset)} in this project.`);
  const t = transcripts[op.asset];
  let s0, s1;
  if (op.from_word || op.to_word) {
    if (!t?.words?.length) throw new OpError("no_transcript", `${op.asset} has no transcript yet.`);
    const fw = t.words.find((w) => w.id === (op.from_word || op.to_word)),
      tw = t.words.find((w) => w.id === (op.to_word || op.from_word));
    if (!fw || !tw) throw new OpError("unknown_word", `Word ids come from media_inspect {asset_id:"${op.asset}", view:"words"} (w0, w1, …).`);
    const next = t.words[t.words.indexOf(tw) + 1];
    s0 = fw.s - 0.02;
    s1 = next && next.s - tw.e < 1.5 ? Math.max(tw.e, next.s - 0.04) : tw.e + 0.05;
  } else {
    s0 = Number(op.from?.s ?? op.from);
    s1 = Number(op.to?.s ?? op.to);
    if (!(s1 > s0)) throw new OpError("bad_value", "delete_words needs from_word/to_word, or from < to in source seconds.");
  }
  const ranges = [];
  for (const it of Object.values(doc.sequence.items)) {
    if (it.asset !== op.asset || !it.source) continue;
    const speed = it.speed || 1;
    const inS = it.source.inMs / 1000,
      outS = inS + f2s(doc, it.duration) * speed;
    const a2 = Math.max(s0, inS),
      b2 = Math.min(s1, outS);
    if (b2 - a2 < 0.02) continue;
    const st = f2s(doc, it.start);
    ranges.push([st + (a2 - inS) / speed, st + (b2 - inS) / speed]);
  }
  if (!ranges.length) throw new OpError("not_on_timeline", `Those words of ${op.asset} are not used on the timeline.`);
  return { ops: rangeOps(doc, ranges, assets), note: `delete_words: cut ${ranges.length} place${ranges.length > 1 ? "s" : ""}` };
}

// Expand macro ops in a batch. Each macro sees the timeline as the ops before it in the batch left
// it (simulated with the batch's seed, so ids match the real apply).
export function expandMacros(doc, ops, assets, transcripts, seed) {
  if (!Array.isArray(ops) || !ops.some((o) => MACRO_OPS.includes(o?.op))) return { ops, notes: [] };
  const out = [],
    notes = [];
  ops.forEach((o, index) => {
    if (!MACRO_OPS.includes(o?.op)) return out.push(o);
    const base = out.length ? applyOps(doc, out, assets, { seed }).doc : doc; // errors here belong to the earlier ops
    try {
      const r = expandOne(base, o, assets, transcripts);
      out.push(...r.ops);
      notes.push(r.note);
    } catch (e) {
      if (e instanceof OpError) e.message = `ops[${index}] (${o.op}): ${e.message}`;
      throw e;
    }
  });
  return { ops: out, notes };
}
