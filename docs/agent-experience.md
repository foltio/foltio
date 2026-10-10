# The agent experience

Studio's users are agents first (Claude Code, Codex, Cursor, chat apps), with a person watching
in the browser. This note is what we learned by running fresh agents against the live MCP
(`scripts/agent-eval/`), what we built from it, and what comes next.

## What a connecting agent needs

1. **Know-how in-band.** Every client reads tool results; not every client loads skills, and
   only some show server instructions. So the craft travels with the server:
   - **Server instructions:** the loop and the rules (the first lines stand alone).
   - **`studio_guide {topic}`:** 12 short playbooks (workflow, editing, short_vertical, teaser,
     generation, consistency, picture, sound, text, review, ops, troubleshooting).
   - **MCP prompts:** `edit_footage`, `make_short` and `generate_story` embed the right playbooks.
   - **`/skill.md`:** the same text as a Claude Code / Codex skill, for people who want it preloaded.
2. **One unit, forgiving names, strict checks.**
   - Plain numbers are seconds everywhere; frames need `{"f":N}`.
   - Preset names accept close variants ("subtitle", "end card").
   - Unknown style fields and wrong parameters fail with the valid values listed — at quote time
     for generation, so a mistake costs nothing.
3. **Results the model actually sees.**
   - Claude Code shows the model structuredContent only, so the summary and next step are in it.
   - Codex drops images when structuredContent is present, so frame tools return image content alone.
4. **Close the loop early.**
   - Every edit returns the timeline afterwards (ids, seconds, source ranges) and only the
     warnings that batch introduced: cut inside a word, music past the end, title over captions,
     overlaps with where the track is free.
   - `timeline_view {at:"cuts"}` shows every cut, before and after, in one call.
   - `timeline_check` gives free numbers; QC measures the render.
5. **Make the common job one call.**
   - `append {in, out}` assembles selects from word timings.
   - `tighten` cleans pauses and fillers.
   - `delete_words` removes lines by word id.
   - Batch uploads with one script; `job_wait {asset_ids}` waits until media and transcripts are
     ready.
   - `media_add {frame}` saves a still for keyframes and shot-to-shot continuity.
6. **Money is safe by construction.**
   - Quote before spending; params are checked at quote time.
   - Failures are refunded.
   - A monthly cap applies, and anything above the auto-approve limit needs the user's approval.
7. **The person stays in the loop.**
   - Agents share the editor link first, and every change shows live.
   - The person can edit at the same time: revisions catch conflicts, and undo works per batch.

## What the evals showed (2026-10-01/02)

Tasks:
- **teaser:** 30 s from two episodes, no spend.
- **ad:** a generated 15–20 s product ad under $6.
- **cleanup:** join two episodes, remove dead air.

Agents: Claude Code and Codex, each with only the MCP.

| Run | Time | Tool calls | Errors | Spend |
|---|---|---|---|---|
| Claude teaser, before | 292 s | 38 | 1 + 4 silent mistakes | – |
| Claude teaser, after | 245 s | 24 | 1 (fixed since) | – |
| Codex teaser, before | 258 s | 30 | 0 + units trap | – |
| Codex teaser, after | 313 s (read 5 guide topics) | 34 | 0 | – |
| Claude ad | 259 s | 50 | 2 (fixed since) | $1.39 |
| Codex ad | 311 s | 64 | 0 | $3.11 |

Before the guide, both agents:
- fell into the seconds/frames trap (`duration: 2.8` became 3 frames);
- invented title fields (`size`, `bold`, `preset:"title"`), which were silently accepted.

After it:
- both read the guide unprompted and shared the editor link up front;
- both made consistent product ads with reference-to-video;
- errors were down to title placement, now handled by auto-stacking titles and preset aliases.

## Next, in order

1. **OAuth sign-in for chat apps** (Claude.ai, ChatGPT, desktop).
   - It replaces pasting API keys, and is the biggest reach gap.
   - Comes with an upload page / QR link for agents without a shell.
2. **Plans as objects.**
   - Bibles (character, location, style) with anchor assets.
   - A storyboard of shots with prompts, quoted and run as a batch.
   - A takes review sheet, and selecting a take swaps the media in place.
3. **Notes from the person.**
   - Pins on the timeline in the browser that the agent reads ("too slow here") and resolves.
4. **Finishing templates.**
   - Animated titles, lower thirds and kinetic captions with parameters, where agents are weakest.
5. **"What changed since revision N"**, so an agent sees the person's edits before its next batch.
6. **Guest projects** for agents that arrive without an account, claimed later by link.
7. **The eval suite on a schedule.**
   - Same tasks, tracked: time, calls, errors, spend, and a watched render.
