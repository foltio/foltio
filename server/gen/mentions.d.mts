// Types for the browser (web/src/agent/Drafts.tsx imports mentions.mjs).
export declare const IMAGE_ROLES: string[];
export type MentionRef = { role: string; key?: string; asset_id?: string };
export type Slot = { i: number; kind: "image" | "audio" | "video"; n: number; label: string };
export declare function slots(model: string, refs?: MentionRef[]): Slot[];
export declare function labelOf(model: string, refs: MentionRef[], index: number): string | null;
export declare function renumber(prompt: string, before: { model: string; refs: MentionRef[] }, after: { model: string; refs: MentionRef[] }): { prompt: string; orphans: string[] };
