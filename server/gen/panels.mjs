// Cutting a storyboard sheet into its panels, so a clip can be watched as its panels in time before
// its video is made. A sheet is rendered frames on
// light paper with thin captions between them: panels show up as tall bands of dense rows, split
// into columns by paper gutters. Analysis runs on a small RGB copy; the crops come from the original.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ffmpeg, ffprobe } from "../media/ff.mjs";

export const ANALYSE = { w: 512, h: 288 };

// The paper colour: the median of a thin ring around the edge of the sheet.
function paperOf(rgb, w, h) {
  const rs = [];
  const gs = [];
  const bs = [];
  const take = (x, y) => {
    const i = (y * w + x) * 3;
    rs.push(rgb[i]);
    gs.push(rgb[i + 1]);
    bs.push(rgb[i + 2]);
  };
  for (let x = 0; x < w; x += 2) for (const y of [1, 2, h - 3, h - 2]) take(x, y);
  for (let y = 0; y < h; y += 2) for (const x of [1, 2, w - 3, w - 2]) take(x, y);
  const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
  return [med(rs), med(gs), med(bs)];
}

// Runs of indexes where on(i) holds, joining runs split by at most `gap` misses.
function runs(n, on, gap = 2) {
  const out = [];
  let start = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (!on(i)) continue;
    if (start >= 0 && i - last <= gap + 1) last = i;
    else {
      if (start >= 0) out.push([start, last]);
      start = last = i;
    }
  }
  if (start >= 0) out.push([start, last]);
  return out;
}

const longest = (rs) => rs.reduce((best, r) => (!best || r[1] - r[0] > best[1] - best[0] ? r : best), null);

// rgb: w×h×3 bytes. Returns the panels as boxes {x, y, w, h} in those pixels, in reading order, or
// null when the sheet doesn't split cleanly into `expected` panels.
export function findPanels(rgb, w, h, expected) {
  const paper = paperOf(rgb, w, h);
  const ink = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const d = Math.hypot(rgb[p * 3] - paper[0], rgb[p * 3 + 1] - paper[1], rgb[p * 3 + 2] - paper[2]);
    ink[p] = d > 38 ? 1 : 0;
  }
  const density = (x0, x1, y0, y1, byRow) => {
    const n = byRow ? y1 - y0 + 1 : x1 - x0 + 1;
    const out = new Float32Array(n);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (ink[y * w + x]) out[byRow ? y - y0 : x - x0]++;
    const span = byRow ? x1 - x0 + 1 : y1 - y0 + 1;
    for (let i = 0; i < n; i++) out[i] /= span;
    return out;
  };
  // 1. bands of rows dense enough to hold panels (titles, captions and the cast strip are sparse)
  const rowD = density(0, w - 1, 0, h - 1, true);
  const bands = runs(h, (y) => rowD[y] >= 0.3).filter(([a, b]) => b - a + 1 >= h * 0.1);
  const boxes = [];
  for (const [y0, y1] of bands) {
    if (boxes.length >= expected) break;
    // 2. columns within the band: panels are solid, gutters are paper
    const colD = density(0, w - 1, y0, y1, false);
    const cols = runs(w, (x) => colD[x] >= 0.5, 1).filter(([a, b]) => b - a + 1 >= w * 0.06);
    for (const [x0, x1] of cols) {
      // 3. tighten each panel to its own solid rows and columns
      const rd = density(x0, x1, Math.max(0, y0 - 4), Math.min(h - 1, y1 + 4), true);
      const r = longest(runs(rd.length, (i) => rd[i] >= 0.55, 1));
      if (!r) continue;
      const ty0 = Math.max(0, y0 - 4) + r[0];
      const ty1 = Math.max(0, y0 - 4) + r[1];
      const cd = density(x0, x1, ty0, ty1, false);
      const c = longest(runs(cd.length, (i) => cd[i] >= 0.55, 1));
      if (!c) continue;
      const box = { x: x0 + c[0], y: ty0, w: c[1] - c[0] + 1, h: ty1 - ty0 + 1 };
      if (box.w * box.h >= w * h * 0.015) boxes.push(box);
    }
  }
  if (boxes.length !== expected) return null;
  // panels on one sheet are much the same height; a short box is the cast strip's thumbnail, not a panel
  const hs = boxes.map((b) => b.h).sort((p, q) => p - q);
  const median = hs[hs.length >> 1];
  if (boxes.some((b) => b.h < median * 0.65 || b.h > median * 1.5)) return null;
  // reading order: by row (allowing for small misalignment), then left to right
  boxes.sort((a, b) => (Math.abs(a.y - b.y) > Math.min(a.h, b.h) / 2 ? a.y - b.y : a.x - b.x));
  return boxes;
}

// Read a sheet at analysis size and find its panels; crop them from the original into dir.
// Returns [{file, box}] (source pixels) or null when the sheet doesn't split cleanly.
export async function cutPanels(sheetFile, expected, dir) {
  const raw = join(dir, "sheet.rgb");
  await ffmpeg(["-y", "-i", sheetFile, "-vf", `scale=${ANALYSE.w}:${ANALYSE.h}`, "-f", "rawvideo", "-pix_fmt", "rgb24", raw], { timeoutMs: 60_000 });
  const boxes = findPanels(await readFile(raw), ANALYSE.w, ANALYSE.h, expected);
  if (!boxes) return null;
  const v = (await ffprobe(sheetFile)).streams.find((x) => x.codec_type === "video");
  const sx = v.width / ANALYSE.w;
  const sy = v.height / ANALYSE.h;
  const out = [];
  for (const [k, b] of boxes.entries()) {
    // a hair inside the edge, so no paper or border shows
    const x = Math.round((b.x + 1) * sx);
    const y = Math.round((b.y + 1) * sy);
    const cw = Math.floor(((b.w - 2) * sx) / 2) * 2;
    const ch = Math.floor(((b.h - 2) * sy) / 2) * 2;
    const file = join(dir, `panel-${k + 1}.jpg`);
    await ffmpeg(["-y", "-i", sheetFile, "-vf", `crop=${cw}:${ch}:${x}:${y}`, "-q:v", "2", file], { timeoutMs: 60_000 });
    out.push({ file, box: { x, y, w: cw, h: ch } });
  }
  return out;
}
