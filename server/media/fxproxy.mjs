// Baked previews of custom filters (item.filter / item.afilter): the asset's proxy run through the
// same chain, stored next to it as derived.fx[key]. The browser plays that copy for the item, so
// what the person sees is what the render makes. A key is (asset, filter, afilter) — fx.mjs fxKey.
import { join } from "node:path";
import { q, one } from "../db.mjs";
import { getToFile, putFile, keys } from "../storage.mjs";
import { ffmpeg, scratch } from "./ff.mjs";
import { enqueue } from "../jobs/queue.mjs";
import { fxKey, keysAlpha, filterAssets, withFiles } from "../timeline/fx.mjs";

export async function bakeFxProxy(job, report) {
  const { asset_id, filter, afilter, key } = job.input;
  const a = await one("select * from studio.assets where id=$1", [asset_id]);
  if (!a) throw new Error(`asset ${asset_id} is gone`);
  if (a.derived?.fx?.[key]) return { key, cached: true };
  return scratch(async (dir) => {
    const src = join(dir, "src");
    await getToFile(a.kind === "video" ? a.derived?.proxy || a.storage_key : a.storage_key, src);
    const files = {};
    for (const id of filterAssets(filter)) {
      const lut = await one("select storage_key from studio.assets where id=$1 and project_id=$2", [id, a.project_id]);
      if (!lut) throw new Error(`LUT ${id} is not in this project`);
      files[id] = join(dir, `${id}.cube`);
      await getToFile(lut.storage_key, files[id]);
    }
    report(0.2);
    const vf = filter ? withFiles(filter, files) : null;
    let out, mime, args;
    if (a.kind === "image") {
      out = join(dir, "fx.png");
      mime = "image/png";
      args = ["-y", "-i", src, ...(vf ? ["-vf", `${vf},format=rgba`] : []), "-frames:v", "1", out];
    } else if (keysAlpha(filter)) {
      // keyed picture: VP9 keeps the alpha the browser composites over the tracks below
      out = join(dir, "fx.webm");
      mime = "video/webm";
      args = ["-y", "-i", src, "-map", "0:v:0", "-map", "0:a:0?", "-vf", `${vf},format=yuva420p`, ...(afilter ? ["-af", afilter] : []), "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "34", "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libopus", "-b:a", "96k", out];
    } else {
      out = join(dir, "fx.mp4");
      mime = "video/mp4";
      args = ["-y", "-i", src, "-map", "0:v:0", "-map", "0:a:0?", ...(vf ? ["-vf", `${vf},format=yuv420p`] : []), ...(afilter ? ["-af", afilter] : []), "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-g", "15", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out];
    }
    await ffmpeg(args, { onProgress: (t) => report(0.2 + 0.7 * Math.min(1, t / (a.probe?.duration || 1))), timeoutMs: 20 * 60_000 });
    const name = `${key}.${out.split(".").pop()}`;
    const { key: storage } = await putFile(keys.derived(a.account_id, a.project_id, a.id, name), out, mime);
    await q("update studio.assets set derived = jsonb_set(coalesce(derived,'{}'::jsonb), '{fx}', coalesce(derived->'fx','{}'::jsonb) || $2::jsonb) where id=$1", [a.id, JSON.stringify({ [key]: storage })]);
    return { key, storage };
  });
}

// After an edit: bake what the timeline's filters need and isn't baked yet (one job per key).
export async function queueFxProxies(accountId, projectId, doc, assets) {
  const queued = [];
  for (const it of Object.values(doc.sequence.items)) {
    if (!it.asset || !(it.filter || it.afilter)) continue;
    const a = assets[it.asset];
    if (!a || a.status !== "ready") continue;
    const key = fxKey(it.asset, it.filter, it.afilter);
    if (a.derived?.fx?.[key]) continue;
    await enqueue({ kind: "fxproxy", account_id: accountId, project_id: projectId, input: { asset_id: it.asset, filter: it.filter || null, afilter: it.afilter || null, key }, idempotency_key: `fx:${it.asset}:${key}` });
    queued.push(key);
  }
  return queued;
}
