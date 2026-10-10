// What a connecting agent needs to do good work, served in-band so every MCP client gets it:
// server instructions (always loaded), the studio_guide tool (playbooks by topic), MCP prompts,
// and /skill.md for Claude Code. Keep each topic short enough to read in one tool result.

export const INSTRUCTIONS = `FOLTIO: cloud video editor + AI generation. You do the editing; the user watches live in the browser editor (https://folt.io/p/<project_id>) — give them that link as soon as a project exists. Before your first edit, call studio_guide (free): it has playbooks for dialogue cuts, short vertical videos, teasers, generated stories and ads, plus op examples.
Loop: studio_status → project_create → media_add (upload ticket → run the curl → finalize) → job_wait → media_inspect (transcript first) → gen_quote → gen_run → job_wait (paid; only what you can't get from footage) → timeline_edit (mode "preview", then "apply" with base_revision; one batch = one undo step) → timeline_view (frames) + timeline_check (numbers) → fix (≤3 passes) → render quality "final" → job_wait → timeline_check {render_id} → share.
Rules: never cut inside a word (use word timings from media_inspect); ids come from tool results, never invent them; quote before spending and tell the user totals over a few dollars; you are the reviewer — look at frames of every cut before calling anything done; report what you checked and what is left.`;

const T = {};

T.overview = `# Studio guide — topics
Call studio_guide {topic} for any of these (each is short):
- workflow — the loop every job follows, what to tell the user, budget and approvals
- editing — cutting dialogue on words, assembling selects, pacing, B-roll, music, captions
- short_vertical — TikTok / Reels / Shorts: hook, pacing, safe zones, captions
- teaser — trailers and teasers from long footage
- story — what makes a one-minute story land: the cold open, dialogue density, beats, turns, endings (measured)
- generation — H3 video, images, voice, music, SFX: prompts, prices, draft → final
- raw — any fal model with its full input: when to leave the curated jobs, how to read a schema, pricing
- consistency — character and location bibles so people and places stay the same across shots
- picture — framing, transforms, keyframes, picture-in-picture, Ken Burns
- looks — custom per-clip filters (set {filter, afilter}): grades, keys, grain, voice cleanup
- sound — levels, ducking, loudness, fades, J/L cuts, SFX
- text — captions and titles
- review — the check-and-fix loop before you call it done
- ops — every timeline op, with JSON examples
- troubleshooting — error codes and what to do`;

T.workflow = `# Workflow
1. studio_status once (budget, recent projects). project_create with the right canvas: 9:16 for TikTok/Reels/Shorts, 16:9 for YouTube, 1:1 or 4:5 for feeds, or any width×height. Send the user the editor link right away — they see every change live and can edit too.
2. Media in: media_add {upload:[{filename, bytes}, …]} → run the returned script exactly (it uploads in parallel) → media_add {finalize:[ids]} → job_wait {asset_ids:[…]} until ingest and transcripts are done. No shell (chat apps)? Ask the user to drop the files into the editor link, then media_list. Speech is transcribed automatically right after ingest (a separate "transcribe" job, usually seconds per minute of audio). media_add {url} imports a public link. media_add {frame:{asset_id, at}} saves a still from a video (keyframes, thumbnails, continuity).
3. Understand before cutting, text first: media_inspect view "transcript" (lines with source times), "words" (exact word times, for cut points), "analysis" (shot cuts, silences, loudness), "sheet" (12 labelled frames — look when you need to see). media_list {search:"words"} finds lines across all clips.
4. Plan in a few lines: target length, hook, beats, ending. For big or paid jobs, tell the user the plan and the estimated cost before starting.
5. Edit with timeline_edit: related ops in one batch (one undo step); preview first, then apply with base_revision. "as":"name" aliases let later ops in the batch use items created earlier.
6. Review (studio_guide topic review): timeline_view at the start, every cut and every title; timeline_check for gaps, pacing, caption speed. Fix and repeat, at most 3 passes.
7. Deliver: render {quality:"final"} → job_wait → timeline_check {render_id} (black/frozen/silent spans, LUFS) → share. Tell the user: editor link, download link, length, what you made, what it cost (project_get shows spent_usd, refunds deducted), anything you could not fix.
Money: generation is paid at fal list prices and capped monthly. Always gen_quote first. policy "needs_approval" → give the user approve_url and wait; "blocked" → over budget, tell the user. Failed generations are refunded.
Working together: the user may edit in the browser while you work. If an apply fails with stale_revision, project_get, re-check, re-apply. Never undo their changes without asking.`;

