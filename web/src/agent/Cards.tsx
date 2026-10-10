import { LayoutGrid } from "lucide-react";
import type { PlanInfo } from "./useAgent";
import { openBoard } from "./view";
import { credits } from "../credits";

const money = (n?: number) => n === undefined || n === null ? "" : credits(n);

// The plan the agent wrote on the board, as a pointer: what it is, how long, what it should cost, and
// the way to the Board view where the clips live (the chat never keeps its own copy of the plan).
// Nothing to approve — each generation is approved as its own draft.
export function PlanCard({ plan, live, onAdjust }: { plan: PlanInfo; live: boolean; onAdjust: () => void }) {
  const shots = plan.storyboards || plan.shots || [];
  const seconds = shots.reduce((t, s) => t + (s.seconds || 0), 0);
  const facts = [shots.length ? `${shots.length} clip${shots.length === 1 ? "" : "s"}` : "", seconds ? `${Math.round(seconds)} s` : "", plan.minutes ? `~${plan.minutes} min to make` : ""].filter(Boolean).join(" · ");
  return (
    <div className={`ag-plan-card compact ${live ? "" : "old"}`}>
      <div className="pc-head">
        <span className="pc-kicker">Plan</span>
        <strong className="ellipsis">{plan.title || "Untitled"}</strong>
      </div>
      {plan.logline && (
        <p className="pc-logline one" title={plan.logline}>
          {plan.logline}
        </p>
      )}
      <div className="pc-foot">
        <span className="pc-facts num">
          {facts}
          {plan.total_usd !== undefined && (
            <>
              {facts ? " · " : ""}about <strong>{money(plan.total_usd)}</strong>
            </>
          )}
        </span>
        <span className="grow" />
        {live && (
          <button className="link small" onClick={onAdjust} title="Tell the agent what to change — or edit any clip on the board yourself">
            Change it
          </button>
        )}
        <button className="btn small" onClick={() => openBoard()} title="See and edit every clip on the board">
          <LayoutGrid size={12} /> Open board
        </button>
      </div>
    </div>
  );
}

// The story so far: the outline as it's agreed, newest change marked. Click opens the board.
export type StoryBeat = { id: string; part?: string; title?: string; text?: string; status?: string; changed?: boolean };
export function StoryCard({ beats, live }: { beats: StoryBeat[]; live: boolean }) {
  return (
    <div className={`ag-story ${live ? "" : "old"}`}>
      <div className="ag-story-head">
        <strong>Story so far</strong>
        <span className="muted small num">{beats.length} beat{beats.length === 1 ? "" : "s"}</span>
        <span className="grow" />
        <button className="btn ghost small" onClick={() => openBoard()}>
          Open board
        </button>
      </div>
      <ol className="ag-story-beats">
        {beats.map((b) => (
          <li key={b.id} className={`${b.changed ? "new" : ""} ${b.status === "draft" ? "draft" : ""}`}>
            <span className="ag-story-part">{b.part || "Beat"}</span>
            <span className="ag-story-body">
              <b>{b.title}</b>
              {b.text && <span>{b.text}</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
