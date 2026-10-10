// The generation library: one model per job, chosen from the leaderboards, fal's catalog and our
// own bake-off (internal model evaluations dated 2026-10-02). Ids name the job, not the
// vendor, so a better model can replace one without changing what agents call. Prices are fal list
// prices (2026-10-02) and are used for quotes; each entry maps a canonical request onto its fal
// endpoint(s) with build().

// ElevenLabs premade voices accepted by fal (all verified 2026-10-01).
import { config } from "../config.mjs";
import { substitute } from "./raw.mjs";

export const VOICES = {
  Rachel: "calm American woman — narration",
  Aria: "expressive American woman — social, ads",
  Sarah: "soft young American woman — news, explainers",
  Laura: "upbeat young American woman — social",
  Alice: "confident British woman — news",
  Charlotte: "sultry Swedish-accented woman — characters",
  Jessica: "lively young American woman — conversational",
  Lily: "warm British woman — narration",
  Matilda: "friendly American woman — narration",
  Roger: "confident American man — social, ads",
  Charlie: "natural Australian man — conversational",
  George: "warm British man — narration, trailers",
  Callum: "intense transatlantic man — characters",
  River: "relaxed American, gender-neutral — social",
  Liam: "articulate young American man — narration",
  Will: "friendly young American man — social",
  Eric: "smooth middle-aged American man — conversational",
  Chris: "casual American man — conversational",
  Brian: "deep American man — narration, trailers",
  Daniel: "authoritative British man — news",
  Bill: "trustworthy older American man — narration",
};

const ASPECTS = ["9:16", "16:9", "1:1", "4:3", "3:4", "21:9"];
const IMG_ROLES = ["storyboard", "character", "subject", "style", "location"];
// how much H3 rewrites the prompt before generating (fal's prompt_expansion_mode)
const REWRITE = { enum: ["off", "light", "rich"], default: "light", note: "off sends your words exactly; light (default) adds detail in about a second; rich spends up to ~30 s" };
const expansion = (p) => ({ off: "disabled", rich: "quality" })[p.rewrite] || "balanced";
const by = (refs, ...roles) => refs.filter((r) => roles.includes(r.role));
const secs = (n) => Math.max(1, Number(n) || 0);

// GPT Image sizes: sides in multiples of 16, area 655,360–8,294,400 px, long edge by size tier.
function imageSize(aspect = "9:16", size = "2K") {
  const [a, b] = String(aspect).split(":").map(Number);
  const long = { "1K": 1088, "2K": 2048, "4K": 3840 }[size] || 2048;
  const r = a / b;
  let w = r >= 1 ? long : long * r,
    h = r >= 1 ? long / r : long;
  const fit = Math.min(1, Math.sqrt(8_294_400 / (w * h)));
  w = Math.max(16, Math.round((w * fit) / 16) * 16);
  h = Math.max(16, Math.round((h * fit) / 16) * 16);
  return { width: w, height: h };
}
const GPT_PRICE = { low: { "1K": 0.01, "2K": 0.012, "4K": 0.025 }, medium: { "1K": 0.02, "2K": 0.025, "4K": 0.05 }, high: { "1K": 0.055, "2K": 0.05, "4K": 0.1 }, xhigh: { "1K": 0.1, "2K": 0.1, "4K": 0.2 } };
const NB2_PRICE = { "0.5K": 0.06, "1K": 0.08, "2K": 0.12, "4K": 0.16 };
// MiniMax H3 (the original) makes clips of 5–15 s; H3 Max does what only it can: clips under 5 s, a
// first/last frame with references, 1080P (older drafts), extend and lip-sync. Dollars per second.
const H3 = { "480P": 0.05, "768P": 0.06 };
const H3_MAX = { "480P": 0.05, "768P": 0.08, "1080P": 0.16 };
const H3_MIN_S = 5;
const H3_FREE_IMAGES = 5; // reference images on the original: the first 5 free, then $0.08 each
// whether a generation goes to H3 Max rather than the original
const onMax = (p, refs = []) => (p.duration ?? 5) < H3_MIN_S || !H3[p.resolution || "768P"] || refs.some((r) => r.role === "first_frame" || r.role === "last_frame");
const OMNI = { "720p": 0.1, "1080p": 0.15, "4k": 0.3 };

