// Durable jobs in Postgres. A job is a server object, never an MCP request: a client
// disconnecting never cancels paid work. Workers lease jobs with SKIP LOCKED.
import { q, one } from "../db.mjs";
import { id } from "../ids.mjs";

// status "waiting": a job that starts when another one finishes (a storyboard's video waits for its
// sheet); workers never claim it until something sets it to queued.
export async function enqueue({ kind, account_id, project_id, input = {}, idempotency_key = null, status = "queued" }) {
  if (idempotency_key) {
    const hit = await one("select * from studio.jobs where account_id = $1 and idempotency_key = $2", [account_id, idempotency_key]);
    if (hit) return hit;
  }
  return one(
    `insert into studio.jobs(id, kind, account_id, project_id, input, idempotency_key, status)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [id("job"), kind, account_id, project_id, input, idempotency_key, status],
  );
}

export async function claim(worker, kinds) {
  return one(
    `update studio.jobs set status='running', worker=$1, attempts=attempts+1,
       lease_until=now()+interval '90 seconds', updated_at=now()
     where id = (
       select id from studio.jobs
       where kind = any($2) and (status='queued' or (status='running' and lease_until < now() and attempts < 3))
       order by created_at for update skip locked limit 1)
     returning *`,
    [worker, kinds],
  );
}

export const heartbeat = (job, progress) =>
  q("update studio.jobs set lease_until=now()+interval '90 seconds', progress=coalesce($2,progress), updated_at=now() where id=$1 and status='running'", [job.id, progress ?? null]);
export const complete = (job, output) =>
  q("update studio.jobs set status='succeeded', output=$2, progress=1, lease_until=null, updated_at=now() where id=$1", [job.id, output]);
export const fail = (job, error) =>
  q("update studio.jobs set status='failed', error=$2, lease_until=null, updated_at=now() where id=$1", [job.id, error]);

export const getJobs = (accountId, ids) =>
  q("select id, kind, status, progress, input, output, error, created_at, updated_at, project_id from studio.jobs where account_id=$1 and id = any($2)", [accountId, ids]);

// Bounded wait: return as soon as all jobs are terminal, or after maxMs ("still running" is not a failure).
export async function waitJobs(accountId, ids, maxMs = 25_000) {
  const t0 = Date.now();
  for (;;) {
    const rows = await getJobs(accountId, ids);
    const done = rows.every((r) => ["succeeded", "failed", "cancelled"].includes(r.status));
    if (done || Date.now() - t0 >= maxMs) return { rows, done };
    await new Promise((r) => setTimeout(r, 800));
  }
}
