// Custom per-item filters: an ffmpeg filter chain on one clip's picture (item.filter) or sound
// (item.afilter), for looks no preset covers. Shared by the server and the browser preview.
//
// Only a simple chain is accepted ("eq=contrast=1.2,vignette"): named filters from an allowlist,
// no labels, no ';', no file or network access, and nothing that changes the clip's length or frame
// size (the layout and the timing come from the item itself). lut3d takes a project asset:
// "lut3d=ast_…" (the render swaps in the file).
import { OpError } from "./model.mjs";

const VIDEO = new Set([
  "eq", "curves", "lut3d", "colorbalance", "colorchannelmixer", "colorcorrect", "colortemperature", "colorlevels", "colorcontrast",
  "hue", "huesaturation", "selectivecolor", "vibrance", "exposure", "lutrgb", "lutyuv", "negate", "monochrome", "grayworld",
  "gblur", "boxblur", "avgblur", "smartblur", "dblur", "unsharp", "cas", "vignette", "noise", "deflicker", "deband", "hqdn3d",
  "nlmeans", "edgedetect", "chromakey", "colorkey", "hsvkey", "despill", "hflip", "vflip", "fade", "lenscorrection", "chromashift",
  "rgbashift", "gradfun", "convolution", "sobel", "elbg", "pixelize", "posterize", "tmix", "lagfun", "photosensitivity",
]);
const AUDIO = new Set([
  "equalizer", "bass", "treble", "highpass", "lowpass", "bandpass", "bandreject", "highshelf", "lowshelf", "acompressor",
  "agate", "afftdn", "anlmdn", "adeclick", "adeclip", "aecho", "areverse_never", "chorus", "flanger", "aphaser", "tremolo",
  "vibrato", "volume", "dynaudnorm", "speechnorm", "deesser", "crystalizer", "extrastereo", "stereowiden", "afade", "rubberband",
  "alimiter", "compand", "silenceremove_never",
].filter((x) => !x.endsWith("_never")));
// options that would make an allowed filter change the length, or read a file
const FORBIDDEN_OPTION = /\b(tempo|file|filename|textfile|fontfile)\s*=/i;
const MAX_LEN = 600;

// Split "a=x=1:y=2,b,c=3" into [{name, args}] (commas inside quotes or parentheses don't split).
function parse(chain) {
  const out = [];
  let cur = "",
    depth = 0,
    quote = null;
  for (const ch of chain) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (quote) throw new OpError("bad_value", "The filter has an unclosed quote.");
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.indexOf("=");
    return { name: (i < 0 ? s : s.slice(0, i)).trim(), args: i < 0 ? "" : s.slice(i + 1).trim() };
  });
}

// The filter as stored (or null to clear it). kind: "video" for item.filter, "audio" for item.afilter.
export function cleanFilter(value, kind = "video") {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  const what = kind === "audio" ? "afilter" : "filter";
  if (s.length > MAX_LEN) throw new OpError("bad_value", `${what} is too long (at most ${MAX_LEN} characters).`);
  if (/[\[\];\\\n\r`$]/.test(s)) throw new OpError("bad_value", `${what} is a simple chain of filters separated by commas: no [labels], ';', backslashes or line breaks.`);
  if (/:\/\/|\.\.\/|(^|[=:])\//.test(s)) throw new OpError("bad_value", `${what} can't refer to files or URLs (for a LUT, use lut3d=ast_… with a .cube asset).`);
  if (FORBIDDEN_OPTION.test(s)) throw new OpError("bad_value", `${what} can't set tempo or read files: speed is the item's speed, and the length stays the item's.`);
  const allowed = kind === "audio" ? AUDIO : VIDEO;
  const parts = parse(s);
  if (!parts.length) return null;
  if (parts.length > 12) throw new OpError("bad_value", `${what} chains at most 12 filters.`);
  for (const p of parts) {
    if (!/^[a-z0-9_]+$/.test(p.name)) throw new OpError("bad_value", `"${p.name}" isn't a filter name.`);
    if (!allowed.has(p.name))
      throw new OpError("bad_value", `${p.name} isn't allowed in ${what}. Allowed: ${[...allowed].join(", ")}.`, {
        hint: kind === "video" ? "Size, crop, rotation and speed are the item's visual/speed settings; length-changing filters aren't allowed." : "Speed is the item's speed setting; length-changing filters aren't allowed.",
      });
    if (p.name === "lut3d" && !/^(file=)?ast_[a-z0-9]{6,}(:.*)?$/.test(p.args)) throw new OpError("bad_value", "lut3d takes a .cube asset from this project: lut3d=ast_….");
  }
  return parts.map((p) => (p.args ? `${p.name}=${p.args}` : p.name)).join(",");
}

// Assets a filter reads (LUTs), so the render can fetch them.
export const filterAssets = (f) => [...String(f || "").matchAll(/lut3d=(?:file=)?(ast_[a-z0-9]{6,})/g)].map((m) => m[1]);
// The filter with its asset ids swapped for local files (render).
export const withFiles = (f, files) => String(f).replace(/lut3d=(?:file=)?(ast_[a-z0-9]{6,})/g, (_, id) => `lut3d=file=${files[id] || id}`);

// The key a baked preview of (asset, filter, afilter) is stored under. Stable, short, the same in
// the browser and on the server (FNV-1a).
export function fxKey(assetId, filter, afilter) {
  const s = `${assetId}|${filter || ""}|${afilter || ""}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return "fx" + h.toString(36);
}
// Whether a filter keys out part of the picture (the preview needs a format with alpha).
export const keysAlpha = (f) => /\b(chromakey|colorkey|hsvkey)\b/.test(String(f || ""));
