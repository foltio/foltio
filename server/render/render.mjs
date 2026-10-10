// Render jobs (draft / final) and composite frame views for agents.
import { join } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { q, one } from "../db.mjs";
import { id } from "../ids.mjs";
import { getToFile, getJson, putFile, putBuffer, presignGet, keys } from "../storage.mjs";
import { ffmpeg, ffprobe, scratch, summarizeProbe, filterScriptFlag } from "../media/ff.mjs";
import { compile } from "./compile.mjs";
import { filterAssets } from "../timeline/fx.mjs";
import { buildAss } from "../timeline/ass.mjs";
import { f2s, seqDuration, tc, end } from "../timeline/model.mjs";
import { config } from "../config.mjs";

export async function docAt(projectId, revision) {
  const p = await one("select * from studio.projects where id=$1", [projectId]);
  if (revision === undefined || revision === null || revision === p.revision) return { project: p, doc: p.doc, revision: p.revision };
  const c = await one("select doc from studio.commits where project_id=$1 and revision=$2", [projectId, revision]);
  if (!c) throw new Error(`revision ${revision} not found`);
  return { project: p, doc: c.doc, revision };
}

export async function assetMap(projectId) {
  const rows = await q("select * from studio.assets where project_id=$1 and deleted_at is null", [projectId]);
  return Object.fromEntries(rows.map((a) => [a.id, a]));
}

// Transcripts are read on every lint and render; keep recent ones in memory for a few minutes.
const txCache = new Map();
export async function transcriptsFor(assets, ids) {
  const out = {};
  await Promise.all(
    ids.map(async (aid) => {
      const key = assets[aid]?.derived?.transcript;
      if (!key) return;
      const hit = txCache.get(key);
      if (hit && Date.now() - hit.at < 5 * 60_000) return (out[aid] = hit.t);
      const t = await getJson(key).catch(() => null);
      if (t) txCache.set(key, { t, at: Date.now() });
      if (txCache.size > 300) txCache.delete(txCache.keys().next().value);
      out[aid] = t;
    }),
  );
  return out;
}

function dims(doc, quality) {
  const W = doc.settings.width,
    H = doc.settings.height;
  if (quality === "final") return { width: W, height: H };
  const s = 540 / Math.min(W, H);
  return { width: Math.round((W * s) / 2) * 2, height: Math.round((H * s) / 2) * 2 };
}

