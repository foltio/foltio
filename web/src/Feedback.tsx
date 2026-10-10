import { useEffect, useMemo, useRef, useState } from "react";
import { api, navigate } from "./api";
import { ArrowLeft, ArrowRight, ArrowUp, Bug, Check, CheckCircle2, Clock3, Lightbulb, Loader2, MessageSquareText, Send, ShieldCheck, Sparkles, X } from "lucide-react";
import "./feedback.css";

type Kind = "feature" | "feedback" | "bug";
type Status = "new" | "reviewing" | "planned" | "building" | "shipped" | "closed";
type Priority = "normal" | "high" | "urgent";
type Message = { id: string; feedback_id: string; author_role: "user" | "support"; body: string; created_at: string };
type Request = {
  id: string;
  kind: Kind;
  title: string;
  details: string;
  context?: string | null;
  status: Status;
  priority?: Priority;
  admin_response?: string | null;
  created_at: string;
  updated_at: string;
  email?: string;
  name?: string | null;
  messages?: Message[];
};
type Update = { id: string; title: string; body: string; tag: string; published?: boolean; created_at: string };

const KIND: Record<Kind, { label: string; icon: React.ReactNode; hint: string }> = {
  feature: { label: "Feature request", icon: <Lightbulb size={14} />, hint: "Something new that would unlock your workflow" },
  feedback: { label: "Product feedback", icon: <MessageSquareText size={14} />, hint: "Something that could feel clearer or work better" },
  bug: { label: "Something’s broken", icon: <Bug size={14} />, hint: "Unexpected behavior we should fix" },
};
const STATUS: Record<Status, string> = { new: "Received", reviewing: "Reviewing", planned: "Planned", building: "Building", shipped: "Shipped", closed: "Closed" };
const since = (iso: string) => {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? `${days} days ago` : new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
};

const FEEDBACK_OPEN_EVENT = "foltio:feedback";
export const openFeedback = () => window.dispatchEvent(new Event(FEEDBACK_OPEN_EVENT));

export function FeedbackModal() {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("feature");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const show = () => { setOpen(true); setSent(false); setError(""); requestAnimationFrame(() => input.current?.focus()); };
    window.addEventListener(FEEDBACK_OPEN_EVENT, show);
    return () => window.removeEventListener(FEEDBACK_OPEN_EVENT, show);
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);
  if (!open) return null;
  const submit = async () => {
    const note = details.trim();
    if (busy || note.length < 20) return;
    setBusy(true); setError("");
    const firstThought = note.split(/\n|[.!?]\s/)[0].replace(/\s+/g, " ").trim();
    const title = (firstThought.length >= 5 ? firstThought : note.replace(/\s+/g, " ")).slice(0, 120);
    try {
      await api("/api/feedback", { kind, title, details: note, context: location.pathname });
      setDetails(""); setSent(true);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  const close = () => setOpen(false);
  return <div className="feedback-modal-back" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && close()}>
    <section className="feedback-modal" role="dialog" aria-modal="true" aria-labelledby="feedback-modal-title">
      <button className="icon feedback-modal-close" onClick={close} aria-label="Close feedback"><X size={17} /></button>
      {sent ? <div className="feedback-modal-sent">
        <span><Check size={20} /></span>
        <h2 id="feedback-modal-title">Thank you—we’ve got it.</h2>
        <p>We read every note and usually act on requests within 24 hours.</p>
        <div><button className="btn primary" onClick={close}>Done</button><button className="btn ghost" onClick={() => (close(), navigate("/feedback"))}>Requests & updates <ArrowRight size={13} /></button></div>
      </div> : <>
        <header className="feedback-modal-head">
          <span className="feedback-modal-mark"><MessageSquareText size={17} /></span>
          <div><span className="micro">Direct to the team</span><h2 id="feedback-modal-title">What should we improve?</h2></div>
        </header>
        <p className="feedback-modal-guidance">Be specific about what you were trying to do and what you wanted to happen. Most requests are handled within <strong>24 hours.</strong></p>
        <div className="feedback-modal-kinds" role="radiogroup" aria-label="Feedback type">
          {(Object.keys(KIND) as Kind[]).map((value) => <button key={value} type="button" className={kind === value ? "on" : ""} role="radio" aria-checked={kind === value} onClick={() => setKind(value)}>{KIND[value].icon}{value === "feature" ? "Feature" : value === "bug" ? "Problem" : "Feedback"}</button>)}
        </div>
        <textarea ref={input} rows={6} maxLength={5000} value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Tell us what would make FOLTIO better…" onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit(); }} />
        {error && <p className="error feedback-modal-error">{error}</p>}
        <footer className="feedback-modal-actions">
          <button className="feedback-history-link" onClick={() => (close(), navigate("/feedback"))}>Your requests & updates</button>
          <span className="feedback-modal-count num">{details.length ? `${details.length} / 5,000` : "⌘ Enter to send"}</span>
          <button className="btn primary" disabled={busy || details.trim().length < 20} onClick={submit}>{busy ? <Loader2 size={14} className="spin" /> : <Send size={14} />} Send feedback</button>
        </footer>
      </>}
    </section>
  </div>;
}

