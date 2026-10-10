// Privacy-safe first-party analytics. Never accept creative content: prompts, chat, file names,
// media URLs and free-form text are intentionally absent from the property allowlist.
import { q, one } from "./db.mjs";
import { id } from "./ids.mjs";
import { config } from "./config.mjs";

const EVENT = /^[a-z][a-z0-9_]{1,63}$/;
const TOKEN = /^[a-zA-Z0-9:_./-]{1,160}$/;
const PROPERTY_KEYS = new Set([
  "area", "action", "kind", "mode", "model", "status", "quality", "aspect", "tab", "control",
  "source", "medium", "campaign", "content", "term", "referrer_domain", "device", "browser", "os",
  "signed_in", "fresh", "success", "error_code", "route", "version", "visibility", "provider",
  "duration_ms", "active_ms", "load_ms", "lcp_ms", "cls", "count", "credits", "seconds", "bytes",
]);
const NUMBER_KEYS = new Set(["duration_ms", "active_ms", "load_ms", "lcp_ms", "cls", "count", "credits", "seconds", "bytes"]);
const ingestRates = new Map();

export function allowAnalyticsIngest(key, count) {
  const now = Date.now(), windowMs = 60_000;
  const old = ingestRates.get(key);
  const state = !old || now - old.at >= windowMs ? { at: now, count: 0 } : old;
  state.count += Math.max(1, Number(count) || 1);
  ingestRates.set(key, state);
  if (ingestRates.size > 5000) for (const [id, value] of ingestRates) if (now - value.at > windowMs * 2) ingestRates.delete(id);
  return state.count <= 240;
}

const shortToken = (value, max = 160) => {
  const text = String(value ?? "").slice(0, max);
  return TOKEN.test(text) ? text : undefined;
};
const cleanPath = (value) => {
  const path = String(value || "").split(/[?#]/)[0].slice(0, 240);
  return path.startsWith("/") ? path.replace(/\/(prj|ast|qt|job)_[\w-]+/g, "/$1_:id") : undefined;
};
const cleanProps = (value) => {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, raw] of Object.entries(value)) {
    if (!PROPERTY_KEYS.has(key)) continue;
    if (NUMBER_KEYS.has(key)) {
      const n = Number(raw);
      if (Number.isFinite(n)) out[key] = Math.max(-1e9, Math.min(1e9, n));
    } else if (typeof raw === "boolean") out[key] = raw;
    else {
      const token = shortToken(raw);
      if (token !== undefined) out[key] = token;
    }
  }
  return out;
};

export function cleanAnalyticsEvent(raw, accountId = null, now = Date.now()) {
  if (!raw || !EVENT.test(String(raw.name || ""))) return null;
  const occurred = new Date(raw.occurred_at || now);
  if (!Number.isFinite(+occurred) || Math.abs(+occurred - now) > 7 * 86400_000) return null;
  const anonymous = shortToken(raw.anonymous_id, 100);
  const session = shortToken(raw.session_id, 100);
  return {
    event_id: shortToken(raw.event_id, 120) || id("evt"),
    account_id: accountId || null,
    anonymous_id: anonymous || null,
    session_id: session || null,
    name: String(raw.name),
    source: "web",
    path: cleanPath(raw.path) || null,
    project_id: /^prj_\w+$/.test(String(raw.project_id || "")) ? String(raw.project_id) : null,
    properties: cleanProps(raw.properties),
    occurred_at: occurred.toISOString(),
  };
}

