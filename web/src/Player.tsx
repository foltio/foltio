import { fxKey } from "./engine";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Doc, Item } from "./api";
import type { FullAsset } from "./useProject";
import type { Clock } from "./clock";
import { captionWords, cues, cueSpans, placement, valueAt } from "./engine";

// Live preview: composites the timeline on a canvas from proxy media, in the browser, using the
// same placement maths as the renderer (server/timeline/layout.mjs). The MP4 render is the exact
// result; this is for instant feedback while editing. Pictures and titles can be selected,
// dragged and scaled directly on the canvas — deliberately: a click only selects, and only what's
// already selected moves, after a real drag, while paused (a click on the picture never shifts it).

type Media = HTMLVideoElement | HTMLAudioElement;
type Slot = { el: Media; src: string; primed: boolean; gain: number; role: string; blocked?: boolean };
type Box = { x: number; y: number; w: number; h: number; rot: number; kind: "visual" | "title" };

const DISSOLVE = new Set(["dissolve", "wipe_left", "wipe_right", "slide_left", "slide_up"]);
const AHEAD = 3,
  BEHIND = 0.8,
  MAX_SLOTS = 24;
const dbGain = (db: number) => Math.pow(10, db / 20);
const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, sans-serif";
// libass sizes text by its full line height (ascender + descender); for Inter that is 1.21 em.
// Matching it keeps the preview's text the same size as the exported video.
const EM = 1 / 1.21,
  ASCENT = 0.969 * EM,
  DESCENT = 0.241 * EM;

export type TransformPatch = { x?: number; y?: number; scale?: number; pos?: { x: number; y: number } };
export type PlayerHandle = { prime: () => void };

// What the preview plays for an item: its asset's proxy, or — when the item has a custom filter —
// the baked copy of that filter (server/media/fxproxy.mjs) once it's ready.
function mediaSrc(it: { asset?: string; filter?: string; afilter?: string } | undefined, a: FullAsset | undefined) {
  if (!it || !a) return null;
  if ((it.filter || it.afilter) && it.asset) {
    const baked = (a as FullAsset & { fx?: Record<string, string> | null }).fx?.[fxKey(it.asset, it.filter, it.afilter)];
    if (baked) return baked;
  }
  return a.proxy || null;
}

// Mirrors the ASS styles in server/timeline/ass.mjs (sizes, bold, outline/box widths, margins).
type TitlePreset = { size: number; weight: number; align: "left" | "center"; anchor: "bottom" | "top" | "middle"; mv: number; mvVertical?: number; box?: number; outline?: number; shadow?: number };
const TITLES: Record<string, TitlePreset> = {
  lower_third: { size: 1, weight: 700, align: "left", anchor: "bottom", mv: 0.14, mvVertical: 0.44, box: 0.35 },
  center: { size: 1.4, weight: 700, align: "center", anchor: "middle", mv: 0, outline: 4, shadow: 2 },
  top: { size: 1, weight: 700, align: "center", anchor: "top", mv: 0.16, outline: 3 },
  big_bold: { size: 2, weight: 700, align: "center", anchor: "middle", mv: 0, outline: 6, shadow: 3 },
  subtitle_box: { size: 0.8, weight: 400, align: "center", anchor: "bottom", mv: 0.18, box: 0.25 },
  end_card: { size: 1.2, weight: 700, align: "center", anchor: "middle", mv: 0, outline: 3 },
};

function wrap(ctx: CanvasRenderingContext2D, text: string, max: number) {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > max) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

export function layoutTitle(ctx: CanvasRenderingContext2D, it: Item, W: number, H: number) {
  const st = it.style || {};
  const P = TITLES[st.preset || "lower_third"] || TITLES.lower_third;
  const base = Math.round(Math.min(W, H) * 0.06);
  const size = Math.round(base * P.size) * (st.scale || 1); // ASS font size = line height
  ctx.font = `${P.weight} ${size * EM}px ${FONT}`;
  const lines = wrap(ctx, String(it.text || ""), W * 0.86);
  const widths = lines.map((l) => ctx.measureText(l).width);
  const lh = size;
  const bw = Math.max(1, ...widths),
    bh = lh * lines.length;
  let align: "left" | "center" = P.align;
  let cx: number, top: number;
  if (st.pos) {
    align = "center";
    cx = st.pos.x * W;
    top = st.pos.y * H - bh / 2;
  } else {
    cx = P.align === "left" ? W * 0.07 : W / 2;
    const mv = (H > W && P.mvVertical !== undefined ? P.mvVertical : P.mv) * H;
    top = P.anchor === "bottom" ? H - mv - bh : P.anchor === "top" ? mv : H / 2 - bh / 2;
  }
  const left = align === "left" ? cx : cx - bw / 2;
  return { P, st, size, base, lines, widths, lh, align, cx, top, box: { x: left, y: top, w: bw, h: bh } };
}