function RequestForm({ onMade }: { onMade: (r: Request) => void }) {
  const [kind, setKind] = useState<Kind>("feature");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [context, setContext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const detailsRef = useRef<HTMLTextAreaElement>(null);
  const submit = async () => {
    if (busy || title.trim().length < 5 || details.trim().length < 20) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<{ request: Request }>("/api/feedback", { kind, title, details, context });
      onMade(r.request);
      setTitle("");
      setDetails("");
      setContext("");
      setSent(true);
      setTimeout(() => setSent(false), 5000);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="fb-compose" aria-labelledby="fb-compose-title">
      <div className="fb-compose-copy">
        <span className="fb-eyebrow"><Sparkles size={12} /> Direct to the team</span>
        <h2 id="fb-compose-title">What should FOLTIO do better?</h2>
        <p>Request a feature or give feedback. Precision is genuinely helpful—tell us what you were trying to do, what happened, and what a great outcome would look like.</p>
        <div className="fb-promise"><Clock3 size={14} /><span>Most requests are reviewed and catered to within <strong>24 hours.</strong></span></div>
      </div>
      <div className="fb-form">
        <div className="fb-kinds" role="radiogroup" aria-label="Request type">
          {(Object.keys(KIND) as Kind[]).map((k) => (
            <button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)} role="radio" aria-checked={kind === k} title={KIND[k].hint}>
              {KIND[k].icon}<span>{KIND[k].label}</span>
            </button>
          ))}
        </div>
        <input className="fb-title-input" placeholder={kind === "feature" ? "A concise feature name" : kind === "bug" ? "What went wrong?" : "What could feel better?"} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && detailsRef.current?.focus()} />
        <textarea ref={detailsRef} placeholder="Share the workflow, the friction, and the outcome you want…" rows={5} value={details} maxLength={5000} onChange={(e) => setDetails(e.target.value)} />
        <div className="fb-context-row">
          <input placeholder="Where does this matter? (optional)" value={context} maxLength={300} onChange={(e) => setContext(e.target.value)} />
          <span className="fb-count num">{details.length.toLocaleString()} / 5,000</span>
          <button className="btn primary" disabled={busy || title.trim().length < 5 || details.trim().length < 20} onClick={submit}>
            {busy ? <Loader2 size={14} className="spin" /> : sent ? <Check size={14} /> : <ArrowUp size={14} />}
            {sent ? "Sent" : "Send request"}
          </button>
        </div>
        {error && <p className="error fb-form-error">{error}</p>}
      </div>
    </section>
  );
}

function Updates({ updates }: { updates: Update[] }) {
  return (
    <section className="fb-section">
      <header className="fb-section-head"><div><span className="micro">What’s new</span><h2>Product updates</h2></div><span className="fb-live"><i /> Updated often</span></header>
      <div className="fb-updates">
        {updates.map((u, i) => (
          <article className="fb-update" key={u.id}>
            <div className="fb-update-mark"><span>{i === 0 ? <Sparkles size={13} /> : <Check size={13} />}</span><i /></div>
            <div><div className="fb-update-meta"><span>{u.tag}</span><time>{since(u.created_at)}</time></div><h3>{u.title}</h3><p>{u.body}</p></div>
          </article>
        ))}
        {!updates.length && <p className="muted">The update log will appear here.</p>}
      </div>
    </section>
  );
}

