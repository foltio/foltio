// Compile the project document into one FFmpeg filter graph.
// Picture: a colour base, then every video track bottom → top, each item trimmed, speed-changed,
// fitted, transformed (keyframes → per-frame expressions) and overlaid in its time window.
// Transitions: dissolves overlap the clips using source handles and fade the incoming alpha.
// Text: titles and captions come from one libass .ass file. Sound: per-role buses, ducking, loudness.
import { f2s, end, itemsOn, seqDuration, fps as fpsOf } from "../timeline/model.mjs";
import { baseSize, cropOf, rotatedBox } from "../timeline/layout.mjs";
import { withFiles } from "../timeline/fx.mjs";

const DISSOLVES = new Set(["dissolve", "wipe_left", "wipe_right", "slide_left", "slide_up"]);
const n3 = (x) => +Number(x).toFixed(4);

const EASE = {
  linear: (p) => p,
  ease_in: (p) => `(${p})*(${p})`,
  ease_out: (p) => `(1-(1-(${p}))*(1-(${p})))`,
  ease_in_out: (p) => `(0.5-0.5*cos(PI*(${p})))`,
  ease_in_out_sine: (p) => `(0.5-0.5*cos(PI*(${p})))`,
};
// Piecewise keyframe expression over local seconds `T` (a string expression).
export function kfExpr(v, T, fpsVal, fallback = 0) {
  if (v === undefined || v === null) return String(fallback);
  if (typeof v === "number") return String(v);
  const kf = [...v.kf].sort((a, b) => a.t - b.t);
  if (kf.length === 1) return String(kf[0].v);
  let expr = String(kf[kf.length - 1].v);
  for (let i = kf.length - 2; i >= 0; i--) {
    const a = kf[i],
      b = kf[i + 1];
    const ta = n3(a.t / fpsVal),
      tb = n3(b.t / fpsVal);
    const p = `clip((${T}-${ta})/${n3(Math.max(1e-3, tb - ta))},0,1)`;
    const ease = (EASE[a.ease] || EASE.linear)(p);
    expr = `if(lt(${T},${tb}),${a.v}+(${b.v - a.v})*${ease},${expr})`;
  }
  return `if(lt(${T},${n3(kf[0].t / fpsVal)}),${kf[0].v},${expr})`;
}
const animated = (v) => v && typeof v === "object" && Array.isArray(v.kf);

