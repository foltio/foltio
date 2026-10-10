// The Decisions strip: what's been decided, by layer, pinned to the top of the agent column. Collapsed
// it's one line (title · n decided · n open · cost); open, each decision is a line you can expand
// and edit — the edit is saved and sent to the agent as the instruction. Pins keep a decision fixed.
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Pencil, Pin, Check, Loader2, Sparkles } from "lucide-react";
import type { BoardApi } from "./Board";
import { credits } from "../credits";

export type Decision = { id: string; layer?: string; label: string; value?: string; asset?: string; pinned?: boolean; source?: string; updated?: string };
export type Open = { id: string; layer?: string; label: string; note?: string; important?: boolean };
// Working styles: the skills Studio ships (the agent loads one per project; their own skills work too).
export const STYLES: { id: string; label: string; note: string }[] = [
  { id: "storyboarded-film", label: "Storyboarded film", note: "A story made clip by clip from storyboards" },
  { id: "freestyle", label: "Freestyle", note: "No set structure — just ask" },
  { id: "music-video", label: "Music video", note: "Sections cut to a track" },
  { id: "ad-variants", label: "Ad with variants", note: "One proposition, versions by length and shape" },
  { id: "footage-edit", label: "Edit my footage", note: "Cut what you bring" },
];
export const styleLabel = (id?: string) => STYLES.find((x) => x.id === id)?.label || (id ? id.replace(/-/g, " ") : "");

// The project's working style as a small menu; changing it tells the agent.
function StylePicker({ value, onPick }: { value?: string; onPick: (id: string) => void }) {
  return (
    <label className="dec-style" title="How your agent works on this project — change it any time" onClick={(e) => e.stopPropagation()}>
      <select value={value || ""} onChange={(e) => onPick(e.target.value)}>
        <option value="">Style: let the agent suggest</option>
        {STYLES.map((x) => (
          <option key={x.id} value={x.id} title={x.note}>
            {x.label}
          </option>
        ))}
        {value && !STYLES.some((x) => x.id === value) && <option value={value}>{styleLabel(value)}</option>}
      </select>
      <ChevronDown size={11} />
    </label>
  );
}

const LAYERS = ["Piece", "Story", "People", "Places", "Look", "Sound", "Shape"];

