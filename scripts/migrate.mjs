// Applies migrations/*.sql in order, once each (tracked in studio.migrations).
// Usage: node scripts/migrate.mjs  [STUDIO_DATABASE_URL from env/.env.local]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../server/config.mjs";
import { pool } from "../server/db.mjs";

const dir = join(config.root, "migrations");
const client = await pool.connect();
try {
  await client.query("create schema if not exists studio");
  await client.query(
    "create table if not exists studio.migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const done = new Set((await client.query("select name from studio.migrations")).rows.map((r) => r.name));
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    await client.query("begin");
    try {
      await client.query(readFileSync(join(dir, name), "utf8"));
      await client.query("insert into studio.migrations(name) values ($1)", [name]);
      await client.query("commit");
      console.log("applied", name);
    } catch (e) {
      await client.query("rollback");
      throw new Error(`${name}: ${e.message}`);
    }
  }
  console.log("migrations up to date");
} finally {
  client.release();
  await pool.end();
}
