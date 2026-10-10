import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Pencil, Check, Loader2, AlertTriangle, MapPin, Target, X, Sparkles, Plus, Trash2, RotateCcw, User, Package, Music, Palette, Play, LayoutGrid } from "lucide-react";
import { api } from "../api";
import { isOpen, draftName, type DraftsApi, type ModelSpec, type PickAsset } from "./Drafts";
import { PlayButton, VoicePicker, voicePreview } from "./Play";
import { openBoard } from "./view";
import { credits } from "../credits";

// The project board beside the chat: what we're going for, the bibles (cast and places, each with
// its design sheet), the music, and the storyboards — one storyboard is one video generation. The agent writes
// it (board_update); the person can open anything, edit its details and panels, make or remake its
// sheet or video as a draft, and pick takes.

export type Ref = { asset_id: string; use?: string };
export type CastCard = {
  id: string; kind?: string; name?: string; role?: string; age?: string; personality?: string; theme?: string; look?: string; outfit?: string; contrast?: string; label?: string; notes?: string;
  voice?: { voice?: string; sample?: string; line?: string; notes?: string }; refs?: Ref[]; sheets?: string[]; status?: string;
};
export type PlaceCard = { id: string; name?: string; look?: string; time?: string; weather?: string; mood?: string; light?: string; sound?: string; refs?: Ref[]; sheets?: string[]; status?: string };
export type MusicCard = { id: string; name?: string; style?: string; mood?: string; tempo?: string; vocals?: string; where?: string; reference?: string; seconds?: number; notes?: string; sample?: string; samples?: string[]; status?: string };
export type Panel = { t?: string; shot?: string; title?: string; action?: string; line?: string; sound?: string; note?: string };
export type Storyboard = {
  id: string; scene?: string; title?: string; beat?: string; mood?: string; ended?: string; last_frame?: string; last_from?: string; seconds?: number; kind?: "sequence" | "shot"; start?: string; style?: string; panels?: Panel[]; cast?: string[]; place?: string; sound?: string; model?: string; est_usd?: number;
  sheet?: string; sheets?: string[]; status?: string; takes?: string[]; chosen?: string; note?: string; pick?: string; placed?: boolean;
};
export type Brief = { intent?: string; goal?: string; format?: string; aspect?: string; seconds?: number; mode?: string; where?: string; versions?: string; ending?: string; about?: string; tone?: string; audience?: string; dialogue?: string; locked?: boolean };
export type LookOption = { id: string; name?: string; style?: string; frame?: string };
export type Look = { style?: string; refs?: Ref[]; moment?: string; chosen?: string; options?: LookOption[] };
// Something made from inputs that have since changed (a sheet drawn before the outfit changed…).
export type Stale = { kind: string; id: string; label: string; usd: number; for: Record<string, string> };
// How the project's sheets look and its clips are made (set by the agent; see server/board.mjs)
export type Design = { pace?: string; clips?: string; storyboard?: { render?: string; sheet?: string; captions?: string; header?: string }; bibles?: { kind?: string; detail?: string; sheet?: string } };
export type Beat = { id: string; part?: string; title?: string; text?: string; status?: string };
export type Board = {
  brief: Brief;
  beats?: Beat[];
  look: Look;
  design?: Design;
  cast: CastCard[];
  places: PlaceCard[];
  music?: MusicCard[];
  scenes: { id: string; title?: string }[];
  storyboards: Storyboard[];
  plan: { title?: string; logline?: string; total_usd?: number; retake_usd?: number; minutes?: number } | null;
  preview?: { items: string[]; revision: number; at: string; seconds: number } | null;
};
export type MediaInfo = { kind: string; name: string; status: string; duration: number | null; poster: string | null; full?: string | null; url: string | null };
export type Media = Record<string, MediaInfo>;
export type BoardData = { version: number; board: Board; media: Media; stale?: Stale[]; previews?: { spent: number; cap: number; left: number } };

export function useBoard(projectId: string) {
  const [data, setData] = useState<BoardData | null>(null);
  const busy = useRef(false);
  const again = useRef(false);
  const load = useCallback(async () => {
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    try {
      setData(await api<BoardData>(`/api/projects/${projectId}/board`));
    } catch {
      /* the strip just stays as it was */
    } finally {
      busy.current = false;
      if (again.current) {
        again.current = false;
        load();
      }
    }
  }, [projectId]);
  useEffect(() => {
    load();
  }, [load]);
  const patch = useCallback(async (p: any) => setData(await api<BoardData>(`/api/projects/${projectId}/board`, { patch: p })), [projectId]);
  return { data, load, patch };
}
export type BoardApi = ReturnType<typeof useBoard>;

export const isEmptyBoard = (b?: Board | null) => !b || (!b.brief?.intent && !b.brief?.goal && !b.cast.length && !b.places.length && !b.music?.length && !b.look?.options?.length && !b.look?.style && !b.storyboards.length && !b.plan);
export const sheetOf = (c?: { refs?: Ref[] }) => c?.refs?.find((r) => r.use === "sheet")?.asset_id || null;

// What a board asset is, in words ("Ines · bible", "Storyboard 2 · sheet", "Storyboard 2 · take 1").
export function boardNames(b?: Board | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!b) return out;
  for (const c of [...b.cast, ...b.places]) {
    (c.sheets || []).forEach((a, i, all) => (out[a] = `${c.name || c.id} · bible${all.length > 1 ? ` ${i + 1}` : ""}`));
    for (const r of c.refs || []) if (!out[r.asset_id]) out[r.asset_id] = `${c.name || c.id} · ${r.use === "sheet" ? "bible" : r.use || "reference"}`;
  }
  for (const c of b.cast) if (c.voice?.sample) out[c.voice.sample] = `${c.name || c.id} · voice`;
  for (const m of b.music || []) [...new Set([...(m.samples || []), ...(m.sample ? [m.sample] : [])])].forEach((a, i, all) => (out[a] = `${m.name || "Music"} · music${all.length > 1 ? ` ${i + 1}` : ""}`));
  for (const o of b.look?.options || []) if (o.frame) out[o.frame] = `Look ${o.id}${o.name ? ` · ${o.name}` : ""}`;
  for (const s of b.storyboards) {
    (s.sheets || []).forEach((a, i, all) => (out[a] = `Storyboard ${s.id} · sheet${all.length > 1 ? ` ${i + 1}` : ""}`));
    if (s.sheet && !out[s.sheet]) out[s.sheet] = `Storyboard ${s.id} · sheet`;
    (s.takes || []).forEach((a, i) => (out[a] = `Storyboard ${s.id} · take ${i + 1}`));
  }
  return out;
}

export type BoardProps = {
  api: BoardApi;
  drafts: DraftsApi;
  models: ModelSpec[];
  assets: PickAsset[];
  nameOf: (assetId: string) => string;
  onUseTake: (s: Storyboard, assetId: string) => void;
  onPicture: (p: { label: string; url: string }) => void;
  onGenerate: (ids: string[]) => Promise<void>;
  onAsk: (text: string) => void;
  onSend: (text: string) => void;
  onWatch?: () => Promise<void>;
  watching?: boolean;
  onOpenDraft?: (draftId: string) => void; // show a waiting draft in the box under the chat
};

