// Stripe Checkout for permanent credit top-ups and recurring monthly plans. Webhook grants are
// idempotent: top-ups key off the Checkout session; renewals key off subscription + billing period.
import { createHmac, timingSafeEqual } from "node:crypto";
import { q, one } from "./db.mjs";
import { config } from "./config.mjs";
import { PACKS, PLANS, fromCredits } from "./credits.mjs";
import { HttpError } from "./auth.mjs";
import { trackServerEvent } from "./analytics.mjs";

const { secret, webhookSecret } = config.stripe;
export const stripeEnabled = !!(secret && webhookSecret && (!secret.startsWith("sk_live_") || config.production));
const stripe = async (path, params) => {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
    signal: AbortSignal.timeout(15000),
  });
  const body = await r.json();
  if (!r.ok) {
    console.error("stripe", path, r.status, body?.error?.message);
    throw new HttpError(502, "The payment page could not be opened. Please try again.", "stripe_error");
  }
  return body;
};
const metadata = (params, meta, prefixes = ["metadata"]) => {
  for (const prefix of prefixes) for (const [k, v] of Object.entries(meta)) params.set(`${prefix}[${k}]`, String(v));
};

export async function checkout(account, itemId) {
  if (!stripeEnabled) throw new HttpError(503, "Purchases are not available right now.", "billing_off");
  const pack = PACKS.find((p) => p.id === itemId);
  const plan = PLANS.find((p) => p.id === itemId);
  if (!pack && !plan) throw new HttpError(400, "Unknown credit pack or plan.", "unknown_pack");
  const existing = plan ? await one("select status, stripe_customer_id from studio.subscriptions where account_id=$1", [account.id]) : null;
  if (existing && ["active", "trialing", "past_due"].includes(existing.status))
    throw new HttpError(409, "You already have a monthly plan. Manage it from Billing.", "subscription_exists");
  const item = pack || plan;
  const meta = { product: "studio", account: account.id, item: item.id, credits: item.credits, kind: plan ? "subscription" : "topup" };
  const params = new URLSearchParams({
    mode: plan ? "subscription" : "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(item.cents),
    "line_items[0][price_data][product_data][name]": plan ? `FOLTIO ${plan.name}` : `${pack.credits.toLocaleString("en-US")} FOLTIO credits`,
    "line_items[0][price_data][product_data][description]": plan ? `${plan.credits.toLocaleString("en-US")} filmmaking credits each month; each refill rolls over for three months.` : "Credits for AI generation and Hermes. Purchased credits never expire.",
    success_url: `${config.publicOrigin}/billing?paid=1`,
    cancel_url: `${config.publicOrigin}/billing`,
    client_reference_id: account.id,
    allow_promotion_codes: "true",
  });
  if (existing?.stripe_customer_id) params.set("customer", existing.stripe_customer_id);
  else params.set("customer_email", account.email);
  if (plan) {
    params.set("line_items[0][price_data][recurring][interval]", "month");
    metadata(params, meta, ["metadata", "subscription_data[metadata]"]);
  } else {
    params.set("payment_intent_data[description]", `FOLTIO credits: ${pack.name}`);
    metadata(params, meta, ["metadata", "payment_intent_data[metadata]"]);
  }
  const session = await stripe("checkout/sessions", params);
  if (!session.url) throw new HttpError(502, "The payment page could not be opened. Please try again.", "stripe_error");
  return { url: session.url };
}

export async function portal(account) {
  if (!stripeEnabled) throw new HttpError(503, "Billing management is not available right now.", "billing_off");
  const sub = await one("select stripe_customer_id from studio.subscriptions where account_id=$1", [account.id]);
  if (!sub?.stripe_customer_id) throw new HttpError(404, "No monthly plan to manage.", "no_subscription");
  const session = await stripe("billing_portal/sessions", new URLSearchParams({ customer: sub.stripe_customer_id, return_url: `${config.publicOrigin}/billing` }));
  return { url: session.url };
}

export function verify(rawBody, signature) {
  const fields = String(signature || "").split(",").map((p) => p.split("="));
  const t = Number(fields.find(([k]) => k === "t")?.[1]);
  const signatures = fields.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !signatures.length) throw new HttpError(400, "Missing signature.", "bad_signature");
  if (Math.abs(Date.now() / 1000 - t) > 300) throw new HttpError(400, "Signature too old.", "bad_signature");
  const want = Buffer.from(createHmac("sha256", webhookSecret).update(`${t}.${rawBody}`).digest("hex"), "hex");
  const valid = signatures.some((value) => {
    const got = Buffer.from(value, "hex");
    return got.length === want.length && timingSafeEqual(got, want);
  });
  if (!valid) throw new HttpError(400, "Signature mismatch.", "bad_signature");
  return JSON.parse(rawBody);
}

