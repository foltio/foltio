import type { User } from "@supabase/supabase-js";
import { api } from "./api";
import { identifyAnalytics } from "./analytics";

type Rdt = ((...args: unknown[]) => void) & { callQueue?: unknown[] };
declare global { interface Window { rdt?: Rdt } }

const CLICK_KEY = "foltio:rdt_cid";
const CLICK_TTL = 30 * 86400000;
const seenUsers = new Set<string>();
let loaded = false;
let lastPage = "";

function rememberClickId() {
  try {
    const id = new URLSearchParams(location.search).get("rdt_cid");
    if (id) localStorage.setItem(CLICK_KEY, JSON.stringify({ id: id.slice(0, 200), at: Date.now() }));
  } catch { /* storage unavailable */ }
}

function clickId(): string | undefined {
  try {
    const raw = localStorage.getItem(CLICK_KEY);
    if (!raw) return undefined;
    const { id, at } = JSON.parse(raw) as { id: string; at: number };
    return Date.now() - at < CLICK_TTL ? id : undefined;
  } catch { return undefined; }
}

export function initAdMeasurement(pixel?: string | null) {
  rememberClickId();
  if (loaded || !pixel) return;
  loaded = true;
  if (!window.rdt) {
    const queue: Rdt = ((...args: unknown[]) => queue.callQueue?.push(args)) as Rdt;
    queue.callQueue = [];
    window.rdt = queue;
    const script = document.createElement("script");
    script.src = "https://www.redditstatic.com/ads/pixel.js";
    script.async = true;
    document.head.appendChild(script);
  }
  window.rdt("init", pixel, { useDecimalCurrencyValues: true });
  lastPage = location.pathname + location.search;
  window.rdt("track", "PageVisit");
}

export function measurePageVisit() {
  const page = location.pathname + location.search;
  if (!loaded || page === lastPage) return;
  lastPage = page;
  window.rdt?.("track", "PageVisit");
}

// A newly created Supabase user is a standard Reddit SignUp conversion. Browser and server use
// the same conversion id so Reddit deduplicates them; returning sessions remain a custom Login.
export function noteSignedIn(user: User) {
  rememberClickId();
  if (seenUsers.has(user.id)) return;
  seenUsers.add(user.id);
  const key = `foltio:signup:${user.id}`;
  let counted = false;
  try { counted = !!localStorage.getItem(key); } catch { /* storage unavailable */ }
  const fresh = !!user.created_at && Date.now() - Date.parse(user.created_at) < 15 * 60000;
  identifyAnalytics(user, fresh && !counted);
  if (fresh && !counted) {
    try { localStorage.setItem(key, String(Date.now())); } catch { /* storage unavailable */ }
    const conversionId = `signup:${user.id}`;
    window.rdt?.("track", "SignUp", { conversionId });
    void api("/api/ads/convert", { event: "SignUp", conversionId, clickId: clickId() }).catch(() => {});
  } else {
    window.rdt?.("track", "Custom", { customEventName: "Login" });
  }
}
