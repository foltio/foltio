// The agent-facing surface. Few consolidated tools; breadth lives in timeline_edit's op batch.
// Results: a short text line + structuredContent; visual tools return image content only
// (Codex shows only structuredContent when present, which would hide the image).
import { join } from "node:path";
import { readFile, writeFile, stat } from "node:fs/promises";
import { HttpError } from "../auth.mjs";
import { q, one } from "../db.mjs";
import { getBuffer, getJson, presignGet, putFile, keys } from "../storage.mjs";
import { enqueue, waitJobs, getJobs } from "../jobs/queue.mjs";
import {
  createProject, listProjects, getProject, projectAssets, assetMapOf, assetView, editProject, history, followAspect,
  uploadTicket, finalizeUpload, importUrl,
} from "../projects.mjs";
import { summarize, f2s, seqDuration, itemsOn, end } from "../timeline/model.mjs";
import { OP_NAMES } from "../timeline/ops.mjs";
import { MACRO_OPS } from "../timeline/macros.mjs";
import { lint, renderQc } from "../qc.mjs";
import { latestRender, framesSheet, transcriptsFor } from "../render/render.mjs";
import { packTranscript } from "../media/transcribe.mjs";
import { listModels, describe, MODELS, validateParams, resolveModel, priceOf } from "../gen/catalog.mjs";
import { createQuote, reviseQuote, holdForQuote, budget } from "../gen/billing.mjs";
import { rawEntry, rawList, rawPrice, rawDocs, assetIdsIn } from "../gen/raw.mjs";
import { config } from "../config.mjs";
import { toCredits } from "../credits.mjs";
import { id } from "../ids.mjs";
import { ffmpeg, scratch } from "../media/ff.mjs";
import { GUIDE_TOPICS, guideText } from "./guide.mjs";
import { loadBoard, patchBoard, withPlacement, boardLines, filedEvent, setLastFrame, visionLocked } from "../board.mjs";
import { buildPreview } from "../preview.mjs";
import { composeFromBoard } from "../gen/compose.mjs";
import { recipe, voiceAssets, pacingNotes, fingerprint, outOfDate, isShot } from "../gen/recipes.mjs";
import { IMAGE_ROLES, slots } from "../gen/mentions.mjs";
import { targetOf, fillPending } from "../gen/generate.mjs";

const S = (props, required = []) => ({ type: "object", properties: props, required, additionalProperties: false });
const str = (d) => ({ type: "string", description: d });
const int = (d) => ({ type: "integer", description: d });
const timeVal = (d) => ({ description: `${d} Seconds as {"s":1.5}, frames as an integer, or "00:00:01.500".` });

const OPS_DOC = `Times: plain numbers are SECONDS everywhere (at, duration, from, to, by, in, out); frames need {"f":45}. in/out are seconds into the source clip. Ids come from project_get; "$alias" refers to items made earlier in the same batch via "as". Full reference with examples: studio_guide {topic:"ops"}.
- place {track, at, asset|color, in?, out?|duration?, visual?, audio?, speed?, as?} — at a free time.
- append {track, asset, in?, out?|duration?, gap?, as?} — after the last item (the way to assemble selects: in/out from word timings).
- insert {track, at, asset, in?, out?|duration?, ripple?:"all"|"track"} ; overwrite {track, at, asset, in?, out?|duration?}
- move {item, to?|by?, track?, onOverlap?:"overwrite"} ; reorder {item, toIndex}
- delete {items:[…], ripple?:true} ; delete_range {from, to, tracks?:"all"|[…], ripple?:true} — cut time out
- tighten {pauses_over?:0.6, keep?:0.25, fillers?:true, from?, to?} — one-op cleanup from the transcripts: shortens every pause longer than pauses_over to keep seconds and cuts um/uh, on all tracks except music (music is trimmed to the new end)
- delete_words {asset, from_word, to_word} (word ids from media_inspect "words") or {asset, from, to} (source seconds) — cut those words wherever they are on the timeline
- trim {item, edge:"start"|"end", to?|by?, ripple?:true} ; split {item, at, as?} ; slip {item, by}
- replace_media {item, asset, in?, fit?:"source_duration"} — swap a take, keeping its slot
- set {item, name?, visual?{fit:"fill"|"fit"|"stretch", bg:"black"|"blur"|"none", scale, x, y, rotation, opacity, crop{l,t,r,b}, flip}, audio?{gainDb, mute, fadeInMs, fadeOutMs, enabled}, speed?, keep?:"duration", text?, style?, color?}
  filter?/afilter? — a custom ffmpeg look on one clip's picture / sound when no setting covers it: a simple chain ("eq=contrast=1.2:saturation=0.8,vignette"; null clears). Allowlisted filters only, nothing that changes length or frame size (use visual/speed for those); LUTs as lut3d=ast_… (.cube asset). The render applies it; the editor previews a baked copy. Recipes: studio_guide {topic:"looks"}.
  Titles: style {preset, color, scale (1 = preset size), pos {x,y} (text centre, 0–1), fadeInMs, fadeOutMs}. Captions: style {preset, position, maxWords, uppercase, color, highlight}.
  Picture model (same in preview and render): fit → scale about the centre → rotate → move the centre by x·W/2, y·H/2.
  scale/x/y/opacity/gainDb may be keyframed: {"kf":[{"t":0,"v":1},{"t":90,"v":1.15,"ease":"ease_in_out"}]} (t = frames from the item start; or "s": seconds).
- add_transition {from, to, preset?:"dissolve"|"dip_black"|"dip_white", duration?} ; set_transition {id, preset?, duration?} ; remove_transition {id}
- add_title {at, duration?, text, style?{preset:"lower_third"|"center"|"top"|"big_bold"|"subtitle_box"|"end_card", color, scale, pos}, track?}
- add_captions {style?{preset:"karaoke"|"bold_pop"|"clean"|"boxed", position:"lower"|"center"|"upper", maxWords, highlight, color, uppercase}} — word-timed from transcripts; follows every edit.
- add_marker {at, label} ; remove_marker {id} ; detach_audio {item, track?} (J/L cuts) ; add_track {kind, name?, role?} ; set_track {track, enabled?, muted?, locked?, name?}
- set_mix {ducking?:{depthDb:-12}|null, loudness?{preset:"social"|"podcast"|"broadcast"}, background?} ; set_canvas {aspect?|width?+height?, fps?}
Tracks by default: trk_v1 (main picture), trk_v2 (overlays/B-roll, on top), trk_t1 (titles), trk_cap (captions), trk_a1 voice, trk_a2 music, trk_a3 sfx. Picture clips carry their own sound unless audio.enabled=false.`;

// Quick sketches and samples the built-in agent may make without a draft, when the person has let quick
// generations run on their own (accounts.quick_auto): up to EXPLORE.item each, EXPLORE.project per
// project in all (everything but video).
const EXPLORE = { item: 0.15 * config.markup, project: 3 * config.markup }; // fal list prices × our markup
// Previews: low-res drafts shown as the options of a question ("which is closest?"), so the person
// answers looks and sounds by eye and ear. The cheapest models, made without a confirm, inside a small
// per-project allowance (rolling 24 h); past it they become ordinary drafts with their price.
export const PREVIEW = { item: 0.125 * config.markup, project: 1 * config.markup, variants: [1, 4] };
export const PREVIEW_SPENT = `select coalesce(sum(cost_usd), 0) as usd from studio.quotes where project_id=$1 and request->>'preview' = 'true' and status in ('open','approved','used') and created_at > now() - interval '24 hours'`;
function previewRequest(a) {
  const want = String(a.model || "image");
  const params = a.params || {};
  if (/^music/.test(want)) return { model: "music/exact", params: { duration: Math.min(15, Math.max(5, Number(params.duration) || 10)) } };
  if (want === "sfx") return { model: "sfx", params: { duration: Math.min(6, Number(params.duration) || 3) } };
  if (!/^image/.test(want)) throw new HttpError(400, "Previews are images (looks, people, places, moments), music sketches (music) or sound effects (sfx). Video is a full generation: prepare it without preview, and it waits for their confirm with its price.", "bad_preview");
  const n = Math.max(PREVIEW.variants[0], Math.min(PREVIEW.variants[1], Number(params.n) || 3));
  return { model: "image", params: { quality: "low", size: "1K", n, ...(params.aspect ? { aspect: params.aspect } : {}) } };
}
const EXPLORE_SPENT = `select coalesce(sum(cost_usd), 0) as usd from studio.quotes where project_id=$1 and request->>'by' = 'agent' and status in ('open','approved','used') and model not like 'video%'`;

