import { useState } from "react";

export const CANVAS_PRESETS = [
  { id: "16:9", label: "Landscape 16:9 — YouTube 1080p", w: 1920, h: 1080 },
  { id: "16:9-4k", label: "Landscape 16:9 4K", w: 3840, h: 2160 },
  { id: "16:9-720", label: "Landscape 16:9 720p", w: 1280, h: 720 },
  { id: "9:16", label: "Portrait 9:16 — Reels, TikTok, Shorts", w: 1080, h: 1920 },
  { id: "9:16-2k", label: "Portrait 9:16 2K", w: 1440, h: 2560 },
  { id: "1:1", label: "Square 1:1", w: 1080, h: 1080 },
  { id: "4:5", label: "Portrait 4:5 — feed", w: 1080, h: 1350 },
  { id: "21:9", label: "Cinematic 21:9", w: 2560, h: 1080 },
  { id: "custom", label: "Custom size…", w: 0, h: 0 },
];
export const FPS = [24, 25, 30, 50, 60, 23.976, 29.97, 59.94];

export type CanvasValue = { width: number; height: number; fps: number };

export function CanvasPicker({ value, onChange }: { value: CanvasValue; onChange: (v: CanvasValue) => void }) {
  const match = CANVAS_PRESETS.find((p) => p.w === value.width && p.h === value.height);
  const [preset, setPreset] = useState(match ? match.id : "custom");
  return (
    <div className="canvas-picker">
      <select
        value={preset}
        onChange={(e) => {
          setPreset(e.target.value);
          const p = CANVAS_PRESETS.find((x) => x.id === e.target.value)!;
          if (p.w) onChange({ ...value, width: p.w, height: p.h });
        }}
      >
        {CANVAS_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
            {p.w ? ` (${p.w}×${p.h})` : ""}
          </option>
        ))}
      </select>
      {preset === "custom" && (
        <span className="dims">
          <input type="number" min={144} max={4096} step={2} value={value.width} onChange={(e) => onChange({ ...value, width: Number(e.target.value) })} aria-label="Width" />
          ×
          <input type="number" min={144} max={4096} step={2} value={value.height} onChange={(e) => onChange({ ...value, height: Number(e.target.value) })} aria-label="Height" />
          px
        </span>
      )}
      <select value={value.fps} onChange={(e) => onChange({ ...value, fps: Number(e.target.value) })} aria-label="Frame rate">
        {FPS.map((f) => (
          <option key={f} value={f}>
            {f} fps
          </option>
        ))}
      </select>
    </div>
  );
}
