import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, isLocalMode, putWithProgress, navigate, uploadFile, type Item } from "./api";
import { AgentPanel, type Attachment, type Mode } from "./agent/AgentPanel";
import { useBoard, boardNames, type Storyboard } from "./agent/Board";
import { useDrafts, useModels } from "./agent/Drafts";
import { useAgent, type ChatItem } from "./agent/useAgent";
import { StoryView } from "./agent/StoryView";
import "./agent/agent.css";
import "./community.css";
import { offerRefs, offerFiles } from "./agent/view";
import { useIsMobile } from "./useIsMobile";
import { useSheetDrag } from "./useSheetDrag";
import { useProject, type FullAsset } from "./useProject";
import { createClock, useClockTime, type Clock } from "./clock";
import { Player, type PlayerHandle, type TransformPatch } from "./Player";
import { Timeline } from "./Timeline";
import { Library } from "./Library";
import { ExportDialog } from "./ExportDialog";
import { FoltioMark } from "./Brand";
import { openFeedback } from "./Feedback";
import { captionWords, cues, cueSpans, cleanFilter } from "./engine";
import { credits } from "./credits";
import { refreshBilling, useLiveBilling } from "./billing";
import { addAssetOps, animSet, deleteOps, dropAssetOps, endOf, fpsOf, fmtTime, itemsAt, mainTrackId, placeCopiesOps, seqEnd, splitOps, trackOf, ensureTrack, hasAudio } from "./edits";
import {
  Undo2, Redo2, Scissors, ArrowLeftToLine, ArrowRightToLine, Trash2, CopyPlus, Bookmark, Magnet, ZoomIn, ZoomOut, Maximize2, Play, Pause, SkipBack, SkipForward, ChevronLeft, ChevronRight,
  Expand, Film, LayoutGrid, ChevronUp, ChevronDown, Sparkles, Download, ScanLine, Crosshair, Loader2, Check, X, Activity, Upload, Square, Clapperboard,
  MessageSquareText, Globe2, LockKeyhole, Wallet, ArrowRight,
} from "lucide-react";

