import type { User } from "@supabase/supabase-js";
import { supabase } from "./api";

type Properties = Record<string, string | number | boolean | null | undefined>;
type QueuedEvent = { event_id: string; anonymous_id: string; session_id: string; name: string; path: string; project_id?: string; properties: Properties; occurred_at: string };

const ANON_KEY = "foltio:analytics:anonymous";
const SESSION_KEY = "foltio:analytics:session";
const ATTR_KEY = "foltio:analytics:attribution";
const SESSION_TTL = 30 * 60_000;
let queue: QueuedEvent[] = [];
let timer = 0;
let initialized = false;
let pageStarted = Date.now();
let pagePath = "";

const read = <T,>(key: string): T | null => { try { return JSON.parse(localStorage.getItem(key) || "null") as T; } catch { return null; } };
const write = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } };
const random = (prefix: string) => `${prefix}_${crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36)}`;
const anonymousId = () => {
  let value = read<string>(ANON_KEY);
  if (!value) { value = random("anon"); write(ANON_KEY, value); }
  return value;
};
const sessionId = () => {
  const old = read<{ id: string; touched: number }>(SESSION_KEY);
  const fresh = !old || Date.now() - old.touched > SESSION_TTL;
  const value = fresh ? { id: random("ses"), touched: Date.now() } : { ...old, touched: Date.now() };
  write(SESSION_KEY, value);
  if (fresh) queueMicrotask(() => track("session_started", attribution()));
  return value.id;
};
const projectFromPath = (path: string) => path.match(/^\/(?:p|v)\/(prj_\w+)/)?.[1];
const cleanPath = () => location.pathname;

function attribution(): Properties {
  let saved = read<Properties>(ATTR_KEY);
  if (saved) return saved;
  const params = new URLSearchParams(location.search);
  let referrer = "";
  try { referrer = document.referrer ? new URL(document.referrer).hostname.slice(0, 120) : ""; } catch { /* invalid referrer */ }
  saved = {
    source: params.get("utm_source")?.slice(0, 120) || (referrer || "direct"),
    medium: params.get("utm_medium")?.slice(0, 120) || (referrer ? "referral" : "none"),
    campaign: params.get("utm_campaign")?.slice(0, 120) || undefined,
    content: params.get("utm_content")?.slice(0, 120) || undefined,
    term: params.get("utm_term")?.slice(0, 120) || undefined,
    referrer_domain: referrer || undefined,
  };
  write(ATTR_KEY, saved);
  return saved;
}

function device(): Properties {
  const ua = navigator.userAgent;
  return {
    device: /Mobi|Android/i.test(ua) ? "mobile" : /iPad|Tablet/i.test(ua) ? "tablet" : "desktop",
    browser: /Edg\//.test(ua) ? "edge" : /Firefox\//.test(ua) ? "firefox" : /Chrome\//.test(ua) ? "chrome" : /Safari\//.test(ua) ? "safari" : "other",
    os: /iPhone|iPad/.test(ua) ? "ios" : /Android/.test(ua) ? "android" : /Mac OS/.test(ua) ? "macos" : /Windows/.test(ua) ? "windows" : /Linux/.test(ua) ? "linux" : "other",
  };
}

async function flush() {
  clearTimeout(timer); timer = 0;
  if (!queue.length) return;
  const events = queue.splice(0, 40);
  try {
    const s = await supabase();
    const { data } = await s.auth.getSession();
    const response = await fetch("/api/analytics/events", {
      method: "POST", keepalive: true,
      headers: { "Content-Type": "application/json", ...(data.session?.access_token ? { Authorization: `Bearer ${data.session.access_token}` } : {}) },
      body: JSON.stringify({ events }),
    });
    if (!response.ok) throw new Error(String(response.status));
  } catch {
    queue = [...events, ...queue].slice(0, 100);
  }
}

// Use this before a navigation that leaves FOLTIO (notably OAuth) so the last conversion step is
// stored before the browser unloads the page.
export async function flushAnalytics() {
  await flush();
}

export function track(name: string, properties: Properties = {}) {
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(name)) return;
  const path = cleanPath();
  queue.push({ event_id: random("evt"), anonymous_id: anonymousId(), session_id: sessionId(), name, path, project_id: projectFromPath(path), properties, occurred_at: new Date().toISOString() });
  if (queue.length >= 10) void flush();
  else if (!timer) timer = window.setTimeout(() => void flush(), 1200);
}

export function trackPageView(path: string, signedIn?: boolean) {
  const now = Date.now();
  if (pagePath && pagePath !== path) track("page_engaged", { route: pagePath, active_ms: now - pageStarted });
  pagePath = path; pageStarted = now;
  track("page_view", { ...attribution(), ...device(), signed_in: !!signedIn, route: path.replace(/\/(prj|ast|qt|job)_\w+/g, "/$1_:id") });
}

export function identifyAnalytics(user: User, fresh: boolean) {
  track(fresh ? "signed_up" : "signed_in", { fresh });
}

export function initProductAnalytics() {
  if (initialized) return;
  initialized = true;
  const started = performance.now();
  window.addEventListener("load", () => track("web_performance", { load_ms: Math.round(performance.now() - started) }), { once: true });
  window.addEventListener("error", (event) => track("web_error", { error_code: event.error?.name || "error", route: cleanPath() }));
  window.addEventListener("unhandledrejection", (event) => track("web_error", { error_code: event.reason?.name || "promise_rejection", route: cleanPath() }));
  document.addEventListener("click", (event) => {
    const element = (event.target as Element | null)?.closest<HTMLElement>("[data-analytics]");
    if (element?.dataset.analytics) track("ui_action", { action: element.dataset.analytics, area: element.dataset.analyticsArea });
  });
  window.addEventListener("foltio:api", ((event: CustomEvent<Properties>) => {
    const detail = event.detail || {};
    const status = Number(detail.status || 0);
    if (detail.action !== "get" || status >= 400) track(status >= 400 ? "api_error" : "api_mutation", detail);
  }) as EventListener);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (pagePath) track("page_engaged", { route: pagePath, active_ms: Date.now() - pageStarted });
      void flush();
    } else pageStarted = Date.now();
  });
  window.addEventListener("pagehide", () => void flush());
}
