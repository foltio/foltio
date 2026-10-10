import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Plus, Upload, ChevronLeft, ChevronRight, HelpCircle, Sparkles, Loader2, X, SlidersHorizontal, CornerDownRight, CornerDownLeft, Music, Check, Pencil, Maximize2, Play, Layers } from "lucide-react";
import { RefPicker, DraftEditor, draftMoney as money, draftSummary, draftName, ROLE_LABEL, isPending, type Draft, type DraftsApi, type ModelSpec, type PickAsset } from "./Drafts";
import { labelOf, renumber } from "../../../server/gen/mentions.mjs";
import { uploadFile } from "../api";
import { PlayButton, voicePreview } from "./Play";
import type { Media } from "./Board";
import { ItemPill, ItemBrief } from "./Items";
import type { Picture, Question } from "./useAgent";

// The one place the person decides, inside the input: the agent's questions, the generations waiting
// for them, and what to do next. Several can wait; one shows at a time, with a stepper. Their own
// answer is always the text box underneath, and every answer goes into the chat as their reply.
export type DockItem =
  | { key: string; kind: "question"; set: Question; q: Question["questions"][number]; step: number; steps: number }
  | { key: string; kind: "draft"; draft: Draft }
  | { key: string; kind: "choices"; id: string; options: string[] };

// Questions first (the agent is waiting on them), then generations, then what to do next.
export function dockItems(questions: Question[], drafts: Draft[], choices: { id: string; options: string[] } | null): DockItem[] {
  const out: DockItem[] = [];
  const set = questions[0];
  if (set) set.questions.forEach((q, i) => out.push({ key: `q-${set.id}-${q.id}`, kind: "question", set, q, step: i, steps: set.questions.length }));
  for (const d of drafts) out.push({ key: `d-${d.id}`, kind: "draft", draft: d });
  if (choices && !set) out.push({ key: `c-${choices.id}`, kind: "choices", id: choices.id, options: choices.options });
  return out;
}

// The options an item offers, in order (what ↑ ↓ and Enter move through).
export const optionsOf = (it?: DockItem): string[] => (!it ? [] : it.kind === "question" ? it.q.options.map((o) => o.label) : it.kind === "choices" ? it.options : []);

// What the text box means while this item shows.
export const dockPlaceholder = (it?: DockItem) =>
  !it ? "" : it.kind === "question" ? "Write your own answer…" : it.kind === "draft" ? "Ask for changes to it, or anything else…" : "Or say what you'd like instead…";

