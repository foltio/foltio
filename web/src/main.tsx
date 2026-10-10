import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Session } from "@supabase/supabase-js";
import { supabase, navigate, api, ApiError, config as appConfig } from "./api";
import { initAdMeasurement, measurePageVisit, noteSignedIn } from "./ads";
import { Projects } from "./Projects";
import { Editor } from "./Editor";
import { Settings } from "./Settings";
import { Approve } from "./Approve";
import { BillingPage } from "./Billing";
import { Legal } from "./Public";
import { GuestEditor, readGuestIdea, clearGuestIdea, clearGuestAuth } from "./Guest";
import { startProject } from "./Projects";
import { ViewPage } from "./Community";
import { FeedbackAdminPage, FeedbackModal, FeedbackPage, openFeedback } from "./Feedback";
import { AnalyticsPage } from "./Analytics";
import { FoltioBrand } from "./Brand";
import { BarChart3, Clapperboard, Plug, LogOut, Wallet, MessageSquareText } from "lucide-react";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";
import "./editor.css";
import "./mobile.css"; // last, so phone rules win (docs/mobile.md)
import { creditsShort } from "./credits";
import { applySeo, routeSeo } from "./seo";
import { useLiveBilling } from "./billing";
import { initProductAnalytics, track, trackPageView } from "./analytics";

function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return path;
}

function NotAllowed({ email, message }: { email: string; message: string }) {
  const switchAccount = async () => {
    const s = await supabase();
    await s.auth.signOut();
    await s.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + "/", queryParams: { prompt: "select_account" } } });
  };
  return (
    <div className="signin">
      <div className="signin-card">
        <FoltioBrand big />
        <p>
          You are signed in as <strong>{email}</strong>, which does not have access.
        </p>
        <p className="muted small">{message}</p>
        <button className="btn primary wide" onClick={switchAccount}>
          Use a different account
        </button>
        <button className="btn wide" onClick={async () => (await supabase()).auth.signOut()}>
          Sign out
        </button>
      </div>
    </div>
  );
}

const NAV: [string, string, React.ReactNode][] = [
  ["/", "Projects", <Clapperboard size={14} />],
  ["/settings", "Connect", <Plug size={14} />],
  ["/billing", "Billing", <Wallet size={14} />],
];

// Top-right: the credit balance (not for accounts that aren't charged) and the account menu.
function Account({ email, path, localMode = false }: { email: string; path: string; localMode?: boolean }) {
  const { billing, refresh } = useLiveBilling();
  const credit = billing?.exempt ? null : Math.max(0, billing?.balanceCredits ?? 0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { refresh().catch(() => {}); }, [path, refresh]);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc);
    return () => (window.removeEventListener("pointerdown", close), window.removeEventListener("keydown", esc));
  }, [open]);
  const go = (href: string) => (setOpen(false), navigate(href));
  return (
    <div className="who" ref={ref}>
      {!localMode && billing && credit !== null && (
        <a className={`credit ${credit < 100 ? "low" : ""}`} href="/billing" onClick={(e) => (e.preventDefault(), navigate("/billing"))} title="Credits left">
          <i /> {creditsShort(credit / 100)} credits
        </a>
      )}
      <button className="avatar" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title={email}>
        {(email[0] || "?").toUpperCase()}
      </button>
      {open && (
        <div className="float menu-list" role="menu">
          <div className="menu-head">
            <span className="micro">Signed in as</span>
            <strong title={email}>{email}</strong>
          </div>
          <div className="menu-sep" />
          {!localMode && <button role="menuitem" onClick={() => go("/billing")}>
            <Wallet size={13} /> Credits and plans
          </button>}
          <button role="menuitem" onClick={() => go("/settings")}>
            <Plug size={13} /> Connect an agent
          </button>
          {!localMode && <button role="menuitem" onClick={() => (setOpen(false), openFeedback())}>
            <MessageSquareText size={13} /> Give feedback
          </button>}
          {!localMode && <div className="menu-sep" />}
          {!localMode && <button role="menuitem" onClick={async () => (await supabase()).auth.signOut()}>
            <LogOut size={13} /> Sign out
          </button>}
        </div>
      )}
    </div>
  );
}

