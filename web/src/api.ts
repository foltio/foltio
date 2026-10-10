import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let supa: SupabaseClient | null = null;
let cfg: { localMode?: boolean; supabaseUrl: string | null; supabaseAnonKey: string | null; mcpUrl: string; redditPixel?: string | null } | null = null;

export async function config() {
  if (!cfg) cfg = await (await fetch("/api/config")).json();
  return cfg!;
}
export const isLocalMode = () => !!cfg?.localMode;
export async function supabase() {
  if (!supa) {
    const c = await config();
    if (c.localMode || !c.supabaseUrl || !c.supabaseAnonKey) throw new Error("Supabase is disabled in local mode.");
    supa = createClient(c.supabaseUrl, c.supabaseAnonKey, { auth: { persistSession: true, storageKey: "studio-auth", flowType: "pkce" } });
  }
  return supa;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
  const started = performance.now();
  const requestMethod = method || (body === undefined ? "GET" : "POST");
  const c = await config();
  let token: string | undefined;
  if (!c.localMode) {
    const s = await supabase();
    const { data } = await s.auth.getSession();
    token = data.session?.access_token;
  }
  const r = await fetch(path, {
    method: requestMethod,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text };
  }
  window.dispatchEvent(new CustomEvent("foltio:api", { detail: { route: path.split("?")[0].replace(/\/(prj|ast|qt|job|fbk)_[\w-]+/g, "/$1_:id"), action: requestMethod.toLowerCase(), status: r.status, duration_ms: Math.round(performance.now() - started) } }));
  if (!r.ok) throw new ApiError(r.status, json.error || `HTTP ${r.status}`, json.code);
  return json as T;
}

// Upload straight to R2 through a presigned PUT, with progress.
export function putWithProgress(url: string, file: File, mime: string, onProgress: (p: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    x.setRequestHeader("Content-Type", mime);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(new Error(`upload failed (${x.status})`)));
    x.onerror = () => reject(new Error("upload failed (network)"));
    x.send(file);
  });
}

// Upload one file into a project: a presigned PUT straight to R2, then finalize (ingest starts).
export async function uploadFile(projectId: string, file: File, onProgress: (p: number) => void = () => {}) {
  const t = await api<any>(`/api/projects/${projectId}/upload`, { filename: file.name, bytes: file.size, mime: file.type || undefined });
  await putWithProgress(t.upload.url, file, t.upload.headers["Content-Type"], onProgress);
  await api(`/api/projects/${projectId}/finalize`, { asset_id: t.asset_id });
  const kind = file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : file.type.startsWith("image/") ? "image" : "file";
  return { asset_id: t.asset_id as string, name: file.name, kind };
}

export function navigate(to: string) {
  history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export type Rate = { num: number; den: number };
export type Item = {
  id: string;
  kind: "clip" | "image" | "color" | "title" | "captions";
  trackId: string;
  start: number;
  duration: number;
  name?: string;
  asset?: string;
  source?: { inMs: number };
  speed?: number;
  filter?: string; // custom ffmpeg look on the picture (server/timeline/fx.mjs)
  afilter?: string; // … and on the sound
  text?: string;
  visual?: Record<string, any>;
  audio?: Record<string, any>;
  style?: Record<string, any>;
  links?: Record<string, any>;
  color?: string;
  sources?: string[] | "auto";
  linkGroup?: string;
};
export type Track = { id: string; kind: "video" | "audio" | "text" | "caption"; name: string; role?: string; enabled?: boolean; muted?: boolean; locked?: boolean };
export type Doc = {
  settings: { rate: Rate; width: number; height: number; loudness: any; safeZone?: string };
  sequence: { tracks: Track[]; items: Record<string, Item>; transitions: Record<string, any>; markers: Record<string, any>; mix: any; background: string };
};
export type Asset = {
  id: string;
  kind: string;
  name: string;
  status: string;
  roles: string[];
  duration_s?: number;
  video?: string;
  audio?: boolean;
  poster?: string | null;
  proxy?: string | null;
  waveform?: string | null;
  transcript_words?: number;
  generated?: any;
  baked?: { recipe?: string; script_path?: string; script?: string; params?: Record<string, unknown>; inputs?: string[]; parent?: string; note?: string };
  origin?: any;
  error?: string;
  created_at?: string;
};
export type Job = { id: string; kind: string; status: string; progress: number; error?: any; output?: any; created_at: string; updated_at: string };
