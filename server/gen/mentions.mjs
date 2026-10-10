// Which file each "Image 2" / "Audio 1" / "<IMAGE_REF_0>" in a prompt means, per model, and
// renumbering those mentions when references are reordered, removed or sent to another model.
// Pure functions: the server's recipes and the browser's draft editor share them.

export const IMAGE_ROLES = ["storyboard", "character", "subject", "style", "location"];

// The numbered slots a model's prompt can mention, in the order the files are sent.
// refs: [{role, key?}] → [{i (index into refs), kind, n, label}]
export function slots(model, refs = []) {
  const at = refs.map((r, i) => ({ r, i }));
  const out = [];
  const add = (list, kind, label) => list.forEach((x, k) => out.push({ i: x.i, kind, n: k + 1, label: label(k + 1) }));
  if (model === "image" || model === "image/fast") {
    // GPT Image and Nano Banana number every image, the edit source first
    const imgs = [...at.filter((x) => x.r.role === "edit_source"), ...at.filter((x) => x.r.role !== "edit_source" && x.r.role !== "voice" && x.r.role !== "source_video" && x.r.role !== "soundtrack")];
    add(imgs, "image", (n) => `image ${n}`);
  } else if (model === "video/omni") {
    add(at.filter((x) => IMAGE_ROLES.includes(x.r.role)), "image", (n) => `<IMAGE_REF_${n - 1}>`);
  } else if (model === "video/ref") {
    add(at.filter((x) => IMAGE_ROLES.includes(x.r.role)), "image", (n) => `Image ${n}`);
    add(at.filter((x) => x.r.role === "voice"), "audio", (n) => `Audio ${n}`);
    add(at.filter((x) => x.r.role === "source_video"), "video", (n) => `Video ${n}`);
  } else if (model === "video/extend") {
    add(at.filter((x) => x.r.role === "voice"), "audio", (n) => `Audio ${n}`);
  }
  return out;
}

// What a reference is called in this model's prompt ("Image 2"), or null when it isn't numbered
// (a first frame, a soundtrack, the clip being edited).
export function labelOf(model, refs, index) {
  return slots(model, refs).find((s) => s.i === index)?.label || null;
}

const MENTION = {
  h3: /\b(Image|Audio|Video) (\d+)\b/g,
  gpt: /\b([Ii]mage) (\d+)\b/g,
  omni: /<IMAGE_REF_(\d+)>/g,
};
const family = (model) => (model === "video/omni" ? "omni" : model === "image" || model === "image/fast" ? "gpt" : model === "video/ref" || model === "video/extend" ? "h3" : null);
const kindOfWord = (w) => (/^image$/i.test(w) ? "image" : /^audio$/i.test(w) ? "audio" : "video");

// Rewrite the mentions in a prompt after the references changed (order, removals, additions, or a
// different model). Each ref carries a stable `key`, so a file keeps its mentions wherever it moves.
// Returns { prompt, orphans } — orphans are mentions of files that are no longer sent.
export function renumber(prompt, before, after) {
  const text = String(prompt || "");
  const fb = family(before.model);
  const fa = family(after.model);
  if (!fb) return { prompt: text, orphans: [] };
  const oldSlots = slots(before.model, before.refs);
  const newSlots = slots(after.model, after.refs);
  const keyAt = (refs, i) => refs[i]?.key ?? `${refs[i]?.asset_id}:${refs[i]?.role}`;
  const target = (kind, n) => {
    const s = oldSlots.find((x) => x.kind === kind && x.n === n);
    if (!s) return undefined;
    const key = keyAt(before.refs, s.i);
    const j = after.refs.findIndex((r, i) => keyAt(after.refs, i) === key);
    if (j < 0) return null;
    return newSlots.find((x) => x.i === j)?.label ?? null;
  };
  const orphans = new Set();
  const swap = (whole, kind, n, keepCase) => {
    const next = target(kind, n);
    if (next === undefined) return whole; // it never pointed at a file: leave it
    if (next === null) {
      orphans.add(whole);
      return whole;
    }
    if (!fa) return whole;
    // keep the writer's capitalisation for GPT Image's "image 2" / "Image 2"
    return keepCase && /^[A-Z]/.test(whole) && fa === "gpt" ? next.replace(/^i/, "I") : next;
  };
  let out;
  if (fb === "omni") out = text.replace(MENTION.omni, (whole, k) => swap(whole, "image", Number(k) + 1, false));
  else out = text.replace(fb === "gpt" ? MENTION.gpt : MENTION.h3, (whole, word, n) => swap(whole, kindOfWord(word), Number(n), true));
  return { prompt: out, orphans: [...orphans] };
}
