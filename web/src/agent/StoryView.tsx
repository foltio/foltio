// The board on the stage (Preview | Board): the whole project at a glance and editable in place.
// Ingredients (look, cast, places, music) on top; the clips below, in order, each moving through
// Outline → Storyboard → Video → In the cut. Opening anything floats its card over this view.
import { useEffect, useMemo, useRef, useState } from "react";
import { Play, Plus, Palette, User, Package, MapPin, Music, Film, Trash2, Check, Loader2, Maximize2, X, Clapperboard } from "lucide-react";
import { BoardDetail, sheetOf, type BoardApi, type BoardFocus, type BoardProps, type Storyboard } from "./Board";
import { BoardItems, ItemPill } from "./Items";
import type { DraftsApi, ModelSpec, PickAsset } from "./Drafts";
import "./story.css";
import { credits } from "../credits";

type Props = {
  board: BoardApi;
  drafts: DraftsApi;
  models: ModelSpec[];
  assets: PickAsset[];
  nameOf: (id: string) => string;
  onUseTake: (s: Storyboard, assetId: string) => void;
  onWatch?: () => Promise<void>;
  watching?: boolean;
  onSend: (text: string) => void; // say something to the agent (switches to its panel)
  aspect: string;
  selectedAssets: string[]; // assets of the timeline items selected now
  onSelectAsset: (assetId: string) => void; // select the timeline item using this asset
  focusClip?: string | null; // a clip opened from the chat or the media (highlighted, scrolled to)
  onClose?: () => void; // back to the video
};

const STEPS = ["Outline", "Storyboard", "Video", "In the cut"];
const stepOf = (s: Storyboard) => (s.placed ? 3 : s.takes?.length ? 2 : s.sheet ? 1 : 0);
const money = (n: number) => credits(n);

