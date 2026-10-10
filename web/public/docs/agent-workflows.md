# FOLTIO agent workflows

## Work with the person, not around them

Create or open the project, then share its editor link immediately. The person and agent see the same media, board and timeline. Every applied operation batch is one undoable revision; if the person edits concurrently, stale-revision protection prevents silent overwrites.

## Edit existing footage

1. Create the correct canvas with `project_create`.
2. Add files with `media_add`, upload them using the returned script, finalize, then `job_wait` for ingest and transcripts.
3. Read `media_inspect` transcript and word timings before choosing selects. Use frame sheets when the visual decision matters.
4. Assemble selects with `timeline_edit` `append` operations. Preview first; apply only after validation.
5. Add B-roll, titles, captions, music and mixing as one or more coherent batches.
6. Review every cut with `timeline_view {"at":"cuts"}` and use `timeline_check` for gaps, pacing, silence and caption speed.
7. Render final, wait, run measured QC and share the download.

## Create a film from an idea

1. Use `board_update` to keep the brief, story decisions, look, cast, places and storyboards as shared structured state.
2. Show visual decisions as inexpensive previews before making costly shots.
3. Create character/location sheets and storyboard sheets so references persist across shots.
4. Use `gen_quote` before every paid generation. Run only open/approved quotes.
5. File selected takes on the board, assemble them on the timeline and finish sound, captions and titles there.
6. Review frames and final QC before claiming completion.

## Make a short-form cut

Use a 9:16 canvas. Put the strongest line or image in the first two seconds, change the picture every 1.5–3 seconds, add readable captions in platform-safe areas, keep dialogue clear over music and end on a payoff rather than a long logo hold. Call `studio_guide {"topic":"short_vertical"}` for exact playbook values.

## Paid generation safety

Generation is quote-first. Quotes include exact credit cost, validated parameters and reference order. FOLTIO enforces the person's monthly cap and per-operation auto-approval threshold. A quote that needs approval includes the human approval URL; wait rather than attempting alternate paid calls. Failed generations release their held credits.

## Definition of done

Do not call a film finished from API success alone. Look at the opening, both sides of each cut, titles and the last frame. Run timeline lint, render the final revision, run measured QC, fix blocking issues and tell the person what you checked and anything still imperfect.
