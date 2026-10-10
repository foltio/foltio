// HTTP entry point: the MCP endpoint (agents), the JSON API (browser editor), health.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config.mjs";
import { q, one } from "./db.mjs";
import { HttpError, accountFromApiKey, accountFromSession, requireAccount, createApiKey } from "./auth.mjs";
import { TOOLS, callTool, HANDLERS, refreshDraft, PREVIEW, PREVIEW_SPENT } from "./mcp/tools.mjs";
import { INSTRUCTIONS, PROMPTS, promptMessages, skillMarkdown } from "./mcp/guide.mjs";
import { listModels, MODELS } from "./gen/catalog.mjs";
import {
  createProject, listProjects, getProject, projectAssets, assetView, editProject, history, followAspect,
  uploadTicket, finalizeUpload, signedAssetUrl, importUrl,
} from "./projects.mjs";
import { enqueue } from "./jobs/queue.mjs";
import { budget } from "./gen/billing.mjs";
import { balance, history as creditHistory, PACKS, PLANS } from "./credits.mjs";
import { checkout, portal, verify, applyEvent, stripeEnabled } from "./stripe.mjs";
import { listPublic, getPublic, getPublicSeo, listPublicIndex, cloneProject } from "./public.mjs";
import { renderSeoPage, projectSeo, legalSeo, renderSitemap } from "./seo.mjs";
import { presignGet } from "./storage.mjs";
import { startWorkers } from "./jobs/worker.mjs";
import { loadBoard, patchBoard, withPlacement, boardAssets } from "./board.mjs";
import { outOfDate } from "./gen/recipes.mjs";
import { listDrafts, createDraft, discardDraft, mediaPreviews } from "./drafts.mjs";
import { id } from "./ids.mjs";
import { redditSignUp } from "./ads.mjs";
import { allowAnalyticsIngest, analyticsDashboard, ingestAnalytics, trackServerEvent } from "./analytics.mjs";

// Server instructions, the guide and the prompts live in mcp/guide.mjs.

function send(res, status, body, headers = {}) {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json", "Cache-Control": "no-store", ...headers });
  res.end(data);
}
async function readJson(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, "Request body too large.", "too_large");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON.", "bad_json");
  }
}
const errText = (e) =>
  e instanceof HttpError
    ? `${e.code || "error"}: ${e.message}${e.extra ? `\n${JSON.stringify(e.extra)}` : ""}`
    : `internal_error: ${e.message}`;

const FEEDBACK_KINDS = new Set(["feature", "feedback", "bug"]);
const FEEDBACK_STATUSES = new Set(["new", "reviewing", "planned", "building", "shipped", "closed"]);
const FEEDBACK_PRIORITIES = new Set(["normal", "high", "urgent"]);
const isAdmin = (account) => config.adminEmails.includes(String(account?.email || "").toLowerCase());
const requireAdmin = (account) => {
  if (!isAdmin(account)) throw new HttpError(403, "Admin access required.", "admin_only");
};
const cleanText = (value, max) => String(value || "").trim().replace(/\r\n/g, "\n").slice(0, max);

async function handleMcp(req, res) {
  if (req.method === "GET" || req.method === "DELETE") return send(res, 405, { error: "Use POST (stateless Streamable HTTP)." }, { Allow: "POST" });
  const account = await accountFromApiKey(req);
  if (!account) return send(res, 401, { error: "Missing or invalid API key. Send Authorization: Bearer sk_studio_… (create one in the editor settings)." });
  const body = await readJson(req);
  const server = new Server({ name: "studio", version: "0.2.0", title: "FOLTIO — film studio" }, { capabilities: { tools: {}, prompts: {} }, instructions: INSTRUCTIONS.replaceAll("https://folt.io", config.publicOrigin) });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS.map(({ name, title, description, arguments: args }) => ({ name, title, description, arguments: args })) }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const r = promptMessages(request.params.name, request.params.arguments || {});
    if (!r) throw new Error(`Unknown prompt ${request.params.name}.`);
    return r;
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const t0 = Date.now();
    try {
      const out = await callTool(account, request.params.name, request.params.arguments, { actor: "agent" });
      console.log(`tool ${request.params.name} ok ${Date.now() - t0}ms`);
      void trackServerEvent("mcp_tool_called", { accountId: account.id, source: "agent", properties: { action: request.params.name, status: "succeeded", duration_ms: Date.now() - t0 } }).catch(() => {});
      return out;
    } catch (e) {
      console.log(`tool ${request.params.name} error ${e.code || ""} ${e.message}`);
      void trackServerEvent("mcp_tool_called", { accountId: account.id, source: "agent", properties: { action: request.params.name, status: "failed", error_code: e.code || "error", duration_ms: Date.now() - t0 } }).catch(() => {});
      return { isError: true, content: [{ type: "text", text: errText(e) }] };
    }
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

