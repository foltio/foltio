// Runtime configuration. Secrets come from the environment (systemd EnvironmentFile on the
// server, .env.local in development). Nothing secret is ever sent to the browser.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const local = join(root, ".env.local");
if (existsSync(local)) {
  for (const line of readFileSync(local, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined)
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const env = process.env;
const num = (v, d) => (v === undefined || v === "" ? d : Number(v));

export const config = {
  root,
  webRoot: env.STUDIO_WEB_ROOT || join(root, "web", "dist"),
  host: env.STUDIO_HOST || "127.0.0.1",
  port: num(env.STUDIO_PORT, 8810),
  publicOrigin: env.STUDIO_PUBLIC_ORIGIN || "http://localhost:3000",
  // Local mode is the default self-hosted experience: one owner account, no OAuth, billing,
  // analytics, or hosted-agent service. Bind to localhost unless you add authentication.
  localMode: env.FOLTIO_LOCAL_MODE === "1",
  localEmail: env.FOLTIO_LOCAL_EMAIL || "owner@local.foltio",
  databaseUrl: env.STUDIO_DATABASE_URL,
  s3: {
    endpoint: env.STUDIO_S3_ENDPOINT || (env.R2_ACCOUNT_ID ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined),
    publicEndpoint: env.STUDIO_S3_PUBLIC_ENDPOINT || env.STUDIO_S3_ENDPOINT || (env.R2_ACCOUNT_ID ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined),
    region: env.STUDIO_S3_REGION || "auto",
    accessKeyId: env.STUDIO_S3_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.STUDIO_S3_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY,
    bucket: env.STUDIO_S3_BUCKET || env.STUDIO_R2_BUCKET || "foltio-media",
    forcePathStyle: env.STUDIO_S3_FORCE_PATH_STYLE === "1",
  },
  falKey: env.FAL_KEY,
  supabase: { url: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY },
  adminEmails: (env.STUDIO_ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  worker: env.STUDIO_WORKER !== "0",
  workDir: env.STUDIO_WORK_DIR || "/tmp/studio-work",
  ffmpeg: env.STUDIO_FFMPEG || "ffmpeg",
  ffprobe: env.STUDIO_FFPROBE || "ffprobe",
  melt: env.STUDIO_MELT || "melt",
  renderThreads: num(env.STUDIO_RENDER_THREADS, 12),
  workerConcurrency: num(env.STUDIO_WORKER_CONCURRENCY, 3),
  monthlyCapUsd: num(env.STUDIO_MONTHLY_CAP_USD, 150),
  perOpAutoUsd: num(env.STUDIO_PER_OP_AUTO_USD, 10),
  // Billing: prices are fal's list price × markup; a new Google/Discord account gets trialUsd once.
  // Provider cost × 4/3: a 25% gross margin before payments, storage and infrastructure.
  markup: num(env.STUDIO_MARKUP, 4 / 3),
  trialUsd: num(env.STUDIO_TRIAL_USD, 5),
  // Only the allowlist (STUDIO_ADMIN_EMAILS) may sign in while this is on.
  inviteOnly: env.STUDIO_INVITE_ONLY === "1",
  stripe: { secret: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET },
  reddit: { pixel: env.REDDIT_PIXEL_ID || null, token: env.REDDIT_CAPI_TOKEN || null },
  production: env.NODE_ENV === "production",
};