T.editing = `# Editing footage (dialogue, interviews, episodes, vlogs)
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
Check: timeline_view at every cut ±0.3 s, then render.`;

T.short_vertical = `# Short vertical video (TikTok, Reels, Shorts)
- Canvas 1080×1920 at 30 fps. 20–45 s is typical; 60 s max for most feeds.
- Hook in the first 1–2 s: the strongest line, a question, or a striking image. No logos, no slow establishing shots, no "hey guys". (In one-minute stories, the most-watched openers land their first line by ~2 s and keep talking: a line about every 3 s.)
- Change the picture every 1.5–3 s: cuts, punch-ins (scale 1.0 → 1.15 keyframes), B-roll, reframes.
- Captions on, always: add_captions {style:{preset:"karaoke" (or "bold_pop"), maxWords:2–3}}. Default position "lower" sits above the platform UI.
- Safe zones: the app covers the bottom ~35% and top ~14%, and buttons run down the right ~14%. Keep faces and titles in the middle band; titles at preset "center" or "top".
- Landscape footage on a vertical canvas: visual {fit:"fit", bg:"blur"} shows the whole frame; or keep "fill" (crops the sides) and move x to keep the face in frame (x > 0 shows more of the left side).
- End on a payoff, a question or a loop back to the hook; an end card (add_title preset "end_card") only if there is a call to action.
- Sound: dialogue clear, music −10 dB under it, loudness preset "social" (−14 LUFS, the default).`;

T.teaser = `# Teasers and trailers from long footage
Structure for ~30 s (10–14 shots):
1. Cold open (1–3 s): the most provocative line or image. Big text optional (add_title preset "big_bold", ≤3 words, 1–1.5 s).
2. Premise (5–8 s): who and what is at stake, in the characters' own lines.
3. Escalation (10–15 s): 4–6 quick beats, shorter and shorter, music rising; dialogue from one moment over pictures from another (L-cuts via detach_audio) compresses time.
4. Button (2–4 s): a twist line, a question, or a hard stop.
5. Title / end card (2–3 s): name of the show + "Episode 1 out now" or similar.
Craft:
- Find lines with media_list {search} and transcripts; mark candidates with add_marker as you go.
- Hard cuts inside acts; dip_black (0.3–0.5 s) between acts and before the end card; dissolves only for time jumps.
- Don't give away the ending. Leave a question.
- Use the episodes' own sound; add a music bed only if you have one (or generate music, about 14 credits) and duck it.
- Check: timeline_view at every cut; read the captions on screen — they should be words worth reading.`;

T.story = `# Story and pacing — one-minute stories that hold attention
Starting points, not rules: the person's vision comes first, and a quiet, slow or wordless piece done on purpose is as valid as any. These are what tends to hold attention, measured on 5,882 published one-minute episodes (Mochi's captions, Oct 2026), with their creators' rules of thumb — offer them when they help. The most-watched first episodes talk more and sooner than the least-watched: 23 vs 19 lines a minute, 83 vs 66 words a minute, speech 41% vs 32% of the time, first line at 2.0 s vs 2.8 s.

Shape
- An episode is 45–90 s: 90 s is the most common, and first episodes do best short (60–75 s). That is 4–6 storyboards of 15 s.
- Cold open: the first line lands in the first 2 s and puts the hook on the table — the rule ("Everyone I touch shows me how they die"), the insult, the demand, the countdown. No establishing shot that only sets the scene.
- Each storyboard (15 s): one pressure, one visible choice, one turn. Setup → pressure → turn → hook. End on a change, never on a resolution: cut at the most consequential moment, before the response.
- The episode's last line flips something: a twist that changes the meaning of what came before, a threat, a condition, a name. Hold it one beat, then cut. Episode 1's last beat is what episode 2's cold open pays off.

Dialogue is the pacing
- A line about every 3 s: 4–6 lines per 15 s storyboard (median 5), 3–4 words each, about 15 words per 15 s. More than ~22 words and the characters rush their lines.
- Never go more than ~8 s without a line or a strong sound beat. A silent storyboard is a choice, not a default.
- Lines are short, plain and loaded: a question dodged, an insult, a demand, a promise that comes back later as ammunition. About one line in ten is a question.
- Voice-over carries the inner rule ("Day one, they called me the janitor"); a raised voice carries the turn; a whisper carries the secret.
- Nobody explains the premise. Show it, and let one line name it.
- Exchanges can share a panel: "TEO: Where were you? / INES: Out."

Premises that travel
- A one-line rule or gimmick + an intimate injustice + an instant reversal + a hidden cost or someone watching. ("She hears the last words of anyone she touches — and her husband's haven't been said yet.")
- Engines that do well: revenge collected in public, a deal or pact with a price, a hidden or mistaken identity the audience is in on, romance tangled with revenge, a power climb past gatekeepers who laughed, foreknowledge spent like money, a thriller where only the lead notices.

People
- Each lead has a want, a contradiction (two ideas colliding) and one signature detail. Keep 2–3 people in a storyboard.
- Emotional turns go notice → react → try to recover → choose.
- A mood line per storyboard: a register plus an escalation ("quiet dread, tightening"). The register holds; the escalation tightens.

Changing a storyboard: pull one lever at a time.
- Intensity: a bigger reaction or a harder hit.
- Cast pressure: another character pushes in.
- Proximity: go closer on the face that matters.
- Information: a reveal, a name, a lie exposed.

Other formats, same rules with a different payload
- Ads: the claim, result or problem in 0–2 s; a line or voice-over about every 3 s; the product named and seen early; end on the call to action.
- Explainers: about 2.5 words a second of voice-over; the answer first.
- Music videos: cuts land on the beat, and lyrics can stand in for dialogue.`;