const money = (n: number) => credits(n);
const staleFor = (props: BoardProps, test: (x: Stale) => boolean) => (props.api.data?.stale || []).filter(test);

// When something on a card was made before its details changed: say so, with the price to remake it.
function StaleNote({ items, props }: { items: Stale[]; props: BoardProps }) {
  const [busy, setBusy] = useState(false);
  if (!items.length) return null;
  const usd = items.reduce((t, x) => t + x.usd, 0);
  return (
    <div className="bd-stale-note">
      <AlertTriangle size={12} />
      <span>
        {items.map((x) => x.label).join(", ")} {items.length > 1 ? "were" : "was"} made before {items.length > 1 ? "their" : "its"} details changed.
      </span>
      <button
        className="link small"
        disabled={busy}
        title="Make new versions from the board as it is now — they open as drafts you can change before they run"
        onClick={async () => {
          setBusy(true);
          try {
            const ids: string[] = [];
            for (const x of items) ids.push(await props.drafts.create({ for: x.for }));
            await props.onGenerate(ids);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Loader2 size={11} className="spin" /> : <RotateCcw size={11} />} Remake · about {money(usd)}
      </button>
    </div>
  );
}

// What waits for one thing on the board — a line that opens it in the box under the chat, where it's
// generated — what's being made, and a button to prepare a new one.
function ItemDrafts({ match, props, make, makeLabel }: { match: (f: any) => boolean; props: BoardProps; make?: any; makeLabel?: string }) {
  const D = props.drafts;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const running = (d: (typeof D.drafts)[number]) => d.jobs.some((j) => j.status === "queued" || j.status === "running" || j.status === "waiting");
  const mine = D.drafts.filter((d) => d.for && match(d.for) && (isOpen(d) || running(d)));
  return (
    <>
      {mine.map((d) =>
        isOpen(d) ? (
          <button key={d.id} className="bd-draft" onClick={() => props.onOpenDraft?.(d.id)} title="Show it in the box under the chat">
            <Sparkles size={12} />
            <span className="ellipsis">{draftName(d)}</span>
            <span className="muted">{money(d.cost_usd)} · waiting in the box</span>
          </button>
        ) : (
          <div key={d.id} className="bd-draft running">
            <Loader2 size={12} className="spin" />
            <span className="ellipsis">{draftName(d)}</span>
            <span className="muted">generating…</span>
          </div>
        ),
      )}
      {make && !mine.some(isOpen) && (
        <button
          className="btn small bd-make"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr("");
            try {
              // the new draft opens in the box, where it's generated
              props.onOpenDraft?.(await D.create(make));
            } catch (e: any) {
              setErr(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 size={12} className="spin" /> : <Sparkles size={12} />} {makeLabel}
        </button>
      )}
      {err && <div className="gd-err">{err}</div>}
    </>
  );
}

export const CAST_FIELDS: FieldSpec<CastCard>[] = [["role", "Role", false], ["age", "Age", false], ["personality", "Personality", false], ["theme", "Core theme", false], ["look", "Design", true], ["outfit", "Outfit", true], ["contrast", "Tell apart", false], ["label", "Label text", false], ["notes", "Notes", true]];
export const MUSIC_FIELDS: FieldSpec<MusicCard>[] = [["style", "Style", true], ["mood", "Mood", true], ["tempo", "Tempo", false], ["vocals", "Vocals", false, ["instrumental", "vocals"]], ["where", "Where it plays", true], ["seconds", "Length (s)", false], ["reference", "Reference", false], ["notes", "Notes", true]];
export const PLACE_FIELDS: FieldSpec<PlaceCard>[] = [["time", "Time of day", false], ["weather", "Weather", false], ["mood", "Mood", false], ["look", "Design", true], ["light", "Light", false], ["sound", "Sound", false]];

export type FieldSpec<T> = [keyof T, string, boolean, string[]?];
function Fields<T extends Record<string, any>>({ item, fields, onSave, hint = "Then remake the sheet to use them." }: { item: T; fields: FieldSpec<T>[]; onSave: (patch: Partial<T>) => Promise<void>; hint?: string }) {
  const [edit, setEdit] = useState<Partial<T> | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = fields.filter(([k]) => item[k]);
  if (edit)
    return (
      <div className="bd-fields edit">
        {fields.map(([k, label, long, choices]) => (
          <label key={String(k)}>
            <span>{label}</span>
            {choices ? (
              <select value={String(edit[k] ?? "")} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })}>
                <option value="">—</option>
                {choices.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            ) : long ? (
              <textarea rows={2} value={String(edit[k] ?? "")} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
            ) : (
              <input value={String(edit[k] ?? "")} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
            )}
          </label>
        ))}
        <div className="bd-row">
          <button
            className="btn small primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const patch: any = {};
                for (const [k] of fields) if ((edit[k] ?? "") !== (item[k] ?? "")) patch[k] = String(edit[k] ?? "").trim() || null;
                if (Object.keys(patch).length) await onSave(patch);
                setEdit(null);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Check size={12} /> Save details
          </button>
          <button className="btn small" onClick={() => setEdit(null)}>
            Cancel
          </button>
          <span className="muted small">{hint}</span>
        </div>
      </div>
    );
  return (
    <div className="bd-fields">
      {shown.map(([k, label]) => (
        <div key={String(k)} className="bd-field">
          <span>{label}</span>
          <p>{String(item[k])}</p>
        </div>
      ))}
      <button className="link small" onClick={() => setEdit(Object.fromEntries(fields.map(([k]) => [k, item[k] ?? ""])) as Partial<T>)}>
        <Pencil size={11} /> Edit details
      </button>
    </div>
  );
}

function SheetView({ assetId, media, label, onPicture, drafts, onOpenDraft }: { assetId: string | null; media: Media; label: string; onPicture: BoardProps["onPicture"]; drafts?: DraftsApi; onOpenDraft?: (id: string) => void }) {
  const m = assetId ? media[assetId] : undefined;
  const [busy, setBusy] = useState(false);
  if (!m?.poster) return null;
  return (
    <div className="bd-sheet-wrap">
      <button className="bd-sheet" onClick={() => onPicture({ label, url: (m.full || m.poster)! })} title="Open full size">
        <img src={m.poster} alt={label} />
      </button>
      {drafts && assetId && (
        <button
          className="link small"
          disabled={busy}
          title="A new draft with exactly this sheet's prompt and references — change anything, then make it again"
          onClick={async () => {
            setBusy(true);
            try {
              onOpenDraft?.(await drafts.create({ from_asset: assetId }));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 size={11} className="spin" /> : <RotateCcw size={11} />} Redo this sheet with changes
        </button>
      )}
    </div>
  );
}

function SheetHistory({ ids, current, media, onUse }: { ids: string[]; current: string | null; media: Media; onUse: (id: string) => void }) {
  if (ids.length < 2) return null;
  return (
    <div className="bd-history">
      {ids.map((a) =>
        media[a]?.poster ? (
          <button key={a} className={a === current ? "on" : ""} onClick={() => a !== current && onUse(a)} title={a === current ? "In use" : "Use this one"}>
            <img src={media[a].poster!} alt="" />
            {a === current && <Check size={10} className="bd-pick" />}
          </button>
        ) : null,
      )}
    </div>
  );
}

// A character's voice: which library voice, the line its sample says, how it's delivered — hear the
// sample, change any of it, and make a new sample (a draft) to hear the change.
function VoiceSection({ c, media, props, save }: { c: CastCard; media: Media; props: BoardProps; save: (patch: any) => Promise<void> }) {
  const spec = props.models.find((m) => m.id === "voice")?.params?.voice;
  const voices = (spec?.enum || []) as string[];
  const about = (v?: string) => (v && spec?.descriptions?.[v]) || "";
  const [edit, setEdit] = useState<{ voice: string; line: string; notes: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const sample = c.voice?.sample ? media[c.voice.sample] : undefined;
  // a sample made moments ago is still processing: look again shortly
  useEffect(() => {
    if (!c.voice?.sample || sample?.url) return;
    const t = setTimeout(() => props.api.load(), 4000);
    return () => clearTimeout(t);
  }, [c.voice?.sample, sample?.url]);
  if (edit)
    return (
      <div className="bd-voice edit">
        <span className="bd-label">Voice</span>
        <div className="bd-voice-pick">
          <span>Voice <em>— click one to hear it and choose it</em></span>
          <VoicePicker value={edit.voice} voices={voices} about={about} onChange={(voice) => setEdit({ ...edit, voice })} />
        </div>
        <label>
          <span>What the sample says</span>
          <textarea rows={2} value={edit.line} placeholder="A line in character, 5–7 seconds long" onChange={(e) => setEdit({ ...edit, line: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
        </label>
        <label>
          <span>Delivery</span>
          <input value={edit.notes} placeholder="e.g. gravelly, slow, a little amused" onChange={(e) => setEdit({ ...edit, notes: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
        </label>
        <div className="bd-row">
          <button
            className="btn small primary"
            disabled={busy || !edit.voice}
            onClick={async () => {
              setBusy(true);
              try {
                await save({ voice: { ...(c.voice || {}), voice: edit.voice, line: edit.line.trim() || null, notes: edit.notes.trim() || null } });
                setEdit(null);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Check size={12} /> Save voice
          </button>
          <button className="btn small" onClick={() => setEdit(null)}>
            Cancel
          </button>
          <span className="muted small">Then make a new sample to hear it.</span>
        </div>
      </div>
    );
  return (
    <div className="bd-voice">
      <span className="bd-label">Voice</span>
      {c.voice?.voice ? (
        <>
          <div className="bd-voice-row">
            <strong>{c.voice.voice}</strong>
            <span className="muted small ellipsis">{about(c.voice.voice)}</span>
            {c.voice.sample ? (
              <PlayButton url={sample?.url} label="Play sample" seconds={sample?.duration} title={c.name ? `Play ${c.name}'s sample` : undefined} />
            ) : (
              <PlayButton url={voicePreview(c.voice.voice)} label={`Hear ${c.voice.voice}`} title={`${c.voice.voice} reading a test line — make a sample to hear ${c.name ? `${c.name}'s` : "their"} own line`} />
            )}
          </div>
          {c.voice.line && <p className="bd-voice-line">“{c.voice.line}”</p>}
          {c.voice.notes && <p className="muted small">Delivery: {c.voice.notes}</p>}
        </>
      ) : (
        <p className="muted small">No voice yet.</p>
      )}
      <button className="link small" onClick={() => setEdit({ voice: c.voice?.voice || "", line: c.voice?.line || "", notes: c.voice?.notes || "" })}>
        <Pencil size={11} /> {c.voice?.voice ? "Change the voice" : "Give them a voice"}
      </button>
      <ItemDrafts props={props} match={(f) => f.voice === c.id} make={c.voice?.voice ? { for: { voice: c.id } } : undefined} makeLabel={c.voice?.sample ? "New voice sample" : "Make a voice sample"} />
    </div>
  );
}

function CardDetail({ c, isPlace, props, onClose }: { c: CastCard | PlaceCard; isPlace: boolean; props: BoardProps; onClose: () => void }) {
  const media = props.api.data!.media;
  const sheet = sheetOf(c);
  const cast = c as CastCard;
  const save = (patch: any) => props.api.patch(isPlace ? { places: [{ id: c.id, ...patch }] } : { cast: [{ id: c.id, ...patch }] });
  const useSheet = (a: string) => save({ refs: [{ asset_id: a, use: "sheet" }, ...(c.refs || []).filter((r) => r.use !== "sheet")] });
  return (
    <div className="bd-detail">
      <div className="bd-pop-head">
        {isPlace ? <MapPin size={13} className="muted" /> : cast.kind === "product" || cast.kind === "prop" ? <Package size={13} className="muted" /> : <User size={13} className="muted" />}
        <strong>{c.name || c.id}</strong>
        <span className={`bd-state ${sheet ? "ok" : ""}`}>{sheet ? "Bible ready" : "No bible yet"}</span>
        <button className="icon xs" onClick={onClose} title="Close">
          <X size={12} />
        </button>
      </div>
      <div className="bd-cols">
      <div className="bd-media">
      {sheet ? <SheetView assetId={sheet} media={media} label={`${c.name || c.id} · bible`} onPicture={props.onPicture} drafts={props.drafts} onOpenDraft={props.onOpenDraft} /> : <div className="bd-empty-sheet muted small">No bible sheet yet. Make one, or give the agent your own sheet or photo for {c.name || c.id}.</div>}
      <SheetHistory ids={c.sheets || []} current={sheet} media={media} onUse={useSheet} />
      </div>
      <div className="bd-side">
      <StaleNote items={staleFor(props, (x) => x.id === c.id && (isPlace ? x.for.place === c.id : !!(x.for.cast || x.for.voice)))} props={props} />
      {isPlace ? <Fields item={c as PlaceCard} fields={PLACE_FIELDS} onSave={save} /> : <Fields item={cast} fields={CAST_FIELDS} onSave={save} />}
      <ItemDrafts props={props} match={(f) => (isPlace ? f.place === c.id : f.cast === c.id)} make={isPlace ? { for: { place: c.id } } : { for: { cast: c.id } }} makeLabel={sheet ? "New bible sheet" : "Make the bible sheet"} />
      {!isPlace && cast.kind !== "product" && cast.kind !== "prop" && <VoiceSection c={cast} media={media} props={props} save={save} />}
      </div>
      </div>
    </div>
  );
}

const BRIEF_FIELDS: FieldSpec<Brief>[] = [
  ["intent", "What we're making", true],
  ["about", "What it's about", true],
  ["ending", "How it ends (or the promise / the ask)", true],
  ["where", "Where it plays", false],
  ["aspect", "Shape", false, ["9:16", "16:9", "1:1", "4:5"]],
  ["seconds", "Length (s)", false],
  ["versions", "Versions", false],
  ["tone", "Tone", false],
  ["audience", "Who it's for", false],
  ["dialogue", "Dialogue", false, ["dialogue", "voiceover", "none"]],
];

// What we're making, in a few lines everyone works from — and anything on the board that's out of date.
// The production design as flat fields (the board keeps it nested: design.storyboard, design.bibles).
type DesignFlat = { pace?: string; clips?: string; render?: string; captions?: string; sheet?: string; header?: string; bibles_kind?: string; bibles_detail?: string; bibles_sheet?: string };
const DESIGN_FIELDS: FieldSpec<DesignFlat>[] = [
  ["pace", "Pace", false, ["calm", "measured", "fast", "rapid"]],
  ["clips", "Clips from", false, ["storyboard", "shots", "mix"]],
  ["render", "Storyboards drawn as", false, ["frames", "sketch", "ink"]],
  ["captions", "Storyboard captions", false, ["full", "short", "labels"]],
  ["sheet", "Storyboard sheet look", true],
  ["header", "Storyboard header", false],
  ["bibles_kind", "Bible sheets", false, ["model", "casting"]],
  ["bibles_detail", "Bible detail", false, ["full", "light"]],
  ["bibles_sheet", "Bible sheet look", true],
];
const flatDesign = (d: any = {}): DesignFlat => ({ pace: d.pace, clips: d.clips, render: d.storyboard?.render, captions: d.storyboard?.captions, sheet: d.storyboard?.sheet, header: d.storyboard?.header, bibles_kind: d.bibles?.kind, bibles_detail: d.bibles?.detail, bibles_sheet: d.bibles?.sheet });
const nestDesign = (f: DesignFlat) => {
  const pick = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  const sb = pick({ render: f.render, captions: f.captions, sheet: f.sheet, header: f.header });
  const bi = pick({ kind: f.bibles_kind, detail: f.bibles_detail, sheet: f.bibles_sheet });
  return { ...pick({ pace: f.pace, clips: f.clips }), ...(Object.keys(sb).length ? { storyboard: sb } : {}), ...(Object.keys(bi).length ? { bibles: bi } : {}) };
};

function BriefDetail({ props, onClose }: { props: BoardProps; onClose: () => void }) {
  const brief = props.api.data!.board.brief;
  const design = props.api.data!.board.design || {};
  const stale = props.api.data!.stale || [];
  return (
    <div className="bd-detail">
      <div className="bd-pop-head">
        <Target size={13} className="muted" />
        <strong>The brief</strong>
        <span className="bd-state ok">{shapeLine(props.api.data!.board) || "Shape not set"}</span>
        <button className="icon xs" onClick={onClose} title="Close">
          <X size={12} />
        </button>
      </div>
      <div className="bd-cols">
        <div className="bd-side">
          <Fields item={brief} fields={BRIEF_FIELDS} onSave={(patch) => props.api.patch({ brief: patch })} hint="The agent works from these. A new shape changes the canvas while the timeline is empty." />
          <span className="bd-label bd-design-label">Production design</span>
          <Fields item={flatDesign(design)} fields={DESIGN_FIELDS} onSave={(patch) => props.api.patch({ design: nestDesign(patch) })} hint="How this project's storyboards and bible sheets are drawn, and how its clips are made. The agent sets them from the project; change any of them." />
        </div>
        <div className="bd-media">
          {stale.length ? (
            <>
              <span className="bd-label">Out of date</span>
              <StaleNote items={stale} props={props} />
            </>
          ) : (
            <p className="muted small">Everything on the board matches what it was made from.</p>
          )}
        </div>
      </div>
    </div>
  );
}

// The shape of the piece in one line: "9:16 · 60 s · TikTok and Reels · + a 15 s teaser".
function shapeLine(board: Board) {
  const b = board.brief;
  const secs = b.seconds || board.storyboards.reduce((t, s) => t + (s.seconds || 0), 0);
  return [b.aspect, secs ? `${Math.round(secs)} s` : "", b.where || "", b.versions ? `+ ${b.versions}` : ""].filter(Boolean).join(" · ");
}

// Choosing the look by eye: the same moment, with the same people, in two or three looks.
function LookDetail({ props, onClose }: { props: BoardProps; onClose: () => void }) {
  const { board, media } = props.api.data!;
  const look = board.look || {};
  const options = look.options || [];
  const [busy, setBusy] = useState<string>("");
  const make = async (ids: string[]) => {
    setBusy(ids.join(","));
    try {
      const qids: string[] = [];
      for (const id of ids) qids.push(await props.drafts.create({ for: { look: id } }));
      await props.onGenerate(qids);
    } finally {
      setBusy("");
    }
  };
  const choose = (id: string) => props.api.patch({ look: { chosen: id } });
  const missing = options.filter((o) => !o.frame).map((o) => o.id);
  // frames are drawn in the piece's own shape: show them that way, whole
  const [aw, ah] = (board.brief.aspect || "16:9").split(":").map(Number);
  const tall = aw < ah;
  return (
    <div className="bd-detail">
      <div className="bd-pop-head">
        <Palette size={13} className="muted" />
        <strong>The look</strong>
        <span className={`bd-state ${look.chosen ? "ok" : ""}`}>{look.chosen ? `Look ${look.chosen} in use` : options.length ? "Pick one" : look.style ? "Set" : "Not set yet"}</span>
        <button className="icon xs" onClick={onClose} title="Close">
          <X size={12} />
        </button>
      </div>
      {look.moment && <p className="muted small lk-moment">Each frame shows the same moment: {look.moment}</p>}
      {options.length > 0 && (
        <div className={`lk-grid ${tall ? "tall" : ""}`}>
          {options.map((o) => {
            const m = o.frame ? media[o.frame] : undefined;
            return (
              <div key={o.id} className={`lk-opt ${o.id === look.chosen ? "on" : ""}`}>
                {m?.full || m?.poster ? (
                  <button className="lk-frame" style={{ aspectRatio: `${aw} / ${ah}` }} onClick={() => props.onPicture({ label: `Look ${o.id}${o.name ? ` · ${o.name}` : ""}`, url: (m.full || m.poster)! })} title="Open full size">
                    <img src={(m.full || m.poster)!} alt="" />
                  </button>
                ) : (
                  <div className="lk-frame empty muted small" style={{ aspectRatio: `${aw} / ${ah}` }}>{busy.includes(o.id) || props.drafts.drafts.some((d) => d.for?.look === o.id && d.jobs.some((j) => j.status === "running" || j.status === "queued")) ? <Loader2 size={14} className="spin" /> : "No frame yet"}</div>
                )}
                <strong>
                  {o.id}
                  {o.name ? ` · ${o.name}` : ""}
                </strong>
                <p className="muted small">{o.style}</p>
                <div className="bd-row">
                  {o.id === look.chosen ? (
                    <span className="bd-state ok">
                      <Check size={11} /> In use
                    </span>
                  ) : (
                    <button className="btn small primary" onClick={() => choose(o.id)}>
                      Use this look
                    </button>
                  )}
                  {!o.frame && (
                    <button className="btn small" disabled={!!busy} onClick={() => make([o.id])}>
                      <Sparkles size={11} /> Make its frame
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {missing.length > 1 && (
        <button className="btn small lk-all" disabled={!!busy} onClick={() => make(missing)}>
          {busy ? <Loader2 size={12} className="spin" /> : <Sparkles size={12} />} Make the {missing.length} frames · about {money(0.025 * missing.length)}
        </button>
      )}
      <Fields item={look as any} fields={[["style", "The look in use", true], ["moment", "The moment the frames show", true]]} onSave={(patch) => props.api.patch({ look: patch })} hint="New frames, sheets and storyboards use it." />
      {!options.length && <p className="muted small">Ask the agent for two or three looks to choose between — it makes a quick frame of each.</p>}
    </div>
  );
}

// A piece of music: hear the latest sample (and earlier ones), change what it should sound like, and
// make a new sample (a draft) to hear the change.
function MusicDetail({ m, props, onClose }: { m: MusicCard; props: BoardProps; onClose: () => void }) {
  const media = props.api.data!.media;
  const save = (patch: any) => props.api.patch({ music: [{ id: m.id, ...patch }] });
  const samples = [...new Set([...(m.samples || []), ...(m.sample ? [m.sample] : [])])];
  const cur = m.sample ? media[m.sample] : undefined;
  const [busy, setBusy] = useState(false);
  // a sample made moments ago is still processing: look again shortly
  useEffect(() => {
    if (!m.sample || cur?.url) return;
    const t = setTimeout(() => props.api.load(), 4000);
    return () => clearTimeout(t);
  }, [m.sample, cur?.url]);
  return (
    <div className="bd-detail">
      <div className="bd-pop-head">
        <Music size={13} className="muted" />
        <strong>{m.name || "Music"}</strong>
        <span className={`bd-state ${m.sample ? "ok" : ""}`}>{m.sample ? "Sample ready" : "No sample yet"}</span>
        <button className="icon xs" onClick={onClose} title="Close">
          <X size={12} />
        </button>
      </div>
      <div className="bd-cols">
        <div className="bd-media">
          {m.sample ? (
            <div className="bd-music">
              <PlayButton url={cur?.url} label="Play" seconds={cur?.duration} className="btn play-big" title={`Play ${m.name || "the music"}`} />
              <p className="muted small">{[m.style, m.tempo, m.vocals].filter(Boolean).join(" · ")}</p>
              <button
                className="link small"
                disabled={busy}
                title="A new draft with exactly this sample's prompt — change anything, then make it again"
                onClick={async () => {
                  setBusy(true);
                  try {
                    props.onOpenDraft?.(await props.drafts.create({ from_asset: m.sample }));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? <Loader2 size={11} className="spin" /> : <RotateCcw size={11} />} Redo this with changes
              </button>
            </div>
          ) : (
            <div className="bd-empty-sheet muted small">No sample yet. Make one to hear this direction — it's a draft you can change before it runs.</div>
          )}
          {samples.length > 1 && (
            <div className="bd-music-history">
              {samples.map((a, i) => (
                <div key={a} className={`bd-music-take ${a === m.sample ? "on" : ""}`}>
                  <PlayButton url={media[a]?.url} label={`Sample ${i + 1}`} seconds={media[a]?.duration} />
                  {a === m.sample ? (
                    <span className="muted small">
                      <Check size={11} /> In use
                    </span>
                  ) : (
                    <button className="link small" onClick={() => save({ sample: a })}>
                      Use this one
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="bd-side">
          <StaleNote items={staleFor(props, (x) => x.kind === "music" && x.id === m.id)} props={props} />
          <Fields item={m} fields={MUSIC_FIELDS} onSave={save} hint="Then make a new sample to hear it." />
          <ItemDrafts props={props} match={(f) => f.music === m.id} make={{ for: { music: m.id } }} makeLabel={m.sample ? "New sample" : "Make a sample"} />
        </div>
      </div>
    </div>
  );
}

function PanelsEditor({ sb, onSave, onCancel }: { sb: Storyboard; onSave: (panels: Panel[], seconds?: number) => Promise<void>; onCancel: () => void }) {
  const [panels, setPanels] = useState<Panel[]>(() => (sb.panels || []).map((p) => ({ ...p })));
  const [seconds, setSeconds] = useState<number | "">(sb.seconds || 15);
  const [busy, setBusy] = useState(false);
  const set = (i: number, k: keyof Panel, v: string) => setPanels(panels.map((p, j) => (j === i ? { ...p, [k]: v } : p)));
  return (
    <div className="bd-panels edit">
      <label className="bd-secs">
        <span>Length</span>
        <input type="number" min={1} max={15} value={seconds} onChange={(e) => setSeconds(e.target.value === "" ? "" : Number(e.target.value))} onKeyDown={(e) => e.stopPropagation()} /> s
      </label>
      {panels.map((p, i) => (
        <div key={i} className="bd-panel-edit">
          <div className="bd-row">
            <span className="bd-panel-n">{i + 1}</span>
            <input className="t" placeholder="0-2.5" value={p.t || ""} onChange={(e) => set(i, "t", e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            <input className="shot" placeholder="Shot and camera" value={p.shot || ""} onChange={(e) => set(i, "shot", e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            <input className="title" placeholder="Title" value={p.title || ""} onChange={(e) => set(i, "title", e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            <button className="icon xs" title="Remove this panel" onClick={() => setPanels(panels.filter((_, j) => j !== i))}>
              <Trash2 size={12} />
            </button>
          </div>
          <textarea rows={2} placeholder="What happens" value={p.action || ""} onChange={(e) => set(i, "action", e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <input placeholder="NAME: the line  ·  an exchange: A: … / B: …  ·  voice-over: NAME (V.O.): …" value={p.line || ""} onChange={(e) => set(i, "line", e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <input className="note" placeholder="A note lettered on the panel (optional) — a beat count, an arrow" value={p.note || ""} onChange={(e) => set(i, "note", e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </div>
      ))}
      <div className="bd-row">
        <button className="btn small" onClick={() => setPanels([...panels, {}])} disabled={panels.length >= 16}>
          <Plus size={12} /> Panel
        </button>
        <span className="grow" />
        <button className="btn small" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="btn small primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onSave(panels.filter((p) => p.action || p.shot || p.line), seconds === "" ? undefined : seconds);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Check size={12} /> Save panels
        </button>
      </div>
    </div>
  );
}

// Where a storyboard's take ended: what the next storyboard picks up from (the agent writes it after
// watching the take; the person can correct it).
function Ended({ s, onSave }: { s: Storyboard; onSave: (text: string) => Promise<void> }) {
  const [edit, setEdit] = useState<string | null>(null);
  if (edit !== null)
    return (
      <div className="bd-ended edit">
        <span>Where it ended</span>
        <textarea rows={3} value={edit} onChange={(e) => setEdit(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder="Who is where, what they hold and wear, what they know, the last line, the open question" />
        <div className="bd-row">
          <button className="btn small primary" onClick={async () => (await onSave(edit.trim()), setEdit(null))}>
            <Check size={12} /> Save
          </button>
          <button className="btn small" onClick={() => setEdit(null)}>
            Cancel
          </button>
        </div>
      </div>
    );
  return (
    <div className="bd-ended">
      <span>Where it ended</span>
      {s.ended ? <p>{s.ended}</p> : <p className="muted">Not written yet — the agent writes it after watching the take.</p>}
      <button className="link small" onClick={() => setEdit(s.ended || "")}>
        <Pencil size={11} /> Edit
      </button>
    </div>
  );
}

function StoryboardDetail({ s, props, onClose }: { s: Storyboard; props: BoardProps; onClose: () => void }) {
  const { board, media } = props.api.data!;
  const takes = (s.takes || []).filter((t) => media[t]);
  const [sel, setSel] = useState<string | undefined>(s.pick || takes[takes.length - 1]);
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => setSel(s.pick || takes[takes.length - 1]), [s.id, takes.length, s.pick]);
  const cur = sel ? media[sel] : undefined;
  const idx = board.storyboards.findIndex((x) => x.id === s.id);
  const prev = idx > 0 ? board.storyboards[idx - 1] : null;
  const outline = !(s.panels || []).length;
  const prevHasTake = !!prev && (prev.takes || []).length > 0;
  const names = (s.cast || []).map((id) => board.cast.find((c) => c.id === id)?.name || id);
  const place = s.place ? board.places.find((p) => p.id === s.place)?.name || s.place : null;
  const save = (patch: any) => props.api.patch({ storyboards: [{ id: s.id, ...patch }] });
  const shot = (s.kind || (board.design?.clips === "shots" ? "shot" : "sequence")) === "shot";
  const redo = async (asset: string) => {
    setErr("");
    try {
      props.onOpenDraft?.(await props.drafts.create({ from_asset: asset }));
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <div className="bd-detail sb">
      <div className="bd-pop-head">
        <strong>
          Storyboard {s.id}
          {s.title ? ` · ${s.title}` : ""}
        </strong>
        <span className="muted small">
          {s.seconds ? `${s.seconds} s` : ""} · {shot ? "one shot" : `${(s.panels || []).length} panels`}
          {s.start === "extend" ? " · continues the last take" : ""}
        </span>
        <span className="seg small bd-kind" title="A storyboard is drawn as a sheet first and then made as one video; a shot is one short, precise take from the character and place sheets alone">
          <button className={!shot ? "on" : ""} onClick={() => shot && save({ kind: "sequence" })}>
            Storyboard
          </button>
          <button className={shot ? "on" : ""} onClick={() => !shot && save({ kind: "shot" })}>
            Shot
          </button>
        </span>
        <button className="icon xs" onClick={onClose} title="Close">
          <X size={12} />
        </button>
      </div>
      {(names.length > 0 || place || s.mood) && (
        <p className="muted small bd-who">
          {names.join(", ")}
          {place ? ` · ${place}` : ""}
          {s.mood ? <span className="bd-mood"> · {s.mood}</span> : null}
        </p>
      )}
      <div className="bd-cols">
      <div className="bd-media">
      {cur?.url ? <video key={sel} className="bd-pop-video" src={cur.url} poster={cur.poster || undefined} controls playsInline /> : null}
      {takes.length > 0 && (
        <div className="bd-history takes">
          {takes.map((t, i) => (
            <button key={t} className={t === sel ? "on" : ""} onClick={() => setSel(t)} title={`Take ${i + 1}${t === s.pick ? " (on the timeline)" : ""}`}>
              {media[t].poster ? <img src={media[t].poster!} alt="" /> : <span>{i + 1}</span>}
              {t === s.pick && <Check size={10} className="bd-pick" />}
            </button>
          ))}
        </div>
      )}
      {sel && (
        <div className="bd-row">
          {sel !== s.pick && (
            <button className="btn small primary" onClick={() => props.onUseTake(s, sel)}>
              {s.placed ? "Use this take" : "Add to the timeline"}
            </button>
          )}
          <button className="btn small" onClick={() => redo(sel)} title="A new draft with this take's exact prompt and references, to change and make again">
            <RotateCcw size={12} /> Redo with changes
          </button>
        </div>
      )}
      {shot ? (
        <div className="bd-empty-sheet muted small">A shot: made straight from the character and place sheets — no storyboard sheet.</div>
      ) : s.sheet ? (
        <SheetView assetId={s.sheet} media={media} label={`Storyboard ${s.id} · sheet`} onPicture={props.onPicture} drafts={props.drafts} onOpenDraft={props.onOpenDraft} />
      ) : (
        <div className="bd-empty-sheet muted small">No storyboard sheet yet: the video follows the sheet's panels, so make it first.</div>
      )}
      {!shot && <SheetHistory ids={s.sheets || []} current={s.sheet || null} media={media} onUse={(a) => save({ sheet: a })} />}
      </div>
      <div className="bd-side">
      <StaleNote items={staleFor(props, (x) => (x.kind === "board" || x.kind === "take") && x.id === s.id)} props={props} />
      {outline && !editing ? (
        <div className="bd-outline">
          <span className="bd-label">Outline</span>
          <p>{s.beat || "No beat written yet."}</p>
          <button className="btn small primary" onClick={() => props.onSend(prev ? (prevHasTake ? `Write storyboard ${s.id}'s panels, picking up from how storyboard ${prev.id}'s take ended.` : `Write storyboard ${s.id}'s panels, following on from storyboard ${prev.id}.`) : `Write storyboard ${s.id}'s panels.`)}>
            <Sparkles size={12} /> Ask the agent to write it
          </button>
          <button className="link small" onClick={() => setEditing(true)}>
            <Pencil size={11} /> Write the panels yourself
          </button>
        </div>
      ) : editing ? (
        <PanelsEditor
          sb={s}
          onCancel={() => setEditing(false)}
          onSave={async (panels, seconds) => {
            await save({ panels, ...(seconds ? { seconds } : {}) });
            setEditing(false);
          }}
        />
      ) : (
        <div className="bd-panels">
          {(s.panels || []).map((p, i) => (
            <div key={i} className="bd-panel">
              <span className="bd-panel-n">{i + 1}</span>
              <div>
                <div className="bd-panel-top">
                  {p.t && <span className="bd-panel-t">{p.t}s</span>}
                  {p.shot && <span className="bd-panel-shot">{p.shot}</span>}
                  {p.title && <span className="bd-panel-title">{p.title}</span>}
                </div>
                {p.action && <p>{p.action}</p>}
                {p.note && <p className="bd-panel-note">{p.note}</p>}
                {p.line &&
                  p.line.split(/\s+\/\s+|\n+/).map((l, j) => (
                    <p key={j} className="bd-line">
                      {l}
                    </p>
                  ))}
              </div>
            </div>
          ))}
          <button className="link small" onClick={() => setEditing(true)}>
            <Pencil size={11} /> Edit panels
          </button>
        </div>
      )}
      {takes.length > 0 && <Ended s={s} onSave={(text) => save({ ended: text || null })} />}
      {s.note && <p className="bd-pop-text warn">{s.note}</p>}
      {err && <div className="gd-err">{err}</div>}
      {!outline && !shot && <ItemDrafts props={props} match={(f) => String(f.storyboard) === s.id && f.make === "sheet"} make={{ for: { storyboard: s.id, make: "sheet" } }} makeLabel={s.sheet ? "New storyboard sheet" : "Make the storyboard sheet"} />}
      {!outline && <ItemDrafts props={props} match={(f) => String(f.storyboard) === s.id && f.make !== "sheet"} make={{ for: { storyboard: s.id } }} makeLabel={takes.length ? "New take" : `Make the video${s.seconds ? ` (${Math.min(15, s.seconds)} s)` : ""}`} />}
      </div>
      </div>
    </div>
  );
}

export type BoardFocus = { kind: "cast" | "place" | "music" | "storyboard" | "brief" | "look"; id: string } | null;
// Whether a draft shows on the open board item (its card, with its own Generate).
export const onBoardItem = (focus: BoardFocus, f: any) =>
  !!focus && !!f && (focus.kind === "storyboard" ? String(f.storyboard) === focus.id : focus.kind === "place" ? f.place === focus.id : focus.kind === "music" ? f.music === focus.id : focus.kind === "look" ? !!f.look : focus.kind === "brief" ? false : f.cast === focus.id || f.voice === focus.id);

// One thing on the board, opened: inline in the panel, or over the preview where there's room.
export function BoardDetail({ focus, props, onClose }: { focus: BoardFocus; props: BoardProps; onClose: () => void }) {
  const board = props.api.data?.board;
  if (!focus || !board) return null;
  if (focus.kind === "storyboard") {
    const s = board.storyboards.find((x) => x.id === focus.id);
    return s ? <StoryboardDetail key={s.id} s={s} props={props} onClose={onClose} /> : null;
  }
  if (focus.kind === "music") {
    const m = (board.music || []).find((x) => x.id === focus.id);
    return m ? <MusicDetail key={m.id} m={m} props={props} onClose={onClose} /> : null;
  }
  if (focus.kind === "brief") return <BriefDetail props={props} onClose={onClose} />;
  if (focus.kind === "look") return <LookDetail props={props} onClose={onClose} />;
  const c = focus.kind === "cast" ? board.cast.find((x) => x.id === focus.id) : board.places.find((x) => x.id === focus.id);
  return c ? <CardDetail key={c.id} c={c} isPlace={focus.kind === "place"} props={props} onClose={onClose} /> : null;
}

const statusOf = (s: Storyboard) => (s.placed ? "placed" : s.status || "planned");

export function BoardStrip(props: BoardProps & { focus: BoardFocus; onFocus: (f: BoardFocus) => void; inline: boolean }) {
  const { api: B, drafts: D } = props;
  // collapsed by default: one line, so the conversation keeps its room; the Board view holds the detail
  const [open, setOpen] = useState(false);
  const pop = props.focus;
  const setPop = props.onFocus;
  const [editing, setEditing] = useState<string | null>(null);
  const data = B.data;
  if (!data || isEmptyBoard(data.board)) return null;
  const { board, media } = data;
  const intent = board.brief.intent || board.brief.goal || "";
  const done = board.storyboards.filter((s) => s.placed || s.status === "ready").length;
  const busyFor = (match: (f: any) => boolean) => D.drafts.some((d) => d.for && match(d.for) && d.status === "used" && d.jobs.some((j) => j.status === "queued" || j.status === "running"));
  const waitingFor = (match: (f: any) => boolean) => D.drafts.some((d) => d.for && match(d.for) && isOpen(d));
  const stale = data.stale || [];
  const isStale = (test: (x: Stale) => boolean) => stale.some(test);
  const staleDot = <span className="bd-stale-dot" title="Made before its details changed — open it to remake" />;
  const shape = shapeLine(board);
  const look = board.look || {};
  const lookFrame = (look.options || []).find((o) => o.id === look.chosen)?.frame || look.refs?.find((r) => r.use === "style")?.asset_id || (look.options || []).find((o) => o.frame)?.frame;
  const showLook = !!(look.options?.length || look.style);
  const chip = (c: CastCard | PlaceCard, kind: "cast" | "place") => {
    const sheet = sheetOf(c);
    const m = (f: any) => (kind === "place" ? f.place === c.id : f.cast === c.id || f.voice === c.id);
    return (
      <button key={c.id} className={`bd-chip ${sheet ? "ready" : ""} ${pop?.id === c.id ? "on" : ""}`} onClick={() => setPop(pop?.id === c.id ? null : { kind, id: c.id })} title={c.look || c.name}>
        <span className="bd-chip-img">
          {sheet && media[sheet]?.poster ? <img src={media[sheet].poster!} alt="" /> : kind === "place" ? <MapPin size={12} /> : <User size={12} />}
          {busyFor(m) ? <Loader2 size={10} className="spin bd-chip-busy" /> : waitingFor(m) ? <span className="bd-chip-dot" title="A draft is waiting for you" /> : isStale((x) => x.id === c.id && x.kind !== "board" && x.kind !== "take") ? staleDot : null}
        </span>
        <span className="ellipsis">{c.name || c.id}</span>
      </button>
    );
  };
  const music = board.music || [];
  const placed = board.storyboards.filter((s) => s.placed || s.pick).length;
  // the ingredients as small avatars for the collapsed line: picture where there is one, else the kind
  const thumbOf = (c: CastCard | PlaceCard) => {
    const sh = sheetOf(c);
    return (sh && media[sh]?.poster) || null;
  };
  const avatars: { key: string; name: string; focus: Exclude<BoardFocus, null>; img: string | null; icon: React.ReactNode }[] = [
    ...(showLook ? [{ key: "look", name: look.style ? `Look · ${look.style}` : "Look", focus: { kind: "look" as const, id: "look" }, img: (lookFrame && media[lookFrame]?.poster) || null, icon: <Palette size={11} /> }] : []),
    ...board.cast.map((c) => ({ key: c.id, name: c.name || c.id, focus: { kind: "cast" as const, id: c.id }, img: thumbOf(c), icon: <User size={11} /> })),
    ...board.places.map((p) => ({ key: p.id, name: p.name || p.id, focus: { kind: "place" as const, id: p.id }, img: thumbOf(p), icon: <MapPin size={11} /> })),
    ...music.map((m) => ({ key: m.id, name: m.name || "Music", focus: { kind: "music" as const, id: m.id }, img: null, icon: <Music size={11} /> })),
  ];
  const musicChip = (m: MusicCard) => {
    const match = (f: any) => f.music === m.id;
    const on = pop?.kind === "music" && pop.id === m.id;
    return (
      <button key={m.id} className={`bd-chip music ${m.sample ? "ready" : ""} ${on ? "on" : ""}`} onClick={() => setPop(on ? null : { kind: "music", id: m.id })} title={[m.style, m.mood].filter(Boolean).join(" · ") || m.name}>
        <span className="bd-chip-img">
          <Music size={12} />
          {busyFor(match) ? <Loader2 size={10} className="spin bd-chip-busy" /> : waitingFor(match) ? <span className="bd-chip-dot" title="A draft is waiting for you" /> : isStale((x) => x.kind === "music" && x.id === m.id) ? staleDot : null}
        </span>
        <span className="ellipsis">{m.name || "Music"}</span>
      </button>
    );
  };
  return (
    <div className={`bd ${open ? "" : "closed"}`}>
      <div className="bd-row bd-intent">
        <Target size={12} className="bd-ico" />
        {editing !== null ? (
          <input
            autoFocus
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            onBlur={async () => {
              const v = editing.trim();
              setEditing(null);
              if (v !== intent) await B.patch({ brief: { intent: v } }).catch(() => {});
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setEditing(null);
              e.stopPropagation();
            }}
          />
        ) : (
          <button className="bd-intent-text" onClick={() => setEditing(intent)} title="What we're going for — click to edit">
            <span className="ellipsis">{intent || "What are we making?"}</span>
            <Pencil size={11} className="muted" />
          </button>
        )}
        {!open && (
          <span className="bd-avatars">
            {avatars.slice(0, 5).map((a) => (
              <button key={a.key} className={`bd-avatar ${pop?.id === a.focus.id && pop?.kind === a.focus.kind ? "on" : ""}`} title={a.name} onClick={() => setPop(pop?.id === a.focus.id && pop?.kind === a.focus.kind ? null : a.focus)}>
                {a.img ? <img src={a.img} alt="" /> : a.icon}
              </button>
            ))}
            {avatars.length > 5 && (
              <button className="bd-avatar more" title="Show everything on the board" onClick={() => setOpen(true)}>
                +{avatars.length - 5}
              </button>
            )}
          </span>
        )}
        {board.storyboards.length > 0 && (
          <span className="bd-count num" title={`${placed} of ${board.storyboards.length} clips in the cut · ${done} made`}>
            {placed}/{board.storyboards.length}
          </span>
        )}
        <button className="btn small bd-open-board" onClick={() => openBoard()} title="Open the board: the brief, ingredients and every clip, on the stage">
          <LayoutGrid size={12} /> Board
        </button>
        <button className="icon xs" title={open ? "Hide the details" : "Show the details here"} onClick={() => setOpen(!open)}>
          <ChevronDown size={13} className={open ? "" : "rot-90"} />
        </button>
      </div>
      {open && (
        <button className={`bd-shape ${pop?.kind === "brief" ? "on" : ""}`} onClick={() => setPop(pop?.kind === "brief" ? null : { kind: "brief", id: "brief" })} title="The brief: what it's about, how it ends, where it plays, its shape and versions — click to see or change it">
          <span className="ellipsis">{shape || "Set the shape, length and where it plays"}</span>
          {stale.length > 0 && (
            <span className="bd-shape-stale">
              {staleDot} {stale.length} out of date
            </span>
          )}
        </button>
      )}
      {open && (showLook || board.cast.length > 0 || board.places.length > 0 || music.length > 0) && (
        <div className="bd-section">
          <span className="bd-label">{music.length || showLook ? "Look, cast, places and music" : "Bibles · cast and places"}</span>
          <div className="bd-chips">
            {showLook && (
              <button className={`bd-chip look ${look.chosen || look.style ? "ready" : ""} ${pop?.kind === "look" ? "on" : ""}`} onClick={() => setPop(pop?.kind === "look" ? null : { kind: "look", id: "look" })} title={look.style || "Choose the look"}>
                <span className="bd-chip-img">
                  {lookFrame && media[lookFrame]?.poster ? <img src={media[lookFrame].poster!} alt="" /> : <Palette size={12} />}
                  {busyFor((f) => !!f.look) ? <Loader2 size={10} className="spin bd-chip-busy" /> : !look.chosen && look.options?.length ? <span className="bd-chip-dot" title="Pick a look" /> : null}
                </span>
                <span className="ellipsis">{look.chosen ? `Look ${look.chosen}` : look.options?.length ? `${look.options.length} looks` : "Look"}</span>
              </button>
            )}
            {board.cast.map((c) => chip(c, "cast"))}
            {board.places.map((p) => chip(p, "place"))}
            {music.map(musicChip)}
          </div>
        </div>
      )}
      {open && board.storyboards.length > 0 && (
        <div className="bd-section">
          <div className="bd-label-row">
            <span className="bd-label">Storyboards · one generation each</span>
            {props.onWatch && (
              <button className="btn small bd-watch" disabled={props.watching} onClick={() => props.onWatch!()} title="Lay the whole piece out on the timeline — takes where they exist, else the storyboard panels with the lines read in the characters' voices and the music under it — and play it">
                {props.watching ? <Loader2 size={11} className="spin" /> : <Play size={11} />} {props.watching ? "Laying it out…" : "Watch so far"}
              </button>
            )}
          </div>
          <div className="bd-boards">
            {board.storyboards.map((s) => {
              const t = s.pick || s.takes?.[s.takes.length - 1];
              const img = (t && media[t]?.poster) || (s.sheet && media[s.sheet]?.poster) || null;
              const st = busyFor((f) => String(f.storyboard) === s.id) ? "generating" : statusOf(s);
              return (
                <button key={s.id} className={`bd-tile ${st} ${pop?.id === s.id && pop.kind === "storyboard" ? "on" : ""}`} onClick={() => setPop(pop?.id === s.id && pop.kind === "storyboard" ? null : { kind: "storyboard", id: s.id })} title={`Storyboard ${s.id}${s.title ? ` · ${s.title}` : ""} — ${st}`}>
                  {img ? <img src={img} alt="" /> : <span className="bd-tile-empty">{(s.panels || []).length ? `${(s.panels || []).length} panels` : "outline"}</span>}
                  <span className="bd-tile-cap">
                    {s.id}
                    {s.seconds ? ` · ${s.seconds}s` : ""}
                  </span>
                  <span className="bd-dot">{st === "generating" ? <Loader2 size={9} className="spin" /> : st === "failed" ? <AlertTriangle size={9} /> : waitingFor((f) => String(f.storyboard) === s.id) ? <span className="bd-chip-dot" /> : isStale((x) => (x.kind === "board" || x.kind === "take") && x.id === s.id) ? staleDot : null}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {pop && props.inline && <BoardDetail focus={pop} props={props} onClose={() => setPop(null)} />}
    </div>
  );
}
