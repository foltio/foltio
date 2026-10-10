import { useEffect } from "react";

// Phones: every bottom sheet (.bd-stage over its .bd-scrim) can be dragged down by its top to close.
// One listener for all of them — the sheets stay ordinary components. A quick flick closes too.
export function useSheetDrag(on: boolean) {
  useEffect(() => {
    if (!on) return;
    let sheet: HTMLElement | null = null;
    let y0 = 0;
    let t0 = 0;
    let dy = 0;
    const down = (e: PointerEvent) => {
      const s = (e.target as HTMLElement)?.closest?.(".bd-stage") as HTMLElement | null;
      if (!s || e.clientY - s.getBoundingClientRect().top > 56) return; // the grabber and the title row
      if ((e.target as HTMLElement).closest("button, a, input, textarea, select")) return;
      sheet = s;
      y0 = e.clientY;
      t0 = performance.now();
      dy = 0;
      s.style.transition = "none";
    };
    const move = (e: PointerEvent) => {
      if (!sheet) return;
      dy = Math.max(0, e.clientY - y0);
      sheet.style.transform = `translateY(${dy}px)`;
    };
    const up = () => {
      if (!sheet) return;
      const s = sheet;
      sheet = null;
      const fast = dy / Math.max(1, performance.now() - t0) > 0.5;
      s.style.transition = "transform 220ms cubic-bezier(0.32, 0.72, 0, 1)";
      if (dy > 110 || (fast && dy > 30)) {
        s.style.transform = "translateY(100%)";
        const scrim = s.parentElement?.querySelector(".bd-scrim") as HTMLElement | null;
        setTimeout(() => {
          scrim?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
          scrim?.click();
        }, 180);
      } else s.style.transform = "";
    };
    document.addEventListener("pointerdown", down);
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
    };
  }, [on]);
}