T.generation = `# Generation — one model per job (quote first; budget-capped)
Pick the job, not the vendor. gen_models lists prices, params and reference roles.
- video — MiniMax H3: every generated shot, from text or a first/last frame. 5–15 s (8 credits/s at 768P, 7 at 480P; clips under 5 s are made with H3 Max at 11 credits/s); 480P/768P — finish keepers with video/upscale; about 30–60 s to make a 5 s clip; native sound. tier:"draft" uses H3 Max Turbo: half price, the same prompts, faster, for trying ideas, but it mangles small text.
- video/ref — H3 reference-to-video: the same characters, places, props or voices across shots. Takes ≤9 images (the first 5 free, then 11 credits each), ≤3 voice samples (≤15 s together) and ≤3 videos (trim to 2–3 s). 5–15 s; clips under 5 s, or with a first/last frame, are made with H3 Max. No draft tier: draft at 480P.
- video/omni — Gemini Omni Flash 1.1: when a shot needs the most cinematic camera, the best sound-to-picture sync, or several cuts in one clip (montages). 3–10 s; 9:16 or 16:9; about 40 s a clip; strict moderation; no voice references (not for recurring speakers). Its 1080p/4K are upscales: use 720p and video/upscale.
- video/edit — change a clip of ≤10 s with words: restyle, swap or remove objects, weather, wardrobe.
- video/extend — add 1–15 s to a clip; only the new seconds are billed.
- video/talk — a talking still: a face image speaks a voice line (no camera move, no prompt). Make the line with voice first. For a moving shot that speaks, use video/ref with a voice sample.
- video/upscale — finish clips at 1080p or 4K (Topaz, about 3 credits/s to 1080p). Far cheaper than generating at 1080P.
- image — GPT Image 2.5 Flare: every still — keyframes, character and location sheets, products, covers, edits with ≤16 references, transparent cut-outs. If OpenAI refuses, it automatically falls back to image/fast.
- image/fast — Nano Banana 2: seeds for exact re-rolls, a quick second opinion, and the automatic fallback when OpenAI refuses. Not cheaper than image at low quality.
- voice — ElevenLabs v4, 21 named voices.
- music — Lyria 3.5: songs or beds.
- music/exact — Stable Audio 3: an exact length, instrumental.
- sfx — ElevenLabs SFX v2.
Left out on purpose:
- Seedance 2.5: one 30 s take from up to 30 references and the best lip-sync on paper, but about 63 credits/s at 720p (≈1,900 credits for 30 s, 6× H3) and 5–12+ min per clip (it timed out in our test). Two 15 s H3 storyboards do the same job.
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
- video/ref: name each reference by type and order: "Image 1 is the can. Image 2 is Mara. Audio 1 is Mara's voice. Keep both exactly as in their references." Give every file one job ("use Image 2 only for her face"). Audio can't be the only reference. With a board, gen_quote {for:{storyboard:"1"}} (or cast/place) adds the files and writes these bindings for you.
- A storyboard sheet as Image 1 makes one 15 s multi-shot sequence: "Image 1 is the storyboard for this sequence: follow its panels in order…", then the beats as "0–2.5 s: wide, slow push-in: …".
- Lines start late on H3 (about 2–3 s into a 5 s clip): write "immediately says", or give a spoken line 6–8 s.
- last_frame alone makes a "land on this frame" shot (packshots, end cards). soundtrack (an audio file) replaces the clip's sound and paces the picture.
- A surprising result? media_inspect {view:"analysis"} shows the expanded prompt H3 actually used.

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
- quality: high by default (bible and storyboard sheets read their small labels best at high, 2K), xhigh for covers. transparent:true for overlays.
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

Workflow (meaning first, then the anchors, then the film one clip at a time):
0. With a person, develop it together before generating: the core (premise and how it ends, or the promise and the ask); the clips as an outline; the leads as a pair; the look chosen by eye; voices and music. Offer options where a choice is open and write each part on the board as it's agreed.
1. The board: brief (intent, about, ending, where, versions, aspect, seconds), the cast and places with their bible fields, a music card in words (music:[{id:"M1", name, style, mood, tempo, vocals, where}] — the video model scores every clip from it), and the story as storyboards of up to 15 s each (one generation: H3's longest clip) — outlines (title, beat, seconds) first: what each clip changes and what it hands on. Vary their length and density; the opening hooks, the last lands the ending. Tell the user what it costs before spending more than 200 credits.
2. The look by eye, not in words: make previews — gen_quote {model:"image", prompt, preview:true, params:{n:3}} (≈2 credits each, low-res, no confirm, small daily allowance) — and ask "which is closest?" with each option's description being its asset id; "more like X" passes X as a style reference. Write the pick to decisions with its asset and to look.style. Ask in words only for intent (premise, ending, tone): at most ~3 questions before the first previews, each with a recommended default. The bible sheets then take their style from the pick.
3. The anchors in that look, before any video: gen_quote {for:{cast:"C1"}} / {for:{place:"L1"}} writes a full bible sheet (header, palette, turnaround, expressions, details, silhouette — 16:9, 2K, ≈7 credits) and files it as the card's sheet; {for:{voice:"C1"}} makes the voice sample (12–20 words in character, never a script line). {for:{music:"M1"}} makes a sample of the music card (Lyria 3.5, about 14 credits) — only to hear the direction.
4. Set the production design (board_update {design}) from the project: pace (shots per 15 s — calm 4–6, measured 6–8, fast 9–12, rapid 13–16; tested: H3 followed a 12-panel sheet in 15 s shot for shot), how storyboards are drawn (render frames|sketch|ink, the sheet's own look, short captions once dense, header), the bible kind (model sheet | live-action casting board) and detail (full|light), and how clips are made (storyboard | shots | mix). Group beats by continuity: shared people, place and continuous action → one storyboarded clip; a beat that stands alone → a short shot (kind:"shot", anchors only, no sheet); no cut → extend the last take (video/extend, about 11 credits/s of new footage, no image references).
   Then clip by clip: write storyboard N in full (as many shots as the pace wants, each one clear action with its shot type and a 2–4 word title; who says what; times optional), starting from how the last take actually ended (its ended note); gen_quote {for:{storyboard:"N", make:"sheet"}} (≈10 credits; it starts from the last take's final frame) and {for:{storyboard:"N"}} — video/ref, Image 1 = the storyboard, then each bible sheet and voice; the prompt says where the clip sits in the story and what happens, loosely, and leaves the cuts, camera and timing to the model (≈120 credits for 15 s at 768P). When the take lands: look at it, set ended, board_preview (the film so far: takes in order, the clips to come as their panels or a card), then the next clip. Don't make every sheet or video up front: each clip learns from the last.
   Tested 2026-10-02: H3 kept the panel order, the cuts, both characters, and six lines in two voices in their panels.
5. Between storyboards cut, or set start:"extend" to continue the previous take with video/extend (seamless, but no image references — people may drift). H3 doesn't reliably honour first_frame together with references.
6. Takes: 1 by default, 2 for a hero storyboard. If both miss, change the board or the references, not the seed. Draft at 480P to check an idea; finish at 768P and video/upscale the keepers.
- Results arrive as project assets (role "generated"); job_wait returns their ids. Generated speech is transcribed for captions.
- Not allowed: real people's likenesses, copyrighted characters.`;

