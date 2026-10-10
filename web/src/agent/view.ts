// Ask the editor to show the Board view on the stage (optionally on one clip). Editor.tsx listens.
export type ViewEvent = { view: "board" | "preview"; clip?: string };
export const openBoard = (clip?: string) => window.dispatchEvent(new CustomEvent<ViewEvent>("studio:view", { detail: { view: "board", ...(clip ? { clip } : {}) } }));

// Media added to the project anywhere (the Media tab, a drop on the editor) is offered to the agent as a
// reference in its composer. Queued here, so it arrives even while the agent panel isn't showing.
export type MediaRef = { asset_id: string; name: string; kind: string; image?: string | null };
const refQueue: MediaRef[] = [];
export const offerRefs = (refs: MediaRef[]) => {
  refQueue.push(...refs);
  window.dispatchEvent(new CustomEvent("studio:refs"));
};
export const takeRefs = () => refQueue.splice(0);

// Files dropped anywhere on the editor go through the agent's composer (one upload path: they land in
// the project and show as references there, with progress). Queued until the panel is showing.
const fileQueue: File[] = [];
export const offerFiles = (files: File[]) => {
  fileQueue.push(...files);
  window.dispatchEvent(new CustomEvent("studio:files"));
};
export const takeFiles = () => fileQueue.splice(0);