export const MODELS = {
  // ---------------- video ----------------
  video: {
    kind: "video",
    job: "Shots from text or a first/last frame — the default for every generated shot.",
    title: "MiniMax H3 (clips under 5 s: H3 Max; tier draft = H3 Max Turbo)",
    params: {
      duration: { type: "integer", min: 1, max: 15, default: 5, note: "5–15 s on H3; shorter clips are made with H3 Max" },
      resolution: { enum: ["480P", "768P"], default: "768P", note: "finish keepers with video/upscale (1080p/4K)" },
      aspect: { enum: ASPECTS, default: "9:16" },
      tier: { enum: ["standard", "draft"], default: "standard", note: "draft = H3 Max Turbo: half price, same prompts, weaker small text" },
      rewrite: REWRITE,
      seed: { type: "integer" },
    },
    references: { first_frame: { max: 1, media: "image" }, last_frame: { max: 1, media: "image" }, soundtrack: { max: 1, media: "audio" } },
    price: (q) => {
      const p = q.params;
      const res = p.resolution || "768P";
      if (p.tier === "draft") return H3_MAX[res] * 0.5 * secs(p.duration ?? 5);
      return (onMax(p) ? H3_MAX[res] : H3[res]) * secs(p.duration ?? 5);
    },
    notes: "Top tier on the video arenas (image-to-video with audio, text-to-video with audio), $0.06/s at 768P. Native sound. Clips are 5–15 s (shorter ones are made with H3 Max at $0.08/s); about 30–60 s to make a 5 s clip (H3 Max Turbo drafts are faster). Use video/ref for recurring characters.",
    build(q, refs) {
      const p = q.params;
      const fam = p.tier === "draft" ? "minimax/h3-max-turbo" : onMax(p) ? "minimax/h3-max" : "minimax/h3";
      const first = by(refs, "first_frame")[0],
        last = by(refs, "last_frame")[0],
        sound = by(refs, "soundtrack")[0];
      const input = { prompt: q.prompt, duration: p.duration ?? 5, resolution: p.resolution ?? "768P", prompt_expansion_mode: expansion(p), enable_safety_checker: true };
      if (p.seed !== undefined) input.seed = p.seed;
      if (sound) input.target_audio_url = sound.url;
      if (first || last) {
        if (first) input.image_url = first.url;
        if (last) input.end_image_url = last.url;
        return { endpoint: `${fam}/image-to-video`, input, ext: "mp4" };
      }
      input.aspect_ratio = p.aspect ?? "9:16";
      return { endpoint: `${fam}/text-to-video`, input, ext: "mp4" };
    },
  },
  "video/ref": {
    kind: "video",
    job: "Shots that must keep the same people, places, props or voices: reference images (character sheets), clips and voice samples.",
    title: "MiniMax H3 reference-to-video (clips under 5 s or with a first/last frame: H3 Max)",
    params: { duration: { type: "integer", min: 1, max: 15, default: 5, note: "5–15 s on H3; shorter clips are made with H3 Max" }, resolution: { enum: ["480P", "768P"], default: "768P", note: "finish keepers with video/upscale" }, aspect: { enum: ASPECTS, default: "9:16" }, rewrite: REWRITE, seed: { type: "integer" } },
    references: {
      storyboard: { max: 1, media: "image", note: "a storyboard sheet: the model follows its numbered panels in order as one sequence — tested up to 12 panels in 15 s (about 1.2 s a shot)" },
      character: { max: 9, media: "image", note: "≤9 images across storyboard/character/subject/style/location; ≤12 files in all" },
      subject: { max: 9, media: "image" },
      style: { max: 9, media: "image" },
      location: { max: 9, media: "image" },
      voice: { max: 3, media: "audio", minSeconds: 2, note: "a clean 5–7 s sample per speaker (2–15 s each, all voice references together ≤15 s); call them Audio 1… in the prompt" },
      source_video: { max: 3, media: "video", note: "2–15 s each, ≤15 s combined; costly (≈$0.13/s at 768P), so trim to the 2–3 s that matter" },
      first_frame: { max: 1, media: "image" },
      last_frame: { max: 1, media: "image" },
    },
    price(q) {
      // fal bills reference tokens beyond 4,096 per call: ≈1,824 per 9:16 image, ≈6.7k per second of
      // reference video at 768P/1080P (≈2.6k at 480P) and ≈80 per second of reference audio
      const refs = q.references || [];
      const res = q.params.resolution || "768P";
      const imgs = by(refs, ...IMG_ROLES, "first_frame", "last_frame").length;
      const vidS = by(refs, "source_video").reduce((t, r) => t + (r.seconds || 5), 0);
      const audS = by(refs, "voice").reduce((t, r) => t + (r.seconds || 7), 0);
      // the original: per second, and reference images past the first 5 at $0.08 each (fal lists no
      // charge for reference video or audio on it)
      if (!onMax(q.params, refs)) return H3[res] * secs(q.params.duration ?? 5) + Math.max(0, imgs - H3_FREE_IMAGES) * 0.08;
      const tokens = imgs * 1824 + vidS * (res === "480P" ? 2600 : 6700) + audS * 80;
      return H3_MAX[res] * secs(q.params.duration ?? 5) + Math.max(0, tokens - 4096) * (0.02 / 1000);
    },
    notes: "Refer to references as Image 1, Image 2… and Audio 1… in the order passed (or pass for:{storyboard} / cast / place from the board and Studio writes the bindings). A storyboard sheet as Image 1 plus each character's bible sheet makes a whole 15 s multi-shot sequence that follows the panels in order. With references, a first_frame is not reliably honoured: cut between sequences, or continue a take with video/extend. No draft tier: draft at 480P.",
    build(q, refs) {
      const p = q.params;
      const input = { prompt: q.prompt, duration: p.duration ?? 5, resolution: p.resolution ?? "768P", aspect_ratio: p.aspect ?? "9:16", prompt_expansion_mode: expansion(p), enable_safety_checker: true };
      if (p.seed !== undefined) input.seed = p.seed;
      const imgs = by(refs, ...IMG_ROLES);
      if (imgs.length) input.reference_image_urls = imgs.slice(0, 9).map((r) => r.url);
      const voices = by(refs, "voice");
      if (voices.length) input.reference_audio_urls = voices.slice(0, 3).map((r) => r.url);
      const vids = by(refs, "source_video");
      if (vids.length) input.reference_video_urls = vids.slice(0, 3).map((r) => r.url);
      const first = by(refs, "first_frame")[0],
        last = by(refs, "last_frame")[0];
      if (!onMax(p, refs)) return { endpoint: "minimax/h3/reference-to-video", input, ext: "mp4" };
      if (first) input.image_url = first.url;
      if (last) input.end_image_url = last.url;
      return { endpoint: "minimax/h3-max/reference-to-video", input, ext: "mp4" };
    },
  },
  "video/omni": {
    kind: "video",
    job: "The premium alternative: the most cinematic camera, the best sound-to-picture sync, several cuts inside one clip (trailers, montages). Its 1080p/4K are upscales: generate 720p and finish with video/upscale.",
    title: "Google Gemini Omni Flash 1.1",
    params: { duration: { type: "integer", min: 3, max: 10, default: 6 }, resolution: { enum: ["720p", "1080p", "4k"], default: "720p" }, aspect: { enum: ["9:16", "16:9"], default: "9:16" } },
    references: {
      first_frame: { max: 1, media: "image" },
      last_frame: { max: 1, media: "image" },
      storyboard: { max: 1, media: "image", note: "a storyboard sheet whose panels it follows" },
      character: { max: 10, media: "image", note: "≤10 images across storyboard/character/subject/style/location" },
      subject: { max: 10, media: "image" },
      style: { max: 10, media: "image" },
      location: { max: 10, media: "image" },
      source_video: { max: 3, media: "video", note: "≤3 s each" },
    },
    price: (q) => OMNI[q.params.resolution || "720p"] * secs(q.params.duration ?? 6),
    notes: "#1 on arena text-to-video and audio sync. 16:9 or 9:16 only, 3–10 s, no seed, strict moderation, ~40 s per clip. Always generates sound. It cuts between shots unless told \"one continuous shot, no cuts\". No voice references (don't use it for recurring speakers). With image references, a first_frame is ignored; a last_frame needs a first_frame.",
    build(q, refs) {
      const p = q.params;
      const input = { prompt: q.prompt, duration: p.duration ?? 6, resolution: p.resolution ?? "720p", aspect_ratio: p.aspect ?? "9:16" };
      const imgs = by(refs, ...IMG_ROLES),
        vids = by(refs, "source_video");
      if (imgs.length || vids.length) {
        if (imgs.length) input.image_urls = imgs.slice(0, 10).map((r) => r.url);
        if (vids.length) input.reference_video_urls = vids.slice(0, 3).map((r) => r.url);
        return { endpoint: "google/gemini-omni-flash/v1.1/reference-to-video", input, ext: "mp4" };
      }
      const first = by(refs, "first_frame")[0],
        last = by(refs, "last_frame")[0];
      if (first) {
        input.image_url = first.url;
        if (last) input.end_image_url = last.url;
        return { endpoint: "google/gemini-omni-flash/v1.1/image-to-video", input, ext: "mp4" };
      }
      return { endpoint: "google/gemini-omni-flash/v1.1/text-to-video", input, ext: "mp4" };
    },
  },
  "video/edit": {
    kind: "video",
    job: "Change an existing clip with words: restyle, swap or remove objects, change weather, light or wardrobe — motion and timing stay.",
    title: "Google Gemini Omni Flash 1.1 edit",
    params: { resolution: { enum: ["720p", "1080p", "4k"], default: "720p" } },
    references: { source_video: { max: 1, media: "video", required: true, maxSeconds: 10.5, note: "the clip to change, ≤10 s (trim longer clips first)" } },
    price: (q) => OMNI[q.params.resolution || "720p"] * secs(Math.min(10, by(q.references || [], "source_video")[0]?.seconds ?? 10)),
    notes: "Describe only the change (\"make it snow; keep everything else\"). Not available to users in the EEA, UK or Switzerland.",
    build(q, refs) {
      return { endpoint: "google/gemini-omni-flash/v1.1/edit", input: { prompt: q.prompt, video_url: by(refs, "source_video")[0].url, resolution: q.params.resolution ?? "720p" }, ext: "mp4" };
    },
  },
  "video/extend": {
    kind: "video",
    job: "Continue a clip: more seconds of the same shot (output \"continuation\" returns only the new part, \"extended\" the whole clip).",
    title: "MiniMax H3 Max extend",
    params: { duration: { type: "integer", min: 1, max: 15, default: 5, note: "seconds to add" }, resolution: { enum: ["480P", "768P", "1080P"], default: "768P" }, output: { enum: ["continuation", "extended"], default: "continuation" }, rewrite: { enum: ["off", "on"], default: "on", note: "let H3 rewrite the prompt using the source clip" }, seed: { type: "integer" } },
    references: { source_video: { max: 1, media: "video", required: true, minSeconds: 1.6, maxSeconds: 60 }, voice: { max: 3, media: "audio", minSeconds: 2 } },
    price: (q) => H3_MAX[q.params.resolution || "768P"] * secs(q.params.duration ?? 5),
    notes: "Only the new seconds are billed. Write what happens next in plain sentences (no timecodes), not the whole shot again. It continues the exact last frames, so it can't take image references: people may drift over long extensions.",
    build(q, refs) {
      const p = q.params;
      const input = { prompt: q.prompt, video_url: by(refs, "source_video")[0].url, duration: p.duration ?? 5, resolution: p.resolution ?? "768P", output: p.output ?? "continuation", enable_prompt_expansion: p.rewrite !== "off", enable_safety_checker: true };
      const voices = by(refs, "voice");
      if (voices.length) input.reference_audio_urls = voices.slice(0, 3).map((r) => r.url);
      if (p.seed !== undefined) input.seed = p.seed;
      return { endpoint: "minimax/h3-max/extend-video", input, ext: "mp4" };
    },
  },
  "video/talk": {
    kind: "video",
    job: "Make a still speak: a face image + a voice line (from the voice model) becomes a lip-synced talking shot. Any art style.",
    title: "MiniMax H3 Max lip-sync (image + audio)",
    params: { resolution: { enum: ["480P", "768P", "1080P"], default: "768P" }, transcribe: { type: "boolean", default: true, note: "guide mouth shapes with the words; turn off for singing" }, seed: { type: "integer" } },
    references: { first_frame: { max: 1, media: "image", required: true, note: "one frontal or 3/4 face, mouth visible" }, voice: { max: 1, media: "audio", required: true, maxSeconds: 60, note: "the line to speak" } },
    price(q) {
      const s = Math.max(5.2, secs(by(q.references || [], "voice")[0]?.seconds ?? 10)); // lines under 5 s are padded to 5.2 s
      return H3_MAX[q.params.resolution || "768P"] * s * (s > 15 ? 1.2 : 1);
    },
    notes: "A talking still: framing, light and expression stay as in the image, no camera move. The clip is as long as the audio (at least 5 s — shorter lines are padded with silence). There is no prompt. For moving shots that speak, use video/ref with a voice sample instead.",
    build(q, refs) {
      const input = { image_url: by(refs, "first_frame")[0].url, audio_url: by(refs, "voice")[0].url, resolution: q.params.resolution ?? "768P", enable_transcription: q.params.transcribe !== false, enable_safety_checker: true };
      if (q.params.seed !== undefined) input.seed = q.params.seed;
      return { endpoint: "minimax/h3-max/lip-sync/image-to-video", input, ext: "mp4" };
    },
  },
  "video/upscale": {
    kind: "video",
    job: "Finish a clip at 1080p or 4K: faithful upscaling (Topaz), e.g. 768P generations for a final export. Far cheaper than generating at 1080p.",
    title: "Topaz Video Precision",
    params: { target: { enum: ["1080p", "4k"], default: "1080p" }, fps: { type: "integer", min: 16, max: 60, note: "optional frame-rate conversion in the same pass" } },
    references: { source_video: { max: 1, media: "video", required: true } },
    price: (q) => ({ "1080p": 0.02, "4k": 0.06 })[q.params.target || "1080p"] * secs(by(q.references || [], "source_video")[0]?.seconds ?? 10) * ((q.params.fps || 30) > 30 ? 2 : 1),
    notes: "Keeps the look; does not invent detail. Use it on the shots that will be seen big.",
    build(q, refs) {
      const src = by(refs, "source_video")[0];
      const short = Math.min(src.width || 768, src.height || 1344) || 768;
      const factor = Math.max(1, Math.min(4, +((q.params.target === "4k" ? 2160 : 1080) / short).toFixed(4)));
      const input = { video_url: src.url, upscale_factor: factor, model: "Proteus", H264_output: true };
      if (q.params.fps) input.target_fps = q.params.fps;
      return { endpoint: "topaz/upscale/video/precision", input, ext: "mp4" };
    },
  },

  // ---------------- images ----------------
  image: {
    kind: "image",
    job: "Every still: keyframes and first frames, character and location sheets, product shots, covers, edits with up to 16 reference images, transparent cut-outs.",
    title: "OpenAI GPT Image 2.5 Flare (falls back to Nano Banana 2 if OpenAI refuses)",
    params: { aspect: { enum: ["9:16", "16:9", "1:1", "4:5", "3:4", "4:3", "21:9"], default: "9:16" }, size: { enum: ["1K", "2K", "4K"], default: "2K" }, quality: { enum: ["low", "medium", "high", "xhigh"], default: "high", note: "low/medium for storyboards; xhigh for covers" }, transparent: { type: "boolean", default: false }, n: { type: "integer", min: 1, max: 4, default: 1 } },
    references: { character: { max: 16, media: "image", note: "≤16 images in total; refer to them as image 1, image 2… in order" }, subject: { max: 16, media: "image" }, style: { max: 16, media: "image" }, location: { max: 16, media: "image" }, storyboard: { max: 4, media: "image", note: "an earlier storyboard sheet, for continuity" }, edit_source: { max: 1, media: "image", note: "the image to change" } },
    price(q) {
      const p = q.params;
      return ((GPT_PRICE[p.quality || "high"] || GPT_PRICE.high)[p.size || "2K"] + 0.006 * (q.references || []).length) * (p.n || 1);
    },
    fallback: "image/fast",
    notes: "#1–2 on every image board (text, photoreal, product, anime, edits). No seed. Put title text in the editor as text, not in the image.",
    build(q, refs) {
      const p = q.params;
      const input = { prompt: q.prompt, quality: p.quality || "high", num_images: p.n || 1, output_format: p.transparent ? "png" : "jpeg", background: p.transparent ? "transparent" : "auto", image_size: imageSize(p.aspect, p.size) };
      const imgs = refs.filter((r) => r.kind === "image");
      if (imgs.length) {
        const order = [...by(imgs, "edit_source"), ...imgs.filter((r) => r.role !== "edit_source")];
        return { endpoint: "openai/gpt-image-2.5/flare/edit", input: { ...input, image_urls: order.slice(0, 16).map((r) => r.url) }, ext: p.transparent ? "png" : "jpg" };
      }
      return { endpoint: "openai/gpt-image-2.5/flare/text-to-image", input, ext: p.transparent ? "png" : "jpg" };
    },
  },
  "image/fast": {
    kind: "image",
    job: "Stills when you need a seed (exact re-rolls), very wide or tall formats, or a second opinion — and the automatic fallback for image.",
    title: "Google Nano Banana 2",
    params: { aspect: { enum: ["9:16", "16:9", "1:1", "4:5", "3:4", "4:3", "2:3", "3:2", "21:9"], default: "9:16" }, resolution: { enum: ["0.5K", "1K", "2K", "4K"], default: "1K" }, n: { type: "integer", min: 1, max: 4, default: 1 }, seed: { type: "integer" } },
    references: { character: { max: 4, media: "image", note: "≤4 people + ≤10 objects/places" }, subject: { max: 10, media: "image" }, style: { max: 10, media: "image" }, location: { max: 10, media: "image" }, storyboard: { max: 2, media: "image" }, edit_source: { max: 1, media: "image" } },
    price: (q) => NB2_PRICE[q.params.resolution || "1K"] * (q.params.n || 1),
    notes: "~10 s an image, seeds, 0.5K drafts, fewer refusals than GPT Image.",
    build(q, refs) {
      const p = q.params;
      const input = { prompt: q.prompt, aspect_ratio: p.aspect ?? "9:16", resolution: p.resolution ?? "1K", num_images: p.n || 1, output_format: "png" };
      if (p.seed !== undefined) input.seed = p.seed;
      const imgs = refs.filter((r) => r.kind === "image");
      if (imgs.length) return { endpoint: "fal-ai/nano-banana-2/edit", input: { ...input, image_urls: imgs.slice(0, 14).map((r) => r.url) }, ext: "png" };
      return { endpoint: "fal-ai/nano-banana-2", input, ext: "png" };
    },
  },

  // ---------------- audio ----------------
  voice: {
    kind: "audio",
    job: "Voice-over, narration and character lines (pass text). Captions use the script's exact words.",
    title: "ElevenLabs v4",
    params: { voice: { enum: Object.keys(VOICES), default: "Rachel", descriptions: VOICES }, stability: { type: "number", min: 0, max: 1, default: 0.5 }, language: { type: "string" }, seed: { type: "integer" } },
    references: {},
    price: (q) => (Math.max(1, (q.text || q.prompt || "").length) / 1000) * 0.08,
    notes: "#1 on the speech leaderboard. Expressive tags work in the text: [whispers], [laughs], [excited], [pause].",
    build(q) {
      const p = q.params;
      return { endpoint: "elevenlabs/tts/eleven-v4", input: { text: q.text || q.prompt, voice: p.voice || "Rachel", stability: p.stability ?? 0.5, timestamps: true, output_format: "mp3_44100_192", ...(p.language ? { language_code: p.language } : {}), ...(p.seed !== undefined ? { seed: p.seed } : {}) }, ext: "mp3" };
    },
  },
  music: {
    kind: "audio",
    job: "A music bed or song (vocals or instrumental) — the best-sounding music model on fal.",
    title: "Google Lyria 3.5",
    params: {},
    references: {},
    price: () => 0.1,
    notes: "Length follows the prompt (\"a 40-second track\"); trim and fade on the timeline. For an exact length use music/exact.",
    build(q) {
      return { endpoint: "google/lyria-3.5", input: { prompt: q.prompt }, ext: "mp3" };
    },
  },
  "music/exact": {
    kind: "audio",
    job: "An instrumental bed of an exact length (1–380 s) that ends with the edit.",
    title: "Stable Audio 3 Medium",
    params: { duration: { type: "number", min: 1, max: 380, default: 30 }, seed: { type: "integer" } },
    references: {},
    price: () => 0.04,
    notes: "Instrumental only. Describe genre, tempo (BPM), instruments, mood, and how it ends.",
    build(q) {
      const p = q.params;
      return { endpoint: "fal-ai/stable-audio-3/medium/text-to-audio", input: { prompt: q.prompt, duration: p.duration ?? 30, output_format: "mp3", ...(p.seed !== undefined ? { seed: p.seed } : {}) }, ext: "mp3" };
    },
  },
  sfx: {
    kind: "audio",
    job: "Sound effects for the cut: whooshes, risers, hits, UI sounds, ambience, foley (≤22 s).",
    title: "ElevenLabs Sound Effects v2",
    params: { duration: { type: "number", min: 0.5, max: 22, default: 3 }, loop: { type: "boolean", default: false } },
    references: {},
    price: (q) => 0.002 * secs(q.params.duration ?? 3),
    notes: "Generated shots already have their own sound; use this for editorial sound design.",
    build(q) {
      const p = q.params;
      return { endpoint: "fal-ai/elevenlabs/sound-effects/v2", input: { text: q.prompt, duration_seconds: p.duration ?? 3, loop: p.loop ?? false }, ext: "mp3" };
    },
  },
  // Any allowlisted fal endpoint with its own input (gen/raw.mjs): priced when quoted (q.raw.usd, fal's
  // list price), files named by asset id become URLs when it runs. Not one of the jobs above.
  raw: {
    kind: "any",
    job: "Any allowlisted fal model with its full input — every parameter it has.",
    title: "fal endpoint (raw)",
    params: {},
    references: { raw: { max: 12, media: "any" } },
    price: (q) => Number(q.raw?.usd),
    build(q, refs) {
      const urls = Object.fromEntries(refs.map((r) => [r.asset_id, r.url]));
      return { endpoint: q.endpoint, input: substitute(q.input || {}, urls), ext: "bin" };
    },
  },
};

