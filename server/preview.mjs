// The film so far, laid out in story order while it's made clip by clip. Every storyboard goes on the
// timeline in order:
//   - its take, once there is one;
//   - else its panels (cut from its sheet), each held for its time;
//   - else, before it's drawn, a title card with its beat.
// Nothing is generated (takes bring their own voices and music); a music card's sample, if one was
// made, plays under the clips without a take. Built from the board; a rebuild replaces exactly what
// the last build put there, and never touches anything else on the timeline.
import { HttpError } from "./auth.mjs";
import { q, one } from "./db.mjs";
import { getProject, editProject } from "./projects.mjs";
import { loadBoard, withPlacement, setPanelFrames, setPreview, boardAssets } from "./board.mjs";
import { panelTimes } from "./gen/recipes.mjs";
import { cutPanels } from "./gen/panels.mjs";
import { getToFile, putFile, keys } from "./storage.mjs";
import { enqueue } from "./jobs/queue.mjs";
import { scratch } from "./media/ff.mjs";
import { fps as fpsOf } from "./timeline/model.mjs";
import { id } from "./ids.mjs";

const TRACKS = { picture: "trk_v1", titles: "trk_t1", voice: "trk_a1", music: "trk_a2" };

async function waitReady(ids, maxMs = 60_000) {
  const t0 = Date.now();
  for (;;) {
    const rows = ids.length ? await q("select id, status, probe from studio.assets where id = any($1)", [ids]) : [];
    if (rows.length === ids.length && rows.every((r) => r.status === "ready" || r.status === "failed")) return rows;
    if (Date.now() - t0 > maxMs) return rows;
    await new Promise((r) => setTimeout(r, 700));
  }
}

// A storyboard's panels as images, cut from its current sheet once and kept on the board.
async function ensurePanels(account, p, sb, notes) {
  const n = (sb.panels || []).length;
  if (!sb.sheet || !n) return null;
  if (sb.panel_from === sb.sheet && (sb.panel_frames || []).length === n) return sb.panel_frames;
  const sheet = await one("select id, storage_key, status from studio.assets where id=$1 and project_id=$2", [sb.sheet, p.id]);
  if (!sheet || sheet.status !== "ready") return null;
  const made = await scratch(async (dir) => {
    const file = `${dir}/sheet`;
    await getToFile(sheet.storage_key, file);
    const crops = await cutPanels(file, n, dir);
    if (!crops) return null;
    const ids = [];
    for (const [k, c] of crops.entries()) {
      const aid = id("ast");
      const key = keys.original(account.id, p.id, aid, "jpg");
      await putFile(key, c.file, "image/jpeg");
      await q(
        `insert into studio.assets(id, project_id, account_id, kind, roles, name, mime, status, origin, storage_key) values ($1,$2,$3,'image',$4,$5,'image/jpeg','processing',$6,$7)`,
        [aid, p.id, account.id, ["frame"], `Storyboard ${sb.id} · panel ${k + 1}`, { kind: "panel", from: sb.sheet, storyboard: sb.id, panel: k + 1, box: c.box }, key],
      );
      await enqueue({ kind: "ingest", account_id: account.id, project_id: p.id, input: { asset_id: aid } });
      ids.push(aid);
    }
    return ids;
  });
  if (!made) {
    notes.push(`Storyboard ${sb.id}'s sheet didn't split cleanly into ${n} panels, so the whole sheet stands in for it.`);
    return null;
  }
  await waitReady(made);
  await setPanelFrames(p.id, sb.id, sb.sheet, made);
  return made;
}

// The take a storyboard plays as: the one chosen for it, else the one on the timeline, else its newest.
const takeOf = (sb) => ((sb.takes || []).includes(sb.chosen) ? sb.chosen : null) || sb.pick || (sb.takes || []).slice(-1)[0] || null;
const watchable = (s) => (s.panels || []).length || s.beat || s.title;

