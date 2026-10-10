import { useIsMobile } from "./useIsMobile";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Doc, Item, Track } from "./api";
import type { FullAsset } from "./useProject";
import type { Clock } from "./clock";
import { Eye, EyeOff, Lock, Unlock, Volume2, VolumeX, Magnet, Type, Captions, Film, Music, Mic, AudioLines, Plus, Image as ImageIcon } from "lucide-react";
import { accepts, assetDuration, endOf, fpsOf, isFree, itemsOnTrack, keyTimes, mainTrackId, seqEnd, trackOf, ensureTrack, hasAudio } from "./edits";
import { dragAsset } from "./dragAsset";

const HEAD_DESKTOP = 148; // track headers; narrower on phones
const RULER = 28;
const PAD_END_S = 12;
const rowHeight = (t: Track, main: boolean) => (main ? 68 : t.kind === "video" ? 54 : t.kind === "audio" ? 46 : 32);

type MoveDrag = { kind: "move"; anchor: string; ids: string[]; x0: number; y0: number; moved: boolean; dF: number; target: string; insertIndex?: number; snapAt?: number; valid: boolean };
type TrimDrag = { kind: "trim"; id: string; item: Item; edge: "start" | "end"; x0: number; dF: number; snapAt?: number };
type DropGhost = { trackId: string | null; frame: number; len: number; insertIndex?: number; name: string };

// Natural size of filmstrip images, loaded once per URL.
const stripSizes = new Map<string, { w: number; h: number }>();
function useStripSize(url?: string | null) {
  const [size, setSize] = useState(url ? stripSizes.get(url) : undefined);
  useEffect(() => {
    if (!url) return;
    const known = stripSizes.get(url);
    if (known) return setSize(known);
    const img = new Image();
    img.onload = () => {
      const s = { w: img.naturalWidth, h: img.naturalHeight };
      stripSizes.set(url, s);
      setSize(s);
    };
    img.src = url;
  }, [url]);
  return size;
}

export type TimelineProps = {
  doc: Doc;
  assets: Record<string, FullAsset>;
  clock: Clock;
  playing: boolean;
  pps: number;
  setPps: (v: number) => void;
  selection: string[];
  setSelection: (ids: string[]) => void;
  selectedTransition?: string;
  setSelectedTransition: (id?: string) => void;
  magnet: boolean;
  snapping: boolean;
  cueList: { s: number; e: number; text: string }[];
  onSeek: (t: number) => void;
  edit: (ops: any[], label?: string) => Promise<boolean>;
  preview: (ops: any[]) => boolean;
  beginPreview: () => void;
  endPreview: () => void;
  onDropAsset: (assetId: string, trackId: string | null, frame: number, insertIndex?: number) => void;
  onItemMenu: (e: React.MouseEvent, id: string) => void;
  onAddTransition: (fromId: string, toId: string) => void;
  // items the agent just added or changed, shown with a brief glow
  flash?: string[];
};