// Earlier ids keep working (quotes, guides and agents written before the library change).
export const ALIASES = {
  "video/h3-max": { id: "video" },
  "video/h3-turbo": { id: "video", params: { tier: "draft" } },
  "video/h3-max-ref": { id: "video/ref" },
  "image/nano-banana-2": { id: "image/fast" },
  "image/flux-schnell": { id: "image", params: { quality: "low", size: "1K" } },
  "audio/tts": { id: "voice" },
  "audio/music": { id: "music" },
  "audio/music-long": { id: "music/exact", drop: ["instrumental"] },
  "audio/sfx": { id: "sfx" },
};
export function resolveModel(modelId, params = {}) {
  const a = ALIASES[modelId];
  if (!a) return { id: modelId, params };
  const rest = { ...params };
  for (const k of a.drop || []) delete rest[k];
  return { id: a.id, params: { ...(a.params || {}), ...rest } };
}

export const STT = { endpoint: "fal-ai/elevenlabs/speech-to-text/scribe-v2", perMinute: 0.008 };

export function describe(modelId) {
  const id = resolveModel(modelId).id;
  const m = MODELS[id];
  if (!m) return null;
  const { build, price, ...rest } = m;
  return { id, ...rest, price: PRICE_LINES[id] };
}

const PRICE_LINES = {
  video: "$0.06/s at 768P, $0.05 at 480P (clips under 5 s: H3 Max, $0.08/s at 768P); tier draft $0.04/s",
  "video/ref": "$0.06/s at 768P, $0.05 at 480P; reference images: the first 5 free, then $0.08 each (clips under 5 s or with a first/last frame: H3 Max, $0.08/s + reference tokens)",
  "video/omni": "$0.10/s at 720p, $0.15/s at 1080p, $0.30/s at 4K",
  "video/edit": "$0.10/s of source at 720p",
  "video/extend": "$0.08/s of new footage at 768P",
  "video/talk": "$0.08/s of audio at 768P (×1.2 beyond 15 s)",
  "video/upscale": "$0.02/s to 1080p, $0.06/s to 4K",
  image: "≈$0.05 per 2K image at high quality; ≈$0.01 at low",
  "image/fast": "$0.06 (0.5K) / $0.08 (1K) / $0.12 (2K) / $0.16 (4K) per image",
  voice: "$0.08 per 1,000 characters",
  music: "$0.10 per track",
  "music/exact": "$0.04 per track",
  sfx: "$0.002 per second",
};