T.raw = `# Raw generation — any fal model, its full input
The curated jobs (gen_models) are the easy path: good defaults, checked params, recipes from the board. Go raw when they can't do what's asked:
- a parameter or mode the job doesn't expose (seeds, camera controls, audio on/off, an exact resolution or fps, a negative prompt);
- a specific model (Seedance, Kling, Veo, Wan…) for its look, length or price;
- utilities: stems (fal-ai/demucs), isolating a voice (fal-ai/sam-audio/separate), cleaning dialogue (fal-ai/elevenlabs/audio-isolation), lip-sync on a moving clip (fal-ai/latentsync, fal-ai/sync-lipsync/v2), voice cloning, background removal, interpolation.
How:
1. gen_models {raw:true, kind} — the allowlist with one line each (video shows per-second prices by resolution).
2. model_docs {endpoint} — every parameter: name, type, range, default, description. Use its exact names.
3. gen_quote {project_id, endpoint, input} — input is the endpoint's own JSON. Put project files in as their asset id ("image_url": "ast_…", "audio_url": "ast_…"); they become URLs when it runs. The quote says how it was priced (fal list price × our markup); a request that can't be priced ahead is refused — pass the duration or the file it's measured by.
4. gen_run / drafts / job_wait as usual. Media outputs become project assets named after what they are (e.g. "demucs · vocals"); endpoints that answer with data (a transcript, a voice id) return it in job_wait's output.result.
Raw requests don't file themselves on the board: write what you made to the board yourself (a card's refs, a storyboard's takes) when it belongs there.`;