const RECOMMENDED = /\s*\((recommended|my pick|suggested)\)\s*$/i;
// An option can point at what it's about: a file the agent made ("ast_…") or a library voice
// ("voice:Charlotte"). The box shows it as a preview, and the token never shows as text.
const MEDIA_TOKEN = /\(?\b(?:ast_[a-z0-9]{6,}|voice:[A-Za-z]+)\b\)?/g;
const tokensIn = (t?: string) => [...String(t || "").matchAll(/\b(ast_[a-z0-9]{6,}|voice:[A-Za-z]+)\b/g)].map((m) => m[1]);
const stripTokens = (t?: string) =>
  String(t || "")
    .replace(/\s*\([^()]*\b(?:ast_[a-z0-9]{6,}|voice:[A-Za-z]+)\b[^()]*\)/g, "") // an aside that only lists files
    .replace(MEDIA_TOKEN, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
export const cleanLabel = (label: string) => stripTokens(label.replace(RECOMMENDED, ""));

type DraftCtx = { media: Media; models: ModelSpec[]; assets: PickAsset[]; nameOf: (id: string) => string; api: DraftsApi; onPicture: (p: Picture) => void; onAsk: (t: string) => void; onSkipped?: (d: Draft) => void; previews?: { spent: number; cap: number; left: number } };

export function Dock({
  items,
  current,
  setCurrent,
  hi,
  setHi,
  answers,
  onPick,
  onDismissChoices,
  onGenerate,
  draft,
  answerSlot,
}: {
  items: DockItem[];
  current: DockItem;
  setCurrent: (key: string) => void;
  hi: number; // the highlighted option
  setHi: (i: number) => void;
  answers: Record<string, string>; // this question set's answers so far, by question id
  onPick: (it: DockItem, label: string) => void;
  onDismissChoices: (id: string) => void;
  onGenerate: (ids: string[]) => Promise<void>;
  draft: DraftCtx;
  answerSlot?: React.ReactNode; // the text box, placed under the question while one waits
}) {
  const i = items.findIndex((x) => x.key === current.key);
  const drafts = items.filter((x): x is Extract<DockItem, { kind: "draft" }> => x.kind === "draft").map((x) => x.draft);
  // what an option's token shows: a file of the project, or a voice from the library
  const previewOf: PreviewOf = (token) => {
    if (token.startsWith("voice:")) {
      const name = token.slice(6);
      return { kind: "audio", url: voicePreview(name), name: `${name} (voice library)` };
    }
    const m = draft.media[token];
    const a = draft.assets.find((x) => x.id === token);
    const kind = (m?.kind || a?.kind) as Preview["kind"] | undefined;
    if (!kind || !["image", "video", "audio"].includes(kind)) return null;
    return { kind, poster: m?.poster || a?.poster, full: m?.full || null, url: m?.url || a?.url || null, name: draft.nameOf(token) || a?.name || token };
  };
  // a question answered with previews says what they cost, and when the day's allowance is gone
  const pvTokens = current.kind === "question" ? current.q.options.flatMap((o) => [...tokensIn(o.label), ...tokensIn(o.description)]).filter((t) => t.startsWith("ast_")) : [];
  const pv = pvTokens.length >= 2 && draft.previews ? { ...draft.previews, used: draft.previews.left < 0.06, each: "0.06" } : null;
  const head =
    current.kind === "question"
      ? { icon: <HelpCircle size={12} />, kicker: current.q.header || "Question", title: current.steps > 1 ? `Question ${current.step + 1} of ${current.steps}` : "" }
      : current.kind === "draft"
        ? { icon: <Sparkles size={12} />, kicker: "Generate", title: draftName(current.draft) + versionOf(current.draft, drafts) }
        : { icon: <CornerDownRight size={12} />, kicker: "Next", title: "" };
  return (
    <div className={`dock dock-${current.kind}`} role="group" aria-label="Waiting for you">
      {current.kind !== "question" && <div className="dock-head">
        <span className="dock-kicker">
          {head.icon} {head.kicker}
        </span>
        {head.title && <span className="dock-title ellipsis">{head.title}</span>}
        <span className="grow" />
        {items.length > 1 && (
          <span className="dock-steps" title="Everything waiting for you — one at a time">
            <button className="icon xs" disabled={i <= 0} onClick={() => setCurrent(items[i - 1].key)} title="Previous (← in an empty box)">
              <ChevronLeft size={14} />
            </button>
            <span className="dock-count">
              {i + 1} / {items.length}
            </span>
            <button className="icon xs" disabled={i >= items.length - 1} onClick={() => setCurrent(items[i + 1].key)} title="Next (→ in an empty box)">
              <ChevronRight size={14} />
            </button>
          </span>
        )}
        {current.kind === "choices" && (
          <button className="icon xs" title="Hide these" onClick={() => onDismissChoices(current.id)}>
            <X size={13} />
          </button>
        )}
      </div>}
      <div className="dock-body">
        {current.kind === "question" ? (
          <QuestionStep slot={answerSlot} it={current} picked={answers[current.q.id]} hi={hi} setHi={setHi} onPick={(label) => onPick(current, label)} previewOf={previewOf} onPicture={draft.onPicture} />
        ) : current.kind === "choices" ? (
          <Options options={current.options} hi={hi} setHi={setHi} onPick={(label) => onPick(current, label)} previewOf={previewOf} onPicture={draft.onPicture} />
        ) : (
          <DraftStep key={current.draft.id} d={current.draft} ctx={draft} onGenerate={onGenerate} others={drafts.filter((d) => d.id !== current.draft.id)} />
        )}
      </div>
      {current.kind === "question" && (
        <div className="dock-foot">
          <span className="dock-topic">
            {current.q.header ? <ItemPill name={current.q.header} /> : "Question"}
            {current.steps > 1 && <span className="num"> · {current.step + 1} of {current.steps}</span>}
          </span>
          {pv && <span className="dock-pv" title={`Quick previews made without asking, up to ${money(pv.cap)} a day for this project`}>{pv.used ? `Preview budget used · drafts now ${money(pv.each)}` : `Previews · ${money(pv.left)} left today`}</span>}
          <span className="grow" />
          {items.length > 1 && (
            <span className="dock-steps" title="Everything waiting for you — one at a time">
              <button className="icon xs" disabled={i <= 0} onClick={() => setCurrent(items[i - 1].key)} title="Previous (← in an empty box)">
                <ChevronLeft size={14} />
              </button>
              <span className="dock-count num">
                {i + 1}/{items.length}
              </span>
              <button className="icon xs" disabled={i >= items.length - 1} onClick={() => setCurrent(items[i + 1].key)} title="Next (→ in an empty box)">
                <ChevronRight size={14} />
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// A draft named like an earlier one is a new version of it: say so ("· v2"), so two look tests don't read as the same.
const versionOf = (d: Draft, all: Draft[]) => {
  const same = all.filter((x) => draftName(x) === draftName(d)); // in the order they were made
  const i = same.findIndex((x) => x.id === d.id);
  return same.length > 1 && i > 0 ? ` · v${i + 1}` : "";
};

// What an option's preview is: a picture, a clip or a sound, from the project or the voice library.
type Preview = { kind: "image" | "video" | "audio"; poster?: string | null; full?: string | null; url?: string | null; name: string };
type PreviewOf = (token: string) => Preview | null;

// Options as numbered rows, like a menu: hover or ↑ ↓ to move, click or Enter to pick. When the
// options are pictures (look frames, sheets, takes), they're cards with the picture on top; a
// picture opens large from its corner without picking it. Sounds get a play button.
function Options({ options, onPick, onSay, picked, hi, setHi, previewOf, onPicture }: { options: { label: string; description?: string }[] | string[]; onPick: (label: string) => void; onSay?: (answer: string) => void; picked?: string; hi: number; setHi: (i: number) => void; previewOf?: PreviewOf; onPicture?: (p: Picture) => void }) {
  const rows = options.map((o) => {
    const label = typeof o === "string" ? o : o.label;
    const description = typeof o === "string" ? "" : o.description || "";
    const preview = previewOf ? [...tokensIn(label), ...tokensIn(description)].map(previewOf).find(Boolean) || null : null;
    return { label, description: stripTokens(description), rec: RECOMMENDED.test(label), preview };
  });
  const cards = rows.filter((r) => r.preview && r.preview.kind !== "audio").length >= 2;
  // tall pictures (a vertical film's frames) sit in one row, with the highlighted one's words below
  const [tall, setTall] = useState(false);
  const open = (p: Preview) => onPicture?.(p.kind === "video" && p.url ? { label: p.name, url: p.url, kind: "video" } : { label: p.name, url: (p.full || p.poster)! });
  const shown = rows[Math.min(hi, rows.length - 1)];
  // long descriptions show two lines; "More" opens one without picking it
  const [full, setFull] = useState<Record<number, boolean>>({});
  // pictures are answered by eye: pick one, ask for more like one, or mix a few (only stills mix:
  // the image model takes them as references; clips and sounds don't)
  const stills = rows.filter((r) => r.preview?.kind === "image").length;
  const canMix = cards && !!onSay && stills >= 2;
  const [mixing, setMixing] = useState<number[]>([]);
  const mixOn = mixing.length > 0;
  const toggleMix = (k: number) => setMixing((m) => (m.includes(k) ? m.filter((x) => x !== k) : [...m, k]));
  const nameOfRow = (k: number) => cleanLabel(rows[k].label);
  return (
    <>
    <div className={`dock-opts ${cards ? `cards ${tall ? "tall" : "wide"} n${rows.length}` : ""}`} style={cards && tall ? { gridTemplateColumns: `repeat(${Math.min(4, rows.length)}, minmax(0, 1fr))` } : undefined} role="listbox">
      {rows.map((r, k) => {
        const on = picked === r.label;
        const pic = r.preview && r.preview.kind !== "audio" && (r.preview.poster || r.preview.full) ? r.preview : null;
        return (
          <div key={r.label} role="option" aria-selected={on || mixing.includes(k)} tabIndex={-1} className={`dock-opt ${on ? "on" : ""} ${mixing.includes(k) ? "mix" : ""} ${hi === k ? "hi" : ""} ${pic ? "with-pic" : ""}`} onMouseEnter={() => setHi(k)} onClick={() => (mixOn && r.preview?.kind === "image" ? toggleMix(k) : onPick(r.label))}>
            {cards && (
              <span className="dock-opt-pic">
                {pic ? <img src={(pic.poster || pic.full)!} alt="" onLoad={(e) => k === 0 || !tall ? setTall(e.currentTarget.naturalHeight > e.currentTarget.naturalWidth * 1.1) : undefined} /> : <span className="dock-opt-nopic" aria-hidden><Layers size={18} /></span>}
                {pic && (
                  <button className="dock-opt-zoom" title="See it large" onClick={(e) => (e.stopPropagation(), open(pic))}>
                    {pic.kind === "video" ? <Play size={12} /> : <Maximize2 size={12} />}
                  </button>
                )}
                {pic && onSay && !mixOn && (
                  <button className="dock-opt-more-like" title="Keep this direction and show me a few variations" onClick={(e) => (e.stopPropagation(), onSay(`More like ${nameOfRow(k)}`))}>
                    More like this
                  </button>
                )}
              </span>
            )}
            <span className="dock-num">{on ? <Check size={11} /> : k + 1}</span>
            {!cards && pic && (
              <button className="dock-opt-thumb" title="See it large" onClick={(e) => (e.stopPropagation(), open(pic))}>
                <img src={(pic.poster || pic.full)!} alt="" />
              </button>
            )}
            {r.preview?.kind === "audio" && r.preview.url && (
              <span onClick={(e) => e.stopPropagation()}>
                <PlayButton url={r.preview.url} label="" className="dock-opt-play" title={`Hear ${r.preview.name}`} />
              </span>
            )}
            <span className="dock-opt-main">
              <span className="dock-opt-label">
                {cleanLabel(r.label)}
                {r.rec && (
                  <span className="dock-rec" title="The agent would take this one if you don't mind">
                    Suggested
                  </span>
                )}
              </span>
              {r.description && !(cards && tall) && <small className={full[k] ? "full" : ""}>{r.description}</small>}
              {r.description.length > 110 && !(cards && tall) && (
                <button className="dock-opt-more" onClick={(e) => (e.stopPropagation(), setFull((f) => ({ ...f, [k]: !f[k] })))}>
                  {full[k] ? "Less" : "More"}
                </button>
              )}
            </span>
            {!cards && (
              <span className="dock-enter" aria-hidden>
                <CornerDownLeft size={12} />
              </span>
            )}
          </div>
        );
      })}
    </div>
    {canMix && (
      <div className="dock-mix">
        {mixOn ? (
          <>
            <span className="muted">{mixing.length < 2 ? "Pick one more to mix" : `Mixing ${mixing.map((k) => k + 1).join(" + ")}`}</span>
            <span className="grow" />
            <button className="btn ghost small" onClick={() => setMixing([])}>Cancel</button>
            <button className="btn primary small" disabled={mixing.length < 2} onClick={() => (onSay!(`Mix ${mixing.map(nameOfRow).join(" + ")}`), setMixing([]))}>
              Mix these
            </button>
          </>
        ) : (
          <button className="dock-mix-start" onClick={() => setMixing([Math.min(hi, rows.length - 1)].filter((k) => rows[k]?.preview?.kind === "image"))} title="Combine what you like from two or more of these">
            <Layers size={12} /> Mix two or more
          </button>
        )}
      </div>
    )}
    {cards && tall && shown?.description && (
      <p className="dock-opt-detail">
        <b>{cleanLabel(shown.label)}</b> — {shown.description}
      </p>
    )}
    </>
  );
}

function QuestionStep({ slot, it, picked, hi, setHi, onPick, previewOf, onPicture }: { slot?: React.ReactNode; it: Extract<DockItem, { kind: "question" }>; picked?: string; hi: number; setHi: (i: number) => void; onPick: (label: string) => void; previewOf: PreviewOf; onPicture: (p: Picture) => void }) {
  const own = picked && !it.q.options.some((o) => o.label === picked);
  // files named in the question rather than in each option ("A — ast_…, B — ast_…") go to the options in order
  const inQuestion = tokensIn(it.q.question);
  const bare = !it.q.options.some((o) => tokensIn(o.label).length || tokensIn(o.description).length);
  const options = bare && inQuestion.length && inQuestion.length <= it.q.options.length ? it.q.options.map((o, k) => (inQuestion[k] ? { ...o, description: `${o.description || ""} ${inQuestion[k]}` } : o)) : it.q.options;
  return (
    <>
      <p className="dock-q">{stripTokens(it.q.question)}</p>
      {it.q.header && <ItemBrief name={it.q.header} onAnswer={onPick} />}
      <Options options={options} picked={picked} hi={hi} setHi={setHi} onPick={onPick} onSay={onPick} previewOf={previewOf} onPicture={onPicture} />
      {slot && <div className="dock-answer">{slot}</div>}
      {own && (
        <p className="dock-own">
          <Pencil size={11} /> Your answer: <b>{picked}</b>
        </p>
      )}
    </>
  );
}

// What a generation takes in: the library voice it speaks with, then its references in order —
// pictures open large, voices play.
function RefStrip({ d, ctx, editable }: { d: Draft; ctx: Pick<DraftCtx, "media" | "nameOf" | "onPicture"> & Partial<Pick<DraftCtx, "models" | "assets" | "api">>; editable?: boolean }) {
  const isVoice = d.model === "voice";
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState("");
  const roles = ctx.models?.find((m) => m.id === d.model)?.referenceRoles;
  const canEdit = !!(editable && roles && Object.keys(roles).length && ctx.api);
  // a change to the references is saved straight away; the prompt's "image 2" mentions follow the files
  const commit = async (next: { asset_id: string; role: string }[]) => {
    setBusy("save");
    try {
      const r = renumber(d.prompt || "", { model: d.model, refs: d.references }, { model: d.model, refs: next });
      await ctx.api!.edit(d.id, { model: d.model, params: d.params, takes: d.takes || 1, references: next.map(({ asset_id, role }) => ({ asset_id, role })), prompt: r.prompt });
    } finally {
      setBusy("");
    }
  };
  const imageRole = () => (roles ? (roles.character ? "character" : Object.keys(roles).find((r) => roles[r].media === "image") || Object.keys(roles)[0]) : "character");
  const upload = async (file: File) => {
    const pid = location.pathname.match(/\/p\/(prj_\w+)/)?.[1];
    if (!pid) return;
    setBusy("upload");
    try {
      const a = await uploadFile(pid, file);
      await commit([...d.references, { asset_id: a.asset_id, role: imageRole() }]);
    } finally {
      setBusy("");
      setPicking(false);
    }
  };
  if (!d.references.length && !(isVoice && d.params?.voice) && !canEdit) return null;
  return (
    <div className={`dock-refs ${canEdit ? "editable" : ""}`}>
      {isVoice && d.params?.voice && <PlayButton url={voicePreview(String(d.params.voice))} label={`Voice · ${d.params.voice}`} className="dock-ref audio" title={`Hear ${d.params.voice} from the voice library`} />}
      {d.references.map((r, k) => {
        const x = ctx.media[r.asset_id];
        const label = labelOf(d.model, d.references, k) || ROLE_LABEL[r.role] || r.role;
        const name = ctx.nameOf(r.asset_id).replace(/ · .*$/, "");
        if (x?.kind === "audio") return <PlayButton key={`${r.asset_id}-${k}`} url={x.url} label={name} className="dock-ref audio" title={`${label} — ${name}'s voice`} />;
        return (
          <span key={`${r.asset_id}-${k}`} className="dock-ref-wrap">
          {canEdit && (
            <button className="dock-ref-x" title={`Take ${name || label} out`} disabled={!!busy} onClick={() => commit(d.references.filter((_, j) => j !== k))}>
              <X size={10} />
            </button>
          )}
          <button className="dock-ref" title={`${label} — ${ctx.nameOf(r.asset_id)}`} onClick={() => (x?.full || x?.poster) && ctx.onPicture({ label: `${label} · ${ctx.nameOf(r.asset_id)}`, url: (x.full || x.poster)! })}>
            <span className="dock-ref-pic">{x?.poster ? <img src={x.poster} alt="" /> : isPending(r.asset_id) ? <Loader2 size={13} className="spin" /> : <Music size={13} />}</span>
            <span className="ellipsis">{isPending(r.asset_id) ? "Sheet · being made" : name || label}</span>
          </button>
          </span>
        );
      })}
      {canEdit && (
        <span className="dock-ref-wrap">
          <button className="dock-ref dock-ref-add" disabled={!!busy} onClick={() => setPicking(!picking)} title="Add a picture from this project, or upload one">
            <span className="dock-ref-pic">{busy ? <Loader2 size={13} className="spin" /> : <Plus size={14} />}</span>
            <span className="ellipsis">{busy === "upload" ? "Uploading…" : "Add"}</span>
          </button>
          {picking && (
            <div className="dock-ref-picker">
              <label className="btn small dock-ref-upload">
                <Upload size={12} /> Upload from your computer
                <input type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
              </label>
              <RefPicker assets={ctx.assets || []} roles={roles!} nameOf={ctx.nameOf} onPick={(a, role) => (setPicking(false), commit([...d.references, { asset_id: a.id, role }]))} onClose={() => setPicking(false)} />
            </div>
          )}
        </span>
      )}
    </div>
  );
}

// The settings as short chips; the voice shows as its own chip, so it isn't repeated here.
const settingsOf = (d: Draft, models: ModelSpec[]) => [
  ...draftSummary(d, models).split(" · ").filter((x) => x && !(d.model === "voice" && x === String(d.params?.voice))),
  ...((d.takes || 1) > 1 ? [] : d.model.startsWith("video") ? ["1 take"] : []),
];

// Long words in a short box: it grows to a few lines, then scrolls (without scrolling the chat
// behind it), with a fade while there's more below.
function WordsBox({ value, onChange, onBlur, onEscape, readOnly, title }: { value: string; onChange?: (v: string) => void; onBlur?: () => void; onEscape?: () => void; readOnly?: boolean; title?: string }) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const [more, setMore] = useState(false);
  const fit = () => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(150, el.scrollHeight + 2) + "px";
    setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 2);
  };
  useLayoutEffect(fit, [value]);
  return (
    <div className={`dock-words-wrap ${more ? "more" : ""}`}>
      <textarea
        ref={ta}
        className={`dock-words ${readOnly ? "read" : ""}`}
        value={value}
        readOnly={readOnly}
        title={title}
        rows={2}
        spellCheck={false}
        onChange={(e) => onChange?.(e.target.value)}
        onBlur={onBlur}
        onScroll={(e) => setMore(e.currentTarget.scrollTop + e.currentTarget.clientHeight < e.currentTarget.scrollHeight - 2)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onEscape?.();
        }}
      />
    </div>
  );
}

// A generation waiting for the person: what goes in (references, the voice), the words the model
// reads, its settings — tune any of it here, generate it, or ask for changes in the text box.
function DraftStep({ d, ctx, onGenerate, others }: { d: Draft; ctx: DraftCtx; onGenerate: (ids: string[]) => Promise<void>; others: Draft[] }) {
  const isVoice = d.model === "voice";
  const words = isVoice ? d.text : d.prompt;
  const [text, setText] = useState(words);
  const [details, setDetails] = useState(false);
  const [busy, setBusy] = useState<"" | "generate" | "all" | "skip" | "save">("");
  const [err, setErr] = useState("");
  useEffect(() => setText(words), [words]);
  const saveWords = async () => {
    if (text === words) return;
    setBusy("save");
    try {
      await ctx.api.edit(d.id, { model: d.model, params: d.params, takes: d.takes, references: d.references.map(({ asset_id, role }) => ({ asset_id, role })), ...(isVoice ? { text } : { prompt: text }) });
    } catch (e: any) {
      setErr(e.message || "Couldn't save the change");
    } finally {
      setBusy("");
    }
  };
  const act = async (what: "generate" | "all" | "skip") => {
    setBusy(what);
    setErr("");
    try {
      if (what !== "skip") await saveWords();
      if (what === "skip") {
        await ctx.api.discard(d.id);
        ctx.onSkipped?.(d);
      }
      else await onGenerate(what === "all" ? [d.id, ...others.map((x) => x.id)] : [d.id]);
    } catch (e: any) {
      setErr(e.message || "Couldn't do that");
    } finally {
      setBusy("");
    }
  };
  if (details)
    return <DraftEditor draft={d} media={ctx.media} models={ctx.models} assets={ctx.assets} nameOf={ctx.nameOf} api={ctx.api} onAsk={ctx.onAsk} onClose={() => setDetails(false)} onGenerate={onGenerate} className="in-dock" />;
  const settings = settingsOf(d, ctx.models);
  const all = others.length ? others.reduce((t, x) => t + x.cost_usd, d.cost_usd) : 0;
  const hasRefs = d.references.length > 0 || (isVoice && !!d.params?.voice);
  return (
    <>
      {hasRefs && <span className="dock-sec micro">{isVoice ? "Voice" : "Goes in"}</span>}
      <RefStrip d={d} ctx={ctx} editable />
      <span className="dock-sec micro">{isVoice ? "What it says" : "Prompt"} <i>· click to edit</i></span>
      <WordsBox value={text} onChange={setText} onBlur={saveWords} onEscape={() => setText(words)} title={isVoice ? "What the voice says — change it here" : "The words the model reads — change them here"} />
      <div className="dock-settings">
        {settings.map((s) => (
          <button key={s} className="dock-chip" onClick={() => setDetails(true)} title="Change it">
            {s}
          </button>
        ))}
        {d.status === "needs_approval" && <span className="dock-note">above your auto-approve limit</span>}
      </div>
      {err && <div className="gd-err">{err}</div>}
      <div className="dock-actions">
        <button className="btn tally dock-go" disabled={!!busy} onClick={() => act("generate")}>
          {busy === "generate" ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />} {busy === "generate" ? "Starting…" : "Generate"} <span className="num">{money(d.cost_usd)}</span>
        </button>
        {others.length > 0 && (
          <button className="btn small" disabled={!!busy} onClick={() => act("all")} title="Generate this and everything else waiting">
            {busy === "all" ? <Loader2 size={12} className="spin" /> : null} All {others.length + 1} <span className="num">{money(all)}</span>
          </button>
        )}
        <button className="btn small" disabled={!!busy} onClick={() => setDetails(true)} title="References, model and every setting">
          <SlidersHorizontal size={12} /> Adjust
        </button>
        <button className="dock-skip" disabled={!!busy} onClick={() => act("skip")} title="Don't make this one">
          {busy === "skip" ? "Skipping…" : "Skip"}
        </button>
      </div>
    </>
  );
}

// A generation in the chat's record, opened: its takes (status, progress, errors), what they made,
// and what went in — the references, the exact words, the settings and the price.
export function DraftDetails({ d, ctx, onAgain }: { d: Draft; ctx: Pick<DraftCtx, "media" | "models" | "nameOf" | "onPicture">; onAgain?: (assetId: string) => void }) {
  const words = d.model === "voice" ? d.text : d.prompt;
  const made = d.jobs.flatMap((j) => j.assets);
  const state = (j: Draft["jobs"][number]) =>
    j.status === "succeeded" ? "done" : j.status === "running" ? `generating${j.progress ? ` · ${Math.round(j.progress * 100)}%` : "…"}` : j.status === "queued" ? "queued" : j.status === "waiting" ? "waiting for its sheet" : j.status === "failed" ? "failed · refunded" : j.status;
  return (
    <div className="dd">
      {d.jobs.length > 0 && (
        <div className="dd-jobs">
          {d.jobs.map((j, k) => (
            <div key={j.id} className={`dd-job ${j.status}`}>
              <span className="dd-take">{d.jobs.length > 1 ? `Take ${k + 1}` : "Take"}</span>
              <span className="dd-state">{state(j)}</span>
              {(j.status === "running" || j.status === "queued") && (
                <span className="dd-bar">
                  <span style={{ width: `${Math.max(4, Math.round((j.progress || 0) * 100))}%` }} />
                </span>
              )}
              {j.error && <span className="dd-err">{j.error}</span>}
            </div>
          ))}
        </div>
      )}
      {made.length > 0 && (
        <div className="dd-made">
          {made.map((id) => {
            const x = ctx.media[id];
            if (x?.kind === "audio") return <PlayButton key={id} url={x.url} label={ctx.nameOf(id).replace(/ · .*$/, "") || "Play"} seconds={x.duration} className="btn small" />;
            const open = () => (x?.kind === "video" && x.url ? ctx.onPicture({ label: ctx.nameOf(id), url: x.url, kind: "video" }) : (x?.full || x?.poster) && ctx.onPicture({ label: ctx.nameOf(id), url: (x.full || x.poster)! }));
            return (
              <button key={id} className="dd-pic" onClick={open} title={ctx.nameOf(id)}>
                {x?.poster ? <img src={x.poster} alt="" /> : <Loader2 size={13} className="spin" />}
              </button>
            );
          })}
        </div>
      )}
      <RefStrip d={d} ctx={ctx} />
      {words && <WordsBox value={words} readOnly title="The words the model read" />}
      <div className="dock-settings">
        {settingsOf(d, ctx.models).map((s) => (
          <span key={s} className="dock-chip static">
            {s}
          </span>
        ))}
        <span className="dd-cost">{money(d.cost_usd)}</span>
        {onAgain && made[0] && (
          <button className="dock-skip" onClick={() => onAgain(made[0])} title="A new draft with exactly this prompt and these references, to change and make again">
            Make it again…
          </button>
        )}
      </div>
    </div>
  );
}
