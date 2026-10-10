import { useEffect, useState } from "react";

// The playhead lives outside React state so playback does not re-render the whole editor;
// only the components that show time subscribe to it.
export type Clock = {
  get: () => number;
  set: (t: number) => void;
  subscribe: (fn: (t: number) => void) => () => void;
};

export function createClock(): Clock {
  let t = 0;
  const subs = new Set<(t: number) => void>();
  return {
    get: () => t,
    set: (v: number) => {
      t = Math.max(0, v);
      for (const f of subs) f(t);
    },
    subscribe: (fn) => {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}

// Re-render on every tick, or at most every `throttleMs`.
export function useClockTime(clock: Clock, throttleMs = 0) {
  const [t, setT] = useState(clock.get());
  useEffect(() => {
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = clock.subscribe((v) => {
      if (!throttleMs) return setT(v);
      const now = performance.now();
      if (now - last >= throttleMs) {
        last = now;
        setT(v);
      } else {
        clearTimeout(timer);
        timer = setTimeout(() => setT(clock.get()), throttleMs);
      }
    });
    return () => {
      unsub();
      clearTimeout(timer);
    };
  }, [clock, throttleMs]);
  return t;
}
