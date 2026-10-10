import { useEffect, useRef, useState, type ReactNode } from "react";
import { Play, Pause, Loader2, Check } from "lucide-react";

// Listening in the panel: voice samples, music, sound effects. One clip plays at a time.
let playing: { el: HTMLAudioElement; stop: () => void } | null = null;

const clock = (s?: number | null) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");

// Every library voice reading the same line, made with the voice model itself (scripts/voice-previews.mjs
// writes them to web/public/voices), so voices can be compared by ear before one is chosen.
export const voicePreview = (name?: string | null) => (name ? `/voices/${name.toLowerCase()}.mp3` : null);

export function PlayButton({
  url,
  label = "Play",
  seconds,
  className = "btn small",
  title,
  onPress,
  pressed,
  children,
}: {
  url?: string | null;
  label?: string;
  seconds?: number | null;
  className?: string;
  title?: string;
  onPress?: () => void; // also called on every click (a voice row chooses itself as it plays)
  pressed?: boolean;
  children?: ReactNode; // in place of the label
}) {
  const [on, setOn] = useState(false);
  const [loading, setLoading] = useState(false);
  const el = useRef<HTMLAudioElement | null>(null);
  useEffect(
    () => () => {
      if (playing?.el === el.current) playing = null;
      el.current?.pause();
    },
    [],
  );
  useEffect(() => {
    // a new file (a newer sample): start over
    el.current?.pause();
    el.current = null;
    setOn(false);
  }, [url]);
  const text = children ?? (label ? <span>{label}</span> : null);
  if (!url)
    return (
      <span className={`${className} play-wait`} title="Still processing — it will play in a moment">
        <Loader2 size={12} className="spin" /> {text}
      </span>
    );
  const stop = () => {
    el.current?.pause();
    setOn(false);
  };
  return (
    <button
      className={`${className} play ${on ? "on" : ""}`}
      title={on ? "Stop" : title || `Play${seconds ? ` (${clock(seconds)})` : ""}`}
      aria-label={label || title || "Play"}
      aria-pressed={pressed}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onPress?.();
        if (on) return stop();
        if (!el.current) {
          el.current = new Audio(url);
          el.current.onended = () => setOn(false);
          el.current.onwaiting = () => setLoading(true);
          el.current.onplaying = () => setLoading(false);
        }
        if (playing && playing.el !== el.current) playing.stop();
        playing = { el: el.current, stop };
        el.current.currentTime = 0;
        setLoading(true);
        el.current
          .play()
          .then(() => (setOn(true), setLoading(false)))
          .catch(() => (setOn(false), setLoading(false)));
      }}
    >
      {loading ? <Loader2 size={12} className="spin" /> : on ? <Pause size={12} /> : <Play size={12} />}
      {text}
      {seconds ? <span className="play-secs">{clock(seconds)}</span> : null}
    </button>
  );
}

// Choosing a library voice by ear, like a ringtone list: clicking a voice plays its preview and
// chooses it; clicking it again stops it.
export function VoicePicker({ value, voices, about, onChange }: { value: string; voices: string[]; about: (v: string) => string; onChange: (v: string) => void }) {
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // open on the current choice
    const box = list.current;
    const row = box?.querySelector<HTMLElement>(".vp-row.chosen");
    if (box && row) box.scrollTop = row.offsetTop - box.clientHeight / 2 + row.clientHeight / 2;
  }, []);
  return (
    <div className="vp" ref={list} role="listbox" aria-label="Voices">
      {voices.map((v) => (
        <PlayButton key={v} url={voicePreview(v)} label={v} className={`vp-row ${v === value ? "chosen" : ""}`} title={`Hear ${v} and choose it`} pressed={v === value} onPress={() => onChange(v)}>
          <strong>{v}</strong>
          <span className="vp-about ellipsis">{about(v)}</span>
          {v === value && <Check size={12} className="vp-check" />}
        </PlayButton>
      ))}
    </div>
  );
}
