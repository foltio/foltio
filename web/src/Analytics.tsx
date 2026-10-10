import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { Activity, AlertTriangle, Bot, CircleDollarSign, Clock3, Film, Loader2, RefreshCw, Sparkles, Users } from "lucide-react";
import "./analytics.css";

type Series = { day: string; signups: number; activeUsers: number; projects: number; generations: number; succeededGenerations: number; failedGenerations: number; exports: number; agentTurns: number; creditsSpent: number };
type Dashboard = {
  range: { days: number; from: string; to: string };
  overview: Record<string, number>;
  series: Series[];
  funnel: { label: string; users: number; rate: number }[];
  guestFunnel: { label: string; users: number; rate: number }[];
  authReturnsUnsigned: number;
  models: { model: string; runs: number; succeeded: number; failed: number; avg_seconds: number; credits: number; success_rate: number; provider_cost_usd: number; gross_margin_usd: number }[];
  agentModels: { model: string; calls: number; errors: number; input_tokens: number; cached_tokens: number; output_tokens: number; avg_seconds: number; credits: number; error_rate: number; cache_rate: number; provider_cost_usd: number }[];
  reliability: { kind: string; runs: number; succeeded: number; failed: number; avg_seconds: number; success_rate: number }[];
  events: { name: string; events: number; users: number }[];
  errors: { id: string; kind: string; project_id?: string; message?: string; updated_at: string }[];
  retention: { cohort: string; users: number; d1: number; d7: number; d30: number }[];
  acquisition: { source: string; campaign: string; sessions: number; accounts: number }[];
};

