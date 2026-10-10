// Quotes, approvals and the spend ledger. Three gates: nothing paid runs without a quote, and
// every run is checked against the credit balance, the per-operation auto-approve limit and the
// monthly cap (credits.mjs keeps the balance).
import { q, one, tx } from "../db.mjs";
import { id } from "../ids.mjs";
import { MODELS, priceOf } from "./catalog.mjs";
import { HttpError } from "../auth.mjs";
import { config } from "../config.mjs";
import { balance, covers, outOfCredit, toCredits } from "../credits.mjs";

export async function monthSpent(accountId) {
  const r = await one(
    `select coalesce(sum(case when kind='hold' then amount_usd when kind='release' then -amount_usd else 0 end),0)::float as spent
     from studio.ledger where account_id=$1 and created_at >= date_trunc('month', now())`,
    [accountId],
  );
  return r.spent;
}

export async function budget(account) {
  const [spent, credit] = await Promise.all([monthSpent(account.id), balance(account)]);
  return {
    balanceUsd: credit.exempt ? null : credit.balanceUsd,
    balanceCredits: credit.exempt ? null : credit.balanceCredits,
    monthlyCapUsd: Number(account.monthly_cap_usd),
    monthlyCapCredits: toCredits(account.monthly_cap_usd),
    spentThisMonthUsd: +spent.toFixed(4),
    spentThisMonthCredits: toCredits(spent),
    remainingUsd: +(Number(account.monthly_cap_usd) - spent).toFixed(4),
    remainingCredits: toCredits(Math.max(0, Number(account.monthly_cap_usd) - spent)),
    autoApproveBelowUsd: Number(account.per_op_auto_usd),
    autoApproveBelowCredits: toCredits(account.per_op_auto_usd),
  };
}

// review: a draft the person looks over (and may edit) before it runs; it keeps for a week.
const policyOf = (cost, b, review) => (cost > b.remainingUsd || (b.balanceUsd != null && cost > b.balanceUsd + 1e-9) ? "blocked" : review ? "review" : cost > b.autoApproveBelowUsd ? "needs_approval" : "open");
const ttl = (policy) => (policy === "review" ? "7 days" : "15 minutes");
const quoteView = (row, cost, policy, b, warnings) => ({
  quote_id: row.id,
  model: row.model,
  cost_usd: cost,
  cost_credits: toCredits(cost),
  policy,
  expires_at: row.expires_at,
  budget: { ...b, remainingAfterUsd: +(b.remainingUsd - cost).toFixed(4), remainingAfterCredits: toCredits(Math.max(0, b.remainingUsd - cost)) },
  approve_url: policy === "needs_approval" ? `${config.publicOrigin}/approve/${row.id}` : undefined,
  topup_url: policy === "blocked" && b.balanceUsd != null && cost > b.balanceUsd ? `${config.publicOrigin}/billing` : undefined,
  warnings,
});

export async function createQuote(account, projectId, req, { review = false } = {}) {
  const m = MODELS[req.model];
  if (!m) throw new HttpError(400, `Unknown model ${JSON.stringify(req.model)}. Call gen_models to list them.`, "unknown_model");
  const cost = priceOf(m, req);
  const b = await budget(account);
  const status = policyOf(cost, b, review);
  const row = await one(
    `insert into studio.quotes(id, account_id, project_id, model, request, cost_usd, status, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7, now() + $8::interval) returning *`,
    [id("qt"), account.id, projectId, req.model, req, cost, status === "blocked" ? "denied" : status, ttl(status)],
  );
  return quoteView(row, cost, status, b, []);
}

