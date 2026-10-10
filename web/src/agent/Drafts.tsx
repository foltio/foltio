import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Sparkles, Pencil, X, ArrowUp, ArrowDown, Plus, Check, Music, Film, RotateCcw, MessageSquare, Play } from "lucide-react";
import { api } from "../api";
import { labelOf, renumber } from "../../../server/gen/mentions.mjs";
import type { Media } from "./Board";
import { VoicePicker } from "./Play";
import { credits } from "../credits";

// Drafts: generations prepared by the agent (or by you from the board) that wait for you in the box
// under the chat (Dock.tsx). Each shows exactly what goes to the model — the prompt, the references in
// order and the settings — and every part can be changed in the full editor here before you press
// Generate. Reordering or removing a reference renumbers
// the prompt's "Image 2" mentions so they keep pointing at the same files.

export type DraftRef = { asset_id: string; role: string; seconds?: number };
export type DraftJob = { id: string; status: string; progress?: number; error?: string | null; assets: string[] };
export type Draft = {
  id: string;
  status: "review" | "needs_approval" | "open" | "approved" | "used" | "denied";
  model: string;
  endpoint?: string; // a raw request: the fal endpoint it calls with its own input
  priced?: string | null; // how a raw request was priced ("$0.06/s at 768p × 6 s")
  title: string | null;
  for: { cast?: string; place?: string; voice?: string; music?: string; look?: string; storyboard?: string; make?: string; read?: string; line?: string } | null;
  by: "agent" | "human" | null;
  edited_by: string | null;
  prompt: string;
  text: string;
  params: Record<string, any>;
  references: DraftRef[];
  takes: number;
  cost_usd: number;
  jobs: DraftJob[];
};
type Param = { enum?: (string | number)[]; type?: string; min?: number; max?: number; default?: any; note?: string; descriptions?: Record<string, string> };
export type ModelSpec = { id: string; kind: string; job: string; model: string; price: string; params: Record<string, Param>; referenceRoles: Record<string, { max: number; media: string; required?: boolean; note?: string }> };
export type PickAsset = { id: string; kind: string; name: string; poster?: string | null; status: string; roles?: string[]; url?: string | null; duration?: number | null };

const money = (n?: number) => n === undefined || n === null || Number.isNaN(n) ? "" : credits(n);
export const isOpen = (d?: Draft) => !!d && (d.status === "review" || d.status === "needs_approval");
const isRunning = (d: Draft) => d.status === "used" && d.jobs.some((j) => j.status === "queued" || j.status === "running" || j.status === "waiting");
const isPending = (assetId: string) => assetId.startsWith("pending:");

let modelsP: Promise<ModelSpec[]> | null = null;
export function useModels() {
  const [models, setModels] = useState<ModelSpec[]>([]);
  useEffect(() => {
    modelsP ||= api<{ models: ModelSpec[] }>("/api/models").then((r) => r.models).catch(() => ((modelsP = null), []));
    modelsP.then(setModels);
  }, []);
  return models;
}

export function useDrafts(projectId: string) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [media, setMedia] = useState<Media>({});
  const busy = useRef(false);
  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const r = await api<{ drafts: Draft[]; media: Media }>(`/api/projects/${projectId}/drafts`);
      setDrafts(r.drafts);
      setMedia(r.media);
    } catch {
      /* keep what we have */
    } finally {
      busy.current = false;
    }
  }, [projectId]);
  useEffect(() => {
    load();
  }, [load]);
  // results arrive on their own clock while something runs, and are playable once processed
  const running = drafts.some(isRunning) || drafts.some((d) => d.status === "used" && d.jobs.some((j) => j.status === "succeeded" && j.assets.some((a) => media[a] && media[a].status !== "ready")));
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [running, load]);
  const edit = useCallback(async (id: string, patch: any) => {
    const r = await api<any>(`/api/quotes/${id}/edit`, patch);
    await load();
    return r;
  }, [load]);
  const generate = useCallback(
    async (ids: string[]) => {
      const out: { id: string; job_ids: string[] }[] = [];
      let err: any = null;
      for (const id of ids) {
        try {
          const r = await api<{ job_ids: string[] }>(`/api/quotes/${id}/generate`, {});
          out.push({ id, job_ids: r.job_ids });
        } catch (e) {
          err = e;
        }
      }
      await load();
      if (err && !out.length) throw err;
      return out;
    },
    [load],
  );
  const discard = useCallback(async (id: string) => {
    await api(`/api/quotes/${id}/discard`, {});
    await load();
  }, [load]);
  const create = useCallback(
    async (body: any) => {
      const r = await api<{ quote_id: string }>(`/api/projects/${projectId}/drafts`, body);
      await load();
      return r.quote_id;
    },
    [projectId, load],
  );
  const byId = useMemo(() => Object.fromEntries(drafts.map((d) => [d.id, d])), [drafts]);
  return { drafts, media, byId, load, edit, generate, discard, create };
}
export type DraftsApi = ReturnType<typeof useDrafts>;