export async function renderProject(job, report) {
  const { project_id, quality = "draft" } = job.input;
  const { project, doc, revision } = await docAt(project_id, job.input.revision);
  const assets = await assetMap(project_id);
  const used = [...new Set(Object.values(doc.sequence.items).flatMap((i) => [i.asset, ...filterAssets(i.filter)]).filter(Boolean))];
  const missing = used.filter((a) => !assets[a] || assets[a].status !== "ready");
  if (missing.length) throw new Error(`assets not ready: ${missing.join(", ")}`);
  if (!Object.values(doc.sequence.items).some((i) => i.kind !== "captions")) throw new Error("the timeline is empty");
  const transcripts = await transcriptsFor(assets, used);
  return scratch(async (dir) => {
    const files = {};
    for (const aid of used) {
      const a = assets[aid];
      const key = a.kind === "video" ? (quality === "final" ? a.derived?.mezzanine || a.storage_key : a.derived?.proxy || a.storage_key) : a.storage_key;
      const f = join(dir, `${aid}${a.kind === "image" ? ".img" : ""}`);
      await getToFile(key, f);
      files[aid] = f;
    }
    report(0.1);
    const ass = buildAss(doc, assets, transcripts);
    const assPath = ass ? join(dir, "text.ass") : null;
    if (ass) await writeFile(assPath, ass);
    const out = join(dir, "out.mp4");
    const d = dims(doc, quality);
    const c = compile({
      doc,
      assets,
      files,
      quality: { ...d, crf: quality === "final" ? 19 : 27, preset: quality === "final" ? "medium" : "veryfast", audioBitrate: quality === "final" ? "192k" : "128k", threads: config.renderThreads },
      assPath,
      outPath: out,
    });
    const graphFile = join(dir, "graph.txt");
    await writeFile(graphFile, c.graph);
    const flag = await filterScriptFlag();
    await ffmpeg(["-y", ...c.args.slice(3), flag, graphFile, ...c.outArgs], { onProgress: (t) => report(0.1 + 0.85 * Math.min(1, t / c.durationS)), timeoutMs: 60 * 60_000 });
    const probe = summarizeProbe(await ffprobe(out));
    const rid = id("ast");
    const storage = keys.render(project.account_id, project_id, rid);
    const { bytes } = await putFile(storage, out, "video/mp4");
    const poster = join(dir, "poster.jpg");
    await ffmpeg(["-y", "-ss", String(Math.min(1, c.durationS / 3)), "-i", out, "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "4", poster]);
    const posterKey = keys.derived(project.account_id, project_id, rid, "poster.jpg");
    await putFile(posterKey, poster, "image/jpeg");
    await q(
      `insert into studio.assets(id, project_id, account_id, kind, roles, name, mime, bytes, status, origin, probe, derived, storage_key)
       values ($1,$2,$3,'video',$4,$5,'video/mp4',$6,'ready',$7,$8,$9,$10)`,
      [rid, project_id, project.account_id, ["render", quality], `${project.name} — ${quality} r${revision}`, bytes, { kind: "render", quality, revision }, probe, { poster: posterKey }, storage],
    );
    await q("update studio.projects set poster_key=$2 where id=$1", [project_id, posterKey]);
    return { render_id: rid, quality, revision, duration: probe.duration, width: probe.video?.width, height: probe.video?.height, bytes };
  });
}

export async function latestRender(projectId, revision, quality = "draft") {
  return one(
    `select * from studio.assets where project_id=$1 and 'render' = any(roles) and origin->>'quality' = $3 and (origin->>'revision')::int = $2 and deleted_at is null order by created_at desc limit 1`,
    [projectId, revision, quality],
  );
}

// Composite frames from a draft render, labelled with timecode and the visible clip ids.
export async function framesSheet(project, doc, render, times, { columns = 4, width = times.length > 8 ? 220 : 270 } = {}) {
  const url = await presignGet(render.storage_key, 900);
  const vis = (t) =>
    Object.values(doc.sequence.items)
      .filter((i) => ["clip", "image", "color", "title"].includes(i.kind) && f2s(doc, i.start) <= t && t < f2s(doc, end(i)))
      .map((i) => i.id)
      .join(" ");
  return scratch(async (dir) => {
    const cells = [];
    for (const [k, t] of times.entries()) {
      const out = join(dir, `f${String(k).padStart(3, "0")}.jpg`);
      const label = `${tc(doc, Math.round(t * doc.settings.rate.num / doc.settings.rate.den)).slice(3)}  ${vis(t)}`.replace(/:/g, "\\:");
      await ffmpeg(["-y", "-ss", String(Math.max(0, t)), "-i", url, "-frames:v", "1", "-vf", `scale=${width}:-2,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='${label}':x=6:y=h-th-8:fontsize=${Math.round(width / 18)}:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=4`, "-q:v", "4", out]).catch(() => null);
      cells.push(out);
    }
    const rows = Math.ceil(times.length / columns);
    const sheet = join(dir, "sheet.jpg");
    await ffmpeg(["-y", "-framerate", "1", "-pattern_type", "glob", "-i", join(dir, "f*.jpg"), "-vf", `tile=${Math.min(columns, times.length)}x${rows}:padding=4:color=0x111111`, "-frames:v", "1", "-q:v", times.length > 8 ? "7" : "5", sheet]);
    const buf = await readFile(sheet);
    const key = keys.frame(project.account_id, project.id, `r${render.origin.revision}`, `${Date.now()}.jpg`);
    await putBuffer(key, buf, "image/jpeg");
    return { jpeg: buf, key };
  });
}
export { seqDuration };
