// Project service shared by the MCP tools and the browser API.
import { q, one, tx } from "./db.mjs";
import { id } from "./ids.mjs";
import { HttpError } from "./auth.mjs";
import { newDoc, summarize, seqDuration, f2s } from "./timeline/model.mjs";
import { applyOps, OP_NAMES } from "./timeline/ops.mjs";
import { expandMacros, MACRO_OPS } from "./timeline/macros.mjs";
import { transcriptsFor } from "./render/render.mjs";
import { OpError } from "./timeline/model.mjs";
import { presignPut, presignGet, head, keys } from "./storage.mjs";
import { enqueue } from "./jobs/queue.mjs";
import { queueFxProxies } from "./media/fxproxy.mjs";
import { config } from "./config.mjs";

export function validateCanvas({ aspect, width, height, fps }) {
  if (width !== undefined || height !== undefined) {
    width = Math.round(Number(width));
    height = Math.round(Number(height));
    if (!(width >= 144 && width <= 4096 && height >= 144 && height <= 4096))
      throw new HttpError(400, "width and height must each be between 144 and 4096 pixels.", "bad_canvas");
    width -= width % 2;
    height -= height % 2; // H.264 needs even dimensions
  }
  fps = fps === undefined ? 30 : Number(fps);
  if (![23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60].includes(fps)) throw new HttpError(400, "fps must be 24, 25, 30, 48, 50 or 60 (or 23.976 / 29.97 / 59.94).", "bad_fps");
  return { aspect, width, height, fps };
}

export async function createProject(account, { name, aspect = "16:9", fps = 30, width, height }) {
  const c = validateCanvas({ aspect, width, height, fps });
  const doc = newDoc(c);
  const p = await one(
    "insert into studio.projects(id, account_id, name, doc) values ($1,$2,$3,$4) returning id, name, revision, created_at",
    [id("prj"), account.id, String(name || "Untitled").slice(0, 120), doc],
  );
  await q("insert into studio.commits(project_id, revision, actor, label, ops, summary, doc) values ($1,0,'system','created','[]','{}',$2)", [p.id, doc]);
  return { ...p, canvas: `${doc.settings.width}x${doc.settings.height}@${+(doc.settings.rate.num / doc.settings.rate.den).toFixed(3)}fps` };
}

export async function listProjects(account, query) {
  const rows = await q(
    `select p.id, p.name, p.revision, p.updated_at, p.is_public as public,
       (p.doc->'settings'->>'width')::int as width, (p.doc->'settings'->>'height')::int as height,
       -- the last export's frame, else the newest video's poster, else the newest image
       coalesce(p.poster_key, (
         select coalesce(a.derived->>'poster', case when a.kind='image' then a.storage_key end) from studio.assets a
         where a.project_id=p.id and a.deleted_at is null and a.status='ready' and a.kind in ('video','image')
           and (a.derived->>'poster' is not null or a.kind='image')
         order by (a.kind='video') desc, a.created_at desc limit 1)) as poster_key,
       (select count(*) from studio.assets a where a.project_id=p.id and a.deleted_at is null and not ('render' = any(a.roles)))::int as assets
     from studio.projects p where p.account_id=$1 and p.deleted_at is null
       and ($2::text is null or p.name ilike '%'||$2||'%' or p.id = $2)
     order by p.updated_at desc limit 50`,
    [account.id, query || null],
  );
  return rows;
}

export async function getProject(account, projectId) {
  const p = await one("select * from studio.projects where id=$1 and account_id=$2 and deleted_at is null", [projectId, account.id]);
  if (!p) throw new HttpError(404, `Project ${projectId} not found. Use project_list.`, "unknown_project");
  return p;
}

export async function projectAssets(projectId, { includeRenders = false } = {}) {
  const rows = await q(
    `select * from studio.assets where project_id=$1 and deleted_at is null ${includeRenders ? "" : "and not ('render' = any(roles))"} order by created_at`,
    [projectId],
  );
  return rows;
}
export const assetMapOf = (rows) => Object.fromEntries(rows.map((a) => [a.id, a]));