const PARAM_LABEL: Record<string, string> = { duration: "Length (s)", resolution: "Quality", aspect: "Aspect", tier: "Tier", voice: "Voice", quality: "Detail", size: "Size", transparent: "Transparent", n: "Images", target: "Upscale to", fps: "FPS", output: "Return", stability: "Stability", loop: "Loop", rewrite: "Prompt rewrite", language: "Language" };
const ROLE_LABEL: Record<string, string> = { storyboard: "Storyboard", character: "Character", subject: "Product / prop", style: "Look", location: "Place", first_frame: "First frame", last_frame: "Last frame", voice: "Voice", soundtrack: "Soundtrack", source_video: "Clip", edit_source: "Image to edit" };
const mediaOfRole = (spec?: { media: string }) => spec?.media || "image";
export { money as draftMoney, summaryOf as draftSummary, ROLE_LABEL, isPending };
// A draft's name a person can read: its title, else what kind of thing it is and its first words.
const MADE_AS: Record<string, string> = { raw: "fal model", video: "Video", "video/ref": "Video with references", "video/omni": "Video (Omni)", "video/edit": "Video edit", "video/extend": "Extension", "video/talk": "Talking shot", "video/upscale": "Upscale", image: "Image", "image/fast": "Image", voice: "Voice line", music: "Music", "music/exact": "Music", sfx: "Sound effect" };
export function draftName(d: Pick<Draft, "title" | "model" | "prompt" | "text">) {
  if (d.title) return d.title;
  const words = String(d.prompt || d.text || "").replace(/(Image|Audio) \d+ is[^.]*\.\s*/g, "").replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ").replace(/[.,;:]+$/, "");
  return `${MADE_AS[d.model] || d.model}${words ? ` · ${words}…` : ""}`;
}
const KIND_ICON = (kind?: string) => (kind === "audio" ? <Music size={14} /> : kind === "video" ? <Film size={14} /> : null);
const modelName = (models: ModelSpec[], id: string) => models.find((m) => m.id === id)?.model?.replace(/\s*\(.*\)$/, "") || id;

function summaryOf(d: Draft, models: ModelSpec[]) {
  const p = d.params || {};
  const bits = [d.model === "raw" ? d.endpoint || "fal" : modelName(models, d.model)];
  if (p.duration) bits.push(`${p.duration} s`);
  if (p.resolution) bits.push(String(p.resolution));
  if (p.aspect) bits.push(String(p.aspect));
  if (p.voice) bits.push(String(p.voice));
  if ((d.takes || 1) > 1) bits.push(`${d.takes} takes`);
  return bits.join(" · ");
}

type EditRef = DraftRef & { key: string };