export function listModels(kind) {
  return Object.entries(MODELS)
    .filter(([id, m]) => id !== "raw" && (!kind || m.kind === kind))
    .map(([id, m]) => ({ id, kind: m.kind, job: m.job, model: m.title, price: atOurPrices(PRICE_LINES[id]), references: Object.keys(m.references), notes: atOurPrices(m.notes) }));
}

// The source strings use fal dollars; agents and people see only whole credits.
const atOurPrices = (line) => line && line.replace(/\$(\d+(?:\.\d+)?)/g, (_, n) => `${Math.max(1, Math.ceil((Number(n) * config.markup - 1e-9) * 100))} credits`);

export function priceOf(m, req) {
  if (!(m.price({ ...req, params: req.params || {} }) >= 0)) throw new Error("no price for this request");
  // Customer prices are whole credits (100 credits = $1). Round once, at quote time, so the
  // displayed price and the amount held from the balance can never differ.
  return Math.max(0.01, Math.ceil((m.price({ ...req, params: req.params || {} }) * (req.takes || 1) * config.markup - 1e-9) * 100) / 100);
}

// Check params against the catalog before quoting, so mistakes cost nothing.
export function validateParams(modelId, params = {}) {
  const m = MODELS[modelId];
  const problems = [];
  for (const [k, v] of Object.entries(params)) {
    const d = m.params[k];
    if (!d) {
      problems.push(`${k} is not a parameter of ${modelId} (it takes: ${Object.keys(m.params).join(", ") || "none — describe it in the prompt"})`);
      continue;
    }
    if (d.enum && !d.enum.includes(v)) problems.push(`${k} must be one of ${d.enum.join(", ")}${d.descriptions ? " — " + Object.entries(d.descriptions).map(([n, x]) => `${n}: ${x}`).join("; ") : ""}`);
    if (d.type === "integer" && !Number.isInteger(v)) problems.push(`${k} must be a whole number`);
    if ((d.type === "number" || d.type === "integer") && typeof v !== "number") problems.push(`${k} must be a number`);
    if (d.min !== undefined && v < d.min) problems.push(`${k} must be at least ${d.min}`);
    if (d.max !== undefined && v > d.max) problems.push(`${k} must be at most ${d.max}`);
    if (d.type === "boolean" && typeof v !== "boolean") problems.push(`${k} must be true or false`);
  }
  return problems;
}