export async function buildPreview(account, projectId, { actor = "agent" } = {}) {
  const notes = [];
  let p = await getProject(account, projectId);
  let { board } = await loadBoard(p.id);
  board = withPlacement(board, p.doc);
  const sbs = board.storyboards.filter(watchable);
  if (!sbs.length) throw new HttpError(400, "There's nothing to watch yet: the board has no storyboards. Sketch the beats first.", "nothing_to_watch");

  // 1. panels not cut yet (free: they come from the sheets)
  for (const sb of sbs) if (!takeOf(sb)) await ensurePanels(account, p, sb, notes);
  board = withPlacement((await loadBoard(p.id)).board, p.doc);
  p = await getProject(account, projectId);
  const used = new Set(boardAssets(board));
  const all = used.size ? await q("select id, kind, status, probe from studio.assets where id = any($1) and project_id=$2 and deleted_at is null", [[...used], p.id]) : [];
  const asset = Object.fromEntries(all.map((a) => [a.id, a]));
  const dur = (aid) => Number(asset[aid]?.probe?.duration) || 0;
  const ready = (aid) => asset[aid]?.status === "ready";

  // 2. what the last build left, and what else is in the way
  const items = Object.values(p.doc.sequence.items);
  const mine = new Set((board.preview?.items || []).filter((i) => p.doc.sequence.items[i]));
  for (const it of items) if ([TRACKS.picture, TRACKS.voice, TRACKS.music].includes(it.trackId) && it.asset && used.has(it.asset)) mine.add(it.id);

  // 3. the layout
  const ops = [];
  const slots = [];
  let t = 0;
  for (const sb of board.storyboards.filter(watchable)) {
    const secs = sb.seconds || 15;
    const take = takeOf(sb);
    if (take && ready(take)) {
      const d = dur(take) || secs;
      ops.push({ op: "place", track: TRACKS.picture, at: t, asset: take, name: `Storyboard ${sb.id} · take` });
      slots.push({ storyboard: sb.id, as: "take", seconds: +d.toFixed(2), at: t });
      t += d;
      continue;
    }
    const times = panelTimes(sb, secs);
    const end = times.length ? Math.max(secs, times[times.length - 1].to) : secs;
    const frames = sb.panel_from === sb.sheet ? sb.panel_frames || [] : [];
    if (frames.length === times.length && frames.every(ready)) {
      times.forEach((x, i) => ops.push({ op: "place", track: TRACKS.picture, at: t + x.from, asset: frames[i], duration: Math.max(0.2, x.to - x.from), visual: { fit: "fill" }, name: `Storyboard ${sb.id} · panel ${i + 1}` }));
      slots.push({ storyboard: sb.id, as: "panels", seconds: end, at: t });
    } else if (sb.sheet && ready(sb.sheet)) {
      ops.push({ op: "place", track: TRACKS.picture, at: t, asset: sb.sheet, duration: end, visual: { fit: "fit", bg: "blur" }, name: `Storyboard ${sb.id} · sheet` });
      slots.push({ storyboard: sb.id, as: "sheet", seconds: end, at: t });
    } else {
      const text = [`${sb.id}${sb.title ? ` · ${sb.title}` : ""}`, sb.beat || ""].filter(Boolean).join("\n").slice(0, 220);
      ops.push({ op: "add_title", at: t, duration: end, text, style: { preset: "center" } });
      slots.push({ storyboard: sb.id, as: "card", seconds: end, at: t });
    }
    t += end;
  }
  const total = t;
  // the music card's sample as temp music, only where there's no take yet: takes bring their own (the
  // video model scores them from the same card). Each stretch plays the part of the track that falls
  // there, so it runs on as one piece.
  const music = (board.music || []).find((m) => m.sample && ready(m.sample));
  const mlen = music ? dur(music.sample) : 0;
  if (music && mlen > 0) {
    const runs = [];
    for (const s of slots) {
      const last = runs[runs.length - 1];
      if (s.as === "take") continue;
      if (last && Math.abs(last.to - s.at) < 0.05) last.to = s.at + s.seconds;
      else runs.push({ from: s.at, to: s.at + s.seconds });
    }
    for (const r of runs) {
      const to = Math.min(r.to, mlen);
      if (to - r.from >= 0.5) ops.push({ op: "place", track: TRACKS.music, at: r.from, asset: music.sample, in: r.from, out: to, audio: { fadeOutMs: 800 }, name: `${music.name || "Music"} · temp` });
    }
  }

  // 4. nothing of theirs is overwritten
  const keep = items.filter((it) => !mine.has(it.id) && [TRACKS.picture, TRACKS.voice, TRACKS.music].includes(it.trackId));
  const clash = keep.find((it) => it.start / fpsOf(p.doc) < total);
  if (clash) throw new HttpError(409, `The timeline already has other clips where the watch-through goes (${clash.name || clash.id} on ${clash.trackId}). Move them past ${total.toFixed(1)} s or onto another track, then build it again.`, "timeline_busy");
  const batch = [...(mine.size ? [{ op: "delete", items: [...mine] }] : []), ...ops];
  const r = await editProject(account, p.id, { ops: batch, mode: "apply", base_revision: p.revision, actor, label: "watch it through" });
  await setPreview(p.id, { items: r.added || [], revision: r.revision, at: new Date().toISOString(), seconds: +total.toFixed(2) });
  const made = slots.filter((x) => x.as === "take").length;
  if (made < slots.length) notes.push(`${made} of ${slots.length} clips made; the rest show as ${slots.some((x) => x.as === "panels" || x.as === "sheet") ? "their storyboards" : "cards with their beats"} until their takes land.`);
  return { revision: r.revision, seconds: +total.toFixed(2), slots, notes };
}
