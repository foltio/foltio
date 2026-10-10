// The signed-out front page is the editor itself — on a desktop, the agent panel, the canvas and the
// timeline, playing a real piece made with Studio; on a phone, the piece and the composer. Visitors can type an idea and look around; anything that does something (send,
// upload, export, edit) opens the sign-in panel. The idea is kept (localStorage, so it survives the
// OAuth round trip), and after sign-in App makes the project and the agent starts on it.
import { useEffect, useMemo, useRef, useState } from "react";
import { navigate } from "./api";
import { signIn } from "./Public";
import {
  ArrowUp, Clapperboard, Film, Paperclip, Download, Play, Pause, Check, SkipBack, SkipForward, ChevronLeft, ChevronRight, Undo2, Redo2, Scissors, Trash2, Magnet,
  Captions, Type, Mic, Music, Upload, Sparkles, X,
} from "lucide-react";
import "./guest.css";
import { FoltioMark } from "./Brand";
import { flushAnalytics, track } from "./analytics";
import { stashGuestFiles } from "./guestUpload";

const KEY = "studio.guest";
const AUTH_KEY = "studio.guest.auth";
const UPLOAD_KEY = "studio.guest.upload";
type Saved = { text: string; aspect: string; at: number; send?: boolean; v?: number };
type GateAction = "generic" | "prompt" | "upload";
type PendingAuth = { provider: "google" | "discord"; action: GateAction; at: number };
export type GuestUploadIntent = { text: string; aspect: string; at: number; fileCount?: number };

export function readGuestIdea(): Saved | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    return s && s.send && s.text?.trim() && Date.now() - s.at < 86_400_000 ? s : null;
  } catch {
    return null;
  }
}
const readPendingAuth = (): PendingAuth | null => {
  try {
    const value = JSON.parse(localStorage.getItem(AUTH_KEY) || "null") as (PendingAuth & { prompt?: boolean }) | null;
    if (!value || Date.now() - value.at >= 15 * 60_000) return null;
    return { provider: value.provider, action: value.action || (value.prompt ? "prompt" : "generic"), at: value.at };
  } catch {
    return null;
  }
};
const savePendingAuth = (provider: PendingAuth["provider"], action: GateAction) => {
  try { localStorage.setItem(AUTH_KEY, JSON.stringify({ provider, action, at: Date.now() })); } catch { /* storage unavailable */ }
};
export const clearGuestAuth = () => localStorage.removeItem(AUTH_KEY);
export const clearGuestIdea = () => (localStorage.removeItem(KEY), clearGuestAuth());
export function readGuestUploadIntent(): GuestUploadIntent | null {
  try {
    const value = JSON.parse(localStorage.getItem(UPLOAD_KEY) || "null") as GuestUploadIntent | null;
    return value && Date.now() - value.at < 86_400_000 ? value : null;
  } catch {
    return null;
  }
}
export const clearGuestUploadIntent = () => localStorage.removeItem(UPLOAD_KEY);
const saveGuestUploadIntent = (text: string, aspect: string, fileCount = 0) => {
  try { localStorage.setItem(UPLOAD_KEY, JSON.stringify({ text, aspect, fileCount, at: Date.now() })); } catch { /* storage unavailable */ }
};
const save = (s: Omit<Saved, "at">) => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...s, v: 2, at: Date.now() }));
  } catch {
    /* private mode: the idea just isn't kept */
  }
};

const SIZES: Record<string, { w: number; h: number; label: string }> = {
  "16:9": { w: 1920, h: 1080, label: "Landscape" },
  "9:16": { w: 1080, h: 1920, label: "Portrait" },
  "1:1": { w: 1080, h: 1080, label: "Square" },
};

const GUEST_IDEAS = [
  "Generate a cinematic short film from my idea",
  "Create a polished product film from scratch",
  "Turn my clips into a sharp 30-second launch video",
  "Cut a podcast highlight with captions",
];


const TRACKS = [
  { name: "Captions", icon: <Captions size={13} />, h: 30 },
  { name: "Titles", icon: <Type size={13} />, h: 30 },
  { name: "V1", icon: <Film size={13} />, h: 64, main: true },
  { name: "Voice", icon: <Mic size={13} />, h: 40 },
  { name: "Music", icon: <Music size={13} />, h: 40 },
];

const GoogleMark = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
    <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
  </svg>
);
const DiscordMark = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
    <path
      fill="currentColor"
      d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.6 1.3a18.4 18.4 0 0 0-5.6 0L8.6 3a19.7 19.7 0 0 0-4.9 1.5C.6 9.1-.3 13.6.1 18.1a19.9 19.9 0 0 0 6 3l1.3-2.1a12.9 12.9 0 0 1-2-1l.5-.4a14.2 14.2 0 0 0 12.2 0l.5.4c-.6.4-1.3.7-2 1l1.3 2.1a19.8 19.8 0 0 0 6-3c.5-5.2-.9-9.7-3.6-13.7zM8 15.3c-1.2 0-2.2-1.1-2.2-2.4S6.8 10.5 8 10.5s2.2 1.1 2.2 2.4-1 2.4-2.2 2.4zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4z"
    />
  </svg>
);

