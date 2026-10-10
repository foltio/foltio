// Titles and captions are rendered by libass from one generated .ass file.
// Captions are derived, never stored: transcript words (asset clock) are mapped through each
// clip's source window onto the timeline, so cutting words can never desync them.
import { f2s, end, itemsOn } from "./model.mjs";

const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/{/g, "(").replace(/}/g, ")").replace(/\r?\n/g, "\\N");
const tcs = (sec) => {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    s = Math.floor(sec % 60),
    cs = Math.floor((sec * 100) % 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
};
// "#RRGGBB" + alpha(0..255, 0 = opaque) → &HAABBGGRR
function col(hex = "#FFFFFF", alpha = 0) {
  const h = hex.replace("#", "").padEnd(6, "F");
  const [r, g, b] = [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)];
  return `&H${alpha.toString(16).padStart(2, "0").toUpperCase()}${b}${g}${r}`.toUpperCase();
}

// override-tag colour: &HBBGGRR&
const oc = (hex = "#FFFFFF") => {
  const h = hex.replace("#", "").padEnd(6, "F");
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase();
};

export function captionLayout(doc, preset, position) {
  const W = doc.settings.width,
    H = doc.settings.height;
  const vertical = H > W;
  const size = Math.round((vertical ? W : H) * (preset === "bold_pop" ? 0.085 : 0.068));
  // keep clear of platform UI: Reels/TikTok reserve the bottom ~35% and top ~14%
  const marginV =
    position === "center" ? Math.round(H * 0.45) : position === "upper" ? Math.round(H * 0.72) : Math.round(H * (vertical ? 0.3 : 0.1));
  return { size, marginV, W, H };
}

function styles(doc) {
  const W = doc.settings.width,
    H = doc.settings.height;
  const base = Math.round(Math.min(W, H) * 0.06);
  const font = "Inter";
  const S = (name, o) =>
    `Style: ${name},${o.font || font},${o.size},${o.primary || col("#FFFFFF")},${o.secondary || col("#FFD400")},${o.outline || col("#000000")},${o.back || col("#000000", 0x80)},${o.bold ? -1 : 0},0,0,0,100,100,${o.spacing || 0},0,${o.border || 1},${o.outlineW ?? 3},${o.shadow ?? 0},${o.align},${o.ml ?? Math.round(W * 0.07)},${o.mr ?? Math.round(W * 0.07)},${o.mv},1`;
  const cap = captionLayout(doc, "karaoke", "lower");
  return [
    S("lower_third", { size: base, bold: true, align: 1, mv: Math.round(H * (H > W ? 0.44 : 0.14)), border: 3, outlineW: Math.round(base * 0.35), back: col("#000000", 0x40), outline: col("#000000", 0x40) }),
    S("center", { size: Math.round(base * 1.4), bold: true, align: 5, mv: 0, outlineW: 4, shadow: 2 }),
    S("top", { size: base, bold: true, align: 8, mv: Math.round(H * 0.16), outlineW: 3 }),
    S("big_bold", { size: Math.round(base * 2), bold: true, align: 5, mv: 0, outlineW: 6, shadow: 3, spacing: -1 }),
    S("subtitle_box", { size: Math.round(base * 0.8), align: 2, mv: Math.round(H * 0.18), border: 3, outlineW: Math.round(base * 0.25), back: col("#000000", 0x30), outline: col("#000000", 0x30) }),
    S("end_card", { size: Math.round(base * 1.2), bold: true, align: 5, mv: 0, outlineW: 3 }),
    S("cap_karaoke", { size: cap.size, bold: true, align: 2, mv: cap.marginV, outlineW: Math.round(cap.size * 0.09), shadow: 1 }),
    S("cap_clean", { size: Math.round(cap.size * 0.85), align: 2, mv: cap.marginV, outlineW: Math.round(cap.size * 0.06), shadow: 1 }),
    S("cap_boxed", { size: Math.round(cap.size * 0.85), bold: true, align: 2, mv: cap.marginV, border: 3, outlineW: Math.round(cap.size * 0.22), back: col("#000000", 0x20), outline: col("#000000", 0x20) }),
    S("cap_bold_pop", { size: Math.round(cap.size * 1.15), bold: true, align: 2, mv: cap.marginV, outlineW: Math.round(cap.size * 0.12), shadow: 2 }),
  ];
}

// Map transcript words onto the timeline for one clip.
function wordsForClip(doc, it, transcript) {
  if (!transcript?.words?.length || !it.source) return [];
  const speed = it.speed || 1;
  const t0 = f2s(doc, it.start),
    t1 = f2s(doc, end(it));
  const s0 = it.source.inMs / 1000,
    s1 = s0 + (t1 - t0) * speed;
  const out = [];
  for (const w of transcript.words) {
    // sound tags ([laughter], (footsteps)) help the agent read the scene but never become captions
    if (w.event || /^[\[(].*[\])]$/.test(String(w.w ?? w.text ?? "").trim())) continue;
    const ws = w.s ?? w.start,
      we = w.e ?? w.end;
    if (we <= s0 || ws >= s1) continue;
    const a = t0 + (Math.max(ws, s0) - s0) / speed,
      b = t0 + (Math.min(we, s1) - s0) / speed;
    if (b - a < 0.02) continue;
    out.push({ text: w.w ?? w.text, s: a, e: b, speaker: w.speaker });
  }
  return out;
}

