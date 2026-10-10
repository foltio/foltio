// Dev-only: the decision box with a sample question, to design it without a live agent (/lab.html).
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "../styles.css";
import "../editor.css";
import "../agent/agent.css";
import { Dock, type DockItem } from "../agent/Dock";
import type { Question } from "../agent/useAgent";

const set: Question = {
  id: "s1",
  questions: [
    {
      id: "q1",
      header: "Premise",
      question: "Which version is closest?",
      other: true,
      options: [
        { label: "The sublet (suggested)", description: "Claire, French, is in New York for a three-month work posting. She's engaged to a man in Paris and flies home in two weeks. She sublets a room from Dana, a Brooklyn bartender who plays piano late at night, and every night she stays up a little later to listen." },
        { label: "The move", description: "Jess has lived in New York for eight years with her boyfriend. He got the job in LA and they leave in a month. While she packs up her life, she meets Noor, who runs the record shop she's selling her vinyl to." },
        { label: "The rotation", description: "Hannah, a London surgeon, is doing a six-week fellowship at a Manhattan hospital. Her partner of ten years is back home. On night shifts she falls for Rosa, an ER nurse. Ending: Hannah's last shift." },
        { label: "Mix / my own", description: "Combine parts, or describe something else." },
      ],
    },
    { id: "q2", header: "Ending", question: "How does it end?", other: true, options: [{ label: "She stays", description: "" }, { label: "She goes", description: "" }] },
  ],
};
// Look previews answered by eye: three low-res stills as cards (gradients stand in for the frames).
const swatch = (a: string, b: string, c: string) =>
  "data:image/svg+xml;utf8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><radialGradient id="g" cx="0.3" cy="0.35" r="0.9"><stop offset="0" stop-color="${a}"/><stop offset="0.55" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></radialGradient></defs><rect width="640" height="360" fill="url(#g)"/><rect x="260" y="120" width="90" height="170" rx="10" fill="${c}" opacity="0.55"/></svg>`);
const looks: Question = {
  id: "s2",
  questions: [
    {
      id: "q1",
      header: "Look",
      question: "Which is closest to how this memory looks?",
      other: true,
      options: [
        { label: "Sodium night (suggested)", description: "ast_lab000001" },
        { label: "Cold fluorescent", description: "ast_lab000002" },
        { label: "Dawn haze", description: "ast_lab000003" },
      ],
    },
  ],
};
const labMedia: Record<string, any> = {
  ast_lab000001: { kind: "image", name: "Preview · sodium", status: "ready", duration: null, poster: swatch("#ffb35c", "#7a3418", "#140806"), url: null },
  ast_lab000002: { kind: "image", name: "Preview · fluorescent", status: "ready", duration: null, poster: swatch("#d8f5ec", "#3d6f6a", "#0b1516"), url: null },
  ast_lab000003: { kind: "image", name: "Preview · dawn", status: "ready", duration: null, poster: swatch("#f6d6e4", "#8a7fa6", "#1e1c2c"), url: null },
};
function Lab() {
  const [hi, setHi] = useState(0);
  const [text, setText] = useState("");
  const which = new URLSearchParams(location.search).get("q") || "looks";
  const budget = new URLSearchParams(location.search).get("used") ? { spent: 2, cap: 2, left: 0 } : { spent: 0.42, cap: 2, left: 1.58 };
  const item: DockItem = which === "looks" ? { key: "q-s2-q1", kind: "question", set: looks, q: looks.questions[0], step: 0, steps: 1 } : { key: "q-s1-q1", kind: "question", set, q: set.questions[0], step: 0, steps: 2 };
  const input = (
    <div className="ag-input">
      <button className="icon xs" title="Attach">📎</button>
      <textarea rows={1} placeholder="Write your own answer…" value={text} onChange={(e) => setText(e.target.value)} />
      <button className="ag-send answer" disabled={!text.trim()}>Answer ↵</button>
    </div>
  );
  return (
    <div style={{ width: 420, margin: "24px", background: "var(--surface-1)", padding: 12, minHeight: 700 }}>
      <div className="agent-panel">
        <div className="ag-compose answering">
          <div className="ag-box with-dock">
            <Dock items={[item, { key: "c", kind: "choices", id: "c", options: ["a"] }]} current={item} setCurrent={() => {}} hi={hi} setHi={setHi} answers={{}} onPick={(l) => alert(l)} onDismissChoices={() => {}} onGenerate={async () => {}} answerSlot={input}
              draft={{ media: labMedia, models: [], assets: [], nameOf: (x) => labMedia[x]?.name || x, api: {} as any, onPicture: () => {}, onAsk: () => {}, previews: budget }} />
          </div>
        </div>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Lab />);