// The board for the browser: the board itself plus signed previews for every asset it points at.
async function boardPayload(account, pid, version, board) {
  const p = await getProject(account, pid);
  const b = withPlacement(board, p.doc);
  const spent = Number((await one(PREVIEW_SPENT, [p.id])).usd);
  return { version, board: b, media: await mediaPreviews(p.id, [...boardAssets(b)]), stale: outOfDate(b), previews: { spent: +spent.toFixed(2), cap: +PREVIEW.project.toFixed(2), left: +Math.max(0, PREVIEW.project - spent).toFixed(2) } };
}
// A quote of this account, with its project (drafts are edited and run from the browser).
async function quoteOf(account, quoteId) {
  const r = await one("select id, project_id, status from studio.quotes where id=$1 and account_id=$2", [quoteId, account.id]);
  if (!r) throw new HttpError(404, "Quote not found.", "unknown_quote");
  return r;
}

async function projectPayload(account, pid) {
  const p = await getProject(account, pid);
  const assets = await projectAssets(p.id, { includeRenders: true });
  const signed = await Promise.all(
    assets.map(async (a) => ({
      ...assetView(a),
      poster: a.derived?.poster ? await presignGet(a.derived.poster, 3600) : null,
      proxy: a.status === "ready" && (a.kind === "video" || a.kind === "audio") ? await presignGet(a.derived?.proxy || a.storage_key, 3600) : a.kind === "image" && a.status === "ready" ? await presignGet(a.storage_key, 3600) : null,
      waveform: a.derived?.waveform ? await presignGet(a.derived.waveform, 3600) : null,
      filmstrip: a.derived?.filmstrip ? await presignGet(a.derived.filmstrip, 3600) : null,
      filmstripStep: a.derived?.filmstripStep || null,
      transcript: a.derived?.transcript ? await presignGet(a.derived.transcript, 3600) : null,
      probe: a.probe || null,
      // baked previews of custom filters on this asset (fx.mjs fxKey → URL)
      fx: a.derived?.fx ? Object.fromEntries(await Promise.all(Object.entries(a.derived.fx).map(async ([k, key]) => [k, await presignGet(key, 3600)]))) : null,
      silences: a.derived?.silences || null,
      origin: a.origin,
      created_at: a.created_at,
    })),
  );
  const jobs = await q("select id, kind, status, progress, error, output, created_at, updated_at from studio.jobs where project_id=$1 order by created_at desc limit 40", [p.id]);
  const clones = await one("select count(*)::int as n from studio.projects where cloned_from=$1 and deleted_at is null", [p.id]);
  return { project: { id: p.id, name: p.name, revision: p.revision, doc: p.doc, updated_at: p.updated_at, public: p.is_public, clones: clones?.n ?? 0 }, assets: signed, jobs };
}