export function Timeline(p: TimelineProps) {
  const HEAD = useIsMobile() ? 92 : HEAD_DESKTOP;
  const { doc, pps } = p;
  const fps = fpsOf(doc);
  const main = mainTrackId(doc);
  const scrollRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, width: 1200 });
  const [moveView, setMoveView] = useState<MoveDrag | null>(null);
  const [trimSnap, setTrimSnap] = useState<number | undefined>();
  const [ghost, setGhost] = useState<DropGhost | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const drag = useRef<MoveDrag | TrimDrag | null>(null);
  const pRef = useRef(p);
  pRef.current = p;

  const display = useMemo(() => [...doc.sequence.tracks.filter((t) => t.kind !== "audio")].reverse().concat(doc.sequence.tracks.filter((t) => t.kind === "audio")), [doc.sequence.tracks]);
  const rows = useMemo(() => {
    let y = 0;
    return display.map((t) => {
      const h = rowHeight(t, t.id === main);
      const r = { track: t, top: y, height: h };
      y += h;
      return r;
    });
  }, [display, main]);
  const totalH = rows.reduce((s, r) => s + r.height, 0);
  const durS = seqEnd(doc) / fps;
  const contentW = Math.max(view.width, (durS + PAD_END_S) * pps);
  const x = (f: number) => (f / fps) * pps;

  // ---------- geometry helpers ----------
  const laneX = (clientX: number) => {
    const el = scrollRef.current!;
    return clientX - el.getBoundingClientRect().left - HEAD + el.scrollLeft;
  };
  const frameAt = (clientX: number) => Math.max(0, Math.round((laneX(clientX) / pps) * fps));
  const rowAt = (clientY: number) => {
    const el = scrollRef.current!;
    const y = clientY - el.getBoundingClientRect().top + el.scrollTop - RULER;
    return rows.find((r) => y >= r.top && y < r.top + r.height);
  };

  // ---------- scroll / zoom ----------
  const updateView = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setView((v) => {
      const left = Math.floor(el.scrollLeft / 200) * 200; // quantised so scrolling re-renders rarely
      const width = el.clientWidth - HEAD;
      return v.left === left && v.width === width ? v : { left, width };
    });
  }, []);
  useLayoutEffect(() => {
    updateView();
    const el = scrollRef.current!;
    const ro = new ResizeObserver(updateView);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateView]);

  // ctrl/⌘ + wheel (and trackpad pinch) zooms around the pointer
  useEffect(() => {
    const el = scrollRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const cur = pRef.current.pps;
      const next = Math.max(4, Math.min(600, cur * Math.exp(-e.deltaY * 0.01)));
      const lx = e.clientX - el.getBoundingClientRect().left - HEAD;
      const t = (el.scrollLeft + lx) / cur;
      pRef.current.setPps(next);
      requestAnimationFrame(() => (el.scrollLeft = Math.max(0, t * next - lx)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // keep the playhead where it was on screen when zoom changes from the toolbar
  const lastPps = useRef(pps);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || lastPps.current === pps) return;
    const t = p.clock.get();
    const onScreen = t * lastPps.current - el.scrollLeft;
    lastPps.current = pps;
    el.scrollLeft = Math.max(0, t * pps - (onScreen >= 0 && onScreen <= el.clientWidth - HEAD ? onScreen : (el.clientWidth - HEAD) / 2));
    updateView();
  }, [pps, p.clock, updateView]);

  // playhead follows the clock without re-rendering the timeline; the view pages along while playing
  useEffect(() => {
    const place = (t: number) => {
      const el = playheadRef.current,
        sc = scrollRef.current;
      if (!el || !sc) return;
      const px = t * pRef.current.pps;
      el.style.transform = `translateX(${px}px)`;
      if (pRef.current.playing && !drag.current) {
        const w = sc.clientWidth - HEAD;
        if (px > sc.scrollLeft + w - 40 || px < sc.scrollLeft) sc.scrollLeft = Math.max(0, px - 60);
      }
    };
    place(p.clock.get());
    return p.clock.subscribe(place);
  }, [p.clock, pps]);

  // ---------- snapping ----------
  const snapPoints = (exclude: string[]) => {
    const pts = new Set<number>([0, Math.round(p.clock.get() * fps)]);
    for (const it of Object.values(doc.sequence.items)) {
      if (exclude.includes(it.id) || it.kind === "captions") continue;
      pts.add(it.start);
      pts.add(endOf(it));
    }
    for (const m of Object.values(doc.sequence.markers || {})) pts.add((m as any).at);
    return [...pts];
  };
  const snap = (edges: number[], exclude: string[]) => {
    if (!p.snapping) return null;
    let best: { adj: number; at: number; dist: number } | null = null;
    for (const pt of snapPoints(exclude))
      for (const e of edges) {
        const dist = (Math.abs(pt - e) / fps) * pps;
        if (dist < 8 && (!best || dist < best.dist)) best = { adj: pt - e, at: pt, dist };
      }
    return best;
  };

  // ---------- trimming ----------
  const trimLimits = (it: Item, edge: "start" | "end") => {
    const a = it.asset ? p.assets[it.asset] : undefined;
    const magMain = p.magnet && it.trackId === main;
    const speed = it.speed || 1;
    const srcMax = it.kind === "clip" && a && it.source ? Math.floor(((assetDuration(a) * 1000 - it.source.inMs) / 1000 / speed) * fps) : Infinity;
    const head = it.kind === "clip" && it.source ? Math.floor((it.source.inMs / 1000 / speed) * fps) : Infinity;
    const list = itemsOnTrack(doc, it.trackId);
    const i = list.findIndex((x) => x.id === it.id);
    const prev = list[i - 1],
      next = list[i + 1];
    if (edge === "end") {
      let max = srcMax - it.duration;
      if (!magMain && next) max = Math.min(max, next.start - endOf(it));
      return [-(it.duration - 1), max];
    }
    let min = -head;
    if (!magMain) min = Math.max(min, -(it.start - (prev ? endOf(prev) : 0)));
    return [min, it.duration - 1];
  };
  const trimOps = (it: Item, edge: "start" | "end", dF: number) => {
    const magMain = p.magnet && it.trackId === main;
    if (edge === "end") return [{ op: "trim", item: it.id, edge: "end", to: { f: endOf(it) + dF }, ...(magMain ? { ripple: true } : {}) }];
    if (magMain && dF > 0) return [{ op: "trim", item: it.id, edge: "start", to: { f: it.start + dF }, ripple: true }];
    if (magMain && dF < 0) {
      const D = -dF;
      const ops: any[] = [];
      if (it.source) ops.push({ op: "slip", item: it.id, by: { ms: -Math.round((D / fps) * 1000 * (it.speed || 1)) } });
      ops.push({ op: "trim", item: it.id, edge: "end", to: { f: endOf(it) + D }, ripple: true });
      return ops;
    }
    return [{ op: "trim", item: it.id, edge: "start", to: { f: it.start + dF } }];
  };

  // ---------- pointer gestures ----------
  const onItemDown = (e: React.PointerEvent, it: Item, zone: "body" | "start" | "end") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const sel = p.selection;
    p.setSelectedTransition(undefined);
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      p.setSelection(sel.includes(it.id) ? sel.filter((x) => x !== it.id) : [...sel, it.id]);
      return;
    }
    const nextSel = sel.includes(it.id) ? sel : [it.id];
    if (!sel.includes(it.id)) p.setSelection(nextSel);
    if (trackOf(doc, it.trackId)?.locked || it.kind === "captions") return;
    if (zone === "body") {
      const ids = nextSel.filter((id) => {
        const x = doc.sequence.items[id];
        return x && x.kind !== "captions" && !trackOf(doc, x.trackId)?.locked && (id === it.id || !(p.magnet && x.trackId === main));
      });
      drag.current = { kind: "move", anchor: it.id, ids: p.magnet && it.trackId === main ? [it.id] : ids, x0: e.clientX, y0: e.clientY, moved: false, dF: 0, target: it.trackId, valid: true };
    } else {
      p.beginPreview();
      drag.current = { kind: "trim", id: it.id, item: it, edge: zone, x0: e.clientX, dF: 0 };
    }
    window.addEventListener("pointermove", onWinMove);
    window.addEventListener("pointerup", onWinUp, { once: true });
  };

  const onWinMove = (e: PointerEvent) => {
    const g = drag.current;
    const P = pRef.current;
    const d = P.doc;
    if (!g) return;
    if (g.kind === "trim") {
      const it = g.item;
      let want = Math.round(((e.clientX - g.x0) / P.pps) * fps);
      const s = snap([g.edge === "end" ? endOf(it) + want : it.start + want], [it.id]);
      if (s) want += s.adj;
      const [lo, hi] = trimLimits(it, g.edge);
      const dF = Math.max(lo, Math.min(hi, want));
      g.dF = dF;
      g.snapAt = s && dF === want ? s.at : undefined;
      setTrimSnap(g.snapAt);
      P.preview(dF === 0 ? [{ op: "set", item: it.id }] : trimOps(it, g.edge, dF));
      return;
    }
    const dx = e.clientX - g.x0,
      dy = e.clientY - g.y0;
    if (!g.moved && Math.hypot(dx, dy) < 4) return;
    g.moved = true;
    const anchor = d.sequence.items[g.anchor];
    if (!anchor) return;
    let target = anchor.trackId;
    if (g.ids.length === 1) {
      const row = rowAt(e.clientY);
      const ta = anchor.asset ? P.assets[anchor.asset] : undefined;
      if (row && row.track.id !== anchor.trackId && !row.track.locked && row.track.kind === trackOf(d, anchor.trackId)?.kind && accepts(row.track, anchor, ta)) target = row.track.id;
    }
    g.target = target;
    if (P.magnet && target === main && g.ids.length === 1) {
      const lx = laneX(e.clientX);
      const others = itemsOnTrack(d, main!).filter((i) => i.id !== anchor.id);
      let idx = others.length;
      for (let i = 0; i < others.length; i++)
        if (lx < x(others[i].start + others[i].duration / 2)) {
          idx = i;
          break;
        }
      g.insertIndex = idx;
      g.snapAt = undefined;
      setMoveView({ ...g });
      return;
    }
    g.insertIndex = undefined;
    let dF = Math.round((dx / P.pps) * fps);
    const s = snap([anchor.start + dF, endOf(anchor) + dF], g.ids);
    if (s) dF += s.adj;
    g.snapAt = s?.at;
    const minStart = Math.min(...g.ids.map((id) => d.sequence.items[id]?.start ?? 0));
    if (minStart + dF < 0) dF = -minStart;
    g.dF = dF;
    g.valid = g.ids.every((id) => {
      const i = d.sequence.items[id];
      return i && isFree(d, id === g.anchor ? target : i.trackId, i.start + dF, i.duration, g.ids);
    });
    setMoveView({ ...g });
  };

  const onWinUp = () => {
    window.removeEventListener("pointermove", onWinMove);
    const g = drag.current;
    drag.current = null;
    setMoveView(null);
    setTrimSnap(undefined);
    const P = pRef.current;
    const d = P.doc;
    if (!g) return;
    if (g.kind === "trim") {
      if (g.dF === 0) return P.endPreview();
      P.edit(trimOps(g.item, g.edge, g.dF), "trim");
      return;
    }
    if (!g.moved) return;
    const anchor = d.sequence.items[g.anchor];
    if (!anchor) return;
    const ops: any[] = [];
    if (g.insertIndex !== undefined) {
      if (anchor.trackId === main) {
        const list = itemsOnTrack(d, main!);
        if (list.findIndex((i) => i.id === anchor.id) === g.insertIndex) return;
        ops.push({ op: "reorder", item: anchor.id, toIndex: g.insertIndex });
      } else {
        const list = itemsOnTrack(d, main!);
        const endF = list.length ? endOf(list[list.length - 1]) : 0;
        ops.push({ op: "move", item: anchor.id, track: main, to: { f: endF } }, { op: "reorder", item: anchor.id, toIndex: g.insertIndex });
      }
      P.edit(ops, "reorder");
      return;
    }
    if (g.dF === 0 && g.target === anchor.trackId) return;
    // same-track moves go right-to-left when moving right (and the reverse) so they never collide midway
    const sorted = g.ids.map((id) => d.sequence.items[id]).filter(Boolean).sort((a, b) => (g.dF > 0 ? b.start - a.start : a.start - b.start));
    for (const it of sorted) {
      const track = it.id === g.anchor ? g.target : it.trackId;
      if (isFree(d, track, it.start + g.dF, it.duration, g.ids)) ops.push({ op: "move", item: it.id, to: { f: it.start + g.dF }, ...(track !== it.trackId ? { track } : {}) });
      else {
        const t = trackOf(d, track)!;
        const tr = ensureTrack(d, t.kind, it.start + g.dF, it.duration, { role: t.role, ignore: g.ids, skipMain: true });
        ops.push(...tr.ops.map((o) => (o.as ? { ...o, as: `${o.as}_${it.id}` } : o)), { op: "move", item: it.id, to: { f: it.start + g.dF }, track: tr.ops.length ? `$newtrack_${it.id}` : tr.ref });
      }
    }
    if (P.magnet && anchor.trackId === main && g.target !== main) ops.push({ op: "delete_range", from: { f: anchor.start }, to: { f: endOf(anchor) }, tracks: [main], ripple: true });
    P.edit(ops, "move");
  };

  const handlers = useRef({ onItemDown, onItemMenu: p.onItemMenu });
  handlers.current = { onItemDown, onItemMenu: p.onItemMenu };
  const stableDown = useCallback((e: React.PointerEvent, it: Item, zone: "body" | "start" | "end") => handlers.current.onItemDown(e, it, zone), []);
  const stableMenu = useCallback((e: React.MouseEvent, id: string) => handlers.current.onItemMenu(e, id), []);

  // ruler / empty lane: seek and scrub
  const startScrub = (e: React.PointerEvent, deselect: boolean) => {
    if (e.button !== 0) return;
    if (deselect) {
      p.setSelection([]);
      p.setSelectedTransition(undefined);
    }
    const seek = (cx: number) => pRef.current.onSeek(frameAt(cx) / fps);
    seek(e.clientX);
    const mv = (ev: PointerEvent) => seek(ev.clientX);
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", () => window.removeEventListener("pointermove", mv), { once: true });
  };

  // ---------- drops from the media library ----------
  const onDragOver = (e: React.DragEvent) => {
    const a = dragAsset.current;
    if (!a || !e.dataTransfer.types.includes("application/x-studio-asset")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const row = rowAt(e.clientY);
    const len = a.kind === "image" ? Math.round(3 * fps) : Math.max(1, Math.round(assetDuration(a) * fps));
    let frame = frameAt(e.clientX);
    const s = snap([frame, frame + len], []);
    if (s) frame += s.adj;
    const picture = a.kind === "video" || a.kind === "image";
    let trackId: string | null = row ? row.track.id : null;
    let insertIndex: number | undefined;
    if (row && (row.track.kind !== (picture ? "video" : "audio") || row.track.locked)) trackId = null;
    if (trackId === main && picture && p.magnet) {
      const list = itemsOnTrack(doc, main!);
      const lx = laneX(e.clientX);
      insertIndex = list.length;
      for (let i = 0; i < list.length; i++)
        if (lx < x(list[i].start + list[i].duration / 2)) {
          insertIndex = i;
          break;
        }
    }
    setGhost({ trackId, frame, len, insertIndex, name: a.name });
  };
  const onDrop = (e: React.DragEvent) => {
    const id = e.dataTransfer.getData("application/x-studio-asset");
    const g = ghost;
    setGhost(null);
    if (!id || !g) return;
    e.preventDefault();
    p.onDropAsset(id, g.trackId, g.frame, g.insertIndex);
  };

  // ---------- render ----------
  const step = useMemo(() => {
    const opts = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    return opts.find((s) => s * pps >= 84) || 600;
  }, [pps]);
  const ticks = useMemo(() => {
    const out: { t: number; major: boolean }[] = [];
    const minor = step / (step >= 10 ? 5 : step === 2 ? 4 : 5);
    const from = Math.max(0, Math.floor((view.left - 200) / pps / minor) * minor);
    const to = (view.left + view.width + 400) / pps;
    for (let t = from; t <= to; t += minor) out.push({ t: +t.toFixed(4), major: Math.abs(t / step - Math.round(t / step)) < 1e-6 });
    return out;
  }, [step, pps, view]);
  const label = (t: number) => (step < 1 ? `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}` : `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}`);

  const trans = Object.values(doc.sequence.transitions || {});
  const selSet = new Set(p.selection);
  const flashSet = new Set(p.flash || []);
  const markers = Object.values(doc.sequence.markers || {}) as any[];
  const viewL = view.left - 300,
    viewR = view.left + view.width + 600;

  return (
    <div className="tl" onDragLeave={(e) => e.currentTarget === e.target && setGhost(null)}>
      <div className="tl-scroll" ref={scrollRef} onScroll={updateView} onDragOver={onDragOver} onDrop={onDrop}>
        <div className="tl-content" style={{ width: HEAD + contentW, height: RULER + totalH + 64 }}>
          <div className="tl-ruler" style={{ width: HEAD + contentW }}>
            <div className="tl-corner">
              <span className="muted small">{doc.sequence.tracks.length} tracks</span>
            </div>
            <div className="tl-ticks" onPointerDown={(e) => startScrub(e, false)}>
              {ticks.map((tk) => (
                <span key={tk.t} className={tk.major ? "major" : "minor"} style={{ left: tk.t * pps }}>
                  {tk.major ? label(tk.t) : ""}
                </span>
              ))}
              {markers.map((m) => (
                <div
                  key={m.id}
                  className="tl-marker"
                  style={{ left: x(m.at), background: m.color || undefined }}
                  title={`${m.label || "Marker"} — click to jump, right-click to remove`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    p.onSeek(m.at / fps);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    p.edit([{ op: "remove_marker", id: m.id }], "remove marker");
                  }}
                />
              ))}
            </div>
          </div>
          {rows.map(({ track: t, top, height }) => {
            const isMainRow = t.id === main;
            const items = Object.values(doc.sequence.items).filter((i) => i.trackId === t.id);
            const list = [...items].sort((a, b) => a.start - b.start);
            return (
              <div key={t.id} className={`tl-row k-${t.kind} ${isMainRow ? "main" : ""} ${t.locked ? "locked" : ""} ${t.enabled === false ? "hidden" : ""}`} style={{ top: RULER + top, height, width: HEAD + contentW }}>
                <div className="tl-head" style={{ height }}>
                  <div className="tl-head-name" onDoubleClick={() => setRenaming(t.id)} title={`${t.id} — double-click to rename`}>
                    {t.kind === "video" ? isMainRow ? <Film size={13} /> : <ImageIcon size={13} /> : t.kind === "text" ? <Type size={13} /> : t.kind === "caption" ? <Captions size={13} /> : t.role === "music" ? <Music size={13} /> : t.role === "sfx" ? <AudioLines size={13} /> : <Mic size={13} />}
                    {renaming === t.id ? (
                      <input
                        autoFocus
                        defaultValue={t.name}
                        onBlur={(e) => {
                          setRenaming(null);
                          if (e.target.value.trim() && e.target.value !== t.name) p.edit([{ op: "set_track", track: t.id, name: e.target.value.trim() }], "rename track");
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                          if (e.key === "Escape") setRenaming(null);
                        }}
                      />
                    ) : (
                      <span>{t.name}</span>
                    )}
                    {isMainRow && p.magnet && <Magnet size={11} className="magnet" />}
                  </div>
                  <div className="tl-head-btns">
                    {t.kind !== "audio" && (
                      <button className="icon xs" title={t.enabled === false ? "Show track" : "Hide track"} onClick={() => p.edit([{ op: "set_track", track: t.id, enabled: t.enabled === false }], "track visibility")}>
                        {t.enabled === false ? <EyeOff size={13} /> : <Eye size={13} />}
                      </button>
                    )}
                    {(t.kind === "audio" || t.kind === "video") && (
                      <button className="icon xs" title={t.muted ? "Unmute track" : "Mute track"} onClick={() => p.edit([{ op: "set_track", track: t.id, muted: !t.muted }], "track mute")}>
                        {t.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                      </button>
                    )}
                    <button className="icon xs" title={t.locked ? "Unlock track" : "Lock track"} onClick={() => p.edit([{ op: "set_track", track: t.id, locked: !t.locked }], "track lock")}>
                      {t.locked ? <Lock size={13} /> : <Unlock size={13} />}
                    </button>
                  </div>
                </div>
                <div className="tl-lane" onPointerDown={(e) => startScrub(e, true)}>
                  {list.map((it) => {
                    const left = x(it.start),
                      w = Math.max(3, x(it.duration));
                    if (left > viewR || left + w < viewL) return null;
                    const moving = moveView?.moved && moveView.ids.includes(it.id);
                    return (
                      <ItemView
                        key={it.id}
                        it={it}
                        left={left}
                        width={w}
                        height={height - 6}
                        asset={it.asset ? p.assets[it.asset] : undefined}
                        selected={selSet.has(it.id)}
                        flash={flashSet.has(it.id)}
                        dim={!!moving}
                        pps={pps}
                        fps={fps}
                        viewL={viewL}
                        viewR={viewR}
                        cues={it.kind === "captions" ? p.cueList : undefined}
                        keys={selSet.has(it.id) ? keyTimes(it) : undefined}
                        onDown={stableDown}
                        onMenu={stableMenu}
                      />
                    );
                  })}
                  {(t.kind === "video" || t.kind === "audio") &&
                    list.slice(1).map((b, i) => {
                      const a = list[i];
                      if (endOf(a) !== b.start || a.kind === "captions") return null;
                      const tr = trans.find((z) => z.from === a.id && z.to === b.id);
                      const cx = x(b.start);
                      if (cx < viewL || cx > viewR) return null;
                      if (tr)
                        return (
                          <button
                            key={tr.id}
                            className={`cut-trn ${p.selectedTransition === tr.id ? "sel" : ""}`}
                            style={{ left: cx - x(tr.duration) / 2, width: Math.max(14, x(tr.duration)) }}
                            title={`${tr.preset.replace("_", " ")} · ${(tr.duration / fps).toFixed(2)} s`}
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              p.setSelection([]);
                              p.setSelectedTransition(tr.id);
                            }}
                          />
                        );
                      if (t.kind !== "video") return null;
                      return (
                        <button
                          key={`add-${a.id}`}
                          className="cut-add"
                          style={{ left: cx - 9 }}
                          title="Add a transition here"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            p.onAddTransition(a.id, b.id);
                          }}
                        >
                          <Plus size={11} />
                        </button>
                      );
                    })}
                  {moveView?.moved && moveView.insertIndex !== undefined && isMainRow && (() => {
                    const others = list.filter((i) => i.id !== moveView.anchor);
                    const at = moveView.insertIndex < others.length ? others[moveView.insertIndex].start : others.length ? endOf(others[others.length - 1]) : 0;
                    // positions shown as they will be once the dragged clip leaves its slot
                    const anchor = doc.sequence.items[moveView.anchor];
                    const shift = anchor && anchor.trackId === main && anchor.start < at ? anchor.duration : 0;
                    return <div className="insert-line" style={{ left: x(at - shift) - 1 }} />;
                  })()}
                  {moveView?.moved &&
                    moveView.insertIndex === undefined &&
                    moveView.ids.map((id) => {
                      const it = doc.sequence.items[id];
                      if (!it) return null;
                      const tId = id === moveView.anchor ? moveView.target : it.trackId;
                      if (tId !== t.id) return null;
                      return <div key={`g-${id}`} className={`tl-ghost ${moveView.valid ? "" : "bad"}`} style={{ left: x(it.start + moveView.dF), width: Math.max(3, x(it.duration)), height: height - 6 }} />;
                    })}
                  {ghost && ghost.trackId === t.id && (
                    <>
                      {ghost.insertIndex !== undefined ? (
                        <div className="insert-line" style={{ left: x(ghost.insertIndex < list.length ? list[ghost.insertIndex].start : list.length ? endOf(list[list.length - 1]) : 0) - 1 }} />
                      ) : (
                        <div className={`tl-ghost drop ${isFree(doc, t.id, ghost.frame, ghost.len) ? "" : "newtrack"}`} style={{ left: x(ghost.frame), width: Math.max(3, x(ghost.len)), height: height - 6 }}>
                          <span>{ghost.name}</span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
          <div className={`tl-newtrack ${ghost && ghost.trackId === null ? "on" : ""}`} style={{ top: RULER + totalH, width: HEAD + contentW }}>
            <div className="tl-head">
              <AddTrackMenu edit={p.edit} />
            </div>
            <div className="tl-lane">{ghost && ghost.trackId === null ? <div className="tl-ghost drop" style={{ left: x(ghost.frame), width: Math.max(3, x(ghost.len)), height: 34 }}><span>New track · {ghost.name}</span></div> : <span className="muted small hint">Drop media here for a new track</span>}</div>
          </div>
          {(moveView?.snapAt !== undefined || trimSnap !== undefined) && <div className="snap-line" style={{ left: HEAD + x((moveView?.snapAt ?? trimSnap)!), height: RULER + totalH }} />}
          <div className="tl-playhead-wrap" style={{ left: HEAD, height: RULER + totalH + 40 }}>
            <div className="tl-playhead" ref={playheadRef}>
              <span className="knob" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AddTrackMenu({ edit }: { edit: TimelineProps["edit"] }) {
  const [open, setOpen] = useState(false);
  const add = (op: any) => {
    edit([{ op: "add_track", ...op }], "add track");
    setOpen(false);
  };
  return (
    <div className="addtrack">
      <button className="btn small" onClick={() => setOpen(!open)}>
        <Plus size={12} /> Track
      </button>
      {open && (
        <div className="menu" onMouseLeave={() => setOpen(false)}>
          <button onClick={() => add({ kind: "video", name: "Overlay" })}>Video overlay</button>
          <button onClick={() => add({ kind: "text", name: "Titles" })}>Text</button>
          <button onClick={() => add({ kind: "audio", role: "dialogue", name: "Voice" })}>Voice</button>
          <button onClick={() => add({ kind: "audio", role: "music", name: "Music" })}>Music</button>
          <button onClick={() => add({ kind: "audio", role: "sfx", name: "SFX" })}>Sound effects</button>
        </div>
      )}
    </div>
  );
}

type ItemProps = {
  it: Item;
  left: number;
  width: number;
  height: number;
  asset?: FullAsset;
  selected: boolean;
  flash?: boolean;
  dim: boolean;
  pps: number;
  fps: number;
  viewL: number;
  viewR: number;
  cues?: { s: number; e: number; text: string }[];
  keys?: number[];
  onDown: (e: React.PointerEvent, it: Item, zone: "body" | "start" | "end") => void;
  onMenu: (e: React.MouseEvent, id: string) => void;
};

const ItemView = memo(function ItemView({ it, left, width, height, asset: a, selected, flash, dim, pps, fps, viewL, viewR, cues, keys, onDown, onMenu }: ItemProps) {
  const strip = useStripSize(it.kind === "clip" && a?.kind === "video" ? a.filmstrip : null);
  const speed = it.speed || 1;
  const inS = (it.source?.inMs || 0) / 1000;
  const audioOn = it.kind === "clip" && hasAudio(a) && it.audio?.enabled !== false && !it.audio?.mute;
  const isPicture = it.kind === "clip" && a?.kind === "video";
  const waveH = isPicture && audioOn ? Math.min(16, Math.round(height * 0.28)) : 0;
  const thumbH = height - waveH;
  const name = it.name || a?.name || (it.kind === "title" ? it.text : it.kind === "captions" ? "Captions" : it.kind === "color" ? "Colour" : it.kind);
  const wave = a?.waveform && (audioOn || a.kind === "audio") ? { backgroundImage: `url(${a.waveform})`, backgroundSize: `${(assetDuration(a) / speed) * pps}px 100%`, backgroundPositionX: `${-(inS / speed) * pps}px` } : undefined;

  let thumbs: React.ReactNode = null;
  if (isPicture && a) {
    if (strip && a.filmstripStep) {
      const D = assetDuration(a);
      const n = Math.max(1, Math.ceil(D / a.filmstripStep));
      const tileW = (strip.w / n) * (thumbH / strip.h);
      const sizeW = strip.w * (thumbH / strip.h);
      const first = Math.max(0, Math.floor((viewL - left) / tileW));
      const last = Math.min(Math.ceil(width / tileW), Math.ceil((viewR - left) / tileW));
      const cells = [];
      for (let j = first; j < last; j++) {
        const srcT = inS + (((j + 0.5) * tileW) / pps) * speed;
        const tile = Math.max(0, Math.min(n - 1, Math.round(srcT / a.filmstripStep)));
        cells.push(<span key={j} style={{ left: j * tileW, width: tileW, height: thumbH, backgroundImage: `url(${a.filmstrip})`, backgroundSize: `${sizeW}px ${thumbH}px`, backgroundPositionX: -tile * tileW }} />);
      }
      thumbs = <div className="thumbs">{cells}</div>;
    } else if (a.poster) thumbs = <div className="thumbs poster" style={{ backgroundImage: `url(${a.poster})`, height: thumbH }} />;
  } else if (it.kind === "image" && a?.poster) {
    thumbs = <div className="thumbs tile" style={{ backgroundImage: `url(${a.poster})`, height: thumbH, backgroundSize: `auto ${thumbH}px` }} />;
  }

  return (
    <div
      className={`tl-item k-${it.kind} ${a?.kind === "audio" || (it.kind === "clip" && !isPicture) ? "is-audio" : ""} ${selected ? "sel" : ""} ${flash ? "flash" : ""} ${dim ? "dim" : ""} ${it.audio?.enabled === false ? "audio-off" : ""}`}
      style={{ left, width, height, ...(it.kind === "color" ? { background: it.color || "#333" } : {}) }}
      onPointerDown={(e) => onDown(e, it, "body")}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e, it.id);
      }}
      title={`${name} · ${it.id}`}
    >
      {thumbs}
      {waveH > 0 && wave && <div className="wave strip" style={{ ...wave, height: waveH }} />}
      {!isPicture && wave && <div className="wave full" style={wave} />}
      {cues && (
        <div className="cues">
          {cues
            .filter((c) => c.e * pps >= viewL && c.s * pps <= viewR)
            .map((c, i) => (
              <span key={i} style={{ left: c.s * pps - left, width: Math.max(2, (c.e - c.s) * pps) }}>
                {c.text}
              </span>
            ))}
        </div>
      )}
      <div className="tl-label">
        {it.kind === "title" && <Type size={11} />}
        <span>{name}</span>
        {speed !== 1 && <span className="tl-badge">{speed}×</span>}
        {(it.filter || it.afilter) && (
          <span className="tl-badge fx" title={[it.filter && `picture: ${it.filter}`, it.afilter && `sound: ${it.afilter}`].filter(Boolean).join("\n")}>
            fx
          </span>
        )}
        {it.audio?.enabled === false && it.kind === "clip" && isPicture && <span className="tl-badge">audio detached</span>}
      </div>
      {keys?.map((k) => (k >= 0 && k <= it.duration ? <span key={k} className="kf-dot" style={{ left: (k / fps) * pps - 4 }} /> : null))}
      {it.kind !== "captions" && (
        <>
          <span className="trim start" onPointerDown={(e) => onDown(e, it, "start")} />
          <span className="trim end" onPointerDown={(e) => onDown(e, it, "end")} />
        </>
      )}
    </div>
  );
});
