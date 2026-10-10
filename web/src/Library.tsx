// The project's media, organised by the story (each ingredient's sheets, each clip's storyboard and
// takes) or by where it came from: what the agent generated (and with what), what was uploaded,
// the storyboard panels cut from sheets, and exports. Pictures sit in a masonry
// grid at their own shape; sound is a list you can play. Click opens the details (preview, how it
// was made, transcript, actions); drag or + puts it on the timeline.
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { Doc } from "./api";
import type { FullAsset } from "./useProject";
import { dragAsset } from "./dragAsset";
import { fmtTime } from "./edits";
import { PlayButton } from "./agent/Play";
import { ItemPill } from "./agent/Items";
import type { Board } from "./agent/Board";
import { Upload, Link2, Film, Music, Image as ImageIcon, Plus, MoreHorizontal, Sparkles, AlertTriangle, Loader2, Search, ChevronDown, ArrowLeft, Download, Copy, Trash2, X, Mic, Clapperboard, MapPin, Palette, User } from "lucide-react";

type Kind = "all" | "video" | "image" | "audio";
type Group = "generated" | "uploaded" | "frames" | "exports";
const GROUPS: { id: Group; label: string }[] = [
  { id: "generated", label: "Generated" },
  { id: "uploaded", label: "Uploaded" },
  { id: "frames", label: "Storyboard panels" },
  { id: "exports", label: "Exports" },
];
const MADE_WITH: Record<string, string> = { voice: "Voice", music: "Music", "music/exact": "Music", sfx: "Sound effect", image: "Image", "image/fast": "Image", video: "Video", "video/ref": "Video", "video/omni": "Video", "video/edit": "Video edit", "video/extend": "Extended video", "video/talk": "Talking video", "video/upscale": "Upscale" };

const isGenerated = (a: FullAsset) => a.roles?.includes("generated") || a.origin?.kind === "generation" || a.origin?.kind === "baked";
const groupOf = (a: FullAsset): Group => (a.roles?.includes("render") ? "exports" : a.roles?.includes("frame") || a.origin?.kind === "panel" ? "frames" : isGenerated(a) ? "generated" : "uploaded");
const madeWith = (a: FullAsset) => (a.generated?.model ? MADE_WITH[a.generated.model] || a.generated.model : a.baked ? a.baked.recipe ? `Script · ${a.baked.recipe}` : "Script" : isGenerated(a) ? "Generated" : "");
const kindIcon = (a: FullAsset, size = 16) => (a.kind === "audio" ? a.generated?.model === "voice" ? <Mic size={size} /> : <Music size={size} /> : a.kind === "image" ? <ImageIcon size={size} /> : <Film size={size} />);
const FRESH_MS = 90_000;