export async function ingestAnalytics(account, body) {
  const incoming = Array.isArray(body?.events) ? body.events.slice(0, 40) : [];
  const events = incoming.map((event) => cleanAnalyticsEvent(event, account?.id)).filter(Boolean);
  if (!events.length) return { accepted: 0 };
  const values = [], params = [];
  for (const event of events) {
    const base = params.length;
    params.push(event.event_id, event.account_id, event.anonymous_id, event.session_id, event.name, event.source, event.path, event.project_id, event.properties, event.occurred_at);
    values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10})`);
  }
  await q(
    `insert into studio.analytics_events(event_id,account_id,anonymous_id,session_id,name,source,path,project_id,properties,occurred_at)
     values ${values.join(",")} on conflict (event_id) do nothing`,
    params,
  );
  // Amortized retention cleanup; deterministic enough to avoid running on every batch.
  if (events[0].event_id.charCodeAt(events[0].event_id.length - 1) % 50 === 0)
    q("delete from studio.analytics_events where received_at < now() - interval '180 days'").catch(() => {});
  return { accepted: events.length };
}

export async function trackServerEvent(name, { accountId = null, projectId = null, source = "server", properties = {}, eventId = null } = {}) {
  if (!EVENT.test(name) || !["server", "agent", "worker", "billing"].includes(source)) return;
  await q(
    `insert into studio.analytics_events(event_id,account_id,name,source,project_id,properties,occurred_at)
     values ($1,$2,$3,$4,$5,$6,now()) on conflict (event_id) do nothing`,
    [eventId || id("evt"), accountId, name, source, /^prj_\w+$/.test(String(projectId || "")) ? projectId : null, cleanProps(properties)],
  );
}

const n = (value) => Number(value || 0);
const pct = (top, bottom) => bottom ? +(100 * top / bottom).toFixed(1) : 0;
const dayKey = (value) => new Date(value).toISOString().slice(0, 10);

export async function analyticsDashboard(days = 30) {
  days = [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
  const interval = `${days - 1} days`;
  const from = `${days} days`;
  const [totals, active, signups, activeDays, projects, jobs, turns, spend, funnel, guestFunnel, modelRows, agentRows, jobRows, featureRows, errors, retention, acquisition] = await Promise.all([
    one(`select
      (select count(*)::int from studio.accounts) accounts_total,
      (select count(*)::int from studio.accounts where created_at >= now()-$1::interval) accounts_new,
      (select count(*)::int from studio.projects where deleted_at is null) projects_total,
      (select count(*)::int from studio.subscriptions where status in ('active','trialing','past_due')) active_subscriptions,
      (select count(distinct account_id)::int from studio.credits where kind in ('purchase','subscription') and amount_usd>0) paying_accounts,
      (select coalesce(sum(case
        when kind='purchase' then coalesce(nullif(substring(note from '\\$([0-9.]+)'), '')::numeric, amount_usd)
        when kind='subscription' and note like 'creator %' then 15
        when kind='subscription' and note like 'filmmaker %' then 39
        when kind='subscription' and note like 'studio %' then 99 else 0 end),0)::float
        from studio.credits where created_at >= now()-$1::interval and amount_usd>0) revenue_usd`, [from]),
    one(`with activity as (
      select account_id, occurred_at at from studio.analytics_events where account_id is not null and occurred_at>=now()-$1::interval
      union all select account_id, started_at from studio.agent_turns where started_at>=now()-$1::interval
      union all select account_id, created_at from studio.jobs where created_at>=now()-$1::interval
      union all select account_id, updated_at from studio.projects where updated_at>=now()-$1::interval)
      select count(distinct account_id)::int users, count(distinct account_id) filter(where at>=now()-interval '1 day')::int dau,
      count(distinct account_id) filter(where at>=now()-interval '7 days')::int wau from activity`, [from]),
    q("select created_at::date as event_day,count(*)::int as value from studio.accounts where created_at>=current_date-$1::interval group by 1", [interval]),
    q(`with activity as (
      select account_id,occurred_at at from studio.analytics_events where account_id is not null and occurred_at>=current_date-$1::interval
      union all select account_id,updated_at from studio.projects where updated_at>=current_date-$1::interval
      union all select account_id,started_at from studio.agent_turns where started_at>=current_date-$1::interval
      union all select account_id,created_at from studio.jobs where created_at>=current_date-$1::interval)
      select at::date as event_day,count(distinct account_id)::int as value from activity group by 1`, [interval]),
    q("select created_at::date as event_day,count(*)::int as value from studio.projects where created_at>=current_date-$1::interval group by 1", [interval]),
    q("select created_at::date as event_day,count(*) filter(where kind='generate')::int as generations,count(*) filter(where kind='generate' and status='succeeded')::int as succeeded,count(*) filter(where kind='generate' and status='failed')::int as failed,count(*) filter(where kind='render' and status='succeeded')::int as exports from studio.jobs where created_at>=current_date-$1::interval group by 1", [interval]),
    q("select started_at::date as event_day,count(*)::int as value from studio.agent_turns where started_at>=current_date-$1::interval group by 1", [interval]),
    q(`with x as (
      select created_at::date as event_day, sum(case when kind='hold' then amount_usd when kind='release' then -amount_usd else 0 end)*100 as credits from studio.ledger where created_at>=current_date-$1::interval group by 1
      union all select at::date as event_day, sum(cost_micros)::numeric/1000000*$2*100 as credits from studio.agent_usage where at>=current_date-$1::interval group by 1)
      select event_day,coalesce(sum(credits),0)::float as value from x group by event_day`, [interval, config.markup]),
    one(`with cohort as (select id from studio.accounts where created_at>=now()-$1::interval)
      select count(*)::int signed_up,
      count(*) filter(where exists(select 1 from studio.projects p where p.account_id=c.id))::int made_project,
      count(*) filter(where exists(select 1 from studio.agent_turns t where t.account_id=c.id))::int used_agent,
      count(*) filter(where exists(select 1 from studio.quotes qt where qt.account_id=c.id))::int quoted,
      count(*) filter(where exists(select 1 from studio.jobs j where j.account_id=c.id and j.kind='generate'))::int generated,
      count(*) filter(where exists(select 1 from studio.jobs j where j.account_id=c.id and j.kind='render' and j.status='succeeded'))::int exported,
      count(*) filter(where exists(select 1 from studio.credits cr where cr.account_id=c.id and cr.kind in ('purchase','subscription') and cr.amount_usd>0))::int paid
      from cohort c`, [from]),
    one(`with people as (
      select anonymous_id,
        bool_or(name='page_view' and path='/' and not coalesce((properties->>'signed_in')::boolean,false)) landed,
        bool_or(name in ('guest_prompt_submitted','guest_upload_started')) submitted,
        bool_or(name='auth_gate_opened' and properties->>'mode' in ('prompt','upload')) opened_auth,
        bool_or(name='auth_provider_selected' and properties->>'mode' in ('prompt','upload')) chose_provider,
        bool_or(name in ('signed_up','signed_in')) completed_auth,
        bool_or(name in ('guest_project_started','guest_upload_project_started')) started_project,
        bool_or(name='auth_returned_unsigned') returned_unsigned
      from studio.analytics_events where occurred_at>=now()-$1::interval and anonymous_id is not null group by anonymous_id)
      select count(*) filter(where landed)::int landed,
        count(*) filter(where submitted)::int submitted,
        count(*) filter(where opened_auth)::int opened_auth,
        count(*) filter(where chose_provider)::int chose_provider,
        count(*) filter(where submitted and completed_auth)::int completed_auth,
        count(*) filter(where submitted and started_project)::int started_project,
        count(*) filter(where returned_unsigned)::int returned_unsigned
      from people`, [from]),
    q(`select qt.model,count(*)::int runs,count(*) filter(where j.status='succeeded')::int succeeded,count(*) filter(where j.status='failed')::int failed,
      coalesce(avg(extract(epoch from (j.updated_at-j.created_at))) filter(where j.status in ('succeeded','failed')),0)::float avg_seconds,
      coalesce(sum(case when j.status='succeeded' then qt.cost_usd/greatest(1,coalesce(nullif(j.input->>'takes','')::numeric,1)) else 0 end),0)::float cost_usd
      from studio.jobs j join studio.quotes qt on qt.id=j.input->>'quote_id'
      where j.kind='generate' and j.created_at>=now()-$1::interval group by qt.model order by runs desc`, [from]),
    q(`select model,count(*)::int calls,count(*) filter(where status>=400)::int errors,
      coalesce(sum(input_tokens),0)::bigint input_tokens,coalesce(sum(cached_tokens),0)::bigint cached_tokens,
      coalesce(sum(output_tokens),0)::bigint output_tokens,coalesce(sum(cost_micros),0)::bigint cost_micros,
      coalesce(avg(seconds),0)::float avg_seconds from studio.agent_usage where at>=now()-$1::interval group by model order by calls desc`, [from]),
    q(`select kind,count(*)::int runs,count(*) filter(where status='succeeded')::int succeeded,count(*) filter(where status='failed')::int failed,
      coalesce(avg(extract(epoch from (updated_at-created_at))) filter(where status in ('succeeded','failed')),0)::float avg_seconds
      from studio.jobs where created_at>=now()-$1::interval group by kind order by runs desc`, [from]),
    q(`select name,count(*)::int events,count(distinct coalesce(account_id::text,anonymous_id))::int users
      from studio.analytics_events where occurred_at>=now()-$1::interval group by name order by events desc limit 30`, [from]),
    q(`select id,kind,status,project_id,error->>'message' message,created_at,updated_at from studio.jobs
      where status='failed' and created_at>=now()-$1::interval order by updated_at desc limit 30`, [from]),
    q(`with cohort as (select id,created_at,date_trunc('week',created_at)::date week from studio.accounts where created_at>=now()-interval '12 weeks'),
      activity as (select account_id,occurred_at at from studio.analytics_events where account_id is not null union all select account_id,started_at from studio.agent_turns union all select account_id,created_at from studio.jobs)
      select week,count(*)::int users,
      count(*) filter(where exists(select 1 from activity x where x.account_id=c.id and x.at>=c.created_at+interval '1 day' and x.at<c.created_at+interval '2 days'))::int d1,
      count(*) filter(where exists(select 1 from activity x where x.account_id=c.id and x.at>=c.created_at+interval '7 days' and x.at<c.created_at+interval '9 days'))::int d7,
      count(*) filter(where exists(select 1 from activity x where x.account_id=c.id and x.at>=c.created_at+interval '30 days' and x.at<c.created_at+interval '33 days'))::int d30
      from cohort c group by week order by week desc`, []),
    q(`select coalesce(properties->>'source','direct') source,coalesce(properties->>'campaign','—') campaign,
      count(distinct session_id)::int sessions,count(distinct account_id)::int accounts
      from studio.analytics_events where name in ('session_started','page_view') and occurred_at>=now()-$1::interval
      group by 1,2 order by sessions desc limit 20`, [from]),
  ]);

  const maps = (rows) => new Map(rows.map((row) => [dayKey(row.event_day), row]));
  const sm = maps(signups), am = maps(activeDays), pm = maps(projects), jm = maps(jobs), tm = maps(turns), cm = maps(spend);
  const series = Array.from({ length: days }, (_, index) => {
    const day = new Date(); day.setUTCHours(0, 0, 0, 0); day.setUTCDate(day.getUTCDate() - (days - 1 - index));
    const key = dayKey(day);
    return { day: key, signups: n(sm.get(key)?.value), activeUsers: n(am.get(key)?.value), projects: n(pm.get(key)?.value), generations: n(jm.get(key)?.generations), succeededGenerations: n(jm.get(key)?.succeeded), failedGenerations: n(jm.get(key)?.failed), exports: n(jm.get(key)?.exports), agentTurns: n(tm.get(key)?.value), creditsSpent: Math.round(n(cm.get(key)?.value)) };
  });
  const f = funnel || {};
  const funnelSteps = [["Signed up", f.signed_up], ["Made a project", f.made_project], ["Used Hermes", f.used_agent], ["Requested generation", f.quoted], ["Generated media", f.generated], ["Exported", f.exported], ["Paid", f.paid]].map(([label, users]) => ({ label, users: n(users), rate: pct(n(users), n(f.signed_up)) }));
  const g = guestFunnel || {};
  const guestFunnelSteps = [["Visited landing page", g.landed], ["Submitted a prompt", g.submitted], ["Opened sign-in", g.opened_auth], ["Chose a provider", g.chose_provider], ["Completed sign-in", g.completed_auth], ["Project started", g.started_project]].map(([label, users]) => ({ label, users: n(users), rate: pct(n(users), n(g.landed)) }));
  return {
    range: { days, from: series[0]?.day, to: series.at(-1)?.day },
    overview: { ...totals, active_users: n(active?.users), dau: n(active?.dau), wau: n(active?.wau), sessions: featureRows.find((x) => x.name === "session_started")?.events || 0,
      generations: series.reduce((sum, x) => sum + x.generations, 0), generation_successes: series.reduce((sum, x) => sum + x.succeededGenerations, 0), generation_failures: series.reduce((sum, x) => sum + x.failedGenerations, 0), agent_turns: series.reduce((sum, x) => sum + x.agentTurns, 0), credits_spent: series.reduce((sum, x) => sum + x.creditsSpent, 0) },
    series, funnel: funnelSteps, guestFunnel: guestFunnelSteps, authReturnsUnsigned: n(g.returned_unsigned),
    models: modelRows.map((row) => ({ ...row, success_rate: pct(n(row.succeeded), n(row.succeeded) + n(row.failed)), credits: Math.ceil(n(row.cost_usd) * 100), provider_cost_usd: +(n(row.cost_usd) / config.markup).toFixed(2), gross_margin_usd: +(n(row.cost_usd) * (1 - 1 / config.markup)).toFixed(2) })),
    agentModels: agentRows.map((row) => ({ ...row, error_rate: pct(n(row.errors), n(row.calls)), cache_rate: pct(n(row.cached_tokens), n(row.input_tokens)), credits: Math.ceil(n(row.cost_micros) / 1e6 * config.markup * 100), provider_cost_usd: +(n(row.cost_micros) / 1e6).toFixed(2) })),
    reliability: jobRows.map((row) => ({ ...row, success_rate: pct(n(row.succeeded), n(row.succeeded) + n(row.failed)) })),
    events: featureRows, errors,
    retention: retention.map((row) => ({ cohort: dayKey(row.week), users: n(row.users), d1: pct(n(row.d1), n(row.users)), d7: pct(n(row.d7), n(row.users)), d30: pct(n(row.d30), n(row.users)) })),
    acquisition,
  };
}
