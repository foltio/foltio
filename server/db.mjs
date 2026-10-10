import pg from "pg";
import { config } from "./config.mjs";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30000,
  ssl: config.databaseUrl?.includes("supabase") ? { rejectUnauthorized: false } : undefined,
});
pool.on("error", (e) => console.error("pg pool error", e.message));

export async function q(text, params = []) {
  const r = await pool.query(text, params);
  return r.rows;
}
export const one = async (text, params) => (await q(text, params))[0] || null;

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const out = await fn({
      q: async (t, p = []) => (await client.query(t, p)).rows,
      one: async (t, p = []) => (await client.query(t, p)).rows[0] || null,
    });
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