// The agent does the editing — text, captions, transitions, sound, generation — so the side panel is
// the conversation, plus the media library for looking through files in detail.
type Tab = "agent" | "board" | "media";
const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "agent", label: "Agent", icon: <Clapperboard size={18} /> },
  { id: "board", label: "Board", icon: <LayoutGrid size={18} /> },
  { id: "media", label: "Media", icon: <Film size={18} /> },
];
const store = {
  get: (k: string, d: string) => {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

function TimeReadout({ clock, fps, dur }: { clock: Clock; fps: number; dur: number }) {
  const t = useClockTime(clock);
  return (
    <span className="timecode">
      <strong>{fmtTime(t, fps)}</strong>
      <span className="muted"> / {fmtTime(dur, fps)}</span>
    </span>
  );
}

const JOB_LABELS: Record<string, string> = { ingest: "Processing upload", probe: "Reading media", transcribe: "Transcribing", render: "Exporting", generate: "Generating", import: "Importing from link", proxy: "Making preview", panels: "Cutting storyboard panels", compose: "Composing", filmstrip: "Making filmstrip" };
const jobLabel = (k: string) => JOB_LABELS[k] || k.replace(/[_-]/g, " ").replace(/^./, (c) => c.toUpperCase());
function relTime(iso?: string) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
}

// Billing stays within reach while editing, without making someone leave their project just to
// check a balance or subscription. Checkout choices and full history remain on the billing page.
function EditorBillingMenu() {
  const [open, setOpen] = useState(false);
  const { billing, error: loadError, refresh } = useLiveBilling();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    refresh().catch(() => {});
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc);
    return () => (window.removeEventListener("pointerdown", close), window.removeEventListener("keydown", esc));
  }, [open, refresh]);
  const active = billing?.subscription && ["active", "trialing", "past_due"].includes(billing.subscription.status) ? billing.subscription : null;
  const plan = active ? billing?.plans.find((p) => p.id === active.plan_id) : null;
  const manage = async () => {
    setBusy(true);
    setError("");
    try {
      location.href = (await api<{ url: string }>("/api/billing/portal", {})).url;
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <div className="ed-billing-ctl" ref={ref}>
      <button className="btn small ghost ed-billing" onClick={() => setOpen(!open)} aria-haspopup="dialog" aria-expanded={open} title="Credits and subscription">
        <Wallet size={13} />
        <span className="ed-credit-label">{billing ? billing.exempt ? "Credits" : `${Math.max(0, Math.round(billing.balanceCredits)).toLocaleString()} credits` : "Credits"}</span>
      </button>
      {open && (
        <div className="popover ed-billing-pop" role="dialog" aria-label="Credits and subscription">
          <div className="ed-billing-head">
            <span className="micro">Credits &amp; subscription</span>
            <button className="icon xs" onClick={() => setOpen(false)} title="Close"><X size={13} /></button>
          </div>
          {!billing ? <span className="muted small">{error || loadError || "Loading…"}</span> : billing.exempt ? (
            <div className="ed-billing-balance"><strong>No credit limit</strong><span>This account is not charged.</span></div>
          ) : (
            <div className={`ed-billing-balance ${billing.balanceCredits < 100 ? "low" : ""}`}>
              <strong className="num">{Math.max(0, Math.round(billing.balanceCredits)).toLocaleString()}</strong>
              <span>credits available</span>
            </div>
          )}
          {billing && !billing.exempt && (
            <div className="ed-plan-row">
              <span><small>Monthly plan</small><strong>{plan?.name || "No active plan"}</strong></span>
              {active?.current_period_end && <small>{active.cancel_at_period_end ? "Ends" : "Renews"} {new Date(active.current_period_end).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</small>}
            </div>
          )}
          {error && billing && <span className="ed-billing-error">{error}</span>}
          <div className="ed-billing-actions">
            <button className="btn small primary" onClick={() => navigate("/billing")}>{active ? "Add credits" : "View credits & plans"} <ArrowRight size={13} /></button>
            {active && <button className="btn small ghost" disabled={busy} onClick={manage}>{busy ? "Opening…" : "Manage subscription"}</button>}
          </div>
        </div>
      )}
    </div>
  );
}

export function Editor({ projectId }: { projectId: string }) {
  const localMode = isLocalMode();
  // while the built-in agent works here, its edits show in the panel rather than as notices
  const agentBusy = useRef(false);
  const P = useProject(projectId, { quietExternal: () => agentBusy.current });
  const { doc } = P;
  const clock = useMemo(createClock, []);
  const playerRef = useRef<PlayerHandle>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  // the stage shows the preview or the board (the whole project, editable); remembered per project
  const view = "preview" as "preview" | "board"; // the board is a side tab now; the stage always shows the video
  // "Open board" from the chat, a clip pill or the media details (agent/view.ts)
  const [focusClip, setFocusClip] = useState<string | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ view: "board" | "preview"; clip?: string }>).detail || { view: "board" };
      if (d.view !== "preview") setTab("board");
      setFocusClip(d.clip || null);
    };
    window.addEventListener("studio:view", on);
    return () => window.removeEventListener("studio:view", on);
  }, [projectId]);
  const [selTrn, setSelTrn] = useState<string>();
  const [pps, setPpsRaw] = useState(() => Number(store.get("studio.pps", "60")) || 60);
  const [magnet, setMagnet] = useState(() => store.get("studio.magnet", "1") === "1");
  const [snapping, setSnapping] = useState(() => store.get("studio.snap", "1") === "1");
  const [tab, setTab] = useState<Tab>(() => localMode ? "media" : (store.get("studio.tab", "agent") === "media" ? "media" : "agent"));
  const tabs = localMode ? TABS.filter((t) => t.id !== "agent") : TABS;
  // phones (docs/mobile.md): a mini player over the tab, bottom tabs Agent · Board · Media · Edit
  const mobile = useIsMobile();
  useSheetDrag(mobile);
  const [mEdit, setMEdit] = useState(false); // the Edit tab (the timeline), phones only
  // the player folds to a bar on the chat (it needs the room) and opens elsewhere; each remembers
  const [playerOpenChat, setPlayerOpenChat] = useState(false);
  const [playerOpenElse, setPlayerOpenElse] = useState(true);
  const onChat = !mEdit && tab === "agent";
  const playerOpen = onChat ? playerOpenChat : playerOpenElse;
  const setPlayerOpen = (v: boolean) => (onChat ? setPlayerOpenChat(v) : setPlayerOpenElse(v));
  useEffect(() => setMEdit(false), [tab]);
  const [mode, setMode] = useState<"live" | "render">("live");
  const [safe, setSafe] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [uploads, setUploads] = useState<Record<string, number>>({});
  const [tlH, setTlH] = useState(() => Number(store.get("studio.tlh", "300")) || 300);
  const [fileDrag, setFileDrag] = useState(false);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [visibilityOpen, setVisibilityOpen] = useState(false);
  // laying the film so far out from the board (takes, else panels or a card), then playing it
  const [watching, setWatching] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const clipboard = useRef<Item[]>([]);
  // the built-in agent: a prompt started on the projects page, following its edits
  const [pending, setPending] = useState<{ text: string; attachments: Attachment[] } | null>(() => {
    try {
      const p = JSON.parse(sessionStorage.getItem("studio.agent.pending") || "null");
      return !localMode && p && p.projectId === projectId ? { text: p.text, attachments: p.attachments || [] } : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (pending) setTab("agent");
  }, []);
  const [follow, setFollowRaw] = useState(() => store.get("studio.follow", "1") === "1");
  const setFollow = useCallback((v: boolean) => (setFollowRaw(v), store.set("studio.follow", v ? "1" : "0")), []);
  const [flash, setFlash] = useState<string[]>([]);
  const followIds = useRef<string[] | null>(null);
  const flashTimer = useRef<any>(null);
  const board = useBoard(projectId);
  const drafts = useDrafts(projectId);
  const models = useModels();
  const onAgentItem = useCallback(
    (item: ChatItem) => {
      if (item.type !== "tool" || item.status !== "done" || !item.focus) return;
      const f = item.focus;
      if (f.project && f.project !== projectId) return;
      if (f.items || f.assets || f.render || f.revision !== undefined) P.load();
      if (f.quote) (P.loadQuotes(), drafts.load());
      if (f.board || f.items || f.assets) board.load();
      if (f.jobs || f.assets) drafts.load();
      const ids = [...(f.items?.added || []), ...(f.items?.changed || [])];
      if (ids.length) followIds.current = ids;
    },
    [projectId, P.load, P.loadQuotes, board.load, drafts.load],
  );
  const agent = useAgent({ projectId, active: !localMode && tab === "agent", onItem: onAgentItem, onTurn: (m) => m.project === projectId && (P.load(), board.load(), drafts.load()) });
  agentBusy.current = agent.running;
  // the board fills in while the agent works or generations run (they finish on their own clock)
  const generating = drafts.drafts.some((d) => d.status === "used" && d.jobs.some((j) => j.status === "queued" || j.status === "running"));
  useEffect(() => {
    if (!agent.running && !generating) return;
    const t = setInterval(() => (board.load(), generating && P.load()), 6000);
    return () => clearInterval(t);
  }, [agent.running, generating, board.load, P.load]);
  // and once more when the last generation lands, so its take or sheet shows at once
  const wasGenerating = useRef(false);
  useEffect(() => {
    if (wasGenerating.current && !generating) (board.load(), P.load(), refreshBilling().catch(() => {}));
    wasGenerating.current = generating;
  }, [generating]);
  const [agentMode, setAgentModeRaw] = useState<Mode>(() => (store.get(`studio.mode.${projectId}`, "work_with_me") === "just_make_it" ? "just_make_it" : "work_with_me"));
  const setAgentMode = useCallback((m: Mode) => (setAgentModeRaw(m), store.set(`studio.mode.${projectId}`, m)), [projectId]);
  // the server holds the agent's generations as drafts in Work with me: keep the board's mode in step
  useEffect(() => {
    if (tab !== "agent" || !board.data || board.data.board.brief?.mode === agentMode) return;
    board.patch({ brief: { mode: agentMode } }).catch(() => {});
  }, [tab, agentMode, board.data?.version]);
  const setPps = useCallback((v: number) => {
    const n = Math.max(4, Math.min(600, v));
    setPpsRaw(n);
    store.set("studio.pps", String(Math.round(n)));
  }, []);
  useEffect(() => store.set("studio.magnet", magnet ? "1" : "0"), [magnet]);
  useEffect(() => store.set("studio.snap", snapping ? "1" : "0"), [snapping]);
  useEffect(() => store.set("studio.tab", tab), [tab]);

  const fps = doc ? fpsOf(doc) : 30;
  const canvasAspect = doc ? (doc.settings.width > doc.settings.height ? "16:9" : doc.settings.height > doc.settings.width ? "9:16" : "other") : "other";
  const setCanvasAspect = (aspect: "16:9" | "9:16") => {
    if (!doc || canvasAspect === aspect) return;
    P.edit([{ op: "set_canvas", aspect }], aspect === "16:9" ? "landscape canvas" : "portrait canvas");
  };
  const dur = doc ? seqEnd(doc) / fps : 0;

  // drop selections that no longer exist (undo, agent edits)
  useEffect(() => {
    if (!doc) return;
    setSelection((s) => (s.every((id) => doc.sequence.items[id]) ? s : s.filter((id) => doc.sequence.items[id])));
    if (selTrn && !doc.sequence.transitions[selTrn]) setSelTrn(undefined);
  }, [doc, selTrn]);

  // notices fade on their own
  useEffect(() => {
    if (!P.notice) return;
    const t = setTimeout(() => P.setNotice(""), 6000);
    return () => clearTimeout(t);
  }, [P.notice, P.setNotice]);
  useEffect(() => {
    if (!P.error) return;
    const t = setTimeout(() => P.setError(""), 9000);
    return () => clearTimeout(t);
  }, [P.error, P.setError]);

  const seek = useCallback(
    (t: number) => {
      clock.set(Math.max(0, Math.min(t, dur)));
    },
    [clock, dur],
  );
  // show what the agent just changed: a brief glow on those clips, and the playhead there when following
  useEffect(() => {
    const ids = followIds.current;
    if (!ids || !doc) return;
    const present = ids.filter((id) => doc.sequence.items[id]);
    if (!present.length) return;
    followIds.current = null;
    setFlash(present);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash([]), 1700);
    if (follow && !playing) seek(Math.min(...present.map((id) => doc.sequence.items[id].start)) / fps + 0.001);
  }, [doc]);

  const togglePlay = useCallback(() => {
    if (!doc) return;
    setPlaying((p) => {
      if (!p) {
        if (clock.get() >= dur - 0.02) clock.set(0);
        playerRef.current?.prime();
      }
      return !p;
    });
  }, [doc, clock, dur]);

  // edit, then select whatever the batch created (new titles, pasted clips…)
  const editSelect = useCallback(
    (ops: any[], label: string) => {
      const before = new Set(Object.keys(P.docNow()?.sequence.items || {}));
      const p = P.edit(ops, label);
      const after = P.docNow();
      const created = Object.keys(after?.sequence.items || {}).filter((id) => !before.has(id));
      if (created.length) {
        setSelection(created);
        setSelTrn(undefined);
      }
      return p;
    },
    [P],
  );

  // ---------- actions ----------
  const frameNow = () => Math.round(clock.get() * fps);
  const split = () => {
    const d = P.docNow();
    if (!d) return;
    const f = frameNow();
    const main = mainTrackId(d);
    let ids = selection.length ? selection : itemsAt(d, f).filter((i) => i.trackId === main).map((i) => i.id);
    if (!ids.length) ids = itemsAt(d, f).map((i) => i.id);
    const ops = splitOps(d, ids, f);
    if (ops.length) P.edit(ops, "split");
  };
  const del = (rippleAll = false) => {
    const d = P.docNow();
    if (!d) return;
    if (selTrn) {
      P.edit([{ op: "remove_transition", id: selTrn }], "remove transition");
      setSelTrn(undefined);
      return;
    }
    if (!selection.length) return;
    const ops = rippleAll ? [{ op: "delete", items: selection, ripple: true }] : deleteOps(d, selection, magnet);
    P.edit(ops, "delete");
    setSelection([]);
  };
  const trimTo = (edge: "start" | "end") => {
    const d = P.docNow();
    if (!d) return;
    const f = frameNow();
    const main = mainTrackId(d);
    const targets = (selection.length ? selection.map((id) => d.sequence.items[id]) : itemsAt(d, f).filter((i) => i.trackId === main)).filter((it) => it && it.kind !== "captions" && f > it.start && f < endOf(it) && !trackOf(d, it.trackId)?.locked);
    if (!targets.length) return;
    const ops = targets.map((it) => ({ op: "trim", item: it.id, edge, to: { f }, ...(magnet && it.trackId === main ? { ripple: true } : {}) }));
    P.edit(ops, edge === "start" ? "trim start" : "trim end");
    if (edge === "start" && magnet && targets.some((t) => t.trackId === main)) seek(targets.find((t) => t.trackId === main)!.start / fps);
  };
  const copy = () => {
    const d = P.docNow();
    if (d) clipboard.current = selection.map((id) => structuredClone(d.sequence.items[id])).filter((i) => i && i.kind !== "captions");
  };
  const paste = () => {
    const d = P.docNow();
    if (!d || !clipboard.current.length) return;
    editSelect(placeCopiesOps(d, clipboard.current, frameNow(), magnet), "paste");
  };
  const duplicate = () => {
    const d = P.docNow();
    if (!d || !selection.length) return;
    const items = selection.map((id) => d.sequence.items[id]).filter((i) => i && i.kind !== "captions");
    if (!items.length) return;
    editSelect(placeCopiesOps(d, items, Math.max(...items.map(endOf)), magnet), "duplicate");
  };
  const addMarker = () => P.edit([{ op: "add_marker", at: { f: frameNow() }, label: `Marker ${Object.keys(P.docNow()?.sequence.markers || {}).length + 1}` }], "marker");
  const detach = (it: Item) => {
    const d = P.docNow()!;
    const t = ensureTrack(d, "audio", it.start, it.duration, { role: "dialogue" });
    editSelect([...t.ops, { op: "detach_audio", item: it.id, track: t.ref }], "detach audio");
  };
  const addTransition = useCallback(
    (from: string, to: string) => {
      const d = P.docNow();
      if (!d) return;
      const a = d.sequence.items[from],
        b = d.sequence.items[to];
      const len = Math.min(Math.round(0.5 * fps), a.duration, b.duration);
      if (len < 2) return P.setError("These clips are too short for a transition.");
      P.edit([{ op: "add_transition", from, to, preset: "dissolve", duration: { f: len } }], "transition");
      const made = Object.values(P.docNow()?.sequence.transitions || {}).find((t: any) => t.from === from && t.to === to) as any;
      if (made) {
        setSelection([]);
        setSelTrn(made.id);
      }
    },
    [P, fps],
  );
  const fit = () => {
    const w = (document.querySelector(".tl-scroll") as HTMLElement)?.clientWidth || 1000;
    setPps((w - 148 - 60) / Math.max(1, dur));
  };
  const cutEdges = () => {
    const d = P.docNow();
    if (!d) return [];
    const s = new Set<number>([0]);
    for (const it of Object.values(d.sequence.items)) if (it.kind !== "captions") (s.add(it.start), s.add(endOf(it)));
    return [...s].sort((a, b) => a - b);
  };

  // ---------- keyboard ----------
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
    if (!doc || exportOpen) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    const f = frameNow();
    const handled = () => e.preventDefault();
    if (e.code === "Space") return handled(), togglePlay();
    if (mod && k === "z") return handled(), e.shiftKey ? P.redo() : P.undo();
    if (mod && k === "y") return handled(), P.redo();
    if (mod && k === "b") return handled(), split();
    if (mod && k === "c") return handled(), copy();
    if (mod && k === "x") return handled(), copy(), del();
    if (mod && k === "v") return handled(), paste();
    if (mod && k === "d") return handled(), duplicate();
    if (mod && k === "a") return handled(), setSelection(Object.values(doc.sequence.items).filter((i) => i.kind !== "captions").map((i) => i.id));
    if (mod && k === "e") return handled(), setExportOpen(true);
    if (mod) return;
    if (k === "s") return handled(), split();
    if (k === "q") return handled(), trimTo("start");
    if (k === "w") return handled(), trimTo("end");
    if (k === "m") return handled(), addMarker();
    if (k === "n") return handled(), setSnapping((v) => !v);
    if (e.key === "Backspace" || e.key === "Delete") return handled(), del(e.shiftKey);
    if (e.key === "ArrowLeft") return handled(), seek((f - (e.shiftKey ? Math.round(fps) : 1)) / fps);
    if (e.key === "ArrowRight") return handled(), seek((f + (e.shiftKey ? Math.round(fps) : 1)) / fps);
    if (e.key === "ArrowUp") {
      handled();
      const prev = cutEdges().filter((x) => x < f).pop();
      return seek((prev ?? 0) / fps);
    }
    if (e.key === "ArrowDown") {
      handled();
      const next = cutEdges().find((x) => x > f);
      return next !== undefined && seek(next / fps);
    }
    if (e.key === "Home") return handled(), seek(0);
    if (e.key === "End") return handled(), seek(dur);
    if (e.key === "=" || e.key === "+") return handled(), setPps(pps * 1.4);
    if (e.key === "-" || e.key === "_") return handled(), setPps(pps / 1.4);
    if (e.key === "Escape") return setSelection([]), setSelTrn(undefined), setMenu(null);
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  // ---------- uploads ----------
  const onFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      try {
        const t = await api<any>(`/api/projects/${projectId}/upload`, { filename: f.name, bytes: f.size, mime: f.type || undefined });
        setUploads((u) => ({ ...u, [f.name]: 0 }));
        await putWithProgress(t.upload.url, f, t.upload.headers["Content-Type"], (p) => setUploads((u) => ({ ...u, [f.name]: p })));
        await api(`/api/projects/${projectId}/finalize`, { asset_id: t.asset_id });
        P.load();
        const kind = f.type.startsWith("video/") ? "video" : f.type.startsWith("audio/") ? "audio" : f.type.startsWith("image/") ? "image" : "file";
        offerRefs([{ asset_id: t.asset_id, name: f.name, kind, image: kind === "image" ? await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(f); }) : null }]);
      } catch (e: any) {
        P.setError(`${f.name}: ${e.message}`);
      } finally {
        setUploads((u) => {
          const n = { ...u };
          delete n[f.name];
          return n;
        });
      }
    }
  };
  const addAsset = (a: FullAsset) => {
    const d = P.docNow();
    if (!d) return;
    editSelect(addAssetOps(d, a, clock.get()), `add ${a.name}`);
  };
  const dropAsset = useCallback(
    (assetId: string, trackId: string | null, frame: number, insertIndex?: number) => {
      const d = P.docNow();
      const a = P.assets[assetId];
      if (!d || !a) return;
      editSelect(dropAssetOps(d, a, trackId, frame, magnet, insertIndex), `add ${a.name}`);
    },
    [P, magnet, editSelect],
  );

  // ---------- direct manipulation on the preview ----------
  const onTransform = useCallback(
    (id: string, patch: TransformPatch, phase: "begin" | "move" | "end") => {
      const d = P.docNow();
      const it = d?.sequence.items[id];
      if (!d || !it) return;
      if (trackOf(d, it.trackId)?.locked) return phase === "end" && P.setError("That track is locked.");
      if (phase === "begin") return P.beginPreview();
      let ops: any[];
      if (it.kind === "title") {
        const style: any = {};
        if (patch.pos) style.pos = patch.pos;
        if (patch.scale !== undefined) style.scale = patch.scale;
        ops = [{ op: "set", item: id, style }];
      } else {
        const lf = Math.max(0, Math.min(it.duration, frameNow() - it.start));
        const visual: any = {};
        for (const key of ["x", "y", "scale"] as const) if (patch[key] !== undefined) visual[key] = animSet(it.visual?.[key], patch[key]!, lf);
        ops = [{ op: "set", item: id, visual }];
      }
      if (phase === "move") P.preview(ops);
      else if (Object.keys(patch).length) P.edit(ops, "transform");
      else P.endPreview();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [P, fps],
  );
  const onSelectFromPlayer = useCallback((id?: string) => {
    setSelection(id ? [id] : []);
    setSelTrn(undefined);
  }, []);
  const onItemMenu = useCallback((e: React.MouseEvent, id: string) => {
    setSelection((s) => (s.includes(id) ? s : [id]));
    setMenu({ x: e.clientX, y: e.clientY, id });
  }, []);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  const cueList = useMemo(() => {
    if (!doc) return [];
    const cap = Object.values(doc.sequence.items).find((i) => i.kind === "captions");
    if (!cap) return [];
    const list = cues(captionWords(doc, cap, P.assets, P.transcripts), cap.style?.maxWords || 3);
    const spans = cueSpans(list);
    return list.map((c: any[], k: number) => ({ s: spans[k][0], e: spans[k][1], text: c.map((w: any) => w.text).join(" ") }));
  }, [doc, P.assets, P.transcripts]);

  // ---------- splitter ----------
  // names for files in drafts and pickers: what they are on the board, else their file names
  const namesOnBoard = useMemo(() => boardNames(board.data?.board), [board.data?.version]);
  const nameOf = useCallback(
    (id: string) => {
      if (id.startsWith("pending:")) {
        const d = drafts.byId[id.slice(8)];
        return `${d?.title || "Storyboard sheet"} (made first)`;
      }
      return namesOnBoard[id] || P.assets[id]?.name || drafts.media[id]?.name || board.data?.media[id]?.name || id;
    },
    [namesOnBoard, P.assets, drafts.media, drafts.byId, board.data],
  );
  const pickAssets = useMemo(() => P.assetList.filter((a) => !a.roles?.includes("render")).map((a) => ({ id: a.id, kind: a.kind, name: a.name, poster: a.kind === "image" ? a.proxy || a.poster : a.poster, status: a.status, roles: a.roles, url: a.proxy, duration: a.duration_s })), [P.assetList]);
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const y0 = e.clientY,
      h0 = tlH;
    const mv = (ev: PointerEvent) => setTlH(Math.max(170, Math.min(window.innerHeight * 0.72, h0 - (ev.clientY - y0))));
    const up = () => {
      window.removeEventListener("pointermove", mv);
      setTlH((h) => (store.set("studio.tlh", String(Math.round(h))), h));
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up, { once: true });
  };

  const [fx, setFx] = useState<{ id: string; filter: string; afilter: string; err: string } | null>(null);
  if (!doc || !P.payload)
    return (
      <div className="center muted">
        {P.error ? (
          <span className="error">{P.error}</span>
        ) : (
          <>
            <Loader2 size={16} className="spin" /> Loading project…
          </>
        )}
      </div>
    );

  const renders = P.assetList.filter((a) => a.roles?.includes("render")).sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  const activeJobs = P.jobs.filter((j) => j.status === "queued" || j.status === "running");
  // the custom-filter editor (power users and agents: an ffmpeg chain per item, see server/timeline/fx.mjs)
  const saveFx = () => {
    if (!fx) return;
    const it = doc.sequence.items[fx.id];
    if (!it) return setFx(null);
    const op: Record<string, unknown> = { op: "set", item: fx.id };
    try {
      const pic = it.kind === "image" || P.assets[it.asset || ""]?.kind === "video";
      if (pic && fx.filter.trim() !== (it.filter || "")) op.filter = cleanFilter(fx.filter, "video") ?? null;
      if (it.kind === "clip" && hasAudio(P.assets[it.asset || ""]) && fx.afilter.trim() !== (it.afilter || "")) op.afilter = cleanFilter(fx.afilter, "audio") ?? null;
    } catch (e: any) {
      return setFx({ ...fx, err: e.message });
    }
    if (Object.keys(op).length > 2) P.edit([op], "custom look");
    setFx(null);
  };
  const menuItem = menu ? doc.sequence.items[menu.id] : undefined;
  const menuAsset = menuItem?.asset ? P.assets[menuItem.asset] : undefined;
  const nextOnTrack = menuItem ? Object.values(doc.sequence.items).find((i) => i.trackId === menuItem.trackId && i.start === endOf(menuItem)) : undefined;

  // ---------- the agent panel ----------
  // What the agent sees of the editor with each message: the project, the playhead, the selection.
  const agentContext = () => {
    const d = P.docNow() || doc;
    const its = selection.map((id) => d.sequence.items[id]).filter(Boolean).slice(0, 8);
    const desc = its.map((it) => {
      const a = it.asset ? P.assets[it.asset] : undefined;
      const what = it.kind === "title" ? `title “${(it.text || "").replace(/[“”\n]/g, " ").slice(0, 40)}”` : it.kind === "captions" ? "captions" : `${it.kind} “${(a?.name || it.name || it.id).replace(/[“”\n]/g, " ")}”`;
      return `${it.id} (${what}, ${(it.start / fps).toFixed(2)}–${((it.start + it.duration) / fps).toFixed(2)} s)`;
    });
    const line =
      `[Editor] project ${projectId} “${P.payload!.project.name.replace(/[“”\n]/g, " ")}” · revision ${P.revision} · ${d.settings.width}×${d.settings.height} · ${dur.toFixed(1)} s long · playhead ${clock.get().toFixed(2)} s` +
      (desc.length ? ` · selected: ${desc.join(", ")}` : " · nothing selected");
    return [line.slice(0, 1500)];
  };
  const contextLabel = selection.length ? `Sees ${selection.length} selected` : "Sees the timeline";
  const agentUpload = async (files: File[], onProgress: (name: string, p: number) => void) => {
    const out: Attachment[] = [];
    for (const f of files) {
      try {
        out.push(await uploadFile(projectId, f, (p) => onProgress(f.name, p)));
      } catch (e: any) {
        P.setError(`${f.name}: ${e.message}`);
      }
    }
    P.load();
    return out;
  };
  const restoreTo = async (revision: number) => {
    await api(`/api/projects/${projectId}/history`, { action: "restore", revision });
    await P.load();
  };
  // picking a take on the board: swap it in where the storyboard sits, or add it at the end
  const playFromStart = () => {
    clock.set(0);
    playerRef.current?.prime();
    setPlaying(true);
  };
  const watchThrough = async (play = true) => {
    setWatching(true);
    try {
      await api(`/api/projects/${projectId}/preview`, {});
      await P.load();
      board.load();
      if (play) playFromStart();
    } catch (e: any) {
      P.setError(e.message || "Couldn't lay it out");
    } finally {
      setWatching(false);
    }
  };
  const useTake = async (sb: Storyboard, assetId: string) => {
    // once the piece is laid out to watch, a chosen take goes into its storyboard's slot
    if (board.data?.board.preview?.items?.length) {
      await board.patch({ storyboards: [{ id: sb.id, chosen: assetId }] });
      return watchThrough(false);
    }
    if (!P.assets[assetId]) await P.load();
    const d = P.docNow();
    const a = P.assets[assetId];
    if (!d || !a) return P.setError("That take isn't ready yet.");
    const it = Object.values(d.sequence.items).find((i) => i.asset && (sb.takes || []).includes(i.asset));
    if (it) await P.edit([{ op: "replace_media", item: it.id, asset: assetId }], `use take for storyboard ${sb.id}`);
    else await P.edit(addAssetOps(d, a, seqEnd(d) / fpsOf(d)), `add storyboard ${sb.id}`);
    board.load();
  };
  const sourceMedia = P.assetList.filter((a) => !a.roles?.includes("render"));
  const hasClips = Object.values(doc.sequence.items).some((i) => i.kind !== "captions");
  const storyboards = board.data?.board.storyboards || [];
  const suggestions = storyboards.length && !hasClips
    ? ["Put the best takes on the timeline in story order", "Make the next storyboard", "Add music and sound, then finish it"]
    : !sourceMedia.length && !hasClips
    ? ["A 30-second story: a lighthouse keeper finds a robot washed up on the rocks", "A 15-second ad for my product (I'll drop a photo)", "A moody 20-second trailer for a sci-fi short"]
    : !hasClips
      ? ["Cut this into a 45-second short with captions", "Make a 30-second teaser from my footage", "Put my clips in order and tighten the pauses"]
      : ["Tighten the pauses and remove filler words", "Add readable captions", "Add music under it, quieter under speech", "Look over the edit and fix what's off"];

  return (
    <div
      className={`editor2 ${mobile ? `mobile m-${mEdit ? "edit" : tab} ${playerOpen ? "" : "player-folded"}` : ""}`}
      style={{ gridTemplateRows: `auto ${P.quotes.length ? "auto " : ""}minmax(0,1fr)` }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setFileDrag(true);
        }
      }}
      onDragLeave={(e) => e.relatedTarget === null && setFileDrag(false)}
      onDrop={(e) => {
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          setFileDrag(false);
          // the same as dropping on the chat: into the project, as references for the agent
          if (localMode) {
            void agentUpload(Array.from(e.dataTransfer.files), (name, progress) => setUploads((u) => ({ ...u, [name]: progress })));
            setTab("media");
          } else {
            offerFiles(Array.from(e.dataTransfer.files));
            setTab("agent");
          }
        }
      }}
    >
      <header className="ed-top">
        <button className="icon ed-home" title="FOLTIO · all projects" onClick={() => navigate("/")}>
          <FoltioMark className="foltio-mark" />
        </button>
        {name === null ? (
          <strong className="proj-name" title="Click to rename" onClick={() => setName(P.payload!.project.name)}>
            {P.payload.project.name}
          </strong>
        ) : (
          <input
            className="proj-name-input"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={async () => {
              if (name.trim() && name !== P.payload!.project.name) await api(`/api/projects/${projectId}`, { name }).catch((e) => P.setError(e.message));
              setName(null);
              P.load();
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        )}
        <span className="pill ed-canvas" title="Canvas — ask your agent to change it (“make it vertical”)">
          {doc.settings.width}×{doc.settings.height} · {+fps.toFixed(3)} fps
        </span>
        <div className="visibility-ctl">
          <button className={`ed-visibility ${P.payload?.project.public ? "public" : "private"}`} onClick={() => setVisibilityOpen(!visibilityOpen)} title={P.payload?.project.public ? "Public — anyone with the link can watch and clone" : "Private — only you can open this project"}>
            {P.payload?.project.public ? <Globe2 size={13} /> : <LockKeyhole size={13} />}
            <span className="ed-vis-label">{P.payload?.project.public ? "Public" : "Private"}</span><ChevronDown size={11} />
          </button>
          {visibilityOpen && (
            <div className="float ed-vis-menu" onMouseLeave={() => setVisibilityOpen(false)}>
              <span className="micro">Who can see this?</span>
              <button className={P.payload?.project.public ? "on" : ""} onClick={() => api(`/api/projects/${projectId}`, { public: true }).then(() => (setVisibilityOpen(false), P.load())).catch((e) => P.setError(e.message))}>
                <Globe2 size={15} /><span><strong>Public</strong><small>Anyone with the link can watch and clone it.</small></span>{P.payload?.project.public && <Check size={13} />}
              </button>
              <button className={!P.payload?.project.public ? "on" : ""} onClick={() => api(`/api/projects/${projectId}`, { public: false }).then(() => (setVisibilityOpen(false), P.load())).catch((e) => P.setError(e.message))}>
                <LockKeyhole size={15} /><span><strong>Private</strong><small>Only you can open this project.</small></span>{!P.payload?.project.public && <Check size={13} />}
              </button>
              {P.payload?.project.public && <a href={`/v/${projectId}`} target="_blank" rel="noreferrer">Open public page · <span className="num">{P.payload.project.clones ?? 0}</span> clone{P.payload.project.clones === 1 ? "" : "s"}</a>}
            </div>
          )}
        </div>
        <span className={`save-state ${P.saving ? "saving" : ""}`} title={`Revision ${P.revision}`}>
          {P.saving ? "Saving" : "Saved"}
          <span className="num">r{P.revision}</span>
        </span>
        {!localMode && agent.running && (
          <span className="ed-agent" onClick={() => setTab("agent")} title="Your agent is working on this project">
            <span className="ed-agent-dot" /> Agent working
            <button className="icon xs" title="Stop the agent" onClick={(e) => (e.stopPropagation(), agent.stop())}>
              <Square size={10} fill="currentColor" />
            </button>
          </span>
        )}
        <div className="grow" />
        {!localMode && <EditorBillingMenu />}
        {!localMode && <button className="btn small primary ed-feedback" onClick={openFeedback} title="Request a feature or share feedback">
          <MessageSquareText size={13} /> <span>Feedback</span>
        </button>}
        <div className="jobs-ctl">
          <button className={`btn small ghost ed-jobs ${activeJobs.length ? "busy" : ""}`} onClick={() => setJobsOpen(!jobsOpen)} title="Background jobs: uploads processing, transcripts, renders, generations">
            {activeJobs.length ? <Loader2 size={13} className="spin" /> : <Activity size={13} />} {activeJobs.length ? <span><span className="num">{activeJobs.length}</span> running</span> : "Jobs"}
          </button>
          {jobsOpen && (
            <div className="popover jobs" onMouseLeave={() => setJobsOpen(false)}>
              <div className="jobs-head">
                <span className="micro">Jobs</span>
                <span className="muted small">{activeJobs.length ? `${activeJobs.length} running` : "All done"}</span>
              </div>
              {P.jobs.length === 0 && <p className="jobs-empty muted small">Uploads, transcripts, generations and exports show up here.</p>}
              {P.jobs.slice(0, 14).map((j) => (
                <div key={j.id} className={`job ${j.status}`} title={j.error?.message || j.id}>
                  <span className={`job-dot ${j.status}`} />
                  <span className="job-kind">{jobLabel(j.kind)}</span>
                  <span className="job-state num">{j.status === "running" ? `${Math.round(j.progress * 100)}%` : j.status === "failed" ? "failed" : j.status === "queued" ? "queued" : relTime(j.updated_at)}</span>
                  {j.status === "running" && (
                    <div className="meter">
                      <div style={{ width: `${Math.round(j.progress * 100)}%` }} />
                    </div>
                  )}
                  {j.status === "failed" && j.error?.message && <span className="job-err">{j.error.message}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
        <button className="btn primary" onClick={() => setExportOpen(true)} disabled={dur <= 0}>
          <Download size={14} /> <span className="lbl">Export</span>
        </button>
      </header>
      {P.quotes.length > 0 && (
        <div className="approvals">
          {P.quotes.map((qt) => (
            <div key={qt.id} className="approval">
              <span className="approval-icon">
                <Sparkles size={14} />
              </span>
              <div className="approval-text">
                <strong>
                  Your agent wants to generate with {qt.model}
                </strong>
                {qt.request?.prompt ? <span className="muted">“{String(qt.request.prompt).slice(0, 140)}”</span> : <span className="muted">Above your auto-approve limit, so it waits for you.</span>}
              </div>
              <span className="approval-price num">{credits(Number(qt.cost_usd))}</span>
              <button className="btn small ghost" onClick={() => api(`/api/quotes/${qt.id}/deny`, {}).then(P.loadQuotes).catch((e) => P.setError(e.message))}>
                Decline
              </button>
              <button className="btn small tally" onClick={() => api(`/api/quotes/${qt.id}/approve`, {}).then(P.loadQuotes).catch((e) => P.setError(e.message))}>
                <Check size={13} /> Approve {credits(Number(qt.cost_usd))}
              </button>
            </div>
          ))}
        </div>
      )}
      <div className={`ed-body ${tab === "agent" || tab === "board" ? "wide-panel" : ""}`}>
        <nav className="rail">
          {tabs.map((t) => (
            <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)} title={t.label}>
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
        {tab === "board" ? (
          <aside className="panel-col board-col">
          <StoryView
            focusClip={focusClip}
            board={board}
            drafts={drafts}
            models={models}
            assets={pickAssets}
            nameOf={nameOf}
            onUseTake={useTake}
            onWatch={() => watchThrough(true)}
            watching={watching}
            onSend={(t) => localMode ? P.setNotice("Connect an external agent from the Connect page, then send it this instruction.") : (setTab("agent"), agent.send(t))}
            aspect={`${doc.settings.width}×${doc.settings.height}`}
            selectedAssets={selection.map((id) => doc.sequence.items[id]?.asset).filter((a): a is string => !!a)}
            onSelectAsset={(a) => {
              const it = Object.values(doc.sequence.items).find((i) => i.asset === a);
              if (it) setSelection([it.id]);
            }}
          />
          </aside>
        ) : tab === "agent" && !localMode ? (
          <aside className="panel-col agent-col">
            <AgentPanel
              agent={agent}
              board={board}
              drafts={drafts}
              models={models}
              assets={pickAssets}
              nameOf={nameOf}
              projectId={projectId}
              jobs={P.jobs}
              context={agentContext}
              contextLabel={contextLabel}
              upload={agentUpload}
              onRestore={restoreTo}
              onUseTake={useTake}
              follow={follow}
              setFollow={setFollow}
              mode={agentMode}
              setMode={setAgentMode}
              suggestions={suggestions}
              pending={pending}
              onWatch={() => watchThrough(true)}
              onPlay={playFromStart}
              watching={watching}
              refreshAssets={() => P.load()}
              onPendingSent={() => {
                sessionStorage.removeItem("studio.agent.pending");
                setPending(null);
              }}
            />
          </aside>
        ) : (
        <aside className="panel-col">
          <div className="panel-title">{TABS.find((t) => t.id === tab)?.label}</div>
          <div className="panel-scroll">
            <Library board={board.data?.board} projectId={projectId} doc={doc} assets={P.assetList} uploads={uploads} onFiles={onFiles} onAdd={addAsset} reload={P.load} setError={P.setError} />
          </div>
        </aside>
        )}
        {/* the work area: the preview over the timeline, beside the full-height panel */}
        <div className="ed-work" style={{ gridTemplateRows: `minmax(0,1fr) 6px ${tlH}px` }}>
        <div className="ed-stage">
        {/* the agent panel opens board items (bibles, music, storyboards) over the preview here */}
        <div id="board-stage" className="board-stage-host" />
        {mobile && (
          <button className="m-fold icon" onClick={() => setPlayerOpen(!playerOpen)} title={playerOpen ? "Fold the player" : "Show the player"}>
            {playerOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          </button>
        )}
        <section className="viewer2" ref={viewerRef}>
          <div className="viewer-stage">
            {mode === "live" ? (
              <Player ref={playerRef} doc={doc} assets={P.assets} transcripts={P.transcripts} clock={clock} playing={playing} onEnded={() => setPlaying(false)} showSafe={safe} selectedId={selection.length === 1 ? selection[0] : undefined} onSelect={onSelectFromPlayer} onTransform={onTransform} />
            ) : renders[0]?.proxy ? (
              <div className="render-view">
                <video src={renders[0].proxy!} controls playsInline />
                <span className="render-badge">
                  {renders[0].origin?.quality === "final" ? "Final" : "Draft"} export of r{renders[0].origin?.revision}
                  {renders[0].origin?.revision !== P.revision ? ` · the timeline has changed since (r${P.revision})` : ""}
                </span>
              </div>
            ) : (
              <div className="render-view empty">
                <p className="muted">No exports yet.</p>
                <button className="btn" onClick={() => setExportOpen(true)}>
                  Export
                </button>
              </div>
            )}
            {view === "preview" && Object.values(doc.sequence.items).filter((i) => i.kind !== "captions").length === 0 && mode === "live" && (
              <div className="viewer-empty">
                <span className="viewer-empty-icon">
                  <Upload size={18} />
                </span>
                <p>Drop footage here, or add media from the library</p>
                <p className="muted small">Or ask your agent: “cut a 30-second teaser from my clips”</p>
              </div>
            )}
          </div>
          <div className="transport2">
            <div className="t-left">
              <TimeReadout clock={clock} fps={fps} dur={dur} />
            </div>
            <div className="t-mid">
              <button className="icon" title="Start (Home)" onClick={() => seek(0)}>
                <SkipBack size={16} />
              </button>
              <button className="icon" title="Previous frame (←)" onClick={() => seek((frameNow() - 1) / fps)}>
                <ChevronLeft size={16} />
              </button>
              <button className="play-btn" title="Play / pause (Space)" onClick={togglePlay}>
                {playing ? <Pause size={18} /> : <Play size={18} />}
              </button>
              <button className="icon" title="Next frame (→)" onClick={() => seek((frameNow() + 1) / fps)}>
                <ChevronRight size={16} />
              </button>
              <button className="icon" title="End (End)" onClick={() => seek(dur)}>
                <SkipForward size={16} />
              </button>
            </div>
            <div className="t-right">
              {view === "preview" && <div className="seg small aspect-toggle" aria-label="Video orientation">
                <button className={canvasAspect === "16:9" ? "on" : ""} onClick={() => setCanvasAspect("16:9")} title="Landscape 16:9">
                  16:9
                </button>
                <button className={canvasAspect === "9:16" ? "on" : ""} onClick={() => setCanvasAspect("9:16")} title="Portrait 9:16">
                  9:16
                </button>
              </div>}
              {view === "preview" && <div className="seg small view-toggle">
                <button className={mode === "live" ? "on" : ""} onClick={() => setMode("live")} title="Live preview of the timeline">
                  Live
                </button>
                <button className={mode === "render" ? "on" : ""} onClick={() => (setMode("render"), setPlaying(false))} title="The last exported MP4">
                  Export
                </button>
              </div>}
              <button className={`icon ${safe ? "on" : ""}`} title="Show platform safe zones" onClick={() => setSafe(!safe)}>
                <ScanLine size={16} />
              </button>
              <button className="icon" title="Full screen" onClick={() => viewerRef.current?.requestFullscreen?.()}>
                <Expand size={16} />
              </button>
            </div>
          </div>
        </section>
        </div>
      <div className="splitter" onPointerDown={startResize} title="Drag to resize the timeline" />
      <div className="tl-area">
        <div className="tl-toolbar">
          <button className="icon" title="Undo (⌘Z)" onClick={P.undo} disabled={P.revision === 0}>
            <Undo2 size={16} />
          </button>
          <button className="icon" title="Redo (⇧⌘Z)" onClick={P.redo} disabled={!P.canRedo}>
            <Redo2 size={16} />
          </button>
          <span className="vsep" />
          <button className="icon" title="Split at playhead (S)" onClick={split}>
            <Scissors size={16} />
          </button>
          <button className="icon" title="Trim start to playhead (Q)" onClick={() => trimTo("start")}>
            <ArrowLeftToLine size={16} />
          </button>
          <button className="icon" title="Trim end to playhead (W)" onClick={() => trimTo("end")}>
            <ArrowRightToLine size={16} />
          </button>
          <button className="icon" title="Delete (⌫)" onClick={() => del()} disabled={!selection.length && !selTrn}>
            <Trash2 size={16} />
          </button>
          <button className="icon" title="Duplicate (⌘D)" onClick={duplicate} disabled={!selection.length}>
            <CopyPlus size={16} />
          </button>
          <button className="icon" title="Add marker (M)" onClick={addMarker}>
            <Bookmark size={16} />
          </button>
          <span className="vsep" />
          <button className={`icon ${magnet ? "on" : ""}`} title={`Magnetic main track: ${magnet ? "on" : "off"} — clips on the main track stay packed together`} onClick={() => setMagnet(!magnet)}>
            <Magnet size={16} />
          </button>
          <button className={`icon ${snapping ? "on" : ""}`} title={`Snapping: ${snapping ? "on" : "off"} (N)`} onClick={() => setSnapping(!snapping)}>
            <Crosshair size={16} />
          </button>
          <span className="sel-info">{selection.length ? `${selection.length} selected` : selTrn ? "Transition selected" : ""}</span>
          <div className="grow" />
          <button className="icon" title="Zoom out (−)" onClick={() => setPps(pps / 1.4)}>
            <ZoomOut size={16} />
          </button>
          <input className="zoom" type="range" min={Math.log(4)} max={Math.log(600)} step={0.01} value={Math.log(pps)} onChange={(e) => setPps(Math.exp(Number(e.target.value)))} title="Zoom (⌘-scroll on the timeline)" />
          <button className="icon" title="Zoom in (+)" onClick={() => setPps(pps * 1.4)}>
            <ZoomIn size={16} />
          </button>
          <button className="btn small ghost" title="Fit the whole edit" onClick={fit}>
            <Maximize2 size={13} /> Fit
          </button>
        </div>
        <Timeline
          doc={doc}
          assets={P.assets}
          clock={clock}
          playing={playing}
          pps={pps}
          setPps={setPps}
          selection={selection}
          setSelection={setSelection}
          selectedTransition={selTrn}
          setSelectedTransition={setSelTrn}
          magnet={magnet}
          snapping={snapping}
          cueList={cueList}
          onSeek={seek}
          edit={P.edit}
          preview={P.preview}
          beginPreview={P.beginPreview}
          endPreview={P.endPreview}
          onDropAsset={dropAsset}
          onItemMenu={onItemMenu}
          onAddTransition={addTransition}
          flash={flash}
        />
      </div>
        </div>
      </div>
      {fx && (
        <div className="fx-veil" onPointerDown={(e) => e.target === e.currentTarget && setFx(null)}>
          <div className="fx-card" role="dialog" aria-label="Custom look">
            <strong>Custom look (fx)</strong>
            <p className="muted small">An ffmpeg filter chain for this clip, e.g. <code>eq=contrast=1.15:saturation=0.85,vignette,noise=alls=8:allf=t</code>. The export applies it; the preview plays a baked copy once it's ready. Leave empty to remove it.</p>
            {(doc.sequence.items[fx.id]?.kind === "image" || P.assets[doc.sequence.items[fx.id]?.asset || ""]?.kind === "video") && (
              <label>
                <span className="micro">Picture</span>
                <textarea rows={2} value={fx.filter} onChange={(e) => setFx({ ...fx, filter: e.target.value, err: "" })} onKeyDown={(e) => e.stopPropagation()} placeholder="eq=contrast=1.1,colortemperature=temperature=5200" />
              </label>
            )}
            {doc.sequence.items[fx.id]?.kind === "clip" && hasAudio(P.assets[doc.sequence.items[fx.id]?.asset || ""]) && (
              <label>
                <span className="micro">Sound</span>
                <textarea rows={2} value={fx.afilter} onChange={(e) => setFx({ ...fx, afilter: e.target.value, err: "" })} onKeyDown={(e) => e.stopPropagation()} placeholder="afftdn=nr=12,highpass=f=80" />
              </label>
            )}
            {fx.err && <p className="error small">{fx.err}</p>}
            <div className="fx-row">
              <button className="btn ghost small" onClick={() => setFx(null)}>
                Cancel
              </button>
              <button className="btn primary small" onClick={saveFx}>
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
      {mobile && (
        <nav className="m-tabs">
          {tabs.map((t) => (
            <button key={t.id} className={!mEdit && tab === t.id ? "on" : ""} onClick={() => (setTab(t.id), setMEdit(false))}>
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
          <button className={mEdit ? "on" : ""} onClick={() => setMEdit(true)}>
            <Scissors size={18} />
            <span>Edit</span>
          </button>
        </nav>
      )}
      {menu && menuItem && (
        <div className="menu ctx" style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 320) }} onPointerDown={(e) => e.stopPropagation()}>
          <button onClick={() => (split(), setMenu(null))}>
            Split at playhead <kbd>S</kbd>
          </button>
          <button onClick={() => (duplicate(), setMenu(null))}>
            Duplicate <kbd>⌘D</kbd>
          </button>
          <button onClick={() => (copy(), setMenu(null))}>
            Copy <kbd>⌘C</kbd>
          </button>
          <button disabled={!clipboard.current.length} onClick={() => (paste(), setMenu(null))}>
            Paste at playhead <kbd>⌘V</kbd>
          </button>
          {menuItem.kind === "clip" && trackOf(doc, menuItem.trackId)?.kind === "video" && hasAudio(menuAsset) && menuItem.audio?.enabled !== false && <button onClick={() => (detach(menuItem), setMenu(null))}>Detach audio</button>}
          {nextOnTrack && trackOf(doc, menuItem.trackId)?.kind === "video" && !Object.values(doc.sequence.transitions).some((t: any) => t.from === menuItem.id) && <button onClick={() => (addTransition(menuItem.id, nextOnTrack.id), setMenu(null))}>Add transition to next clip</button>}
          {(menuItem.kind === "image" || (menuItem.kind === "clip" && (menuAsset?.kind === "video" || hasAudio(menuAsset)))) && (
            <button onClick={() => (setFx({ id: menuItem.id, filter: menuItem.filter || "", afilter: menuItem.afilter || "", err: "" }), setMenu(null))}>
              {menuItem.filter || menuItem.afilter ? "Edit custom look (fx)…" : "Custom look (fx)…"}
            </button>
          )}
          <button onClick={() => (navigator.clipboard?.writeText(menuItem.id), setMenu(null))}>Copy id for your agent</button>
          <hr />
          <button className="danger" onClick={() => (del(), setMenu(null))}>
            Delete <kbd>⌫</kbd>
          </button>
          <button className="danger" onClick={() => (del(true), setMenu(null))}>
            Ripple delete <kbd>⇧⌫</kbd>
          </button>
        </div>
      )}
      {fileDrag && (
        <div className="file-drop" onDragLeave={() => setFileDrag(false)}>
          <Upload size={28} />
          <p>Drop to upload to this project</p>
        </div>
      )}
      {(P.error || P.notice) && (
        <div className={`toast ${P.error ? "error" : ""}`} onClick={() => (P.setError(""), P.setNotice(""))}>
          {P.error || P.notice}
        </div>
      )}
      {exportOpen && <ExportDialog projectId={projectId} doc={doc} revision={P.revision} assets={P.assetList} jobs={P.jobs} onClose={() => setExportOpen(false)} reload={P.load} />}
    </div>
  );
}