// What a piece of media belongs to on the board: an ingredient (its sheets, samples, voice) or a
// clip (its storyboard sheet, panels and takes). From the board's own lists, then the generation's
// "for", then a panel's storyboard.
type Owner = { key: string; kind: "item" | "clip"; name: string; label: string; clip?: string; order: number };
function ownersOf(board: Board | null | undefined, assets: FullAsset[]) {
  const out = new Map<string, Owner>();
  if (!board) return out;
  const items: Owner[] = [];
  const set = (id: string | undefined | null, o: Owner) => id && !out.has(id) && out.set(id, o);
  board.cast.forEach((c, i) => {
    const o: Owner = { key: `cast:${c.id}`, kind: "item", name: c.name || c.id, label: c.name || c.id, order: i };
    items.push(o);
    for (const r of c.refs || []) set(r.asset_id, o);
    for (const a of c.sheets || []) set(a, o);
    set(c.voice?.sample, o);
  });
  board.places.forEach((p, i) => {
    const o: Owner = { key: `place:${p.id}`, kind: "item", name: p.name || p.id, label: p.name || p.id, order: 100 + i };
    items.push(o);
    for (const r of p.refs || []) set(r.asset_id, o);
    for (const a of p.sheets || []) set(a, o);
  });
  (board.music || []).forEach((m, i) => {
    const o: Owner = { key: `music:${m.id}`, kind: "item", name: m.name || m.id, label: m.name || m.id, order: 200 + i };
    items.push(o);
    set(m.sample, o);
    for (const a of m.samples || []) set(a, o);
  });
  const look: Owner = { key: "look", kind: "item", name: "Look", label: "Look", order: -1 };
  for (const o of board.look?.options || []) set(o.frame, look);
  for (const r of board.look?.refs || []) set(r.asset_id, look);
  const clips = new Map<string, Owner>();
  board.storyboards.forEach((sb, i) => {
    const o: Owner = { key: `clip:${sb.id}`, kind: "clip", name: sb.title || `Clip ${i + 1}`, label: `${i + 1} · ${sb.title || "Untitled"}`, clip: sb.id, order: 1000 + i };
    clips.set(String(sb.id), o);
    set(sb.sheet, o);
    for (const a of sb.sheets || []) set(a, o);
    for (const a of sb.takes || []) set(a, o);
  });
  const byFor = (f: Record<string, string> | undefined) => {
    if (!f) return null;
    if (f.storyboard) return clips.get(String(f.storyboard)) || null;
    const k = f.cast ? `cast:${f.cast}` : f.voice ? `cast:${f.voice}` : f.place ? `place:${f.place}` : f.music ? `music:${f.music}` : f.look !== undefined ? "look" : "";
    return k === "look" ? look : items.find((o) => o.key === k) || null;
  };
  for (const a of assets) {
    if (out.has(a.id)) continue;
    const o = byFor(a.origin?.for) || (a.origin?.storyboard !== undefined ? clips.get(String(a.origin.storyboard)) : null);
    if (o) out.set(a.id, o);
  }
  return out;
}
const STATUS: Record<string, string> = { uploading: "Uploading", processing: "Processing", queued: "Queued", failed: "Failed" };