const eventMeta = (o) => {
  for (const meta of [o.metadata, o.parent?.subscription_details?.metadata, o.subscription_details?.metadata, o.lines?.data?.find((line) => line.metadata && Object.keys(line.metadata).length)?.metadata])
    if (meta && Object.keys(meta).length) return meta;
  return {};
};
const periodEnd = (o) => o.current_period_end || o.items?.data?.[0]?.current_period_end || o.lines?.data?.[0]?.period?.end || null;

export async function applyEvent(event) {
  const o = event.data?.object || {};
  const meta = eventMeta(o);
  if (meta.product !== "studio") return;
  void trackServerEvent("billing_webhook", { accountId: meta.account || null, source: "billing", eventId: `evt_stripe_${event.id}`, properties: { action: event.type, status: o.status || o.payment_status || "received" } }).catch(() => {});

  if (event.type === "checkout.session.completed" && ["paid", "no_payment_required"].includes(o.payment_status) && meta.account) {
    const credits = Number(meta.credits || (meta.credit ? Number(meta.credit) * 100 : 0));
    if (!(credits > 0)) return;
    if (meta.kind === "subscription" || o.mode === "subscription") {
      await q(
        `insert into studio.subscriptions(account_id, stripe_customer_id, stripe_subscription_id, plan_id, status)
         values ($1,$2,$3,$4,'active') on conflict (account_id) do update set stripe_customer_id=excluded.stripe_customer_id,
         stripe_subscription_id=excluded.stripe_subscription_id, plan_id=excluded.plan_id, status='active', updated_at=now()`,
        [meta.account, o.customer, o.subscription, meta.item || meta.pack],
      );
      await q(
        `insert into studio.credits(account_id, kind, amount_usd, ref, note, expires_at)
         values ($1,'subscription',$2,$3,$4,now() + interval '3 months') on conflict (ref) do nothing`,
        [meta.account, fromCredits(credits), `subscription:${o.subscription}:initial`, `${meta.item || "monthly"} plan · ${credits} credits`],
      );
    } else {
      await q("insert into studio.credits(account_id, kind, amount_usd, ref, note) values ($1,'purchase',$2,$3,$4) on conflict (ref) do nothing", [
        meta.account, fromCredits(credits), o.id, `${meta.item || meta.pack || "credit"} · $${(Number(o.amount_total) / 100).toFixed(2)}`,
      ]);
    }
  } else if (event.type === "invoice.paid" && o.billing_reason === "subscription_cycle" && meta.account) {
    const credits = Number(meta.credits);
    const subId = typeof o.subscription === "string" ? o.subscription : o.parent?.subscription_details?.subscription || o.lines?.data?.[0]?.parent?.subscription_item_details?.subscription;
    const start = o.lines?.data?.[0]?.period?.start || o.period_start || o.created;
    if (!(credits > 0) || !subId || !start) return;
    await q(
      `insert into studio.credits(account_id, kind, amount_usd, ref, note, expires_at)
       values ($1,'subscription',$2,$3,$4,to_timestamp($5) + interval '3 months') on conflict (ref) do nothing`,
      [meta.account, fromCredits(credits), `subscription:${subId}:${start}`, `${meta.item || "monthly"} plan · ${credits} credits`, start],
    );
    const end = periodEnd(o);
    await q("update studio.subscriptions set status='active', current_period_end=case when $2::bigint is null then current_period_end else to_timestamp($2) end, updated_at=now() where account_id=$1", [meta.account, end]);
  } else if (event.type.startsWith("customer.subscription.") && meta.account) {
    await q(
      `insert into studio.subscriptions(account_id, stripe_customer_id, stripe_subscription_id, plan_id, status, current_period_end, cancel_at_period_end)
       values ($1,$2,$3,$4,$5,case when $6::bigint is null then null else to_timestamp($6) end,$7)
       on conflict (account_id) do update set stripe_customer_id=excluded.stripe_customer_id,
       stripe_subscription_id=excluded.stripe_subscription_id, plan_id=excluded.plan_id, status=excluded.status,
       current_period_end=excluded.current_period_end, cancel_at_period_end=excluded.cancel_at_period_end, updated_at=now()`,
      [meta.account, o.customer, o.id, meta.item || "monthly", o.status || (event.type.endsWith("deleted") ? "canceled" : "active"), periodEnd(o), !!o.cancel_at_period_end],
    );
  } else if (event.type === "charge.refunded" && meta.account) {
    const credits = Number(meta.credits || (meta.credit ? Number(meta.credit) * 100 : 0));
    const share = Number(o.amount_refunded) / Number(o.amount);
    const back = +(fromCredits(credits) * share).toFixed(2);
    if (!(back > 0)) return;
    await q(
      `insert into studio.credits(account_id, kind, amount_usd, ref, note)
       select $1, 'refund', -($2::numeric - coalesce((select -sum(amount_usd) from studio.credits where kind='refund' and ref like $4), 0)), $3, 'refund'
       on conflict (ref) do nothing`,
      [meta.account, back, `refund:${o.id}:${o.amount_refunded}`, `refund:${o.id}:%`],
    );
  }
}