type Props = {
  doc: Doc;
  assets: Record<string, FullAsset>;
  transcripts: Record<string, any>;
  clock: Clock;
  playing: boolean;
  onEnded: () => void;
  showSafe: boolean;
  selectedId?: string;
  onSelect: (id?: string) => void;
  onTransform: (id: string, patch: TransformPatch, phase: "begin" | "move" | "end") => void;
};

export const Player = forwardRef<PlayerHandle, Props>(function Player(props, ref) {
  const { doc } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const guideX = useRef<HTMLDivElement>(null);
  const guideY = useRef<HTMLDivElement>(null);
  const slots = useRef<Map<string, Slot>>(new Map());
  const images = useRef<Map<string, HTMLImageElement>>(new Map());
  const blurCanvas = useRef<HTMLCanvasElement | null>(null);
  const boxes = useRef<Map<string, Box>>(new Map()); // what is on screen now, in project pixels
  const capCache = useRef<{ doc: any; tr: any; cues: any[]; spans: [number, number][] }>({ doc: null, tr: null, cues: [], spans: [] });
  const propsRef = useRef(props);
  propsRef.current = props;
  const stall = useRef(0);
  const bufferingRef = useRef(false);
  const [buffering, setBuffering] = useState(false);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const drag = useRef<null | { id: string; mode: "move" | "scale"; kind: "visual" | "title"; px: number; py: number; s0: number; cx: number; cy: number; d0: number; last: TransformPatch; sx: number; sy: number; live: boolean }>(null);

  const W = doc.settings.width,
    H = doc.settings.height;

  // Called inside the Play click: browsers that want a gesture per media element then allow sound.
  function prime() {
    for (const s of slots.current.values()) {
      const el = s.el;
      s.blocked = false;
      if (!el.paused) continue;
      el.muted = false;
      el.volume = 0;
      el.play()
        .then(() => {
          if (!propsRef.current.playing) el.pause();
        })
        .catch(() => {});
    }
    setSoundBlocked(false);
  }
  useImperativeHandle(ref, () => ({ prime }));

  const setBuf = (v: boolean) => {
    if (bufferingRef.current !== v) {
      bufferingRef.current = v;
      setBuffering(v);
    }
  };

  // canvas backing store follows its on-screen size (capped at the project size)
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      const box = wrapRef.current,
        c = canvasRef.current,
        st = stageRef.current;
      if (!box || !c || !st) return;
      const bw = box.clientWidth - 32,
        bh = box.clientHeight - 32;
      const s = Math.max(0.01, Math.min(bw / W, bh / H));
      const cw = Math.max(60, Math.floor(W * s)),
        ch = Math.max(60, Math.floor(H * s));
      for (const el of [c, st]) {
        el.style.width = `${cw}px`;
        el.style.height = `${ch}px`;
      }
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = Math.round(Math.min(W, cw * dpr));
      c.height = Math.round((c.width * H) / W);
    });
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [W, H]);

  useEffect(
    () => () => {
      for (const s of slots.current.values()) destroy(s.el);
      slots.current.clear();
    },
    [],
  );

  // the clock + compositor loop
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const p = propsRef.current;
      const d = p.doc;
      const fps = d.settings.rate.num / d.settings.rate.den;
      const dur = Math.max(0, ...Object.values(d.sequence.items).filter((i) => i.kind !== "captions").map((i) => (i.start + i.duration) / fps));
      let t = p.clock.get();
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      syncSlots(t);
      if (p.playing) {
        if (isBuffering(t) && stall.current < 2.5) {
          stall.current += dt;
          if (stall.current > 0.25) setBuf(true);
        } else {
          stall.current = 0;
          setBuf(false);
          t = Math.min(dur, t + dt);
          p.clock.set(t);
          if (t >= dur) p.onEnded();
        }
      } else {
        stall.current = 0;
        setBuf(false);
      }
      draw(t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function destroy(el: Media) {
    el.pause();
    el.removeAttribute("src");
    el.load();
  }

  function itemWindow(d: Doc, it: Item) {
    const fps = d.settings.rate.num / d.settings.rate.den;
    let s = it.start / fps,
      e = (it.start + it.duration) / fps;
    for (const tr of Object.values(d.sequence.transitions || {})) {
      if (!DISSOLVE.has(tr.preset)) continue;
      if (tr.to === it.id) s -= tr.duration / fps / 2;
      if (tr.from === it.id) e += tr.duration / fps / 2;
    }
    return { s, e, start: it.start / fps, end: (it.start + it.duration) / fps };
  }

  // one media element per clip near the playhead, created ahead of time so cuts are seamless
  function syncSlots(t: number) {
    const { doc: d, assets } = propsRef.current;
    const want: [string, number][] = [];
    for (const it of Object.values(d.sequence.items)) {
      if (it.kind !== "clip" || !it.asset) continue;
      const a = assets[it.asset];
      if (!a?.proxy || a.status !== "ready") continue;
      const w = itemWindow(d, it);
      if (t >= w.s - AHEAD && t < w.e + BEHIND) want.push([it.id, Math.abs(w.s - t)]);
    }
    want.sort((x, y) => x[1] - y[1]);
    const keep = new Set(want.slice(0, MAX_SLOTS).map((x) => x[0]));
    for (const [id, s] of slots.current)
      if (!keep.has(id) || s.src !== mediaSrc(d.sequence.items[id], assets[d.sequence.items[id]?.asset || ""])) {
        destroy(s.el);
        slots.current.delete(id);
      }
    for (const id of keep) {
      if (slots.current.has(id)) continue;
      const it = d.sequence.items[id];
      const a = assets[it.asset!];
      const tr = d.sequence.tracks.find((x) => x.id === it.trackId);
      const el = (a.kind === "audio" || tr?.kind === "audio" ? document.createElement("audio") : document.createElement("video")) as Media;
      el.preload = "auto";
      (el as HTMLVideoElement).playsInline = true;
      el.muted = true;
      const src = mediaSrc(it, a)!;
      el.src = src;
      slots.current.set(id, { el, src, primed: false, gain: 1, role: "dialogue" });
    }
  }

  function isBuffering(t: number) {
    const d = propsRef.current.doc;
    for (const [id, s] of slots.current) {
      const it = d.sequence.items[id];
      if (!it || s.el.error) continue;
      const w = itemWindow(d, it);
      if (t < w.s || t >= w.e) continue;
      if (s.el.readyState < 3 || s.el.seeking) return true;
    }
    return false;
  }

  function blurred(src: CanvasImageSource, sx: number, sy: number, sw: number, sh: number) {
    // a cheap, portable blur: draw tiny, then let the browser smooth it back up
    const c = (blurCanvas.current ||= document.createElement("canvas"));
    c.width = 24;
    c.height = Math.max(8, Math.round((24 * sh) / sw));
    const x = c.getContext("2d")!;
    x.imageSmoothingEnabled = true;
    x.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c;
  }

  function draw(t: number) {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const p = propsRef.current;
    const d = p.doc,
      A = p.assets;
    const fps = d.settings.rate.num / d.settings.rate.den;
    const k = c.width / W;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.filter = "none";
    ctx.fillStyle = d.sequence.background || "#000";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(k, 0, 0, k, 0, 0); // project pixels from here on
    ctx.imageSmoothingQuality = "high";
    boxes.current.clear();
    const trans = Object.values(d.sequence.transitions || {});
    const duck = d.sequence.mix?.ducking?.[0];
    let speaking = false;
    const live = new Set<string>();

    for (const tr of d.sequence.tracks) {
      if (tr.kind !== "video" && tr.kind !== "audio") continue;
      const hidden = tr.enabled === false;
      const trackMuted = !!tr.muted || hidden;
      const items = Object.values(d.sequence.items)
        .filter((i) => i.trackId === tr.id && ["clip", "image", "color"].includes(i.kind))
        .sort((a, b) => a.start - b.start);
      for (const it of items) {
        const w = itemWindow(d, it);
        if (t < w.s || t >= w.e) continue;
        live.add(it.id);
        const slot = slots.current.get(it.id);
        const a = it.asset ? A[it.asset] : undefined;
        // keep media in step with the timeline clock
        if (slot && it.source) {
          const el = slot.el;
          const speed = it.speed || 1;
          const expected = Math.max(0, it.source.inMs / 1000 + (t - w.start) * speed);
          if (p.playing) {
            const drift = el.currentTime - expected;
            if (Math.abs(drift) > 0.35 || el.ended) el.currentTime = expected;
            else el.playbackRate = Math.min(4, Math.max(0.25, Math.abs(drift) < 0.03 ? speed : speed * (1 - Math.max(-0.3, Math.min(0.3, drift * 2)))));
            if (el.paused && !el.error) {
              el.play().catch(() => {
                if (!el.muted) {
                  el.muted = true;
                  slot.blocked = true;
                  setSoundBlocked(true);
                  el.play().catch(() => {});
                }
              });
            }
          } else {
            if (!el.paused) el.pause();
            if (Math.abs(el.currentTime - expected) > 0.5 / fps && !el.seeking) el.currentTime = expected;
          }
          const au = it.audio || {};
          const off = au.enabled === false || au.mute || trackMuted;
          const lf = (t - w.start) * fps;
          let g = dbGain(valueAt(au.gainDb, lf, 0));
          const fin = (au.fadeInMs || 0) / 1000,
            fout = (au.fadeOutMs || 0) / 1000;
          if (fin && t - w.start < fin) g *= Math.max(0, (t - w.start) / fin);
          if (fout && w.end - t < fout) g *= Math.max(0, (w.end - t) / fout);
          if (t >= w.end || t < w.start) g = 0; // dissolve handles: picture only
          slot.gain = off ? 0 : g;
          slot.role = tr.kind === "video" ? "dialogue" : tr.role || "dialogue";
          if (!slot.blocked) el.muted = off || !p.playing;
          if (slot.role === "dialogue" && !off && g > 0.05 && (a?.kind === "audio" || a?.probe?.audio)) speaking = true;
        }
        if (tr.kind !== "video" || hidden) continue;
        // picture
        const lf = Math.round((t - w.start) * fps);
        let src: CanvasImageSource | null = null;
        let sw = W,
          sh = H;
        if (it.kind === "image" && it.asset) {
          const url = mediaSrc(it, a);
          let img = url ? images.current.get(url) : undefined;
          if (!img && url) {
            img = new Image();
            img.src = url;
            images.current.set(url, img);
          }
          if (img?.complete && img.naturalWidth) {
            src = img;
            sw = img.naturalWidth;
            sh = img.naturalHeight;
          }
        } else if (it.kind === "clip" && slot && slot.el instanceof HTMLVideoElement && slot.el.readyState >= 2 && slot.el.videoWidth) {
          src = slot.el;
          sw = slot.el.videoWidth;
          sh = slot.el.videoHeight;
        }
        const pl = placement(it, it.kind === "color" ? null : { width: sw, height: sh }, W, H, lf);
        // transitions
        let alpha = pl.opacity;
        let dip = 0,
          dipColor = "#000";
        const tin = trans.find((x) => x.to === it.id),
          tout = trans.find((x) => x.from === it.id);
        let backAlpha = 1;
        if (tin) {
          const hd = tin.duration / fps;
          if (DISSOLVE.has(tin.preset)) {
            const f = Math.min(1, Math.max(0, (t - (w.start - hd / 2)) / hd));
            alpha *= f;
            backAlpha = f;
          } else if (t < w.start + hd / 2) {
            dip = 1 - (t - w.start) / (hd / 2);
            dipColor = tin.preset === "dip_white" ? "#fff" : "#000";
          }
        }
        if (tout && !DISSOLVE.has(tout.preset)) {
          const hd = tout.duration / fps;
          if (t > w.end - hd / 2) {
            dip = Math.max(dip, (t - (w.end - hd / 2)) / (hd / 2));
            dipColor = tout.preset === "dip_white" ? "#fff" : "#000";
          }
        }
        if (pl.backdrop === "black") {
          ctx.globalAlpha = backAlpha;
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, W, H);
        }
        if (it.kind === "color") {
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.translate(pl.cx, pl.cy);
          if (pl.rotation) ctx.rotate((pl.rotation * Math.PI) / 180);
          ctx.fillStyle = (it as any).color || "#000";
          ctx.fillRect(-pl.w / 2, -pl.h / 2, pl.w, pl.h);
          ctx.restore();
        } else if (src) {
          const cr = pl.crop;
          const sx = sw * cr.l,
            sy = sh * cr.t,
            sW = sw * (1 - cr.l - cr.r),
            sH = sh * (1 - cr.t - cr.b);
          if (pl.backdrop === "blur") {
            const r = Math.max(W / sW, H / sH);
            ctx.save();
            ctx.globalAlpha = backAlpha;
            ctx.drawImage(blurred(src, sx, sy, sW, sH), (W - sW * r) / 2, (H - sH * r) / 2, sW * r, sH * r);
            ctx.fillStyle = "rgba(0,0,0,0.12)";
            ctx.fillRect(0, 0, W, H);
            ctx.restore();
          }
          ctx.save();
          ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
          ctx.translate(pl.cx, pl.cy);
          if (pl.rotation) ctx.rotate((pl.rotation * Math.PI) / 180);
          if (pl.flip === "h") ctx.scale(-1, 1);
          if (pl.flip === "v") ctx.scale(1, -1);
          ctx.drawImage(src, sx, sy, sW, sH, -pl.w / 2, -pl.h / 2, pl.w, pl.h);
          ctx.restore();
        }
        if (dip > 0) {
          ctx.globalAlpha = Math.min(1, dip);
          ctx.fillStyle = dipColor;
          ctx.fillRect(0, 0, W, H);
        }
        ctx.globalAlpha = 1;
        boxes.current.set(it.id, { x: pl.cx - pl.w / 2, y: pl.cy - pl.h / 2, w: pl.w, h: pl.h, rot: pl.rotation, kind: "visual" });
      }
    }
    // sound levels (with simple preview ducking); park clips that are coming up
    for (const [id, s] of slots.current) {
      const el = s.el;
      if (!live.has(id)) {
        if (!el.paused) el.pause();
        el.muted = true;
        const it = d.sequence.items[id];
        if (it?.source && !s.primed && el.readyState >= 1) {
          const w = itemWindow(d, it);
          el.currentTime = Math.max(0, it.source.inMs / 1000 - (w.start - w.s) * (it.speed || 1));
          s.primed = true;
        }
        continue;
      }
      s.primed = false;
      let g = s.gain;
      if (duck && speaking && s.role === (duck.targets?.roles?.[0] || "music")) g *= dbGain(duck.depthDb ?? -12);
      el.volume = Math.max(0, Math.min(1, g));
    }
    ctx.globalAlpha = 1;
    ctx.filter = "none";
    drawCaptions(ctx, d, A, t);
    drawTitles(ctx, d, t);
    if (p.showSafe) {
      ctx.fillStyle = "rgba(255, 70, 70, 0.14)";
      if (H > W) {
        ctx.fillRect(0, 0, W, H * 0.14);
        ctx.fillRect(0, H * 0.65, W, H * 0.35);
        ctx.fillRect(0, H * 0.14, W * 0.06, H * 0.51);
        ctx.fillRect(W * 0.86, H * 0.14, W * 0.14, H * 0.51);
      } else {
        ctx.fillRect(0, 0, W, H * 0.05);
        ctx.fillRect(0, H * 0.95, W, H * 0.05);
        ctx.fillRect(0, H * 0.05, W * 0.05, H * 0.9);
        ctx.fillRect(W * 0.95, H * 0.05, W * 0.05, H * 0.9);
      }
    }
    placeSelectionBox();
  }

  function drawTitles(ctx: CanvasRenderingContext2D, d: Doc, t: number) {
    const fps = d.settings.rate.num / d.settings.rate.den;
    for (const tr of d.sequence.tracks) {
      if (tr.kind !== "text" || tr.enabled === false) continue;
      for (const it of Object.values(d.sequence.items)) {
        if (it.kind !== "title" || it.trackId !== tr.id) continue;
        const s = it.start / fps,
          e = (it.start + it.duration) / fps;
        if (t < s || t >= e) continue;
        const L = layoutTitle(ctx, it, W, H);
        const fin = (L.st.fadeInMs ?? 200) / 1000,
          fout = (L.st.fadeOutMs ?? 200) / 1000;
        const fade = Math.min(1, fin ? (t - s) / fin : 1, fout ? (e - t) / fout : 1);
        ctx.save();
        ctx.globalAlpha = Math.max(0, fade);
        ctx.textAlign = L.align;
        ctx.textBaseline = "alphabetic";
        ctx.lineJoin = "round";
        L.lines.forEach((ln, i) => {
          const y = L.top + L.lh * i + L.size * ASCENT;
          const lx = L.align === "left" ? L.cx : L.cx - L.widths[i] / 2;
          if (L.P.box) {
            const pad = Math.round(L.base * L.P.box) * (L.st.scale || 1); // BorderStyle 3: the outline width pads the box
            ctx.fillStyle = "rgba(0,0,0,0.75)";
            ctx.fillRect(lx - pad, L.top + L.lh * i - pad, L.widths[i] + pad * 2, L.lh + pad * 2);
          } else {
            if (L.P.shadow) {
              ctx.fillStyle = "rgba(0,0,0,0.5)";
              ctx.fillText(ln, L.cx + L.P.shadow, y + L.P.shadow);
            }
            ctx.lineWidth = (L.P.outline || 3) * 2;
            ctx.strokeStyle = "#000";
            ctx.strokeText(ln, L.cx, y);
          }
          ctx.fillStyle = L.st.color || "#fff";
          ctx.fillText(ln, L.cx, y);
        });
        ctx.restore();
        boxes.current.set(it.id, { ...L.box, rot: 0, kind: "title" });
      }
    }
  }

  function drawCaptions(ctx: CanvasRenderingContext2D, d: Doc, A: Record<string, FullAsset>, t: number) {
    const cap = Object.values(d.sequence.items).find((i) => i.kind === "captions");
    if (!cap) return;
    const ctr = d.sequence.tracks.find((x) => x.id === cap.trackId);
    if (ctr?.enabled === false) return;
    const st = cap.style || {};
    const tr = propsRef.current.transcripts;
    if (capCache.current.doc !== d || capCache.current.tr !== tr) {
      const words = captionWords(d, cap, A, tr);
      const list = cues(words, st.maxWords || 3);
      capCache.current = { doc: d, tr, cues: list, spans: cueSpans(list) };
    }
    const ci = capCache.current.spans.findIndex(([a, b]) => t >= a && t < b);
    if (ci < 0) return;
    const cue = capCache.current.cues[ci];
    const preset = st.preset || "karaoke";
    const vertical = H > W;
    const base = Math.round((vertical ? W : H) * 0.068);
    const size = preset === "bold_pop" ? Math.round(base * 1.15) : preset === "clean" || preset === "boxed" ? Math.round(base * 0.85) : base;
    const outline = Math.round(base * (preset === "clean" ? 0.06 : preset === "bold_pop" ? 0.12 : preset === "boxed" ? 0.22 : 0.09));
    const shadow = preset === "bold_pop" ? 2 : preset === "boxed" ? 0 : 1;
    const mv = st.position === "center" ? Math.round(H * 0.45) : st.position === "upper" ? Math.round(H * 0.72) : Math.round(H * (vertical ? 0.3 : 0.1));
    const upper = st.uppercase ?? preset !== "clean";
    ctx.save();
    ctx.font = `${preset === "clean" ? 400 : 700} ${size * EM}px ${FONT}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.lineJoin = "round";
    const words = cue.map((w: any) => (upper ? String(w.text).toUpperCase() : String(w.text)));
    const space = ctx.measureText(" ").width;
    const widths = words.map((w: string) => ctx.measureText(w).width);
    const lineW = (a: number, b: number) => widths.slice(a, b).reduce((x: number, y: number) => x + y, 0) + space * Math.max(0, b - a - 1);
    // one row, or two balanced rows when it is wider than the frame margins (as libass wraps)
    let breakAt = words.length;
    if (lineW(0, words.length) > W * 0.86 && words.length > 1) {
      let best = 1;
      for (let k = 1; k < words.length; k++) if (Math.max(lineW(0, k), lineW(k, words.length)) < Math.max(lineW(0, best), lineW(best, words.length))) best = k;
      breakAt = best;
    }
    const rows = breakAt < words.length ? [[0, breakAt], [breakAt, words.length]] : [[0, words.length]];
    const yBottom = H - mv - size * DESCENT; // alignment 2: the bottom of the last line sits on the margin
    const active = cue.findIndex((w: any, i: number) => t >= w.s && (i === cue.length - 1 || t < cue[i + 1].s));
    const pos: { x: number; y: number }[] = [];
    rows.forEach(([a, b], r) => {
      const y = yBottom - (rows.length - 1 - r) * size;
      let x = (W - lineW(a, b)) / 2;
      if (preset === "boxed") {
        ctx.fillStyle = "rgba(0,0,0,0.87)";
        ctx.fillRect(x - outline, y - size * ASCENT - outline, lineW(a, b) + outline * 2, size * (ASCENT + DESCENT) + outline * 2);
      }
      for (let i = a; i < b; i++) {
        pos[i] = { x, y };
        x += widths[i] + space;
      }
    });
    words.forEach((w: string, i: number) => {
      const { x, y } = pos[i];
      const hi = (preset === "karaoke" || preset === "bold_pop") && i === active;
      ctx.save();
      if (hi && preset === "bold_pop") {
        ctx.translate(x + widths[i] / 2, y - size * 0.35);
        ctx.scale(1.12, 1.12);
        ctx.translate(-(x + widths[i] / 2), -(y - size * 0.35));
      }
      if (preset !== "boxed") {
        if (shadow) {
          ctx.fillStyle = "rgba(0,0,0,0.5)";
          ctx.fillText(w, x + shadow, y + shadow);
        }
        ctx.lineWidth = outline * 2;
        ctx.strokeStyle = "#000";
        ctx.strokeText(w, x, y);
      }
      ctx.fillStyle = hi ? st.highlight || "#FFD400" : st.color || "#fff";
      ctx.fillText(w, x, y);
      ctx.restore();
    });
    ctx.restore();
  }

  // ---------- direct manipulation ----------
  const cssScale = () => (stageRef.current?.clientWidth || 1) / W;

  function placeSelectionBox() {
    const el = boxRef.current;
    if (!el) return;
    const id = propsRef.current.selectedId;
    const b = id ? boxes.current.get(id) : undefined;
    if (!b) {
      el.style.display = "none";
      return;
    }
    const s = cssScale();
    el.style.display = "block";
    el.style.left = `${b.x * s}px`;
    el.style.top = `${b.y * s}px`;
    el.style.width = `${Math.max(6, b.w * s)}px`;
    el.style.height = `${Math.max(6, b.h * s)}px`;
    el.style.transform = b.rot ? `rotate(${b.rot}deg)` : "";
    el.dataset.kind = b.kind;
  }

  function toProject(e: React.PointerEvent) {
    const r = stageRef.current!.getBoundingClientRect();
    const s = cssScale();
    return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
  }

  function hitTest(px: number, py: number) {
    const d = propsRef.current.doc;
    const order: string[] = [];
    for (const tr of [...d.sequence.tracks].reverse()) {
      if (tr.kind !== "text" && tr.kind !== "video") continue;
      order.push(
        ...Object.values(d.sequence.items)
          .filter((i) => i.trackId === tr.id)
          .sort((a, b) => b.start - a.start)
          .map((i) => i.id),
      );
    }
    // titles sit above every picture
    const ranked = order.filter((id) => boxes.current.get(id)?.kind === "title").concat(order.filter((id) => boxes.current.get(id)?.kind === "visual"));
    for (const id of ranked) {
      const b = boxes.current.get(id)!;
      const cx = b.x + b.w / 2,
        cy = b.y + b.h / 2;
      const r = (-b.rot * Math.PI) / 180;
      const dx = px - cx,
        dy = py - cy;
      const lx = dx * Math.cos(r) - dy * Math.sin(r),
        ly = dx * Math.sin(r) + dy * Math.cos(r);
      const pad = b.kind === "title" ? 12 : 0;
      if (Math.abs(lx) <= b.w / 2 + pad && Math.abs(ly) <= b.h / 2 + pad) return id;
    }
    return undefined;
  }

  function startDrag(e: React.PointerEvent, id: string, mode: "move" | "scale") {
    const p = propsRef.current;
    const it = p.doc.sequence.items[id];
    const b = boxes.current.get(id);
    if (!it || !b) return;
    e.preventDefault();
    e.stopPropagation();
    stageRef.current?.setPointerCapture?.(e.pointerId);
    const pt = toProject(e);
    const cx = b.x + b.w / 2,
      cy = b.y + b.h / 2;
    const fps = p.doc.settings.rate.num / p.doc.settings.rate.den;
    const lf = Math.round((p.clock.get() - it.start / fps) * fps);
    const s0 = b.kind === "title" ? it.style?.scale || 1 : valueAt(it.visual?.scale, lf, 1);
    // it becomes a drag only once the pointer has really moved (see onMove)
    drag.current = { id, mode, kind: b.kind, px: pt.x, py: pt.y, s0, cx, cy, d0: Math.max(4, Math.hypot(pt.x - cx, pt.y - cy)), last: {}, sx: e.clientX, sy: e.clientY, live: false };
  }

  function onMove(e: React.PointerEvent) {
    const g = drag.current;
    if (!g) return;
    // the button came up somewhere we didn't hear about: the drag is over
    if (e.buttons === 0) return onUp();
    if (!g.live) {
      if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 6) return;
      g.live = true;
      propsRef.current.onTransform(g.id, {}, "begin");
    }
    const pt = toProject(e);
    const snap = 8 / cssScale();
    let patch: TransformPatch;
    let showX = false,
      showY = false;
    if (g.mode === "move") {
      let ncx = g.cx + (pt.x - g.px),
        ncy = g.cy + (pt.y - g.py);
      if (Math.abs(ncx - W / 2) < snap) {
        ncx = W / 2;
        showX = true;
      }
      if (Math.abs(ncy - H / 2) < snap) {
        ncy = H / 2;
        showY = true;
      }
      patch = g.kind === "title" ? { pos: { x: +(ncx / W).toFixed(4), y: +(ncy / H).toFixed(4) } } : { x: +((ncx - W / 2) / (W / 2)).toFixed(4), y: +((ncy - H / 2) / (H / 2)).toFixed(4) };
    } else {
      const dist = Math.hypot(pt.x - g.cx, pt.y - g.cy);
      let sc = Math.max(0.05, Math.min(8, g.s0 * (dist / g.d0)));
      if (Math.abs(sc - 1) < 0.03) sc = 1;
      patch = { scale: +sc.toFixed(3) };
    }
    if (guideX.current) guideX.current.style.display = showX ? "block" : "none";
    if (guideY.current) guideY.current.style.display = showY ? "block" : "none";
    g.last = patch;
    propsRef.current.onTransform(g.id, patch, "move");
  }

  function onUp() {
    const g = drag.current;
    if (!g) return;
    drag.current = null;
    if (guideX.current) guideX.current.style.display = "none";
    if (guideY.current) guideY.current.style.display = "none";
    if (g.live) propsRef.current.onTransform(g.id, g.last, "end");
  }

  // the selected picture moved or scaled by hand (plain values, not keyframes): offer to put it back
  const sel = props.selectedId ? doc.sequence.items[props.selectedId] : undefined;
  const v: any = sel && sel.kind !== "title" ? sel.visual || {} : {};
  const plain = (x: any) => typeof x === "number";
  const shifted = !!sel && ((plain(v.x) && Math.abs(v.x) > 0.001) || (plain(v.y) && Math.abs(v.y) > 0.001) || (plain(v.scale) && Math.abs(v.scale - 1) > 0.001));
  const resetFrame = () => {
    if (!sel) return;
    props.onTransform(sel.id, {}, "begin");
    props.onTransform(sel.id, { x: 0, y: 0, scale: 1 }, "end");
  };

  return (
    <div className="player-wrap" ref={wrapRef}>
      <div className="player-frame">
        <canvas ref={canvasRef} className="player-canvas" />
        {doc.settings.width > doc.settings.height && (
          <div
            className="portrait-frame-guide"
            style={{ width: `${Math.min(100, (doc.settings.height * 9 / 16 / doc.settings.width) * 100)}%` }}
            aria-hidden
          >
            <span>9:16</span>
          </div>
        )}
        <div
          className="player-stage"
          ref={stageRef}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            const pt = toProject(e);
            const hit = hitTest(pt.x, pt.y);
            const was = propsRef.current.selectedId;
            props.onSelect(hit);
            // a click selects; only what was already selected can be dragged, and not while playing
            if (hit && hit === was && !propsRef.current.playing) startDrag(e, hit, "move");
          }}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onLostPointerCapture={onUp}
        >
          <div className="sel-box" ref={boxRef} onPointerDown={(e) => props.selectedId && !propsRef.current.playing && startDrag(e, props.selectedId, "move")}>
            {["nw", "ne", "sw", "se"].map((h) => (
              <span key={h} className={`handle ${h}`} onPointerDown={(e) => props.selectedId && !propsRef.current.playing && startDrag(e, props.selectedId, "scale")} />
            ))}
          </div>
          <div className="guide gx" ref={guideX} />
          <div className="guide gy" ref={guideY} />
        </div>
        {shifted && !props.playing && (
          <button className="player-reset" onClick={resetFrame} title="Put it back: centred, full size">
            Reset position
          </button>
        )}
        {buffering && <div className="player-note">Loading media…</div>}
        {soundBlocked && (
          <button className="player-note sound" onClick={prime}>
            The browser blocked sound — click to enable it
          </button>
        )}
      </div>
    </div>
  );
});
