// Board items (characters, places, music, the look) as objects anywhere in the chat: a pill that
// opens the item's card over the editor, and — when a question is about one item — its details
// under the question, editable in place, so the edit itself is the answer.
import { createContext, useContext, useState, type ReactNode } from "react";
import { MapPin, Music, Palette, Pencil, User, Package, Maximize2, Check, Loader2, Clapperboard } from "lucide-react";
import { openBoard } from "./view";
import { sheetOf, CAST_FIELDS, PLACE_FIELDS, MUSIC_FIELDS, type BoardApi, type BoardFocus, type CastCard, type PlaceCard, type MusicCard } from "./Board";

export type ItemsCtx = { api: BoardApi; open: (f: BoardFocus) => void } | null;
export const BoardItems = createContext<ItemsCtx>(null);

type Found = { focus: Exclude<BoardFocus, null>; name: string; card: CastCard | PlaceCard | MusicCard | null; thumb: string | null };
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

// The board item a name refers to ("Hélène", "HÉLÈNE", "Pryce's Café"), or null.
export function findItem(ctx: ItemsCtx, name?: string | null): Found | null {
  const b = ctx?.api.data?.board;
  if (!b || !name) return null;
  const n = norm(name);
  const media = ctx!.api.data!.media;
  const thumb = (c: { refs?: any[] }) => {
    const s = sheetOf(c);
    return (s && media[s]?.poster) || null;
  };
  for (const c of b.cast) if (c.name && norm(c.name) === n) return { focus: { kind: "cast", id: c.id }, name: c.name, card: c, thumb: thumb(c) };
  for (const p of b.places) if (p.name && norm(p.name) === n) return { focus: { kind: "place", id: p.id }, name: p.name, card: p, thumb: thumb(p) };
  for (const m of b.music || []) if (m.name && norm(m.name) === n) return { focus: { kind: "music", id: m.id }, name: m.name, card: m, thumb: null };
  const clip = n.match(/^(?:clip|storyboard)\s+(\w+)$/)?.[1];
  for (const sb of b.storyboards) {
    if ((clip && String(sb.id).toLowerCase() === clip) || (sb.title && norm(sb.title) === n)) {
      const t = sb.pick || sb.takes?.[sb.takes.length - 1];
      return { focus: { kind: "storyboard", id: sb.id }, name: `Clip ${sb.id}${sb.title ? ` · ${sb.title}` : ""}`, card: null, thumb: (t && media[t]?.poster) || (sb.sheet && media[sb.sheet]?.poster) || null };
    }
  }
  if (n === "look" || n === "the look") return { focus: { kind: "look", id: "look" }, name: "Look", card: null, thumb: null };
  return null;
}

const iconOf = (f: Found) => (f.focus.kind === "storyboard" ? <Clapperboard size={11} /> : f.focus.kind === "place" ? <MapPin size={11} /> : f.focus.kind === "music" ? <Music size={11} /> : f.focus.kind === "look" ? <Palette size={11} /> : (f.card as CastCard)?.kind === "product" || (f.card as CastCard)?.kind === "prop" ? <Package size={11} /> : <User size={11} />);

// One item as a pill: its picture (or kind) and name; click opens its card.
export function ItemPill({ name, label }: { name: string; label?: ReactNode }) {
  const ctx = useContext(BoardItems);
  const f = findItem(ctx, name);
  if (!f) return <>{label ?? name}</>;
  const go = () => (f.focus.kind === "storyboard" ? openBoard(f.focus.id) : ctx!.open(f.focus));
  return (
    <span
      role="button"
      tabIndex={0}
      className="item-pill"
      title={f.focus.kind === "storyboard" ? `Show ${f.name} on the board` : `Open ${f.name}'s card`}
      onClick={(e) => (e.stopPropagation(), go())}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), e.stopPropagation(), go())}
    >
      <span className="item-pill-pic">{f.thumb ? <img src={f.thumb} alt="" /> : iconOf(f)}</span>
      {label ?? (f.focus.kind === "storyboard" ? name : f.name)}
    </span>
  );
}