// The full editor for one draft: model, references (order, roles, add, remove), prompt, settings.
export function DraftEditor({ draft: d, media, models, assets, nameOf, api: D, onAsk, onClose, onGenerate, className = "" }: { draft: Draft; media: Media; models: ModelSpec[]; assets: PickAsset[]; nameOf: (id: string) => string; api: DraftsApi; onAsk: (t: string) => void; onClose: () => void; onGenerate: (ids: string[]) => Promise<void>; className?: string }) {
  const seq = useRef(0);
  const keyed = (refs: DraftRef[]): EditRef[] => refs.map((r) => ({ ...r, key: `k${seq.current++}` }));
  const [model, setModel] = useState(d.model);
  const [refs, setRefs] = useState<EditRef[]>(() => keyed(d.references));
  const [prompt, setPrompt] = useState(d.model === "voice" ? d.text : d.prompt);
  const [params, setParams] = useState<Record<string, any>>({ ...d.params });
  const [takes, setTakes] = useState(d.takes || 1);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "generate" | "rebuild">("");
  const [err, setErr] = useState("");
  const [orphans, setOrphans] = useState<string[]>([]);
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => root.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), []);
  const m = models.find((x) => x.id === model);
  const kindOf = (id: string) => models.find((x) => x.id === id)?.kind;
  const alternatives = models.filter((x) => x.kind === kindOf(d.model) && (x.id === d.model || canSwitch(d.model, x.id)));
  const dirty = model !== d.model || takes !== (d.takes || 1) || prompt !== (d.model === "voice" ? d.text : d.prompt) || JSON.stringify(params) !== JSON.stringify(d.params) || JSON.stringify(refs.map(({ asset_id, role }) => ({ asset_id, role }))) !== JSON.stringify(d.references.map(({ asset_id, role }) => ({ asset_id, role })));

  // every change to the references keeps the prompt's mentions pointing at the same files
  const changeRefs = (next: EditRef[], nextModel = model) => {
    const r = renumber(prompt, { model, refs }, { model: nextModel, refs: next });
    setPrompt(r.prompt);
    setOrphans(r.orphans);
    setRefs(next);
  };
  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= refs.length) return;
    const next = refs.slice();
    [next[i], next[j]] = [next[j], next[i]];
    changeRefs(next);
  };
  const switchModel = (id: string) => {
    const spec = models.find((x) => x.id === id);
    if (!spec) return;
    // keep the settings the new model shares; drop references it can't take
    const nextParams: Record<string, any> = {};
    for (const [k, p] of Object.entries(spec.params)) {
      if (k === "seed") continue;
      const v = params[k];
      if (v !== undefined && (!p.enum || p.enum.includes(v)) && (p.max === undefined || v <= p.max) && (p.min === undefined || v >= p.min)) nextParams[k] = v;
      else if (p.default !== undefined && k !== "tier") nextParams[k] = k === "duration" && typeof v === "number" ? Math.min(p.max ?? v, Math.max(p.min ?? v, v)) : p.default;
    }
    const nextRefs = refs.filter((r) => spec.referenceRoles[r.role]);
    changeRefs(nextRefs, id);
    setParams(nextParams);
    setModel(id);
  };
  const save = async () => {
    const body: any = { model, params, takes, references: refs.map(({ asset_id, role }) => ({ asset_id, role })) };
    if (model === "voice") body.text = prompt;
    else body.prompt = prompt;
    return D.edit(d.id, body);
  };
  const run = async (what: "save" | "generate") => {
    setBusy(what);
    setErr("");
    try {
      if (dirty) await save();
      if (what === "generate") {
        await onGenerate([d.id]);
        onClose();
      } else onClose();
    } catch (e: any) {
      setErr(e.message || "Couldn't save it");
    } finally {
      setBusy("");
    }
  };
  const rebuild = async () => {
    setBusy("rebuild");
    setErr("");
    try {
      await D.edit(d.id, { rebuild: true });
      onClose();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy("");
    }
  };
  const roleOptions = (r: EditRef) => {
    const kind = media[r.asset_id]?.kind || "image";
    return Object.entries(m?.referenceRoles || {}).filter(([role, spec]) => mediaOfRole(spec) === kind || (mediaOfRole(spec) === "image" && kind === "video" && role !== "source_video"));
  };
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(window.innerHeight * 0.45, el.scrollHeight + 2) + "px";
  }, [prompt]);

  return (
    <div className={`gd open editing ${className}`} ref={root}>
      <div className="gd-head">
        <span className="gd-kicker">
          <Pencil size={11} /> Editing
        </span>
        <strong className="ellipsis">{d.title || d.model}</strong>
        <button className="icon xs" title="Close without saving" onClick={onClose}>
          <X size={13} />
        </button>
      </div>

      <label className="gd-field">
        <span>Model</span>
        <select value={model} onChange={(e) => switchModel(e.target.value)} disabled={alternatives.length < 2}>
          {alternatives.map((x) => (
            <option key={x.id} value={x.id}>
              {x.model.replace(/\s*\(.*\)$/, "")}
            </option>
          ))}
        </select>
      </label>
      {m && <p className="gd-hint">{m.job}</p>}

      {m && Object.keys(m.referenceRoles).length > 0 && (
        <div className="gd-field">
          <span>
            References <em className="muted">({refs.length})</em>
          </span>
          <div className="gd-ref-list">
            {refs.map((r, i) => {
              const x = media[r.asset_id] || assets.find((a) => a.id === r.asset_id);
              const label = labelOf(model, refs, i);
              return (
                <div key={r.key} className="gd-ref-row">
                  <span className="gd-ref-thumb">{x?.poster ? <img src={x.poster} alt="" /> : isPending(r.asset_id) ? <Loader2 size={13} /> : KIND_ICON(x?.kind) || "?"}</span>
                  <div className="gd-ref-main">
                    <span className="ellipsis">
                      <b className="gd-ref-label">{label || ROLE_LABEL[r.role] || r.role}</b> <span className="muted">{nameOf(r.asset_id)}</span>
                    </span>
                    <select value={r.role} onChange={(e) => setRefs(refs.map((y) => (y.key === r.key ? { ...y, role: e.target.value } : y)))} title={m.referenceRoles[r.role]?.note || "What this file is to the model"}>
                      {roleOptions(r).map(([role]) => (
                        <option key={role} value={role}>
                          {ROLE_LABEL[role] || role}
                        </option>
                      ))}
                      {!m.referenceRoles[r.role] && <option value={r.role}>{r.role} (not taken)</option>}
                    </select>
                  </div>
                  <div className="gd-ref-btns">
                    <button className="icon xs" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUp size={12} />
                    </button>
                    <button className="icon xs" title="Move down" disabled={i === refs.length - 1} onClick={() => move(i, 1)}>
                      <ArrowDown size={12} />
                    </button>
                    <button className="icon xs" title="Remove" onClick={() => changeRefs(refs.filter((y) => y.key !== r.key))}>
                      <X size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
            <div className="gd-ref-add">
              <button className="btn small" onClick={() => setPicking(!picking)}>
                <Plus size={12} /> Add a reference
              </button>
              {picking && (
                <RefPicker
                  assets={assets}
                  roles={m.referenceRoles}
                  nameOf={nameOf}
                  onPick={(a, role) => {
                    changeRefs([...refs, { asset_id: a.id, role, key: `k${seq.current++}` }]);
                    setPicking(false);
                  }}
                  onClose={() => setPicking(false)}
                />
              )}
            </div>
          </div>
        </div>
      )}

      <label className="gd-field">
        <span>{model === "voice" ? "Words to speak" : "Prompt"} <em className="muted">— exactly what the model reads</em></span>
        <textarea ref={ta} className="gd-text" value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => e.stopPropagation()} spellCheck={false} />
      </label>
      {orphans.length > 0 && <div className="gd-warn">The prompt still mentions {orphans.join(", ")}, which is no longer sent. Edit those lines.</div>}

      {m && (
        <div className="gd-params">
          {Object.entries(m.params)
            .filter(([k]) => k !== "seed")
            .map(([k, p]) =>
              k === "voice" && p.descriptions && p.enum ? (
                <div key={k} className="gd-param wide">
                  <span>{PARAM_LABEL[k]} <em className="muted">— click one to hear it and choose it</em></span>
                  <VoicePicker value={String(params[k] ?? p.default ?? "")} voices={p.enum.map(String)} about={(v) => p.descriptions?.[v] || ""} onChange={(v) => setParams({ ...params, [k]: v })} />
                </div>
              ) : (
              <label key={k} className="gd-param" title={p.note}>
                <span>{PARAM_LABEL[k] || k}</span>
                {p.enum ? (
                  <select value={params[k] ?? p.default ?? ""} onChange={(e) => setParams({ ...params, [k]: typeof p.enum![0] === "number" ? Number(e.target.value) : e.target.value })}>
                    {p.enum.map((v) => (
                      <option key={String(v)} value={String(v)}>
                        {String(v)}
                      </option>
                    ))}
                  </select>
                ) : p.type === "boolean" ? (
                  <input type="checkbox" checked={!!(params[k] ?? p.default)} onChange={(e) => setParams({ ...params, [k]: e.target.checked })} />
                ) : p.type === "integer" || p.type === "number" ? (
                  <input type="number" min={p.min} max={p.max} step={p.type === "integer" ? 1 : 0.1} value={params[k] ?? p.default ?? ""} onChange={(e) => setParams({ ...params, [k]: e.target.value === "" ? undefined : Number(e.target.value) })} onKeyDown={(e) => e.stopPropagation()} />
                ) : (
                  <input value={params[k] ?? ""} onChange={(e) => setParams({ ...params, [k]: e.target.value || undefined })} onKeyDown={(e) => e.stopPropagation()} />
                )}
              </label>
              ),
            )}
          <label className="gd-param">
            <span>Takes</span>
            <select value={takes} onChange={(e) => setTakes(Number(e.target.value))}>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {err && <div className="gd-err">{err}</div>}
      <div className="gd-actions">
        <button className="btn small tally" disabled={!!busy} onClick={() => run("generate")}>
          {busy === "generate" ? <Loader2 size={12} className="spin" /> : <Sparkles size={12} />} {dirty ? "Save & generate" : `Generate ${money(d.cost_usd)}`}
        </button>
        <button className="btn small" disabled={!!busy || !dirty} onClick={() => run("save")}>
          {busy === "save" ? <Loader2 size={12} className="spin" /> : <Check size={12} />} Save
        </button>
        <span className="grow" />
        {d.for && (
          <button className="link small" disabled={!!busy} onClick={rebuild} title="Write it again from the board as it is now (drops your edits)">
            <RotateCcw size={11} /> From the board
          </button>
        )}
        <button className="link small" onClick={() => (onAsk(`About the draft “${d.title || d.model}” (${d.id}): `), onClose())} title="Tell the agent what to change">
          <MessageSquare size={11} /> Ask the agent
        </button>
      </div>
      <p className="gd-hint">Price updates when you save. {dirty ? "Unsaved changes." : ""}</p>
    </div>
  );
}

const SWITCH: Record<string, string[]> = { "video/ref": ["video/omni", "video"], "video/omni": ["video/ref", "video"], video: ["video/ref", "video/omni"], image: ["image/fast"], "image/fast": ["image"], music: ["music/exact"], "music/exact": ["music"] };
const canSwitch = (from: string, to: string) => (SWITCH[from] || []).includes(to);

// Pick a file from the project (bibles, storyboards and takes first) and the role it plays.
export function RefPicker({ assets, roles, nameOf, onPick, onClose }: { assets: PickAsset[]; roles: ModelSpec["referenceRoles"]; nameOf: (id: string) => string; onPick: (a: PickAsset, role: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const accepts = (a: PickAsset) => Object.values(roles).some((s) => s.media === a.kind || (s.media === "image" && a.kind === "video"));
  const list = assets.filter((a) => a.status === "ready" && !a.roles?.includes("render") && accepts(a) && (!q || nameOf(a.id).toLowerCase().includes(q.toLowerCase())));
  const defaultRole = (a: PickAsset) => {
    const n = nameOf(a.id).toLowerCase();
    const has = (r: string) => !!roles[r];
    if (a.kind === "audio") return has("voice") ? "voice" : has("soundtrack") ? "soundtrack" : Object.keys(roles)[0];
    if (a.kind === "video" && has("source_video")) return "source_video";
    if (/storyboard/.test(n) && has("storyboard")) return "storyboard";
    if (/location|place/.test(n) && has("location")) return "location";
    if (has("character")) return "character";
    return Object.keys(roles).find((r) => roles[r].media === "image") || Object.keys(roles)[0];
  };
  return (
    <div className="gd-picker" onMouseLeave={onClose}>
      <input autoFocus placeholder="Find a file…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => (e.stopPropagation(), e.key === "Escape" && onClose())} />
      <div className="gd-picker-grid">
        {list.slice(0, 60).map((a) => (
          <button key={a.id} onClick={() => onPick(a, defaultRole(a))} title={nameOf(a.id)}>
            {a.poster ? <img src={a.poster} alt="" /> : <span className="gd-ref-icon">{KIND_ICON(a.kind)}</span>}
            <span className="ellipsis">{nameOf(a.id)}</span>
          </button>
        ))}
        {!list.length && <span className="muted small">Nothing here this model can take.</span>}
      </div>
    </div>
  );
}