export function captionWords(doc, capItem, assets, transcripts) {
  const words = [];
  const items = Object.values(doc.sequence.items).filter((i) => {
    if (i.kind !== "clip" || !i.asset) return false;
    if (Array.isArray(capItem.sources)) return capItem.sources.includes(i.id);
    const t = doc.sequence.tracks.find((x) => x.id === i.trackId);
    const a = assets[i.asset];
    if (!a || !(a.kind === "audio" || a.probe?.audio)) return false;
    if (t?.kind === "audio") return (t.role || "dialogue") === "dialogue";
    return i.audio?.enabled !== false; // picture clips that carry their own sound
  });
  for (const it of items) words.push(...wordsForClip(doc, it, transcripts[it.asset]));
  words.sort((a, b) => a.s - b.s);
  return words;
}

export function cues(words, maxWords = 3) {
  const out = [];
  let cur = [];
  const flush = () => {
    if (cur.length) out.push(cur);
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i],
      prev = cur[cur.length - 1];
    if (prev && (w.s - prev.e > 0.3 || cur.length >= maxWords || /[.!?…]$/.test(prev.text))) flush();
    cur.push(w);
  }
  flush();
  return out;
}

// When each caption is on screen: from its first word to just after its last, held for at least
// minS (short lines like "Mom?" otherwise flash), never running into the next caption.
export function cueSpans(list, minS = 0.7) {
  return list.map((c, k) => {
    const s = c[0].s;
    const next = list[k + 1]?.[0].s ?? Infinity;
    const e = Math.min(Math.max(c[c.length - 1].e + 0.12, s + minS), next - 0.04);
    return [s, Math.max(e, c[c.length - 1].e)];
  });
}

export function buildAss(doc, assets, transcripts) {
  const W = doc.settings.width,
    H = doc.settings.height;
  const events = [];
  for (const it of Object.values(doc.sequence.items)) {
    const tr = doc.sequence.tracks.find((t) => t.id === it.trackId);
    if (tr && tr.enabled === false) continue;
    if (it.kind === "title") {
      const s = f2s(doc, it.start),
        e = f2s(doc, end(it));
      const st = it.style?.preset || "lower_third";
      const color = it.style?.color ? `\\c${oc(it.style.color)}` : "";
      const fad = `\\fad(${Math.round((it.style?.fadeInMs ?? 200))},${Math.round(it.style?.fadeOutMs ?? 200)})`;
      const sc = it.style?.scale && it.style.scale !== 1 ? `\\fscx${Math.round(it.style.scale * 100)}\\fscy${Math.round(it.style.scale * 100)}` : "";
      const pos = it.style?.pos ? `\\an5\\pos(${Math.round(it.style.pos.x * W)},${Math.round(it.style.pos.y * H)})` : "";
      events.push(`Dialogue: 2,${tcs(s)},${tcs(e)},${st},,0,0,0,,{${fad}${color}${sc}${pos}}${esc(it.text)}`);
    }
  }
  for (const capItem of Object.values(doc.sequence.items).filter((i) => i.kind === "captions")) {
    const tr = doc.sequence.tracks.find((t) => t.id === capItem.trackId);
    if (tr && tr.enabled === false) continue;
    const st = capItem.style || {};
    const preset = st.preset || "karaoke";
    const style = `cap_${preset}`;
    const words = captionWords(doc, capItem, assets, transcripts);
    const hi = oc(st.highlight || "#FFD400");
    const base = oc(st.color || "#FFFFFF");
    const upper = st.uppercase ?? preset !== "clean";
    const T = (x) => esc(upper ? x.toUpperCase() : x);
    const mv = captionLayout(doc, preset, st.position || "lower").marginV; // per-event margin carries the chosen position
    const list = cues(words, st.maxWords || 3);
    const spans = cueSpans(list);
    for (const [ci, cue] of list.entries()) {
      const [cs, ce] = spans[ci];
      if (preset === "karaoke" || preset === "bold_pop") {
        // one event per active word: the speaking word is highlighted (the CapCut look)
        cue.forEach((w, k) => {
          const s = k === 0 ? cs : w.s,
            e = k === cue.length - 1 ? ce : cue[k + 1].s;
          const text = cue.map((x, j) => (j === k ? `{\\c${hi}${preset === "bold_pop" ? "\\fscx112\\fscy112" : ""}}${T(x.text)}{\\c${base}\\fscx100\\fscy100}` : T(x.text))).join(" ");
          events.push(`Dialogue: 1,${tcs(s)},${tcs(e)},${style},,0,0,${mv},,{\\c${base}}${text}`);
        });
      } else {
        events.push(`Dialogue: 1,${tcs(cs)},${tcs(ce)},${style},,0,0,${mv},,${cue.map((x) => T(x.text)).join(" ")}`);
      }
    }
  }
  if (!events.length) return null;
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styles(doc),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}

// Used by timeline_check: caption reading speed (chars/second) per cue.
export function captionStats(doc, assets, transcripts) {
  const cap = Object.values(doc.sequence.items).find((i) => i.kind === "captions");
  if (!cap) return null;
  const words = captionWords(doc, cap, assets, transcripts);
  const cs = cues(words, cap.style?.maxWords || 3);
  const spans = cueSpans(cs);
  const cps = cs.map((c, k) => c.map((w) => w.text).join(" ").length / Math.max(0.2, spans[k][1] - spans[k][0]));
  return { words: words.length, cues: cs.length, maxCps: cps.length ? +Math.max(...cps).toFixed(1) : 0 };
}
export { itemsOn };
