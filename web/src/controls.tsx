import { useEffect, useRef, useState } from "react";

// Slider that previews while dragging and commits once on release, with an optional keyframe diamond.
export function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  unit = "",
  toDisplay = (v: number) => v,
  fromDisplay = (d: number) => d,
  digits = 0,
  onBegin,
  onLive,
  onCommit,
  onCancel,
  kf,
  onKey,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  toDisplay?: (v: number) => number;
  fromDisplay?: (d: number) => number;
  digits?: number;
  onBegin?: () => void;
  onLive?: (v: number) => void;
  onCommit: (v: number) => void;
  onCancel?: () => void;
  kf?: "none" | "animated" | "key";
  onKey?: () => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const [text, setText] = useState<string | null>(null);
  const start = useRef<number | null>(null);
  const v = draft ?? value;
  const shown = +toDisplay(v).toFixed(digits);
  const finish = (n: number) => {
    const changed = start.current !== null && Math.abs(n - start.current) > 1e-9;
    start.current = null;
    setDraft(null);
    if (changed) onCommit(n);
    else onCancel?.();
  };
  return (
    <div className={`slider ${disabled ? "disabled" : ""}`}>
      <div className="slider-head">
        <span className="slider-label">{label}</span>
        {onKey && (
          <button className={`kf-btn ${kf || "none"}`} onClick={onKey} title={kf === "key" ? "Remove keyframe at playhead" : kf === "animated" ? "Add keyframe at playhead" : "Animate: add a keyframe at the playhead"}>
            ◆
          </button>
        )}
        <input
          className="num"
          disabled={disabled}
          value={text ?? `${shown}`}
          onChange={(e) => setText(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={() => {
            if (text !== null) {
              const n = Number(text);
              if (Number.isFinite(n)) {
                const val = Math.max(min, Math.min(max, fromDisplay(n)));
                if (Math.abs(val - value) > 1e-9) onCommit(val);
              }
            }
            setText(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setText(null);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        {unit && <span className="unit">{unit}</span>}
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={v}
        disabled={disabled}
        onPointerDown={() => {
          start.current = value;
          onBegin?.();
        }}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (start.current === null) {
            start.current = value;
            onBegin?.();
          }
          setDraft(n);
          onLive?.(n);
        }}
        onPointerUp={(e) => finish(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => start.current !== null && finish(Number((e.target as HTMLInputElement).value))}
        onDoubleClick={() => onCommit(fromDisplay(toDisplay(value)))}
      />
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange, small }: { value: T; options: { value: T; label: React.ReactNode; title?: string }[]; onChange: (v: T) => void; small?: boolean }) {
  return (
    <div className={`seg ${small ? "small" : ""}`}>
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? "on" : ""} title={o.title} onClick={() => o.value !== value && onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const SWATCHES = ["#FFFFFF", "#000000", "#FFD400", "#FF4D4D", "#7CF2C5", "#4DA3FF", "#B57CFF", "#FF8A3D"];

// Colour picker that previews while picking and commits when you stop.
export function ColorField({ label, value, onLive, onCommit }: { label: string; value: string; onLive?: (v: string) => void; onCommit: (v: string) => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const change = (c: string, now = false) => {
    setV(c);
    onLive?.(c);
    clearTimeout(timer.current);
    if (now) onCommit(c);
    else timer.current = setTimeout(() => onCommit(c), 450);
  };
  return (
    <div className="color-field">
      <span className="slider-label">{label}</span>
      <div className="swatches">
        {SWATCHES.map((s) => (
          <button key={s} className={`sw ${v.toUpperCase() === s ? "on" : ""}`} style={{ background: s }} onClick={() => change(s, true)} title={s} />
        ))}
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(v) ? v : "#ffffff"} onChange={(e) => change(e.target.value.toUpperCase())} />
      </div>
    </div>
  );
}

export function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="ins-sec">
      <div className="ins-sec-head">
        <span>{title}</span>
        {right}
      </div>
      {children}
    </section>
  );
}