export function Library({
  projectId,
  doc,
  assets,
  uploads,
  onFiles,
  onAdd,
  reload,
  setError,
  board,
}: {
  board?: Board | null;
  projectId: string;
  doc: Doc;
  assets: FullAsset[];
  uploads: Record<string, number>;
  onFiles: (files: FileList | File[]) => void;
  onAdd: (a: FullAsset) => void;
  reload: () => void;
  setError: (s: string) => void;
}) {
  const [kind, setKind] = useState<Kind>("all");
  const owners = useMemo(() => ownersOf(board, assets), [board, assets]);
  const hasStory = owners.size > 0;
  const [view, setView] = useState<"story" | "kind" | null>(null); // null: by story when the board has items
  const byStory = (view ?? (hasStory ? "story" : "kind")) === "story";
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [inspect, setInspect] = useState<string | null>(null);
  const [closed, setClosed] = useState<Record<string, boolean>>({ exports: true });
  const [hover, setHover] = useState<string | null>(null);
  const [drop, setDrop] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const used = useMemo(() => new Set(Object.values(doc.sequence.items).map((i) => i.asset).filter(Boolean)), [doc]);
  const portrait = doc.settings.height > doc.settings.width;

  const q = query.trim().toLowerCase();
  const matches = (a: FullAsset) => (kind === "all" || a.kind === kind) && (!q || a.name.toLowerCase().includes(q) || String(a.generated?.prompt || "").toLowerCase().includes(q) || madeWith(a).toLowerCase().includes(q));
  const counts = useMemo(() => {
    const c: Record<Kind, number> = { all: 0, video: 0, image: 0, audio: 0 };
    for (const a of assets) if (!a.roles?.includes("render")) (c.all++, (c[a.kind as Kind] = (c[a.kind as Kind] || 0) + 1));
    return c;
  }, [assets]);
  const groups = useMemo(() => {
    const by: Record<Group, FullAsset[]> = { generated: [], uploaded: [], frames: [], exports: [] };
    for (const a of assets) if (matches(a)) by[groupOf(a)].push(a);
    for (const g of Object.values(by)) g.sort((x, y) => (y.created_at || "").localeCompare(x.created_at || ""));
    return by;
  }, [assets, kind, q]);
  const total = Object.values(groups).reduce((n, g) => n + g.length, 0);
  // by story: one section per ingredient and per clip (in board order), then what has no owner
  const story = useMemo(() => {
    if (!byStory) return [];
    const secs = new Map<string, { o: Owner; list: FullAsset[] }>();
    const rest: Record<Group, FullAsset[]> = { generated: [], uploaded: [], frames: [], exports: [] };
    for (const a of assets) {
      if (!matches(a)) continue;
      const o = a.roles?.includes("render") ? null : owners.get(a.id);
      if (o) (secs.get(o.key) || secs.set(o.key, { o, list: [] }).get(o.key)!).list.push(a);
      else rest[groupOf(a)].push(a);
    }
    const all = [...secs.values()].sort((x, y) => x.o.order - y.o.order);
    for (const g of all) g.list.sort((x, y) => (y.created_at || "").localeCompare(x.created_at || ""));
    return [
      ...all.filter((g) => g.o.kind === "item").map((g, i) => ({ id: g.o.key, head: i === 0 ? "Ingredients" : "", o: g.o, list: g.list })),
      ...all.filter((g) => g.o.kind === "clip").map((g, i) => ({ id: g.o.key, head: i === 0 ? "Clips" : "", o: g.o, list: g.list })),
      ...(["uploaded", "generated", "frames", "exports"] as Group[]).filter((g) => rest[g].length).map((g, i) => ({ id: g, head: i === 0 ? "Other media" : "", o: null as Owner | null, list: rest[g], label: g === "generated" ? "Other generated" : GROUPS.find((x) => x.id === g)!.label })),
    ];
  }, [byStory, assets, owners, kind, q]);
  const inUse = useMemo(() => {
    // a clip's take in use: on the timeline, else the one picked on the board
    const picks = new Set<string>();
    for (const sb of board?.storyboards || []) for (const t of sb.takes || []) if (used.has(t)) picks.add(t);
    return picks;
  }, [board, used]);
  const inspected = inspect ? assets.find((a) => a.id === inspect) : undefined;
  useEffect(() => {
    if (inspect && !inspected) setInspect(null);
  }, [inspect, inspected]);

  const importUrl = async () => {
    if (!url?.trim()) return;
    setImporting(true);
    try {
      await api(`/api/projects/${projectId}/import`, { url: url.trim() });
      setUrl(null);
      reload();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setImporting(false);
    }
  };
  const actions = {
    rename: async (a: FullAsset, name: string) => {
      if (!name.trim() || name === a.name) return;
      await api(`/api/assets/${a.id}`, { name: name.trim() }).catch((e) => setError(e.message));
      reload();
    },
    remove: async (a: FullAsset) => {
      setMenu(null);
      await api(`/api/assets/${a.id}`, undefined, "DELETE").catch((e) => setError(e.message));
      reload();
    },
    download: async (a: FullAsset) => {
      setMenu(null);
      const r = await api<{ url: string }>(`/api/assets/${a.id}/url?kind=download`).catch((e) => (setError(e.message), null));
      if (r) window.open(r.url, "_blank");
    },
    transcribe: async (a: FullAsset) => {
      setMenu(null);
      await api(`/api/assets/${a.id}/transcribe`, {}).catch((e) => setError(e.message));
      reload();
    },
  };

  if (inspected) return <Detail a={inspected} owner={owners.get(inspected.id) || null} used={used.has(inspected.id)} onBack={() => setInspect(null)} onAdd={onAdd} actions={actions} />;

  const card = (a: FullAsset) => {
    const ready = a.status === "ready";
    const fresh = isGenerated(a) && a.created_at && Date.now() - new Date(a.created_at).getTime() < FRESH_MS;
    const audio = a.kind === "audio";
    return (
      <div
        key={a.id}
        className={`acard ${audio ? "row" : "tile"} ${a.status} ${used.has(a.id) ? "used" : ""} ${fresh ? "fresh" : ""} ${inUse.has(a.id) ? "pick" : ""}`}
        draggable={ready}
        onDragStart={(e) => {
          dragAsset.current = a;
          e.dataTransfer.setData("application/x-studio-asset", a.id);
          e.dataTransfer.effectAllowed = "copy";
        }}
        onDragEnd={() => (dragAsset.current = null)}
        onClick={() => setInspect(a.id)}
        onDoubleClick={(e) => (e.stopPropagation(), ready && onAdd(a))}
        onMouseEnter={() => setHover(a.id)}
        onMouseLeave={() => (setHover(null), menu === a.id && setMenu(null))}
        title={`${a.name}\nClick for details · double-click or drag to add`}
      >
        <div className="acard-thumb" style={!audio && !a.poster && !(a.kind === "image" && a.proxy) ? { aspectRatio: portrait ? "9 / 16" : "16 / 9" } : undefined}>
          {audio ? (
            ready && a.proxy ? (
              <span onClick={(e) => e.stopPropagation()}>
                <PlayButton url={a.proxy} label="" className="acard-play" title={`Play ${a.name}`} />
              </span>
            ) : (
              <span className="ico">{kindIcon(a)}</span>
            )
          ) : hover === a.id && a.kind === "video" && a.proxy && ready ? (
            <video src={a.proxy} muted autoPlay loop playsInline poster={a.poster || undefined} />
          ) : a.poster || (a.kind === "image" && a.proxy) ? (
            <img src={(a.kind === "image" && a.proxy) || a.poster!} alt="" draggable={false} loading="lazy" />
          ) : (
            <span className="ico">{kindIcon(a, 20)}</span>
          )}
          {!audio && a.duration_s ? <span className="dur num">{fmtTime(a.duration_s)}</span> : null}
          {!audio && isGenerated(a) && (
            <span className="gen-badge" title={a.generated?.prompt || "Generated"}>
              <Sparkles size={10} />
            </span>
          )}
          {!ready && (
            <span className="acard-status">
              {a.status === "failed" ? <AlertTriangle size={13} /> : <Loader2 size={13} className="spin" />} {STATUS[a.status] || a.status}
            </span>
          )}
        </div>
        {audio && (
          <div className="acard-row-text">
            <span className="ellipsis">{a.name}</span>
            <span className="acard-sub">
              {madeWith(a) || "Audio"}
              {a.duration_s ? <span className="num"> · {fmtTime(a.duration_s)}</span> : null}
              {!ready && <span> · {STATUS[a.status] || a.status}</span>}
            </span>
            {a.waveform && <span className="acard-wave" style={{ backgroundImage: `url(${a.waveform})` }} />}
          </div>
        )}
        {!audio && <div className="acard-name ellipsis">{a.name}</div>}
        <div className="acard-tools" onClick={(e) => e.stopPropagation()}>
          {ready && (
            <button className="acard-add" title="Add to timeline at the playhead" onClick={() => onAdd(a)}>
              <Plus size={13} />
            </button>
          )}
          <button className="acard-more" title="More" onClick={() => setMenu(menu === a.id ? null : a.id)}>
            <MoreHorizontal size={13} />
          </button>
          {menu === a.id && (
            <div className="menu acard-menu">
              <button onClick={() => (setInspect(a.id), setMenu(null))}>Details</button>
              <button onClick={() => (navigator.clipboard?.writeText(a.id), setMenu(null))}>Copy id for your agent</button>
              <button onClick={() => actions.download(a)}>Download original</button>
              {a.kind !== "image" && ready && a.transcript_words === undefined && <button onClick={() => actions.transcribe(a)}>Transcribe</button>}
              <hr />
              <button className="danger" disabled={used.has(a.id)} title={used.has(a.id) ? "Remove it from the timeline first" : ""} onClick={() => actions.remove(a)}>
                Delete
              </button>
            </div>
          )}
        </div>
        {used.has(a.id) && <span className="acard-used" title="On the timeline" />}
        {inUse.has(a.id) && <span className="acard-pick">In the cut</span>}
      </div>
    );
  };

  return (
    <div
      className={`lib ${drop ? "dropping" : ""}`}
      onDragOver={(e) => e.dataTransfer.types.includes("Files") && (e.preventDefault(), setDrop(true))}
      onDragLeave={(e) => e.currentTarget === e.target && setDrop(false)}
      onDrop={() => setDrop(false)}
    >
      <div className="lib-head">
        <label className="lib-search">
          <Search size={13} />
          <input placeholder="Search media" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQuery("")} />
          {query && (
            <button className="icon xs" onClick={() => setQuery("")} title="Clear">
              <X size={12} />
            </button>
          )}
        </label>
        <button className="icon" title="Import from a link" onClick={() => setUrl(url === null ? "" : null)}>
          <Link2 size={15} />
        </button>
        <button className="btn small primary" onClick={() => fileRef.current?.click()} title="Upload video, audio or images">
          <Upload size={13} /> Upload
        </button>
        <input ref={fileRef} type="file" multiple hidden accept="video/*,audio/*,image/*" onChange={(e) => (e.target.files && onFiles(e.target.files), (e.target.value = ""))} />
      </div>
      {url !== null && (
        <div className="lib-url">
          <input autoFocus placeholder="https://… mp4, mov, mp3, wav, png, jpg" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => (e.key === "Enter" ? importUrl() : e.key === "Escape" && setUrl(null))} />
          <button className="btn small" disabled={importing || !url.trim()} onClick={importUrl}>
            {importing ? <Loader2 size={13} className="spin" /> : "Import"}
          </button>
        </div>
      )}
      {hasStory && (
        <div className="seg small lib-view" title="Group the media by what it belongs to in the story, or by where it came from">
          <button className={byStory ? "on" : ""} onClick={() => setView("story")}>
            By story
          </button>
          <button className={!byStory ? "on" : ""} onClick={() => setView("kind")}>
            By source
          </button>
        </div>
      )}
      <div className="seg small lib-kinds">
        {(["all", "video", "image", "audio"] as Kind[]).map((k) => (
          <button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
            {k === "all" ? "All" : k === "image" ? "Images" : k[0].toUpperCase() + k.slice(1)}
            <span className="num">{counts[k] || 0}</span>
          </button>
        ))}
      </div>

      {Object.keys(uploads).length > 0 && (
        <div className="lib-uploads">
          {Object.entries(uploads).map(([n, p]) => (
            <div key={n} className="upload-row">
              <Loader2 size={12} className="spin" />
              <span className="ellipsis">{n}</span>
              <span className="num">{Math.round(p * 100)}%</span>
              <div className="meter">
                <div style={{ width: `${Math.round(p * 100)}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {total === 0 && Object.keys(uploads).length === 0 && (
        q || kind !== "all" ? (
          <p className="lib-none">Nothing matches{q ? ` “${query}”` : ""}.</p>
        ) : (
          <button className="lib-empty" onClick={() => fileRef.current?.click()}>
            <span className="lib-empty-icon">
              <Upload size={18} />
            </span>
            <strong>Drop footage, images or music</strong>
            <span>Or click to upload. What your agent generates lands here too.</span>
          </button>
        )
      )}

      {byStory &&
        story.map((g) => {
          const pics = g.list.filter((a) => a.kind !== "audio");
          const sound = g.list.filter((a) => a.kind === "audio");
          const shut = closed[g.id] && !q;
          return (
            <section key={g.id} className={`lib-sec ${g.o ? "owned" : ""}`}>
              {g.head && <div className="lib-story-head micro">{g.head}</div>}
              <div className="lib-sec-head">
                <button className="lib-sec-toggle" onClick={() => setClosed((c) => ({ ...c, [g.id]: !c[g.id] }))} aria-label={shut ? "Show" : "Hide"}>
                  <ChevronDown size={12} className={shut ? "shut" : ""} />
                </button>
                {g.o?.kind === "item" ? (
                  <span className="lib-owner" title={`${g.o.name}: sheets, samples and voice`}>
                    {g.o.key.startsWith("place:") ? <MapPin size={11} /> : g.o.key.startsWith("music:") ? <Music size={11} /> : g.o.key === "look" ? <Palette size={11} /> : <User size={11} />} {g.o.label}
                  </span>
                ) : g.o?.kind === "clip" ? (
                  <button className="lib-clip-link" title="Open this clip on the board" onClick={() => window.dispatchEvent(new CustomEvent("studio:view", { detail: { view: "board", clip: g.o!.clip } }))}>
                    <Clapperboard size={11} /> {g.o.label}
                  </button>
                ) : (
                  <span className="micro">{(g as any).label}</span>
                )}
                <span className="num">{g.list.length}</span>
              </div>
              {!shut && (
                <>
                  {pics.length > 0 && <div className="lib-grid">{pics.map(card)}</div>}
                  {sound.length > 0 && <div className="lib-list">{sound.map(card)}</div>}
                </>
              )}
            </section>
          );
        })}
      {!byStory && GROUPS.map(({ id, label }) => {
        const list = groups[id];
        if (!list.length) return null;
        const pics = list.filter((a) => a.kind !== "audio");
        const sound = list.filter((a) => a.kind === "audio");
        const shut = closed[id] && !q;
        return (
          <section key={id} className="lib-sec">
            <button className="lib-sec-head" onClick={() => setClosed((c) => ({ ...c, [id]: !c[id] }))}>
              <ChevronDown size={12} className={shut ? "shut" : ""} />
              <span className="micro">{label}</span>
              <span className="num">{list.length}</span>
            </button>
            {!shut && (
              <>
                {pics.length > 0 && <div className="lib-grid">{pics.map(card)}</div>}
                {sound.length > 0 && <div className="lib-list">{sound.map(card)}</div>}
              </>
            )}
          </section>
        );
      })}
      {drop && (
        <div className="lib-drop">
          <Upload size={18} /> Drop to upload
        </div>
      )}
    </div>
  );
}

function Detail({
  a,
  owner,
  used,
  onBack,
  onAdd,
  actions,
}: {
  a: FullAsset;
  owner: Owner | null;
  used: boolean;
  onBack: () => void;
  onAdd: (a: FullAsset) => void;
  actions: { rename: (a: FullAsset, n: string) => Promise<void>; remove: (a: FullAsset) => Promise<void>; download: (a: FullAsset) => Promise<void>; transcribe: (a: FullAsset) => Promise<void> };
}) {
  const [name, setName] = useState(a.name);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setName(a.name), [a.id, a.name]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === "Escape" && !(e.target as HTMLElement)?.closest?.("input,textarea") && onBack();
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onBack]);
  const ready = a.status === "ready";
  const dims = a.video?.split("@")[0]?.replace("x", "×");
  const rows: [string, React.ReactNode][] = [
    ["Kind", isGenerated(a) ? `Generated ${(madeWith(a) || a.kind).toLowerCase()}` : groupOf(a) === "frames" ? "Storyboard panel" : `Uploaded ${a.kind}`],
    ...(a.duration_s ? [["Length", <span className="num">{fmtTime(a.duration_s)}</span>] as [string, React.ReactNode]] : []),
    ...(dims ? [["Size", <span className="num">{dims}</span>] as [string, React.ReactNode]] : []),
    ...(a.transcript_words !== undefined ? [["Transcript", <span className="num">{a.transcript_words} words</span>] as [string, React.ReactNode]] : []),
    ...(owner
      ? [[
          "Belongs to",
          owner.kind === "item" ? (
            <span className="lib-owner">
              <ItemPill name={owner.name} />
            </span>
          ) : (
            <button className="lib-clip-link" onClick={() => window.dispatchEvent(new CustomEvent("studio:view", { detail: { view: "board", clip: owner.clip } }))}>
              <Clapperboard size={11} /> Clip {owner.label}
            </button>
          ),
        ] as [string, React.ReactNode]]
      : []),
    ["Timeline", used ? "In use" : "Not used yet"],
    ...(a.created_at ? [["Added", new Date(a.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })] as [string, React.ReactNode]] : []),
  ];
  return (
    <div className="lib lib-detail">
      <div className="lib-detail-head">
        <button className="btn small ghost" onClick={onBack} title="Back to media (Esc)">
          <ArrowLeft size={14} /> Media
        </button>
      </div>
      <div className="lib-preview">
        {a.kind === "video" && a.proxy ? (
          <video src={a.proxy} poster={a.poster || undefined} controls playsInline />
        ) : a.kind === "image" && (a.proxy || a.poster) ? (
          <img src={a.proxy || a.poster!} alt="" />
        ) : a.kind === "audio" ? (
          <div className="lib-preview-audio">
            {a.waveform && <span className="acard-wave big" style={{ backgroundImage: `url(${a.waveform})` }} />}
            {ready && a.proxy && <PlayButton url={a.proxy} label="Play" className="btn small" />}
          </div>
        ) : (
          <span className="ico">{kindIcon(a, 24)}</span>
        )}
        {!ready && (
          <span className="acard-status">
            {a.status === "failed" ? <AlertTriangle size={13} /> : <Loader2 size={13} className="spin" />} {STATUS[a.status] || a.status}
          </span>
        )}
      </div>
      <input className="lib-detail-name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => actions.rename(a, name)} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} aria-label="Name" />
      <div className="lib-detail-actions">
        <button className="btn small primary" disabled={!ready} onClick={() => onAdd(a)}>
          <Plus size={13} /> Add to timeline
        </button>
        <button className="btn small" onClick={() => actions.download(a)} title="Download the original">
          <Download size={13} />
        </button>
        <button className="btn small" onClick={() => navigator.clipboard?.writeText(a.id)} title="Copy the id, to mention it to your agent">
          <Copy size={13} />
        </button>
        <div className="grow" />
        <button className={`btn small ${confirm ? "danger" : "ghost"}`} disabled={used} title={used ? "Remove it from the timeline first" : "Delete"} onClick={() => (confirm ? actions.remove(a) : setConfirm(true))} onMouseLeave={() => setConfirm(false)}>
          <Trash2 size={13} /> {confirm ? "Delete?" : ""}
        </button>
      </div>
      {a.error && <p className="error small">{typeof a.error === "string" ? a.error : JSON.stringify(a.error)}</p>}
      {a.generated && (
        <div className="lib-made">
          <span className="micro">
            <Sparkles size={10} /> Made by your agent
          </span>
          {a.generated.prompt && <p>{a.generated.prompt.length >= 120 ? a.generated.prompt.trimEnd() + "…" : a.generated.prompt}</p>}
          <span className="muted small num">
            {a.generated.model}
            {a.generated.take ? ` · take ${a.generated.take}` : ""}
            {a.generated.seed !== undefined && a.generated.seed !== null ? ` · seed ${a.generated.seed}` : ""}
          </span>
        </div>
      )}
      {a.baked && <MadeByScript b={a.baked} />}
      <dl className="lib-kv">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {a.kind !== "image" && ready && a.transcript_words === undefined && (
        <button className="btn small" onClick={() => actions.transcribe(a)}>
          Transcribe
        </button>
      )}
    </div>
  );
}

// A file your agent made with a script: what for, the recipe, the parameters (what a re-bake changes)
// and the script itself, folded.
function MadeByScript({ b }: { b: NonNullable<FullAsset["baked"]> }) {
  const [open, setOpen] = useState(false);
  const params = b.params ? Object.entries(b.params).slice(0, 8) : [];
  return (
    <div className="lib-made">
      <span className="micro">
        <Sparkles size={10} /> Made by a script{b.recipe ? ` · ${b.recipe}` : ""}
      </span>
      {b.note && <p>{b.note}</p>}
      {params.length > 0 && (
        <span className="muted small num">
          {params.map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" · ").slice(0, 240)}
        </span>
      )}
      {(b.parent || b.inputs?.length) && (
        <span className="muted small num">
          {b.inputs?.length ? `from ${b.inputs.join(", ")}` : ""}
          {b.parent ? `${b.inputs?.length ? " · " : ""}re-bake of ${b.parent}` : ""}
        </span>
      )}
      {(b.script || b.script_path) && (
        <>
          <button className="btn ghost small lib-script-toggle" onClick={() => setOpen(!open)}>
            {open ? "Hide the script" : "Show the script"}
          </button>
          {open && <pre className="lib-script">{b.script || b.script_path}</pre>}
        </>
      )}
    </div>
  );
}
