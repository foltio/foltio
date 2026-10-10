// Public projects and cloning. Projects start public and their owner can make each one private;
// anyone may watch a public project at /v/:id and clone it into their own account. A clone is a full
// copy: new project and asset ids, every file copied inside R2 (no download), the doc and the board
// rewritten to the new ids. Quotes, jobs, the ledger and agent conversations stay behind.
import { q, one, tx } from "./db.mjs";
import { id } from "./ids.mjs";
import { HttpError } from "./auth.mjs";
import { presignGet, list, copy } from "./storage.mjs";
import { loadBoard } from "./board.mjs";

// What the public sees of the owner: a first name or the part of the email before the @, never the email.
export const ownerName = (name, email) => {
  const first = String(name || "").trim().split(/\s+/)[0];
  if (first) return first.slice(0, 40);
  return String(email || "").split("@")[0].slice(0, 40) || "someone";
};

// Projects with something in them: at least one asset, or a board with a brief or clips.
// something to look at: at least one picture, clip or sound (an idea alone isn't worth showing)
const HAS_CONTENT = `exists (select 1 from studio.assets a where a.project_id = p.id and a.deleted_at is null and a.status = 'ready')`;
const POSTER_KEY = `coalesce(p.poster_key, (
  select coalesce(a.derived->>'poster', case when a.kind='image' then a.storage_key end) from studio.assets a
  where a.project_id=p.id and a.deleted_at is null and a.status='ready' and a.kind in ('video','image')
    and (a.derived->>'poster' is not null or a.kind='image')
  order by (a.kind='video') desc, a.created_at desc limit 1))`;

export async function listPublic({ sort = "clones", q: search = "", limit = 48 } = {}) {
  const rows = await q(
    `select p.id, p.name, p.updated_at, p.clones,
       (p.doc->'settings'->>'width')::int as width, (p.doc->'settings'->>'height')::int as height,
       ${POSTER_KEY} as poster_key,
       acc.name as owner_name, acc.email as owner_email
     from studio.public_projects p join studio.accounts acc on acc.id = p.account_id
     where ${HAS_CONTENT} and ($1::text = '' or p.name ilike '%'||$1||'%')
     order by ${sort === "recent" ? "p.updated_at desc" : "p.clones desc, p.updated_at desc"}
     limit $2`,
    [String(search || "").slice(0, 80), Math.min(100, Math.max(1, Number(limit) || 48))],
  );
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      name: r.name,
      width: r.width,
      height: r.height,
      clones: r.clones,
      owner: ownerName(r.owner_name, r.owner_email),
      updated_at: r.updated_at,
      poster: r.poster_key ? await presignGet(r.poster_key, 3600) : null,
    })),
  );
}

// Lightweight, stable metadata for crawler HTML, social previews and the sitemap. Signed media URLs
// never go in HTML: the stable poster endpoint below redirects to a fresh one when fetched.
export async function getPublicSeo(projectId) {
  const p = await one(
    `select p.id, p.name, p.updated_at, ${POSTER_KEY} as poster_key,
       acc.name as owner_name, acc.email as owner_email
     from studio.public_projects p join studio.accounts acc on acc.id=p.account_id where p.id=$1`,
    [projectId],
  );
  if (!p) throw new HttpError(404, "This project isn't public.", "not_public");
  return { id: p.id, name: p.name, updated_at: p.updated_at, owner: ownerName(p.owner_name, p.owner_email), hasPoster: !!p.poster_key, posterKey: p.poster_key };
}

export async function listPublicIndex() {
  return q(`select p.id, p.updated_at from studio.public_projects p where ${HAS_CONTENT} order by p.updated_at desc limit 49997`);
}

