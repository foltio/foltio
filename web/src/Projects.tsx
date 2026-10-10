import { useEffect, useMemo, useRef, useState } from "react";
import { api, isLocalMode, navigate, uploadFile } from "./api";
import { Plus, Film, Paperclip, ArrowUp, X, Loader2, Cpu, ChevronDown, MoreHorizontal, Search, Trash2, Pencil, Play, Globe2, LockKeyhole } from "lucide-react";
import { offeredModels, storedModel, storeModel, type ModelOption } from "./agent/models";
import { CanvasPicker, type CanvasValue } from "./Canvas";
import { CommunitySection } from "./Community";
import { STYLES } from "./agent/Decisions";
import { track } from "./analytics";
import { clearGuestUploadIntent, readGuestUploadIntent } from "./Guest";
import { clearGuestFiles, readGuestFiles } from "./guestUpload";

type P = { id: string; name: string; revision: number; updated_at: string; assets: number; public?: boolean; poster?: string | null; width?: number; height?: number };

export const ASPECTS: Record<string, { width: number; height: number }> = { "9:16": { width: 1080, height: 1920 }, "16:9": { width: 1920, height: 1080 }, "1:1": { width: 1080, height: 1080 } };
export const IDEAS = [
  "Generate a cinematic short film from my idea",
  "Create a polished product film from scratch",
  "Cut a 30-second teaser from my footage, with captions",
  "Tighten my talking-head video and add music under it",
];

