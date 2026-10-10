// Drafts for the browser: generations waiting for the person (status review, or above the
// auto-approve limit), plus the ones decided lately so the chat can show how each ended. Each comes
// with previews of its references, so the panel can show and edit exactly what goes to the model.
import { q, one } from "./db.mjs";
import { HttpError } from "./auth.mjs";
import { presignGet } from "./storage.mjs";
import { HANDLERS } from "./mcp/tools.mjs";

const OPEN = ["review", "needs_approval"];

export async function mediaPreviews(projectId, ids) {
  const list = [...new Set(ids)].filter(Boolean);
  if (!list.length) return {};
  const rows = await q("select id, kind, name, status, storage_key, derived, probe from studio.assets where project_id=$1 and id = any($2)", [projectId, list]);
  const media = {};
  for (const a of rows) {
    const poster = a.kind === "image" ? a.storage_key : a.derived?.poster;
    media[a.id] = {
      kind: a.kind,
      name: a.name,
      status: a.status,
      duration: a.probe?.duration || null,
      poster: poster ? await presignGet(poster, 3600) : null,
      full: a.kind === "image" && a.status === "ready" ? await presignGet(a.storage_key, 3600) : null,
      url: a.status === "ready" && (a.kind === "audio" || a.kind === "video") ? await presignGet(a.derived?.proxy || a.storage_key, 3600) : null,
    };
  }
  return media;
}

export async function listDrafts(account, projectId) {
  const rows = await q(
    `select id, model, request, cost_usd, status, expires_at, created_at, updated_at, decided_at, edited_by from studio.quotes
     where project_id=$1 and account_id=$2 and (
       (status = any($3) and expires_at > now())
       or (request ? 'by' and status in ('used','denied') and coalesce(updated_at, decided_at, created_at) > now() - interval '2 days')
     ) order by created_at desc limit 60`,
    [projectId, account.id, OPEN],
  );
  const used = rows.filter((r) => r.status === "used").map((r) => r.id);
  const jobs = used.length
    ? await q("select id, status, error, output, input->>'quote_id' as quote_id, progress from studio.jobs where account_id=$1 and kind='generate' and input->>'quote_id' = any($2) order by created_at", [account.id, used])
    : [];
  const ids = [];
  for (const r of rows) for (const ref of r.request.references || []) ids.push(ref.asset_id);
  for (const j of jobs) for (const a of j.output?.assets || []) ids.push(a);
  const media = await mediaPreviews(projectId, ids);
  return {
    drafts: rows.map((r) => ({
      id: r.id,
      status: r.status,
      model: r.request.model || r.model,
      ...(r.request.model === "raw" ? { endpoint: r.request.endpoint, priced: r.request.raw?.basis || null } : {}),
      title: r.request.title || null,
      for: r.request.for || null,
      by: r.request.by || null,
      edited_by: r.edited_by || null,
      prompt: r.request.prompt || "",
      text: r.request.text || "",
      params: r.request.params || {},
      references: (r.request.references || []).map(({ asset_id, role, seconds }) => ({ asset_id, role, ...(seconds ? { seconds } : {}) })),
      takes: r.request.takes || 1,
      cost_usd: Number(r.cost_usd),
      created_at: r.created_at,
      updated_at: r.updated_at,
      expires_at: r.expires_at,
      jobs: jobs.filter((j) => j.quote_id === r.id).map((j) => ({ id: j.id, status: j.status, progress: j.progress, error: j.error?.message || (typeof j.error === "string" ? j.error : null), assets: j.output?.assets || [] })),
    })),
    media,
  };
}

// A draft the person starts themselves: from the board ({for}) or from a take ({from_asset}),
// to change its prompt or references and make it again.
export async function createDraft(account, projectId, body) {
  if (body.from_asset) {
    const a = await one("select id, name, origin from studio.assets where id=$1 and project_id=$2 and deleted_at is null", [body.from_asset, projectId]);
    if (!a) throw new HttpError(404, "That file isn't in this project.", "unknown_asset");
    const o = a.origin || {};
    if (o.kind !== "generation") throw new HttpError(400, "Only generated files can be made again with changes.", "not_generated");
    const prev = o.quote ? await one("select request from studio.quotes where id=$1 and account_id=$2", [o.quote, account.id]) : null;
    const r = prev?.request || {};
    const out = await HANDLERS.gen_quote(
      account,
      {
        project_id: projectId,
        model: o.model,
        prompt: o.model === "voice" ? undefined : o.prompt,
        text: o.model === "voice" ? o.prompt : undefined,
        params: o.params || {},
        references: (o.references || []).map(({ asset_id, role }) => ({ asset_id, role })),
        label: r.label,
        file_to: o.for || (o.shot ? { storyboard: o.shot } : undefined),
        title: `${String(r.title || a.name || "Generation").replace(/( · again)+$/, "")} · again`,
        draft: true,
      },
      { actor: "human" },
    );
    return out.structuredContent;
  }
  // the same request again, to change and make again (also after a failure, when there is no output)
  if (body.from_quote) {
    const prev = await one("select request, project_id from studio.quotes where id=$1 and account_id=$2", [body.from_quote, account.id]);
    if (!prev || prev.project_id !== projectId) throw new HttpError(404, "That generation isn't in this project.", "unknown_quote");
    const r = prev.request;
    const out = await HANDLERS.gen_quote(
      account,
      {
        project_id: projectId,
        model: r.model,
        prompt: r.model === "voice" ? undefined : r.prompt,
        text: r.model === "voice" ? r.text || r.prompt : undefined,
        params: r.params || {},
        references: (r.references || []).filter((x) => !String(x.asset_id).startsWith("pending:")).map(({ asset_id, role }) => ({ asset_id, role })),
        takes: r.takes || 1,
        label: r.label,
        file_to: r.for,
        title: `${String(r.title || r.model).replace(/( · again)+$/, "")} · again`,
        draft: true,
      },
      { actor: "human" },
    );
    return out.structuredContent;
  }
  if (body.for) return (await HANDLERS.gen_quote(account, { project_id: projectId, for: body.for, ...(body.model ? { model: body.model } : {}), draft: true }, { actor: "human" })).structuredContent;
  throw new HttpError(400, "Pass for (something on the board) or from_asset (a generated file).", "bad_request");
}

export async function discardDraft(account, quoteId) {
  const r = await one(
    "update studio.quotes set status='denied', decided_at=now(), updated_at=now() where id=$1 and account_id=$2 and status in ('review','open','needs_approval','approved') returning id, status",
    [quoteId, account.id],
  );
  if (!r) throw new HttpError(409, "This generation already ran or was discarded.", "quote_closed");
  return r;
}