function Conversation({ request, admin = false, onMessage }: { request: Request; admin?: boolean; onMessage: (message: Message, status?: Status) => void }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const send = async () => {
    if (busy || body.trim().length < 2) return;
    setBusy(true); setError("");
    try {
      const path = admin ? `/api/admin/feedback/${request.id}/messages` : `/api/feedback/${request.id}/messages`;
      const result = await api<{ message: Message; status?: Status }>(path, { body });
      onMessage(result.message, result.status);
      setBody("");
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  return <div className={`fb-conversation ${admin ? "admin" : ""}`}>
    {!!request.messages?.length && <div className="fb-thread">
      {request.messages.map((message) => <div className={`fb-message ${message.author_role}`} key={message.id}>
        <div><span>{message.author_role === "support" ? <><ShieldCheck size={12} /> FOLTIO support</> : admin ? "Filmmaker" : "You"}</span><time>{since(message.created_at)}</time></div>
        <p>{message.body}</p>
      </div>)}
    </div>}
    <div className="fb-followup">
      <textarea rows={admin ? 3 : 2} maxLength={5000} value={body} onChange={(e) => setBody(e.target.value)} placeholder={admin ? "Reply with an answer, question, or progress update…" : "Add context or reply to support…"} />
      <button className="btn primary" disabled={busy || body.trim().length < 2} onClick={send}>{busy ? <Loader2 size={13} className="spin" /> : <Send size={13} />}{admin ? "Send reply" : "Send"}</button>
    </div>
    {error && <span className="error small">{error}</span>}
  </div>;
}

function MyRequests({ requests, onMessage }: { requests: Request[]; onMessage: (id: string, message: Message) => void }) {
  return (
    <section className="fb-section">
      <header className="fb-section-head"><div><span className="micro">Your line to us</span><h2>Your requests</h2></div><span className="num muted">{requests.length}</span></header>
      <div className="fb-request-list">
        {requests.map((r) => (
          <article className="fb-request" key={r.id}>
            <div className="fb-request-top"><span className={`fb-status ${r.status}`}><i />{STATUS[r.status]}</span><time>{since(r.created_at)}</time></div>
            <h3>{r.title}</h3>
            <p>{r.details}</p>
            {r.context && <span className="fb-context">Where: {r.context}</span>}
            <Conversation request={r} onMessage={(message) => onMessage(r.id, message)} />
          </article>
        ))}
        {!requests.length && <div className="fb-empty"><MessageSquareText size={20} /><p>Your requests and our replies will stay here.</p></div>}
      </div>
    </section>
  );
}

export function FeedbackPage() {
  const [data, setData] = useState<{ updates: Update[]; requests: Request[]; admin: boolean } | null>(null);
  const [error, setError] = useState("");
  const load = () => api<{ updates: Update[]; requests: Request[]; admin: boolean }>("/api/feedback").then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  return (
    <div className="fb-page">
      <header className="fb-hero"><div><span className="fb-eyebrow">FOLTIO · shaped with filmmakers</span><h1>Help make the studio<br />fit the way you work.</h1><p>Small friction, ambitious feature, honest reaction—we read all of it.</p></div>{data?.admin && <button className="btn" onClick={() => navigate("/feedback/admin")}><ShieldCheck size={14} /> Open admin desk</button>}</header>
      <RequestForm onMade={(request) => setData((d) => d ? { ...d, requests: [request, ...d.requests] } : d)} />
      {error && <p className="error">{error}</p>}
      {!data && !error && <div className="fb-loading"><Loader2 className="spin" size={17} /> Loading the feedback desk…</div>}
      {data && <div className="fb-columns"><Updates updates={data.updates} /><MyRequests requests={data.requests} onMessage={(id, message) => setData((d) => d ? { ...d, requests: d.requests.map((request) => request.id === id ? { ...request, messages: [...(request.messages || []), message] } : request) } : d)} /></div>}
    </div>
  );
}

function AdminRequest({ request, onSaved }: { request: Request; onSaved: (r: Partial<Request>) => void }) {
  const [status, setStatus] = useState<Status>(request.status);
  const [priority, setPriority] = useState<Priority>(request.priority || "normal");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const changed = status !== request.status || priority !== request.priority;
  const save = async () => {
    setBusy(true);
    try {
      const r = await api<{ request: Partial<Request> }>(`/api/admin/feedback/${request.id}`, { status, priority, admin_response: request.admin_response || "" });
      onSaved(r.request);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } finally { setBusy(false); }
  };
  return (
    <article className={`fba-card priority-${priority}`}>
      <header><div><span className="fba-person">{request.name || request.email}</span>{request.name && <span className="muted">{request.email}</span>}</div><time>{since(request.created_at)}</time></header>
      <div className="fba-meta"><span className={`fb-kind ${request.kind}`}>{KIND[request.kind].icon}{KIND[request.kind].label}</span>{request.context && <span className="fb-context">{request.context}</span>}</div>
      <h3>{request.title}</h3><p className="fba-details">{request.details}</p>
      <Conversation admin request={request} onMessage={(message, nextStatus) => { if (nextStatus) setStatus(nextStatus); onSaved({ status: nextStatus || request.status, messages: [...(request.messages || []), message] }); }} />
      <div className="fba-controls">
        <label><span>Status</span><select value={status} onChange={(e) => setStatus(e.target.value as Status)}>{(Object.keys(STATUS) as Status[]).map((s) => <option value={s} key={s}>{STATUS[s]}</option>)}</select></label>
        <label><span>Priority</span><select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>
      </div>
      <div className="fba-save"><span className="muted small">Status and priority are private.</span><button className="btn" onClick={save} disabled={busy || (!changed && !saved)}>{busy ? <Loader2 size={13} className="spin" /> : saved ? <Check size={13} /> : null}{saved ? "Saved" : "Save triage"}</button></div>
    </article>
  );
}

function PublishUpdate({ onMade }: { onMade: (u: Update) => void }) {
  const [title, setTitle] = useState(""); const [body, setBody] = useState(""); const [tag, setTag] = useState("Update"); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const publish = async () => {
    setBusy(true); setError("");
    try { const r = await api<{ update: Update }>("/api/admin/updates", { title, body, tag }); onMade(r.update); setTitle(""); setBody(""); setTag("Update"); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return <section className="fba-publish"><div><span className="micro">Changelog</span><h2>Publish an update</h2><p>Close the loop when something ships. Everyone signed in sees this in Feedback.</p></div><div className="fba-publish-form"><div><input placeholder="Update title" value={title} onChange={(e) => setTitle(e.target.value)} /><input className="fba-tag" placeholder="Tag" value={tag} onChange={(e) => setTag(e.target.value)} /></div><textarea rows={3} placeholder="What changed, and why it matters…" value={body} onChange={(e) => setBody(e.target.value)} /><div>{error && <span className="error small">{error}</span>}<span className="grow" /><button className="btn primary" disabled={busy || title.trim().length < 4 || body.trim().length < 12} onClick={publish}>{busy ? <Loader2 size={13} className="spin" /> : <Send size={13} />} Publish</button></div></div></section>;
}

export function FeedbackAdminPage() {
  const [data, setData] = useState<{ requests: Request[]; updates: Update[] } | null>(null);
  const [filter, setFilter] = useState<Status | "all">("all");
  const [error, setError] = useState("");
  useEffect(() => { api<{ requests: Request[]; updates: Update[] }>("/api/admin/feedback").then(setData).catch((e) => setError(e.message)); }, []);
  const shown = useMemo(() => (data?.requests || []).filter((r) => filter === "all" || r.status === filter), [data, filter]);
  const counts = useMemo(() => Object.fromEntries((Object.keys(STATUS) as Status[]).map((s) => [s, (data?.requests || []).filter((r) => r.status === s).length])), [data]);
  return <div className="fba-page"><header className="fba-head"><button className="icon" title="Back to feedback" onClick={() => navigate("/feedback")}><ArrowLeft size={17} /></button><div><span className="micro">Admin workspace</span><h1>Feedback desk</h1><p>Triage requests, reply with context, and close the loop publicly.</p></div></header>{error && <div className="fba-denied"><ShieldCheck size={24} /><h2>Feedback desk unavailable</h2><p>{error}</p></div>}{data && <><PublishUpdate onMade={(u) => setData((d) => d ? { ...d, updates: [u, ...d.updates] } : d)} /><div className="fba-stats"><div><strong>{data.requests.length}</strong><span>Total</span></div><div><strong>{counts.new || 0}</strong><span>New</span></div><div><strong>{(counts.planned || 0) + (counts.building || 0)}</strong><span>In motion</span></div><div><strong>{counts.shipped || 0}</strong><span>Shipped</span></div></div><nav className="fba-filters"><button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>All <span>{data.requests.length}</span></button>{(Object.keys(STATUS) as Status[]).map((s) => <button key={s} className={filter === s ? "on" : ""} onClick={() => setFilter(s)}>{STATUS[s]} <span>{counts[s] || 0}</span></button>)}</nav><main className="fba-grid">{shown.map((r) => <AdminRequest key={r.id} request={r} onSaved={(patch) => setData((d) => d ? { ...d, requests: d.requests.map((x) => x.id === r.id ? { ...x, ...patch } : x) } : d)} />)}{!shown.length && <div className="fb-empty"><CheckCircle2 size={20} /><p>Nothing in this queue.</p></div>}</main></>}</div>;
}
