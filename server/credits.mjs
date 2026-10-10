// One customer currency for generation and the built-in agent. Internally the existing numeric
// columns remain dollar-denominated for exact provider accounting; the product displays 100 credits
// per dollar. Top-ups never expire. Each monthly-plan grant rolls over for three months.
import { q, one } from "./db.mjs";
import { config } from "./config.mjs";

export const CREDITS_PER_USD = 100;
export const toCredits = (usd) => Math.max(0, Math.ceil((Number(usd) - 1e-9) * CREDITS_PER_USD));
export const fromCredits = (credits) => Number(credits) / CREDITS_PER_USD;

export const PACKS = [
  { id: "topup_1000", name: "1,000 credits", cents: 1000, credits: 1000 },
  { id: "topup_2550", name: "2,550 credits", cents: 2500, credits: 2550 },
  { id: "topup_5200", name: "5,200 credits", cents: 5000, credits: 5200 },
];

export const PLANS = [
  { id: "creator", name: "Creator", cents: 1500, credits: 1550 },
  { id: "filmmaker", name: "Filmmaker", cents: 3900, credits: 4100 },
  { id: "studio", name: "Studio", cents: 9900, credits: 10500 },
];

function spend(buckets, amount) {
  let left = Math.max(0, Number(amount) || 0);
  buckets.sort((a, b) => (a.expires ? +a.expires : Infinity) - (b.expires ? +b.expires : Infinity) || a.at - b.at);
  for (const bucket of buckets) {
    const used = Math.min(bucket.left, left);
    bucket.left -= used;
    left -= used;
    if (left <= 1e-9) break;
  }
  return left;
}

export function balanceFromEvents(events, now = Date.now()) {
  const buckets = [];
  let generation = 0, agent = 0, credited = 0, debt = 0;
  const add = (amount, at, expires) => {
    const paid = Math.min(debt, amount);
    debt -= paid;
    const left = amount - paid;
    if (left > 1e-9) buckets.push({ left, at, expires });
  };
  for (const e of events) {
    const at = +new Date(e.at);
    for (const bucket of buckets) if (bucket.expires && +bucket.expires <= at) bucket.left = 0;
    const amount = Number(e.amount) || 0;
    if (e.type === "credit") {
      if (amount > 0) {
        add(amount, at, e.expires_at ? new Date(e.expires_at) : null);
        credited += amount;
      } else debt += spend(buckets, -amount);
    } else if (amount >= 0) {
      debt += spend(buckets, amount);
      if (e.type === "generation") generation += amount;
      else agent += amount;
    } else {
      add(-amount, at, null);
      generation += amount;
    }
  }
  for (const bucket of buckets) if (bucket.expires && +bucket.expires <= now) bucket.left = 0;
  return { available: buckets.reduce((sum, bucket) => sum + bucket.left, 0) - debt, generation, agent, credited };
}

// Replay grants and charges chronologically. This makes three-month subscription rollover exact:
// an older purchase cannot be retroactively consumed by a later subscription grant.
export async function balance(account, db = { one, q }) {
  const query = db.q || (async (text, params) => { const row = await db.one(text, params); return row ? [row] : []; });
  const state = await db.one("select billing_from, billing_exempt as exempt from studio.accounts where id=$1", [account.id]);
  const events = await query(
    `select at, type, amount, expires_at from (
         select created_at as at, 'credit'::text as type, amount_usd::float as amount, expires_at
           from studio.credits where account_id=$1
         union all
         select created_at, 'generation', case when kind='release' then -amount_usd::float else amount_usd::float end, null
           from studio.ledger where account_id=$1 and created_at >= (select billing_from from studio.accounts where id=$1)
         union all
         select at, 'agent', (cost_micros::float / 1e6) * $2, null
           from studio.agent_usage where account_id=$1 and at >= (select billing_from from studio.accounts where id=$1)
       ) e order by at asc, case type when 'credit' then 0 else 1 end asc`,
    [account.id, config.markup],
  );
  const { available, generation, agent, credited } = balanceFromEvents(events);
  return {
    exempt: !!state?.exempt,
    balanceUsd: +available.toFixed(4),
    balanceCredits: toCredits(available),
    creditedUsd: +credited.toFixed(2),
    creditedCredits: toCredits(credited),
    generationUsd: +generation.toFixed(4),
    generationCredits: toCredits(generation),
    agentUsd: +agent.toFixed(4),
    agentCredits: toCredits(agent),
  };
}

// Whether this account can pay `cost` now (exempt accounts always can).
export const covers = (b, cost) => b.exempt || cost <= b.balanceUsd + 1e-9;

export const outOfCredit = (b, cost) =>
  `This costs ${toCredits(cost).toLocaleString("en-US")} credits and the balance is ${toCredits(b.balanceUsd).toLocaleString("en-US")} credits. Top up at ${config.publicOrigin}/billing.`;

// The welcome credit, once per account, for people who signed in with Google or Discord.
export async function grantTrial(accountId, provider) {
  if (!config.trialUsd || !["google", "discord"].includes(provider)) return;
  await q("insert into studio.credits(account_id, kind, amount_usd, ref, note) values ($1,'trial',$2,$3,'Welcome credit') on conflict (ref) do nothing", [
    accountId,
    config.trialUsd,
    `trial:${accountId}`,
  ]);
}

export async function history(accountId) {
  return q("select kind, amount_usd::float as amount_usd, round(amount_usd * 100)::int as amount_credits, note, expires_at, created_at from studio.credits where account_id=$1 order by created_at desc limit 50", [accountId]);
}