// Text with the board's item names turned into pills ("cast: Hélène, Solange").
export function WithItems({ text }: { text: string }) {
  const ctx = useContext(BoardItems);
  const b = ctx?.api.data?.board;
  if (!b) return <>{text}</>;
  const names = [...b.cast, ...b.places, ...(b.music || []), ...b.storyboards.map((x) => ({ name: x.title }))].map((x) => x.name).filter((x): x is string => !!x && x.length > 1);
  const clipRef = b.storyboards.length ? "(?:[Cc]lip|[Ss]toryboard)s? \\d+" : "";
  if (!names.length && !clipRef) return <>{text}</>;
  const esc = names.sort((a, z) => z.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = text.split(new RegExp(`(${[clipRef, ...esc].filter(Boolean).join("|")})`, "g"));
  const isClip = (p: string) => !!clipRef && new RegExp(`^${clipRef}$`).test(p);
  return <>{parts.map((p, i) => (names.includes(p) || isClip(p) ? <ItemPill key={i} name={p.replace(/^(clip|storyboard)s /i, "$1 ")} label={p} /> : p))}</>;
}

const SPECS = { cast: CAST_FIELDS, place: PLACE_FIELDS, music: MUSIC_FIELDS } as const;

// A question about one item: its details under the question. "Edit details" turns them into
// fields; "Answer with these changes" saves the card and sends what changed as the answer.
export function ItemBrief({ name, onAnswer }: { name: string; onAnswer: (text: string) => void }) {
  const ctx = useContext(BoardItems);
  const f = findItem(ctx, name);
  const [edit, setEdit] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  if (!f || !f.card || f.focus.kind === "look" || f.focus.kind === "storyboard" || f.focus.kind === "brief") return null;
  const kind = f.focus.kind as keyof typeof SPECS;
  const spec = SPECS[kind] as unknown as [string, string, boolean, string[]?][];
  const card = f.card as Record<string, any>;
  const shown = spec.filter(([k]) => card[k]);
  const changed = edit ? spec.filter(([k]) => (edit[k] ?? "").trim() !== String(card[k] ?? "").trim()) : [];
  const submit = async () => {
    if (!edit || !changed.length) return;
    setBusy(true);
    try {
      const patch: Record<string, any> = { id: card.id };
      for (const [k] of changed) patch[k] = edit[k].trim() || null;
      await ctx!.api.patch({ [kind === "cast" ? "cast" : kind === "place" ? "places" : "music"]: [patch] });
      onAnswer(`I edited ${f.name}'s card — ${changed.map(([k, label]) => `${label}: ${edit[k].trim() || "(cleared)"}`).join("; ")}`);
      setEdit(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`item-brief ${edit ? "editing" : ""}`}>
      <div className="item-brief-head">
        <span className="item-brief-pic">{f.thumb ? <img src={f.thumb} alt="" /> : iconOf(f)}</span>
        <strong>{f.name}</strong>
        <span className="micro">{edit ? "Editing" : "On the card"}</span>
        <span className="grow" />
        <button className="btn ghost small" onClick={() => ctx!.open(f.focus)} title="Open the full card over the editor">
          <Maximize2 size={12} /> Card
        </button>
      </div>
      {edit ? (
        <div className="item-brief-fields edit">
          {spec.map(([k, label, long, choices]) => (
            <label key={k} className={(edit[k] ?? "").trim() !== String(card[k] ?? "").trim() ? "changed" : ""}>
              <span>{label}</span>
              {choices ? (
                <select value={edit[k] ?? ""} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })}>
                  <option value="">—</option>
                  {choices.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              ) : long ? (
                <textarea rows={2} value={edit[k] ?? ""} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
              ) : (
                <input value={edit[k] ?? ""} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
              )}
            </label>
          ))}
        </div>
      ) : (
        <dl className="item-brief-fields">
          {shown.map(([k, label]) => (
            <div key={k}>
              <dt>{label}</dt>
              <dd>{String(card[k])}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="item-brief-foot">
        {edit ? (
          <>
            <button className="btn primary small" disabled={!changed.length || busy} onClick={submit}>
              {busy ? <Loader2 size={12} className="spin" /> : <Check size={12} />} {changed.length ? `Answer with ${changed.length === 1 ? "this change" : `these ${changed.length} changes`}` : "Change something to answer"}
            </button>
            <button className="btn ghost small" onClick={() => setEdit(null)}>
              Cancel
            </button>
          </>
        ) : (
          <button className="btn small" onClick={() => setEdit(Object.fromEntries(spec.map(([k]) => [k, String(card[k] ?? "")])))}>
            <Pencil size={12} /> Edit details
          </button>
        )}
      </div>
    </div>
  );
}
