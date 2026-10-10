// Compose a generation request from the project board: reference images and voices from the cast and
// places, the bindings that tell the model which file is who ("Image 1 is Vera: …") in each model's
// own syntax, and the look block. The locked descriptions reach every prompt word for word, and the
// reference numbering always matches the files actually sent.
import { q } from "../db.mjs";
import { HttpError } from "../auth.mjs";
import { loadBoard } from "../board.mjs";
import { IMAGE_ROLES } from "./mentions.mjs";

const IMAGE_SLOTS = { "video/ref": 9, image: 16, "image/fast": 14, "video/omni": 10, video: 0 };
const VOICE_SLOTS = { "video/ref": 3 };
const VOICE_TOTAL_S = 15;

const label = (model, n) => (model === "video/omni" ? `<IMAGE_REF_${n - 1}>` : model === "image" || model === "image/fast" ? `Image ${n}` : `Image ${n}`);
const sentence = (s) => (s ? s.trim().replace(/\s+/g, " ").replace(/[.;,]*$/, ".") : "");

export function composable(modelId) {
  return modelId in IMAGE_SLOTS;
}

// a = gen_quote args: { cast:[ids], place:id, look:boolean, references:[explicit] }.
// Returns { references, prefix, order, warnings } — composed references go first.
export async function composeFromBoard(projectId, modelId, a, deps = {}) {
  if (!composable(modelId)) throw new HttpError(400, `cast/place work with video/ref, video, video/omni, image and image/fast, not ${modelId}.`, "bad_compose");
  const board = deps.board || (await loadBoard(projectId)).board;
  const castIds = Array.isArray(a.cast) ? a.cast : a.cast ? [a.cast] : [];
  const cast = castIds.map((id) => {
    const c = board.cast.find((x) => x.id === id || (x.name && x.name.toLowerCase() === String(id).toLowerCase()));
    if (!c) throw new HttpError(400, `No cast member ${id} on the board. It has: ${board.cast.map((x) => `${x.id} ${x.name || ""}`.trim()).join(", ") || "nobody yet"}.`, "unknown_cast");
    return c;
  });
  const place = a.place ? board.places.find((x) => x.id === a.place || (x.name && x.name.toLowerCase() === String(a.place).toLowerCase())) : null;
  if (a.place && !place) throw new HttpError(400, `No place ${a.place} on the board. It has: ${board.places.map((x) => `${x.id} ${x.name || ""}`.trim()).join(", ") || "none yet"}.`, "unknown_place");
  const useLook = a.look !== false;
  const warnings = [];
  const explicit = a.references || [];
  const editFirst = explicit.some((r) => r.role === "edit_source") ? 1 : 0; // GPT Image sends the edit source as image 1
  const slots = IMAGE_SLOTS[modelId] - explicit.filter((r) => IMAGE_ROLES.includes(r.role)).length;
  const refs = [];
  const order = [];
  const lines = [];
  const voiceLines = [];
  let n = editFirst;
  const addImage = (entity, ref, role, text) => {
    if (refs.length >= slots) {
      warnings.push(`${modelId} takes ${IMAGE_SLOTS[modelId]} images; ${entity} was described in words only.`);
      return null;
    }
    refs.push({ asset_id: ref.asset_id, role });
    n += 1;
    order.push({ n, entity, asset_id: ref.asset_id, role });
    return `${label(modelId, n)} is ${text}`;
  };
  for (const c of cast) {
    const who = `${c.name || c.id}${c.look ? `: ${sentence(c.look)}` : "."}${c.outfit ? ` Wearing ${sentence(c.outfit)}` : ""}${c.contrast ? ` ${sentence(c.contrast)}` : ""}`;
    const ref = (c.refs || []).find((r) => r.use === "sheet") || (c.refs || [])[0];
    if (IMAGE_SLOTS[modelId] && ref) lines.push(addImage(c.name || c.id, ref, c.kind === "product" || c.kind === "prop" ? "subject" : "character", who) || who);
    else {
      lines.push(who);
      if (IMAGE_SLOTS[modelId] && !ref) warnings.push(`${c.name || c.id} has no bible sheet yet, so only the words describe them. Make it with gen_quote {for:{cast:"${c.id}"}}.`);
    }
  }
  if (place) {
    const where = `${place.name || place.id}${place.look ? `: ${sentence(place.look)}` : "."}`;
    const ref = (place.refs || []).find((r) => r.use === "sheet") || (place.refs || [])[0];
    if (IMAGE_SLOTS[modelId] && ref) lines.push(addImage(place.name || place.id, ref, "location", where) || where);
    else lines.push(where);
  }
  if (useLook && board.look?.refs?.length && IMAGE_SLOTS[modelId] && refs.length < slots) {
    const s = addImage("look", board.look.refs[0], "style", "the look reference: match its palette, light and texture, not its content.");
    if (s) lines.push(s);
  }
  // voices: one clean sample per speaker, all together within 15 s (H3 reference-to-video only)
  if (VOICE_SLOTS[modelId]) {
    const samples = cast.filter((c) => c.voice?.sample);
    if (samples.length) {
      const dur = deps.durations || Object.fromEntries((await q("select id, probe from studio.assets where project_id=$1 and id = any($2)", [projectId, samples.map((c) => c.voice.sample)])).map((r) => [r.id, r.probe?.duration || 0]));
      let total = explicit.filter((r) => r.role === "voice").reduce((s, r) => s + (r.seconds || 0), 0);
      let k = explicit.filter((r) => r.role === "voice").length;
      for (const c of samples) {
        const d = dur[c.voice.sample] || 0;
        if (k >= VOICE_SLOTS[modelId] || total + d > VOICE_TOTAL_S) {
          warnings.push(`${c.name}'s voice sample left out: voice references must fit ${VOICE_SLOTS[modelId]} files and ${VOICE_TOTAL_S} s together (trim samples to 5–7 s).`);
          continue;
        }
        refs.push({ asset_id: c.voice.sample, role: "voice" });
        k += 1;
        total += d;
        voiceLines.push(`Audio ${k} is ${c.name || c.id}'s voice; when ${c.name || c.id} speaks, match it.`);
      }
    }
  }
  const parts = [];
  if (lines.length) {
    parts.push(lines.join(" "));
    if (refs.some((r) => r.role !== "voice")) parts.push(modelId.startsWith("image") ? "Keep each of them exactly as in their image; do not redesign anyone." : "Keep every person, product and place exactly as in their images.");
  }
  if (voiceLines.length) parts.push(voiceLines.join(" "));
  if (useLook && board.look?.style) parts.push(`Look: ${sentence(board.look.style)}`);
  return { references: refs, prefix: parts.join("\n"), order, warnings };
}
