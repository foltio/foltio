// Two ways in:
//  - Agents (MCP/REST): a personal API key, `Authorization: Bearer sk_foltio_…` (hash stored, never the key).
//  - Browser editor: the user's Supabase session (Google or Discord). Anyone may sign up; with
//    STUDIO_INVITE_ONLY=1 only the allowlist (STUDIO_ADMIN_EMAILS) gets in.
import { randomBytes } from "node:crypto";
import { q, one } from "./db.mjs";
import { sha256 } from "./ids.mjs";
import { config } from "./config.mjs";
import { grantTrial } from "./credits.mjs";

export class HttpError extends Error {
  constructor(status, message, code, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// The account for this email, made on first sign-in. The team (STUDIO_ADMIN_EMAILS) is never
// charged; everyone else gets the welcome credit once, if they came in with Google or Discord.
export async function ensureAccount(email, name, provider) {
  email = email.toLowerCase();
  const found = await one("select * from studio.accounts where email = $1 or $1 = any(aliases) order by (email = $1) desc limit 1", [email]);
  if (found) return found;
  const made = await one(
    `insert into studio.accounts(email, name, monthly_cap_usd, per_op_auto_usd, billing_exempt) values ($1,$2,$3,$4,$5)
     on conflict (email) do update set email = excluded.email returning *`,
    [email, name || null, config.monthlyCapUsd, config.perOpAutoUsd, config.adminEmails.includes(email)],
  );
  await grantTrial(made.id, provider);
  return made;
}

let localAccountCache;
export async function localAccount() {
  if (!config.localMode) return null;
  if (localAccountCache) return localAccountCache;
  const email = config.localEmail.toLowerCase();
  localAccountCache = await one("select * from studio.accounts where email=$1", [email]);
  if (!localAccountCache) {
    localAccountCache = await one(
      `insert into studio.accounts(email, name, monthly_cap_usd, per_op_auto_usd, billing_exempt)
       values ($1,'Local owner',$2,$3,true) returning *`,
      [email, config.monthlyCapUsd, config.perOpAutoUsd],
    );
  }
  return localAccountCache;
}

export async function createApiKey(accountId, name = "default") {
  const secret = "sk_foltio_" + randomBytes(24).toString("base64url");
  await q("insert into studio.api_keys(account_id, name, prefix, hash) values ($1,$2,$3,$4)", [
    accountId,
    name,
    secret.slice(0, 14),
    sha256(secret),
  ]);
  return secret;
}

function bearer(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}
const isApiKey = (token) => /^sk_(?:foltio|studio)_/.test(token || ""); // studio keeps existing keys valid

export async function accountFromApiKey(req) {
  return accountFromKey(bearer(req));
}

// A personal key, or the short-lived key a built-in agent's sandbox acts with (kind 'hosted').
export async function accountFromKey(token, { kinds } = {}) {
  if (!isApiKey(token)) return null;
  const row = await one(
    `select k.id as key_id, k.kind as key_kind, a.* from studio.api_keys k join studio.accounts a on a.id = k.account_id
     where k.hash = $1 and k.revoked_at is null and (k.expires_at is null or k.expires_at > now())`,
    [sha256(token)],
  );
  if (!row || (kinds && !kinds.includes(row.key_kind))) return null;
  q("update studio.api_keys set last_used_at = now() where id = $1", [row.key_id]).catch(() => {});
  return row;
}

const sessionCache = new Map(); // token hash -> {account, until}
export async function accountFromSession(req) {
  if (config.localMode) return localAccount();
  const token = bearer(req);
  if (!token || isApiKey(token)) return null;
  return accountFromSessionToken(token);
}

// The account behind a Supabase access token (the browser's sign-in), or null.
export async function accountFromSessionToken(token) {
  const k = sha256(token);
  const hit = sessionCache.get(k);
  if (hit && hit.until > Date.now()) return hit.account;
  const r = await fetch(`${config.supabase.url}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: config.supabase.anonKey },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return null;
  const user = await r.json();
  const email = (user.email || "").toLowerCase();
  if (!email) return null;
  if (config.inviteOnly && !config.adminEmails.includes(email))
    throw new HttpError(403, `${email} is not allowed in this studio yet.`, "not_allowed", { email });
  const account = await ensureAccount(email, user.user_metadata?.full_name || user.user_metadata?.name, user.app_metadata?.provider);
  sessionCache.set(k, { account, until: Date.now() + 5 * 60_000 });
  if (sessionCache.size > 500) sessionCache.clear();
  return account;
}

export async function requireAccount(req) {
  const a = (await accountFromApiKey(req)) || (await accountFromSession(req)) || (await localAccount());
  if (!a) throw new HttpError(401, "Sign in, or send Authorization: Bearer <studio API key>.", "unauthorized");
  return a;
}
