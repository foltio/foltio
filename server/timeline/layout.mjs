// Where a picture sits on the canvas. Shared by the FFmpeg compiler and the browser preview so
// both agree: the source (after crop) is fitted to the canvas (fill covers it, fit sits inside,
// stretch matches it), scaled about its centre, rotated, then moved by (x·W/2, y·H/2). Whatever
// falls outside the canvas is cut off. In fit mode a black or blurred full-canvas backdrop sits
// behind the picture and does not move with it.

export const EASE_FN = {
  linear: (p) => p,
  ease_in: (p) => p * p,
  ease_out: (p) => 1 - (1 - p) * (1 - p),
  ease_in_out: (p) => 0.5 - 0.5 * Math.cos(Math.PI * p),
  ease_in_out_sine: (p) => 0.5 - 0.5 * Math.cos(Math.PI * p),
};

export const isAnimated = (v) => !!v && typeof v === "object" && Array.isArray(v.kf);

// Value of an animatable field at an item-local frame.
export function valueAt(v, frame, fallback) {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "number") return v;
  const kf = [...(v.kf || [])].sort((a, b) => a.t - b.t);
  if (!kf.length) return fallback;
  if (frame <= kf[0].t) return kf[0].v;
  for (let i = 0; i < kf.length - 1; i++) {
    const a = kf[i],
      b = kf[i + 1];
    if (frame < b.t) {
      const p = (frame - a.t) / Math.max(1e-6, b.t - a.t);
      return a.v + (b.v - a.v) * (EASE_FN[a.ease] || EASE_FN.linear)(p);
    }
  }
  return kf[kf.length - 1].v;
}

export const cropOf = (v = {}) => ({ l: 0, t: 0, r: 0, b: 0, ...(v.crop || {}) });

// Size of the fitted picture before scale/rotation, in canvas pixels.
export function baseSize(fit, srcW, srcH, crop, W, H) {
  const cw = Math.max(1, srcW * (1 - crop.l - crop.r)),
    ch = Math.max(1, srcH * (1 - crop.t - crop.b));
  if (fit === "stretch") return { bw: W, bh: H };
  const r = fit === "fit" ? Math.min(W / cw, H / ch) : Math.max(W / cw, H / ch);
  return { bw: cw * r, bh: ch * r };
}

// Bounding box of a w×h rectangle rotated by `deg`.
export function rotatedBox(w, h, deg) {
  const r = (deg * Math.PI) / 180;
  const c = Math.abs(Math.cos(r)),
    s = Math.abs(Math.sin(r));
  return { rw: w * c + h * s, rh: w * s + h * c };
}

// Full placement at one item-local frame: centre, drawn size, rotation and opacity.
export function placement(item, src, W, H, frame) {
  const v = item.visual || {};
  const fit = item.kind === "color" ? "stretch" : v.fit || "fill";
  const crop = cropOf(v);
  const { bw, bh } = baseSize(fit, src?.width || W, src?.height || H, crop, W, H);
  const scale = valueAt(v.scale, frame, 1);
  return {
    fit,
    crop,
    bw,
    bh,
    scale,
    w: bw * scale,
    h: bh * scale,
    cx: W / 2 + (valueAt(v.x, frame, 0) * W) / 2,
    cy: H / 2 + (valueAt(v.y, frame, 0) * H) / 2,
    rotation: valueAt(v.rotation, frame, 0),
    opacity: Math.max(0, Math.min(1, valueAt(v.opacity, frame, 1))),
    backdrop: fit === "fit" && item.kind !== "color" ? v.bg || "black" : "none",
    flip: v.flip,
  };
}
