# Model library

Studio offers one generation model per job. Agents pick a job (`video`, `image`, `voice`…);
which vendor model sits behind it is our decision and can change without changing agent prompts.
The catalogue is based on provider documentation and internal model evaluations dated 2026-10-02.

| Job | Model | Price |
|---|---|---|
| video (tier draft = Turbo) | MiniMax H3 Max | $0.08/s at 768P |
| video/ref | H3 Max reference-to-video | $0.08/s |
| video/omni | Gemini Omni Flash 1.1 | $0.10/s at 720p |
| video/edit | Gemini Omni Flash 1.1 edit | $0.10/s of source |
| video/extend | H3 Max extend | $0.08/s of new footage |
| video/talk | H3 Max lip-sync | $0.08/s of audio (min 5 s) |
| video/upscale | Topaz Video Precision | $0.02/s to 1080p |
| image (falls back to image/fast on refusals) | GPT Image 2.5 Flare | ≈$0.05 per 2K image |
| image/fast | Nano Banana 2 | $0.06–0.16 per image |
| voice | ElevenLabs v4 | $0.08 per 1k characters |
| music | Lyria 3.5 | $0.10 per track |
| music/exact | Stable Audio 3 Medium | $0.04 per track |
| sfx | ElevenLabs SFX v2 | $0.002/s |

**Where things live**
- **Catalog:** `server/gen/catalog.mjs`. Each job has its params, reference roles (with media type and length limits), a `price()` for quotes and a `build()` that maps the request onto fal.
- **Old ids:** they keep working through `ALIASES`.
- **Prompting rules:** `studio_guide {topic:"generation"}` (`server/mcp/guide.mjs`).

**Changing a model**
1. Edit the job's `title`, `price` and `build`.
2. Add any new params.
3. Run `node scripts/fal-probe.mjs <endpoint> '<input>' <out>` against the new endpoint.
4. Run the end-to-end check, `research/.../scripts/10-library-e2e.py`, and an agent eval (`scripts/agent-eval`).
5. Update the guide.
