import { useEffect, useState } from "react";
import { api, navigate } from "./api";
import { ArrowRight, Check, Loader2, Sparkles, X } from "lucide-react";
import { creditCount } from "./credits";

// A generation above the auto-approve limit, waiting for the person: what it makes, what it costs,
// what's left after.
export function Approve({ quoteId }: { quoteId: string }) {
  const [d, setD] = useState<any>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<"" | "approve" | "deny">("");
  useEffect(() => {
    api(`/api/quotes/${quoteId}`).then(setD).catch((e) => setMsg(e.message));
  }, [quoteId]);
  if (!d)
    return (
      <div className="pg narrow">
        <p className={msg ? "error" : "muted"}>{msg || "Loading…"}</p>
      </div>
    );
  const qt = d.quote;
  const cost = Number(qt.cost_usd);
  const bal = d.budget.balanceCredits;
  const costCredits = creditCount(cost);
  const act = async (a: "approve" | "deny") => {
    setBusy(a);
    try {
      await api(`/api/quotes/${quoteId}/${a}`, {});
      setMsg(a === "approve" ? "Approved. Your agent can run it now." : "Declined. Nothing was charged.");
      setD({ ...d, quote: { ...qt, status: a === "approve" ? "approved" : "denied" } });
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy("");
    }
  };
  const params = Object.entries(qt.request?.params || {}).filter(([, v]) => v !== null && v !== "" && typeof v !== "object");
  return (
    <div className="pg narrow">
      <div className="confirm">
        <span className="confirm-icon">
          <Sparkles size={16} />
        </span>
        <h1>Approve this generation?</h1>
        <p className="muted">Your agent wants to run something above your auto-approve limit.</p>
        <div className="confirm-what">
          <span className="micro">Model</span>
          <strong>{qt.model}</strong>
          {qt.request?.prompt && <p className="confirm-prompt">{qt.request.prompt}</p>}
          {params.length > 0 && (
            <div className="confirm-params">
              {params.map(([k, v]) => (
                <span key={k} className="pill">
                  {k} {String(v)}
                </span>
              ))}
            </div>
          )}
        </div>
        <dl className="confirm-sum">
          <div>
            <dt>Cost</dt>
            <dd className="num">{costCredits.toLocaleString()} credits</dd>
          </div>
          {bal != null && (
            <div>
              <dt>Credit after</dt>
              <dd className="num">{Math.max(0, bal - costCredits).toLocaleString()} credits</dd>
            </div>
          )}
          <div>
            <dt>Left this month</dt>
            <dd className="num">{Math.max(0, d.budget.remainingCredits - costCredits).toLocaleString()} credits</dd>
          </div>
        </dl>
        {qt.status === "needs_approval" ? (
          <div className="confirm-act">
            <button className="btn ghost large" onClick={() => act("deny")} disabled={!!busy}>
              {busy === "deny" ? <Loader2 size={14} className="spin" /> : <X size={14} />} Decline
            </button>
            <button className="btn tally large" onClick={() => act("approve")} disabled={!!busy}>
              {busy === "approve" ? <Loader2 size={15} className="spin" /> : <Check size={15} />} Approve {costCredits.toLocaleString()} credits
            </button>
          </div>
        ) : (
          <p className="confirm-done">{msg || (qt.status === "approved" || qt.status === "used" ? "Already approved." : qt.status === "denied" ? "Declined." : `Status: ${qt.status}`)}</p>
        )}
        {qt.status === "needs_approval" && msg && <p className="error small">{msg}</p>}
        {qt.project_id && (
          <a className="confirm-link" href={`/p/${qt.project_id}`} onClick={(e) => (e.preventDefault(), navigate(`/p/${qt.project_id}`))}>
            Open the project <ArrowRight size={13} />
          </a>
        )}
      </div>
    </div>
  );
}
