import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { creditCount } from "./credits";

export type BillingOffer = { id: string; name: string; cents: number; credits: number };
export type BillingSnapshot = {
  exempt: boolean;
  balanceCredits: number;
  creditedCredits: number;
  generationCredits: number;
  agentCredits: number;
  packs: BillingOffer[];
  plans: BillingOffer[];
  subscription: { plan_id: string; status: string; current_period_end?: string; cancel_at_period_end: boolean } | null;
  purchases: boolean;
  credits: { kind: string; amount_credits: number; note: string; expires_at?: string | null; created_at: string }[];
  usage: { note: string; usd: number; at: string }[];
};

let snapshot: BillingSnapshot | null = null;
let pending: Promise<BillingSnapshot> | null = null;
const listeners = new Set<(value: BillingSnapshot) => void>();

function publish(value: BillingSnapshot) {
  snapshot = value;
  for (const listener of listeners) listener(value);
  return value;
}

// One request and one shared value keep the header, editor and Billing page in sync. Calling this
// around a charge is cheap: simultaneous callers share the same in-flight request.
export function refreshBilling() {
  if (!pending) {
    pending = api<BillingSnapshot>("/api/billing")
      .then(publish)
      .finally(() => { pending = null; });
  }
  return pending;
}

// Agent usage arrives over the already-open socket. Reflect it immediately instead of waiting for
// the next HTTP poll; the poll still follows to update the history and subscription fields.
export function updateLiveCreditBalance(balanceUsd: unknown) {
  if (typeof balanceUsd !== "number" || !Number.isFinite(balanceUsd)) return void refreshBilling().catch(() => {});
  if (snapshot && !snapshot.exempt) publish({ ...snapshot, balanceCredits: creditCount(balanceUsd) });
  else refreshBilling().catch(() => {});
}

export function useLiveBilling(pollMs = 15_000) {
  const [billing, setBilling] = useState<BillingSnapshot | null>(snapshot);
  const [error, setError] = useState("");
  const refresh = useCallback(() => refreshBilling().then((value) => (setError(""), value)).catch((e) => {
    setError(e instanceof Error ? e.message : "Couldn't update credits");
    throw e;
  }), []);

  useEffect(() => {
    listeners.add(setBilling);
    refresh().catch(() => {});
    const visible = () => document.visibilityState === "visible" && refresh().catch(() => {});
    const timer = window.setInterval(visible, pollMs);
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      listeners.delete(setBilling);
      clearInterval(timer);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [pollMs, refresh]);

  return { billing, error, refresh };
}