// "2h ago", "3d ago", then a short date: the library reads at a glance.
export function ago(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
const groupOf = (iso: string) => {
  const d = (Date.now() - new Date(iso).getTime()) / 86400000;
  return d < 1 ? "Today" : d < 7 ? "This week" : d < 31 ? "This month" : "Earlier";
};

// Start with the built-in agent: make the project (and upload any files), then open the editor with
// the agent working on the prompt. The projects page and the signed-out editor (after sign-in) use it.
export async function startProject(prompt: string, aspect: string, files: File[] = [], onProgress?: (name: string, x: number) => void, style = "") {
  const name = prompt.replace(/\s+/g, " ").split(" ").slice(0, 7).join(" ").replace(/[.,;:!?]+$/, "").slice(0, 60) || "Untitled";
  const p = await api<{ id: string }>("/api/projects", { name, ...(ASPECTS[aspect] || ASPECTS["16:9"]), fps: 30 });
  // the working style chosen here is on the board before the agent's first turn
  if (style) await api(`/api/projects/${p.id}/board`, { patch: { brief: { style } } }).catch(() => {});
  const attachments = [];
  for (const f of files) attachments.push(await uploadFile(p.id, f, (x) => onProgress?.(f.name, x)));
  if (!isLocalMode()) sessionStorage.setItem("studio.agent.pending", JSON.stringify({ projectId: p.id, text: prompt, attachments }));
  navigate(`/p/${p.id}`);
}

function StartBox() {
  const localMode = isLocalMode();
  const uploadIntent = useMemo(() => readGuestUploadIntent(), []);
  const [resumeUpload, setResumeUpload] = useState(!!uploadIntent);
  const [text, setText] = useState(uploadIntent?.text || "");
  const [aspect, setAspect] = useState(uploadIntent?.aspect && ASPECTS[uploadIntent.aspect] ? uploadIntent.aspect : "16:9");
  const [style, setStyle] = useState("");
  // the model the agent's conversation runs on (the chat panel picks it up from here)
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState(storedModel);
  useEffect(() => {
    if (localMode) return;
    offeredModels().then((o) => {
      setModels(o.models);
      setModel((m) => (o.models.some((x) => x.id === m) ? m : o.model || o.models[0]?.id || ""));
    });
  }, []);
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }, [text]);
  useEffect(() => {
    if (!uploadIntent?.fileCount) return;
    readGuestFiles().then((saved) => {
      if (!saved.length) return;
      setFiles(saved);
      setResumeUpload(false);
      if (!uploadIntent.text.trim()) setText("Turn this footage into a polished video");
    }).catch(() => {});
  }, []);
  const addFiles = (incoming: File[]) => {
    if (!incoming.length) return;
    setFiles((current) => [...current, ...incoming]);
    setResumeUpload(false);
    if (!text.trim()) setText("Turn this footage into a polished video");
    clearGuestUploadIntent();
    void clearGuestFiles();
    track("guest_upload_selected", { count: incoming.length });
  };
  const start = async () => {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setBusy(true);
    setError("");
    try {
      track("project_start_submitted", { mode: localMode ? "local" : "agent", aspect, model, count: files.length });
      if (!localMode && model) storeModel(model);
      await startProject(prompt, aspect, files, (n, x) => setProgress((m) => ({ ...m, [n]: x })), style);
      clearGuestUploadIntent();
      void clearGuestFiles();
      if (uploadIntent) track("guest_upload_project_started", { aspect, count: files.length });
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <section className="pl-hero">
      <h1>{localMode ? "Start a film project" : "What are we making?"}</h1>
      {resumeUpload && files.length === 0 && (
        <div className="pl-resume-upload">
          <span><Upload size={17} /><span><strong>You’re signed in.</strong><small>Choose your footage to continue where you left off.</small></span></span>
          <button className="btn primary" onClick={() => picker.current?.click()}>Choose footage</button>
        </div>
      )}
      <div
        className={`pl-compose ${drag ? "drag" : ""}`}
        onDragOver={(e) => e.dataTransfer.types.includes("Files") && (e.preventDefault(), setDrag(true))}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          addFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <textarea
          ref={input}
          rows={2}
          autoFocus
          placeholder={localMode ? "Name your project, or drop footage, images and music here…" : "Describe the video, or drop footage, images and music here…"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), start())}
        />
        {files.length > 0 && (
          <div className="pl-files">
            {files.map((f, i) => (
              <span key={i} className="pl-file" title={f.name}>
                {busy ? <Loader2 size={12} className="spin" /> : <Paperclip size={12} />}
                <span className="ellipsis">{f.name}</span>
                {busy && progress[f.name] !== undefined && <span className="num">{Math.round(progress[f.name] * 100)}%</span>}
                {!busy && (
                  <button className="icon xs" title="Remove" onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}>
                    <X size={11} />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
        <div className="pl-compose-row">
          <button className="icon" title="Attach footage, images or music" onClick={() => picker.current?.click()} disabled={busy}>
            <Paperclip size={15} />
          </button>
          <input ref={picker} type="file" multiple hidden accept="video/*,audio/*,image/*" onChange={(e) => (addFiles(Array.from(e.target.files || [])), (e.target.value = ""))} />
          <div className="seg small">
            {Object.keys(ASPECTS).map((a) => (
              <button key={a} className={aspect === a ? "on" : ""} onClick={() => setAspect(a)}>
                {a}
              </button>
            ))}
          </div>
          {!localMode && <label className="pl-style" title="How your agent works on this project — change it any time in the editor">
            <select value={style} onChange={(e) => setStyle(e.target.value)} disabled={busy}>
              <option value="">Style: let the agent suggest</option>
              {STYLES.map((x) => (
                <option key={x.id} value={x.id} title={x.note}>
                  {x.label}
                </option>
              ))}
            </select>
            <ChevronDown size={11} />
          </label>}
          {!localMode && models.length > 1 && (
            <label className="pl-model" title={models.find((m) => m.id === model)?.note || "The model your agent runs on"}>
              <Cpu size={12} />
              <select value={model} onChange={(e) => (setModel(e.target.value), storeModel(e.target.value))} disabled={busy}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <ChevronDown size={11} />
            </label>
          )}
          <div className="grow" />
          {busy && <span className="muted small">{files.length ? "Uploading…" : "Starting…"}</span>}
          <button className="pl-send" onClick={start} disabled={!text.trim() || busy} title="Start (Enter)">
            {busy ? <Loader2 size={16} className="spin" /> : <ArrowUp size={16} />}
          </button>
        </div>
      </div>
      {!text && (
        <div className="pl-ideas">
          {IDEAS.map((i) => (
            <button key={i} onClick={() => (setText(i), input.current?.focus())}>
              {i}
            </button>
          ))}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

// A blank project with a chosen canvas, for people who'd rather start editing themselves.
function BlankProject() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [canvas, setCanvas] = useState<CanvasValue>({ width: 1920, height: 1080, fps: 30 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc);
    return () => (window.removeEventListener("pointerdown", close), window.removeEventListener("keydown", esc));
  }, [open]);
  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      track("project_start_submitted", { mode: "blank", aspect: `${canvas.width}x${canvas.height}` });
      const p = await api<{ id: string }>("/api/projects", { name: name.trim() || "Untitled", width: canvas.width, height: canvas.height, fps: canvas.fps });
      navigate(`/p/${p.id}`);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <div className="pl-blank" ref={ref}>
      <button className="btn small" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Plus size={14} /> Blank project
      </button>
      {open && (
        <div className="float pl-blank-pop" role="dialog">
          <label className="field">
            <span>Name</span>
            <input autoFocus placeholder="Untitled" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
          </label>
          <label className="field">
            <span>Canvas</span>
            <CanvasPicker value={canvas} onChange={setCanvas} />
          </label>
          {error && <p className="error small">{error}</p>}
          <button className="btn primary" onClick={create} disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" /> : null} Create and open
          </button>
        </div>
      )}
    </div>
  );
}

// One project: its poster in a dark frame (the poster's own shape shows: tall fills, wide letterboxes),
// what it is and when it changed, and a menu for rename and delete.
function ProjectCard({ p, onChanged }: { p: P; onChanged: () => void }) {
  const shapeOf = (r: number) => (r < 0.7 ? "9:16" : r < 0.9 ? "4:5" : r < 1.1 ? "1:1" : r < 2 ? "16:9" : "21:9");
  // the project's canvas says its shape; the poster's own shape is only a fallback
  const [shape, setShape] = useState<string | null>(p.width && p.height ? shapeOf(p.width / p.height) : null);
  const [wide, setWide] = useState(false);
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && (setMenu(false), setConfirm(false));
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);
  const open = () => navigate(`/p/${p.id}`);
  const rename = async () => {
    const n = (renaming || "").trim();
    setRenaming(null);
    if (n && n !== p.name) await api(`/api/projects/${p.id}`, { name: n }).catch(() => {});
    onChanged();
  };
  return (
    <article className={`pl-card ${menu ? "menu-open" : ""}`}>
      <a className="pl-frame" href={`/p/${p.id}`} onClick={(e) => (e.preventDefault(), open())}>
        {p.poster ? (
          <img
            src={p.poster}
            alt=""
            loading="lazy"
            className={wide ? "wide" : ""}
            onLoad={(e) => {
              const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
              if (!w || !h) return;
              const r = w / h;
              setWide(r > 1.05 && !(p.width && p.height && p.height > p.width)); // a wide still in a tall project fills the frame
              if (!(p.width && p.height)) setShape(shapeOf(r));
            }}
          />
        ) : (
          <span className="pl-frame-empty">
            <Film size={20} strokeWidth={1.5} />
            {p.assets ? "No preview yet" : "Empty"}
          </span>
        )}
        <span className="pl-open">
          <Play size={14} fill="currentColor" /> Open
        </span>
        {shape && <span className="pl-shape num">{shape}</span>}
        <span className={`pl-visibility ${p.public === false ? "private" : "public"}`} title={p.public === false ? "Private project" : "Public project"}>{p.public === false ? <LockKeyhole size={11} /> : <Globe2 size={11} />}</span>
      </a>
      <div className="pl-meta">
        {renaming !== null ? (
          <input className="pl-rename" autoFocus value={renaming} onChange={(e) => setRenaming(e.target.value)} onBlur={rename} onKeyDown={(e) => (e.key === "Enter" ? rename() : e.key === "Escape" && setRenaming(null))} />
        ) : (
          <a className="pl-name" href={`/p/${p.id}`} onClick={(e) => (e.preventDefault(), open())} title={p.name}>
            {p.name}
          </a>
        )}
        <span className="pl-sub">
          <span>{ago(p.updated_at)}</span>
          <span className="dot" />
          <span className="num">{p.assets.toLocaleString()}</span> media
        </span>
      </div>
      <div className="pl-more" ref={ref}>
        <button className="icon" title="More" aria-haspopup="menu" aria-expanded={menu} onClick={() => (setMenu(!menu), setConfirm(false))}>
          <MoreHorizontal size={16} />
        </button>
        {menu && (
          <div className="float menu-list" role="menu">
            <button role="menuitem" onClick={() => (setMenu(false), open())}>
              <Play size={13} /> Open
            </button>
            <button role="menuitem" onClick={() => (setMenu(false), setRenaming(p.name))}>
              <Pencil size={13} /> Rename
            </button>
            <div className="menu-sep" />
            <button
              role="menuitem"
              className={`danger ${confirm ? "armed" : ""}`}
              onClick={async () => {
                if (!confirm) return setConfirm(true);
                setMenu(false);
                await api(`/api/projects/${p.id}`, undefined, "DELETE").catch(() => {});
                onChanged();
              }}
            >
              <Trash2 size={13} /> {confirm ? "Click again to delete" : "Delete"}
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

const Skeletons = () => (
  <div className="pl-grid">
    {Array.from({ length: 6 }, (_, i) => (
      <div key={i} className="pl-card skeleton" style={{ animationDelay: `${i * 60}ms` }}>
        <div className="pl-frame" />
        <div className="pl-meta">
          <span className="sk-line" />
          <span className="sk-line short" />
        </div>
      </div>
    ))}
  </div>
);

export function Projects() {
  const [projects, setProjects] = useState<P[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const load = () =>
    api<{ projects: P[] }>("/api/projects")
      .then((r) => (setProjects(r.projects), setError("")))
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (projects || []).filter((p) => !q || p.name.toLowerCase().includes(q));
    const out: [string, P[]][] = [];
    for (const p of list) {
      const g = groupOf(p.updated_at);
      const last = out[out.length - 1];
      if (last && last[0] === g) last[1].push(p);
      else out.push([g, [p]]);
    }
    return out;
  }, [projects, query]);
  return (
    <div className="pl">
      <StartBox />
      <section className="pl-body">
        <header className="pl-head">
          <h2>
            Library {projects && projects.length > 0 && <span className="num muted">{projects.length}</span>}
          </h2>
          <div className="grow" />
          {projects && projects.length > 6 && (
            <label className="pl-search">
              <Search size={13} />
              <input placeholder="Search projects" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
          )}
          <BlankProject />
        </header>
        {error && <p className="error">{error}</p>}
        {projects === null && !error && <Skeletons />}
        {projects && projects.length === 0 && (
          <div className="pl-empty">
            <Film size={22} strokeWidth={1.5} />
            <p>{isLocalMode() ? "Nothing here yet. Create a project above, then edit it here or connect an external agent." : "Nothing here yet. Describe a video above and your agent starts on it."}</p>
            <a href="/settings" onClick={(e) => (e.preventDefault(), navigate("/settings"))}>
              Or connect Claude Code, Codex or Cursor →
            </a>
          </div>
        )}
        {projects && projects.length > 0 && groups.length === 0 && <p className="muted pl-none">No projects match “{query}”.</p>}
        {groups.map(([g, list]) => (
          <div key={g} className="pl-group">
            <h3 className="micro">{g}</h3>
            <div className="pl-grid">
              {list.map((p) => (
                <ProjectCard key={p.id} p={p} onChanged={load} />
              ))}
            </div>
          </div>
        ))}
      </section>
      {!isLocalMode() && <CommunitySection />}
    </div>
  );
}