// One public project, read-only: doc, signed assets (renders included), board and its media.
export async function getPublic(projectId) {
  const p = await one(
    `select p.id, p.name, p.doc, p.revision, p.updated_at, p.clones, p.cloned_from, acc.name as owner_name, acc.email as owner_email
     from studio.public_projects p join studio.accounts acc on acc.id = p.account_id where p.id = $1`,
    [projectId],
  );
  if (!p) throw new HttpError(404, "This project isn't public.", "not_public");
  const rows = await q("select * from studio.assets where project_id=$1 and deleted_at is null order by created_at", [p.id]);
  const sign = (k, s = 3600) => (k ? presignGet(k, s) : null);
  const assets = await Promise.all(
    rows.map(async (a) => ({
      id: a.id,
      kind: a.kind,
      name: a.name,
      status: a.status,
      roles: a.roles,
      probe: a.probe || null,
      duration_s: a.probe?.duration ?? null,
      poster: await sign(a.kind === "image" ? a.storage_key : a.derived?.poster),
      proxy: a.status === "ready" && (a.kind === "video" || a.kind === "audio") ? await sign(a.derived?.proxy || a.storage_key) : a.kind === "image" && a.status === "ready" ? await sign(a.storage_key) : null,
      waveform: await sign(a.derived?.waveform),
      filmstrip: await sign(a.derived?.filmstrip),
      filmstripStep: a.derived?.filmstripStep || null,
      transcript: await sign(a.derived?.transcript),
      silences: a.derived?.silences || null,
      origin: a.origin,
      created_at: a.created_at,
    })),
  );
  const render = [...rows].reverse().find((a) => (a.roles || []).includes("render") && a.status === "ready");
  const { board } = await loadBoard(p.id);
  return {
    project: { id: p.id, name: p.name, doc: p.doc, revision: p.revision, updated_at: p.updated_at },
    owner: ownerName(p.owner_name, p.owner_email),
    clones: p.clones,
    cloned_from: p.cloned_from,
    render: render ? { id: render.id, url: await sign(render.storage_key), poster: await sign(render.derived?.poster) } : null,
    assets,
    board,
  };
}

// Swap every old id for its new one in a JSON-able value (doc, board, asset rows).
export function rewrite(value, map) {
  if (value == null) return value;
  let s = JSON.stringify(value);
  for (const [from, to] of map) s = s.split(from).join(to);
  return JSON.parse(s);
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      await fn(items[k]);
    }
  }));
}

// Clone a public project into this account. Returns the new project's id.
export async function cloneProject(account, sourceId) {
  const src = await one("select p.* from studio.public_projects p where p.id=$1", [sourceId]);
  if (!src) {
    // your own project can always be cloned too
    const own = await one("select * from studio.projects where id=$1 and account_id=$2 and deleted_at is null", [sourceId, account.id]);
    if (!own) throw new HttpError(404, "This project isn't public.", "not_public");
    Object.assign(own, { clones: 0 });
    return cloneRows(account, own);
  }
  return cloneRows(account, src);
}

async function cloneRows(account, src) {
  const newId = id("prj");
  const assets = await q("select * from studio.assets where project_id=$1 and deleted_at is null order by created_at", [src.id]);
  // ids and storage prefixes, old → new (longest first, so a project prefix never clips an asset id)
  const map = new Map([[`a/${src.account_id}/${src.id}/`, `a/${account.id}/${newId}/`], [src.id, newId]]);
  for (const a of assets) map.set(a.id, id("ast"));
  const ordered = [...map].sort((x, y) => y[0].length - x[0].length);

  // the files: everything under the project's prefix, copied server-side under the new prefix
  const keys = await list(`a/${src.account_id}/${src.id}/`);
  await pool(keys, 8, (k) => copy(k, ordered.reduce((s, [from, to]) => s.split(from).join(to), k)));

  const { board } = await loadBoard(src.id);
  const doc = rewrite(src.doc, ordered);
  await tx(async (t) => {
    await t.q(
      "insert into studio.projects(id, account_id, name, doc, revision, poster_key, cloned_from) values ($1,$2,$3,$4,0,$5,$6)",
      [newId, account.id, `${src.name} (clone)`.slice(0, 120), doc, src.poster_key ? rewrite(src.poster_key, ordered) : null, src.id],
    );
    await t.q("insert into studio.commits(project_id, revision, actor, label, ops, summary, doc) values ($1,0,'system','cloned','[]','{}',$2)", [newId, doc]);
    for (const a of assets) {
      const r = rewrite(a, ordered);
      await t.q(
        `insert into studio.assets(id, project_id, account_id, kind, roles, name, mime, bytes, sha256, status, origin, probe, derived, storage_key, error)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [r.id, newId, account.id, r.kind, r.roles, r.name, r.mime, r.bytes, r.sha256, r.status === "ready" ? "ready" : r.status, { ...(r.origin || {}), cloned_from: { project: src.id, asset: a.id } }, r.probe, r.derived, r.storage_key, r.error],
      );
    }
    if (board) await t.q("insert into studio.boards(project_id, data, version) values ($1,$2,1) on conflict (project_id) do update set data=excluded.data", [newId, rewrite(board, ordered)]);
  });
  return { id: newId, files: keys.length, assets: assets.length };
}