const routes = [
  ["GET", /^\/v\/(prj_\w+)$/, async (req, res, account, m) => {
    const project = await getPublicSeo(m[1]);
    const html = renderSeoPage(await readFile(join(config.webRoot, "index.html"), "utf8"), projectSeo(config.publicOrigin, project));
    send(res, 200, html, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" });
  }],
  ["GET", /^\/(terms|privacy)$/, async (req, res, account, m) => {
    const html = renderSeoPage(await readFile(join(config.webRoot, "index.html"), "utf8"), legalSeo(config.publicOrigin, m[1]));
    send(res, 200, html, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
  }],
  ["GET", /^\/sitemap\.xml$/, async (req, res) => send(res, 200, renderSitemap(config.publicOrigin, await listPublicIndex()), { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=900" })],
  ["GET", /^\/health$/, async (req, res) => send(res, 200, { ok: true, service: "studio", time: new Date().toISOString() })],
  ["GET", /^\/skill\.md$/, async (req, res) => send(res, 200, skillMarkdown(config.publicOrigin), { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=300" })],
  ["GET", /^\/api\/config$/, async (req, res) => send(res, 200, {
    localMode: config.localMode,
    supabaseUrl: config.localMode ? null : config.supabase.url,
    supabaseAnonKey: config.localMode ? null : config.supabase.anonKey,
    mcpUrl: `${config.publicOrigin}/mcp`,
    redditPixel: config.localMode ? null : config.reddit.pixel,
  })],
  ["POST", /^\/api\/analytics\/events$/, async (req, res) => {
    const body = await readJson(req, 96 * 1024);
    const account = await accountFromSession(req).catch(() => null);
    const peer = account?.id || String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
    if (!allowAnalyticsIngest(peer, body?.events?.length)) throw new HttpError(429, "Too many analytics events.", "analytics_rate_limit");
    send(res, 202, await ingestAnalytics(account, body));
  }],
  ["GET", /^\/api\/me$/, async (req, res, account) => {
    const keysRows = await q("select id, name, prefix, kind, created_at, last_used_at, expires_at from studio.api_keys where account_id=$1 and revoked_at is null and (expires_at is null or expires_at > now()) order by created_at desc", [account.id]);
    // read fresh: the session's account is cached for a few minutes
    const prefs = await one("select quick_auto from studio.accounts where id=$1", [account.id]);
    send(res, 200, { email: account.email, admin: isAdmin(account), budget: await budget(account), keys: keysRows, mcpUrl: `${config.publicOrigin}/mcp`, quick_auto: !!prefs?.quick_auto });
  }],
  ["GET", /^\/api\/feedback$/, async (req, res, account) => {
    const [updates, requests, messages] = await Promise.all([
      q("select id, title, body, tag, created_at from studio.product_updates where published=true order by created_at desc limit 40"),
      q("select id, kind, title, details, context, status, admin_response, created_at, updated_at from studio.feedback where account_id=$1 order by created_at desc limit 100", [account.id]),
      q(`select m.id, m.feedback_id, m.author_role, m.body, m.created_at
         from studio.feedback_messages m join studio.feedback f on f.id=m.feedback_id
         where f.account_id=$1 order by m.created_at asc`, [account.id]),
    ]);
    const threads = Object.groupBy(messages, (message) => message.feedback_id);
    send(res, 200, { updates, requests: requests.map((request) => ({ ...request, messages: threads[request.id] || [] })), admin: isAdmin(account) });
  }],
  ["GET", /^\/api\/admin\/analytics$/, async (req, res, account, m, url) => {
    requireAdmin(account);
    send(res, 200, await analyticsDashboard(Number(url.searchParams.get("days") || 30)));
  }],
  ["POST", /^\/api\/feedback$/, async (req, res, account) => {
    const recent = await one("select count(*)::int as n from studio.feedback where account_id=$1 and created_at > now() - interval '1 hour'", [account.id]);
    if (recent.n >= 10) throw new HttpError(429, "You have sent several requests recently. Please try again in a little while.", "feedback_rate_limit");
    const b = await readJson(req);
    const kind = FEEDBACK_KINDS.has(b.kind) ? b.kind : "feedback";
    const title = cleanText(b.title, 120), details = cleanText(b.details, 5000), context = cleanText(b.context, 300);
    if (title.length < 5) throw new HttpError(400, "Give this request a short, specific title.", "feedback_title");
    if (details.length < 20) throw new HttpError(400, "A little more detail will help us act on this quickly.", "feedback_details");
    const row = await one(
      "insert into studio.feedback(id, account_id, kind, title, details, context) values ($1,$2,$3,$4,$5,$6) returning id, kind, title, details, context, status, admin_response, created_at, updated_at",
      [id("fbk"), account.id, kind, title, details, context || null],
    );
    send(res, 201, { request: row });
  }],
  ["POST", /^\/api\/ads\/convert$/, async (req, res, account) => {
    const b = await readJson(req, 4096);
    if (b.event !== "SignUp" || !String(b.conversionId || "").startsWith("signup:"))
      throw new HttpError(400, "Unknown conversion event.", "conversion_event");
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    void redditSignUp({ account, conversionId: b.conversionId, clickId: b.clickId, ip: forwarded || req.socket.remoteAddress, userAgent: req.headers["user-agent"] });
    send(res, 202, { ok: true });
  }],
  ["POST", /^\/api\/feedback\/(fbk_\w+)\/messages$/, async (req, res, account, m) => {
    const feedback = await one("select id from studio.feedback where id=$1 and account_id=$2", [m[1], account.id]);
    if (!feedback) throw new HttpError(404, "Feedback request not found.", "unknown_feedback");
    const recent = await one("select count(*)::int as n from studio.feedback_messages where account_id=$1 and created_at > now() - interval '1 hour'", [account.id]);
    if (recent.n >= 30) throw new HttpError(429, "You have sent several messages recently. Please try again in a little while.", "feedback_rate_limit");
    const body = cleanText((await readJson(req)).body, 5000);
    if (body.length < 2) throw new HttpError(400, "Write a little more so we can help.", "feedback_message");
    const message = await one(
      "insert into studio.feedback_messages(id, feedback_id, account_id, author_role, body) values ($1,$2,$3,'user',$4) returning id, feedback_id, author_role, body, created_at",
      [id("fbm"), feedback.id, account.id, body],
    );
    await q("update studio.feedback set updated_at=now() where id=$1", [feedback.id]);
    send(res, 201, { message });
  }],
  ["GET", /^\/api\/admin\/feedback$/, async (req, res, account) => {
    requireAdmin(account);
    const [requests, updates, messages] = await Promise.all([
      q(`select f.id, f.kind, f.title, f.details, f.context, f.status, f.priority, f.admin_response, f.created_at, f.updated_at,
                a.email, a.name
         from studio.feedback f join studio.accounts a on a.id=f.account_id
         order by case f.priority when 'urgent' then 0 when 'high' then 1 else 2 end, f.created_at desc limit 500`),
      q("select id, title, body, tag, published, created_at from studio.product_updates order by created_at desc limit 100"),
      q("select id, feedback_id, author_role, body, created_at from studio.feedback_messages order by created_at asc"),
    ]);
    const threads = Object.groupBy(messages, (message) => message.feedback_id);
    send(res, 200, { requests: requests.map((request) => ({ ...request, messages: threads[request.id] || [] })), updates });
  }],
  ["POST", /^\/api\/admin\/feedback\/(fbk_\w+)$/, async (req, res, account, m) => {
    requireAdmin(account);
    const b = await readJson(req);
    const status = FEEDBACK_STATUSES.has(b.status) ? b.status : null;
    const priority = FEEDBACK_PRIORITIES.has(b.priority) ? b.priority : null;
    if (!status || !priority) throw new HttpError(400, "Unknown feedback status or priority.", "feedback_state");
    const response = cleanText(b.admin_response, 5000);
    const row = await one(
      "update studio.feedback set status=$2, priority=$3, admin_response=$4, updated_at=now() where id=$1 returning id, status, priority, admin_response, updated_at",
      [m[1], status, priority, response || null],
    );
    if (!row) throw new HttpError(404, "Feedback request not found.", "unknown_feedback");
    send(res, 200, { request: row });
  }],
  ["POST", /^\/api\/admin\/feedback\/(fbk_\w+)\/messages$/, async (req, res, account, m) => {
    requireAdmin(account);
    const feedback = await one("select id from studio.feedback where id=$1", [m[1]]);
    if (!feedback) throw new HttpError(404, "Feedback request not found.", "unknown_feedback");
    const body = cleanText((await readJson(req)).body, 5000);
    if (body.length < 2) throw new HttpError(400, "Write a useful reply before sending.", "feedback_message");
    const message = await one(
      "insert into studio.feedback_messages(id, feedback_id, account_id, author_role, body) values ($1,$2,$3,'support',$4) returning id, feedback_id, author_role, body, created_at",
      [id("fbm"), feedback.id, account.id, body],
    );
    const updated = await one("update studio.feedback set status=case when status='new' then 'reviewing' else status end, updated_at=now() where id=$1 returning status, updated_at", [feedback.id]);
    send(res, 201, { message, ...updated });
  }],
  ["POST", /^\/api\/admin\/updates$/, async (req, res, account) => {
    requireAdmin(account);
    const b = await readJson(req);
    const title = cleanText(b.title, 120), body = cleanText(b.body, 3000), tag = cleanText(b.tag, 30) || "Update";
    if (title.length < 4 || body.length < 12) throw new HttpError(400, "An update needs a title and a useful description.", "update_details");
    const row = await one(
      "insert into studio.product_updates(id, title, body, tag, created_by) values ($1,$2,$3,$4,$5) returning id, title, body, tag, published, created_at",
      [id("upd"), title, body, tag, account.id],
    );
    send(res, 201, { update: row });
  }],
  // public projects (free accounts): watch, browse, clone
  ["GET", /^\/api\/public\/projects$/, async (req, res, account, m, url) => send(res, 200, { projects: await listPublic({ sort: url.searchParams.get("sort") || "clones", q: url.searchParams.get("q") || "" }) })],
  ["GET", /^\/api\/public\/projects\/(prj_\w+)$/, async (req, res, account, m) => send(res, 200, await getPublic(m[1]))],
  ["GET", /^\/api\/public\/projects\/(prj_\w+)\/poster$/, async (req, res, account, m) => {
    const project = await getPublicSeo(m[1]);
    if (!project.posterKey) return send(res, 404, { error: "This project has no poster." });
    send(res, 302, "", { Location: await presignGet(project.posterKey, 3600), "Cache-Control": "public, max-age=300" });
  }],
  ["POST", /^\/api\/projects\/(prj_\w+)\/clone$/, async (req, res, account, m) => send(res, 201, await cloneProject(account, m[1]))],
  ["GET", /^\/api\/billing$/, async (req, res, account) => {
    const [b, credits, usage, subscription] = await Promise.all([
      balance(account),
      creditHistory(account.id),
      q(
        `select note, sum(case when kind='hold' then amount_usd else -amount_usd end)::float as usd, max(created_at) as at
         from studio.ledger l where account_id=$1 and created_at >= (select billing_from from studio.accounts where id=$1)
         group by note, date_trunc('day', created_at) order by at desc limit 40`,
        [account.id],
      ),
      one("select plan_id, status, current_period_end, cancel_at_period_end from studio.subscriptions where account_id=$1", [account.id]),
    ]);
    send(res, 200, { ...b, packs: PACKS, plans: PLANS, subscription, purchases: stripeEnabled, credits, usage, markup: config.markup });
  }],
  ["POST", /^\/api\/billing\/checkout$/, async (req, res, account) => send(res, 200, await checkout(account, (await readJson(req)).pack))],
  ["POST", /^\/api\/billing\/portal$/, async (req, res, account) => send(res, 200, await portal(account))],
  ["POST", /^\/api\/keys$/, async (req, res, account) => {
    const b = await readJson(req);
    const secret = await createApiKey(account.id, String(b.name || "Claude Code").slice(0, 60));
    send(res, 201, { key: secret, command: `claude mcp add --transport http studio ${config.publicOrigin}/mcp --header "Authorization: Bearer ${secret}"` });
  }],
  ["POST", /^\/api\/keys\/([\w-]+)\/revoke$/, async (req, res, account, m) => {
    await q("update studio.api_keys set revoked_at=now() where id=$1 and account_id=$2", [m[1], account.id]);
    send(res, 200, { ok: true });
  }],
  ["POST", /^\/api\/settings$/, async (req, res, account) => {
    const b = await readJson(req);
    const cap = b.monthly_cap_credits !== undefined ? Number(b.monthly_cap_credits) / 100 : Number(b.monthly_cap_usd);
    const auto = b.per_op_auto_credits !== undefined ? Number(b.per_op_auto_credits) / 100 : Number(b.per_op_auto_usd);
    if (Number.isFinite(cap) && cap >= 0 && cap <= 2000) await q("update studio.accounts set monthly_cap_usd=$2 where id=$1", [account.id, cap]);
    if (Number.isFinite(auto) && auto >= 0 && auto <= 200) await q("update studio.accounts set per_op_auto_usd=$2 where id=$1", [account.id, auto]);
    if (typeof b.quick_auto === "boolean") await q("update studio.accounts set quick_auto=$2 where id=$1", [account.id, b.quick_auto]);
    send(res, 200, { ok: true });
  }],
  ["GET", /^\/api\/projects$/, async (req, res, account) => {
    const rows = await listProjects(account);
    send(res, 200, { projects: await Promise.all(rows.map(async (p) => ({ ...p, poster: p.poster_key ? await presignGet(p.poster_key, 3600) : null }))) });
  }],
  ["POST", /^\/api\/projects$/, async (req, res, account) => send(res, 201, await createProject(account, await readJson(req)))],
  ["GET", /^\/api\/projects\/(prj_\w+)$/, async (req, res, account, m) => send(res, 200, await projectPayload(account, m[1]))],
  ["POST", /^\/api\/projects\/(prj_\w+)$/, async (req, res, account, m) => {
    const b = await readJson(req);
    const p = await getProject(account, m[1]);
    if (b.name && String(b.name).trim()) await q("update studio.projects set name=$2, updated_at=now() where id=$1", [p.id, String(b.name).trim().slice(0, 120)]);
    if (typeof b.public === "boolean") await q("update studio.projects set is_public=$2, updated_at=now() where id=$1", [p.id, b.public]);
    send(res, 200, { ok: true, public: typeof b.public === "boolean" ? b.public : p.is_public });
  }],
  ["DELETE", /^\/api\/projects\/(prj_\w+)$/, async (req, res, account, m) => {
    const p = await getProject(account, m[1]);
    await q("update studio.projects set deleted_at=now() where id=$1", [p.id]);
    send(res, 200, { ok: true });
  }],
  ["POST", /^\/api\/projects\/(prj_\w+)\/edit$/, async (req, res, account, m) => {
    const { _doc, _before, _assets, ...r } = await editProject(account, m[1], { ...(await readJson(req)), actor: "human" });
    send(res, 200, { ...r, doc: _doc });
  }],
  ["GET", /^\/api\/projects\/(prj_\w+)\/board$/, async (req, res, account, m) => {
    const p = await getProject(account, m[1]);
    const { board, version } = await loadBoard(p.id);
    send(res, 200, await boardPayload(account, p.id, version, board));
  }],
  ["POST", /^\/api\/projects\/(prj_\w+)\/board$/, async (req, res, account, m) => {
    const p = await getProject(account, m[1]);
    const { patch } = await readJson(req);
    const { board, version, warnings } = await patchBoard(p.id, patch);
    const note = patch?.brief?.aspect ? await followAspect(account, p.id, board.brief.aspect, "human") : null;
    send(res, 200, { ...(await boardPayload(account, p.id, version, board)), warnings: note ? [...warnings, note] : warnings });
  }],
  // the film so far laid out on the timeline from the board (takes, else panels or a card)
  ["POST", /^\/api\/projects\/(prj_\w+)\/preview$/, async (req, res, account, m) => {
    const r = await HANDLERS.board_preview(account, { project_id: m[1] }, { actor: "human" });
    send(res, 200, r.structuredContent);
  }],
  // drafts: what the director (or the person) prepared, editable until it runs
  ["GET", /^\/api\/projects\/(prj_\w+)\/drafts$/, async (req, res, account, m) => {
    const p = await getProject(account, m[1]);
    send(res, 200, await listDrafts(account, p.id));
  }],
  ["POST", /^\/api\/projects\/(prj_\w+)\/drafts$/, async (req, res, account, m) => {
    const p = await getProject(account, m[1]);
    send(res, 201, await createDraft(account, p.id, await readJson(req)));
  }],
  ["POST", /^\/api\/quotes\/(qt_\w+)\/edit$/, async (req, res, account, m) => {
    const qt = await quoteOf(account, m[1]);
    const b = await readJson(req);
    const out = await HANDLERS.gen_quote(account, { ...b, project_id: qt.project_id, quote_id: qt.id }, { actor: "human" });
    send(res, 200, out.structuredContent);
  }],
  ["POST", /^\/api\/quotes\/(qt_\w+)\/generate$/, async (req, res, account, m) => {
    await quoteOf(account, m[1]);
    // made from the board, and the board changed since (an anchor landed): rebuilt before it runs
    const rebuilt = await refreshDraft(account, m[1]).catch((e) => (console.warn("draft_refresh_failed", m[1], e.message), false));
    const out = await HANDLERS.gen_run(account, { quote_id: m[1] }, { actor: "human" });
    send(res, 202, { ...out.structuredContent, ...(rebuilt ? { rebuilt: true } : {}) });
  }],
  ["POST", /^\/api\/quotes\/(qt_\w+)\/discard$/, async (req, res, account, m) => send(res, 200, await discardDraft(account, m[1]))],
  ["POST", /^\/api\/projects\/(prj_\w+)\/history$/, async (req, res, account, m) => {
    const { _doc, ...r } = await history(account, m[1], { ...(await readJson(req)), actor: "human" });
    send(res, 200, { ...r, doc: _doc });
  }],
  ["POST", /^\/api\/assets\/(ast_\w+)$/, async (req, res, account, m) => {
    const b = await readJson(req);
    if (b.name) await q("update studio.assets set name=$3, updated_at=now() where id=$1 and account_id=$2", [m[1], account.id, String(b.name).slice(0, 160)]);
    send(res, 200, { ok: true });
  }],
  ["DELETE", /^\/api\/assets\/(ast_\w+)$/, async (req, res, account, m) => {
    await q("update studio.assets set deleted_at=now() where id=$1 and account_id=$2", [m[1], account.id]);
    send(res, 200, { ok: true });
  }],
  ["POST", /^\/api\/projects\/(prj_\w+)\/render$/, async (req, res, account, m) => {
    const p = await getProject(account, m[1]);
    const b = await readJson(req);
    const quality = b.quality === "final" ? "final" : "draft";
    const job = await enqueue({ kind: "render", account_id: account.id, project_id: p.id, input: { project_id: p.id, quality, revision: p.revision }, idempotency_key: `${quality}:${p.id}:${p.revision}` });
    send(res, 202, { job_id: job.id });
  }],
  ["POST", /^\/api\/projects\/(prj_\w+)\/import$/, async (req, res, account, m) => send(res, 202, await importUrl(account, m[1], await readJson(req)))],
  ["POST", /^\/api\/assets\/(ast_\w+)\/transcribe$/, async (req, res, account, m) => {
    const a = await one("select id, project_id, probe from studio.assets where id=$1 and account_id=$2 and deleted_at is null", [m[1], account.id]);
    if (!a) throw new HttpError(404, "Asset not found.", "unknown_asset");
    if (!a.probe?.audio) throw new HttpError(400, "This file has no audio to transcribe.", "no_audio");
    const job = await enqueue({ kind: "transcribe", account_id: account.id, project_id: a.project_id, input: { asset_id: a.id }, idempotency_key: `transcribe:${a.id}:${Date.now() >> 16}` });
    send(res, 202, { job_id: job.id });
  }],
  ["POST", /^\/api\/projects\/(prj_\w+)\/upload$/, async (req, res, account, m) => send(res, 201, await uploadTicket(account, m[1], await readJson(req)))],
  ["POST", /^\/api\/projects\/(prj_\w+)\/finalize$/, async (req, res, account, m) => send(res, 200, await finalizeUpload(account, m[1], (await readJson(req)).asset_id))],
  ["GET", /^\/api\/assets\/(ast_\w+)\/url$/, async (req, res, account, m, url) => send(res, 200, { url: await signedAssetUrl(account, m[1], url.searchParams.get("kind") || "original") })],
  ["GET", /^\/api\/projects\/(prj_\w+)\/quotes$/, async (req, res, account, m) => {
    const rows = await q("select id, model, request, cost_usd, status, expires_at, created_at from studio.quotes where project_id=$1 and account_id=$2 and status='needs_approval' and expires_at > now() order by created_at desc limit 10", [m[1], account.id]);
    send(res, 200, { quotes: rows });
  }],
  ["GET", /^\/api\/models$/, async (req, res) => send(res, 200, { models: listModels().map((m) => ({ ...m, params: MODELS[m.id].params, referenceRoles: MODELS[m.id].references })) })],
  ["POST", /^\/api\/projects\/(prj_\w+)\/quote$/, async (req, res, account, m) => {
    const out = await HANDLERS.gen_quote(account, { ...(await readJson(req)), project_id: m[1] }, { actor: "human" });
    send(res, 201, out.structuredContent);
  }],
  ["POST", /^\/api\/quotes\/(qt_\w+)\/run$/, async (req, res, account, m) => {
    const out = await HANDLERS.gen_run(account, { quote_id: m[1] });
    send(res, 202, out.structuredContent);
  }],
  ["GET", /^\/api\/quotes\/(qt_\w+)$/, async (req, res, account, m) => {
    const qt = await one("select id, model, request, cost_usd, status, expires_at, project_id, created_at from studio.quotes where id=$1 and account_id=$2", [m[1], account.id]);
    if (!qt) throw new HttpError(404, "Quote not found.", "unknown_quote");
    send(res, 200, { quote: qt, budget: await budget(account) });
  }],
  ["POST", /^\/api\/quotes\/(qt_\w+)\/(approve|deny)$/, async (req, res, account, m) => {
    const status = m[2] === "approve" ? "approved" : "denied";
    const r = await one("update studio.quotes set status=$3, decided_at=now(), expires_at=greatest(expires_at, now()+interval '30 minutes') where id=$1 and account_id=$2 and status='needs_approval' returning id, status", [m[1], account.id, status]);
    if (!r) throw new HttpError(409, "This quote is not waiting for approval.", "not_pending");
    send(res, 200, r);
  }],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://local");
  try {
    if (url.pathname === "/mcp") return await handleMcp(req, res);
    if (url.pathname === "/api/stripe/webhook" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      await applyEvent(verify(Buffer.concat(chunks).toString("utf8"), req.headers["stripe-signature"]));
      return send(res, 200, { received: true });
    }
    for (const [method, re, fn] of routes) {
      const m = url.pathname.match(re);
      if (!m || req.method !== method) continue;
      const open = url.pathname.startsWith("/api/public/") || url.pathname.startsWith("/v/") || ["/terms", "/privacy", "/sitemap.xml", "/health", "/api/config", "/api/models", "/api/analytics/events", "/skill.md"].includes(url.pathname);
      const account = open ? null : await requireAccount(req);
      return await fn(req, res, account, m, url);
    }
    send(res, 404, { error: "Not found." });
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(req.method, url.pathname, e);
    send(res, e.status || 500, { error: e.message, code: e.code || "internal_error", ...(e.extra || {}) });
  }
});
server.requestTimeout = 120_000;
server.listen(config.port, config.host, () => console.log(`foltio listening on ${config.host}:${config.port}`));
startWorkers();