export function assetView(a) {
  const o = { id: a.id, kind: a.kind, name: a.name, status: a.status, roles: a.roles };
  if (a.probe) {
    o.duration_s = a.probe.duration;
    if (a.probe.video) o.video = `${a.probe.video.width}x${a.probe.video.height}@${a.probe.video.fps}`;
    if (a.probe.audio) o.audio = true;
  }
  if (a.derived?.transcriptWords !== undefined && a.derived?.transcriptWords !== null) o.transcript_words = a.derived.transcriptWords;
  if (a.derived?.shots) o.shots = a.derived.shots.length;
  if (a.derived?.loudness?.integratedLufs) o.lufs = a.derived.loudness.integratedLufs;
  if (a.origin?.kind === "baked")
    o.baked = { recipe: a.origin.recipe, script_path: a.origin.script_path, script: (a.origin.script || "").slice(0, 600), params: a.origin.params, inputs: a.origin.inputs, parent: a.origin.parent, note: a.origin.note };
  if (a.origin?.kind === "generation") o.generated = { model: a.origin.model, prompt: (a.origin.prompt || "").slice(0, 120), seed: a.origin.seed, take: a.origin.take };
  if (a.error) o.error = a.error;
  return o;
}

export async function editProject(account, projectId, { base_revision, ops, mode = "preview", label, actor = "agent", seed }) {
  seed = typeof seed === "string" && seed.length <= 64 ? seed : undefined; // the browser sends one so its optimistic ids match
  const p = await getProject(account, projectId);
  const assets = assetMapOf(await projectAssets(projectId));
  // transcript-aware ops (tighten, delete_words) become ordinary ops first; a seed keeps their ids stable
  let macroNotes = [];
  if (Array.isArray(ops) && ops.some((o) => MACRO_OPS.includes(o?.op))) {
    seed ||= id("seed", 10);
    // clips already on the timeline and any the batch brings in before the macro runs
    const used = [...new Set([...Object.values(p.doc.sequence.items).map((i) => i.asset), ...ops.map((o) => o?.asset)].filter((x) => x && assets[x]))];
    try {
      const x = expandMacros(p.doc, ops, assets, await transcriptsFor(assets, used), seed);
      ops = x.ops;
      macroNotes = x.notes;
    } catch (e) {
      throw toHttp(e);
    }
    if (!ops.length) return { mode, revision: p.revision, base_revision: p.revision, added: [], removed: [], changed: [], notes: [...macroNotes, "nothing to cut"], aliases: {}, affected: null, durationS: { before: +f2s(p.doc, seqDuration(p.doc)).toFixed(3), after: +f2s(p.doc, seqDuration(p.doc)).toFixed(3) }, _doc: p.doc, _before: p.doc, _assets: assets };
  }
  if (mode === "preview") {
    try {
      const r = applyOps(p.doc, ops, assets, { seed });
      return { mode: "preview", base_revision: p.revision, ...r.summary, notes: [...macroNotes, ...r.summary.notes], next: `Apply with mode:"apply", base_revision:${p.revision}.`, _doc: r.doc, _before: p.doc, _assets: assets };
    } catch (e) {
      throw toHttp(e);
    }
  }
  if (base_revision === undefined) throw new HttpError(400, `base_revision is required to apply (current is ${p.revision}).`, "revision_required", { current: p.revision });
  const applied = await tx(async (t) => {
    const cur = await t.one("select * from studio.projects where id=$1 for update", [projectId]);
    if (cur.revision !== base_revision)
      throw new HttpError(409, `Stale revision: you sent ${base_revision}, the project is at ${cur.revision}. Re-read with project_get and retry.`, "stale_revision", { current: cur.revision });
    let r;
    try {
      r = applyOps(cur.doc, ops, assets, { seed });
    } catch (e) {
      throw toHttp(e);
    }
    r.summary.notes = [...macroNotes, ...r.summary.notes];
    const rev = cur.revision + 1;
    await t.q("insert into studio.commits(project_id, revision, actor, label, ops, summary, doc) values ($1,$2,$3,$4,$5,$6,$7)", [projectId, rev, actor, label || null, JSON.stringify(ops), r.summary, r.doc]);
    await t.q("update studio.projects set doc=$2, revision=$3, updated_at=now() where id=$1", [projectId, r.doc, rev]);
    return { mode: "apply", revision: rev, ...r.summary, undo: `timeline_history {action:"undo"} restores revision ${cur.revision}.`, _doc: r.doc, _before: cur.doc, _assets: assets };
  });
  // custom filters get a baked preview (the render applies them directly)
  const fx = await queueFxProxies(p.account_id, projectId, applied._doc, assets).catch((e) => (console.error("fx proxies", e.message), []));
  if (fx.length) applied.notes = [...(applied.notes || []), `Baking the preview of ${fx.length} filtered clip${fx.length > 1 ? "s" : ""}: the editor shows the plain clip until it's ready; the render applies the filter either way.`];
  return applied;
}