function App() {
  const path = usePath();
  const [runtime, setRuntime] = useState<"loading" | "local" | "cloud">("loading");
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [email, setEmail] = useState<string>("");
  const [access, setAccess] = useState<{ ok: boolean; admin?: boolean; message?: string } | null>(null);
  // an idea typed before signing in: make its project and open the editor with the agent on it
  const [starting, setStarting] = useState<string | null>(null);
  useEffect(() => { applySeo(routeSeo(path, session === undefined ? undefined : !!session)); }, [path, session]);
  useEffect(() => {
    appConfig().then((c) => {
      if (c.localMode) return setRuntime("local");
      setRuntime("cloud");
      initProductAnalytics();
      initAdMeasurement(c.redditPixel);
    }).catch(() => {});
  }, []);
  useEffect(() => { if (runtime === "cloud" && session !== undefined) { measurePageVisit(); trackPageView(path, !!session); } }, [path, runtime, session === undefined ? "loading" : session ? "signed-in" : "guest"]);
  useEffect(() => {
    if (!access?.ok) return;
    const idea = readGuestIdea();
    if (!idea) return;
    clearGuestIdea();
    setStarting("");
    startProject(idea.text, idea.aspect)
      .then(() => (track("guest_project_started", { aspect: idea.aspect }), setStarting(null)))
      .catch((e) => (track("guest_project_failed", { error_code: e.code || e.name || "error" }), setStarting(`Couldn't start the project: ${e.message}`), setTimeout(() => (setStarting(null), navigate("/")), 4000)));
  }, [access?.ok]);
  useEffect(() => {
    let sub: { unsubscribe: () => void } | undefined;
    appConfig().then(async (c) => {
      if (c.localMode) {
        setSession({ access_token: "local", user: { email: "owner@local.foltio" } } as Session);
        setEmail("owner@local.foltio");
        return;
      }
      const s = await supabase();
      const { data } = await s.auth.getSession();
      setSession(data.session);
      setEmail(data.session?.user.email || "");
      if (data.session?.user) (noteSignedIn(data.session.user), clearGuestAuth());
      sub = s.auth.onAuthStateChange((event, sess) => {
        setSession(sess);
        setEmail(sess?.user.email || "");
        if (event === "SIGNED_IN" && sess?.user) (noteSignedIn(sess.user), clearGuestAuth());
      }).data.subscription;
    });
    return () => sub?.unsubscribe();
  }, []);
  useEffect(() => {
    if (!session) return setAccess(null);
    api<{ admin?: boolean }>("/api/me")
      .then((me) => setAccess({ ok: true, admin: !!me.admin }))
      .catch((e: ApiError) => setAccess({ ok: false, message: e.message }));
  }, [session?.access_token]);
  if (path === "/terms" || path === "/privacy") return <Legal page={path === "/terms" ? "terms" : "privacy"} />;
  // The public page is useful immediately; session discovery can happen in the background.
  if (session === undefined && runtime === "loading") return <div className="center muted">Starting FOLTIO…</div>;
  if (session === undefined) return <GuestEditor />;
  const view = path.match(/^\/v\/(prj_\w+)/);
  if (view) return <ViewPage projectId={view[1]} signedIn={!!session} />;
  if (!session) return <GuestEditor />;
  if (!access) return <div className="center muted">Checking access…</div>;
  if (!access.ok) return <NotAllowed email={email} message={access.message || ""} />;
  if (starting !== null) return <div className="center muted">{starting || "Setting up your project…"}</div>;
  let page;
  let m;
  if ((m = path.match(/^\/p\/(prj_\w+)/))) page = <Editor projectId={m[1]} />;
  else if ((m = path.match(/^\/approve\/(qt_\w+)/))) page = <Approve quoteId={m[1]} />;
  else if (path.startsWith("/settings")) page = <Settings />;
  else if (path.startsWith("/billing")) page = <BillingPage />;
  else if (path.startsWith("/analytics")) page = <AnalyticsPage />;
  else if (path.startsWith("/feedback/admin")) page = <FeedbackAdminPage />;
  else if (path.startsWith("/feedback")) page = <FeedbackPage />;
  else page = <Projects />;
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/" onClick={(e) => (e.preventDefault(), navigate("/"))}>
          <FoltioBrand />
        </a>
        <nav>
          {[...NAV.filter(([href]) => runtime !== "local" || href !== "/billing"), ...(runtime !== "local" && access.admin ? [["/analytics", "Analytics", <BarChart3 size={14} />] as [string, string, React.ReactNode]] : [])].map(([href, label, icon]) => (
            <a key={href} href={href} data-analytics={`nav_${label.toLowerCase()}`} onClick={(e) => (e.preventDefault(), navigate(href))} className={(href === "/" ? path === "/" : path.startsWith(href)) ? "on" : ""}>
              {icon} {label}
            </a>
          ))}
        </nav>
        {runtime !== "local" && <button className="btn primary topbar-feedback" onClick={openFeedback}><MessageSquareText size={14} /> Give feedback</button>}
        <Account email={email} path={path} localMode={runtime === "local"} />
      </header>
      <main className="page">{page}</main>
      {runtime !== "local" && <FeedbackModal />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
