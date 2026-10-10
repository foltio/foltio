// Raw generation: the allowlist, pricing from what the input asks for, and project files as URLs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rawEntry, rawPrice, rawList, assetIdsIn, substitute, rawOutputs, kindOfFile } from "../server/gen/raw.mjs";
import { MODELS, priceOf, listModels } from "../server/gen/catalog.mjs";
import { config } from "../server/config.mjs";

test("only allowlisted endpoints are callable", () => {
  assert.equal(rawEntry("evil/thing"), null);
  assert.equal(rawEntry("minimax/h3/reference-to-video")?.kind, "video");
  assert.equal(rawEntry("fal-ai/demucs")?.kind, "audio");
  assert.ok(rawList("video").length > 100);
  assert.ok(rawList().some((x) => x.endpoint === "fal-ai/sam-audio/separate"));
  // the curated library doesn't list the raw pseudo-model
  assert.ok(!listModels().some((m) => m.id === "raw"));
});

test("video is priced per second at the asked resolution, never under-quoted", async () => {
  const e = rawEntry("minimax/h3/image-to-video"); // $0.05 480p · $0.06 768p · $0.13 2k · $0.16 4k
  assert.equal((await rawPrice(e, { duration: 10, resolution: "768P" })).usd, 0.6);
  assert.equal((await rawPrice(e, { duration: 10, resolution: "480p" })).usd, 0.5);
  // no resolution: the dearest tier
  assert.equal(+(await rawPrice(e, { duration: 5 })).usd.toFixed(4), 0.8);
  // "6s"-style durations
  const kling = rawList("video").find((x) => x.family === "Kling");
  assert.ok(kling);
});

test("our own per-call and per-30 s units; unknown lengths are refused, not guessed", async () => {
  assert.equal((await rawPrice(rawEntry("fal-ai/minimax/voice-clone"), {})).usd, 1.5);
  const sep = rawEntry("fal-ai/sam-audio/separate");
  assert.equal((await rawPrice(sep, { audio_url: "ast_aaaaaaaa" }, { ast_aaaaaaaa: { kind: "audio", seconds: 61 } })).usd, 0.15);
  await assert.rejects(() => rawPrice(sep, { audio_url: "https://x/y.mp3" }), /length of its input/);
  // an edit endpoint with no duration and no source file can't be priced
  const edit = rawList("video").map((x) => rawEntry(x.endpoint)).find((x) => !x.video.durations);
  if (edit) await assert.rejects(() => rawPrice(edit, { prompt: "x" }), /how long/);
});

test("asset ids anywhere in the input become signed URLs; text that merely mentions one is left alone", () => {
  const input = { image_url: "ast_abcdef12", refs: [{ url: "ast_ghijkl34" }], prompt: "make ast_abcdef12 dance", n: 2 };
  assert.deepEqual(assetIdsIn(input).sort(), ["ast_abcdef12", "ast_ghijkl34"]);
  const out = substitute(input, { ast_abcdef12: "https://s/1.png", ast_ghijkl34: "https://s/2.png" });
  assert.equal(out.image_url, "https://s/1.png");
  assert.equal(out.refs[0].url, "https://s/2.png");
  assert.equal(out.prompt, "make ast_abcdef12 dance");
  // the raw pseudo-model builds the endpoint call from the quote and the signed refs
  const b = MODELS.raw.build({ endpoint: "fal-ai/demucs", input: { audio_url: "ast_abcdef12" } }, [{ asset_id: "ast_abcdef12", url: "https://s/a.mp3" }]);
  assert.deepEqual(b, { endpoint: "fal-ai/demucs", input: { audio_url: "https://s/a.mp3" }, ext: "bin" });
});

test("a raw quote costs the priced amount × takes × our markup, and refuses when unpriced", () => {
  assert.equal(priceOf(MODELS.raw, { raw: { usd: 0.6 }, takes: 2 }), +(0.6 * 2 * config.markup).toFixed(4));
  assert.throws(() => priceOf(MODELS.raw, { takes: 1 }), /no price/);
});

test("raw results: every file found with what it is", () => {
  const files = rawOutputs({ vocals: { url: "https://f/v.wav", content_type: "audio/wav" }, drums: { url: "https://f/d.wav" }, timings: [1, 2] });
  assert.deepEqual(files.map((f) => f.name), ["vocals", "drums"]);
  assert.equal(kindOfFile(files[1].contentType, files[1].url), "audio");
  assert.equal(kindOfFile("", "https://x/a.mp4?sig=1"), "video");
});