export function StoryView(p: Props) {
  const data = p.board.data;
  const [focus, setFocus] = useState<BoardFocus>(null);
  const [picture, setPicture] = useState<{ label: string; url: string; kind?: string } | null>(null);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !focus && !picture && !(e.target as HTMLElement)?.closest?.("input, textarea, select, [contenteditable]") && p.onClose?.();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [focus, picture, p.onClose]);
  const items = useMemo(() => ({ api: p.board, open: setFocus }), [p.board]);
  useEffect(() => {
    if (!focus && !picture) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !(e.target as HTMLElement)?.closest?.("input, textarea, select") && (picture ? setPicture(null) : setFocus(null));
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [focus, picture]);
  if (!data) return <div className="sv sv-loading muted">Loading the board…</div>;
  const b = data.board;
  const media = data.media;
  const boards = b.storyboards || [];
  const total = boards.reduce((t, s) => t + (Number(s.seconds) || 0), 0);
  const est = b.plan?.total_usd ?? boards.reduce((t, s) => t + (Number(s.est_usd) || 0), 0);
  const done = boards.filter((s) => s.placed).length;
  const title = b.plan?.title || b.brief?.intent || "Untitled";
  const boardProps: BoardProps = {
    api: p.board,
    drafts: p.drafts,
    models: p.models,
    assets: p.assets,
    nameOf: p.nameOf,
    onUseTake: p.onUseTake,
    onPicture: setPicture,
    onGenerate: async (ids) => {
      await p.drafts.generate(ids);
      p.board.load();
    },
    onAsk: p.onSend,
    onSend: p.onSend,
    onWatch: p.onWatch,
    watching: p.watching,
  };
  const thumbOf = (c: { refs?: any[] }) => {
    const s = sheetOf(c);
    return (s && media[s]?.poster) || null;
  };
  const lookPic = (() => {
    const chosen = b.look?.options?.find((o) => o.id === b.look?.chosen);
    const id = chosen?.frame || b.look?.refs?.[0]?.asset_id;
    return (id && media[id]?.poster) || null;
  })();
  const ingredients: { key: string; focus: BoardFocus; name: string; pic: string | null; icon: React.ReactNode; ready: boolean }[] = [
    ...(b.look?.style || b.look?.options?.length ? [{ key: "look", focus: { kind: "look" as const, id: "look" }, name: "Look", pic: lookPic, icon: <Palette size={15} />, ready: !!b.look?.style }] : []),
    ...b.cast.map((c) => ({ key: `c${c.id}`, focus: { kind: "cast" as const, id: c.id }, name: c.name || c.id, pic: thumbOf(c), icon: c.kind === "product" || c.kind === "prop" ? <Package size={15} /> : <User size={15} />, ready: !!sheetOf(c) })),
    ...b.places.map((x) => ({ key: `p${x.id}`, focus: { kind: "place" as const, id: x.id }, name: x.name || x.id, pic: thumbOf(x), icon: <MapPin size={15} />, ready: !!sheetOf(x) })),
    ...(b.music || []).map((m) => ({ key: `m${m.id}`, focus: { kind: "music" as const, id: m.id }, name: m.name || m.id, pic: null, icon: <Music size={15} />, ready: !!m.sample })),
  ];
  const addClip = () => p.board.patch({ storyboards: [{ title: "New clip", seconds: 15 }] });

  return (
    <BoardItems.Provider value={items}>
      <div className="sv">
        <header className="sv-head">
          <div className="sv-title">
            <strong>{title}</strong>
            <span className="sv-meta num">
              {total ? `${total} s` : "—"} · {p.aspect}
              {est > 0 && ` · about ${money(est)}`}
            </span>
          </div>
          <span className="grow" />
          {boards.length > 0 && (
            <span className="sv-progress num" title="Clips in the cut">
              <span className="sv-progress-bar">
                <i style={{ width: `${(100 * done) / boards.length}%` }} />
              </span>
              {done}/{boards.length} in the cut
            </span>
          )}
          {p.onClose && (
            <button className="btn primary sv-close" hidden={!p.onClose} onClick={p.onClose} title="Back to the video (Esc)">
              <X size={16} strokeWidth={2.25} /> Close board <kbd>Esc</kbd>
            </button>
          )}
        </header>

        {b.brief?.about && <p className="sv-logline">{b.brief.about}</p>}
        {(b.beats || []).length > 0 && (
          <section className="sv-section">
            <span className="micro">Story so far</span>
            <ol className="ag-story-beats sv-beats">
              {(b.beats || []).map((x) => (
                <li key={x.id} className={x.status === "draft" ? "draft" : ""}>
                  <span className="ag-story-part">{x.part || "Beat"}</span>
                  <span className="ag-story-body">
                    <b
                      contentEditable
                      suppressContentEditableWarning
                      onBlur={(e) => e.currentTarget.textContent !== (x.title || "") && p.board.patch({ beats: [{ id: x.id, title: e.currentTarget.textContent || null }] })}
                    >
                      {x.title}
                    </b>
                    <span
                      contentEditable
                      suppressContentEditableWarning
                      onBlur={(e) => e.currentTarget.textContent !== (x.text || "") && p.board.patch({ beats: [{ id: x.id, text: e.currentTarget.textContent || null }] })}
                    >
                      {x.text}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {ingredients.length > 0 && (
          <section className="sv-section">
            <span className="micro">Ingredients</span>
            <div className="sv-ingredients">
              {ingredients.map((x) => (
                <button key={x.key} className={`sv-ing ${x.ready ? "ready" : ""} ${focus && JSON.stringify(focus) === JSON.stringify(x.focus) ? "on" : ""}`} onClick={() => setFocus(x.focus)} title={`Open ${x.name}`}>
                  <span className="sv-ing-pic">{x.pic ? <img src={x.pic} alt="" /> : x.icon}</span>
                  <span className="sv-ing-name ellipsis">{x.name}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="sv-section sv-clips-wrap">
          <span className="micro">Clips{boards.length ? ` · ${boards.length}` : ""}</span>
          {boards.length === 0 ? (
            <div className="sv-empty">
              <Clapperboard size={22} strokeWidth={1.5} />
              <p>Your agent fills the board as you talk: the people, the places, then the film clip by clip.</p>
              <button className="btn small" onClick={addClip}>
                <Plus size={13} /> Add a clip
              </button>
            </div>
          ) : (
            <div className="sv-clips">
              {boards.map((s, i) => (
                <ClipCard
                  key={s.id}
                  n={i + 1}
                  s={s}
                  p={p}
                  media={media}
                  castName={(id) => b.cast.find((c) => c.id === id)?.name || id}
                  placeName={(id) => b.places.find((x) => x.id === id)?.name || id}
                  selected={s.id === p.focusClip || !!(s.takes || []).some((t) => p.selectedAssets.includes(t))}
                  onOpen={() => setFocus({ kind: "storyboard", id: s.id })}
                  onPicture={setPicture}
                />
              ))}
              <button className="sv-add" onClick={addClip} title="Add a clip at the end">
                <Plus size={18} />
                <span>Add a clip</span>
              </button>
            </div>
          )}
        </section>

        {focus && (
          <>
            <div className="bd-scrim" onPointerDown={() => setFocus(null)} />
            <div className="bd-stage" role="dialog" aria-modal="false">
              <BoardDetail focus={focus} props={boardProps} onClose={() => setFocus(null)} />
            </div>
          </>
        )}
        {picture && (
          <div className="ag-lightbox" onClick={() => setPicture(null)}>
            <figure onClick={(e) => e.stopPropagation()}>
              {picture.kind === "video" ? <video src={picture.url} controls autoPlay playsInline /> : <img src={picture.url} alt={picture.label} />}
              <figcaption>{picture.label}</figcaption>
            </figure>
            <button className="icon" onClick={() => setPicture(null)} title="Close">
              <X size={18} />
            </button>
          </div>
        )}
      </div>
    </BoardItems.Provider>
  );
}

function ClipCard({
  n, s, p, media, castName, placeName, selected, onOpen, onPicture,
}: {
  n: number;
  s: Storyboard;
  p: Props;
  media: NonNullable<BoardApi["data"]>["media"];
  castName: (id: string) => string;
  placeName: (id: string) => string;
  selected: boolean;
  onOpen: () => void;
  onPicture: (x: { label: string; url: string; kind?: string }) => void;
}) {
  const [title, setTitle] = useState(s.title || "");
  const [beat, setBeat] = useState(s.beat || "");
  const [secs, setSecs] = useState(String(s.seconds ?? ""));
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const ref = useRef<HTMLElement>(null);
  // the board changed underneath (the agent edited this clip): show its version
  useEffect(() => setTitle(s.title || ""), [s.title]);
  useEffect(() => setBeat(s.beat || ""), [s.beat]);
  useEffect(() => setSecs(String(s.seconds ?? "")), [s.seconds]);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [selected]);
  const save = async (patch: Record<string, unknown>) => {
    setSaving(true);
    try {
      await p.board.patch({ storyboards: [{ id: s.id, ...patch }] });
    } finally {
      setSaving(false);
    }
  };
  const takes = s.takes || [];
  const pick = s.pick || s.chosen || takes[takes.length - 1];
  const pic = (pick && media[pick]?.poster) || (s.sheet && media[s.sheet]?.poster) || null;
  const video = pick && media[pick]?.kind === "video" ? media[pick]?.url || null : null;
  const [hover, setHover] = useState(false);
  const step = stepOf(s);
  const busy = s.status === "generating";
  const cast = s.cast || [];
  return (
    <article ref={ref} className={`sv-clip ${selected ? "on" : ""} ${busy ? "busy" : ""}`} onClick={() => s.placed && pick && p.onSelectAsset(pick)}>
      <div
        className={`sv-clip-pic ${video ? "playable" : ""}`}
        onClick={(e) => (e.stopPropagation(), video ? onPicture({ label: `Clip ${n} · ${s.title || ""}`.trim(), url: video, kind: "video" }) : onOpen())}
        onMouseEnter={() => video && setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={video ? "Play this clip" : "Open the storyboard"}
      >
        {hover && video ? <video src={video} poster={pic || undefined} autoPlay muted loop playsInline /> : pic ? <img src={pic} alt="" /> : <Film size={20} strokeWidth={1.5} />}
        <span className="sv-clip-n num">{n}</span>
        {video && !hover && (
          <span className="sv-clip-play">
            <Play size={16} fill="currentColor" />
          </span>
        )}
        <button className="sv-clip-open" onClick={(e) => (e.stopPropagation(), onOpen())} title="Open the storyboard">
          <Maximize2 size={12} /> Storyboard
        </button>
      </div>
      <div className="sv-clip-body">
        <div className="sv-clip-row">
          <input className="sv-clip-title" value={title} placeholder="Untitled clip" onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() !== (s.title || "") && save({ title: title.trim() || null })} onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && (e.target as HTMLInputElement).blur())} onClick={(e) => e.stopPropagation()} />
          <label className="sv-clip-secs num" onClick={(e) => e.stopPropagation()} title="Length in seconds">
            <input value={secs} inputMode="numeric" onChange={(e) => setSecs(e.target.value.replace(/[^\d.]/g, ""))} onBlur={() => Number(secs) !== Number(s.seconds) && secs && save({ seconds: Number(secs) })} onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && (e.target as HTMLInputElement).blur())} />s
          </label>
        </div>
        <textarea className="sv-clip-beat" rows={3} value={beat} placeholder="What happens in this clip…" onChange={(e) => setBeat(e.target.value)} onBlur={() => beat.trim() !== (s.beat || "") && save({ beat: beat.trim() || null })} onKeyDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} />
        {(cast.length > 0 || s.place) && (
          <div className="sv-clip-who">
            {cast.map((c) => (
              <ItemPill key={c} name={castName(c)} />
            ))}
            {s.place && <ItemPill name={placeName(s.place)} />}
          </div>
        )}
        <div className="sv-steps" title={STEPS[step]}>
          {STEPS.map((x, i) => (
            <i key={x} className={i <= step ? "done" : ""} />
          ))}
          <span className={busy ? "busy" : ""}>{busy ? "Generating…" : STEPS[step]}</span>
          <span className="grow" />
          {saving ? <Loader2 size={11} className="spin muted" /> : s.est_usd ? <span className="num muted">{money(Number(s.est_usd))}</span> : null}
        </div>
        {takes.length > 0 && (
          <div className="sv-takes" onClick={(e) => e.stopPropagation()}>
            {takes.map((t, i) => {
              const m = media[t];
              const used = s.placed && t === pick;
              return (
                <div key={t} className={`sv-take ${used ? "used" : ""}`}>
                  <button className="sv-take-pic" onClick={() => (m?.kind === "video" && m.url ? onPicture({ label: `Clip ${n} · take ${i + 1}`, url: m.url, kind: "video" }) : m?.poster && onPicture({ label: `Clip ${n} · take ${i + 1}`, url: m.full || m.poster }))} title={`Take ${i + 1}`}>
                    {m?.poster ? <img src={m.poster} alt="" /> : <Film size={12} />}
                  </button>
                  {used ? (
                    <span className="sv-take-used">
                      <Check size={10} /> In cut
                    </span>
                  ) : (
                    <button className="sv-take-use" onClick={() => p.onUseTake(s, t)}>
                      Use
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <button
        className={`icon xs sv-clip-del ${confirm ? "confirm" : ""}`}
        title={confirm ? "Click again to remove this clip" : "Remove clip"}
        onClick={(e) => {
          e.stopPropagation();
          if (!confirm) return setConfirm(true), setTimeout(() => setConfirm(false), 2500);
          p.board.patch({ storyboards: [{ id: s.id, remove: true }] });
        }}
      >
        {confirm ? <Check size={12} /> : <Trash2 size={12} />}
      </button>
    </article>
  );
}
