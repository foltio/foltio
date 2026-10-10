import { useEffect, useState } from "react";
import { api } from "./api";
import { Section } from "./Settings";
import { ArrowRight, Check, Loader2 } from "lucide-react";
import { creditCount } from "./credits";
import { useLiveBilling } from "./billing";

const n = (value: number) => Math.round(value).toLocaleString();
const usd = (cents: number) => `$${(cents / 100).toFixed(0)}`;
const KIND: Record<string, string> = { trial: "Welcome credits", purchase: "Credit top-up", subscription: "Monthly refill", refund: "Refund", grant: "Credits from us" };
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const COSTS: [string, string][] = [
  ["Standard 10-second video", "≈ 80 credits"],
  ["Draft 10-second video", "≈ 54 credits"],
  ["High-quality image", "≈ 7 credits"],
  ["A minute of voice-over", "≈ 10–15 credits"],
  ["Music track", "≈ 14 credits"],
  ["Typical Hermes task", "≈ 15–55 credits"],
];

export function BillingPage() {
  const { billing: b, error: loadError, refresh } = useLiveBilling();
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const paid = new URLSearchParams(location.search).has("paid");
  useEffect(() => {
    if (!paid) return;
    const timers = [2000, 6000].map((ms) => window.setTimeout(() => refresh().catch(() => {}), ms));
    return () => timers.forEach(clearTimeout);
  }, [paid, refresh]);
  const checkout = async (id: string) => {
    setBusy(id);
    setErr("");
    try {
      location.href = (await api<{ url: string }>("/api/billing/checkout", { pack: id })).url;
    } catch (e: any) {
      setErr(e.message);
      setBusy("");
    }
  };
  const manage = async () => {
    setBusy("manage");
    try {
      location.href = (await api<{ url: string }>("/api/billing/portal", {})).url;
    } catch (e: any) {
      setErr(e.message);
      setBusy("");
    }
  };
  if (!b) return <div className="pg">{err || loadError ? <p className="error">{err || loadError}</p> : <p className="muted">Loading…</p>}</div>;
  const rows = [
    ...b.credits.map((c) => ({ at: c.created_at, what: KIND[c.kind] || c.kind, note: c.note, amount: c.amount_credits, expires: c.expires_at })),
    ...b.usage.map((u) => ({ at: u.at, what: "Generation", note: u.note, amount: -creditCount(u.usd), expires: null })),
  ].sort((x, y) => +new Date(y.at) - +new Date(x.at));
  const current = b.subscription && ["active", "trialing", "past_due"].includes(b.subscription.status) ? b.plans.find((p) => p.id === b.subscription!.plan_id) : null;
  return (
    <div className="pg">
      <header className="pg-head">
        <h1>Credits</h1>
        <p>One balance for AI generation and Hermes. Editing, uploads and renders are free. The base price is 100 credits per $1, with small bonuses in larger refills.</p>
      </header>
      {err && <p className="error">{err}</p>}
      {paid && <p className="notice"><Check size={14} /> Thanks. Your credits arrive as soon as Stripe confirms payment, usually within seconds.</p>}

      <Section title="Balance" text={b.exempt ? undefined : "What is left, and where it went."}>
        {b.exempt ? <p className="muted">This account is not charged.</p> : (
          <div className="bal">
            <span className={`bal-num num ${b.balanceCredits < 100 ? "low" : ""}`}>{n(b.balanceCredits)} <small>credits</small></span>
            <dl className="bal-split">
              <div><dt>Added</dt><dd className="num">{n(b.creditedCredits)}</dd></div>
              <div><dt>Generation</dt><dd className="num">−{n(b.generationCredits)}</dd></div>
              <div><dt>Hermes</dt><dd className="num">−{n(b.agentCredits)}</dd></div>
            </dl>
          </div>
        )}
      </Section>

      <Section title="Monthly plans" text="A comfortable monthly refill. Each refill rolls over for three months; cancel whenever you like.">
        {current && (
          <div className="notice">
            <Check size={14} /> {current.name} is {b.subscription!.cancel_at_period_end ? "set to end" : "active"}.
            <button className="link" onClick={manage} disabled={!!busy}>{busy === "manage" ? "Opening…" : "Manage plan"}</button>
          </div>
        )}
        <div className="packs">
          {b.plans.map((p) => (
            <button key={p.id} className={`pack ${current?.id === p.id ? "on" : ""}`} onClick={() => checkout(p.id)} disabled={!b.purchases || !!busy || !!current}>
              <span className="pack-top"><span className="pack-name">{p.name}</span>{current?.id === p.id && <span className="pack-bonus">Current</span>}</span>
              <span className="pack-credit num">{n(p.credits)} credits</span>
              <span className="pack-price">{usd(p.cents)} / month · about {Math.floor(p.credits / 80)} standard clips</span>
              {busy === p.id && <Loader2 size={14} className="spin" />}
            </button>
          ))}
        </div>
        {!b.purchases && <span className="muted small">Purchases are switched off on this server.</span>}
      </Section>

      <Section title="Top up" text="For occasional or extra work. Purchased credits never expire.">
        <div className="packs">
          {b.packs.map((p) => {
            const bonus = p.credits - p.cents;
            return (
              <button key={p.id} className="pack" onClick={() => checkout(p.id)} disabled={!b.purchases || !!busy}>
                <span className="pack-top"><span className="pack-name">Top-up</span>{bonus > 0 && <span className="pack-bonus">+{n(bonus)}</span>}</span>
                <span className="pack-credit num">{n(p.credits)} credits</span>
                <span className="pack-price">{usd(p.cents)} once</span>
                {busy === p.id ? <Loader2 size={14} className="spin" /> : <ArrowRight size={14} />}
              </button>
            );
          })}
        </div>
        <dl className="costs">{COSTS.map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="num">{v}</dd></div>)}</dl>
      </Section>

      {rows.length > 0 && (
        <Section title="History">
          <table className="tbl"><tbody>{rows.map((r, i) => (
            <tr key={i}>
              <td className="muted num small tbl-date">{day(r.at)}</td>
              <td><span className="tbl-main">{r.what}</span>{r.note && r.note !== r.what && <span className="tbl-sub">{r.note}{r.expires ? ` · rolls over until ${day(r.expires)}` : ""}</span>}</td>
              <td className={`num tbl-amt ${r.amount >= 0 ? "pos" : ""}`}>{r.amount >= 0 ? "+" : "−"}{n(Math.abs(r.amount))}</td>
            </tr>
          ))}</tbody></table>
        </Section>
      )}
    </div>
  );
}
