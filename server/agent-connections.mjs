import { randomBytes } from "node:crypto";
import { q, one } from "./db.mjs";
import { sha256 } from "./ids.mjs";
import { config } from "./config.mjs";
import { HttpError, localAccount } from "./auth.mjs";

const PENDING_SECONDS = 30 * 60;
const TOKEN_DAYS = 90;
const cleanName = (value) => String(value || "AI assistant").trim().replace(/\s+/g, " ").slice(0, 80) || "AI assistant";
const makeSecret = () => `sk_foltio_${randomBytes(24).toString("base64url")}`;
const makeCode = () => randomBytes(9).toString("base64url");

export async function decideAgentConnection(account, requestCode, decision = "approve") {
  const code = String(requestCode || "").trim();
  const current = await one("select * from studio.agent_connections where request_code=$1", [code]);
  if (!current) throw new HttpError(404, "This connection link does not exist.", "unknown_connection");
  if (current.status === "connected") {
    if (current.account_id !== account.id) throw new HttpError(409, "This connection belongs to another account.", "connection_taken");
    return { status: "connected", client_name: current.client_name, expires_at: current.token_expires_at };
  }
  if (current.status === "denied") throw new HttpError(409, "This connection was denied. Ask the agent for a new link.", "connection_denied");
  if (new Date(current.expires_at).getTime() <= Date.now()) throw new HttpError(410, "This connection link expired. Ask the agent for a new one.", "connection_expired");
  if (decision === "deny") {
    const denied = await one(
      "update studio.agent_connections set status='denied', account_id=$2, decided_at=now() where request_code=$1 and status='pending' returning client_name, status",
      [code, account.id],
    );
    return denied || { status: "denied", client_name: current.client_name };
  }
  const connected = await one(
    `with accepted as (
       update studio.agent_connections
       set status='connected', account_id=$2, decided_at=now(), token_expires_at=now()+($3::text || ' days')::interval
       where request_code=$1 and status='pending' and expires_at > now()
       returning *
     ), key as (
       insert into studio.api_keys(account_id, name, prefix, hash, kind, expires_at)
       select account_id, client_name, secret_prefix, secret_hash, 'agent', token_expires_at from accepted
       on conflict (hash) do nothing
     )
     select request_code, client_name, status, token_expires_at as expires_at from accepted`,
    [code, account.id, TOKEN_DAYS],
  );
  if (!connected) throw new HttpError(409, "This connection changed while it was being approved. Refresh and try again.", "connection_changed");
  return connected;
}

export async function startAgentConnection(clientName) {
  const secret = makeSecret();
  let code;
  for (let attempt = 0; attempt < 4; attempt++) {
    code = makeCode();
    try {
      await q(
        `insert into studio.agent_connections(request_code, secret_hash, secret_prefix, client_name, expires_at)
         values ($1,$2,$3,$4,now()+($5::text || ' seconds')::interval)`,
        [code, sha256(secret), secret.slice(0, 14), cleanName(clientName), PENDING_SECONDS],
      );
      break;
    } catch (error) {
      if (error?.code !== "23505" || attempt === 3) throw error;
    }
  }
  if (config.localMode) await decideAgentConnection(await localAccount(), code, "approve");
  return {
    status: config.localMode ? "connected" : "pending",
    device_code: secret,
    verification_uri: `${config.publicOrigin}/c/${code}`,
    expires_in: PENDING_SECONDS,
    interval: 5,
    api_url: config.publicOrigin,
  };
}

export async function pollAgentConnection(deviceCode) {
  const secret = String(deviceCode || "");
  if (!/^sk_(?:foltio|studio)_/.test(secret) || secret.length < 32) throw new HttpError(400, "device_code is invalid.", "bad_device_code");
  const row = await one("select * from studio.agent_connections where secret_hash=$1", [sha256(secret)]);
  if (!row) throw new HttpError(404, "This connection request does not exist.", "unknown_connection");
  if (row.status === "pending" && new Date(row.expires_at).getTime() <= Date.now()) throw new HttpError(410, "This connection request expired.", "connection_expired");
  if (row.status === "denied") return { status: "denied" };
  if (row.status === "pending") return { status: "pending", expires_in: Math.max(0, Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000)), interval: 5 };
  return {
    status: "connected",
    access_token: secret,
    token_type: "Bearer",
    expires_at: row.token_expires_at,
    api_url: config.publicOrigin,
    mcp_url: `${config.publicOrigin}/mcp`,
    start_url: `${config.publicOrigin}/api/agent/start`,
  };
}

export async function publicAgentConnection(requestCode) {
  const row = await one(
    "select request_code, client_name, status, expires_at, token_expires_at from studio.agent_connections where request_code=$1",
    [String(requestCode || "").trim()],
  );
  if (!row) throw new HttpError(404, "This connection link does not exist.", "unknown_connection");
  const expired = row.status === "pending" && new Date(row.expires_at).getTime() <= Date.now();
  return { ...row, status: expired ? "expired" : row.status };
}
