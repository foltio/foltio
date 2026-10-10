// Free, instant checks before rendering, plus measured QC on a rendered file.
// Agents tend to under-cut, over-hold and declare success early; these are the numbers
// editors' judges use, returned so the agent can act on them.
import { f2s, end, itemsOn, seqDuration } from "./timeline/model.mjs";
import { captionStats } from "./timeline/ass.mjs";
import { ffmpeg } from "./media/ff.mjs";
import { presignGet } from "./storage.mjs";

export function lint(doc, assets, transcripts) {
  const issues = [];
  const dur = f2s(doc, seqDuration(doc));
  const pictureTracks = doc.sequence.tracks.filter((t) => t.kind === "video" && t.enabled !== false);
  // black gaps: times not covered by any picture item
  const spans = pictureTracks
    .flatMap((t) => itemsOn(doc, t.id))
    .filter((i) => ["clip", "image", "color"].includes(i.kind))
    .map((i) => [f2s(doc, i.start), f2s(doc, end(i))])
    .sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  for (const [s, e] of spans) {
    if (s - cursor > 0.05) issues.push({ code: "black_gap", severity: "error", at_s: +cursor.toFixed(3), to_s: +s.toFixed(3), fix: "Nothing is on screen here: extend a clip, add B-roll, or ripple-delete the gap (delete_range)." });
    cursor = Math.max(cursor, e);
  }
  if (spans.length && dur - cursor > 0.05) {
    const over = Object.values(doc.sequence.items).filter((i) => i.kind !== "captions" && f2s(doc, end(i)) > cursor + 0.05 && !pictureTracks.some((t) => t.id === i.trackId));
    issues.push({
      code: "black_tail",
      severity: "warn",
      at_s: +cursor.toFixed(3),
      to_s: +dur.toFixed(3),
      items: over.map((i) => i.id),
      fix: `${over.map((i) => i.id).join(", ") || "Audio or titles"} run${over.length === 1 ? "s" : ""} ${(dur - cursor).toFixed(1)} s past the last picture, so the video ends on black. Trim them: trim {item, edge:"end", to:${+cursor.toFixed(3)}} (and fade music out).`,
    });
  }
  for (const it of Object.values(doc.sequence.items)) {
    if (it.asset && (!assets[it.asset] || assets[it.asset].status !== "ready"))
      issues.push({ code: "media_not_ready", severity: "error", item: it.id, fix: "Wait for ingest (job_wait) or replace the media." });
  }
  // pacing on the main picture track
  const v1 = pictureTracks[0] ? itemsOn(doc, pictureTracks[0].id).filter((i) => i.kind !== "captions") : [];
  const shots = v1.map((i) => f2s(doc, i.duration));
  const cutsPerMin = dur > 0 ? +((Math.max(0, v1.length - 1) / dur) * 60).toFixed(1) : 0;
  const longest = shots.length ? +Math.max(...shots).toFixed(2) : 0;
  const vertical = doc.settings.height > doc.settings.width;
  if (vertical && dur <= 90 && longest > 6) issues.push({ code: "long_static_shot", severity: "info", value_s: longest, fix: "Short vertical edits usually change picture every 2–4 s; split it with B-roll, a punch-in (visual.scale keyframes) or a cut." });
  if (vertical && dur <= 90 && dur > 8 && cutsPerMin < 10) issues.push({ code: "slow_pacing", severity: "info", value: cutsPerMin, fix: "Shorts usually run 15–30 cuts/min. Tighten pauses (delete_range on silences) or add cutaways." });
  // cuts that land inside a spoken word, and jump cuts within one shot
  for (let k = 0; k < v1.length; k++) {
    const it = v1[k];
    if (it.kind !== "clip" || !it.source) continue;
    const words = (transcripts[it.asset]?.words || []).filter((w) => !w.event);
    const srcIn = it.source.inMs / 1000,
      srcOut = srcIn + f2s(doc, it.duration) * (it.speed || 1);
    const inside = (t) => words.find((w) => t > w.s + 0.04 && t < w.e - 0.04);
    const a = inside(srcIn),
      b = inside(srcOut);
    if (a) issues.push({ code: "cut_in_word", severity: "warn", item: it.id, at_s: +f2s(doc, it.start).toFixed(3), word: a.w, fix: `${it.id} starts inside the word "${a.w}" (${a.s}–${a.e} s in the source). Start at ${(a.s - 0.06).toFixed(2)} or ${(a.e + 0.04).toFixed(2)}.` });
    if (b) issues.push({ code: "cut_in_word", severity: "warn", item: it.id, at_s: +f2s(doc, end(it)).toFixed(3), word: b.w, fix: `${it.id} ends inside the word "${b.w}" (${b.s}–${b.e} s in the source). End at ${(b.e + 0.08).toFixed(2)} or ${(b.s - 0.04).toFixed(2)}.` });
    const next = v1[k + 1];
    if (next && next.kind === "clip" && next.asset === it.asset && next.start === end(it) && next.source) {
      const gap = next.source.inMs / 1000 - srcOut;
      const sc = (x) => (typeof x?.visual?.scale === "number" ? x.visual.scale : 1);
      if (gap > 0.3 && gap < 30 && Math.abs(sc(next) - sc(it)) < 0.05 && !doc.sequence.transitions[Object.keys(doc.sequence.transitions).find((tid) => doc.sequence.transitions[tid].from === it.id)])
        issues.push({ code: "jump_cut", severity: "info", at_s: +f2s(doc, next.start).toFixed(3), items: [it.id, next.id], fix: `Same shot and framing either side of this cut (${gap.toFixed(1)} s skipped). Punch in on one side (visual.scale 1.15) or cover the cut with B-roll on trk_v2 — unless the jump is the style.` });
    }
  }
  // titles fighting captions for the same spot on vertical canvases
  const capItem = Object.values(doc.sequence.items).find((i) => i.kind === "captions");
  if (capItem && vertical && (capItem.style?.position || "lower") === "lower")
    for (const t of Object.values(doc.sequence.items).filter((i) => i.kind === "title" && ["lower_third", "subtitle_box"].includes(i.style?.preset || "lower_third") && !i.style?.pos))
      issues.push({ code: "title_over_captions", severity: "warn", item: t.id, at_s: +f2s(doc, t.start).toFixed(3), fix: `${t.id} (${t.style?.preset || "lower_third"}) sits where the captions are. Use preset "center"/"top", set style.pos, or move captions with set {item:"${capItem.id}", style:{position:"upper"}} while it shows.` });
  const cap = captionStats(doc, assets, transcripts);
  const capPreset = capItem?.style?.preset || "karaoke";
  const cpsLimit = capPreset === "karaoke" || capPreset === "bold_pop" ? 28 : 18; // word-by-word styles are read as spoken
  if (cap && cap.maxCps > cpsLimit) issues.push({ code: "captions_fast", severity: "warn", value: cap.maxCps, fix: `Some caption cues run above ${cpsLimit} characters/second. Lower style.maxWords (2) or leave more air around fast lines.` });
  if (cap && cap.words === 0) issues.push({ code: "captions_empty", severity: "warn", fix: "The captions layer has no words: transcribe the dialogue (automatic on upload) or bind captions to the right clips." });
  // loudness sanity from sources
  const hasAudio = Object.values(doc.sequence.items).some((i) => i.kind === "clip" && assets[i.asset] && (assets[i.asset].kind === "audio" || assets[i.asset].probe?.audio) && i.audio?.enabled !== false);
  if (!hasAudio && dur > 0) issues.push({ code: "silent", severity: "info", fix: "No sound on the timeline; add a music bed (gen_quote audio/music) or voice-over." });
  return {
    duration_s: +dur.toFixed(3),
    pacing: { shots: v1.length, cuts_per_min: cutsPerMin, longest_shot_s: longest, median_shot_s: shots.length ? +shots.sort((a, b) => a - b)[Math.floor(shots.length / 2)].toFixed(2) : 0 },
    captions: cap,
    loudness_target: doc.settings.loudness,
    issues,
    ok: !issues.some((i) => i.severity === "error"),
  };
}