export const TOOLS = [
  {
    name: "studio_status",
    title: "Studio status and guide",
    description: "Start here. Your account, monthly budget, recent projects and how to begin. Then read studio_guide before your first edit. Free.",
    inputSchema: S({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "studio_guide",
    title: "Studio guide (playbooks)",
    description: `How to do good work here, by topic — read it before your first edit (free, instant). Topics: ${GUIDE_TOPICS.join(", ")}. Start with "workflow", then the playbook for the job (editing, short_vertical, teaser, generation, consistency…), and "review" before you finish.`,
    inputSchema: S({ topic: { type: "string", enum: [...GUIDE_TOPICS, "all"], description: "Default: overview (the topic list)." } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "project_list",
    title: "List projects",
    description: "Your projects, most recent first. Optional fuzzy name filter.",
    inputSchema: S({ query: str("Part of a project name, or an id.") }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "project_create",
    title: "Create project",
    description: "Create a cloud video project. New projects are public by default and can be made private in the editor. Canvas: an aspect preset (9:16 → 1080x1920, 16:9 → 1920x1080, 1:1 → 1080x1080, 4:5 → 1080x1350) or any width×height (144–4096 px, e.g. 3840x2160 for 4K, 1440x2560 for 2K vertical). fps 24/25/30/48/50/60 (or 23.976/29.97/59.94); default 30. Change later with the set_canvas op. Returns project_id, editor and public watch links.",
    inputSchema: S({ name: str("Project name."), aspect: { type: "string", enum: ["9:16", "16:9", "1:1", "4:5"] }, width: int("Canvas width in px (with height; overrides aspect)."), height: int("Canvas height in px."), fps: { type: "number", enum: [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60] } }, ["name"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "project_get",
    title: "Read project",
    description: "Read one section of a project. section: overview (default) | timeline (tracks/items with both clocks; detail:'full' for transforms) | media (assets with status, duration, transcript size) | history | budget. Ids returned here are what timeline_edit expects.",
    inputSchema: S({ project_id: str("prj_…"), section: { type: "string", enum: ["overview", "timeline", "media", "history", "budget"] }, detail: { type: "string", enum: ["summary", "full"] } }, ["project_id"]),
    annotations: { readOnlyHint: true },
  },
  {
    name: "media_add",
    title: "Add media",
    description: "Bring footage, audio or images into a project. (1) Local files: upload:{filename, bytes} — or a list of them — returns presigned PUT URLs and a ready shell script (curl, parallel); run it, then call media_add again with finalize:<asset_id or list>. (2) url: the server downloads a public link (no YouTube). (3) path (built-in agent): a file you made in your container — one call uploads and finalizes it; pass provenance {script|script_path, params, inputs, parent, recipe} so it can be re-baked later. (4) frame:{asset_id, at}: save one frame of a video as an image asset (keyframes, first_frame for the next generated shot, thumbnails). Ingest then runs automatically (proxy, contact sheet, filmstrip, waveform, loudness, silences, shot cuts) and speech is transcribed right after. Then job_wait {asset_ids:[…]} waits until the media and its transcript are ready.",
    inputSchema: S({
      project_id: str("prj_…"),
      upload: {
        description: "One file {filename, bytes, mime?, roles?} or a list of them. roles: optional tags such as ['broll'], ['music'], ['voiceover'].",
        anyOf: [
          S({ filename: str("File name (used for type)."), bytes: int("Size in bytes."), mime: str("Optional MIME type."), roles: { type: "array", items: { type: "string" } } }, ["filename"]),
          { type: "array", minItems: 1, maxItems: 20, items: S({ filename: str("File name."), bytes: int("Size in bytes."), mime: str("Optional MIME type."), roles: { type: "array", items: { type: "string" } } }, ["filename"]) },
        ],
      },
      finalize: { description: "Asset id (or list of ids) from the upload step, after the files have been PUT.", anyOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: 20 }] },
      path: str("Built-in agent only: a file in your container (e.g. /data/workspace/out/title.mp4). It is uploaded and finalized in one call — use this for everything you bake with a script."),
      provenance: S({
        script: str("The script's text (or give script_path and it's read for you)."),
        script_path: str("Path of the script that made it, in your container."),
        language: str("python | node | bash | html …"),
        params: { type: "object", description: "The parameters it ran with (what you'd change to re-bake it).", additionalProperties: true },
        inputs: { type: "array", items: { type: "string" }, description: "Asset ids it read." },
        parent: str("For a re-bake: the asset id this replaces (keeps the lineage)."),
        recipe: str("The skill it followed, e.g. kinetic-captions."),
        note: str("One line on what it is."),
      }, []),
      url: str("Public http(s) URL to import."),
      name: str("Display name for a URL import or a saved frame."),
      frame: S({ asset_id: str("Video asset to take the frame from."), at: { type: "number", description: "Seconds into that video (the last frame: its duration − 0.05)." } }, ["asset_id", "at"]),
    }, ["project_id"]),
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: "media_list",
    title: "List media",
    description: "Assets in a project with status, kind, duration, transcript size and generation provenance. Optional text search over names and transcripts (returns matching moments in source seconds).",
    inputSchema: S({ project_id: str("prj_…"), search: str("Words to find in transcripts or names."), include_renders: { type: "boolean" } }, ["project_id"]),
    annotations: { readOnlyHint: true },
  },
  {
    name: "media_inspect",
    title: "Inspect media",
    description: "Look at or read one source asset. view: file (the original, to work on in a script: a signed link, or with path the built-in agent gets it downloaded into its container) | transcript (packed phrase lines with timestamps; from/to to window) | words (word list with ids and times) | analysis (silences, shot cuts, loudness) | sheet (12-frame labelled contact sheet image) | poster | waveform (images). Use text views first; images at decision points.",
    inputSchema: S({ asset_id: str("ast_…"), view: { type: "string", enum: ["transcript", "words", "analysis", "sheet", "poster", "waveform", "file"] }, from: { type: "number" }, to: { type: "number" }, path: str("view file, built-in agent only: where to save it in your container (e.g. /data/workspace/in/clip.mp4); the file is downloaded there for you.") }, ["asset_id", "view"]),
    annotations: { readOnlyHint: true },
  },
  {
    name: "timeline_edit",
    title: "Edit timeline (typed ops)",
    description: `Apply a batch of typed edit ops. mode "preview" (default) validates and returns the result without saving; mode "apply" saves it as ONE undo step and needs base_revision (the current revision from project_get or the last result). All-or-nothing: on error nothing changes and the message names the failing op and the fix. Results list the timeline afterwards (item ids with start–end seconds and source ranges) plus warnings such as cuts inside words, black at the end, or titles over captions.\n${OPS_DOC}`,
    inputSchema: S({
      project_id: str("prj_…"),
      ops: { type: "array", minItems: 1, maxItems: 200, items: { type: "object", properties: { op: { type: "string", enum: [...OP_NAMES, ...MACRO_OPS] } }, required: ["op"], additionalProperties: true } },
      mode: { type: "string", enum: ["preview", "apply"] },
      base_revision: int("Required for apply."),
      label: str("Short description for history."),
    }, ["project_id", "ops"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "timeline_history",
    title: "History / undo",
    description: "list recent revisions, undo the last change, or restore any revision (restores are new revisions, so they can be undone too).",
    inputSchema: S({ project_id: str("prj_…"), action: { type: "string", enum: ["list", "undo", "restore"] }, revision: int("For restore.") }, ["project_id"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "timeline_view",
    title: "See the edit (frames)",
    description: "Composited frames of the current edit as one labelled contact sheet (timecode + clip ids visible). Renders a fast draft for the current revision first if needed (usually 5–30 s). at:\"cuts\" shows the first frame, both sides of every cut on the main track and the end — the quickest full check. Or pass times (seconds), or a range with count. You are the reviewer: look before you call anything done.",
    inputSchema: S({ project_id: str("prj_…"), at: { type: "string", enum: ["cuts"], description: "Frames either side of every cut, plus start and end." }, times: { type: "array", items: { type: "number" }, maxItems: 16 }, from: { type: "number" }, to: { type: "number" }, count: { type: "integer", minimum: 1, maximum: 16 } }, ["project_id"]),
    annotations: { readOnlyHint: true },
  },
  {
    name: "timeline_check",
    title: "Check the edit (lint / QC)",
    description: "Free instant lint: black gaps, media not ready, caption reading speed, pacing (cuts/min, longest shot), silence. With render_id: measured QC of the rendered file (black/frozen/silent spans, integrated LUFS, true peak). Numbers only — still look at frames.",
    inputSchema: S({ project_id: str("prj_…"), render_id: str("Optional ast_… of a render.") }, ["project_id"]),
    annotations: { readOnlyHint: true },
  },
  {
    name: "render",
    title: "Render",
    description: "Render the current revision. quality: draft (540p, fast, for checking) | final (full canvas, H.264/AAC, loudness-normalised). Returns job_id; then job_wait. Finished renders get a download URL and appear in the browser editor.",
    inputSchema: S({ project_id: str("prj_…"), quality: { type: "string", enum: ["draft", "final"] } }, ["project_id"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "job_wait",
    title: "Wait for jobs",
    description: "Wait up to wait_s (≤45) for jobs (ingest, transcribe, generate, render) to finish — or pass asset_ids to wait until those assets are ready to edit, transcript included. 'still running' is normal — call again. Returns outputs: new asset ids for generations, render_id + download_url for renders.",
    inputSchema: S({ job_ids: { type: "array", items: { type: "string" }, maxItems: 32 }, asset_ids: { type: "array", items: { type: "string" }, maxItems: 32, description: "Wait until these assets are ingested and transcribed (when they have speech)." }, wait_s: { type: "integer", minimum: 0, maximum: 45 } }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "board_get",
    title: "Read the board",
    description: "The project board the person sees beside the chat: the brief, the cast (people, products, props) and places with their bible sheets and voices, the look, the storyboards (each one is one video generation of up to 15 s) with their sheets and takes, and the plan. Use it for generated work; plain edits don't need it.",
    inputSchema: S({ project_id: str("prj_…") }, ["project_id"]),
    annotations: { readOnlyHint: true },
  },
  {
    name: "board_update",
    title: "Update the board",
    description: "Patch the board. Objects merge; lists merge by id (new ids are added, remove:true deletes, a field set to null is cleared; a storyboard's panels are replaced as a whole). patch: {decisions:[{id, layer (Piece|Story|People|Places|Look|Sound|Shape), label (a few words), value (the decision, in full), pinned (true: never change it unless they ask), source (you|agent), asset (ast_…: the preview they picked — it shows as the decision's thumbnail; 'more like this' keeps the same id and updates asset)}] — write every answer here the moment it is given; open:[{id, layer, label, note, important}] — what is still undecided (remove:true when resolved); beats:[{id, part (Opening, Inciting, The turn, Ending…), title (a few words), text (the beat in 1–3 sentences: what happens and what it means), status (draft | agreed)}] — the story so far, in order, shown to the person as a living outline; brief:{intent (the one-liner), about (what it's about, as a claim), ending (how it ends, or the promise/ask), where (where it plays), versions (the cuts it needs), aspect, seconds, format, goal, tone, audience, premise, must_have, avoid, budget_usd, dialogue:\"dialogue\"|\"voiceover\"|\"none\", locked:true (set once they've locked the vision; until then the built-in agent can't prepare generations for a new piece)}, look:{style, refs:[{asset_id, use}], moment (the key moment every look frame shows), options:[{id:\"A\", name, style}] (2–3 looks to choose by; frames via gen_quote {for:{look}}), chosen:\"A\" (makes it the look: its style and its frame as the style reference)}, cast:[{id:\"C1\", kind:character|product|prop, name, role, age, personality, theme, look (the locked design, reused word for word), outfit, contrast, label (exact product text), notes, voice:{voice, line (the sample line), sample:<asset>}, refs:[{asset_id, use:\"sheet\"|\"source\"}], status:proposed|ready}], places:[{id:\"L1\", name, look, time, weather, mood, light, sound, refs, status}], music:[{id:\"M1\", name, style (genre and instruments), mood (the feel and how it moves), tempo, vocals:\"instrumental\"|\"vocals\", where (where it plays in the film), reference (a direction in words), seconds, notes}], scenes:[{id, title, goal}], design:{pace:\"calm\"|\"measured\"|\"fast\"|\"rapid\" (shots per 15 s: 4–6 | 6–8 | 9–12 | 13–16), clips:\"storyboard\"|\"shots\"|\"mix\" (how clips are made by default), storyboard:{render:\"frames\"|\"sketch\"|\"ink\", sheet (the sheet's own design: paper, frame, type, colours — e.g. \"deep storm-blue board, thin white borders, condensed sans labels\"), captions:\"full\"|\"short\"|\"labels\" (short: number · time · SHOT · title; default short past 8 panels), header (a few words printed in the sheet's header as written, e.g. \"BRAND: SOL VITALS · PRODUCT: MATCHA\" — no notes or instructions)}, bibles:{kind:\"model\"|\"casting\" (an animation model sheet | a live-action casting board), detail:\"full\"|\"light\", sheet}}, storyboards:[{id:\"1\", scene, title, beat, mood (\"register, escalation\"), seconds (≤15: one generation), kind:\"sequence\"|\"shot\" (a sequence is drawn as a storyboard sheet first; a shot is one short, precise take from the anchors alone, no sheet), panels:[{t:\"0-1.2\", shot:\"wide, slow push-in\", title:\"THE BEAM\" (2–4 words), action, line:\"MARA: You came back.\" (an exchange: \"TEO: Where were you? / MARA: Out.\"; voice-over: \"MARA (V.O.): …\"), sound, note (lettered on the panel, e.g. a beat count)}] (as many as the pace wants, up to 16; t optional), cast:[\"C1\"], place:\"L1\", sound, start:\"cut\"|\"extend\" (extend continues the previous storyboard's take: no cut), style:\"frames\"|\"sketch\"|\"ink\", model, est_usd, status, note, ended}], plan:{title, logline, total_usd (an estimate), retake_usd, minutes}}. Bible sheets, voice and music samples, storyboard sheets and takes file themselves when made with gen_quote {for}. Storyboards that will play slow or rushed come back with Pacing notes. The person sees the board beside the chat and can edit any of it; the plan is a summary, not a gate.",
    inputSchema: S({ project_id: str("prj_…"), patch: { type: "object", additionalProperties: true, description: "The fields to change (see the description)." } }, ["project_id", "patch"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "board_preview",
    title: "Lay out the film so far",
    description: "Lay the film out on the timeline from the board, in story order, so the person watches it grow clip by clip: every storyboard's take once it has one; for the clips still to come, their panels (cut from the sheet, when there is one) or a title card with the beat. Nothing is generated: it's free. Rebuilding replaces exactly what the last build put there and never overwrites anything else; it refuses if other clips sit where it would go. Returns the length, what each storyboard showed as, and notes.",
    inputSchema: S({ project_id: str("prj_…") }, ["project_id"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "gen_models",
    title: "Generation models",
    description: "The generation library — one model per job: video (shots), video/ref (consistent characters), video/omni (premium cinematic), video/edit, video/extend, video/talk (lip-sync a still), video/upscale, image, image/fast, voice, music, music/exact, sfx. Prices, parameters and reference roles; pass model for the full descriptor.",
    inputSchema: S({ kind: { type: "string", enum: ["video", "image", "audio", "text"] }, model: str("e.g. video/ref"), raw: { type: "boolean", description: "List the raw allowlist: every fal endpoint you can call with its own input (gen_quote endpoint + input)." } }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "model_docs",
    title: "A model's parameters",
    description: "The input schema (every parameter, its type, range, default and description), output shape and docs page of a fal endpoint on the raw allowlist — read it before a raw gen_quote, so you use the model's full power and its exact parameter names.",
    inputSchema: S({ endpoint: str("e.g. bytedance/seedance-2.0/reference-to-video") }, ["endpoint"]),
    annotations: { readOnlyHint: true },
  },
  {
    name: "gen_quote",
    title: "Prepare a generation",
    description: "Prepare and price one generation. Nothing is spent; params, reference roles and clip lengths are checked here. Say what to make in one of three ways:\n(1) for — something on the board: {cast:\"C1\"} or {place:\"L1\"} (its bible sheet), {voice:\"C1\"} (a voice sample: the character's audio bible, which the video copies), {music:\"M1\"} (a sample of the music card, only when they want to hear the direction: the video model scores every clip from the card's words), {look:\"A\"} (a rough frame of the key moment in look A, to choose the look by), {storyboard:\"2\", make:\"sheet\"} (the storyboard sheet, drawn from the bibles), {storyboard:\"2\"} (the video: one generation of up to 15 s that follows the sheet's panels, with every sheet and voice attached). Studio writes the prompt and bindings, and the result files itself on the board. prompt then adds a direction; params and references override or add.\n(2) model + prompt + references:[{asset_id, role}] (role ∈ storyboard | character | subject | style | location | first_frame | last_frame | voice | soundtrack | source_video | edit_source; gen_models lists each model's). cast:[…] / place add those cards' sheets and bindings.\n(3) quote_id — revise a draft or quote that hasn't run: prompt, references, params, takes, model; rebuild:true rewrites it from the board.\nReturns quote_id, the exact prompt, the reference order and policy: open (run it with gen_run) | review (a draft: it waits for the person in the box under the chat; they may edit it and press Generate — don't gen_run it) | needs_approval (above the auto-approve limit) | blocked (over budget). draft:true asks for a draft even when it could run. preview:true makes a cheap low-res preview that runs without a confirm (to show as options).",
    inputSchema: S({
      project_id: str("prj_…"),
      for: {
        type: "object",
        description: "What on the board this makes: {cast} | {place} | {voice} | {music} | {look} | {storyboard, make:\"sheet\"} | {storyboard} (the video).",
        properties: { cast: { type: "string" }, place: { type: "string" }, voice: { type: "string" }, music: { type: "string" }, look: { type: "string" }, storyboard: { type: "string" }, make: { type: "string", enum: ["sheet", "video"] } },
        additionalProperties: false,
      },
      quote_id: str("Revise this draft or quote (qt_…) instead of making a new one."),
      rebuild: { type: "boolean", description: "With quote_id: rewrite the draft from the board as it is now." },
      discard: { type: "boolean", description: "With quote_id: take a draft you've replaced or no longer want out of the box." },
      endpoint: str("Raw instead of model: an allowlisted fal endpoint (gen_models {raw:true}) called with your own input. Use when a curated job can't do it — a parameter, a mode or a model it doesn't expose."),
      input: { type: "object", additionalProperties: true, description: "With endpoint: the endpoint's own input, exactly as its schema (model_docs) names it. Put project files in as their asset id (\"ast_…\" as the whole value); they become URLs when it runs." },
      model: str("A job id from gen_models: video, video/ref, video/omni, video/edit, video/extend, video/talk, video/upscale, image, image/fast, voice, music, music/exact, sfx. With for, only to switch a storyboard's video to video/omni or video."),
      prompt: str("What to make (style, subject, action, camera, light, sound). Refer to references as Image 1, Image 2… and Audio 1… in the order passed (video/omni: <IMAGE_REF_0>…). With for: an extra direction added at the end."),
      text: str("Text to speak (voice)."),
      params: { type: "object", description: "Model params (gen_models lists each model's): duration (s), resolution, aspect, rewrite, seed, tier, voice, quality, size, n…", additionalProperties: true },
      references: { type: "array", items: { type: "object", properties: { asset_id: { type: "string" }, role: { type: "string" }, seconds: { type: "number" } }, required: ["asset_id", "role"] } },
      takes: { type: "integer", minimum: 1, maximum: 4 },
      label: str("Short name for the resulting assets."),
      cast: { type: "array", items: { type: "string" }, maxItems: 6, description: "Without for: board cast ids (or names) in this generation; their bible sheets, voice samples and locked descriptions are added." },
      place: str("Without for: a board place id (or name); its sheet and description are added."),
      look: { type: "boolean", description: "Add the board's look block and look reference (default true when cast or place is given)." },
      draft: { type: "boolean", description: "Make it a draft the person reviews and generates, whatever the mode." },
      preview: { type: "boolean", description: "A cheap low-res preview to show as a question's options (no confirm, inside a small daily allowance): model image (params.n 1–4 variants of one prompt, about 2 credits each — n:1 per call for distinct looks; references for 'more like this' or a mix), music (a 10 s sketch) or sfx. Then gen_run, job_wait, and ask with each option's description ending in its asset id." },
    }, ["project_id"]),
    annotations: { readOnlyHint: true },
  },
  {
    name: "gen_run",
    title: "Run a quoted generation",
    description: "Spend: runs a quote (takes run in parallel, each with its own seed). Outputs become project assets (role 'generated') with provenance, then ingest; ones made for the board file themselves there. Failed generations are refunded. Drafts (policy review) can't be run here: the person generates them. Returns job_ids for job_wait.",
    inputSchema: S({ quote_id: str("qt_…"), idempotency_key: str("Optional; a retry with the same key never charges twice.") }, ["quote_id"]),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "share",
    title: "Links and downloads",
    description: "Get the browser editor link for a project (you can watch, scrub and approve there) and download links for renders.",
    inputSchema: S({ project_id: str("prj_…"), render_id: str("Optional render asset id.") }, ["project_id"]),
    annotations: { readOnlyHint: true },
  },
  {
    name: "item_delete",
    title: "Delete project or asset",
    description: "Delete a project or an asset (soft delete; restorable for 30 days). Clips using a deleted asset will show as media_not_ready.",
    inputSchema: S({ project_id: str("prj_… (deletes the project if asset_id is absent)"), asset_id: str("ast_…") }, ["project_id"]),
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

// Clients differ in what they show the model: Claude Code reads structuredContent, others the text.
// So the one-line summary (with any next step) goes into both.
const ok = (text, data) => ({ content: [{ type: "text", text }], structuredContent: { summary: text, ...data } });
const textOnly = (text) => ({ content: [{ type: "text", text }] });

// The timeline as compact lines: one per track, items as "id start–end source[in–out]".
function timelineLines(doc, assets, limit = 60) {
  const lines = [];
  let n = 0;
  for (const t of doc.sequence.tracks) {
    const its = itemsOn(doc, t.id);
    if (!its.length) continue;
    const parts = [];
    for (const i of its) {
      if (n++ >= limit) break;
      const span = `${f2s(doc, i.start).toFixed(2)}–${f2s(doc, end(i)).toFixed(2)}`;
      let what = i.kind;
      if (i.kind === "clip" || i.kind === "image") {
        const a = assets[i.asset];
        what = a?.name || i.asset;
        if (i.source) what += `[${(i.source.inMs / 1000).toFixed(2)}–${(i.source.inMs / 1000 + f2s(doc, i.duration) * (i.speed || 1)).toFixed(2)}]`;
        if (i.speed && i.speed !== 1) what += ` ${i.speed}×`;
      } else if (i.kind === "title") what = `title "${String(i.text).slice(0, 40)}" (${i.style?.preset || "lower_third"})`;
      else if (i.kind === "captions") what = `captions (${i.style?.preset || "karaoke"})`;
      else if (i.kind === "color") what = `colour ${i.color}`;
      parts.push(`${i.id} ${span} ${what}`);
    }
    lines.push(`${t.id}: ${parts.join(" | ")}`);
  }
  if (n > limit) lines.push(`… ${n - limit} more items (project_get section "timeline").`);
  return lines;
}
const image = (text, buf) => ({ content: [{ type: "text", text }, { type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" }] });
// What an agent looks at goes back with every later model call, so keep pictures small: at most
// 768 px on the long side as a JPEG (a full-size 2K still is 4–5× the bytes and no more useful).
async function forAgent(buf) {
  if (buf.length < 110_000) return { buf, mime: "image/jpeg" };
  try {
    return await scratch(async (dir) => {
      const src = join(dir, "in");
      const out = join(dir, "out.jpg");
      await writeFile(src, buf);
      await ffmpeg(["-y", "-i", src, "-frames:v", "1", "-vf", "scale='if(gt(iw,ih),min(768,iw),-2)':'if(gt(iw,ih),-2,min(768,ih))'", "-q:v", "5", out]);
      return { buf: await readFile(out), mime: "image/jpeg" };
    });
  } catch {
    return { buf, mime: "image/jpeg" };
  }
}
const editorUrl = (pid) => `${config.publicOrigin}/p/${pid}`;

// A name for a generation a person can read: its title, else its label, else what kind of thing it is
// and the first words of its prompt.
const MADE_AS = { video: "Video", "video/ref": "Video with references", "video/omni": "Video (Omni)", "video/edit": "Video edit", "video/extend": "Extension", "video/talk": "Talking shot", "video/upscale": "Upscale", image: "Image", "image/fast": "Image", voice: "Voice line", music: "Music", "music/exact": "Music", sfx: "Sound effect" };
export function nameOfGeneration(req) {
  if (req?.title) return req.title;
  if (req?.label) return req.label;
  const words = String(req?.prompt || req?.text || "").replace(/(Image|Audio) \d+ is[^.]*\.\s*/g, "").replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
  return `${MADE_AS[req?.model] || req?.model || "Generation"}${words ? ` · ${words.replace(/[.,;:]+$/, "")}…` : ""}`;
}

async function jobView(account, rows) {
  const out = [];
  // what each generation is, by name
  const quoteIds = [...new Set(rows.filter((j) => j.kind === "generate" && j.input?.quote_id).map((j) => j.input.quote_id))];
  const names = quoteIds.length ? Object.fromEntries((await q("select id, request from studio.quotes where id = any($1)", [quoteIds])).map((r) => [r.id, nameOfGeneration(r.request)])) : {};
  for (const j of rows) {
    const o = { job_id: j.id, kind: j.kind, status: j.status, progress: +Number(j.progress || 0).toFixed(2), ...(names[j.input?.quote_id] ? { title: names[j.input.quote_id] } : {}) };
    if (j.error) o.error = j.error.message;
    if (j.status === "succeeded" && j.output) {
      o.output = j.output;
      if (j.kind === "render" && j.output.render_id) {
        const r = await one("select storage_key, name from studio.assets where id=$1", [j.output.render_id]);
        if (r) o.download_url = await presignGet(r.storage_key, 3600, `${r.name}.mp4`);
        o.watch_url = editorUrl(j.project_id);
      }
    }
    out.push(o);
  }
  return out;
}

// What a project's generations really cost (holds minus refunds).
async function projectSpend(pid) {
  const r = await one(
    "select coalesce(sum(case when l.kind='hold' then l.amount_usd else -l.amount_usd end), 0)::float as usd from studio.ledger l join studio.quotes qt on qt.id = l.quote_id where qt.project_id = $1",
    [pid],
  );
  return +Number(r?.usd || 0).toFixed(3);
}

// Wait until assets can be edited: ingested, and transcribed when they have speech.
async function waitAssets(account, ids, budgetMs) {
  const t0 = Date.now();
  for (;;) {
    const rows = await q("select id, name, kind, status, error, probe, derived from studio.assets where account_id=$1 and id = any($2)", [account.id, ids]);
    const jobs = await q("select input->>'asset_id' as asset_id, status from studio.jobs where account_id=$1 and kind='transcribe' and input->>'asset_id' = any($2) order by created_at", [account.id, ids]);
    const tx = Object.fromEntries(jobs.map((j) => [j.asset_id, j.status]));
    const view = rows.map((r) => {
      const o = { asset_id: r.id, name: r.name, kind: r.kind, status: r.status };
      if (r.error) o.error = r.error;
      if (r.probe?.duration) o.duration_s = r.probe.duration;
      if (r.status === "ready" && r.probe?.audio) o.transcript = r.derived?.transcript ? (r.derived.transcriptWords ? `${r.derived.transcriptWords} words` : "no speech") : ["queued", "running"].includes(tx[r.id]) ? "running" : tx[r.id] === "failed" ? "failed" : "none";
      return o;
    });
    const busy = view.filter((v) => ["uploading", "processing"].includes(v.status) || v.transcript === "running");
    if (!busy.length || Date.now() - t0 > budgetMs) {
      const missing = ids.filter((x) => !rows.some((r) => r.id === x));
      return ok(busy.length ? `${busy.length} of ${ids.length} still processing — call job_wait again.` : `All ${ids.length} ready.`, { assets: view, ...(missing.length ? { unknown: missing } : {}) });
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// Save one frame of a video as an image asset (ingested like any upload). Returns the new asset.
async function saveFrame(account, projectId, assetId, atS, name) {
  const src = await one("select * from studio.assets where id=$1 and project_id=$2 and account_id=$3 and deleted_at is null", [assetId, projectId, account.id]);
  if (!src) throw new HttpError(404, `Asset ${assetId} is not in this project.`, "unknown_asset");
  if (src.kind !== "video" || src.status !== "ready") throw new HttpError(400, `${src.id} must be a ready video (it is a ${src.status} ${src.kind}).`, "bad_target");
  const at = Math.max(0, Math.min(Number(atS) || 0, (src.probe?.duration || 0) - 0.05));
  const aid = id("ast");
  const key = keys.original(account.id, projectId, aid, "jpg");
  await scratch(async (dir) => {
    const out = `${dir}/frame.jpg`;
    const url = await presignGet(src.derived?.mezzanine || src.storage_key, 600);
    // seeking to the very end yields no frame: take the last one from a short tail instead
    const tail = ["-y", "-sseof", "-0.6", "-i", url, "-update", "1", "-q:v", "2", out];
    if ((src.probe?.duration || 0) - at < 0.3) await ffmpeg(tail, { timeoutMs: 60_000 });
    else {
      await ffmpeg(["-y", "-ss", String(at), "-i", url, "-frames:v", "1", "-q:v", "2", out], { timeoutMs: 60_000 });
      if (!(await stat(out).catch(() => null))) await ffmpeg(tail, { timeoutMs: 60_000 });
    }
    await putFile(key, out, "image/jpeg");
  });
  const label = String(name || `${src.name} @ ${at.toFixed(2)}s`).slice(0, 160);
  await q(
    `insert into studio.assets(id, project_id, account_id, kind, roles, name, mime, status, origin, storage_key) values ($1,$2,$3,'image',$4,$5,'image/jpeg','processing',$6,$7)`,
    [aid, projectId, account.id, ["frame"], label, { kind: "frame", from: src.id, at }, key],
  );
  const job = await enqueue({ kind: "ingest", account_id: account.id, project_id: projectId, input: { asset_id: aid } });
  return { aid, job, src, at };
}

// Before drawing a storyboard's sheet: the last frame of the take the storyboard before it ended on
// (the one on the timeline, else the newest), saved once per take and filed on that storyboard.
async function ensureLastFrame(account, p, board, sbId) {
  const i = board.storyboards.findIndex((x) => x.id === String(sbId));
  const prev = i > 0 ? board.storyboards[i - 1] : null;
  const take = prev && (prev.pick || (prev.takes || []).slice(-1)[0]);
  if (!take || prev.last_from === take) return false;
  const src = await one("select status, probe from studio.assets where id=$1 and project_id=$2", [take, p.id]);
  if (!src || src.status !== "ready") return false;
  const { aid } = await saveFrame(account, p.id, take, (src.probe?.duration || 0) - 0.05, `Storyboard ${prev.id} · last frame`);
  for (let k = 0; k < 40; k++) {
    const a = await one("select status from studio.assets where id=$1", [aid]);
    if (a?.status === "ready") break;
    if (a?.status === "failed") return false;
    await new Promise((r) => setTimeout(r, 750));
  }
  await setLastFrame(p.id, prev.id, take, aid);
  return true;
}

// The anchors a storyboard is drawn from that aren't made yet: a cast or place sheet that's still a
// draft, or still being generated. A storyboard prepared before they land would be drawn without them.
async function pendingAnchors(projectId, board, sbId) {
  const sb = board.storyboards.find((x) => x.id === String(sbId));
  if (!sb) return [];
  const hasSheet = (card) => (card?.refs || []).some((r) => r.use === "sheet");
  const need = [...(sb.cast || []).map((id) => ["cast", board.cast.find((c) => c.id === id)]), ...(sb.place ? [["place", board.places.find((c) => c.id === sb.place)]] : [])].filter(([, card]) => card && !hasSheet(card));
  const out = [];
  for (const [key, card] of need) {
    const d = await one(
      `select id, status, request->>'title' as title from studio.quotes where project_id=$1 and status in ('review','needs_approval','open','approved','used')
         and request->'for'->>$2 = $3 order by created_at desc limit 1`,
      [projectId, key, card.id],
    );
    if (!d) continue;
    if (d.status === "used") {
      const jobs = await q("select status from studio.jobs where kind='generate' and input->>'quote_id' = $1", [d.id]);
      if (!jobs.some((j) => ["queued", "running", "waiting"].includes(j.status))) continue;
    }
    out.push({ name: card.name || card.id, quote: d.id, title: d.title, making: d.status === "used" });
  }
  return out;
}

// A storyboard video can be prepared while its sheet is still a draft or being made: it names that
// sheet's quote, and waits for it when it runs.
async function pendingSheetFor(projectId, sbId) {
  const d = await one(
    `select id, status from studio.quotes where project_id=$1 and status in ('review','open','needs_approval','approved','used')
       and request->'for'->>'storyboard' = $2 and request->'for'->>'make' = 'sheet' order by created_at desc limit 1`,
    [projectId, String(sbId)],
  );
  if (!d) return null;
  if (d.status !== "used") return d.id;
  const jobs = await q("select status from studio.jobs where kind='generate' and input->>'quote_id' = $1", [d.id]);
  return jobs.some((j) => ["queued", "running", "waiting"].includes(j.status)) ? d.id : null;
}

// ---------------------------------------------------------------- generation helpers

const NEEDS_PROMPT = (modelId) => !["video/talk", "video/upscale", "voice"].includes(modelId);
const ASPECT_RATIOS = [["16:9", 16 / 9], ["9:16", 9 / 16], ["1:1", 1], ["4:3", 4 / 3], ["3:4", 3 / 4], ["21:9", 21 / 9]];
const aspectOf = (doc) => {
  const w = doc?.settings?.width, h = doc?.settings?.height;
  if (!w || !h) return "16:9";
  return ASPECT_RATIOS.slice().sort((x, y) => Math.abs(x[1] - w / h) - Math.abs(y[1] - w / h))[0][0];
};
async function durationsOf(projectId, ids) {
  if (!ids.length) return {};
  const rows = await q("select id, probe from studio.assets where project_id=$1 and id = any($2)", [projectId, ids]);
  return Object.fromEntries(rows.map((r) => [r.id, r.probe?.duration || 0]));
}
async function namesOf(projectId, refs) {
  const ids = [...new Set(refs.map((r) => r.asset_id))];
  if (!ids.length) return {};
  const rows = await q("select id, name from studio.assets where project_id=$1 and id = any($2)", [projectId, ids]);
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

// References: right roles, right kind of media, within each model's limits — checked now, for free.
async function checkRefs(projectId, modelId, references, { fromBoard = false } = {}) {
  const m = MODELS[modelId];
  const refs = [];
  const counts = {};
  for (const r of references || []) {
    if (!r || typeof r.asset_id !== "string") throw new HttpError(400, "Each reference needs asset_id and role.", "bad_reference");
    const spec = m.references[r.role];
    if (!spec) throw new HttpError(400, `Role ${r.role} is not accepted by ${modelId}; it takes: ${Object.keys(m.references).join(", ") || "no references"}.`, "bad_reference_role", { roles: m.references });
    // a sheet still being made: it is checked when it lands
    if (r.asset_id.startsWith("pending:")) {
      counts[r.role] = (counts[r.role] || 0) + 1;
      refs.push({ asset_id: r.asset_id, role: r.role });
      continue;
    }
    const x = await one("select id, kind, status, probe, name from studio.assets where id=$1 and project_id=$2 and deleted_at is null", [r.asset_id, projectId]);
    if (!x) throw new HttpError(fromBoard ? 400 : 404, fromBoard ? `The board points at ${r.asset_id}, which is gone from this project. Update the card with board_update.` : `Reference ${r.asset_id} is not in this project.`, "unknown_asset");
    if (x.status !== "ready") throw new HttpError(409, `Reference ${r.asset_id} (${x.name}) is ${x.status}; job_wait {asset_ids:["${r.asset_id}"]} first.`, "asset_not_ready");
    const okKind = x.kind === spec.media || (spec.media === "image" && x.kind === "video" && r.role !== "source_video");
    if (!okKind) throw new HttpError(400, `Role ${r.role} needs ${spec.media === "audio" ? "an audio" : `a ${spec.media}`} asset; ${x.id} (${x.name}) is ${x.kind}.`, "bad_reference_media");
    const seconds = x.probe?.duration;
    if (spec.maxSeconds && seconds > spec.maxSeconds) throw new HttpError(400, `${x.name} is ${seconds.toFixed(1)} s; ${modelId} takes at most ${Math.floor(spec.maxSeconds)} s for ${r.role}. Cut the part you want onto a timeline, render it, and pass the render's asset id.`, "reference_too_long");
    if (spec.minSeconds && seconds < spec.minSeconds) throw new HttpError(400, `${x.name} is ${seconds.toFixed(1)} s; ${modelId} needs at least ${spec.minSeconds} s for ${r.role}.`, "reference_too_short");
    counts[r.role] = (counts[r.role] || 0) + 1;
    if (counts[r.role] > spec.max) throw new HttpError(400, `${modelId} takes at most ${spec.max} ${r.role} reference${spec.max > 1 ? "s" : ""}.`, "too_many_references");
    refs.push({ asset_id: r.asset_id, role: r.role, ...(seconds ? { seconds: +seconds.toFixed(2) } : {}) });
  }
  if (modelId === "video/ref" || modelId === "video/omni") {
    const cap = modelId === "video/ref" ? 9 : 10;
    const imgs = refs.filter((r) => IMAGE_ROLES.includes(r.role)).length;
    if (imgs > cap) throw new HttpError(400, `${modelId} takes at most ${cap} reference images in all (storyboard, characters, subjects, style and places together); this has ${imgs}.`, "too_many_references");
  }
  if (modelId === "video/ref") {
    if (refs.filter((r) => r.role !== "first_frame" && r.role !== "last_frame").length > 12) throw new HttpError(400, "video/ref takes at most 12 reference files (images, voices and clips together).", "too_many_references");
    for (const role of ["voice", "source_video"]) {
      const total = refs.filter((r) => r.role === role).reduce((t, r) => t + (r.seconds || 0), 0);
      if (total > 15.5) throw new HttpError(400, `${role === "voice" ? "Voice references" : "Reference clips"} for video/ref must be 15 s or less together; these are ${total.toFixed(1)} s. Trim them (5–7 s per voice).`, "references_too_long");
    }
  }
  return refs;
}

// The canonical request for a model: params checked, required references and prompt present.
function finishRequest(modelId, r) {
  const m = MODELS[modelId];
  const params = Object.fromEntries(Object.entries(r.params || {}).filter(([k, v]) => v !== null && v !== undefined && m.params[k]));
  const dropped = Object.keys(r.params || {}).filter((k) => r.params[k] !== null && r.params[k] !== undefined && !m.params[k]);
  const problems = validateParams(modelId, params);
  if (problems.length) throw new HttpError(400, `Fix the params for ${modelId}: ${problems.join("; ")}.`, "bad_params", { params: m.params });
  for (const [role, spec] of Object.entries(m.references)) if (spec.required && !(r.references || []).some((x) => x.role === role)) throw new HttpError(400, `${modelId} needs a ${role} reference (${spec.note || spec.media}).`, "missing_reference");
  if (NEEDS_PROMPT(modelId) && !String(r.prompt || "").trim()) throw new HttpError(400, "prompt is required.", "bad_request");
  if (modelId === "voice" && !String(r.text || r.prompt || "").trim()) throw new HttpError(400, "text is required for voice.", "bad_request");
  return {
    model: modelId,
    prompt: modelId === "voice" ? undefined : r.prompt,
    text: modelId === "voice" ? r.text || r.prompt : r.text,
    params,
    references: r.references || [],
    takes: Math.max(1, Math.min(4, Number(r.takes) || 1)),
    ...(r.label ? { label: String(r.label).slice(0, 80) } : {}),
    ...(r.title ? { title: String(r.title).slice(0, 120) } : {}),
    ...(r.for ? { for: r.for } : {}),
    ...(r.fp ? { fp: r.fp } : {}),
    ...(r.by ? { by: r.by } : {}),
    ...(r.preview ? { preview: true } : {}),
    ...(r.after && (r.references || []).some((x) => x.asset_id === `pending:${r.after}`) ? { after: r.after } : {}),
    ...(dropped.length ? { dropped } : {}),
  };
}

// How the prompt refers to each file ("Image 2 — Ines · bible").
function referenceOrder(modelId, refs, names) {
  const sl = slots(modelId, refs);
  return refs.map((r, i) => ({ n: i + 1, ...(sl.find((x) => x.i === i) ? { label: sl.find((x) => x.i === i).label } : {}), role: r.role, asset_id: r.asset_id, name: names[r.asset_id] || null }));
}

function quoteResult(r, req, order, warnings, note) {
  const what = req.title || req.model;
  const line =
    r.policy === "review" ? `Draft ${r.quote_id} — ${what}: ${r.cost_credits} credits. It waits for the person in the box under the chat, with the exact prompt and references; they may edit it and press Generate, and you'll get a "[Generated]" message. Don't gen_run it.` :
    r.policy === "open" ? `Quote ${r.quote_id} for ${what}: ${r.cost_credits} credits. Run it with gen_run.` :
    r.policy === "needs_approval" ? `Quote ${r.quote_id}: ${r.cost_credits} credits — above their auto-approve limit. In the built-in chat it waits for them in the box under the chat, and you'll get a "[Generated]" message when they run it; otherwise ask them to approve at ${r.approve_url}, then gen_run.` :
    `Over budget: ${r.cost_credits} credits needed, ${r.budget.remainingCredits} left this month.`;
  const all = [...(r.warnings || []), ...warnings, ...(req.dropped?.length ? [`${req.model} doesn't take ${req.dropped.join(", ")}; left out.`] : [])];
  return ok(all.length ? `${line} ${all.join(" ")}` : line, {
    ...r,
    title: req.title || null,
    ...(req.for ? { for: req.for } : {}),
    ...(req.for?.storyboard ? { storyboard: String(req.for.storyboard) } : {}),
    prompt: (req.prompt || req.text || "").slice(0, 4000),
    params: req.params,
    takes: req.takes,
    reference_order: order,
    ...(all.length ? { warnings: all } : {}),
    ...(note ? { note } : {}),
  });
}

// A raw request: an allowlisted fal endpoint with its own input, priced from what it asks for.
async function rawRequest(p, a, base = {}, actor = "agent") {
  const entry = rawEntry(a.endpoint ?? base.endpoint);
  if (!entry) throw new HttpError(400, `${a.endpoint ?? base.endpoint} isn't on the raw allowlist. gen_models {raw:true} lists the endpoints you can call.`, "unknown_endpoint");
  const input = a.input ?? base.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "input must be an object: the endpoint's own parameters (model_docs shows them).", "bad_request");
  const media = {};
  for (const aid of assetIdsIn(input)) {
    const x = await one("select id, kind, status, probe, name from studio.assets where id=$1 and project_id=$2 and deleted_at is null", [aid, p.id]);
    if (!x) throw new HttpError(404, `${aid} is not in this project.`, "unknown_asset");
    if (x.status !== "ready") throw new HttpError(409, `${aid} (${x.name}) is ${x.status}; job_wait {asset_ids:["${aid}"]} first.`, "asset_not_ready");
    media[aid] = { kind: x.kind, seconds: x.probe?.duration || null };
  }
  let price;
  try {
    price = await rawPrice(entry, input, media);
  } catch (e) {
    throw new HttpError(400, `Can't price this request, so it isn't quoted: ${e.message}.`, "unpriced");
  }
  const words = String(input.prompt || input.text || "").trim();
  const short = entry.endpoint.split("/").slice(-2).join(" ");
  const key = Object.fromEntries(
    Object.entries({ duration: input.duration ?? input.duration_seconds, resolution: input.resolution, aspect: input.aspect_ratio ?? input.aspect, voice: input.voice ?? input.voice_id }).filter(([, v]) => v !== undefined && v !== null),
  );
  return {
    model: "raw",
    endpoint: entry.endpoint,
    kind: entry.kind,
    input,
    prompt: words || undefined,
    params: key,
    references: Object.keys(media).map((asset_id) => ({ asset_id, role: "raw", ...(media[asset_id].seconds ? { seconds: media[asset_id].seconds } : {}) })),
    raw: { usd: +price.usd.toFixed(4), basis: price.basis },
    takes: Math.max(1, Math.min(4, Number(a.takes ?? base.takes) || 1)),
    ...((a.label ?? base.label) ? { label: String(a.label ?? base.label).slice(0, 80) } : {}),
    title: String(a.title || base.title || `${short}${words ? ` · ${words.split(/\s+/).slice(0, 6).join(" ")}` : ""}`).slice(0, 120),
    by: base.by || actor,
  };
}

// Revise a draft (or a quote that hasn't run): the person's edits from the panel, or the director's.
async function reviseDraft(account, p, a, actor, getBoard) {
  const cur = await one("select * from studio.quotes where id=$1 and account_id=$2 and project_id=$3", [a.quote_id, account.id, p.id]);
  if (!cur) throw new HttpError(404, `No quote ${a.quote_id} in this project.`, "unknown_quote");
  if (cur.request.model === "raw") {
    // the panel edits the words; the director can change any of the input
    const input = { ...cur.request.input, ...(a.input || {}) };
    if (a.prompt !== undefined) input[input.text !== undefined && input.prompt === undefined ? "text" : "prompt"] = a.prompt;
    if (a.text !== undefined) input.text = a.text;
    const req = await rawRequest(p, { ...a, endpoint: a.endpoint || cur.request.endpoint, input }, cur.request, actor);
    const r = await reviseQuote(account, cur.id, req, { by: actor });
    return quoteResult(r, req, [], [`Priced as ${req.raw.basis} (fal list price × our markup).`], null);
  }
  const base = { ...cur.request };
  let next = { ...base };
  const warnings = [];
  if (a.rebuild) {
    if (!base.for) throw new HttpError(400, "This generation wasn't made from the board, so there is nothing to rebuild it from.", "bad_request");
    const b = await getBoard();
    const spec = { ...base.for, ...(base.for.storyboard && base.for.make !== "sheet" ? { model: base.model } : {}) };
    let after = base.for.storyboard && base.for.make !== "sheet" ? await pendingSheetFor(p.id, base.for.storyboard) : null;
    const made = recipe(b, spec, { durations: await durationsOf(p.id, voiceAssets(b, spec)), aspect: aspectOf(p.doc), ...(after ? { pendingSheet: `pending:${after}` } : {}) });
    if (after && !made.references.some((r) => r.asset_id === `pending:${after}`)) after = null;
    next = { ...next, model: made.model, prompt: made.prompt, text: made.text, params: { ...made.params, ...(base.model === made.model ? pick(base.params, ["resolution", "seed", "rewrite", "tier"]) : {}) }, references: made.references, title: made.title, fp: fingerprint(b, base.for), after: after || undefined };
    warnings.push(...made.warnings);
  }
  if (a.model) {
    const id = resolveModel(a.model).id;
    if (!MODELS[id]) throw new HttpError(400, `Unknown model ${a.model}.`, "unknown_model");
    if (MODELS[id].kind !== MODELS[next.model].kind) throw new HttpError(400, `A draft can switch between models of the same kind (${MODELS[next.model].kind}); make a new one for ${id}.`, "bad_model");
    next.model = id;
  }
  if (a.prompt !== undefined) next.prompt = a.prompt;
  if (a.text !== undefined) next.text = a.text;
  if (a.params) next.params = { ...(next.params || {}), ...a.params };
  if (a.references) next.references = a.references;
  if (a.takes) next.takes = a.takes;
  if (a.label) next.label = a.label;
  const refs = await checkRefs(p.id, next.model, next.references);
  const req = finishRequest(next.model, { ...next, references: refs, by: base.by || actor, after: next.after });
  const r = await reviseQuote(account, cur.id, req, { by: actor });
  return quoteResult(r, req, referenceOrder(req.model, req.references, await namesOf(p.id, req.references)), warnings, null);
}
const pick = (o, keys) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => keys.includes(k)));

export async function refreshDraft(account, quoteId) {
  const qt = await one("select id, project_id, status, request, edited_by from studio.quotes where id=$1 and account_id=$2", [quoteId, account.id]);
  const req = qt?.request;
  if (!qt || !["review", "needs_approval"].includes(qt.status) || !req?.for || !req.fp || qt.edited_by === "human") return false;
  const p = await getProject(account, qt.project_id);
  const now = fingerprint(withPlacement((await loadBoard(p.id)).board, p.doc), req.for);
  if (!now || now === req.fp) return false;
  await HANDLERS.gen_quote(account, { project_id: p.id, quote_id: qt.id, rebuild: true }, { actor: "agent" });
  return true;
}

export const HANDLERS = {
  async studio_status(account) {
    const b = await budget(account);
    const projects = await listProjects(account);
    const data = {
      account: account.email,
      budget: b,
      editor: config.publicOrigin,
      projects: projects.slice(0, 8).map((p) => ({ id: p.id, name: p.name, revision: p.revision, updated: p.updated_at })),
      workflow: [
        "project_create (or project_list)",
        "media_add upload → run curl → media_add finalize → job_wait (ingest + transcript)",
        "media_inspect transcript/analysis/sheet to understand footage (text first)",
        "gen_models → gen_quote → gen_run → job_wait for generated shots, voice, music, sfx",
        "timeline_edit (preview, then apply with base_revision); add_captions, add_title, set_mix",
        "timeline_view to look; timeline_check for numbers; fix; repeat (≤3 passes)",
        "render final → job_wait → timeline_check with render_id → share",
      ],
      start_here: "Read studio_guide {topic:\"workflow\"} and the playbook for this job before editing. Times are seconds; in/out are source seconds.",
      guide_topics: GUIDE_TOPICS,
      ops: OP_NAMES,
      models: Object.keys(MODELS),
    };
    return ok(`Signed in as ${account.email}. Budget: ${b.spentThisMonthCredits} of ${b.monthlyCapCredits} credits used this month. ${projects.length} projects. Editor: ${config.publicOrigin}`, data);
  },

  async studio_guide(account, a) {
    return textOnly(guideText(a.topic || "overview"));
  },

  async project_list(account, a) {
    const rows = await listProjects(account, a.query);
    return ok(`${rows.length} projects.`, { projects: rows.map((p) => ({ id: p.id, name: p.name, revision: p.revision, assets: p.assets, updated: p.updated_at, visibility: p.public ? "public" : "private", editor: editorUrl(p.id), ...(p.public ? { watch: `${config.publicOrigin}/v/${p.id}` } : {}) })) });
  },

  async project_create(account, a) {
    const p = await createProject(account, a);
    return ok(`Created ${p.id} (${p.canvas}). Editor: ${editorUrl(p.id)}`, { ...p, project_id: p.id, visibility: p.public ? "public" : "private", editor: editorUrl(p.id), ...(p.public ? { watch: `${config.publicOrigin}/v/${p.id}` } : {}), next: "Share the editor link, then use media_add to bring footage in or gen_quote to generate." });
  },

  async project_get(account, a) {
    const p = await getProject(account, a.project_id);
    const assetsRows = await projectAssets(p.id);
    const assets = assetMapOf(assetsRows);
    const section = a.section || "overview";
    if (section === "timeline") {
      const s = summarize(p.doc, assets, { detail: a.detail });
      return ok(`${p.name} r${p.revision}: ${s.duration.s}s, ${Object.keys(p.doc.sequence.items).length} items.`, { project_id: p.id, revision: p.revision, ...s });
    }
    if (section === "media") return ok(`${assetsRows.length} assets.`, { project_id: p.id, assets: assetsRows.map(assetView) });
    if (section === "history") return ok("History.", await history(account, p.id, { action: "list" }));
    if (section === "budget") {
      const spent = await projectSpend(p.id);
      const accountBudget = await budget(account);
      return ok(`This project has spent ${toCredits(spent)} credits on generation. Account: ${accountBudget.spentThisMonthCredits} credits used this month.`, { project_spent_usd: spent, project_spent_credits: toCredits(spent), account: accountBudget });
    }
    const s = summarize(p.doc, assets);
    const jobs = await q("select id, kind, status, progress from studio.jobs where project_id=$1 and status in ('queued','running') order by created_at desc limit 10", [p.id]);
    const renders = await q("select id, name, origin, created_at from studio.assets where project_id=$1 and 'render' = any(roles) and deleted_at is null order by created_at desc limit 3", [p.id]);
    const spent = await projectSpend(p.id);
    return ok(`${p.name} (r${p.revision}) ${s.canvas}, ${s.duration.s}s, ${assetsRows.length} assets, ${toCredits(spent)} credits spent on generation.`, {
      project_id: p.id, name: p.name, revision: p.revision, canvas: s.canvas, duration_s: s.duration.s, spent_usd: spent, spent_credits: toCredits(spent),
      tracks: s.tracks.map((t) => ({ track: t.track, kind: t.kind, name: t.name, items: t.items.length })),
      assets: assetsRows.map((x) => ({ id: x.id, kind: x.kind, name: x.name, status: x.status, duration_s: x.probe?.duration })),
      active_jobs: jobs, recent_renders: renders.map((r) => ({ id: r.id, quality: r.origin.quality, revision: r.origin.revision, at: r.created_at })),
      editor: editorUrl(p.id),
    });
  },

  async media_add(account, a) {
    if (a.path && !a.upload) throw new HttpError(400, "path works only inside Studio's built-in agent (its container uploads the file). From elsewhere use upload:{filename, bytes} and run the returned curl.", "path_unsupported");
    if (a.finalize) {
      const ids = Array.isArray(a.finalize) ? a.finalize : [a.finalize];
      const rs = [];
      for (const aid of ids) rs.push(await finalizeUpload(account, a.project_id, aid));
      const next = `job_wait {"asset_ids":${JSON.stringify(rs.map((r) => r.asset_id))}} waits until ingest and transcripts are done.`;
      return ok(`Ingesting ${rs.map((r) => r.asset_id).join(", ")}. ${next}`, { assets: rs.map(({ next: _n, ...r }) => r), next });
    }
    if (a.upload) {
      const files = Array.isArray(a.upload) ? a.upload : [a.upload];
      const tickets = [];
      for (const f of files) tickets.push(await uploadTicket(account, a.project_id, { ...f, provenance: f.provenance || a.provenance }));
      const script = tickets.length === 1 ? tickets[0].upload.curl : `${tickets.map((t) => `${t.upload.curl} &`).join("\n")}\nwait`;
      const next = `media_add {"project_id":"${a.project_id}","finalize":${JSON.stringify(tickets.length === 1 ? tickets[0].asset_id : tickets.map((t) => t.asset_id))}}`;
      return ok(`${tickets.length} upload slot${tickets.length > 1 ? "s" : ""}. Run this from the folder with the files:\n${script}\nThen: ${next}`, {
        uploads: tickets.map((t) => ({ asset_id: t.asset_id, url: t.upload.url, headers: t.upload.headers, expires_in_s: t.upload.expires_in_s })),
        script,
        next,
      });
    }
    if (a.frame) {
      const { aid, job, src, at } = await saveFrame(account, a.project_id, a.frame.asset_id, a.frame.at, a.name);
      return ok(`Saved the frame at ${at.toFixed(2)} s of ${src.name} as ${aid}. job_wait {"asset_ids":["${aid}"]} then use it (e.g. as a first_frame reference).`, { asset_id: aid, job_id: job.id, from: src.id, at });
    }
    if (a.url) {
      const r = await importUrl(account, a.project_id, a);
      return ok(`Imported as ${r.asset_id}; ingest job ${r.job_id}.`, r);
    }
    throw new HttpError(400, "Pass upload:{filename,bytes}, finalize:<asset_id>, or url.", "bad_request");
  },

  async media_list(account, a) {
    const p = await getProject(account, a.project_id);
    const rows = await projectAssets(p.id, { includeRenders: a.include_renders });
    const data = { project_id: p.id, assets: rows.map(assetView) };
    if (a.search) {
      const needle = a.search.toLowerCase();
      const hits = [];
      for (const x of rows) {
        if (x.name.toLowerCase().includes(needle)) hits.push({ asset_id: x.id, match: "name" });
        if (!x.derived?.transcript) continue;
        const t = await getJson(x.derived.transcript).catch(() => null);
        const words = t?.words || [];
        const parts = needle.split(/\s+/);
        for (let i = 0; i < words.length; i++) {
          if (parts.every((w, k) => (words[i + k]?.w || "").toLowerCase().replace(/[^\p{L}\p{N}']/gu, "").startsWith(w.replace(/[^\p{L}\p{N}']/gu, "")))) {
            hits.push({ asset_id: x.id, at_s: words[i].s, to_s: words[i + parts.length - 1].e, context: words.slice(Math.max(0, i - 6), i + parts.length + 6).map((w) => w.w).join(" ") });
            if (hits.length > 40) break;
          }
        }
      }
      data.matches = hits;
    }
    return ok(`${rows.length} assets${a.search ? `, ${data.matches.length} matches` : ""}.`, data);
  },

  async media_inspect(account, a) {
    const x = await one("select * from studio.assets where id=$1 and account_id=$2", [a.asset_id, account.id]);
    if (!x) throw new HttpError(404, "Asset not found.", "unknown_asset");
    const view = a.view;
    // the file itself, to work on in a script: a signed link (the built-in agent's container downloads it
    // to path) — available as soon as it's uploaded, before ingest finishes
    if (view === "file" && x.status !== "uploading" && x.status !== "failed") {
      const url = await presignGet(x.storage_key, 3600);
      const ext = (x.storage_key.match(/\.([a-z0-9]+)$/i) || [])[1] || "bin";
      return ok(`${x.name} (${x.kind}, ${x.mime || ext}): download within an hour — curl -fsSL -o ${x.id}.${ext} '<url>'`, { asset_id: x.id, kind: x.kind, mime: x.mime, ext, url, name: x.name, duration_s: x.probe?.duration ?? null, origin: x.origin?.kind || null });
    }
    if (x.status !== "ready") return ok(`${x.id} is ${x.status}.`, { asset_id: x.id, status: x.status, error: x.error });
    if (["sheet", "poster", "waveform"].includes(view)) {
      const key = x.derived?.[view];
      if (!key) throw new HttpError(404, `No ${view} for this asset.`, "no_rendition");
      const raw = await getBuffer(key);
      const label = view === "sheet" && x.derived.sheetTimes ? `Contact sheet of ${x.name}; cell times (s): ${x.derived.sheetTimes.join(", ")}` : `${view} of ${x.name}`;
      const small = view === "waveform" ? { buf: raw, mime: key.endsWith(".png") ? "image/png" : "image/jpeg" } : await forAgent(raw);
      return { content: [{ type: "text", text: label }, { type: "image", data: small.buf.toString("base64"), mimeType: small.mime }] };
    }
    if (view === "analysis")
      return ok(`${x.name}: ${x.probe?.duration}s, ${x.derived?.shots?.length ?? 0} shot cuts, ${x.derived?.silences?.length ?? 0} silences.`, { asset_id: x.id, probe: x.probe, shots_s: x.derived?.shots, silences_s: x.derived?.silences, loudness: x.derived?.loudness, speech_ratio: x.derived?.speechRatio, generation: x.origin?.kind === "generation" ? x.origin : undefined });
    if (!x.derived?.transcript) {
      const tj = await one("select id, status from studio.jobs where kind='transcribe' and input->>'asset_id'=$1 order by created_at desc limit 1", [x.id]);
      if (tj && ["queued", "running"].includes(tj.status))
        return ok(`The transcript of ${x.id} is still being made (job ${tj.id}). job_wait {"asset_ids":["${x.id}"]} then ask again.`, { asset_id: x.id, transcript: "pending", job_id: tj.id });
      if (x.derived?.transcriptWords === 0) return ok(`${x.id} has no speech in its transcript (sound events only, or music).`, { asset_id: x.id, transcript: "no_speech" });
      return ok(`No transcript for ${x.id} (${x.probe?.audio ? (tj?.status === "failed" ? "transcription failed" : "it was not transcribed") : "no audio"}).`, { asset_id: x.id, transcript: null, ...(x.probe?.audio ? { fix: "The browser editor's library menu or a re-upload transcribes it." } : {}) });
    }
    const t = await getJson(x.derived.transcript);
    const from = a.from ?? 0,
      to = a.to ?? Infinity;
    if (view === "words") {
      const ws = t.words.filter((w) => w.e >= from && w.s <= to).slice(0, 1500);
      return ok(`${ws.length} words.`, { asset_id: x.id, language: t.language, words: ws });
    }
    const packed = packTranscript(t, { from, to });
    return { content: [{ type: "text", text: `Transcript of ${x.name} (${t.language}); times are source seconds:\n${packed.slice(0, 24000)}` }] };
  },

  async timeline_edit(account, a, ctx) {
    const { _doc, _before, _assets, ...r } = await editProject(account, a.project_id, { ...a, actor: ctx.actor });
    const head = r.mode === "apply" ? `Applied → revision ${r.revision}.` : `Preview OK (from revision ${r.base_revision}); nothing saved.`;
    // lint the result and report only what this batch introduced
    const used = [...new Set(Object.values(_doc.sequence.items).map((i) => i.asset).filter(Boolean))];
    const transcripts = await transcriptsFor(_assets, used).catch(() => ({}));
    const key = (i) => `${i.code}:${i.item || ""}:${i.at_s ?? ""}`;
    const before = new Set(lint(_before, _assets, transcripts).issues.map(key));
    const warnings = lint(_doc, _assets, transcripts).issues.filter((i) => !before.has(key(i)) && i.severity !== "info").map((i) => `${i.code}${i.at_s !== undefined ? ` at ${i.at_s}s` : ""}: ${i.fix}`);
    const out = { ...r, timeline: timelineLines(_doc, _assets), ...(warnings.length ? { warnings } : {}) };
    return ok(`${head} +${r.added.length} −${r.removed.length} ~${r.changed.length}; duration ${r.durationS.before}s → ${r.durationS.after}s.${warnings.length ? ` ${warnings.length} warning${warnings.length > 1 ? "s" : ""}.` : ""}`, out);
  },

  async timeline_history(account, a, ctx) {
    const { _doc, ...r } = await history(account, a.project_id, { action: a.action || "list", revision: a.revision, actor: ctx.actor });
    return ok(r.commits ? `${r.commits.length} revisions; current ${r.current}.` : `Restored r${r.restored_from} as revision ${r.revision}.`, r);
  },

  async timeline_view(account, a) {
    const p = await getProject(account, a.project_id);
    if (!Object.values(p.doc.sequence.items).some((i) => i.kind !== "captions")) return ok("The timeline is empty — nothing to show yet. Add clips with timeline_edit first (media_inspect view \"sheet\" shows a source clip).", { revision: p.revision, empty: true });
    let render = await latestRender(p.id, p.revision, "draft");
    if (!render) {
      const job = await enqueue({ kind: "render", account_id: account.id, project_id: p.id, input: { project_id: p.id, quality: "draft", revision: p.revision }, idempotency_key: `draft:${p.id}:${p.revision}` });
      const { done, rows } = await waitJobs(account.id, [job.id], 40_000);
      if (!done) return ok(`Draft render for revision ${p.revision} is still running (job ${job.id}). Call timeline_view again in a few seconds.`, { job_id: job.id, status: rows[0]?.status });
      if (rows[0].status !== "succeeded") throw new HttpError(500, `Draft render failed: ${rows[0].error?.message}`, "render_failed");
      render = await latestRender(p.id, p.revision, "draft");
    }
    const dur = render.probe?.duration || f2s(p.doc, seqDuration(p.doc));
    let times = a.times;
    let cutNote = "";
    if (a.at === "cuts") {
      const main = p.doc.sequence.tracks.find((t) => t.kind === "video");
      const its = main ? itemsOn(p.doc, main.id) : [];
      const cuts = its.slice(1).map((i) => f2s(p.doc, i.start));
      const pick = cuts.length > 7 ? Array.from({ length: 7 }, (_, k) => cuts[Math.round((k * (cuts.length - 1)) / 6)]) : cuts;
      times = [0.2, ...pick.flatMap((c) => [Math.max(0, c - 0.2), c + 0.2]), Math.max(0, dur - 0.3)];
      cutNote = ` Cuts at ${cuts.map((c) => c.toFixed(2)).join(", ")}${cuts.length > 7 ? " (7 shown)" : ""}; each cut appears as a before/after pair.`;
    }
    if (!times?.length) {
      const from = a.from ?? 0,
        to = Math.min(a.to ?? dur, dur),
        n = a.count ?? 8;
      times = Array.from({ length: n }, (_, i) => +(from + ((to - from) * (i + 0.5)) / n).toFixed(2));
    }
    times = times.filter((t) => t >= 0 && t < dur + 0.01).slice(0, 16);
    const { jpeg } = await framesSheet(p, p.doc, render, times);
    return image(`Revision ${p.revision} draft frames at ${times.map((t) => +Number(t).toFixed(2) + "s").join(", ")} (labels: timecode + visible item ids).${cutNote}`, jpeg);
  },

  async timeline_check(account, a) {
    const p = await getProject(account, a.project_id);
    if (a.render_id) {
      const r = await one("select * from studio.assets where id=$1 and project_id=$2 and 'render' = any(roles)", [a.render_id, p.id]);
      if (!r) throw new HttpError(404, "Render not found.", "unknown_render");
      const qc = await renderQc(r);
      return ok(`QC of ${r.id}: ${qc.issues.length} issues, ${qc.loudness.integrated_lufs} LUFS.`, qc);
    }
    const assets = assetMapOf(await projectAssets(p.id));
    const used = [...new Set(Object.values(p.doc.sequence.items).map((i) => i.asset).filter(Boolean))];
    const transcripts = await transcriptsFor(assets, used);
    const r = lint(p.doc, assets, transcripts);
    return ok(`${r.ok ? "No blocking issues" : "Blocking issues found"}; ${r.issues.length} notes; ${r.pacing.cuts_per_min} cuts/min, longest shot ${r.pacing.longest_shot_s}s.`, { revision: p.revision, ...r });
  },

  async render(account, a) {
    const p = await getProject(account, a.project_id);
    const quality = a.quality || "draft";
    const job = await enqueue({ kind: "render", account_id: account.id, project_id: p.id, input: { project_id: p.id, quality, revision: p.revision }, idempotency_key: `${quality}:${p.id}:${p.revision}` });
    return ok(`Rendering ${quality} of revision ${p.revision} (job ${job.id}). Use job_wait.`, { job_id: job.id, revision: p.revision, quality, status: job.status });
  },

  async job_wait(account, a) {
    if (a.asset_ids?.length) return waitAssets(account, a.asset_ids, Math.min(45, a.wait_s ?? 40) * 1000);
    if (!a.job_ids?.length) throw new HttpError(400, "Pass job_ids or asset_ids.", "bad_request");
    const { rows } = await waitJobs(account.id, a.job_ids, Math.min(45, a.wait_s ?? 25) * 1000);
    const view = await jobView(account, rows);
    const pending = view.filter((j) => ["queued", "running"].includes(j.status)).length;
    return ok(pending ? `${pending} of ${view.length} still running — call job_wait again.` : `All ${view.length} finished.`, { jobs: view });
  },

  async board_get(account, a) {
    const p = await getProject(account, a.project_id);
    const { board, version } = await loadBoard(p.id);
    const b = withPlacement(board, p.doc);
    const stale = outOfDate(b);
    const lines = stale.length ? `${boardLines(b)}\nOut of date (made before its details changed): ${stale.map((s) => `${s.label} (${toCredits(s.usd)} credits)`).join(", ")}` : boardLines(b);
    return ok(lines, { project_id: p.id, version, board: b, stale });
  },

  async board_preview(account, a, ctx) {
    const actor = ctx?.actor === "human" ? "human" : "agent";
    const r = await buildPreview(account, a.project_id, { actor });
    const shown = r.slots.map((x) => `${x.storyboard}: ${x.as} ${x.seconds}s`).join(" · ");
    return ok(`Laid out ${r.seconds} s (revision ${r.revision}): ${shown}.${r.notes.length ? `\n${r.notes.join("\n")}` : ""}`, r);
  },

  async board_update(account, a, ctx) {
    const p = await getProject(account, a.project_id);
    const { board, version, warnings } = await patchBoard(p.id, a.patch);
    if (a.patch?.brief?.aspect) {
      const note = await followAspect(account, p.id, board.brief.aspect);
      if (note) warnings.push(note);
    }
    const b = withPlacement(board, p.doc);
    // storyboards that will play slow or rushed, while they are still words
    const touched = Array.isArray(a.patch?.storyboards) ? a.patch.storyboards.filter((x) => x && !x.remove).map((x) => String(x.id)) : null;
    if (touched?.length) warnings.push(...pacingNotes(b, touched).map((n) => `Pacing (a suggestion; their vision wins): ${n}`));
    const line = `Board updated (v${version}).${warnings.length ? " " + warnings.join(" ") : ""}`;
    return ok(`${line}\n${boardLines(b)}`, { project_id: p.id, version, board: b, ...(warnings.length ? { warnings } : {}) });
  },

  async gen_models(account, a) {
    if (a.raw) {
      const list = rawList(a.kind);
      return ok(`${list.length} fal endpoints you can call with their own input (gen_quote endpoint + input). Read model_docs {endpoint} for the exact parameters first. Prices are fal list × our markup; video is per second by resolution.`, { endpoints: list });
    }
    if (a.model) {
      const d = describe(a.model);
      if (!d) throw new HttpError(404, `Unknown model ${a.model}.`, "unknown_model", { models: Object.keys(MODELS) });
      return ok(`${d.id}: ${d.title}. ${d.job}`, d);
    }
    const ms = listModels(a.kind);
    return ok(`${ms.length} models, one per job — pick by the job, not the vendor. studio_guide {topic:"generation"} has prompt rules for each.`, { models: ms });
  },

  async model_docs(account, a) {
    if (!rawEntry(a.endpoint)) throw new HttpError(400, `${a.endpoint} isn't on the raw allowlist (gen_models {raw:true}).`, "unknown_endpoint");
    const d = await rawDocs(a.endpoint).catch((e) => {
      throw new HttpError(502, `Couldn't fetch ${a.endpoint}'s schema: ${e.message}`, "docs_unavailable");
    });
    const params = Object.entries(d.input?.properties || {}).map(([k, x]) => `${k}${d.input.required.includes(k) ? " (required)" : ""}: ${x.type || "?"}${x.enum ? ` ∈ ${x.enum.join("|")}` : ""}${x.default !== undefined ? ` = ${JSON.stringify(x.default)}` : ""}${x.description ? ` — ${String(x.description).slice(0, 160)}` : ""}`);
    return ok(`${d.name || a.endpoint} (${d.category || "?"}): ${d.description || ""}\nInput:\n${params.join("\n")}\nDocs: ${d.page}`, d);
  },

  async gen_quote(account, a, ctx) {
    const p = await getProject(account, a.project_id);
    const actor = ctx?.actor === "human" ? "human" : "agent";
    let board = null;
    const getBoard = async () => (board ||= withPlacement((await loadBoard(p.id)).board, p.doc));
    if (a.quote_id && a.discard) {
      const gone = await one("update studio.quotes set status='denied', decided_at=now(), updated_at=now() where id=$1 and account_id=$2 and project_id=$3 and status in ('review','open','needs_approval','approved') returning id", [a.quote_id, account.id, p.id]);
      if (!gone) throw new HttpError(409, "That draft already ran or was discarded.", "quote_closed");
      return ok(`Draft ${a.quote_id} is out of the box.`, { quote_id: a.quote_id, discarded: true });
    }
    if (a.quote_id) return reviseDraft(account, p, a, actor, getBoard);
    if (a.endpoint) {
      const req = await rawRequest(p, a, {}, actor);
      const b = await getBoard();
      const working = actor === "agent" && account.key_kind === "hosted" && b.brief?.mode !== "just_make_it";
      // the same rule as the library: in the built-in chat it's the person's draft (video always),
      // unless they've let small ones run on their own
      let review = a.draft === true || (working && (req.kind === "video" || !account.quick_auto));
      if (!review && working) {
        const cost = priceOf(MODELS.raw, req);
        const spent = Number((await one(EXPLORE_SPENT, [p.id])).usd);
        review = cost > EXPLORE.item || spent + cost > EXPLORE.project;
      }
      const r = await createQuote(account, p.id, req, { review });
      return quoteResult(r, req, req.references.map((x, i) => ({ n: i + 1, role: "raw", asset_id: x.asset_id })), [`Priced as ${req.raw.basis} (fal list price × our markup).`], null);
    }

    // 1. what to make: a recipe from the board, or the caller's own request
    let made = null;
    let after = null;
    if (a.for) {
      // a sheet starts from where the storyboard before it actually ended
      if (a.for.storyboard && a.for.make === "sheet" && (await ensureLastFrame(account, p, await getBoard(), a.for.storyboard))) board = null;
      const b = await getBoard();
      const spec = { ...a.for, ...(a.model && a.for.storyboard && a.for.make !== "sheet" ? { model: resolveModel(a.model).id } : {}) };
      // a storyboard is drawn from its anchors: the agent waits for ones still being made
      const waiting = a.for.storyboard ? await pendingAnchors(p.id, b, a.for.storyboard) : [];
      const what = waiting.map((w) => `${w.title || `${w.name}'s sheet`} (${w.quote}, ${w.making ? "being made" : "a draft"})`).join(", ");
      const sbNow = a.for.storyboard ? b.storyboards.find((x) => x.id === String(a.for.storyboard)) : null;
      // flow advice, not a rule (the storyboarded-film skill makes the sheet first; other ways of working may not)
      const noSheet = !!(sbNow && a.for.make !== "sheet" && !isShot(b, sbNow) && !sbNow.sheet && sbNow.start !== "extend");
      if (a.for.storyboard && a.for.make !== "sheet") after = await pendingSheetFor(p.id, a.for.storyboard);
      made = recipe(b, spec, { durations: await durationsOf(p.id, voiceAssets(b, spec)), aspect: aspectOf(p.doc), ...(after ? { pendingSheet: `pending:${after}` } : {}) });
      if (after && !made.references.some((r) => r.asset_id === `pending:${after}`)) after = null;
      if (noSheet && !after) made.warnings.push(`Storyboard ${sbNow.id} has no sheet yet, so this video is drawn without one. In the storyboarded-film way of working you'd make and show the sheet first (it steers framing panel by panel); go on without it only if they want to.`);
      if (waiting.length) made.warnings.push(`${what} ${waiting.length > 1 ? "aren't" : "isn't"} made yet, so this is drawn without ${waiting.length > 1 ? "them" : "it"}. Generate ${waiting.length > 1 ? "them" : "it"} first: when you generate this, it's rebuilt from the board.`);
    }
    if (a.preview) {
      if (a.for) throw new HttpError(400, "preview takes model + prompt (+ references for 'more like this' or a mix), not for. Previews don't file themselves on the board: when they pick one, write it to decisions with its asset.", "bad_preview");
      const pv = previewRequest(a);
      // each variant is one frame to choose by: never a collage, a grid or captions in the picture
      if (pv.model === "image" && /\b(compare|comparison|side[- ]by[- ]side|triptych|split[- ]screen|collage|grid of|(two|three|four|2|3|4) (looks|versions|options|styles|panels))\b/i.test(a.prompt || ""))
        throw new HttpError(400, "A preview is one picture of one look — the person compares the options as cards in the box. For distinct looks, call gen_quote once per look (n:1, in parallel), each prompt describing only that look; for variations of one direction, one call with n:3.", "bad_preview");
      const prompt = pv.model === "image" && a.prompt ? `One single full-frame photograph or frame (not a collage, split-screen, triptych or grid; no text or labels): ${a.prompt}` : a.prompt;
      a = { ...a, prompt, model: pv.model, params: pv.params, takes: 1, label: a.label || "Preview" };
    }
    let modelId = made ? made.model : a.model;
    if (made && a.model && MODELS[resolveModel(a.model).id]?.kind === MODELS[made.model].kind) modelId = a.model;
    if (!modelId) throw new HttpError(400, "Pass model (or for: something on the board).", "bad_request");
    const resolved = resolveModel(modelId, { ...(made?.params || {}), ...(a.params || {}) });
    modelId = resolved.id;
    const m = MODELS[modelId];
    if (!m) throw new HttpError(400, `Unknown model ${a.model}. The library: ${Object.keys(MODELS).join(", ")}.`, "unknown_model", { models: listModels().map(({ id, job }) => ({ id, job })) });
    let params = resolved.params;
    if (made && modelId === "image/fast") params = { aspect: params.aspect || "16:9", resolution: "2K", ...(a.params || {}) };
    let prompt = made ? [made.prompt, a.prompt].filter(Boolean).join("\n\n") : a.prompt;
    let refs = await checkRefs(p.id, modelId, [...(made?.references || []), ...(a.references || [])]);
    const warnings = [...(made?.warnings || [])];
    let order = null;

    // 2. without a recipe, cast/place still add their sheets, voices and bindings
    if (!made && (a.cast?.length || a.place)) {
      const composed = await composeFromBoard(p.id, modelId, a);
      const fromBoard = await checkRefs(p.id, modelId, composed.references.filter((r) => m.references[r.role]), { fromBoard: true });
      const editIdx = refs.findIndex((r) => r.role === "edit_source");
      if (editIdx >= 0) refs.splice(editIdx + 1, 0, ...fromBoard);
      else refs.unshift(...fromBoard);
      if (composed.prefix) prompt = `${composed.prefix}\n\n${a.prompt || ""}`.trim();
      warnings.push(...composed.warnings);
    }
    const target = made?.for || a.file_to || (a.shot ? { storyboard: String(a.shot) } : null);
    const text = modelId === "voice" ? a.text || made?.text || a.prompt : a.text;
    if (made && a.for?.storyboard) warnings.push(...pacingNotes(await getBoard(), [String(a.for.storyboard)]).map((n) => `Pacing (a suggestion; their vision wins): ${n}`));
    if (after) warnings.push(`It waits for storyboard ${a.for.storyboard}'s sheet (${after}): when it runs, the sheet goes first and the video starts as soon as the sheet lands.`);
    const fp = made ? fingerprint(await getBoard(), made.for) : null;
    const req = finishRequest(modelId, { preview: !!a.preview, prompt, text, params, references: refs, takes: a.takes || 1, label: a.label || made?.label, title: made?.title || a.title || nameOfGeneration({ model: modelId, label: a.label, prompt, text }), for: target || undefined, fp, by: actor, after: after || undefined });
    order = referenceOrder(modelId, req.references, await namesOf(p.id, req.references));

    // 3. a draft for the person, or a quote to run. With the built-in agent in Work with me, every
    // generation waits for the person in the box under the chat — unless they've let quick ones run
    // on their own (their setting): looks, sheets and voices inside the project's allowance. Video
    // always waits.
    const b = await getBoard();
    const working = actor === "agent" && account.key_kind === "hosted" && b.brief?.mode !== "just_make_it";
    let review = a.draft === true;
    if (a.preview && !review) {
      // previews run without a confirm (for every agent), inside the allowance
      const cost = priceOf(MODELS[modelId], req);
      const spent = Number((await one(PREVIEW_SPENT, [p.id])).usd);
      if (cost > PREVIEW.item || spent + cost > PREVIEW.project) {
        review = true;
        warnings.push(`Preview budget used (${toCredits(spent)} of ${toCredits(PREVIEW.project)} credits today), so this is a draft for the person at ${toCredits(cost)} credits. Say so in one line; don't keep making previews — ask in words or wait.`);
      }
    } else if (working && !review) {
      const isVideo = MODELS[modelId].kind === "video";
      if (isVideo || !account.quick_auto) review = true;
      else {
        const cost = priceOf(MODELS[modelId], req);
        const spent = Number((await one(EXPLORE_SPENT, [p.id])).usd);
        review = cost > EXPLORE.item || spent + cost > EXPLORE.project;
        if (review) warnings.push(cost > EXPLORE.item ? `This costs more than ${toCredits(EXPLORE.item)} credits, so it's a draft for the person.` : `This project has used its ${toCredits(EXPLORE.project)} credits for quick sketches and samples (${toCredits(spent)} used), so from here they're drafts for the person.`);
      }
    }
    const r = await createQuote(account, p.id, req, { review });
    return quoteResult(r, req, order, warnings, a.model && a.model !== modelId && !made ? `${a.model} is now ${modelId}.` : null);
  },

  async gen_run(account, a, ctx) {
    const person = ctx?.actor === "human";
    // a storyboard video waiting on its sheet: run the sheet first if it hasn't run, then wait for it
    const pre = await one("select status, request from studio.quotes where id=$1 and account_id=$2", [a.quote_id, account.id]);
    const dep = pre?.request?.after;
    let waitFor = null;
    let depJobs = [];
    if (dep && !["used", "denied"].includes(pre.status) && (pre.request.references || []).some((r) => r.asset_id === `pending:${dep}`)) {
      const d = await one("select id, status from studio.quotes where id=$1 and account_id=$2", [dep, account.id]);
      if (!d || d.status === "denied") throw new HttpError(409, "The storyboard sheet this video waits for was discarded. Rebuild the video from the board.", "sheet_gone");
      if (d.status !== "used") {
        if (d.status === "review" && !person) throw new HttpError(409, "The storyboard sheet this video waits for is a draft the person hasn't generated. End your turn; they generate both.", "needs_review");
        depJobs = (await HANDLERS.gen_run(account, { quote_id: dep }, ctx)).structuredContent.job_ids;
        waitFor = dep;
      } else {
        const jobs = await q("select id, status, output from studio.jobs where kind='generate' and input->>'quote_id' = $1 order by created_at", [dep]);
        const madeIt = jobs.find((j) => j.status === "succeeded" && j.output?.assets?.length);
        if (madeIt) await fillPending(a.quote_id, dep, madeIt.output.assets[0]);
        else if (jobs.some((j) => ["queued", "running", "waiting"].includes(j.status))) waitFor = dep;
        else throw new HttpError(409, "The storyboard sheet this video waits for failed. Make the sheet again, then rebuild the video.", "sheet_failed");
      }
    }
    const qt = await holdForQuote(account, a.quote_id, { person });
    const takes = qt.request.takes || 1;
    const baseSeed = qt.request.params?.seed ?? Math.floor(Math.random() * 2 ** 31);
    const jobs = [];
    for (let k = 0; k < takes; k++)
      jobs.push(await enqueue({ kind: "generate", account_id: account.id, project_id: qt.project_id, status: waitFor ? "waiting" : "queued", input: { quote_id: qt.id, take: k + 1, takes, seed: (baseSeed + k * 7919) % 2 ** 31, ...(waitFor ? { after_quote: waitFor } : {}) }, idempotency_key: a.idempotency_key ? `${a.idempotency_key}:${k}` : null }));
    const target = targetOf(qt.request);
    if (target?.storyboard && target.make !== "sheet") await filedEvent(qt.project_id, target, { status: "generating" }).catch(() => {});
    const name = nameOfGeneration(qt.request);
    const charged = toCredits(qt.cost_usd);
    const line = waitFor ? `Started the storyboard sheet (${depJobs.length ? depJobs.join(", ") : "already running"}); ${name} (${charged} credits held) starts when it lands. job_wait on: ${jobs.map((j) => j.id).join(", ")}` : `Started ${name}${takes > 1 ? ` — ${takes} takes` : ""} (${charged} credits held). job_wait on: ${jobs.map((j) => j.id).join(", ")}`;
    return ok(line, { job_ids: [...depJobs, ...jobs.map((j) => j.id)], cost_usd: Number(qt.cost_usd), cost_credits: charged, quote_id: qt.id, title: name, takes, ...(waitFor ? { waits_for: waitFor } : {}), ...(target ? { for: target } : {}), ...(target?.storyboard ? { storyboard: String(target.storyboard) } : {}) });
  },

  async share(account, a) {
    const p = await getProject(account, a.project_id);
    const data = { editor: editorUrl(p.id), visibility: p.is_public ? "public" : "private", ...(p.is_public ? { watch: `${config.publicOrigin}/v/${p.id}` } : {}) };
    const r = a.render_id
      ? await one("select * from studio.assets where id=$1 and project_id=$2", [a.render_id, p.id])
      : await one("select * from studio.assets where project_id=$1 and 'render' = any(roles) and deleted_at is null order by (origin->>'quality')='final' desc, created_at desc limit 1", [p.id]);
    if (r) {
      data.render_id = r.id;
      data.render = { quality: r.origin.quality, revision: r.origin.revision };
      data.download_url = await presignGet(r.storage_key, 24 * 3600, `${p.name}.mp4`);
    }
    return ok(`Editor: ${data.editor}${data.watch ? `\nPublic watch page: ${data.watch}` : "\nThis project is private."}${data.download_url ? `\nDownload (24 h): ${data.download_url}` : ""}`, data);
  },

  async item_delete(account, a) {
    const p = await getProject(account, a.project_id);
    if (a.asset_id) {
      await q("update studio.assets set deleted_at=now() where id=$1 and project_id=$2", [a.asset_id, p.id]);
      return ok(`Deleted ${a.asset_id}.`, { deleted: a.asset_id });
    }
    await q("update studio.projects set deleted_at=now() where id=$1", [p.id]);
    return ok(`Deleted project ${p.id}.`, { deleted: p.id });
  },
};

export async function callTool(account, name, args, ctx) {
  const h = HANDLERS[name];
  if (!h) throw new HttpError(404, `Unknown tool ${name}.`, "unknown_tool");
  return h(account, args || {}, ctx);
}
export { getJobs };