T.consistency = `# Keeping characters and places consistent (bibles and storyboards)
Prompts alone drift within a few shots. Reference images are the strongest lever, and locations drift before people do. Keep it as data on the board (board_update) — the person sees it, and gen_quote {for} builds every generation from it:
1. A card per character, product or prop: cast:[{id:"C1", name, role, age, personality, theme, look:"the locked design, reused word for word", outfit, contrast:"how to tell them from look-alikes", label:"exact product text", notes, voice:{voice:"<library voice>", line:"<sample line>"}}]. A card per recurring place: places:[{id:"L1", name, look, time, weather, mood, light, sound}]. A look for the whole project: look:{style:"medium, palette, light, texture"}.
2. One bible sheet per card: gen_quote {for:{cast:"C1"}} lays the card out as a landscape model sheet — turnaround with a height ruler, 8 expressions, head angles, outfit details, hands, silhouette, palette with hex codes (products: views, states, details, label). It becomes the card's sheet (refs[0], use "sheet"). Their own photo or design goes in first as refs:[{asset_id, use:"source"}]; a finished sheet of theirs as use "sheet" needs no generation.
3. One storyboard sheet per generation: gen_quote {for:{storyboard:"2", make:"sheet"}} draws the panels with the bibles as references and the previous storyboard attached, so costumes, props, light and layout carry on.
4. The video sends the storyboard sheet first, then every bible and voice (≤9 images, ≤3 voices within 15 s), with "Image 2 is Ines's character sheet: …" bindings and the look.
Fixing drift:
- When a take nails a character, save a frame (media_add {frame}) and add it to their card's refs (use "face") for later storyboards.
- Faces belong in close-ups; wides can use backs and silhouettes.
- Describe only what changes per panel; repeat the outfit and contrast lines for look-alikes.
- A wrong detail in an otherwise good take: video/edit ("change only the jacket to red; keep everything else").
- video/omni takes up to 10 images (<IMAGE_REF_0>…) but no voices: not for recurring speakers.
Continuity between storyboards: cut (the default), or start:"extend" to continue the last take exactly with video/extend.
Check: timeline_view one frame per storyboard side by side; regenerate the worst one and swap it in with replace_media {item, asset}.`;

T.picture = `# Picture: framing, transforms, keyframes
set {item, visual:{fit, bg, scale, x, y, rotation, opacity, crop:{l,t,r,b}, flip}}
- fit "fill" (default) covers the canvas and crops; "fit" shows the whole picture over bg "black" | "blur" | "none" (transparent: tracks below show through); "stretch" distorts.
- The same model drives the browser preview and the render: fitted picture → scaled about its centre → rotated → centre moved by x·W/2, y·H/2. x = 1 puts the centre on the right edge. Outside the frame is cut off.
- Inside a zoomed full-frame picture, a pan stays covered while |x| ≤ scale − 1 (same aspect as the canvas). Landscape on vertical with "fill" has much more room.
- Picture-in-picture (same-aspect clip, bottom-right, about a third of the width): {scale:0.35, x:0.55, y:0.55}. Top-left: {scale:0.35, x:-0.55, y:-0.55}.
- crop trims the source before fitting (fractions 0–0.45 per side).
Keyframes: scale, x, y, opacity, rotation (static only in renders) and audio gainDb accept {"kf":[{"t":0,"v":1},{"t":90,"v":1.15,"ease":"ease_in_out"}]}, where t is frames from the item's start (fps is in the canvas line of project_get). Eases: linear, ease_in, ease_out, ease_in_out.
- Slow zoom (Ken Burns): scale 1 → 1.15 over the clip. Pan: scale 1.2 with x −0.1 → 0.1.
- Punch-in for emphasis: static scale 1.15–1.25 on a clip, alternating with 1.0.
- Fade an overlay in: opacity 0 → 1 over 10–15 frames (renders as a fade).
Colour plates: place {track, color:"#0E0E10", at, duration} for backgrounds behind text.`;