function toHttp(e) {
  if (e instanceof OpError) return new HttpError(422, e.message, e.code, { ...(e.extra || {}), op_index: e.index, allowed_ops: e.code === "unknown_op" ? OP_NAMES : undefined });
  return e;
}

// The board's shape decides the canvas while the timeline is still empty. Returns a note when it
// can't follow (the timeline already has things on it, or the aspect isn't a canvas preset).
export async function followAspect(account, projectId, aspect, actor = "agent") {
  const [w, h] = String(aspect || "").split(":").map(Number);
  if (!w || !h) return null;
  const p = await getProject(account, projectId);
  const cur = p.doc.settings;
  if (Math.abs(cur.width / cur.height - w / h) < 0.01) return null;
  if (Object.keys(p.doc.sequence.items).length) return `The canvas is still ${cur.width}×${cur.height}: the timeline already has things on it. Change it with set_canvas if the timeline should follow.`;
  try {
    await editProject(account, projectId, { ops: [{ op: "set_canvas", aspect }], mode: "apply", base_revision: p.revision, actor, label: "canvas follows the brief" });
  } catch (e) {
    return `The canvas stays ${cur.width}×${cur.height}: ${e.message}`;
  }
  return null;
}

export async function history(account, projectId, { action = "list", revision, actor = "agent" }) {
  const p = await getProject(account, projectId);
  if (action === "list") {
    const rows = await q("select revision, actor, label, summary, created_at from studio.commits where project_id=$1 order by revision desc limit 30", [projectId]);
    return { current: p.revision, commits: rows.map((r) => ({ revision: r.revision, actor: r.actor, label: r.label, added: r.summary?.added?.length, removed: r.summary?.removed?.length, changed: r.summary?.changed?.length, at: r.created_at })) };
  }
  let target;
  if (action === "undo") {
    // Undo steps back through edits: an undo/restore commit stands for the revision it restored,
    // so repeated undos keep walking back instead of bouncing between two states.
    let r = p.revision;
    for (let guard = 0; guard < 500; guard++) {
      const c = await one("select summary from studio.commits where project_id=$1 and revision=$2", [projectId, r]);
      const rf = c?.summary?.restoredFrom;
      if (rf === undefined || rf === null) break;
      r = rf;
    }
    target = r - 1;
  }
  else if (action === "restore") target = revision;
  else throw new HttpError(400, 'action must be "list", "undo" or "restore".', "bad_action");
  if (!(target >= 0)) throw new HttpError(409, "Nothing to undo.", "nothing_to_undo");
  const c = await one("select doc from studio.commits where project_id=$1 and revision=$2", [projectId, target]);
  if (!c) throw new HttpError(404, `Revision ${target} not found.`, "unknown_revision");
  const doc = c.doc;
  return tx(async (t) => {
    const cur = await t.one("select revision from studio.projects where id=$1 for update", [projectId]);
    const rev = cur.revision + 1;
    await t.q("insert into studio.commits(project_id, revision, actor, label, ops, summary, doc) values ($1,$2,$3,$4,$5,$6,$7)", [projectId, rev, actor, `${action} → r${target}`, "[]", { restoredFrom: target }, doc]);
    await t.q("update studio.projects set doc=$2, revision=$3, updated_at=now() where id=$1", [projectId, doc, rev]);
    return { revision: rev, restored_from: target, duration_s: +f2s(doc, seqDuration(doc)).toFixed(3), _doc: doc };
  });
}