const integer = (value: number) => Math.round(Number(value || 0)).toLocaleString();
const money = (value: number) => `$${Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const seconds = (value: number) => value < 60 ? `${Number(value || 0).toFixed(1)}s` : `${(value / 60).toFixed(1)}m`;
const percent = (value: number) => `${Number(value || 0).toFixed(1)}%`;
const shortDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const nice = (value: string) => value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

function Metric({ icon, label, value, note, tone = "" }: { icon: React.ReactNode; label: string; value: string; note: string; tone?: string }) {
  return <div className={`an-metric ${tone}`}><div className="an-metric-icon">{icon}</div><span>{label}</span><strong>{value}</strong><small>{note}</small></div>;
}

function ActivityChart({ rows }: { rows: Series[] }) {
  const max = Math.max(1, ...rows.flatMap((row) => [row.activeUsers, row.generations, row.agentTurns]));
  return <div className="an-chart-wrap"><div className="an-chart">
    {rows.map((row, index) => <div className="an-day" key={row.day} title={`${shortDay(row.day)} · ${row.activeUsers} active · ${row.generations} generations · ${row.agentTurns} Hermes turns`}>
      <div className="an-bars"><i className="active" style={{ height: `${Math.max(2, row.activeUsers / max * 100)}%` }} /><i className="gen" style={{ height: `${Math.max(2, row.generations / max * 100)}%` }} /><i className="agent" style={{ height: `${Math.max(2, row.agentTurns / max * 100)}%` }} /></div>
      {(rows.length <= 30 || index % Math.ceil(rows.length / 15) === 0) && <span>{new Date(`${row.day}T00:00:00Z`).getUTCDate()}</span>}
    </div>)}
  </div></div>;
}

function Panel({ title, subtitle, children, className = "" }: { title: string; subtitle?: string; children: React.ReactNode; className?: string }) {
  return <section className={`an-panel ${className}`}><header><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div></header>{children}</section>;
}

export function AnalyticsPage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = () => {
    setLoading(true); setError("");
    api<Dashboard>(`/api/admin/analytics?days=${days}`).then(setData).catch((e) => setError(e.message)).finally(() => setLoading(false));
  };
  useEffect(load, [days]);
  const o = data?.overview || {};
  const terminalGenerations = Number(o.generation_successes || 0) + Number(o.generation_failures || 0);
  const success = terminalGenerations ? 100 * Number(o.generation_successes || 0) / terminalGenerations : 0;
  const totalCredits = data?.series.reduce((sum, row) => sum + row.creditsSpent, 0) || 0;
  const daily = useMemo(() => data ? data.series.reduce((sum, row) => sum + row.activeUsers, 0) / data.series.length : 0, [data]);
  if (error && !data) return <div className="an-page"><div className="an-denied"><AlertTriangle size={25} /><h2>Analytics unavailable</h2><p>{error}</p></div></div>;
  return <div className="an-page">
    <header className="an-head"><div><span className="micro">First-party product intelligence</span><h1>Platform analytics</h1><p>Acquisition, activation, creation, model economics, retention and reliability—from source-of-truth data.</p></div><div className="an-head-actions"><div className="seg small">{[7, 30, 90].map((value) => <button className={days === value ? "on" : ""} key={value} onClick={() => setDays(value)}>{value}d</button>)}</div><button className="btn small" onClick={load} disabled={loading}>{loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Refresh</button></div></header>
    {error && <p className="error">{error}</p>}
    {!data ? <div className="an-loading"><Loader2 className="spin" size={18} /> Building the picture…</div> : <>
      <div className="an-metrics">
        <Metric icon={<Users size={16} />} label="Active people" value={integer(o.active_users)} note={`${integer(o.dau)} today · ${integer(o.wau)} this week`} />
        <Metric icon={<Activity size={16} />} label="Average DAU" value={daily.toFixed(1)} note={`${integer(o.sessions)} sessions · ${integer(o.accounts_new)} new accounts`} />
        <Metric icon={<Sparkles size={16} />} label="Generations" value={integer(o.generations)} note={`${percent(success)} successful`} tone={success < 90 && o.generations ? "warn" : "good"} />
        <Metric icon={<Bot size={16} />} label="Hermes turns" value={integer(o.agent_turns)} note={`${integer(o.projects_total)} projects all-time`} />
        <Metric icon={<CircleDollarSign size={16} />} label="Recognized revenue" value={money(o.revenue_usd)} note={`${integer(o.active_subscriptions)} active plans`} tone="money" />
        <Metric icon={<Film size={16} />} label="Credits spent" value={integer(totalCredits)} note={`${integer(o.paying_accounts)} paying accounts all-time`} />
      </div>

      <Panel title="Product activity" subtitle={`${shortDay(data.range.from)}–${shortDay(data.range.to)} · UTC`}>
        <div className="an-legend"><span><i className="active" /> Active people</span><span><i className="gen" /> Generations</span><span><i className="agent" /> Hermes turns</span></div>
        <ActivityChart rows={data.series} />
      </Panel>

      <Panel title="Landing conversion" subtitle={`Prompt to project · ${integer(data.authReturnsUnsigned)} returned from sign-in still unsigned`}>
        <div className="an-funnel an-funnel-horizontal">{data.guestFunnel.map((step, index) => <div key={step.label}><span>{index + 1}</span><div><strong>{step.label}</strong><small>{integer(step.users)} people</small></div><b>{percent(step.rate)}</b><i style={{ width: `${step.rate}%` }} /></div>)}</div>
      </Panel>

      <div className="an-grid two">
        <Panel title="New-account activation" subtitle="What accounts created in this period went on to do">
          <div className="an-funnel">{data.funnel.map((step, index) => <div key={step.label}><span>{index + 1}</span><div><strong>{step.label}</strong><small>{integer(step.users)} people</small></div><b>{percent(step.rate)}</b><i style={{ width: `${step.rate}%` }} /></div>)}</div>
        </Panel>
        <Panel title="Retention by signup week" subtitle="Returned and did meaningful work after signup">
          <div className="an-table-scroll"><table className="an-table"><thead><tr><th>Cohort</th><th>People</th><th>D1</th><th>D7</th><th>D30</th></tr></thead><tbody>{data.retention.map((row) => <tr key={row.cohort}><td>{shortDay(row.cohort)}</td><td>{integer(row.users)}</td><td>{percent(row.d1)}</td><td>{percent(row.d7)}</td><td>{percent(row.d30)}</td></tr>)}</tbody></table></div>
        </Panel>
      </div>

      <Panel title="Generation model economics" subtitle="Each paid generation job, including failures and time to terminal state">
        <div className="an-table-scroll"><table className="an-table wide"><thead><tr><th>Model</th><th>Runs</th><th>Success</th><th>Failed</th><th>Avg time</th><th>Provider cost</th><th>Credits billed</th><th>Gross margin</th></tr></thead><tbody>{data.models.map((row) => <tr key={row.model}><td><strong>{row.model}</strong></td><td>{integer(row.runs)}</td><td><span className={row.success_rate < 90 ? "an-bad" : "an-good"}>{percent(row.success_rate)}</span></td><td>{integer(row.failed)}</td><td>{seconds(row.avg_seconds)}</td><td>{money(row.provider_cost_usd)}</td><td>{integer(row.credits)}</td><td>{money(row.gross_margin_usd)}</td></tr>)}{!data.models.length && <tr><td colSpan={8} className="muted">No generations in this period.</td></tr>}</tbody></table></div>
      </Panel>

      <div className="an-grid two">
        <Panel title="Hermes model usage" subtitle="OpenRouter usage, cache effectiveness, latency and customer credits">
          <div className="an-table-scroll"><table className="an-table"><thead><tr><th>Model</th><th>Calls</th><th>Cache</th><th>Errors</th><th>Credits</th></tr></thead><tbody>{data.agentModels.map((row) => <tr key={row.model}><td><strong>{row.model.replace(/^.*\//, "")}</strong></td><td>{integer(row.calls)}</td><td>{percent(row.cache_rate)}</td><td className={row.error_rate ? "an-bad" : ""}>{percent(row.error_rate)}</td><td>{integer(row.credits)}</td></tr>)}</tbody></table></div>
        </Panel>
        <Panel title="Job reliability" subtitle="All media, generation and export workers">
          <div className="an-table-scroll"><table className="an-table"><thead><tr><th>Job</th><th>Runs</th><th>Success</th><th>Failed</th><th>Avg</th></tr></thead><tbody>{data.reliability.map((row) => <tr key={row.kind}><td><strong>{nice(row.kind)}</strong></td><td>{integer(row.runs)}</td><td><span className={row.success_rate < 90 ? "an-bad" : "an-good"}>{percent(row.success_rate)}</span></td><td>{integer(row.failed)}</td><td>{seconds(row.avg_seconds)}</td></tr>)}</tbody></table></div>
        </Panel>
      </div>

      <div className="an-grid two">
        <Panel title="Acquisition" subtitle="First-party sessions by UTM or referring domain">
          <div className="an-table-scroll"><table className="an-table"><thead><tr><th>Source</th><th>Campaign</th><th>Sessions</th><th>Accounts</th></tr></thead><tbody>{data.acquisition.map((row, index) => <tr key={`${row.source}-${row.campaign}-${index}`}><td><strong>{row.source}</strong></td><td>{row.campaign}</td><td>{integer(row.sessions)}</td><td>{integer(row.accounts)}</td></tr>)}{!data.acquisition.length && <tr><td colSpan={4} className="muted">Collection starts with this release.</td></tr>}</tbody></table></div>
        </Panel>
        <Panel title="Behavioral events" subtitle="Privacy-safe actions—never prompts, chats, filenames or media URLs">
          <div className="an-event-list">{data.events.slice(0, 14).map((row) => <div key={row.name}><span>{nice(row.name)}</span><strong>{integer(row.events)}</strong><small>{integer(row.users)} people</small></div>)}{!data.events.length && <p className="muted small">Collection starts with this release.</p>}</div>
        </Panel>
      </div>

      <Panel title="Recent failures" subtitle="Latest worker failures for diagnosis; creative prompts and user content are not collected">
        <div className="an-errors">{data.errors.map((row) => <div key={row.id}><AlertTriangle size={14} /><span><strong>{nice(row.kind)}</strong><small>{row.project_id || "No project"} · {new Date(row.updated_at).toLocaleString()}</small></span><p>{row.message || "No error detail"}</p></div>)}{!data.errors.length && <div className="an-clear"><Clock3 size={16} /> No worker failures in this period.</div>}</div>
      </Panel>
    </>}
  </div>;
}