T.looks = `# Looks — custom per-clip filters
timeline_edit set {item, filter:"…"} puts an ffmpeg filter chain on that clip's picture; afilter:"…" on its sound; null removes it. The render applies it exactly; the editor plays a baked copy once it's ready (a few seconds per minute of footage; until then it shows the plain clip, with an "fx" badge on the item). Use it when no setting covers the look — size, position, crop, rotation, opacity and speed stay in visual/speed.
Rules: a simple comma-separated chain from the allowlist (eq, curves, lut3d, colorbalance, colortemperature, hue, huesaturation, vibrance, exposure, gblur, boxblur, unsharp, cas, vignette, noise, deband, deflicker, hqdn3d, chromakey, colorkey, hsvkey, despill, lenscorrection, chromashift, fade…; sound: equalizer, highpass, lowpass, acompressor, agate, afftdn, anlmdn, deesser, aecho, chorus, dynaudnorm, rubberband pitch…). No [labels], ';', files or URLs; nothing that changes length or frame size. A LUT: upload the .cube, then lut3d=ast_….
Recipes:
- Warm film grade: filter "colortemperature=temperature=4800,eq=contrast=1.08:saturation=0.9:gamma=0.97,curves=preset=vintage,noise=alls=6:allf=t"
- Black and white, high contrast: filter "hue=s=0,eq=contrast=1.35:brightness=-0.03,curves=preset=strong_contrast,vignette=PI/5"
- Green screen over the track below: put the green-screen clip on trk_v2 above the background on trk_v1, then filter "chromakey=color=0x00d000:similarity=0.12:blend=0.06,despill=type=green" — the keyed areas show the track below.
- Vignette with grain: filter "vignette=angle=PI/4.5,noise=alls=10:allf=t+u,eq=saturation=0.92"
- Voice cleanup: afilter "highpass=f=80,afftdn=nr=12:nf=-30,equalizer=f=3000:t=q:w=1:g=3,deesser,acompressor=threshold=0.1:ratio=3:makeup=2"
Check the result with timeline_view (the render frames show the filter) before calling it done.`;

T.sound = `# Sound
- Picture clips carry their own sound (audio.enabled false to silence one). Audio tracks: trk_a1 voice (role dialogue), trk_a2 music, trk_a3 sfx; add_track {kind:"audio", role} for more.
- Levels: speech around 0 dB; music −8 to −12 dB under speech (ducking lowers it a further 12 dB while people talk: set_mix {ducking:{depthDb:-12}}, or null to turn off); SFX −6 to −12 dB.
- Fades: audio {fadeInMs, fadeOutMs}. Every clip already gets a 10 ms fade at its edges, so cuts don't click.
- Loudness: renders are normalised to the preset: set_mix {loudness:{preset:"social"}} (−14 LUFS, default) | "podcast" (−16) | "broadcast" (−23). timeline_check {render_id} measures the result.
- J and L cuts: detach_audio {item} moves the clip's sound to a voice track as its own clip; then trim or move picture and sound separately so speech leads or trails the cut.
- Mute a whole track: set_track {track, muted:true}. Change speed: set {item, speed} (pitch is kept; duration changes unless keep:"duration").
- SFX: a whoosh into a hard cut or title, an impact on a reveal, room tone under silences. Keep them subtle.
- Generated music: music for a bed (trim it to the edit length and fade out); music/exact when it must be an exact length.`;

T.text = `# Captions and titles
Captions: add_captions {style:{preset:"karaoke"|"bold_pop"|"clean"|"boxed", position:"lower"|"center"|"upper", maxWords:1–8, uppercase, color:"#FFFFFF", highlight:"#FFD400"}}
- One captions layer for the whole edit, built from transcripts of dialogue tracks and picture clips with sound. It follows every later cut automatically — add it once, early.
- karaoke highlights the spoken word (short-form standard); bold_pop is bigger; clean is sentence case for long-form; boxed sits on a dark box.
- karaoke / bold_pop: 2–3 words. clean / boxed (subtitle style): 5–8 words; long lines wrap onto two rows. Each caption stays up at least ~0.7 s. timeline_check reports reading speed.
- A clip with no transcript yet gets no captions: wait for its transcribe job (media_inspect says so).
- Change the look later with set {item:<captions item id>, style:{…}}.
Titles: add_title {at, duration, text, style:{preset, color, scale, pos:{x,y}, fadeInMs, fadeOutMs}}
- Presets: lower_third (name + role, 3–5 s), center, top, big_bold (hook words, 1–2 s), subtitle_box, end_card (call to action, 2–3 s).
- ≤6 words per line; "\\n" for a second line. pos is the text block's centre in 0–1 canvas units; scale multiplies the size.
- Don't stack titles on captions: on vertical canvases captions sit in the lower third, so use center/top titles or move captions to "upper" while a lower third is up.`;