// Measured QC on a render: black / frozen / silent spans and integrated loudness.
export async function renderQc(render) {
  const url = await presignGet(render.storage_key, 1800);
  const err = await ffmpeg(
    ["-i", url, "-vf", "blackdetect=d=0.3:pic_th=0.97,freezedetect=n=0.003:d=1.5", "-af", "silencedetect=noise=-45dB:d=1.5,ebur128=peak=true", "-f", "null", "-"],
    { timeoutMs: 5 * 60_000 },
  );
  const spans = (re) => [...err.matchAll(re)].map((m) => [+Number(m[1]).toFixed(2), +Number(m[2]).toFixed(2)]);
  const black = spans(/black_start:(\d+(?:\.\d+)?) black_end:(\d+(?:\.\d+)?)/g);
  const frozen = [];
  let fs = null;
  for (const line of err.split("\n")) {
    let m;
    if ((m = line.match(/freeze_start: (\d+(?:\.\d+)?)/))) fs = Number(m[1]);
    if ((m = line.match(/freeze_end: (\d+(?:\.\d+)?)/)) && fs !== null) (frozen.push([+fs.toFixed(2), +Number(m[1]).toFixed(2)]), (fs = null));
  }
  const silent = [];
  let ss = null;
  for (const line of err.split("\n")) {
    let m;
    if ((m = line.match(/silence_start: (-?\d+(?:\.\d+)?)/))) ss = Math.max(0, Number(m[1]));
    if ((m = line.match(/silence_end: (\d+(?:\.\d+)?)/)) && ss !== null) (silent.push([+ss.toFixed(2), +Number(m[1]).toFixed(2)]), (ss = null));
  }
  const I = err.match(/Integrated loudness:\s+I:\s+(-?\d+(?:\.\d+)?) LUFS/);
  const TP = err.match(/True peak:\s+Peak:\s+(-?\d+(?:\.\d+)?) dBFS/);
  const dur = render.probe?.duration || 0;
  const issues = [];
  for (const [a, b] of black) issues.push({ code: "black_frames", at_s: a, to_s: b });
  for (const [a, b] of frozen) issues.push({ code: "frozen_picture", at_s: a, to_s: b });
  for (const [a, b] of silent) if (b - a > 5) issues.push({ code: "dead_air", at_s: a, to_s: b });
  const lufs = I ? Number(I[1]) : null;
  return {
    render_id: render.id,
    duration_s: dur,
    loudness: { integrated_lufs: lufs, true_peak_db: TP ? Number(TP[1]) : null },
    black,
    frozen,
    silent,
    issues,
    note: "Measurements only. Watch the frames (timeline_view) and judge pacing, story and finish yourself; never report success from these numbers alone.",
  };
}