export function DecisionsStrip({ api, onSay }: { api: BoardApi; onSay: (text: string) => void }) {
  const b = api.data?.board as (NonNullable<BoardApi["data"]>["board"] & { decisions?: Decision[]; open?: Open[] }) | undefined;
  const decisions = b?.decisions || [];
  const open = b?.open || [];
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  // the most recent change glows for a few seconds
  const latest = useMemo(() => [...decisions].sort((x, y) => String(y.updated || "").localeCompare(String(x.updated || "")))[0], [decisions]);
  const [glow, setGlow] = useState<string | null>(null);
  useEffect(() => {
    if (!latest?.updated || Date.now() - Date.parse(latest.updated) > 15000) return;
    setGlow(latest.id);
    const t = setTimeout(() => setGlow(null), 4000);
    return () => clearTimeout(t);
  }, [latest?.id, latest?.updated]);
  if (!b) return null;
  const style = (b.brief as { style?: string } | undefined)?.style;
  const pickStyle = async (id: string) => {
    await api.patch({ brief: { style: id || null } });
    onSay(id ? `[Style] Work in the "${styleLabel(id)}" style on this project from now on (skill: ${id}).` : "[Style] No set style: suggest one that fits, or just follow my lead.");
  };
  const title = b.plan?.title || b.brief?.intent || "This piece";
  const clips = b.storyboards?.length || 0;
  const cost = b.plan?.total_usd;
  const importantOpen = open.filter((o) => o.important !== false);
  const ready = decisions.length > 0 && importantOpen.length === 0 && clips > 0;

  const save = async (d: Decision) => {
    const value = draft.trim();
    if (!value || value === d.value) return setEditing(null);
    setBusy(true);
    try {
      await api.patch({ decisions: [{ id: d.id, value, source: "you" }] });
      onSay(`[Decision changed] ${d.layer || "Story"} · ${d.label}: ${value}\n(I changed this in the Decisions strip — update anything it affects, tell me what that is and what remaking it would cost.)`);
      setEditing(null);
    } finally {
      setBusy(false);
    }
  };
  // a picked preview's thumbnail; the look's own style frame stands in for a Look decision without one
  const lookRef = (b.look as { refs?: { asset_id: string; use?: string }[] } | undefined)?.refs?.find((r) => r.use === "style")?.asset_id;
  const thumbOf = (d: Decision) => {
    const id = d.asset || (d.layer === "Look" ? lookRef : undefined);
    return id ? api.data?.media?.[id]?.poster || null : null;
  };
  const pin = (d: Decision) => api.patch({ decisions: [{ id: d.id, pinned: !d.pinned }] });
  const groups = LAYERS.map((layer) => ({ layer, items: decisions.filter((d) => (d.layer || "Story") === layer) })).filter((g) => g.items.length);

  return (
    <div className={`dec ${expanded ? "open" : ""}`}>
      <button className="dec-bar" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
        <strong className="ellipsis">{title}</strong>
        <span className="dec-facts num">
          {decisions.length ? `${decisions.length} decided` : "Nothing decided yet"}
          {open.length > 0 && <> · <span className="dec-open-n">{open.length} open</span></>}
          {typeof cost === "number" && <> · about {credits(cost)}</>}
        </span>
        <StylePicker value={style} onPick={pickStyle} />
        <ChevronDown size={14} className={`dec-chev ${expanded ? "up" : ""}`} />
      </button>
      {expanded && (
        <div className="dec-body">
          {groups.map((g) => (
            <section key={g.layer} className="dec-group">
              <span className="micro">{g.layer}</span>
              {g.items.map((d) => (
                <div key={d.id} className={`dec-row ${glow === d.id ? "glow" : ""} ${editing === d.id ? "editing" : ""}`}>
                  {editing === d.id ? (
                    <div className="dec-edit">
                      <span className="dec-label">{d.label}</span>
                      <textarea autoFocus rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => (e.stopPropagation(), e.key === "Escape" ? setEditing(null) : e.key === "Enter" && (e.metaKey || e.ctrlKey) && save(d))} />
                      <div className="dec-edit-row">
                        <span className="muted small">Saving tells your agent to update what it affects.</span>
                        <span className="grow" />
                        <button className="btn ghost small" onClick={() => setEditing(null)}>
                          Cancel
                        </button>
                        <button className="btn primary small" disabled={busy || !draft.trim() || draft.trim() === d.value} onClick={() => save(d)}>
                          {busy ? <Loader2 size={12} className="spin" /> : <Check size={12} />} Save change
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <button className="dec-line" onClick={() => (setEditing(d.id), setDraft(d.value || ""))} title="Edit this decision">
                        <span className="dec-label">{d.label}</span>
                        <span className="dec-value">
                          {thumbOf(d) && <img className="dec-thumb" src={thumbOf(d)!} alt="" />}
                          {d.value}
                        </span>
                        <Pencil size={11} className="dec-pen" />
                      </button>
                      <button className={`icon xs dec-pin ${d.pinned ? "on" : ""}`} onClick={() => pin(d)} title={d.pinned ? "Pinned: your agent won't change this unless you ask. Click to unpin." : "Pin it: your agent won't change this unless you ask"}>
                        <Pin size={11} />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </section>
          ))}
          {open.length > 0 && (
            <section className="dec-group">
              <span className="micro">Still open</span>
              {open.map((o) => (
                <div key={o.id} className="dec-row open">
                  <span className="dec-dot" />
                  <span className="dec-label">{o.label}</span>
                  {o.note && <span className="dec-value">{o.note}</span>}
                </div>
              ))}
            </section>
          )}
        </div>
      )}
      {ready && (
        <div className="dec-ready">
          <Sparkles size={13} />
          <span>
            Story's complete · <span className="num">{clips} clip{clips === 1 ? "" : "s"}{typeof cost === "number" ? ` · about ${credits(cost)}` : ""}</span>
          </span>
          <span className="grow" />
          <button className="btn ghost small" onClick={() => onSay("Keep refining — what would you sharpen first?")}>
            Keep refining
          </button>
        </div>
      )}
    </div>
  );
}
