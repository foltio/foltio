# Studio on a phone

Phones are where people have an idea, answer the agent, watch what it made and share it. Precise timeline work happens at a desk, or through the agent. The phone layout is designed for that, not shrunk from the desktop. It covers widths of 760 px and below (`useIsMobile`), and every flow was checked at 390×844 and 360×740.

## The shape of a project on a phone

```
┌───────────────────────────┐
│ ←  Project name     ⟳  ⤓  │  top bar: back, name, jobs, export
├───────────────────────────┤
│  ▶  mini player   00:12 ⌄ │  the cut, always there; tap ⌄ to fold to a bar
├───────────────────────────┤
│                           │
│   the current tab         │  Agent (default) · Board · Media · Edit
│   (full height)           │
│                           │
├───────────────────────────┤
│ Agent  Board  Media  Edit │  bottom tabs, above the home indicator
└───────────────────────────┘
```

- **The agent is home.** A project opens on the chat. The decision box and composer sit at the bottom, within thumb reach, and the composer text is 16 px so iOS doesn't zoom.
- **The video is always one glance away.** The mini player sits above the tab content (about 28% of the height). It folds to a 44 px bar with play and timecode, so the chat gets the room. In the Edit tab it grows.
- **Board:** clips stacked as a list. A clip's picture plays its take, and a tap opens it large. Ingredients wrap.
- **Media:** a 2-column grid. Uploads come from the camera roll through the system picker.
- **Edit:** the real timeline, horizontally scrollable, with a compact toolbar (undo, split, trim, delete), 44 px targets and narrow track headers. Heavy editing is expected to go through the agent.
- **Floating things become bottom sheets:** board item cards, a draft's details, menus and dialogs rise from the bottom with a grabber. Drag down or tap outside to dismiss.
- **No hover.** Everything revealed on hover on desktop has a tap equivalent on touch, or is always visible.

## Flows

1. **Land → sign in → start.** The front page (owned by track A) → Google/Discord → the library. The start box ("What are we making?") stacks: words, then aspect and style on one wrapping row, then the round send button. The idea opens the project on the Agent tab with the agent already working.
2. **Talk.** Questions arrive in the decision box: the question, the options as 44 px rows, then your own answer field and Answer. Drafts show "Goes in" thumbnails that you can add or remove, the prompt, and one tally **Generate · $x**. The Decisions strip folds to one line at the top of the chat.
3. **Watch.** The Board tab lists the clips with their progress. Tap a clip's picture to play its take full width, and use **Storyboard** for its sheet. Ingredient cards open as sheets.
4. **Review the cut.** The mini player plays the timeline. Unfold it, or go to Edit for the transport and the strip.
5. **Upload / Media / Export / Share.** The paperclip in the composer, or the Media tab's upload, opens the system picker (camera roll), and files become references in the chat. Export in the top bar opens a full-width sheet.
6. **Billing & Connect.** Single-column pages, packs stacked, code blocks scroll sideways, copy buttons stay large.
7. **Public page `/v/:id`.** The video full width first, then **Clone this project** (full-width primary), then the idea, story, clips and media.