T.review = `# Review before you call it done
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
6. Tell the user what you checked and anything you could not fix. Never say "done" from numbers alone.`;

T.ops = `# Ops reference (timeline_edit)
Default tracks: trk_v1 (main picture, bottom), trk_v2 (overlays, drawn on top), trk_t1 (titles), trk_cap (captions), trk_a1 voice, trk_a2 music, trk_a3 sfx. Times: {"s":1.5}, frames (integer) or "00:00:01.500"; in/out are source seconds.
- place {track, asset|color, at, in?, out?|duration?, visual?, audio?, speed?, as?} — at a free time (errors on overlap)
- append {track, asset, in?, out?|duration?, gap?, as?} — after the last item on the track
- insert {track, at, asset, in?, out?|duration?, ripple?:"all"|"track"} — push later material right
- overwrite {track, at, asset, in?, out?|duration?} — replace what is there
- move {item, to?|by?, track?, onOverlap?:"overwrite"} ; reorder {item, toIndex} (gap-free main track)
- delete {items:[…], ripple?:true} ; delete_range {from, to, tracks?:"all"|[…], ripple?:true}
- trim {item, edge:"start"|"end", to?|by?, ripple?:true} ; split {item, at, as?} ; slip {item, by:<seconds>}
- tighten {pauses_over?:0.6, keep?:0.25, fillers?:true, from?, to?} ; delete_words {asset, from_word, to_word} — transcript-based cleanup
- replace_media {item, asset, in?, fit?:"source_duration"} — swap a take in place
- set {item, name?, visual?, audio?, speed?, keep?:"duration", text?, style?, color?}
- add_transition {from, to, preset:"dissolve"|"dip_black"|"dip_white", duration?} ; set_transition {id, preset?, duration?} ; remove_transition {id}
- add_title {at, duration?, text, style?, track?} ; add_captions {style?, sources?}
- add_marker {at, label} ; remove_marker {id} ; detach_audio {item, track?}
- add_track {kind:"video"|"audio"|"text"|"caption", role?, name?, as?} ; set_track {track, enabled?, muted?, locked?, name?}
- set_mix {ducking?, loudness?, background?} ; set_canvas {aspect?|width?+height?, fps?}
Example — assemble a teaser in one batch:
{"project_id":"prj_…","mode":"apply","base_revision":4,"label":"first cut","ops":[
 {"op":"append","track":"trk_v1","asset":"ast_ep1","in":41.2,"out":43.9,"as":"hook"},
 {"op":"append","track":"trk_v1","asset":"ast_ep2","in":12.05,"out":17.6},
 {"op":"append","track":"trk_v1","asset":"ast_ep1","in":63.4,"out":66.1,"visual":{"scale":1.15}},
 {"op":"add_title","at":0,"duration":{"s":1.5},"text":"SHE KNEW","style":{"preset":"big_bold"}},
 {"op":"add_captions","style":{"preset":"karaoke","maxWords":3}},
 {"op":"place","track":"trk_a2","asset":"ast_music","at":0,"duration":{"s":30},"audio":{"gainDb":-10,"fadeOutMs":1500}}]}
Example — tighten and polish:
[{"op":"delete_range","from":{"s":7.2},"to":{"s":7.9},"tracks":"all","ripple":true},
 {"op":"set","item":"itm_x","visual":{"scale":{"kf":[{"t":0,"v":1},{"t":75,"v":1.12,"ease":"ease_in_out"}]}}},
 {"op":"add_transition","from":"itm_y","to":"itm_z","preset":"dip_black","duration":{"s":0.4}}]
Preview returns the same summary without saving; errors are all-or-nothing and name the op that failed.`;

