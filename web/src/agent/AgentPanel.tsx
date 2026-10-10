import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CornerDownLeft, ArrowUp, Square, Plus, ChevronDown, Paperclip, X, Check, Loader2, AlertTriangle, Terminal, FileCode, Undo2, Crosshair, Clapperboard, Image as ImageIcon, ChevronRight, Archive, Sparkles, Play, Cpu, Ban } from "lucide-react";
import { api } from "../api";
import { Markdown } from "./Markdown";
import { BoardStrip, BoardDetail, onBoardItem, type BoardApi, type BoardFocus, type Storyboard } from "./Board";
import { PlanCard, StoryCard } from "./Cards";
import { isOpen, draftName, type Draft, type DraftsApi, type ModelSpec, type PickAsset } from "./Drafts";
import { Dock, DraftDetails, dockItems, dockPlaceholder, optionsOf, cleanLabel, type DockItem } from "./Dock";
import type { AgentApi, Answer, ChatItem, Picture } from "./useAgent";
import { PlayButton } from "./Play";
import { BoardItems, WithItems } from "./Items";
import { takeRefs, takeFiles, type MediaRef } from "./view";
import { DecisionsStrip } from "./Decisions";
import { credits } from "../credits";

export type Attachment = { asset_id: string; name: string; kind: string };
export type Mode = "work_with_me" | "just_make_it";
type Uploading = { key: string; name: string; progress: number; done?: Attachment; error?: string; image?: string };
type ToolItem = Extract<ChatItem, { type: "tool" }>;

// A reply can end with "Choices: A | B | C"; the panel shows those as buttons that answer for you.
const CHOICES = /\n?\s*(?:\*\*)?(?:Choices|Options)(?:\*\*)?:\s*(.+?)\s*$/i;
export function splitChoices(text: string): { text: string; choices: string[] } {
  const m = text.match(CHOICES);
  if (!m) return { text, choices: [] };
  // split on "|"; "·" separates only when there's no "|" (it often sits inside an option: "Look A · Stormlight")
  const choices = m[1].split(m[1].includes("|") ? /\s*\|\s*/ : /\s*·\s*/).map((c) => c.replace(/^[\[\(]|[\]\)]$/g, "").trim()).filter((c) => c && c.length <= 80).slice(0, 5);
  return choices.length >= 2 ? { text: text.slice(0, m.index).trimEnd(), choices } : { text, choices: [] };
}

const money = (n?: number) => n === undefined || n === null ? "" : credits(n);
const clock = (s: number) => (s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`);
const elapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// A downscaled JPEG of a picked image, for the model to see (the file itself is uploaded as media).
async function previewOf(file: File): Promise<string | undefined> {
  if (!file.type.startsWith("image/") || file.size > 20 * 2 ** 20) return undefined;
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return undefined;
  const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85);
}

function Lightbox({ pic, onClose }: { pic: Picture; onClose: () => void }) {
  return (
    <div className="ag-lightbox" onClick={onClose}>
      <figure onClick={(e) => e.stopPropagation()}>
        {pic.kind === "video" ? <video src={pic.url} controls autoPlay playsInline /> : pic.kind === "audio" ? <audio src={pic.url} controls autoPlay /> : <img src={pic.url} alt={pic.label} />}
        <figcaption>{pic.label}</figcaption>
      </figure>
      <button className="icon" onClick={onClose} title="Close">
        <X size={18} />
      </button>
    </div>
  );
}

// One step of the work: a line with what happened; details, pictures and decisions only when they matter.
function Step({ item, onPicture, plan, onWatch }: { item: ToolItem; onPicture: (p: Picture) => void; plan?: React.ReactNode; onWatch?: () => void }) {
  const [open, setOpen] = useState(false);
  const jobs = item.focus?.jobList || [];
  const more = !!(item.warnings?.length || item.error || jobs.length);
  return (
    <div className={`ag-step ${item.status}`}>
      <button className="ag-step-row" onClick={() => more && setOpen(!open)} disabled={!more}>
        <span className="ag-glyph">{item.status === "running" ? <Loader2 size={12} className="spin" /> : item.status === "failed" ? <AlertTriangle size={12} /> : <Check size={12} />}</span>
        <span className="ag-step-title">{item.title}</span>
        {item.detail && <span className="ag-step-detail"><WithItems text={item.detail} /></span>}
        {item.status === "failed" && <span className="ag-step-state">Didn't work</span>}
        {more && <ChevronRight size={11} className={`ag-step-more ${open ? "rot" : ""}`} />}
      </button>
      {item.error && open && <div className="ag-step-error open">{item.error}</div>}
      {open && jobs.length > 0 && <JobList jobs={jobs} onPicture={onPicture} />}
      {open && item.warnings?.length ? <ul className="ag-warn">{item.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul> : null}
      {item.images?.length > 0 && (
        <div className="ag-strip">
          {item.images.map((p, i) => (
            <button key={i} onClick={() => onPicture(p)} title={p.label}>
              <img src={p.url} alt={p.label} />
            </button>
          ))}
        </div>
      )}
      {plan}
      {item.focus?.preview && onWatch && (
        <button className="btn small ag-watch" onClick={onWatch} title="Play it from the start on the preview">
          <Play size={12} /> Watch the film so far · {Math.round(item.focus.preview.seconds)} s
        </button>
      )}
      {item.links?.length > 0 && (
        <div className="ag-links">
          {item.links.map((l) => (
            <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="btn small">
              {l.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// Steps that only gather context fold into one line.
const QUIET = new Set(["agent_step", "studio_status", "studio_guide", "project_list", "project_get", "media_list", "gen_models", "job_wait", "share", "board_get", "list_mcp_resources", "read_mcp_resource"]);
const isQuiet = (it: ChatItem) =>
  it.type === "tool" && !it.images?.length && !it.focus?.quote && !it.focus?.render && !it.focus?.plan && !it.focus?.story && (QUIET.has(it.tool) || it.tool === "media_inspect" || it.title === "Tried an edit");
// A draft the agent prepared for you to review (Work with me): shown as an editable card.
const isDraftStep = (it: ChatItem): boolean => it.type === "tool" && it.tool === "gen_quote" && it.status === "done" && it.focus?.quote?.policy === "review";
type Row = { kind: "item"; item: ChatItem } | { kind: "group"; id: string; items: ToolItem[] } | { kind: "drafts"; id: string; items: ToolItem[] } | { kind: "made"; id: string; ids: string[] };
function rows(items: ChatItem[]): Row[] {
  const out: Row[] = [];
  const shown = new Set<string>();
  for (const it of items) {
    const last = out[out.length - 1];
    // what a generation made shows once, as pictures and players, right after the step that saw it land
    const made = it.type === "tool" ? (it.focus?.made || []).filter((x) => !shown.has(x)) : [];
    made.forEach((x) => shown.add(x));
    if (made.length) {
      pushItem(out, it);
      out.push({ kind: "made", id: `m-${it.id}`, ids: made });
      continue;
    }
    if (isDraftStep(it)) {
      // one line per draft; a revision of a draft already shown replaces it
      const t = it as ToolItem;
      const id = t.focus!.quote!.id;
      for (const r of out) if (r.kind === "drafts") r.items = r.items.filter((x) => x.focus?.quote?.id !== id);
      if (last?.kind === "drafts") last.items.push(t);
      else out.push({ kind: "drafts", id: `d-${t.id}`, items: [t] });
      continue;
    }
    pushItem(out, it);
  }
  return out.filter((r) => r.kind !== "drafts" || r.items.length);
}
function pushItem(out: Row[], it: ChatItem) {
  const last = out[out.length - 1];
  if (isQuiet(it)) {
    if (last?.kind === "group") last.items.push(it as ToolItem);
    else out.push({ kind: "group", id: `g-${it.id}`, items: [it as ToolItem] });
  } else out.push({ kind: "item", item: it });
}

// What the agent just made (a look, a sheet, a voice, a sample), to look at or listen to right away.
function MadeStrip({ ids, assets, onPicture }: { ids: string[]; assets: Record<string, PickAsset>; onPicture: (p: Picture) => void }) {
  return (
    <div className="ag-made">
      {ids.map((id) => {
        const a = assets[id];
        if (!a || a.status !== "ready") return <span key={id} className="ag-made-wait" title="Still processing"><Loader2 size={12} className="spin" /></span>;
        if (a.kind === "audio") return <PlayButton key={id} url={a.url} label={a.name} seconds={a.duration} className="btn small ag-made-audio" />;
        const open = () => (a.kind === "video" && a.url ? onPicture({ label: a.name, url: a.url, kind: "video" }) : a.poster ? onPicture({ label: a.name, url: a.poster }) : undefined);
        return (
          <button key={id} className="ag-made-pic" onClick={open} title={a.name}>
            {a.poster ? <img src={a.poster} alt={a.name} /> : <span className="muted small">{a.name}</span>}
            {a.kind === "video" && <span className="ag-made-play"><Play size={14} /></span>}
            <span className="ag-made-name ellipsis">{a.name}</span>
          </button>
        );
      })}
    </div>
  );
}

function QuietGroup({ items, onPicture }: { items: ToolItem[]; onPicture: (p: Picture) => void }) {
  const [open, setOpen] = useState(false);
  const running = items.some((i) => i.status === "running");
  const failed = items.filter((i) => i.status === "failed").length;
  const parts: string[] = [];
  const topics: string[] = [];
  for (const i of items) {
    if (i.tool === "studio_guide") {
      const t = (i.detail || "").replace(/^Topic: /, "");
      if (t && !topics.includes(t)) topics.push(t);
      if (!parts.includes("\u0000guide")) parts.push("\u0000guide");
    } else if (!parts.includes(i.title)) parts.push(i.title);
  }
  const label = failed
    ? `${failed === 1 ? "A background check" : `${failed} background checks`} didn't respond`
    : parts.map((p) => (p === "\u0000guide" ? `Read the guide${topics.length ? ` (${topics.join(", ")})` : ""}` : p)).join(" · ");
  return (
    <div className={`ag-quiet ${failed ? "failed" : ""}`}>
      <button onClick={() => setOpen(!open)} title={open ? "Hide the steps" : "Show each step"}>
        <span className="ag-glyph">{running ? <Loader2 size={12} className="spin" /> : failed ? <AlertTriangle size={12} /> : <Check size={12} />}</span>
        <span>{label}</span>
        <ChevronRight size={11} className={open ? "rot" : ""} />
      </button>
      {open && (
        <div className="ag-quiet-list">
          {items.map((i) => (
            <Step key={i.id} item={i} onPicture={onPicture} />
          ))}
        </div>
      )}
    </div>
  );
}