function SignInPanel({ reason, action, onClose }: { reason: string; action: GateAction; onClose: () => void }) {
  const mode = action;
  const stagedFiles = action === "upload" ? readGuestUploadIntent()?.fileCount || 0 : 0;
  const [busy, setBusy] = useState<PendingAuth["provider"] | null>(null);
  useEffect(() => {
    track("auth_gate_opened", { mode });
    const on = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);
  const link = (path: string) => (e: React.MouseEvent) => (e.preventDefault(), navigate(path));
  const choose = async (provider: PendingAuth["provider"]) => {
    if (busy) return;
    setBusy(provider);
    savePendingAuth(provider, action);
    track("auth_provider_selected", { provider, mode });
    await flushAnalytics();
    try {
      await signIn(provider, "/");
    } catch {
      clearGuestAuth();
      track("auth_provider_failed", { provider, mode });
      setBusy(null);
    }
  };
  return (
    <div className="g-veil" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="g-signin" role="dialog" aria-modal="true" aria-labelledby="g-signin-title">
        <button className="icon g-close" onClick={onClose} title="Close">
          <X size={16} />
        </button>
        <span className="mark g-mark">▶</span>
        <h2 id="g-signin-title">{action === "prompt" ? "Sign in and Hermes starts" : action === "upload" ? stagedFiles ? "Sign in to continue your upload" : "Sign in, then choose your footage" : reason}</h2>
        <p className="muted">
          {action === "prompt"
            ? "Your prompt and format are saved. After sign-in, we’ll create the project and start your agent."
            : action === "upload"
              ? stagedFiles
                ? `${stagedFiles} ${stagedFiles === 1 ? "file is" : "files are"} safely staged in this browser. After sign-in, you’ll continue without selecting them again.`
                : "Your idea and format are saved. You’ll come straight back to choose files, then Hermes can start editing."
              : "One click with Google or Discord. Your projects stay private to your account unless you choose to share them."}
        </p>
        <div className="g-providers">
          <button className="g-provider google" disabled={!!busy} onClick={() => void choose("google")}>
            <GoogleMark /> {busy === "google" ? "Opening Google…" : "Continue with Google"}
          </button>
          <button className="g-provider discord" disabled={!!busy} onClick={() => void choose("discord")}>
            <DiscordMark /> {busy === "discord" ? "Opening Discord…" : "Continue with Discord"}
          </button>
        </div>
        <p className="g-gift">
          <Sparkles size={13} />
          <span>
            New accounts get <strong>500 free credits</strong>. No card needed.
          </span>
        </p>
        <p className="muted g-legal">
          By continuing you agree to the{" "}
          <a href="/terms" onClick={link("/terms")}>
            Terms
          </a>{" "}
          and{" "}
          <a href="/privacy" onClick={link("/privacy")}>
            Privacy
          </a>
          .
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the showcase
// The front page plays a real piece made with Studio: its export, or its timeline's clips one after
// another, with that timeline drawn underneath and a playhead in sync. Keep a finished commercial
// edit as the launch demo; the remaining public projects are playable fallbacks if it is unavailable.
type ShowClip = { id: string; track: string; kind: string; name: string; url: string | null; poster: string | null; start: number; dur: number; inS: number };
type Showcase = { id: string; name: string; owner: string; clones: number; total: number; ratio: number; intent: string; render: { url: string; poster: string | null } | null; clips: ShowClip[]; tracks: { id: string; kind: string }[] };
const FEATURED_SHOWCASE = "prj_atpneb06a6b9";

async function loadShowcase(): Promise<Showcase | null> {
  const list = await fetch("/api/public/projects?sort=clones").then((r) => r.json()).catch(() => null);
  const projects = list?.projects || [];
  const featured = projects.find((p: any) => p.id === FEATURED_SHOWCASE) || { id: FEATURED_SHOWCASE };
  const candidates = [featured, ...projects.filter((p: any) => p.id !== FEATURED_SHOWCASE)].slice(0, 6);
  for (const p of candidates) {
    const d = await fetch(`/api/public/projects/${p.id}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!d) continue;
    const doc = d.project?.doc || {};
    const rate = doc.settings?.rate;
    const fps = rate?.num ? rate.num / (rate.den || 1) : 30;
    const assets = new Map<string, any>((d.assets || []).map((a: any) => [a.id, a]));
    const clips: ShowClip[] = Object.values<any>(doc.sequence?.items || {})
      .filter((it) => it && typeof it.start === "number" && typeof it.duration === "number")
      .map((it) => {
        const a = it.asset ? assets.get(it.asset) : null;
        return { id: it.id, track: it.trackId, kind: it.kind, name: it.name || a?.name || it.text || it.kind, url: a?.kind === "video" ? a.proxy : null, poster: a?.poster || null, start: it.start / fps, dur: it.duration / fps, inS: (it.source?.inMs || 0) / 1000 };
      })
      .sort((x, y) => x.start - y.start);
    const main = clips.filter((c) => c.track === "trk_v1" && c.url);
    if (!d.render?.url && !main.length) continue;
    const total = Math.max(1, ...clips.map((c) => c.start + c.dur));
    const used = new Set(clips.map((c) => c.track));
    return {
      id: p.id,
      name: d.project.name,
      owner: d.owner,
      clones: d.clones || 0,
      total,
      ratio: (doc.settings?.width || 1080) / (doc.settings?.height || 1920),
      intent: d.board?.brief?.intent || d.project.name,
      render: d.render?.url ? d.render : null,
      clips,
      // every track, used or not, as the editor shows them (pictures on top, sound below)
      tracks: (doc.sequence?.tracks || []).map((t: any) => ({ id: t.id, kind: t.kind })).sort((x: any, y: any) => (x.kind === "audio" ? 1 : 0) - (y.kind === "audio" ? 1 : 0) || (used.has(y.id) ? 1 : 0) * 0),
    };
  }
  return null;
}

function useShowcase() {
  const [sc, setSc] = useState<Showcase | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    loadShowcase().then((x) => live && setSc(x)).catch(() => live && setSc(null));
    return () => {
      live = false;
    };
  }, []);
  return sc;
}

const fmt = (s: number) => {
  const m = Math.floor(s / 60), r = Math.floor(s % 60), f = Math.floor((s % 1) * 30);
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
};

// Plays the showcase: the export if there is one, else the main track's clips in order. Reports the
// timeline position (seconds) on every frame, so the playhead and timecode follow without re-renders.
function ShowcasePlayer({ sc, onTime, className = "" }: { sc: Showcase; onTime: (t: number) => void; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const main = useMemo(() => sc.clips.filter((c) => c.track === "trk_v1" && c.url), [sc]);
  const [i, setI] = useState(0);
  const clip = sc.render ? null : main[i % Math.max(1, main.length)];
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    let raf = 0;
    const tick = () => {
      if (sc.render) onTime(v.currentTime % sc.total);
      else if (clip) {
        const t = clip.start + Math.max(0, v.currentTime - clip.inS);
        onTime(t);
        if (v.currentTime >= clip.inS + clip.dur - 0.04) setI((n) => (n + 1) % main.length);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [sc, clip?.id]);
  useEffect(() => {
    const v = ref.current;
    if (!v || !clip) return;
    const go = () => {
      v.currentTime = clip.inS;
      v.play().catch(() => {});
    };
    if (v.readyState >= 1) go();
    else v.addEventListener("loadedmetadata", go, { once: true });
  }, [clip?.id]);
  const src = sc.render ? sc.render.url : clip?.url || undefined;
  const poster = sc.render ? sc.render.poster || undefined : clip?.poster || undefined;
  return <video ref={ref} className={className} src={src} poster={poster} muted playsInline autoPlay loop={!!sc.render || main.length === 1} preload="metadata" />;
}

// ---------------------------------------------------------------- a sample conversation
// What working with the agent looks like, from the showcase's own idea: shown once, a step at a time.
function SampleChat({ sc, onAsk }: { sc: Showcase; onAsk: (reason: string) => void }) {
  const steps = 5;
  const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [shown, setShown] = useState(reduce ? steps : 0);
  useEffect(() => {
    if (reduce) return;
    const timers = [400, 1300, 2300, 3600, 5200].map((ms, k) => setTimeout(() => setShown(k + 1), ms));
    return () => timers.forEach(clearTimeout);
  }, []);
  const take = sc.clips.find((c) => c.track === "trk_v1" && c.poster);
  return (
    <div className="g-chat" aria-label="An example conversation">
      <div className="g-chat-head">
        <span>Example</span>
        <strong className="ellipsis">{sc.name}</strong>
        <span className="g-chat-by">by {sc.owner}</span>
      </div>
      {shown >= 1 && <div className="g-msg you">{sc.intent}</div>}
      {shown >= 2 && <p className="g-msg agent">Good brief. Before I draw anything: how should it feel?</p>}
      {shown >= 3 && (
        <div className="g-q">
          {["Fast and punchy, cut on the beat", "Slow and warm, lingering close-ups", "Playful, with on-screen words"].map((o, k) => (
            <button key={o} className={k === 0 ? "on" : ""} onClick={() => onAsk("Sign in to make your own")}>
              <span className="num">{k + 1}</span> {o}
            </button>
          ))}
        </div>
      )}
      {shown >= 4 && (
        <div className="g-step">
          <Check size={12} /> Drew the storyboard <span className="muted">· {Math.max(1, sc.clips.filter((c) => c.track === "trk_v1").length)} clip{sc.clips.filter((c) => c.track === "trk_v1").length === 1 ? "" : "s"}</span>
        </div>
      )}
      {shown >= 5 && (
        <div className="g-step">
          <Check size={12} /> Made the video and cut it on the timeline
          {take?.poster && <img src={take.poster} alt="" />}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the composer (shared)
function useGuestComposer() {
  const kept = useMemo(() => {
    try {
      const value = JSON.parse(localStorage.getItem(KEY) || "null") as Saved | null;
      // Before landscape became the default, every untouched draft silently stored portrait.
      // Migrate only those old, unsent drafts; a prompt already submitted keeps its chosen format.
      return value && value.v !== 2 && !value.send ? { ...value, aspect: "16:9" } : value;
    } catch {
      return null;
    }
  }, []);
  const [text, setText] = useState(kept?.text || "");
  const [aspect, setAspect] = useState(kept?.aspect && SIZES[kept.aspect] ? kept.aspect : "16:9");
  const [gate, setGate] = useState<{ action: GateAction; reason: string } | null>(null);
  // keep the draft as it's typed, so a reload or the sign-in round trip doesn't lose it
  // (an idea sent before sign-in stays sent while it's unchanged: the page can show for a moment
  // on the way back from Google or Discord)
  useEffect(() => save({ text, aspect, send: !!kept?.send && text === kept.text && aspect === kept.aspect }), [text, aspect]);
  useEffect(() => {
    const pending = readPendingAuth();
    const resumable = pending?.action === "prompt" ? !!kept?.send : pending?.action === "upload" ? !!readGuestUploadIntent() : false;
    if (!pending || !resumable) return;
    // A successful OAuth callback normally replaces this page before the timer fires. If it does
    // not, the person came back unsigned: resume the exact sign-in step instead of silently
    // dropping them onto the landing page with a dormant prompt.
    const callback = new URLSearchParams(location.search).has("code");
    const timer = window.setTimeout(() => {
      track("auth_returned_unsigned", { provider: pending.provider, status: "cancelled" });
      setGate({ action: pending.action, reason: "Continue signing in to start" });
    }, callback ? 3500 : 650);
    return () => clearTimeout(timer);
  }, []);
  const send = () => {
    if (!text.trim()) return false;
    clearGuestUploadIntent();
    save({ text: text.trim(), aspect, send: true });
    track("guest_prompt_submitted", { aspect });
    setGate({ action: "prompt", reason: "Sign in to start" });
    return true;
  };
  const upload = async (files: File[] = []) => {
    save({ text, aspect, send: false });
    let fileCount = 0;
    if (files.length) {
      try { fileCount = await stashGuestFiles(files); } catch { /* quota/privacy mode: choose again after sign-in */ }
    }
    saveGuestUploadIntent(text.trim(), aspect, fileCount);
    track("guest_upload_started", { aspect, count: files.length });
    setGate({ action: "upload", reason: "Sign in to upload footage" });
  };
  const ask = (reason: string) => setGate({ action: "generic", reason });
  const close = () => {
    track("auth_gate_closed", { mode: gate?.action || "generic" });
    clearGuestAuth();
    setGate(null);
    save({ text, aspect, send: false });
  };
  return { text, setText, aspect, setAspect, gate, ask, upload, send, close };
}

function useAutoHeight(ref: React.RefObject<HTMLTextAreaElement | null>, text: string, max = 220) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, max) + "px";
  }, [text]);
}

function usePhone() {
  const q = "(max-width: 760px)";
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setPhone(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return phone;
}

export function GuestEditor({ error }: { error?: string }) {
  const c = useGuestComposer();
  const phone = usePhone();
  // Acquisition opens into a clean editor. Never load another person's public project into a
  // signed-out workspace: the empty canvas should feel like the visitor's own starting point.
  const sc = null;
  return (
    <>
      {phone ? <PhoneLanding sc={sc} c={c} error={error} /> : <DesktopLanding sc={sc} c={c} error={error} />}
      {c.gate && <SignInPanel reason={c.gate.reason} action={c.gate.action} onClose={c.close} />}
    </>
  );
}

type Composer = ReturnType<typeof useGuestComposer>;

type LandingFilm = { name: string; shape: "portrait" | "wide"; slug?: string; video?: string; poster?: string; image?: string };
const FILMS: LandingFilm[] = [
  { name: "Prism maker", slug: "prism-maker", shape: "portrait" },
  { name: "Red passage", slug: "red-passage", shape: "wide" },
  { name: "Paper orbit", slug: "paper-orbit", shape: "portrait" },
  { name: "Salt procession", slug: "salt-procession", shape: "wide" },
  { name: "Blue hour drift", slug: "blue-hour-drift", shape: "portrait" },
  { name: "Chrome garden", slug: "chrome-garden", shape: "wide" },
  { name: "Last round", slug: "last-round", shape: "portrait" },
];

const asset = (slug: string, ext: "mp4" | "jpg") => `/films/${slug}${ext === "jpg" ? "-poster.jpg" : ".mp4"}`;
const filmPoster = (film: LandingFilm) => film.poster || film.image || asset(film.slug!, "jpg");
const filmVideo = (film: LandingFilm) => film.video || (film.slug ? asset(film.slug, "mp4") : null);

function LandingFilmVisual({ film, eager = false }: { film: LandingFilm; eager?: boolean }) {
  const video = filmVideo(film);
  return video
    ? <video autoPlay muted loop playsInline preload={eager ? "metadata" : "none"} poster={filmPoster(film)} src={video} />
    : <img src={filmPoster(film)} alt="" loading={eager ? "eager" : "lazy"} />;
}

function HeroClip({ className, slug, label, preload = "none" }: { className: string; slug: string; label: string; preload?: "none" | "metadata" }) {
  const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  return (
    <div className={`fl-float ${className}`} aria-hidden="true">
      <video autoPlay={!reduce} muted loop playsInline preload={preload} poster={asset(slug, "jpg")} src={asset(slug, "mp4")} tabIndex={-1} />
      <span className="fl-shot-label"><i /> {label}</span>
    </div>
  );
}

function FoltioLanding({ c, error }: { c: Composer; error?: string }) {
  const input = useRef<HTMLTextAreaElement>(null);
  useAutoHeight(input, c.text, 150);
  const prompts = [
    ["Social cut", "Turn my footage into a fast social video about "],
    ["Product film", "Make a polished product video about "],
    ["Short film", "Create a cinematic short film about "],
    ["Music video", "Make a music video about "],
    ["Podcast clip", "Cut a captioned podcast highlight about "],
  ];
  const submit = () => c.send() || input.current?.focus();
  return (
    <div className="fl-page">
      <header className="fl-nav">
        <a className="fl-wordmark" href="#top" aria-label="FOLTIO home">
          <FoltioMark className="fl-logo" />
          FOLTIO
        </a>
        <nav aria-label="Main navigation">
          <a href="#films">Films</a>
          <a href="#how">How it works</a>
          <a href="#questions">Questions</a>
          <a href="/settings" onClick={(e) => (e.preventDefault(), c.ask("Sign in to connect your agent"))}>Connect</a>
        </nav>
        <div className="fl-actions">
          <button className="fl-login" onClick={() => c.ask("Sign in to FOLTIO")}>Sign in</button>
          <button className="fl-start" onClick={() => c.ask("Sign in to start making")}>Start making</button>
        </div>
      </header>

      <main id="top">
        <section className="fl-hero" aria-labelledby="fl-title">
          <div className="fl-aura" />
          <HeroClip className="fl-float-a" slug="prism-maker" label="Source" preload="metadata" />
          <HeroClip className="fl-float-b" slug="blue-hour-drift" label="Select" preload="metadata" />
          <HeroClip className="fl-float-c" slug="chrome-garden" label="Sequence" />
          <HeroClip className="fl-float-d" slug="salt-procession" label="Final cut" />
          <div className="fl-cinema-veil" aria-hidden="true" />

          <div className="fl-hero-copy">
            <p className="fl-kicker"><span /> The agentic video editor</p>
            <h1 id="fl-title">Make the video.<br /><em>Finish the cut.</em></h1>
            <p className="fl-lede">Bring footage or start with an idea. FOLTIO plans the story, generates what is missing and edits everything with you on a real multitrack timeline.</p>

            <div className="fl-composer">
              <textarea
                ref={input}
                rows={2}
                aria-label="Describe the video you want to make"
                placeholder="Turn my clips into a sharp 30-second launch video…"
                value={c.text}
                onChange={(e) => c.setText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), submit())}
              />
              <div className="fl-compose-row">
                <button className="fl-add" aria-label="Add footage" onClick={() => c.ask("Sign in to use your footage")}><Paperclip size={15} /></button>
                <button className="fl-auto" onClick={() => c.ask("Sign in to choose a filmmaking model")}><Sparkles size={13} /> Auto</button>
                <div className="fl-aspects" aria-label="Aspect ratio">
                  {["9:16", "16:9"].map((a) => <button key={a} className={c.aspect === a ? "on" : ""} onClick={() => c.setAspect(a)}>{a}</button>)}
                </div>
                <span className="grow" />
                <button className="fl-send" disabled={!c.text.trim()} onClick={submit} aria-label="Start making"><ArrowUp size={17} /></button>
              </div>
            </div>
            <div className="fl-prompts">
              {prompts.map(([label, prompt]) => <button key={label} onClick={() => (c.setText(prompt), input.current?.focus())}>{label}</button>)}
            </div>
            <p className="fl-proof"><span>Consistent characters</span><i /> <span>Native sound</span><i /> <span>Editable timeline</span></p>
            <p className="fl-credit">500 credits included · no card</p>
            {error && <p className="error">{error}</p>}
          </div>
        </section>

        <section className="fl-reel" id="films" aria-labelledby="fl-reel-title">
          <div className="fl-section-head">
            <h2 id="fl-reel-title">Videos made with FOLTIO</h2>
            <p>Ads, social cuts, short films and visual stories—from raw material to final export.</p>
          </div>
          <div className="fl-filmstrip">
            {FILMS.map((film, index) => (
              <button className={`fl-film ${film.shape}`} key={film.name} onClick={() => c.ask("Sign in to make your film")}>
                <LandingFilmVisual film={film} eager={index < 4} />
                <span>{filmVideo(film) ? <Play size={11} fill="currentColor" /> : <Sparkles size={11} />} {film.name}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="fl-how" id="how">
          <div className="fl-section-head center-copy">
            <p className="fl-kicker"><span /> From footage to final</p>
            <h2>One workspace for the whole edit.</h2>
          </div>
          <div className="fl-three">
            <article><b>01</b><div className="fl-mini fl-mini-story"><i>PLAN</i><strong>Story, selects &amp; pace</strong><span>FOOTAGE · SCRIPT · STORYBOARD</span></div><h3>Shape the story</h3><p>Bring footage, references or one sentence. FOLTIO finds the structure, tracks every creative decision and keeps the project coherent.</p></article>
            <article><b>02</b><div className="fl-mini fl-mini-direct"><video autoPlay muted loop playsInline poster={asset("salt-procession", "jpg")} src={asset("salt-procession", "mp4")} /><span>Take 03 · selected</span></div><h3>Direct every shot</h3><p>Generate animated shots with sound, compare takes, bring references and steer the next scene from what actually landed.</p></article>
            <article><b>03</b><div className="fl-mini fl-mini-cut"><div className="fl-playline" /><i style={{ width: "31%" }} /><i style={{ width: "23%" }} /><i style={{ width: "38%" }} /><span>V1</span><em>VOICE</em></div><h3>Finish the cut</h3><p>Everything lands on a real editable timeline—picture, dialogue, music, captions and effects—ready to share or export.</p></article>
          </div>
        </section>

        <section className="fl-faq" id="questions" aria-labelledby="fl-faq-title">
          <div className="fl-faq-intro">
            <p className="fl-kicker"><span /> The practical version</p>
            <h2 id="fl-faq-title">An AI video editor you can actually direct.</h2>
            <p>FOLTIO combines a filmmaking agent with the production board and multitrack timeline where the work actually gets finished.</p>
          </div>
          <div className="fl-faq-list">
            <article>
              <h3>What is FOLTIO?</h3>
              <p>FOLTIO is an agentic video editor. Upload footage or start from an idea, then plan, generate, cut, caption, mix and finish the video in one browser workspace.</p>
            </article>
            <article>
              <h3>What can I make with it?</h3>
              <p>Social videos, ads, explainers, trailers, short films, music videos, podcast clips and polished edits built from your footage, references or a prompt.</p>
            </article>
            <article>
              <h3>Does it include a real video editor?</h3>
              <p>Yes. Generated media and uploaded footage land on an editable multitrack timeline with picture, dialogue, music, captions and effects—not in a separate demo.</p>
            </article>
            <article>
              <h3>How does it keep a world consistent?</h3>
              <p>Hermes, the built-in filmmaking agent, works from the same story, characters, locations, visual references, selected takes and timeline throughout the project.</p>
            </article>
            <article>
              <h3>How do credits work?</h3>
              <p>New accounts get 500 credits. AI generation and Hermes work use credits, and you see the generation price before it runs. Editing, uploads and renders are free.</p>
            </article>
            <article>
              <h3>Can another AI agent use FOLTIO?</h3>
              <p>Yes. Connect an external agent through FOLTIO’s MCP tools so it can inspect a project, prepare media, edit the timeline, render and run quality checks with your approval.</p>
            </article>
          </div>
        </section>

        <section className="fl-end">
          <div className="fl-end-cards" aria-hidden>
            {FILMS.slice(0, 5).map((f) => <img key={f.name} src={filmPoster(f)} alt="" />)}
          </div>
          <h2>Your next video<br />starts here.</h2>
          <button onClick={() => (input.current?.scrollIntoView({ behavior: "smooth", block: "center" }), setTimeout(() => input.current?.focus(), 500))}>Start editing <ArrowUp size={16} /></button>
        </section>
      </main>

      <footer className="fl-footer">
        <a className="fl-wordmark" href="#top"><FoltioMark className="fl-logo" />FOLTIO</a>
        <p>Video editing with people, agents and good decisions.</p>
        <span className="grow" />
        <a href="/terms" onClick={(e) => (e.preventDefault(), navigate("/terms"))}>Terms</a>
        <a href="/privacy" onClick={(e) => (e.preventDefault(), navigate("/privacy"))}>Privacy</a>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------- phone
// A different composition, not a squeezed editor: the piece playing, what it is, and the composer
// as the one thing to do, pinned to the bottom above the home indicator.
function PhoneLanding({ sc, c, error }: { sc: Showcase | null | undefined; c: Composer; error?: string }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const uploadPicker = useRef<HTMLInputElement>(null);
  useAutoHeight(input, c.text, 140);
  const go = (path: string) => (e: React.MouseEvent) => (e.preventDefault(), navigate(path));
  return (
    <div className="gm">
      <header className="gm-top">
        <a className="brand" href="/" onClick={(e) => e.preventDefault()}>
          <FoltioMark className="foltio-mark" /> FOLTIO
        </a>
        <span className="grow" />
        <button className="btn small ghost" onClick={() => c.ask("Sign in to FOLTIO")}>
          Sign in
        </button>
      </header>
      <main className="gm-main">
        <h1>Edit video by talking to an agent.</h1>
        <p className="gm-sub">Bring footage or describe the result. Hermes plans the story, generates what is missing and works with you on a real timeline.</p>
        <div className="gm-card gm-poster-card" onClick={() => !sc && input.current?.focus()} title={sc ? undefined : "Start with a prompt"}>
          {sc ? (
            <>
              <ShowcasePlayer sc={sc} onTime={() => {}} className="gm-video" />
              <a className="gm-made" href={`/v/${sc.id}`} onClick={go(`/v/${sc.id}`)}>
                <span className="ellipsis">{sc.name}</span>
                <span className="gm-made-by">
                  by {sc.owner} · <span className="num">{sc.clones}</span> clone{sc.clones === 1 ? "" : "s"}
                </span>
              </a>
            </>
          ) : (
            <img className="gm-generated-poster" src="/guest-editor-poster-v4.webp" alt="Plan, generate, edit and finish — start with a prompt or your footage" />
          )}
        </div>
        <footer className="gm-foot">
          <a href="/terms" onClick={go("/terms")}>
            Terms
          </a>
          <a href="/privacy" onClick={go("/privacy")}>
            Privacy
          </a>
        </footer>
        {error && <p className="error">{error}</p>}
      </main>
      <div className="gm-dock">
        <div className="gm-dock-aspects" aria-label="Video orientation">
          <button className={c.aspect === "16:9" ? "on" : ""} onClick={() => c.setAspect("16:9")}>Landscape <span>16:9</span></button>
          <button className={c.aspect === "9:16" ? "on" : ""} onClick={() => c.setAspect("9:16")}>Portrait <span>9:16</span></button>
          <button className="gm-upload" onClick={() => uploadPicker.current?.click()}><Upload size={12} /> Upload</button>
          <input ref={uploadPicker} type="file" multiple hidden accept="video/*,audio/*,image/*" onChange={(e) => (void c.upload(Array.from(e.target.files || [])), (e.target.value = ""))} />
        </div>
        {!c.text && (
          <div className="gm-ideas">
            {GUEST_IDEAS.map((i) => (
              <button key={i} onClick={() => (c.setText(i), input.current?.focus())}>
                {i}
              </button>
            ))}
          </div>
        )}
        <div className="gm-compose">
          <textarea
            ref={input}
            rows={1}
            placeholder="Describe the video you want to make…"
            value={c.text}
            onChange={(e) => c.setText(e.target.value)}
            enterKeyHint="send"
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), c.send() || input.current?.focus())}
          />
          <button className="gm-send" disabled={!c.text.trim()} onClick={() => c.send()} aria-label="Start">
            <ArrowUp size={18} />
          </button>
        </div>
        <p className="gm-note">
          <Sparkles size={11} /> 500 free credits · no card
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- desktop
function DesktopLanding({ sc, c, error }: { sc: Showcase | null | undefined; c: Composer; error?: string }) {
  const [tab, setTab] = useState<"agent" | "media">("agent");
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const uploadPicker = useRef<HTMLInputElement>(null);
  const head = useRef<HTMLElement>(null);
  const clock = useRef<HTMLElement>(null);
  const size = SIZES[c.aspect];
  useEffect(() => input.current?.focus(), []);
  useAutoHeight(input, c.text);
  const total = sc?.total || 30;
  const onTime = (t: number) => {
    if (head.current) head.current.style.transform = `translateX(${(t / total) * 100}cqw)`;
    if (clock.current) clock.current.textContent = fmt(t);
  };
  const tickEvery = total > 40 ? 10 : total > 16 ? 4 : 2;
  const ticks = Array.from({ length: Math.floor(total / tickEvery) + 1 }, (_, k) => k * tickEvery);
  const ask = c.ask;
  const rows = sc ? sc.tracks : TRACKS.map((t) => ({ id: t.name, kind: t.name === "V1" ? "video" : "x" }));
  const trackName = (id: string, kind: string) => ({ trk_v1: "V1", trk_v2: "V2", trk_t1: "Titles", trk_cap: "Captions", trk_a1: "Voice", trk_a2: "Music", trk_a3: "Sound" } as Record<string, string>)[id] || (kind === "audio" ? "Audio" : id);
  const trackIcon = (id: string) => (id === "trk_cap" || id === "Captions" ? <Captions size={13} /> : id === "trk_t1" || id === "Titles" ? <Type size={13} /> : id === "trk_a1" || id === "Voice" ? <Mic size={13} /> : id.startsWith("trk_a") || id === "Music" ? <Music size={13} /> : <Film size={13} />);

  return (
    <div
      className={`g-editor ${drag ? "drag" : ""}`}
      onDragOver={(e) => e.dataTransfer.types.includes("Files") && (e.preventDefault(), setDrag(true))}
      onDragLeave={(e) => e.relatedTarget === null && setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        void c.upload(Array.from(e.dataTransfer.files));
      }}
    >
      <h1 className="g-sr-only">FOLTIO agentic AI video editor</h1>
      <header className="g-top">
        <a className="brand" href="/" onClick={(e) => e.preventDefault()}>
          <FoltioMark className="foltio-mark" /> FOLTIO
        </a>
        <span className="g-vsep" />
        <strong className="g-name">{sc ? sc.name : "Untitled video"}</strong>
        <span className="pill g-hide-sm">{sc ? `${sc.ratio < 1 ? "1080×1920" : sc.ratio > 1 ? "1920×1080" : "1080×1080"} · 30 fps` : `${size.w}×${size.h} · 30 fps`}</span>
        {sc && (
          <a className="g-made g-hide-sm" href={`/v/${sc.id}`} onClick={(e) => (e.preventDefault(), navigate(`/v/${sc.id}`))}>
            Made with FOLTIO by {sc.owner} · Clone it
          </a>
        )}
        <div className="grow" />
        <a className="g-toplink g-hide-sm" href="/terms" onClick={(e) => (e.preventDefault(), navigate("/terms"))}>
          Terms
        </a>
        <button className="btn small ghost" onClick={() => ask("Sign in to FOLTIO")}>
          Sign in
        </button>
        <button className="btn primary small" onClick={() => ask("Sign in to export")}>
          <Download size={14} /> Export
        </button>
      </header>

      <div className="g-body">
        <nav className="g-rail">
          <button className={tab === "agent" ? "on" : ""} onClick={() => setTab("agent")}>
            <Clapperboard size={18} />
            Agent
          </button>
          <button className={tab === "media" ? "on" : ""} onClick={() => setTab("media")}>
            <Film size={18} />
            Media
          </button>
        </nav>

        <aside className="g-panel">
          {tab === "agent" ? (
            <>
              <div className="g-panel-scroll">
                {sc ? (
                  <SampleChat sc={sc} onAsk={ask} />
                ) : (
                  <div className="g-entry">
                    <span className="g-entry-kicker">Start with your media</span>
                    <button className="g-drop-start" onClick={() => uploadPicker.current?.click()}>
                      <span className="g-drop-icon"><Upload size={21} /></span>
                      <strong>Drop footage here</strong>
                      <span>Video, images or audio</span>
                      <em>Choose files</em>
                    </button>
                    <div className="g-entry-or"><span>or</span></div>
                    <div className="g-prompt-hint">
                      <Sparkles size={16} />
                      <span><strong>Start from an idea</strong><small>Describe it below. Hermes will plan the first cut with you.</small></span>
                    </div>
                  </div>
                )}
                {error && <p className="error">{error}</p>}
              </div>
              <div className="g-compose-wrap">
                <label className="g-compose-label" htmlFor="g-idea">
                  Describe your video <span>— primary action</span>
                </label>
                {!c.text && (
                  <div className="g-ideas">
                    {GUEST_IDEAS.map((i) => (
                      <button key={i} onClick={() => (c.setText(i), input.current?.focus())}>
                        {i}
                      </button>
                    ))}
                  </div>
                )}
                <div className="g-compose">
                  <textarea
                    id="g-idea"
                    ref={input}
                    rows={2}
                    placeholder="Turn my clips into a sharp 30-second launch video…"
                    value={c.text}
                    onChange={(e) => c.setText(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), c.send() || input.current?.focus())}
                  />
                  <div className="g-compose-row">
                    <button className="icon" title="Upload footage, images or music" onClick={() => uploadPicker.current?.click()}>
                      <Paperclip size={15} />
                    </button>
                    <div className="seg small">
                      {Object.keys(SIZES).map((a) => (
                        <button key={a} className={c.aspect === a ? "on" : ""} onClick={() => c.setAspect(a)} title={SIZES[a].label}>
                          {a}
                        </button>
                      ))}
                    </div>
                    <div className="grow" />
                    <button className="g-send" disabled={!c.text.trim()} onClick={() => c.send()} title="Start (Enter)">
                      <ArrowUp size={16} />
                    </button>
                  </div>
                </div>
                <p className="g-note">
                  <Sparkles size={11} /> 500 free credits to start · no card
                </p>
              </div>
            </>
          ) : (
            <div className="g-panel-scroll">
                  <div className="g-media-drop" onClick={() => uploadPicker.current?.click()}>
                <Upload size={22} />
                <strong>Drop footage, images or music</strong>
                <span className="muted small">Your agent can transcribe, cut and caption what you bring.</span>
              </div>
            </div>
          )}
        </aside>
        <input ref={uploadPicker} type="file" multiple hidden accept="video/*,audio/*,image/*" onChange={(e) => (void c.upload(Array.from(e.target.files || [])), (e.target.value = ""))} />

        <section className="g-work">
          <div className={`g-stage ${sc ? "" : "poster"}`}>
            <div className={`g-canvas ${sc ? "" : "g-poster-canvas"}`} style={sc ? { aspectRatio: `${sc.ratio}` } : undefined} onClick={() => !sc && input.current?.focus()} title={sc ? undefined : "Start with a prompt"}>
              {sc ? (
                <ShowcasePlayer sc={sc} onTime={onTime} className="g-canvas-video" />
              ) : (
                <img className="g-generated-poster" src="/guest-editor-poster-v4.webp" alt="Plan, generate, edit and finish — start with a prompt or your footage" />
              )}
            </div>
          </div>
          <div className="g-transport">
            <span className="timecode">
              <strong ref={clock as React.RefObject<HTMLElement>}>00:00:00</strong>
              <span className="muted"> / {fmt(sc?.total || 0)}</span>
            </span>
            <div className="g-transport-btns">
              <SkipBack size={16} />
              <ChevronLeft size={16} />
              <span className={`g-play ${sc ? "live" : ""}`}>{sc ? <Pause size={16} /> : <Play size={16} />}</span>
              <ChevronRight size={16} />
              <SkipForward size={16} />
            </div>
            <span className="g-hide-sm" />
          </div>
          <div className="g-timeline" onClick={() => ask("Sign in to start editing")}>
            <div className="g-tl-tools">
              <Undo2 size={15} />
              <Redo2 size={15} />
              <span className="g-vsep" />
              <Scissors size={15} />
              <Trash2 size={15} />
              <span className="g-vsep" />
              <Magnet size={15} className="on" />
            </div>
            <div className="g-tl-ruler">
              <span className="g-tl-corner">{rows.length} tracks</span>
              <div className="g-tl-ticks">
                {ticks.map((t) => (
                  <span key={t} style={{ left: `${(t / total) * 100}%` }}>
                    0:{String(t).padStart(2, "0")}
                  </span>
                ))}
              </div>
            </div>
            <div className="g-tl-rows">
              {rows.map((t) => (
                <div key={t.id} className={`g-tl-row ${t.id === "trk_v1" || t.id === "V1" ? "main" : ""}`}>
                  <span className="g-tl-head">
                    {trackIcon(t.id)} {sc ? trackName(t.id, t.kind) : t.id}
                  </span>
                  <span className="g-tl-lane">
                    {sc
                      ? sc.clips
                          .filter((x) => x.track === t.id)
                          .map((x) => (
                            <i
                              key={x.id}
                              className={`g-tl-item k-${x.kind}`}
                              style={{ left: `${(x.start / total) * 100}%`, width: `${(x.dur / total) * 100}%`, backgroundImage: x.poster && (x.kind === "clip" || x.kind === "image") ? `url(${x.poster})` : undefined }}
                              title={x.name}
                            >
                              <b>{x.name}</b>
                            </i>
                          ))
                      : (t.id === "V1") && <em>Your agent fills this in, or drop footage here</em>}
                  </span>
                </div>
              ))}
              <div className="g-tl-headroom" aria-hidden>
                <i className="g-playhead" ref={head as React.RefObject<HTMLElement>} />
              </div>
            </div>
          </div>
        </section>
      </div>

      {drag && (
        <div className="g-dropping">
          <Upload size={20} /> Drop files — they’ll stay ready through sign-in
        </div>
      )}
    </div>
  );
}