const EXT = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mp4": "m4a", "audio/aac": "aac", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const guessMime = (name = "") => {
  const e = name.toLowerCase().split(".").pop();
  return { mp4: "video/mp4", mov: "video/quicktime", m4v: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" }[e];
};

// What a script made: the script (text, capped), its parameters, the assets it read and, for a
// re-bake, the asset it replaces. Stored as the asset's origin {kind:"baked"}.
export function provenanceOf(p) {
  if (!p || typeof p !== "object") return null;
  const ids = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(String).filter((x) => /^ast_[a-z0-9]{6,}$/.test(x)).slice(0, 20);
  let params = p.params && typeof p.params === "object" ? p.params : undefined;
  if (params && JSON.stringify(params).length > 8000) params = { note: "parameters too large to keep" };
  return {
    kind: "baked",
    script: typeof p.script === "string" ? p.script.slice(0, 20000) : undefined,
    script_path: typeof p.script_path === "string" ? p.script_path.slice(0, 300) : undefined,
    language: typeof p.language === "string" ? p.language.slice(0, 20) : undefined,
    params,
    inputs: ids(p.inputs),
    parent: ids(p.parent)[0],
    recipe: typeof p.recipe === "string" ? p.recipe.slice(0, 80) : undefined,
    note: typeof p.note === "string" ? p.note.slice(0, 500) : undefined,
    at: new Date().toISOString(),
  };
}

export async function uploadTicket(account, projectId, { filename, bytes, mime, roles = [], provenance }) {
  await getProject(account, projectId);
  mime = mime || guessMime(filename);
  if (!mime) throw new HttpError(400, `Unsupported file type for ${filename}. Use mp4/mov/webm, mp3/wav/m4a, png/jpg/webp.`, "bad_type");
  if (bytes && bytes > 5 * 1024 ** 3) throw new HttpError(413, "Files up to 5 GB.", "too_large");
  const aid = id("ast");
  const kind = mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "image";
  const storage = keys.original(account.id, projectId, aid, EXT[mime] || "bin");
  await q(
    `insert into studio.assets(id, project_id, account_id, kind, roles, name, mime, bytes, status, origin, storage_key) values ($1,$2,$3,$4,$5,$6,$7,$8,'uploading',$9,$10)`,
    [aid, projectId, account.id, kind, provenance ? [...new Set([...roles, "baked"])] : roles, String(filename || aid).slice(0, 160), mime, bytes || null, provenanceOf(provenance) || { kind: "upload" }, storage],
  );
  const url = await presignPut(storage, mime, 6 * 3600);
  const local = filename && !filename.includes("/") ? filename : filename || "FILE";
  return {
    asset_id: aid,
    upload: {
      method: "PUT",
      url,
      headers: { "Content-Type": mime },
      expires_in_s: 6 * 3600,
      curl: `curl -fsS -T ${JSON.stringify(local)} -H 'Content-Type: ${mime}' '${url}'`,
    },
    next: `After the upload finishes, call media_add {"project_id":"${projectId}","finalize":"${aid}"}.`,
  };
}

