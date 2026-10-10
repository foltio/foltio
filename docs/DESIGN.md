---
version: 1
name: Studio
description: "A film-set dark editor. Near-black, neutral (not blue) surfaces, hairline structure, no chrome gradients, no shadows except for things that float. The footage is the colour; the interface is grey. One warm signal colour — Tally, the red-orange of a camera's recording light — marks what is live, what the agent is doing and what costs money. Primary actions are white. Geist for everything, tight and quiet; Geist Mono for time and numbers."

colors:
  canvas: "#0a0a0b"        # app background, stage, the viewer surround
  surface-1: "#111113"     # panels: agent column, timeline, top bar
  surface-2: "#18181b"     # raised: cards, inputs, menus, the composer
  surface-3: "#1f1f23"     # hover on surface-2, selected rows, segmented 'on'
  surface-4: "#27272b"     # pressed, scrollbar thumb, strongest lift
  hairline: "#232327"      # every 1px border and divider
  hairline-strong: "#303036" # input borders, focused card borders, outlines on media
  ink: "#ededef"           # primary text
  ink-muted: "#a1a1aa"     # secondary text
  ink-subtle: "#71717a"    # tertiary: meta, placeholders, idle icons
  ink-faint: "#4a4a52"     # disabled, empty-state glyphs
  white: "#fafafa"         # primary button surface
  on-white: "#0a0a0b"
  tally: "#ff6a3d"         # the one chromatic accent
  tally-soft: "rgba(255,106,61,0.14)"
  tally-line: "rgba(255,106,61,0.45)"
  on-tally: "#1a0a04"
  focus: "rgba(255,106,61,0.55)"
  ok: "#3ecf8e"
  warn: "#f5b544"
  danger: "#f2555a"
  # timeline item kinds: desaturated, distinguishable, never brighter than footage
  k-clip: "#4c6fbf"
  k-image: "#3f8f86"
  k-title: "#b98a3e"
  k-caption: "#7a68c4"
  k-audio: "#3f8f5c"
  k-voice: "#5a8fb0"

typography:
  family: "Geist Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
  mono: "Geist Mono Variable, ui-monospace, SFMono-Regular, Menlo, monospace"
  display: { size: 28px, weight: 600, lineHeight: 1.1, tracking: -0.025em }
  title: { size: 17px, weight: 600, lineHeight: 1.25, tracking: -0.015em }
  body: { size: 13.5px, weight: 400, lineHeight: 1.5, tracking: -0.005em }
  body-sm: { size: 12.5px, weight: 400, lineHeight: 1.45 }
  label: { size: 12.5px, weight: 500, lineHeight: 1.2 }
  micro: { size: 10.5px, weight: 500, lineHeight: 1.2, tracking: 0.06em, transform: uppercase }
  numeric: { family: mono, size: 12px, feature: tabular-nums }

rounded: { xs: 4px, sm: 6px, md: 8px, lg: 10px, xl: 14px, full: 9999px }
spacing: { 1: 4px, 2: 8px, 3: 12px, 4: 16px, 5: 20px, 6: 24px, 8: 32px, 12: 48px }
heights: { control-sm: 26px, control: 32px, control-lg: 40px, topbar: 48px }

motion:
  ease-out: "cubic-bezier(0.23, 1, 0.32, 1)"
  ease-in-out: "cubic-bezier(0.77, 0, 0.175, 1)"
  ease-drawer: "cubic-bezier(0.32, 0.72, 0, 1)"
  press: "transform 140ms ease-out; :active scale(0.97)"
  hover: "background-color, color, border-color 120ms ease"
  popover: "opacity + scale(0.97→1) 160ms ease-out, origin at the trigger"
  dialog: "opacity + translateY(8px) + scale(0.98) 220ms ease-out, centred"
  never: "transition: all; animating keyboard actions; durations over 300ms in UI; scale from 0"
---

# Studio design system

## Stance
Studio is a tool people spend hours in, looking at footage. Everything in this file follows from two rules:

1. **The footage is the colour.** Chrome is neutral grey with no blue cast, so skin tones and grades read true. No gradients, glows or tinted panels in the interface. The only colour-heavy things on screen are media: thumbnails, filmstrips, the viewer, storyboards.
2. **One signal.** Tally (#ff6a3d) is the camera's recording light. It means *live, working or spending*: the agent is running, a generation is in progress, the playhead, a price, the focus ring, the drop target. It is never decorative and never a large fill, except the Generate button, which is the one place money is spent.

Primary actions (Start, Export, Save, Sign in) are **white buttons with dark text**. They read as decisive without adding a second hue. Secondary actions are surface-2 with a hairline. Tertiary actions are bare text or icons that light up on hover.

## Surfaces and depth
- Canvas, then surface-1 (panels), then surface-2 (cards, inputs, menus), then surface-3 (hover/selected), then surface-4 (pressed).
- Hierarchy comes from the surface ladder plus hairlines, **not shadows**. Only floating layers get a shadow: menus, popovers, dialogs, toasts, drag ghosts. Use `0 12px 32px -8px rgba(0,0,0,.6), 0 0 0 1px var(--hairline-strong)`.
- Floating layers have a faint top-edge highlight: `inset 0 1px 0 rgba(255,255,255,.04)`.
- The viewer surround is canvas. The video frame sits on pure black with a hairline-strong outline.

## Type
- **Geist** for everything. Body text is 13.5px, because this is a dense pro tool, not a marketing page. Headings are weight 600 with negative tracking. Never use weight 700+.
- **Micro labels** (section names like LOOK, CAST, STORYBOARDS and track groups) are 10.5px uppercase with +0.06em tracking, in ink-subtle. Use them sparingly, as signposts.
- **Geist Mono with tabular numbers** for timecodes, durations, prices, sizes, revisions and counts. Numbers never jitter.
- Line length in the chat stays under about 68ch.

## Shape
- Controls get 6px corners (8px for inputs and the composer). Cards and media get 10px, dialogs 14px. Pills are only for status chips and the segmented control. The geometry is subtly rounded, not bubbly.
- Control heights are 26 (small), 32 (default) and 40 (large). Icon buttons are square at the same heights. Hit areas are at least 28px, even when the glyph is 14–16px.
- Icons are lucide at 1.75 stroke width, 15px in toolbars and 14px inline, coloured ink-subtle when idle and ink on hover.

## Components
- **Buttons:** `.btn` (secondary), `.btn.primary` (white), `.btn.tally` (generate/spend), `.btn.ghost`, `.btn.danger`. Sizes are small, default and large. All of them get `:active { transform: scale(.97) }`, colour transitions of 120ms, and disabled at 40% opacity with no pointer.
- **Inputs:** surface-2 with a hairline-strong border. On focus the border goes tally-line and there's a 3px tally-soft ring. Placeholders are ink-subtle.
- **Segmented control:** a canvas track with a 2px inset. The on state is surface-3 with ink text. No accent.
- **Chips / options:** surface-2 with a hairline, 6px corners. Hover is surface-3. Selected gets a hairline-strong border plus a 2px tally bar on the left.
- **Menus and popovers:** surface-2, hairline-strong, floating shadow, 4px inner padding. Rows are 30px with 6px corners and surface-3 on hover. They scale from the trigger.
- **Dialogs:** a canvas scrim at 70% with an 8px blur. The panel is surface-1, 14px corners and centred.
- **Tabs and the rail:** active is an ink icon on surface-3. Inactive is ink-subtle. No accent fills.
- **Status:** "Agent working" uses a tally dot with a soft pulse. Saved uses an ok dot. Errors use danger text, not red panels.
- **Timeline:** item colours come from the k-* tokens at 85% opacity, with a hairline top highlight and a white 1.5px outline when selected. The playhead is tally, with a tally head and a 1px line. The ruler is micro mono text in ink-subtle.
- **Empty states:** one faint glyph, one line of ink-muted text and one action. No illustrations.

## Motion (Emil Kowalski's rules)
- Ask first whether it should animate. Keyboard actions, timeline scrubbing and frequent hovers never animate.
- Entering uses ease-out (`--ease-out`). On-screen movement uses `--ease-in-out`. Hover colour uses plain `ease` at 120ms.
- Popovers take 160ms, dialogs 220ms and toasts 240ms. Exits are faster than entrances.
- Never start from scale(0). Use 0.97–0.98 plus opacity. Animate only transform and opacity, and list exact properties, never `all`.
- Hover effects go behind `@media (hover: hover) and (pointer: fine)`.
- Respect `prefers-reduced-motion` by keeping fades and dropping movement.

## Voice in the UI
Use short sentence-case labels and verbs on buttons ("Generate · $1.32", "Export", "Start"). No exclamation marks. Prices always come with what they buy.

## Don't
- No mint, purple or blue accents, and no second chromatic colour in the chrome.
- No gradients or glows on chrome, and no glassmorphism except the dialog scrim blur.
- No shadows on panels that sit in the layout.
- No Inter, no weight 700+, no ALL-CAPS beyond micro labels.
- No `transition: all`, nothing over 300ms, nothing that animates on every keystroke.
