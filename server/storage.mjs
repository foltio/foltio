// S3-compatible object storage. Docker Compose uses MinIO; hosted installs can use R2 or S3.
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "./config.mjs";

const client = (endpoint) => new S3Client({
  region: config.s3.region,
  endpoint,
  forcePathStyle: config.s3.forcePathStyle,
  credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
});
export const s3 = client(config.s3.endpoint);
// Presigned URLs are opened by the browser, which may reach storage at a different hostname than
// the API container (for example localhost:9000 outside Docker vs minio:9000 inside it).
const signedS3 = config.s3.publicEndpoint === config.s3.endpoint ? s3 : client(config.s3.publicEndpoint);
const Bucket = config.s3.bucket;

// Key layout: a/{account}/{project}/{asset}/{file}; renders and frames under the project.
export const keys = {
  original: (acct, prj, ast, ext) => `a/${acct}/${prj}/${ast}/original${ext ? "." + ext : ""}`,
  derived: (acct, prj, ast, file) => `a/${acct}/${prj}/${ast}/${file}`,
  render: (acct, prj, rnd, ext = "mp4") => `a/${acct}/${prj}/renders/${rnd}.${ext}`,
  frame: (acct, prj, tag, file) => `a/${acct}/${prj}/frames/${tag}/${file}`,
};

export async function presignPut(Key, ContentType, expiresIn = 6 * 3600) {
  return getSignedUrl(signedS3, new PutObjectCommand({ Bucket, Key, ContentType }), { expiresIn });
}
export async function presignGet(Key, expiresIn = 3600, filename) {
  return getSignedUrl(
    signedS3,
    new GetObjectCommand({
      Bucket,
      Key,
      ...(filename ? { ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, "")}"` } : {}),
    }),
    { expiresIn },
  );
}
export async function head(Key) {
  try {
    return await s3.send(new HeadObjectCommand({ Bucket, Key }));
  } catch (e) {
    if (e.$metadata?.httpStatusCode === 404 || e.name === "NotFound") return null;
    throw e;
  }
}
export async function putFile(Key, path, ContentType) {
  const { size } = await stat(path);
  await s3.send(
    new PutObjectCommand({ Bucket, Key, Body: createReadStream(path), ContentLength: size, ContentType }),
  );
  return { key: Key, bytes: size };
}
export async function putBuffer(Key, Body, ContentType) {
  await s3.send(new PutObjectCommand({ Bucket, Key, Body, ContentType }));
  return { key: Key, bytes: Body.length };
}
// Downloads retry, and abort if no bytes arrive for stallMs (R2 → VPS transfers occasionally stall).
export async function getToFile(Key, path, { attempts = 4, stallMs = 20_000 } = {}) {
  for (let i = 1; ; i++) {
    const ac = new AbortController();
    let timer;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ac.abort(new Error(`download stalled: ${Key}`)), stallMs);
    };
    try {
      arm();
      const r = await s3.send(new GetObjectCommand({ Bucket, Key }), { abortSignal: ac.signal });
      r.Body.on("data", arm);
      await pipeline(r.Body, createWriteStream(path), { signal: ac.signal });
      clearTimeout(timer);
      return path;
    } catch (e) {
      clearTimeout(timer);
      if (i >= attempts) throw e;
      await new Promise((res) => setTimeout(res, 1000 * i));
    }
  }
}
export async function getJson(Key) {
  const r = await s3.send(new GetObjectCommand({ Bucket, Key }));
  return JSON.parse(await r.Body.transformToString());
}
export async function getBuffer(Key) {
  const r = await s3.send(new GetObjectCommand({ Bucket, Key }));
  return Buffer.from(await r.Body.transformToByteArray());
}
export async function del(Key) {
  await s3.send(new DeleteObjectCommand({ Bucket, Key }));
}

// Every key under a prefix (for copying a project's files).
export async function list(Prefix) {
  const out = [];
  let ContinuationToken;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
    for (const o of r.Contents || []) out.push(o.Key);
    ContinuationToken = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return out;
}

// A server-side copy inside the bucket (no download).
export async function copy(from, to) {
  await s3.send(new CopyObjectCommand({ Bucket, CopySource: `${Bucket}/${from.split("/").map(encodeURIComponent).join("/")}`, Key: to }));
}