function CommandBlock({ item }: { item: Extract<ChatItem, { type: "command" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`ag-cmd ${item.status}`}>
      <button className="ag-cmd-head" onClick={() => setOpen(!open)}>
        <Terminal size={12} />
        <code>{item.command.replace(/^\/bin\/(ba)?sh -lc /, "")}</code>
        {item.status === "running" ? <Loader2 size={12} className="spin" /> : item.status === "failed" ? <span className="ag-fail" title={`Exited with code ${item.exit_code}`}>Didn't work</span> : <ChevronRight size={11} className={open ? "rot" : ""} />}
      </button>
      {open && item.output && <pre>{item.output}</pre>}
    </div>
  );
}

// The end of a turn: how long it took, what it cost, and Undo for its timeline changes.
function TurnFooter({ item, projectId, onRestore }: { item: Extract<ChatItem, { type: "turn" }>; projectId: string; onRestore: (rev: number) => Promise<void> }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const changed = item.project === projectId && item.to_revision > item.from_revision;
  const bits = [
    item.seconds !== undefined ? `Worked ${clock(item.seconds)}` : null,
    item.model_usd ? `agent ${money(item.model_usd)}` : null,
    item.gen_usd ? `generation ${money(item.gen_usd)}` : null,
    changed ? `r${item.from_revision} → r${item.to_revision}` : null,
  ].filter(Boolean);
  if (!bits.length) return null;
  return (
    <div className="ag-turn">
      <span>{bits.join(" · ")}</span>
      {changed &&
        (state === "done" ? (
          <span className="muted">Restored r{item.from_revision}</span>
        ) : (
          <button
            className="link"
            disabled={state === "busy"}
            onClick={async () => {
              setState("busy");
              try {
                await onRestore(item.from_revision);
                setState("done");
              } catch {
                setState("error");
              }
            }}
          >
            <Undo2 size={11} /> {state === "error" ? "Couldn't undo — try again" : "Undo"}
          </button>
        ))}
    </div>
  );
}

// A draft in the chat's record: what it is and how it stands. Waiting ones open in the box below,
// where they're generated; the rest open here, with their takes, results and what went in.
function DraftLine({ item, draft: d, onOpen, details }: { item: ToolItem; draft?: Draft; onOpen: (id: string) => void; details: (d: Draft) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const q = item.focus!.quote!;
  const running = d?.jobs.filter((j) => ["queued", "running", "waiting"].includes(j.status)) || [];
  const state = !d ? "gone" : isOpen(d) ? "waiting" : d.status === "denied" ? "skipped" : running.length ? "running" : d.jobs.some((j) => j.status === "succeeded") ? "made" : d.jobs.some((j) => j.status === "failed") ? "failed" : d.status === "used" ? "running" : "gone";
  const pct = running.length ? Math.round((100 * running.reduce((t, j) => t + (j.progress || 0), 0)) / running.length) : 0;
  const detail =
    state === "waiting" ? `${money(d!.cost_usd)} · waiting below`
    : state === "running" ? `generating${pct ? ` · ${pct}%` : "…"}`
    : state === "made" ? "made"
    : state === "skipped" ? "skipped"
    : state === "failed" ? "failed · refunded"
    : "expired";
  const expandable = !!d && state !== "waiting";
  return (
    <div className={`ag-step ag-draftline ${state} ${open ? "open" : ""}`}>
      <button
        className="ag-step-row"
        onClick={() => (state === "waiting" ? onOpen(q.id) : setOpen(!open))}
        disabled={state !== "waiting" && !expandable}
        title={state === "waiting" ? "Show it in the box below" : open ? "Hide the details" : "Show its takes, results and what went in"}
      >
        <span className="ag-glyph">{state === "running" ? <Loader2 size={12} className="spin" /> : state === "made" ? <Check size={12} /> : state === "failed" ? <AlertTriangle size={12} /> : state === "skipped" || state === "gone" ? <Ban size={11} /> : <Sparkles size={12} />}</span>
        <span className="ag-step-title">{d ? draftName(d) : q.title || q.model}</span>
        <span className="ag-step-detail">{detail}</span>
        {expandable && <ChevronRight size={11} className={`ag-step-more ${open ? "rot" : ""}`} />}
      </button>
      {open && d && details(d)}
    </div>
  );
}

// How the agent works with you: the mode, and whether quick generations run on their own.
function ModeMenu({ mode, setMode, quick, setQuick }: { mode: Mode; setMode: (m: Mode) => void; quick: boolean; setQuick: (v: boolean) => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !(e.target as HTMLElement)?.closest?.(".ag-mode") && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const label = mode === "just_make_it" ? "Just make it" : quick ? "Work with me · quick ones run" : "Work with me";
  return (
    <div className="ag-mode">
      <button className={`ag-mode-btn ${open ? "on" : ""}`} onClick={() => setOpen(!open)} title="How your agent works with you">
        <span className="ellipsis">{label}</span>
        <ChevronDown size={10} />
      </button>
      {open && (
        <div className="popover ag-mode-menu">
          <button className={`ag-mode-opt ${mode === "work_with_me" ? "on" : ""}`} onClick={() => (setMode("work_with_me"), setOpen(false))}>
            <span className="ag-mode-check">{mode === "work_with_me" && <Check size={12} />}</span>
            <span>
              <b>Work with me</b>
              <small>It develops the piece with you, one step at a time. Every generation waits for you in the box.</small>
            </span>
          </button>
          <label className={`ag-mode-quick ${mode === "just_make_it" ? "off" : ""}`}>
            <input type="checkbox" checked={quick} onChange={(e) => setQuick(e.target.checked)} />
            <span>
              Let quick ones run on their own
              <small>Look frames, sheets and voice samples — under about 20 credits each, up to 400 credits a project. Video always waits.</small>
            </span>
          </label>
          <button className={`ag-mode-opt ${mode === "just_make_it" ? "on" : ""}`} onClick={() => (setMode("just_make_it"), setOpen(false))}>
            <span className="ag-mode-check">{mode === "just_make_it" && <Check size={12} />}</span>
            <span>
              <b>Just make it</b>
              <small>No questions or drafts: it makes the whole thing inside your budget.</small>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

// Whether quick generations run without asking: the person's own setting, kept on their account.
function useQuickAuto() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    api<{ quick_auto?: boolean }>("/api/me")
      .then((m) => setOn(!!m.quick_auto))
      .catch(() => {});
  }, []);
  const set = async (v: boolean) => {
    setOn(v);
    try {
      await api("/api/settings", { quick_auto: v });
    } catch {
      setOn(!v);
    }
  };
  return [on, set] as const;
}

// One answered question, kept whole: the question, what they chose or wrote, and — folded — the
// options they didn't take (any of which they can still switch to).
function Answered({ a, onRevisit }: { a: Answer; onRevisit: (label: string) => void }) {
  const [open, setOpen] = useState(false);
  const skipped = a.answer.startsWith("(not answered");
  const opts = (a.options || []).map((o) => ({ ...o, label: cleanLabel(o.label) }));
  const chosen = opts.find((o) => o.label === a.answer);
  const others = opts.filter((o) => o !== chosen);
  const more = !!(a.question || chosen?.description || others.length);
  return (
    <div className={`ag-answer ${skipped ? "skipped" : ""} ${open ? "open" : ""}`}>
      <button className="ag-answer-line" onClick={() => more && setOpen(!open)} disabled={!more} title={more ? (open ? "Hide the details" : "See the question, what you picked and the other options") : undefined}>
        <span className="ag-answer-q">{a.header || "Answer"}</span>
        <span className="ag-answer-arrow">→</span>
        <span className="ag-answer-a">{skipped ? "skipped" : chosen ? chosen.label : `“${a.answer.replace(/\n?\[Attached\][\s\S]*$/, "")}”`}{/\[Attached\]/.test(a.answer) && <span className="ag-answer-att"> · {(a.answer.match(/“[^”]*”/g) || []).length} file{(a.answer.match(/“[^”]*”/g) || []).length === 1 ? "" : "s"} attached</span>}</span>
        {more && <ChevronRight size={11} className={`ag-answer-chev ${open ? "rot" : ""}`} />}
      </button>
      {open && (
        <div className="ag-answer-more-body">
          {a.question && <span className="ag-answer-question">{a.question}</span>}
          {chosen?.description && (
            <span className="ag-answer-desc">
              <Check size={11} className="ag-answer-tick" /> {chosen.description}
            </span>
          )}
          {!chosen && !skipped && <span className="ag-answer-desc">In your own words: “{a.answer}”</span>}
          {others.length > 0 && (
            <ul className="ag-answer-others">
              {others.map((o) => (
                <li key={o.label}>
                  <span>
                    <b>{o.label}</b>
                    {o.description && <small>{o.description}</small>}
                  </span>
                  <button className="btn ghost small" onClick={() => onRevisit(o.label)} title="Tell your agent to go with this instead">
                    Use this
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// The jobs a step waited on: each by name, its state, and what it made (click to see it large).
function JobList({ jobs, onPicture }: { jobs: NonNullable<NonNullable<ToolItem["focus"]>["jobList"]>; onPicture: (p: Picture) => void }) {
  const ctx = useContext(BoardItems);
  const media = ctx?.api.data?.media || {};
  return (
    <ul className="ag-jobs">
      {jobs.map((j, i) => (
        <li key={i} className={j.status}>
          <span className="ag-job-dot" />
          <span className="ag-job-title">{j.title}</span>
          <span className="ag-job-state num">{j.status === "succeeded" ? "done" : j.status === "failed" ? "failed" : j.status === "queued" ? "queued" : `${Math.round((j.progress || 0) * 100)}%`}</span>
          {j.assets.length > 0 && (
            <span className="ag-job-pics">
              {j.assets.map((a) => {
                const m = media[a];
                return m?.poster ? (
                  <button key={a} onClick={() => onPicture({ label: j.title, url: (m.full || m.poster)! })} title={j.title}>
                    <img src={m.poster} alt="" />
                  </button>
                ) : null;
              })}
            </span>
          )}
          {j.error && <span className="ag-job-err">{j.error}</span>}
        </li>
      ))}
    </ul>
  );
}

// "Generated …" from pressing Generate: the things set going, as a list rather than a sentence.
function GeneratedNote({ text }: { text: string }) {
  const names = text.replace(/^Generated\s+/, "").replace(/\.$/, "").split(/,\s+(?=[^,]*·)/);
  return (
    <div className="ag-generated">
      <span className="ag-generated-head">
        <Sparkles size={12} /> Generating {names.length > 1 ? <span className="num">{names.length}</span> : null}
      </span>
      <ul>
        {names.map((n, i) => (
          <li key={i}>
            <WithItems text={n.replace(/ \(I edited it\)$/, "")} />
            {/\(I edited it\)$/.test(n) && <span className="muted small"> · edited by you</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// The agent reached a limit: say so plainly, keep everything, offer the way on.
function LimitCard({ message, onDone }: { message: string; onDone: () => void }) {
  return (
    <div className="ag-limit">
      <strong>You're out of credits</strong>
      <span className="muted small">Your conversation, board and media are saved. Add credits to keep going.</span>
      <div className="ag-limit-row">
        <a className="btn primary small" href="/billing">Add credits</a>
        <button className="btn ghost small" onClick={onDone}>Dismiss</button>
      </div>
    </div>
  );
}

// An option that offers to spend (make frames, sheets, clips): once they've passed one up, the offer
// stays away for the session until they ask or reach a checkpoint ("Make it").
const GEN_OFFER = /^\W*(generate|make (the |a |two |three |some |quick |rough )?(look|frames?|sheets?|stills?|images?|it|them|clip|clips|video|storyboards?|samples?)|render)\b/i;
const ASKS_TO_MAKE = /\b(generate|make (it|them|the|a|some|this|that)|render|let'?s see|show me)\b/i;
const HOLD_LINE = "[Generation] This session they chose to keep going without generating. Don't offer full generations — no drafts, no \"Generate…\" options or Choices — until they ask or the story is complete (a \"Make it\" checkpoint). Cheap previews (gen_quote preview:true) as a question's options are still fine.";
const SKIPPED = "(not answered: they replied in their own words to the question before; ask again only if you still need it)";

export function AgentPanel(props: {
  agent: AgentApi;
  board: BoardApi;
  drafts: DraftsApi;
  models: ModelSpec[];
  assets: PickAsset[];
  nameOf: (assetId: string) => string;
  projectId: string;
  context: () => string[];
  contextLabel: string;
  upload: (files: File[], onProgress: (name: string, p: number) => void) => Promise<Attachment[]>;
  onRestore: (revision: number) => Promise<void>;
  onUseTake: (s: Storyboard, assetId: string) => void;
  follow: boolean;
  setFollow: (v: boolean) => void;
  mode: Mode;
  setMode: (m: Mode) => void;
  suggestions: string[];
  pending: { text: string; attachments: Attachment[] } | null;
  onPendingSent: () => void;
  onWatch: () => Promise<void>; // lay the piece out on the timeline from the board, then play it
  onPlay: () => void; // play the timeline from the start
  watching: boolean;
  refreshAssets: () => void;
  jobs?: { id: string; status: string; output?: any; error?: any }[]; // the project's recent jobs (polled by the editor)
}) {
  const { agent, projectId } = props;
  const [text, setText] = useState("");
  const [useContext, setUseContext] = useState(true);
  const [files, setFiles] = useState<Uploading[]>([]);
  const [picture, setPicture] = useState<Picture | null>(null);
  // the decision box in the input: which item shows, the answers given so far to a question set, and
  // next-step options the person put away
  const [dockKey, setDockKey] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, Record<string, string>>>({});
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [hi, setHi] = useState(0); // the highlighted option in the box
  const [quick, setQuick] = useQuickAuto();
  // "keep going without generating" sticks for the session (this conversation), until they ask
  const holdKey = `studio.genhold.${agent.thread || "new"}`;
  const [hold, setHoldState] = useState(false);
  useEffect(() => setHoldState(sessionStorage.getItem(holdKey) === "1"), [holdKey]);
  const setHold = (on: boolean) => {
    setHoldState(on);
    on ? sessionStorage.setItem(holdKey, "1") : sessionStorage.removeItem(holdKey);
  };
  // a board item opened: over the preview where there's room (the editor's #board-stage), else inline
  const [focus, setFocus] = useState<BoardFocus>(null);
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 981px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 981px)");
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const itemsCtx = useMemo(() => ({ api: props.board, open: setFocus }), [props.board]);
  const [stage, setStage] = useState<HTMLElement | null>(null);
  useEffect(() => setStage(document.getElementById("board-stage")), []);
  useEffect(() => {
    if (!focus) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !(e.target as HTMLElement)?.closest?.("input, textarea, select") && setFocus(null);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [focus]);
  const [menu, setMenu] = useState(false);
  const [drag, setDrag] = useState(false);
  const [, tick] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!agent.running) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [agent.running]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [agent.items, agent.running, agent.questions, props.drafts.drafts]);
  useEffect(() => {
    stick.current = true;
  }, [agent.thread]);

  const modeLine = () =>
    `[Mode] ${props.mode === "just_make_it" ? "Just make it — skip questions and approvals, stay inside the budget" : quick ? "Work with me — quick generations (looks, sheets, voices) run on their own" : "Work with me — every generation waits for them in the box"}`;
  const attachedLine = (att: Attachment[]) => "[Attached] " + att.map((a) => `${a.asset_id} “${a.name.replace(/[“”\n]/g, "")}” (${a.kind})`).join(", ");
  // what they did in the box without a word (a skipped draft) goes along with their next message
  const quiet = useRef<string[]>([]);
  const say = (body: string, ctx: string[] = [], images: string[] = []) => {
    let held = hold;
    if (held && ASKS_TO_MAKE.test(body)) (held = false), setHold(false);
    const sent = agent.send(body, { context: [...ctx, ...quiet.current, modeLine(), ...(held ? [HOLD_LINE] : [])], images });
    if (sent) quiet.current = [];
    return sent;
  };

  // a prompt started on the projects page goes out once the agent is connected
  useEffect(() => {
    if (!props.pending || !agent.ready) return;
    const att = props.pending.attachments;
    if (say(props.pending.text, [...props.context(), ...(att.length ? [attachedLine(att)] : [])])) props.onPendingSent();
  }, [props.pending, agent.ready]);

  const addFiles = async (all: File[]) => {
    // the same file dropped twice (or through two drop targets) uploads once
    const list = all.filter((f, i) => all.findIndex((g) => g.name === f.name && g.size === f.size) === i && !files.some((u) => u.name === f.name && !u.error));
    if (!list.length) return;
    const entries: Uploading[] = list.map((f) => ({ key: `${f.name}-${f.size}-${Date.now()}`, name: f.name, progress: 0 }));
    setFiles((fs) => [...fs, ...entries]);
    const previews = await Promise.all(list.map(previewOf));
    setFiles((fs) =>
      fs.map((u) => {
        const i = entries.findIndex((e) => e.key === u.key);
        return i >= 0 && previews[i] ? { ...u, image: previews[i] } : u;
      }),
    );
    try {
      const done = await props.upload(list, (name, p) => setFiles((fs) => fs.map((u) => (u.name === name && !u.done ? { ...u, progress: p } : u))));
      setFiles((fs) =>
        fs.map((u) => {
          if (!entries.some((e) => e.key === u.key)) return u;
          const d = done.find((x) => x.name === u.name);
          return d ? { ...u, progress: 1, done: d } : { ...u, error: "Upload failed" };
        }),
      );
    } catch (e: any) {
      setFiles((fs) => fs.map((u) => (entries.some((e2) => e2.key === u.key) ? { ...u, error: e.message } : u)));
    }
  };

  // media from anywhere in the project, as references in the composer (already uploaded)
  const addRefs = (refs: MediaRef[]) =>
    refs.length &&
    setFiles((fs) => [
      ...fs,
      ...refs
        .filter((r) => !fs.some((f) => f.done?.asset_id === r.asset_id))
        .map((r) => ({ key: `ref-${r.asset_id}`, name: r.name, progress: 1, done: { asset_id: r.asset_id, name: r.name, kind: r.kind }, image: r.image || undefined })),
    ]);
  useEffect(() => {
    addRefs(takeRefs());
    const on = () => addRefs(takeRefs());
    const onFiles = () => {
      const fs = takeFiles();
      if (fs.length) addFiles(fs);
    };
    onFiles();
    window.addEventListener("studio:refs", on);
    window.addEventListener("studio:files", onFiles);
    return () => (window.removeEventListener("studio:refs", on), window.removeEventListener("studio:files", onFiles));
  }, []);

  const uploading = files.some((f) => !f.done && !f.error);
  const submit = (override?: string) => {
    const body = (override ?? text).trim();
    if (!body || uploading) return;
    // typed while the box shows a question: it's their own answer to it
    const it = override === undefined ? currentItem : undefined;
    if (it?.kind === "question") {
      // files in the box go with the answer (it's the only message the agent reads mid-question)
      const att = files.filter((f) => f.done).map((f) => f.done!);
      answerQuestion(it, att.length ? `${body}\n${attachedLine(att)}` : body);
      setFiles([]);
      setText("");
      if (input.current) input.current.style.height = "auto";
      return;
    }
    const att = files.filter((f) => f.done).map((f) => f.done!);
    // typed while the box shows a generation: likely about it, so the agent knows which one
    const showing = it?.kind === "draft" ? [`[Box] They were looking at draft ${it.draft.id} (“${draftName(it.draft).replace(/[“”\n]/g, "")}”) when they wrote this`] : [];
    const ctx = [...(useContext ? props.context() : []), ...(att.length ? [attachedLine(att)] : []), ...showing];
    const images = files.filter((f) => f.done && f.image).map((f) => f.image!).slice(0, 4);
    if (say(body, ctx, images)) {
      if (override === undefined) {
        setText("");
        if (input.current) input.current.style.height = "auto";
      }
      setFiles([]);
      stick.current = true;
    }
  };

  // generations set going from the box: when they finish, the agent hears it and carries on
  const genWaiting = useRef(new Map<string, string>());
  const finished = useRef<{ name: string; ok: boolean; assets: string[] }[]>([]);
  useEffect(() => {
    if (!genWaiting.current.size || !props.jobs) return;
    for (const j of props.jobs) {
      const name = genWaiting.current.get(j.id);
      if (!name || !["succeeded", "failed"].includes(j.status)) continue;
      genWaiting.current.delete(j.id);
      finished.current.push({ name, ok: j.status === "succeeded", assets: j.output?.assets || [] });
    }
    if (!finished.current.length || genWaiting.current.size || agent.running || text.trim() || currentItem?.kind === "question") return;
    const done = finished.current.splice(0);
    const line = done.map((x) => `${x.name} ${x.ok ? "is ready" : "failed"}${x.assets.length ? ` (${x.assets.join(", ")})` : ""}`).join("; ");
    say(`[Ready] ${line}.`, ["[Ready] Generations they started from the box have finished. Look at them and carry on with what you said you'd do next."]);
  }, [props.jobs, agent.running]);

  // generating drafts runs them now; the agent hears about the ones it prepared, so it can carry on
  const generateDrafts = async (ids: string[]) => {
    setHold(false);
    const before = ids.map((id) => props.drafts.byId[id]).filter(Boolean);
    const started = await props.drafts.generate(ids);
    for (const r of started) {
      const d = before.find((x) => x.id === r.id);
      if (d) for (const j of r.job_ids || []) genWaiting.current.set(j, draftName(d));
    }
    const mine = started.map((r) => ({ r, d: before.find((d) => d.id === r.id)! })).filter((x) => x.d && (x.d.by === "agent" || !!agent.thread));
    if (mine.length)
      say(
        `Generated ${mine.map((x) => `${draftName(x.d)}${x.d.edited_by === "human" ? " (I edited it)" : ""}`).join(", ")}.`,
        [`[Generated] ${mine.map((x) => `${x.r.id} → ${x.r.job_ids.join(", ")}`).join("; ")}`],
      );
    props.board.load();
  };
  const askAbout = (t: string) => {
    setText(t);
    setTimeout(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(t.length, t.length);
      el.style.height = "auto";
      el.style.height = Math.min(180, el.scrollHeight) + "px";
    }, 0);
  };
  const draftMedia = { ...(props.board.data?.media || {}), ...props.drafts.media };
  const boardProps = { api: props.board, drafts: props.drafts, models: props.models, assets: props.assets, nameOf: props.nameOf, onUseTake: props.onUseTake, onPicture: setPicture, onGenerate: generateDrafts, onAsk: askAbout, onSend: (t: string) => void say(t), onWatch: props.onWatch, watching: props.watching, onOpenDraft: (id: string) => setDockKey(`d-${id}`) };
  // the chat as rows: a record of the work (decisions happen in the box below)
  const assetMap = useMemo(() => Object.fromEntries(props.assets.map((a) => [a.id, a])), [props.assets]);
  const chatRows = useMemo(() => rows(agent.items), [agent.items]);
  // results the editor hasn't loaded yet (just made): fetch them, and again while they process
  const unseen = chatRows.flatMap((r) => (r.kind === "made" ? r.ids.filter((x) => assetMap[x]?.status !== "ready") : [])).join(",");
  useEffect(() => {
    if (!unseen) return;
    const t = setTimeout(props.refreshAssets, 2500);
    return () => clearTimeout(t);
  }, [unseen, props.assets]);
  // what waits for the person, in the box: questions, then generations (oldest first), then next steps
  const lastAgent = [...agent.items].reverse().find((i) => i.type === "agent" && i.text) as Extract<ChatItem, { type: "agent" }> | undefined;
  const waiting = props.drafts.drafts.filter(isOpen).slice().reverse();
  const next = lastAgent && !agent.running && !agent.questions.length && !dismissed.includes(lastAgent.id) ? splitChoices(lastAgent.text).choices.filter((c) => !/^generate\b/i.test(c)) : [];
  // while they're holding off, offers to generate don't show among a question's options
  const asked = hold ? agent.questions.map((set) => ({ ...set, questions: set.questions.map((q) => { const keep = q.options.filter((o) => !GEN_OFFER.test(cleanLabel(o.label))); return keep.length >= 2 ? { ...q, options: keep } : q; }) })) : agent.questions;
  const items = dockItems(asked, waiting, next.length >= 2 ? { id: lastAgent!.id, options: next } : null);
  // what the box shows: something new waits while the reply is still streaming in, so they read
  // first and choose second (what they've already seen stays put)
  const shownKeys = useRef<Set<string>>(new Set());
  const candidate: DockItem | undefined = items.find((x) => x.key === dockKey) || items[0];
  const currentItem: DockItem | undefined = candidate && (!agent.streaming || shownKeys.current.has(candidate.key)) ? candidate : undefined;
  if (currentItem) shownKeys.current.add(currentItem.key);
  // the highlight starts on the option already picked, else the first
  useEffect(() => {
    const it = currentItem;
    const picked = it?.kind === "question" ? answers[it.set.id]?.[it.q.id] : undefined;
    setHi(Math.max(0, optionsOf(it).indexOf(picked || "")));
  }, [currentItem?.key]);
  // The box keeps its order — questions, then generations, then next steps — and follows it unless
  // the person stepped somewhere themselves. Something more urgent than what they're on comes to the
  // front: a new question always (unless one is half answered), a new generation over next steps.
  const seenKeys = useRef<Set<string>>(new Set());
  const itemKeys = items.map((x) => x.key).join("|");
  useEffect(() => {
    const fresh = items.filter((x) => !seenKeys.current.has(x.key));
    items.forEach((x) => seenKeys.current.add(x.key));
    const on = dockKey ? items.find((x) => x.key === dockKey) : undefined;
    if (!fresh.length || !on) return;
    if (on.kind === "question" && Object.keys(answers[on.set.id] || {}).length) return;
    const q = fresh.find((x) => x.kind === "question");
    const d = fresh.find((x) => x.kind === "draft");
    if (q) setDockKey(q.key);
    else if (d && on.kind === "choices") setDockKey(d.key);
  }, [itemKeys]);
  // an answer to one question of a set; the set goes to the agent once every question has one
  const answerQuestion = (it: Extract<DockItem, { kind: "question" }>, value: string) => {
    const done: Record<string, string> = { ...(answers[it.set.id] || {}), [it.q.id]: value.trim() };
    // their own words answer now: the rest of the set isn't asked (it may depend on what they said);
    // the agent reads those as skipped and asks again only if it still needs to
    const own = !it.q.options.some((o) => o.label === value);
    if (own) for (const q of it.set.questions) if (!done[q.id]) done[q.id] = SKIPPED;
    const open = it.set.questions.find((q) => !done[q.id]);
    if (open) {
      setAnswers((a) => ({ ...a, [it.set.id]: done }));
      setDockKey(`q-${it.set.id}-${open.id}`);
      return;
    }
    // passing up an offer to generate (their words, or another option) holds offers off for the session
    const passed = it.set.questions.filter((q) => q.options.some((o) => GEN_OFFER.test(cleanLabel(o.label))) && done[q.id] && !GEN_OFFER.test(cleanLabel(done[q.id])));
    if (passed.length) setHold(true);
    const shown = it.set.questions.map((q) => ({ header: q.header, question: q.question, answer: cleanLabel(done[q.id]), options: q.options.map((o) => ({ label: cleanLabel(o.label), description: o.description })) }));
    const note = (k: string, v: string) => (passed.some((q) => q.id === k) ? `${v} — (they're keeping going without generating: don't offer it again this session until they ask or the story's complete)` : v);
    if (!agent.answer(it.set.id, Object.fromEntries(Object.entries(done).map(([k, v]) => [k, [note(k, cleanLabel(v))]])), shown)) return;
    setAnswers((a) => {
      const rest = { ...a };
      delete rest[it.set.id];
      return rest;
    });
    setDockKey(null);
    stick.current = true;
  };
  // picking an option answers for them: a question's answer, or the next step said as their message
  const pick = (it: DockItem, label: string) => {
    if (it.kind === "question") answerQuestion(it, label);
    else if (it.kind === "choices") submit(cleanLabel(label));
  };
  const adjustPlan = () => {
    setText("Change the plan: ");
    input.current?.focus();
  };

  const lastStoryId = [...agent.items].reverse().find((i) => i.type === "tool" && i.focus?.story)?.id;
  const lastPlanId = [...agent.items].reverse().find((i) => i.type === "tool" && i.focus?.plan)?.id;
  const lastRunning = [...agent.items].reverse().find((i) => i.type === "tool" && i.status === "running") as ToolItem | undefined;
  const current = agent.threads.find((t) => t.id === agent.thread);
  const statusDot = agent.socket !== "open" ? "off" : agent.agentState === "error" ? "err" : agent.running ? "busy" : agent.agentState === "ready" ? "on" : "idle";

  const renderItem = (item: ChatItem) => {
    switch (item.type) {
      case "user":
        if (item.answers?.length)
          return (
            <div className="ag-user">
              <div className="ag-bubble ag-answers">
                {item.answers.map((a, i) => (
                  <Answered key={i} a={a} onRevisit={(label) => agent.send(`Actually, for “${a.header || a.question}”: ${label}`)} />
                ))}
              </div>
            </div>
          );
        return (
          <div className={`ag-user ${item.pending ? "pending" : ""}`}>
            {item.images?.length ? (
              <div className="ag-pics small">
                {item.images.map((u, i) => (
                  <button key={i} onClick={() => setPicture({ label: "Attached image", url: u })}>
                    <img src={u} alt="" />
                  </button>
                ))}
              </div>
            ) : null}
            {/^\[Ready\] /.test(item.text) ? (
              <div className="ag-ready-note">
                <Check size={12} /> {item.text.replace(/^\[Ready\] /, "").replace(/ \(ast_[^)]*\)/g, "")}
              </div>
            ) : /^Generated .+·/.test(item.text) ? <GeneratedNote text={item.text} /> : <div className="ag-bubble">{item.text}</div>}
            {item.context?.some((c) => c.startsWith("[Attached]")) && (
              <span className="ag-chip">
                <Paperclip size={10} /> with attachments
              </span>
            )}
          </div>
        );
      case "agent": {
        if (!item.text) return null;
        const split = splitChoices(item.text);
        return (
          <div className="ag-agent">
            <Markdown text={split.text} />
          </div>
        );
      }
      case "reasoning":
        return null;
      case "plan":
        return item.text ? (
          <div className="ag-plan">
            <Markdown text={item.text} />
          </div>
        ) : null;
      case "tool":
        return (
          <Step
            item={item}
            onPicture={setPicture}
            plan={item.focus?.plan ? <PlanCard plan={item.focus.plan} live={item.id === lastPlanId} onAdjust={adjustPlan} /> : item.focus?.story ? <StoryCard beats={item.focus.story.beats} live={item.id === lastStoryId} /> : null}
            onWatch={props.onPlay}
          />
        );
      case "command":
        return <CommandBlock item={item} />;
      case "files":
        return (
          <div className="ag-files">
            <FileCode size={12} />
            <span>{item.changes.map((c) => c.path).join(", ") || "Edited files"}</span>
          </div>
        );
      case "notice":
        return <div className="ag-notice">{item.text}</div>;
      case "turn":
        return <TurnFooter item={item} projectId={projectId} onRestore={props.onRestore} />;
    }
  };

  // a question arriving puts the cursor in its answer box
  useEffect(() => {
    if (currentItem?.kind === "question") requestAnimationFrame(() => input.current?.focus());
  }, [currentItem?.key]);
  // the text box: under the chat normally; while a question waits it sits right under the question,
  // as the main way to answer (the options are the shortcuts)
  const inputEl = (
          <div className="ag-input">
            <button className="icon xs" title="Attach files (they're added to this project)" onClick={() => picker.current?.click()}>
              <Paperclip size={15} />
            </button>
            <input ref={picker} type="file" multiple hidden accept="video/*,audio/*,image/*" onChange={(e) => (addFiles(Array.from(e.target.files || [])), (e.target.value = ""))} />
            <textarea
              ref={input}
              rows={1}
              placeholder={dockPlaceholder(currentItem) || (agent.running ? "Steer it — it reads this right away…" : "Tell your agent what you want…")}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onPaste={(e) => {
                const pics = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
                if (pics.length) {
                  e.preventDefault();
                  addFiles(pics);
                }
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
                // with nothing typed, the keys drive the box: ↑ ↓ move, Enter picks, ← → step through
                const opts = optionsOf(currentItem);
                if (!text.trim() && currentItem) {
                  if (opts.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                    e.preventDefault();
                    setHi((h) => (h + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length);
                    return;
                  }
                  if (opts.length && e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    pick(currentItem, opts[Math.min(hi, opts.length - 1)]);
                    return;
                  }
                  const k = items.findIndex((x) => x.key === currentItem.key);
                  if ((e.key === "ArrowLeft" && k > 0) || (e.key === "ArrowRight" && k < items.length - 1)) {
                    e.preventDefault();
                    setDockKey(items[k + (e.key === "ArrowLeft" ? -1 : 1)].key);
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = Math.min(180, el.scrollHeight) + "px";
              }}
            />
            {agent.running && (
              <button className="ag-send stop" title="Stop" onClick={agent.stop}>
                <Square size={11} />
              </button>
            )}
            <button className={`ag-send ${currentItem?.kind === "question" ? "answer" : ""}`} title={currentItem?.kind === "question" ? "Answer with this" : agent.running ? "Send now (it joins the work in progress)" : "Send (Enter)"} disabled={!text.trim() || uploading || !agent.ready} onClick={() => submit()}>
              {currentItem?.kind === "question" ? <>Answer <CornerDownLeft size={13} /></> : <ArrowUp size={15} />}
            </button>
          </div>
  );
  return (
    <BoardItems.Provider value={itemsCtx}>
    <div
      className={`agent-panel ${drag ? "drag" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files") || e.dataTransfer.types.includes("application/x-studio-asset")) {
          e.preventDefault();
          e.stopPropagation();
          setDrag(true);
        }
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        const dragged = e.dataTransfer.getData("application/x-studio-asset");
        if (dragged) {
          e.preventDefault();
          e.stopPropagation();
          setDrag(false);
          const a = props.assets.find((x) => x.id === dragged);
          if (a) {
            const pic = a.kind === "image" ? a.url || a.poster : a.poster;
            // inline the picture, so the agent gets it as an image (its sandbox can't fetch our URLs)
            const inline = pic
              ? fetch(pic)
                  .then((r) => r.blob())
                  .then((b) => new Promise<string>((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.readAsDataURL(b); }))
                  .catch(() => null)
              : Promise.resolve(null);
            inline.then((image) => addRefs([{ asset_id: a.id, name: a.name, kind: a.kind, image }]));
          }
          return;
        }
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        e.stopPropagation();
        setDrag(false);
        addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="ag-head">
        <span className={`ag-dot ${statusDot}`} title={`Agent ${agent.socket !== "open" ? "connecting" : agent.agentState}`} />
        <div className="ag-threads">
          <button className="ag-thread-btn" onClick={() => setMenu(!menu)} title="Conversations">
            <span className="ellipsis">{current?.title || (agent.thread ? "Conversation" : "New chat")}</span>
            <ChevronDown size={13} />
          </button>
          {menu && (
            <div className="popover ag-menu" onMouseLeave={() => setMenu(false)}>
              <button onClick={() => (agent.newChat(), setMenu(false), input.current?.focus())}>
                <Plus size={13} /> New chat
              </button>
              {agent.threads.map((t) => (
                <div key={t.id} className={`ag-menu-row ${t.id === agent.thread ? "on" : ""}`}>
                  <button onClick={() => (agent.open(t.id), setMenu(false))}>
                    {t.running ? <Loader2 size={12} className="spin" /> : <Clapperboard size={12} />}
                    <span className="ellipsis">{t.title}</span>
                  </button>
                  <button className="icon xs" title="Archive" onClick={() => agent.archive(t.id)}>
                    <Archive size={12} />
                  </button>
                </div>
              ))}
              {!agent.threads.length && <div className="muted small ag-menu-empty">No conversations in this project yet.</div>}
            </div>
          )}
        </div>
        <button className={`icon xs ${props.follow ? "on" : ""}`} title={props.follow ? "Following: the playhead jumps to its changes" : "Follow its changes"} onClick={() => props.setFollow(!props.follow)}>
          <Crosshair size={14} />
        </button>
        <button className="icon xs" title="New chat" onClick={() => (agent.newChat(), input.current?.focus())}>
          <Plus size={14} />
        </button>
      </div>

      <DecisionsStrip api={props.board} onSay={(t) => void say(t)} />
      <BoardStrip {...boardProps} focus={focus} onFocus={setFocus} inline={!wide || !stage} />
      {focus && wide && stage &&
        createPortal(
          <>
            <div className="bd-scrim" onPointerDown={() => setFocus(null)} />
            <div className="bd-stage" role="dialog" aria-modal="false">
              <BoardDetail focus={focus} props={boardProps} onClose={() => setFocus(null)} />
            </div>
          </>,
          stage,
        )}

      <div
        className="ag-list"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {agent.loading && (
          <div className="ag-notice">
            <Loader2 size={12} className="spin" /> Loading the conversation…
          </div>
        )}
        {!agent.loading && agent.items.length === 0 && (
          <div className="ag-empty">
            <Clapperboard size={24} />
            <p>
              <strong>Your agent</strong> edits your footage and helps you make new videos — your vision, its craft. Drop in clips and ask for a cut, captions or a short. Or describe what you're picturing: it develops it with you — the story, the people, the look, the script, the voices and music — sketching as you talk, so you can watch the whole thing through before any video is made.
            </p>
            <div className="ag-suggest">
              {props.suggestions.map((s) => (
                <button key={s} onClick={() => submit(s)} disabled={!agent.ready}>
                  {s}
                </button>
              ))}
            </div>
            <p className="muted small">Drop footage, photos or music here to give them to it. It sees your playhead and selection.</p>
          </div>
        )}
        {chatRows.map((r) =>
          r.kind === "made" ? (
            <MadeStrip key={r.id} ids={r.ids} assets={assetMap} onPicture={setPicture} />
          ) : r.kind === "drafts" ? (
            <div key={r.id} className="ag-row">
              {r.items.map((i) => (
                <DraftLine
                  key={i.id}
                  item={i}
                  draft={props.drafts.byId[i.focus!.quote!.id]}
                  onOpen={(id) => setDockKey(`d-${id}`)}
                  details={(d) => <DraftDetails d={d} ctx={{ media: draftMedia, models: props.models, nameOf: props.nameOf, onPicture: setPicture }} onAgain={async (asset) => setDockKey(`d-${await props.drafts.create({ from_asset: asset })}`)} />}
                />
              ))}
            </div>
          ) : r.kind === "group" ? (
            <QuietGroup key={r.id} items={r.items} onPicture={setPicture} />
          ) : (
            <div key={r.item.id} className="ag-row">
              {renderItem(r.item)}
            </div>
          ),
        )}
        {agent.running && (
          <div className="ag-working">
            <Loader2 size={12} className="spin" />
            <span className="ellipsis">{agent.questions.length ? "Waiting for your answer below" : agent.agentState === "starting" ? "Starting…" : lastRunning ? lastRunning.title + "…" : "Thinking…"}</span>
            <span className="muted">{agent.runningSince ? elapsed(Date.now() - agent.runningSince) : ""}</span>
          </div>
        )}
      </div>

      {agent.error && /allowance|out of credit/i.test(agent.error) ? (
        <LimitCard message={agent.error} onDone={() => agent.setError("")} />
      ) : agent.error && (
        <div className="ag-error">
          <span>{agent.error}</span>
          <button className="icon xs" onClick={() => agent.setError("")}>
            <X size={12} />
          </button>
        </div>
      )}
      {agent.socket === "denied" && <div className="ag-error">Your sign-in expired. Reload the page to sign in again.</div>}

      <div className={`ag-compose ${currentItem?.kind === "question" ? "answering" : ""}`}>
        {files.length > 0 && (
          <div className="ag-files-up">
            {files.map((f) => (
              <span key={f.key} className={`ag-chip ${f.error ? "err" : ""}`} title={f.error || f.name}>
                {f.image ? <img src={f.image} alt="" /> : f.done ? <Check size={11} /> : <Loader2 size={11} className="spin" />}
                <span className="ellipsis">{f.name}</span>
                {!f.done && !f.error && <span className="muted">{Math.round(f.progress * 100)}%</span>}
                <button className="icon xs" onClick={() => setFiles((fs) => fs.filter((x) => x.key !== f.key))}>
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className={`ag-box ${currentItem ? "with-dock" : ""}`}>
          {currentItem && (
            <Dock
              items={items}
              current={currentItem}
              setCurrent={setDockKey}
              hi={hi}
              setHi={setHi}
              answers={currentItem.kind === "question" ? answers[currentItem.set.id] || {} : {}}
              onPick={pick}
              onDismissChoices={(id) => setDismissed((d) => [...d, id])}
              onGenerate={generateDrafts}
              answerSlot={currentItem.kind === "question" ? inputEl : undefined}
              draft={{ media: draftMedia, models: props.models, assets: props.assets, nameOf: props.nameOf, api: props.drafts, onPicture: setPicture, onAsk: askAbout, previews: props.board.data?.previews, onSkipped: (d) => (setHold(true), quiet.current.push(`[Skipped] They skipped draft ${d.id} (“${draftName(d).replace(/[“”\n]/g, "")}”) in the box — don't run it or remake it unless they ask`)) }}
            />
          )}
          {currentItem?.kind !== "question" && inputEl}
        </div>
        <div className="ag-compose-meta">
          <ModeMenu mode={props.mode} setMode={props.setMode} quick={quick} setQuick={setQuick} />
          {props.contextLabel && (
            <button className={`ag-ctx-toggle ${useContext ? "on" : ""}`} onClick={() => setUseContext(!useContext)} title="It sees what's open in the editor: the playhead and your selection">
              <Crosshair size={11} /> <span className="ellipsis">{useContext ? props.contextLabel : "Editor context off"}</span>
            </button>
          )}
          <span className="grow" />
          {agent.models.length > 1 && (
            <label className="ag-model" title={agent.thread ? "Change the model for this chat without losing its history." : "The model a new chat runs on"}>
              <Cpu size={11} />
              <select value={agent.model} onChange={(e) => agent.pickModel(e.target.value)} disabled={agent.running}>
                {agent.models.map((m) => (
                  <option key={m.id} value={m.id} title={m.note}>
                    {m.label}
                  </option>
                ))}
              </select>
              <ChevronDown size={10} />
            </label>
          )}
        </div>
      </div>
      {drag && (
        <div className="ag-drop">
          <ImageIcon size={22} />
          Drop to give these files to your agent
        </div>
      )}
      {picture && <Lightbox pic={picture} onClose={() => setPicture(null)} />}
    </div>
    </BoardItems.Provider>
  );
}