// Change a quote that hasn't run (a draft the person or the director edits): new request, new price.
export async function reviseQuote(account, quoteId, req, { by = "agent" } = {}) {
  const m = MODELS[req.model];
  if (!m) throw new HttpError(400, `Unknown model ${JSON.stringify(req.model)}.`, "unknown_model");
  const cur = await one("select * from studio.quotes where id=$1 and account_id=$2", [quoteId, account.id]);
  if (!cur) throw new HttpError(404, "Quote not found.", "unknown_quote");
  if (!["review", "open", "needs_approval", "approved"].includes(cur.status)) throw new HttpError(409, `This generation already ${cur.status === "used" ? "ran" : "was declined"}; make a new one.`, "quote_closed");
  const cost = priceOf(m, req);
  const b = await budget(account);
  const status = policyOf(cost, b, cur.status === "review");
  const row = await one(
    `update studio.quotes set model=$3, request=$4, cost_usd=$5, status=$6, expires_at=now() + $7::interval, updated_at=now(), edited_by=$8
     where id=$1 and account_id=$2 returning *`,
    [quoteId, account.id, req.model, req, cost, status === "blocked" ? "denied" : status, ttl(status), by],
  );
  return quoteView(row, cost, status, b, []);
}

// Atomically turn an approved/open quote into a hold. Returns the quote row. person: the person
// pressed Generate themselves, which approves a draft or a quote above the auto-approve limit.
export async function holdForQuote(account, quoteId, { person = false } = {}) {
  return tx(async (t) => {
    const qt = await t.one("select * from studio.quotes where id=$1 and account_id=$2 for update", [quoteId, account.id]);
    if (!qt) throw new HttpError(404, "Quote not found.", "unknown_quote");
    if (new Date(qt.expires_at) < new Date() && qt.status !== "approved") throw new HttpError(409, "Quote expired; ask for a new one with gen_quote.", "quote_expired");
    if (qt.status === "used") throw new HttpError(409, "Quote already used.", "quote_used");
    if (qt.status === "denied") throw new HttpError(402, "This generation was declined, or it is over the monthly budget or the credit balance (top up at " + config.publicOrigin + "/billing).", "quote_denied");
    if (qt.status === "review" && !person)
      throw new HttpError(409, "This is a draft waiting for the person: it's in the box under the chat with its exact prompt and references; they may edit it and press Generate. End your turn and say what is ready; you'll get a message when it runs.", "needs_review");
    if (qt.status === "needs_approval" && !person)
      throw new HttpError(402, `This costs ${toCredits(qt.cost_usd)} credits, above the auto-approve limit. Approve it at ${config.publicOrigin}/approve/${qt.id} then call gen_run again.`, "needs_approval", { approve_url: `${config.publicOrigin}/approve/${qt.id}` });
    const spent = await t.one(
      `select coalesce(sum(case when kind='hold' then amount_usd when kind='release' then -amount_usd else 0 end),0)::float as s
       from studio.ledger where account_id=$1 and created_at >= date_trunc('month', now())`,
      [account.id],
    );
    if (spent.s + Number(qt.cost_usd) > Number(account.monthly_cap_usd) + 1e-9)
      throw new HttpError(402, "This would exceed the monthly budget.", "over_budget");
    await t.one("select id from studio.accounts where id=$1 for update", [account.id]); // one hold at a time per account
    const credit = await balance(account, t);
    if (!covers(credit, Number(qt.cost_usd)))
      throw new HttpError(402, outOfCredit(credit, Number(qt.cost_usd)), "insufficient_credit", { topup_url: `${config.publicOrigin}/billing` });
    await t.q("insert into studio.ledger(account_id, kind, amount_usd, quote_id, note) values ($1,'hold',$2,$3,$4)", [account.id, qt.cost_usd, qt.id, qt.model]);
    await t.q("update studio.quotes set status='used' where id=$1", [qt.id]);
    return qt;
  });
}

export const releaseHold = (accountId, quoteId, amount, jobId, note) =>
  q("insert into studio.ledger(account_id, kind, amount_usd, quote_id, job_id, note) values ($1,'release',$2,$3,$4,$5)", [accountId, amount, quoteId, jobId, note || "refund"]);
export const recordCharge = (accountId, amount, jobId, note) =>
  q("insert into studio.ledger(account_id, kind, amount_usd, job_id, note) values ($1,'hold',$2,null,$3)", [accountId, amount, `${note} (${jobId})`]);
