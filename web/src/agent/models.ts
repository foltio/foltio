// The model a new conversation with the agent runs on: picked on the landing page or in the chat
// panel (both read and write the same choice), from the models the agent service offers.
export type ModelOption = { id: string; label: string; note?: string };

const KEY = "studio.agent.model";

export function storedModel() {
  try {
    return localStorage.getItem(KEY) || "";
  } catch {
    return "";
  }
}

export function storeModel(id: string) {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* private mode */
  }
}

// What the agent service offers, and its default (from /agent/health: no sign-in needed).
export async function offeredModels(): Promise<{ model: string; models: ModelOption[] }> {
  try {
    const r = await fetch("/agent/health");
    const j = await r.json();
    return { model: j.model || "", models: Array.isArray(j.models) ? j.models : [] };
  } catch {
    return { model: "", models: [] };
  }
}