T.troubleshooting = `# Troubleshooting
- stale_revision: someone (often the user in the browser) changed the project. project_get, re-check your plan against it, apply again with the new revision.
- overlap: the target time is taken on that track. Use insert (pushes later items), overwrite, another track (trk_v2, or add_track), or move the other item.
- source_bounds: in/out or duration runs past the source. Check the asset's duration_s (media_list) and the in point; for speed changes, source used = duration × speed.
- asset_not_ready: ingest still running — job_wait on its job, or media_list to see status.
- wrong_track_kind: picture on video tracks, sound on audio tracks, titles on text, captions on the caption track.
- track_locked: the user locked it in the browser; ask before unlocking (set_track {locked:false}).
- not_adjacent (transitions): the two clips must touch on the same track (from ends exactly where to starts).
- bad_time: use {"s":1.5}, an integer frame count, or "00:00:01.500".
- Uploads: curl failing with 403 means the ticket expired (6 h) — call media_add upload again. Big files: run curl in the background and wait.
- job_wait "still running": normal — call again. timeline_view "still rendering": call again in a few seconds.
- Captions empty: the clips have no transcript yet (or no speech). media_inspect view "transcript" says which.
- Generation needs_approval: give the user approve_url; blocked: monthly cap reached.`;

export const GUIDE = T;
export const GUIDE_TOPICS = Object.keys(T);

export function guideText(topic = "overview") {
  if (topic === "all") return GUIDE_TOPICS.map((k) => T[k]).join("\n\n");
  return T[topic] || `${T.overview}\n\n(Unknown topic "${topic}".)`;
}

// Claude Code skill built from the same text (served at /skill.md).
export function skillMarkdown(origin) {
  const body = ["workflow", "editing", "short_vertical", "generation", "consistency", "review"].map((k) => T[k].replace(/^# /, "## ")).join("\n\n");
  return `---
name: foltio
description: Make, edit and generate videos with FOLTIO (${origin}) — cloud projects, uploads from local disk, AI generation (video, images, voice, music, SFX), typed multi-track timeline edits, frame previews, QC and renders. Use whenever the user wants a video made, cut, captioned, generated or polished.
---

# FOLTIO: agentic video editing

FOLTIO is a cloud video editor exposed as MCP tools (mcp__foltio__*) and the equivalent REST API. You are the editor and the reviewer; the user watches at ${origin}/p/<project_id>. More topics (picture, sound, text, teaser, ops, troubleshooting) are available any time through the studio_guide tool.

${body}
`;
}

// MCP prompts (slash commands in clients that support them).
export const PROMPTS = [
  {
    name: "edit_footage",
    title: "Edit my footage",
    description: "Cut local or uploaded footage into a finished video: selects on the transcript, pacing, captions, music, review, final render.",
    arguments: [
      { name: "files", description: "Paths or a description of the footage", required: true },
      { name: "goal", description: "What the video is for, target length and platform", required: false },
    ],
    topics: ["workflow", "editing", "review"],
    text: (a) => `Use the Studio tools to edit this footage: ${a.files}.\nGoal: ${a.goal || "a tight, well-paced cut with captions"}.`,
  },
  {
    name: "make_short",
    title: "Make a short vertical video",
    description: "A 20–45 s TikTok/Reels/Shorts video from footage or an idea: hook, pace, captions, safe zones.",
    arguments: [
      { name: "source", description: "Footage paths, a project id, or the idea", required: true },
      { name: "platform", description: "TikTok, Reels, Shorts…", required: false },
    ],
    topics: ["workflow", "short_vertical", "review"],
    text: (a) => `Use the Studio tools to make a short vertical video for ${a.platform || "TikTok/Reels/Shorts"} from: ${a.source}.`,
  },
  {
    name: "generate_story",
    title: "Generate a short story",
    description: "A short generated film or ad with consistent characters: bible, storyboard, drafts, finals, edit, sound.",
    arguments: [
      { name: "idea", description: "The story or ad in a few sentences", required: true },
      { name: "budget", description: "Maximum spend in credits", required: false },
    ],
    topics: ["workflow", "generation", "consistency", "review"],
    text: (a) => `Use the Studio tools to make this as a short generated video: ${a.idea}.\nBudget: ${a.budget ? `${a.budget} credits at most` : "keep it under 500 credits and tell me before spending more"}.`,
  },
];

export function promptMessages(name, args = {}) {
  const p = PROMPTS.find((x) => x.name === name);
  if (!p) return null;
  const guide = p.topics.map((k) => T[k]).join("\n\n");
  return {
    description: p.description,
    messages: [{ role: "user", content: { type: "text", text: `${p.text(args)}\n\nFollow this Studio guide:\n\n${guide}` } }],
  };
}