export async function finalizeUpload(account, projectId, assetId) {
  const a = await one("select * from studio.assets where id=$1 and project_id=$2 and account_id=$3", [assetId, projectId, account.id]);
  if (!a) throw new HttpError(404, `Asset ${assetId} not found.`, "unknown_asset");
  if (a.status !== "uploading") return { asset_id: a.id, status: a.status, note: "already finalized" };
  const h = await head(a.storage_key);
  if (!h) throw new HttpError(409, "The file has not arrived yet; run the upload command first.", "not_uploaded");
  await q("update studio.assets set status='processing', bytes=$2, updated_at=now() where id=$1", [a.id, Number(h.ContentLength || 0)]);
  const job = await enqueue({ kind: "ingest", account_id: account.id, project_id: projectId, input: { asset_id: a.id }, idempotency_key: `ingest:${a.id}` });
  return { asset_id: a.id, status: "processing", job_id: job.id, next: `job_wait {"job_ids":["${job.id}"]} — then the asset is ready to place.` };
}

export async function importUrl(account, projectId, { url, name, roles = [] }) {
  await getProject(account, projectId);
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new HttpError(400, "Not a valid URL.", "bad_url");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new HttpError(400, "Only http(s) URLs.", "bad_url");
  if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(u.hostname)) throw new HttpError(400, "YouTube downloads are not supported (their terms forbid it). Download the file yourself and upload it.", "unsupported_source");
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname)) throw new HttpError(400, "Private addresses are not allowed.", "bad_url");
  if (u.hostname.endsWith("dropbox.com")) u.searchParams.set("dl", "1");
  const r = await fetch(u, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new HttpError(400, `Fetching the URL failed: HTTP ${r.status}.`, "fetch_failed");
  const mime = (r.headers.get("content-type") || "").split(";")[0] || guessMime(u.pathname);
  const fname = name || decodeURIComponent(u.pathname.split("/").pop() || "import");
  if (!mime || !EXT[mime]) throw new HttpError(400, `Unsupported content type ${mime || "unknown"}.`, "bad_type");
  const aid = id("ast");
  const storage = keys.original(account.id, projectId, aid, EXT[mime]);
  const { putBuffer } = await import("./storage.mjs");
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 1024 ** 3) throw new HttpError(413, "URL imports up to 1 GB; upload larger files.", "too_large");
  await putBuffer(storage, buf, mime);
  await q(
    `insert into studio.assets(id, project_id, account_id, kind, roles, name, mime, bytes, status, origin, storage_key) values ($1,$2,$3,$4,$5,$6,$7,$8,'processing',$9,$10)`,
    [aid, projectId, account.id, mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "image", roles, fname.slice(0, 160), mime, buf.length, { kind: "url", url: u.toString() }, storage],
  );
  const job = await enqueue({ kind: "ingest", account_id: account.id, project_id: projectId, input: { asset_id: aid } });
  return { asset_id: aid, status: "processing", job_id: job.id };
}

export async function signedAssetUrl(account, assetId, kind = "original") {
  const a = await one("select * from studio.assets where id=$1 and account_id=$2", [assetId, account.id]);
  if (!a) throw new HttpError(404, "Asset not found.", "unknown_asset");
  const key = kind === "proxy" ? a.derived?.proxy || a.storage_key : kind === "poster" ? a.derived?.poster : kind === "sheet" ? a.derived?.sheet : kind === "waveform" ? a.derived?.waveform : kind === "transcript" ? a.derived?.transcript : kind === "filmstrip" ? a.derived?.filmstrip : a.storage_key;
  if (!key) throw new HttpError(404, `No ${kind} for this asset.`, "no_rendition");
  return presignGet(key, 3600, kind === "download" ? a.name : undefined);
}

export function mcpUrl() {
  return `${config.publicOrigin}/mcp`;
}
