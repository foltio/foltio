---
name: foltio
description: Make, edit and generate videos with FOLTIO (https://folt.io) — cloud projects, uploads from local disk, AI generation (video, images, voice, music, SFX), typed multi-track timeline edits, frame previews, QC and renders. Use whenever the user wants a video made, cut, captioned, generated or polished.
---

# FOLTIO: agentic video editing

FOLTIO is a cloud video editor exposed as MCP tools (mcp__foltio__*) and the equivalent REST API. You are the editor and the reviewer; the user watches at https://folt.io/p/<project_id>. More topics (picture, sound, text, teaser, ops, troubleshooting) are available any time through the studio_guide tool.

## Workflow
1. studio_status once (budget, recent projects). project_create with the right canvas: 9:16 for TikTok/Reels/Shorts, 16:9 for YouTube, 1:1 or 4:5 for feeds, or any width×height. Send the user the editor link right away — they see every change live and can edit too.
2. Media in: media_add {upload:[{filename, bytes}, …]} → run the returned script exactly (it uploads in parallel) → media_add {finalize:[ids]} → job_wait {asset_ids:[…]} until ingest and transcripts are done. No shell (chat apps)? Ask the user to drop the files into the editor link, then media_list. Speech is transcribed automatically right after ingest (a separate "transcribe" job, usually seconds per minute of audio). media_add {url} imports a public link. media_add {frame:{asset_id, at}} saves a still from a video (keyframes, thumbnails, continuity).
3. Understand before cutting, text first: media_inspect view "transcript" (lines with source times), "words" (exact word times, for cut points), "analysis" (shot cuts, silences, loudness), "sheet" (12 labelled frames — look when you need to see). media_list {search:"words"} finds lines across all clips.
4. Plan in a few lines: target length, hook, beats, ending. For big or paid jobs, tell the user the plan and the estimated cost before starting.
5. Edit with timeline_edit: related ops in one batch (one undo step); preview first, then apply with base_revision. "as":"name" aliases let later ops in the batch use items created earlier.
6. Review (studio_guide topic review): timeline_view at the start, every cut and every title; timeline_check for gaps, pacing, caption speed. Fix and repeat, at most 3 passes.
7. Deliver: render {quality:"final"} → job_wait → timeline_check {render_id} (black/frozen/silent spans, LUFS) → share. Tell the user: editor link, download link, length, what you made, what it cost (project_get shows spent_usd, refunds deducted), anything you could not fix.
Money: generation is paid at fal list prices and capped monthly. Always gen_quote first. policy "needs_approval" → give the user approve_url and wait; "blocked" → over budget, tell the user. Failed generations are refunded.

Working with a person on something new: words for intent (premise, ending, tone — at most ~3 questions, each with a default), pictures for look. Show looks, faces, places and music as cheap previews — gen_quote {model:"image"|"music"|"sfx", prompt, preview:true, params:{n:3}} (low-res, ≈$0.02 an image, no confirm, small daily allowance) — and let them pick, ask for more like one, or mix. Offer a full-quality generation once with its price; if they pass, don't offer it again until they ask.
Working together: the user may edit in the browser while you work. If an apply fails with stale_revision, project_get, re-check, re-apply. Never undo their changes without asking.

## Editing footage (dialogue, interviews, episodes, vlogs)
Times: timeline positions take seconds {"s":12.5}, frames (integer) or "00:00:12.500". Source points (in, out) are seconds into the asset. place/append/insert accept in + out (source seconds) or in + duration (timeline length).
Assemble selects (the fastest way to build a cut):
- Read media_inspect "transcript", pick lines, then get exact times with view "words" around them.
- For each line: append {track:"trk_v1", asset, in: firstWord.s − 0.08, out: lastWord.e + 0.15}. append keeps the main track gap-free and in order.
- Order for impact, not chronology: the strongest line first.
Cutting rules:
- Never cut inside a word. Leave 0.05–0.2 s of air; cut in silences (analysis "silences") when you can.
- Clean up talk in one op: tighten {pauses_over:0.6, keep:0.25} shortens long pauses and cuts um/uh across the edit (music keeps playing and is trimmed to the new end). It is for interviews, vlogs, podcasts and explainers — in films, episodes and ads the gaps between lines are often action, reactions or music, so look at those spans (timeline_view) and keep the beats that carry the story; use from/to or a larger pauses_over.
- Cut specific words: delete_words {asset, from_word:"w41", to_word:"w47"} (ids from media_inspect "words") removes them wherever that part of the clip is used. For anything else, delete_range {from, to, tracks:"all", ripple:true} in timeline seconds (timeline time = item start + (source time − source_in)/speed).
- Tighten: trim {item, edge:"start"|"end", to, ripple:true} on the main track closes the gap.
- Jump cuts (same framing back to back) feel abrupt: alternate scale 1.0 and 1.15 punch-ins, or cover the cut with B-roll on trk_v2.
Pacing: short-form 15–30 cuts per minute, no static shot over ~4 s; long-form can breathe. timeline_check reports cuts/min and the longest shot.
B-roll: place {track:"trk_v2", asset, in, at:<timeline s>, duration} over the line it illustrates; audio stays from the main track (set audio:{enabled:false} on B-roll with its own sound unless you want it).
Music: one bed on trk_a2 from 0 to the end, gainDb −8 to −12, fadeOutMs 1500. Ducking under speech is on by default.
Captions: add_captions once; they follow every later edit. Titles: add_title.
Check: timeline_view at every cut ±0.3 s, then render.

## Short vertical video (TikTok, Reels, Shorts)
- Canvas 1080×1920 at 30 fps. 20–45 s is typical; 60 s max for most feeds.
- Hook in the first 1–2 s: the strongest line, a question, or a striking image. No logos, no slow establishing shots, no "hey guys".
- Change the picture every 1.5–3 s: cuts, punch-ins (scale 1.0 → 1.15 keyframes), B-roll, reframes.
- Captions on, always: add_captions {style:{preset:"karaoke" (or "bold_pop"), maxWords:2–3}}. Default position "lower" sits above the platform UI.
- Safe zones: the app covers the bottom ~35% and top ~14%, and buttons run down the right ~14%. Keep faces and titles in the middle band; titles at preset "center" or "top".
- Landscape footage on a vertical canvas: visual {fit:"fit", bg:"blur"} shows the whole frame; or keep "fill" (crops the sides) and move x to keep the face in frame (x > 0 shows more of the left side).
- End on a payoff, a question or a loop back to the hook; an end card (add_title preset "end_card") only if there is a call to action.
- Sound: dialogue clear, music −10 dB under it, loudness preset "social" (−14 LUFS, the default).

## Generation — one model per job (quote first; budget-capped)
Pick the job, not the vendor. gen_models lists prices, params and reference roles.
- video — MiniMax H3 Max: every generated shot, from text or a first/last frame. 1–15 s; 480P/768P/1080P; about 8 s per 5 s clip; native sound. tier:"draft" uses H3 Max Turbo: half the price and the same prompts, for trying ideas, but it mangles small text.
- video/ref — H3 Max reference-to-video: the same characters, places, props or voices across shots. Takes ≤9 images, ≤3 voice clips and ≤3 videos.
- video/omni — Gemini Omni Flash 1.1: when a shot needs the most cinematic camera, the best sound-to-picture sync, several cuts in one clip, or 1080p/4K straight out. 3–10 s; 9:16 or 16:9; about 40 s a clip; strict moderation.
- video/edit — change a clip of ≤10 s with words: restyle, swap or remove objects, weather, wardrobe.
- video/extend — add 1–15 s to a clip; only the new seconds are billed.
- video/talk — make a still speak a voice line (lip-sync). Make the line with voice first.
- video/upscale — finish clips at 1080p or 4K (Topaz, $0.02/s to 1080p). Far cheaper than generating at 1080P.
- image — GPT Image 2.5 Flare: every still — keyframes, character and location sheets, products, covers, edits with ≤16 references, transparent cut-outs. If OpenAI refuses, it automatically falls back to image/fast.
- image/fast — Nano Banana 2: seeds for exact re-rolls, very wide or tall formats, a quick second opinion.
- voice — ElevenLabs v4, 21 named voices.
- music — Lyria 3.5: songs or beds.
- music/exact — Stable Audio 3: an exact length, instrumental.
- sfx — ElevenLabs SFX v2.
Left out on purpose:
- Seedance: the best lip-sync on paper, but 6× the price and 5–12 min per clip.
- Veo and Kling: behind on the leaderboards.
- Sora: its API is gone.
- Wan 3.0: about 3 min per clip and not better in our tests.

Shot prompts (video, video/ref):
- Write a shot brief, not adjectives.
  - Start with the style: "Live-action, cinematic." / "2D anime, not 3D, not CGI." / "3D animation."
  - Then the subject, the action (in verbs, and how it ends), the setting, the camera, the light and the sound.
- One camera move and one main action per shot. Camera words H3 knows: push in / pull out, pan, truck, tilt, pedestal, arc shot, tracking, static, shake slightly, POV. Add "with small amplitude" or "at slow speed".
- Dialogue: name who speaks, the delivery, then the exact words in quotes — at most about 12 words per line. End with "No on-screen text."
- Always direct the audio: list the sounds, and write "no music" or "no dialogue" when you mean it.
- First-frame shots: describe the motion and what must stay as in the still, e.g. "hold the framing and light; slight push-in".
- video/ref: name each reference by type and order: "Image 1 is the can. Image 2 is Mara. Keep both exactly as in their references." Audio can't be the only reference.

Omni prompts (video/omni):
- It cuts between shots by default. For one shot, write "single continuous shot, no scene cuts".
- It has no negative prompt: ask for the sound and music you want, and write "No dialogue. No music." in the prompt when needed.
- Give timing in words or timecodes: "[0-3s] … [3-6s] …".
- References are <IMAGE_REF_0>, <IMAGE_REF_1>… in the order you pass them.

Edits (video/edit, and image with edit_source): keep it short and literal.
- "Make it snow. Keep everything else the same."
- "Change only the jacket to red leather; keep the face, pose and background."

Stills (image):
- Say what it is for and the composition first: "a vertical keyframe for a product ad: …".
- Put exact text in quotes, with its placement and type, e.g. the word "MOONBREW" once, white condensed sans, centred on the can. End with "no extra text".
- People: give framing, scale, gaze and hands ("full body, feet visible").
- quality: low or medium for storyboards (≈$0.01), high by default, xhigh for covers. transparent:true for overlays.
- Titles and captions belong in the editor (add_title), not baked into images.

Voice:
- Pick a voice by name, not a description:
  - men: Brian (deep, trailers), George (warm British), Roger (confident ad read), Daniel (British news);
  - women: Rachel (calm), Aria (expressive ad read), Sarah (soft), Lily (warm British).
- Tags in the text steer the delivery: [whispers], [excited], [laughs], [pause]. "…" adds a pause and CAPS stress a word.
- Spell out numbers.

Music:
- Give the genre (plus an era), the instruments and how they play together, the BPM, key and mood, and the structure ("[Intro] -> [Build] -> [Drop] at 0:12").
- For beds, write "Instrumental only, no vocals" and state the length.
- music/exact takes the same prompt plus a duration.

SFX: one sound per call, described concretely ("a deep whoosh rising into a muffled hit, 1.5 s").

Workflow:
1. Storyboard: image at quality "low" for each shot (≈$0.01 each). Show the user when it matters.
2. Keyframes for the key shots: image at high, with the bible references.
3. Drafts: video with tier "draft", using those keyframes as first_frame.
4. Finals: video at standard tier with the same prompt and keyframe. Then video/upscale the hero shots to 1080p.
- Tell the user what the plan costs before spending more than ~$2. Use takes 2–3 only for hero shots.
- Results arrive as project assets (role "generated"); job_wait returns their ids. Generated speech is transcribed for captions.
- Not allowed: real people's likenesses, copyrighted characters.

## Keeping characters and places consistent (bibles)
Prompts alone drift within a few shots. Explicit reference images are the strongest lever, and locations drift before people do.
Before generating shots:
1. Write a short bible per character (name, age, face, hair, build, wardrobe, signature prop, voice) and per location (layout, palette, light, time of day). Reuse the same wording in every prompt.
2. Make one canonical anchor image per character with image: plain background, even light, full body.
   - Keep its asset id.
   - Derive the other views (turnaround, expressions, outfits) by passing the anchor as a "character" reference to image: "change only the pose; keep the face, hair and coat exactly".
3. Make one wide establishing image per location, plus one style frame for the look.
Every shot with that character:
- Use video/ref with references [{asset_id:<anchor>, role:"character"}, {asset_id:<location>, role:"location"}]. Prompt like: "Image 1 is Mara, keep her face, short black bob and red coat exactly as in Image 1. Image 2 is the flooded station. She wades in, slow tracking shot…".
- Keyframes hold composition; references hold identity. For a precise frame, also make a keyframe with image (anchor + location as references) and pass it as first_frame.
- Voices: give each speaker one clean 2–15 s clip (a voice line works) as role "voice", referred to as Audio 1.
- video/omni also takes up to 10 image references (<IMAGE_REF_0>…). Don't use it for real people.
Continuity between shots: media_add {frame:{asset_id:<previous shot>, at:<its last second>}} saves the last frame as an image; use it as the next shot's first_frame.
Lines from a still: voice for the line, then video/talk with the character image.
Check: timeline_view one frame per shot side by side. Regenerate the worst shot and swap it in with replace_media {item, asset}, which keeps its place and edits.

## Review before you call it done
You are the reviewer. Agents tend to under-cut, hold shots too long and claim success without looking. Look.
1. After each apply, read the summary (added/removed/changed, duration before → after). Is the length right?
2. timeline_view {times:[…]} (≤16 per call; labels show timecode and visible item ids): 0.2 s (the hook frame), each cut −0.3 s and +0.3 s, each title, the last second. Look for:
   - black or empty frames, faces cut off, wrong clip;
   - captions overlapping titles, text in unsafe zones, typos;
   - jump cuts with identical framing back to back;
   - the end landing on a weak frame.
3. timeline_check: blocking issues (gaps, media not ready), caption reading speed, cuts/min and longest shot against the playbook's targets, silences.
4. Fix, then check again. At most 3 passes; then stop and report what is left.
5. render quality "final" → job_wait → timeline_check {render_id}: no black/frozen/silent spans, integrated loudness near the preset (−14 LUFS social), true peak ≤ −1 dBTP.
6. Tell the user what you checked and anything you could not fix. Never say "done" from numbers alone.