export function compile({ doc, assets, files, quality, assPath, fontsDir, outPath, loudnessMeasured }) {
  const R = fpsOf(doc);
  const RS = `${doc.settings.rate.num}/${doc.settings.rate.den}`; // exact rate for ffmpeg (e.g. 30000/1001)
  const W = quality.width,
    H = quality.height;
  const dur = Math.max(f2s(doc, seqDuration(doc)), 0.1);
  const args = ["-hide_banner", "-y", "-nostdin"];
  const inputs = [];
  const g = [];
  const addInput = (a) => {
    inputs.push(...a);
    return inputs.filter((x) => x === "-i").length - 1;
  };
  g.push(`color=c=${doc.sequence.background || "#000000"}:s=${W}x${H}:r=${RS}:d=${n3(dur)}[base]`);
  let cur = "base";
  let n = 0;
  const audioParts = []; // {label, bus}
  const tracks = doc.sequence.tracks.filter((t) => t.enabled !== false);
  const trans = Object.values(doc.sequence.transitions || {});
  // Overlap plan per dissolve: the incoming clip starts hB early, the outgoing runs tA late,
  // limited by the source footage each has outside its edit points.
  const plan = {};
  for (const tr of trans) {
    if (!DISSOLVES.has(tr.preset)) continue;
    const A = doc.sequence.items[tr.from],
      B = doc.sequence.items[tr.to];
    if (!A || !B) continue;
    const d = f2s(doc, tr.duration);
    const headAvail = (x) => (x.kind === "clip" ? x.source.inMs / 1000 / (x.speed || 1) : Infinity);
    const tailAvail = (x) => {
      if (x.kind !== "clip") return Infinity;
      const dur = assets[x.asset]?.probe?.duration ?? 0;
      return Math.max(0, (dur - (x.source.inMs / 1000 + f2s(doc, x.duration) * (x.speed || 1))) / (x.speed || 1));
    };
    let hB = Math.min(d / 2, headAvail(B));
    const tA = Math.min(d - hB, tailAvail(A));
    hB = Math.min(d - tA, headAvail(B));
    plan[tr.id] = { hB: Math.max(0, hB), tA: Math.max(0, tA), window: Math.max(0, hB) + Math.max(0, tA) };
  }

  const even = (x) => Math.max(2, 2 * Math.round(x / 2));
  for (const t of tracks.filter((t) => t.kind === "video")) {
    for (const it of itemsOn(doc, t.id).filter((i) => ["clip", "image", "color"].includes(i.kind))) {
      const a = it.asset ? assets[it.asset] : null;
      const file = it.asset ? files[it.asset] : null;
      if (it.asset && !file) continue;
      const speed = it.speed || 1;
      const s = f2s(doc, it.start),
        e = f2s(doc, end(it));
      const tin = trans.find((x) => x.to === it.id),
        tout = trans.find((x) => x.from === it.id);
      const srcIn = it.source ? it.source.inMs / 1000 : 0;
      const head = tin ? plan[tin.id]?.hB || 0 : 0;
      const tail = tout ? plan[tout.id]?.tA || 0 : 0;
      const vs = s - head,
        ve = e + tail,
        len = ve - vs;
      const L = `v${n}`;
      let chain;
      if (it.kind === "color") {
        g.push(`color=c=${it.color || "#000000"}:s=${W}x${H}:r=${RS}:d=${n3(len)},format=yuva420p[${L}src]`);
        chain = `[${L}src]`;
      } else if (it.kind === "image") {
        const k = addInput(["-loop", "1", "-framerate", RS, "-t", String(n3(len + 0.1)), "-i", file]);
        chain = `[${k}:v]`;
      } else {
        const k = addInput(["-ss", String(n3(Math.max(0, srcIn - head * speed))), "-t", String(n3(len * speed + 0.2)), "-i", file]);
        it._input = k;
        it._audioOffset = head * speed; // seconds into this input where the item's own window starts
        chain = `[${k}:v]`;
      }
      const v = it.visual || {};
      // 1. source → constant-rate stream, cropped and flipped
      const pre = [];
      if (it.kind === "clip") {
        pre.push("setpts=PTS-STARTPTS");
        if (speed !== 1) pre.push(`setpts=PTS/${speed}`);
      }
      pre.push(`fps=${RS}`);
      const crop = cropOf(v);
      if (crop.l || crop.t || crop.r || crop.b) pre.push(`crop=iw*${n3(1 - crop.l - crop.r)}:ih*${n3(1 - crop.t - crop.b)}:iw*${n3(crop.l)}:ih*${n3(crop.t)}`);
      if (v.flip === "h") pre.push("hflip");
      if (v.flip === "v") pre.push("vflip");
      // the item's own look (a validated chain; LUT assets swapped for local files)
      if (it.filter) pre.push(withFiles(it.filter, files));
      // 2. fit (same maths as the browser preview, see layout.mjs)
      const fit = it.kind === "color" ? "stretch" : v.fit || "fill";
      const src = it.kind === "color" ? { width: W, height: H } : a?.probe?.video;
      const { bw, bh } = baseSize(fit, src?.width || W, src?.height || H, crop, W, H);
      const backdrop = fit === "fit" && it.kind !== "color" ? v.bg || "black" : "none";
      // transitions act on the picture and its backdrop alike
      const fades = [];
      if (tin) {
        const d = f2s(doc, tin.duration);
        if (DISSOLVES.has(tin.preset)) {
          const w = plan[tin.id]?.window || 0;
          if (w >= 0.04) fades.push(`fade=t=in:st=0:d=${n3(w)}:alpha=1`);
        } else if (tin.preset === "dip_black" || tin.preset === "dip_white") fades.push(`fade=t=in:st=0:d=${n3(d / 2)}:color=${tin.preset === "dip_white" ? "white" : "black"}`);
      }
      if (tout && (tout.preset === "dip_black" || tout.preset === "dip_white")) {
        const d = f2s(doc, tout.duration);
        fades.push(`fade=t=out:st=${n3(len - d / 2)}:d=${n3(d / 2)}:color=${tout.preset === "dip_white" ? "white" : "black"}`);
      }
      const shift = `setpts=PTS-STARTPTS+${n3(vs)}/TB`;
      const enable = `enable='between(t,${n3(vs)},${n3(ve)})'`;
      let fg = chain;
      if (backdrop === "blur") {
        g.push(`${chain}${pre.join(",")},split=2[${L}bgsrc][${L}fgsrc]`);
        g.push(`[${L}bgsrc]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:2,eq=brightness=-0.08,format=yuva420p,${[...fades, shift].join(",")}[${L}bg]`);
        g.push(`[${cur}][${L}bg]overlay=0:0:eof_action=pass:${enable}[${L}b]`);
        cur = `${L}b`;
        fg = `[${L}fgsrc]`;
        pre.length = 0;
      } else if (backdrop === "black") {
        g.push(`color=c=black:s=${W}x${H}:r=${RS}:d=${n3(len)},format=yuva420p,${[...fades, shift].join(",")}[${L}bg]`);
        g.push(`[${cur}][${L}bg]overlay=0:0:eof_action=pass:${enable}[${L}b]`);
        cur = `${L}b`;
      }
      // 3. rotate, scale (keyframable) — the layer keeps its own size and is placed by the overlay
      const p = [...pre];
      const Tl = `(t-${n3(head)})`; // item-local seconds inside the layer stream
      const zAnim = animated(v.scale);
      const z = zAnim ? 1 : Number(v.scale ?? 1);
      const rot = typeof v.rotation === "number" ? v.rotation : animated(v.rotation) ? Number(v.rotation.kf[0]?.v || 0) : 0;
      let lw = bw,
        lh = bh;
      if (rot) {
        const { rw, rh } = rotatedBox(bw, bh, rot);
        p.push(`scale=${even(bw)}:${even(bh)}`, "format=yuva420p", `rotate=${n3((rot * Math.PI) / 180)}:c=none:ow=${even(rw)}:oh=${even(rh)}`);
        lw = rw;
        lh = rh;
        if (zAnim) p.push(`scale=w='max(2,trunc(${n3(lw)}*(${kfExpr(v.scale, Tl, R, 1)})/2)*2)':h='max(2,trunc(${n3(lh)}*(${kfExpr(v.scale, Tl, R, 1)})/2)*2)':eval=frame`);
        else if (z !== 1) p.push(`scale=${even(lw * z)}:${even(lh * z)}`);
      } else if (zAnim) {
        p.push(`scale=w='max(2,trunc(${n3(bw)}*(${kfExpr(v.scale, Tl, R, 1)})/2)*2)':h='max(2,trunc(${n3(bh)}*(${kfExpr(v.scale, Tl, R, 1)})/2)*2)':eval=frame`);
      } else p.push(`scale=${even(bw * z)}:${even(bh * z)}`);
      p.push("format=yuva420p");
      // static placement: cut the layer down to the part that is on the canvas
      const posAnim = zAnim || animated(v.x) || animated(v.y);
      let ox = "0",
        oy = "0";
      if (!posAnim) {
        const lwz = rot || z !== 1 ? even(lw * z) : even(bw),
          lhz = rot || z !== 1 ? even(lh * z) : even(bh);
        const lx = Math.round(W / 2 + (Number(v.x || 0) * W) / 2 - lwz / 2),
          ly = Math.round(H / 2 + (Number(v.y || 0) * H) / 2 - lhz / 2);
        const x0 = Math.max(0, lx),
          y0 = Math.max(0, ly),
          x1 = Math.min(W, lx + lwz),
          y1 = Math.min(H, ly + lhz);
        if (x1 - x0 < 2 || y1 - y0 < 2) continue; // entirely off-canvas
        if (x0 !== lx || y0 !== ly || x1 !== lx + lwz || y1 !== ly + lhz) p.push(`crop=${x1 - x0}:${y1 - y0}:${x0 - lx}:${y0 - ly}`);
        ox = String(x0);
        oy = String(y0);
      } else {
        const Ts = `(t-${n3(s)})`; // item-local seconds on the main clock
        const zw = zAnim ? `${n3(lw)}*(${kfExpr(v.scale, Ts, R, 1)})` : `${n3(lw * z)}`;
        const zh = zAnim ? `${n3(lh)}*(${kfExpr(v.scale, Ts, R, 1)})` : `${n3(lh * z)}`;
        ox = `${n3(W / 2)}+(${kfExpr(v.x, Ts, R, 0)})*${n3(W / 2)}-(${zw})/2`;
        oy = `${n3(H / 2)}+(${kfExpr(v.y, Ts, R, 0)})*${n3(H / 2)}-(${zh})/2`;
      }
      // 4. opacity: static, or fades for keyframes that rise from / fall to zero
      if (typeof v.opacity === "number" && v.opacity < 1) p.push(`colorchannelmixer=aa=${n3(Math.max(0, v.opacity))}`);
      else if (animated(v.opacity)) {
        const kf = [...v.opacity.kf].sort((x, y) => x.t - y.t);
        const peak = Math.min(1, Math.max(...kf.map((k) => k.v)));
        if (peak < 1) p.push(`colorchannelmixer=aa=${n3(Math.max(0, peak))}`);
        if (kf.length > 1 && kf[0].v <= 0.05 && kf[1].v > kf[0].v) p.push(`fade=t=in:st=${n3(head + kf[0].t / R)}:d=${n3(Math.max(0.04, (kf[1].t - kf[0].t) / R))}:alpha=1`);
        const l2 = kf[kf.length - 2], l1 = kf[kf.length - 1];
        if (kf.length > 1 && l1.v <= 0.05 && l2.v > l1.v) p.push(`fade=t=out:st=${n3(head + l2.t / R)}:d=${n3(Math.max(0.04, (l1.t - l2.t) / R))}:alpha=1`);
      }
      p.push(...fades, shift);
      g.push(`${fg}${p.join(",")}[${L}]`);
      g.push(`[${cur}][${L}]overlay=x='${ox}':y='${oy}':eval=${posAnim ? "frame" : "init"}:eof_action=pass:${enable}[c${n}]`);
      cur = `c${n}`;
      n++;
    }
  }
  if (assPath) {
    g.push(`[${cur}]subtitles=filename='${assPath}'${fontsDir ? `:fontsdir='${fontsDir}'` : ""}[vsub]`);
    cur = "vsub";
  }
  g.push(`[${cur}]format=yuv420p,trim=0:${n3(dur)},setpts=PTS-STARTPTS[vout]`);

  // ---------- audio ----------
  const roleOf = (t) => (t.kind === "video" ? "dialogue" : t.role || "dialogue");
  let m = 0;
  for (const t of tracks.filter((t) => (t.kind === "audio" || t.kind === "video") && !t.muted)) {
    for (const it of itemsOn(doc, t.id).filter((i) => i.kind === "clip")) {
      const a = assets[it.asset];
      const file = files[it.asset];
      if (!a || !file || !(a.kind === "audio" || a.probe?.audio)) continue;
      const au = it.audio || {};
      if (au.mute || au.enabled === false) continue;
      const speed = it.speed || 1;
      const s = f2s(doc, it.start),
        e = f2s(doc, end(it));
      let k, offset;
      if (t.kind === "video" && it._input !== undefined) {
        k = it._input;
        offset = it._audioOffset || 0;
      } else {
        k = addInput(["-ss", String(n3(it.source.inMs / 1000)), "-t", String(n3((e - s) * speed + 0.2)), "-i", file]);
        offset = 0;
      }
      const L = `a${m++}`;
      const f = [`atrim=start=${n3(offset)}:duration=${n3((e - s) * speed)}`, "asetpts=PTS-STARTPTS"];
      let sp = speed;
      while (sp > 2) (f.push("atempo=2"), (sp /= 2));
      while (sp < 0.5) (f.push("atempo=0.5"), (sp *= 2));
      if (sp !== 1) f.push(`atempo=${n3(sp)}`);
      if (it.afilter) f.push(it.afilter);
      const gain = au.gainDb ?? 0;
      if (animated(gain)) f.push(`volume='pow(10,(${kfExpr(gain, "t", R, 0)})/20)':eval=frame`);
      else if (gain) f.push(`volume=${n3(gain)}dB`);
      const fin = Math.max(0.01, (au.fadeInMs ?? 0) / 1000),
        fout = Math.max(0.01, (au.fadeOutMs ?? 0) / 1000);
      f.push(`afade=t=in:st=0:d=${n3(fin)}`, `afade=t=out:st=${n3(Math.max(0, e - s - fout))}:d=${n3(fout)}`);
      f.push(`adelay=${Math.round(s * 1000)}:all=1`);
      g.push(`[${k}:a]${f.join(",")}[${L}]`);
      audioParts.push({ label: L, bus: roleOf(t) });
    }
  }
  const buses = {};
  for (const p of audioParts) (buses[p.bus] ||= []).push(p.label);
  const busLabels = {};
  for (const [bus, labels] of Object.entries(buses)) {
    const L = `bus_${bus}`;
    if (labels.length === 1) g.push(`[${labels[0]}]anull[${L}]`);
    else g.push(`${labels.map((l) => `[${l}]`).join("")}amix=inputs=${labels.length}:normalize=0:duration=longest[${L}]`);
    busLabels[bus] = L;
  }
  const duck = (doc.sequence.mix?.ducking || [])[0];
  if (duck) {
    const target = duck.targets?.roles?.[0] || "music",
      trigger = duck.triggers?.roles?.[0] || "dialogue";
    if (busLabels[target] && busLabels[trigger]) {
      const depth = Math.min(30, Math.max(3, -(duck.depthDb ?? -12)));
      const ratio = n3(Math.min(20, Math.max(2, depth / 2)));
      g.push(`[${busLabels[trigger]}]asplit=2[duck_trig][duck_sc]`);
      g.push(`[${busLabels[target]}][duck_sc]sidechaincompress=threshold=0.02:ratio=${ratio}:attack=${duck.attackMs ?? 150}:release=${duck.releaseMs ?? 500}:makeup=1[${busLabels[target]}d]`);
      busLabels[trigger] = "duck_trig";
      busLabels[target] = `${busLabels[target]}d`;
    }
  }
  const finalBuses = Object.values(busLabels);
  const lufs = doc.settings.loudness?.integratedLufs ?? -14,
    tp = doc.settings.loudness?.truePeakDb ?? -1;
  let loud = `loudnorm=I=${lufs}:TP=${tp}:LRA=11`;
  if (loudnessMeasured)
    loud += `:measured_I=${loudnessMeasured.input_i}:measured_TP=${loudnessMeasured.input_tp}:measured_LRA=${loudnessMeasured.input_lra}:measured_thresh=${loudnessMeasured.input_thresh}:offset=${loudnessMeasured.target_offset}:linear=true`;
  if (finalBuses.length) {
    const mixIn = finalBuses.map((l) => `[${l}]`).join("");
    g.push(`${mixIn}${finalBuses.length > 1 ? `amix=inputs=${finalBuses.length}:normalize=0:duration=longest,` : ""}${quality.measureLoudness ? "loudnorm=print_format=json" : loud},aresample=48000,apad,atrim=0:${n3(dur)}[aout]`);
  } else {
    g.push(`anullsrc=r=48000:cl=stereo,atrim=0:${n3(dur)}[aout]`);
  }
  return {
    args: [...args, ...inputs],
    graph: g.join(";\n"),
    outArgs: [
      "-map", "[vout]", "-map", "[aout]",
      "-t", String(n3(dur)),
      "-r", RS,
      "-c:v", "libx264", "-preset", quality.preset || "veryfast", "-crf", String(quality.crf ?? 23),
      "-pix_fmt", "yuv420p", "-g", String(Math.round(R * 2)),
      "-c:a", "aac", "-b:a", quality.audioBitrate || "160k", "-ar", "48000", "-ac", "2",
      "-movflags", "+faststart",
      "-threads", String(quality.threads || 8), "-filter_complex_threads", String(quality.threads || 8),
      outPath,
    ],
    durationS: dur,
  };
}
