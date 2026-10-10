import { useEffect, useState } from "react";

// Phones and narrow windows (docs/mobile.md): below this width the layout changes shape.
export const MOBILE_QUERY = "(max-width: 760px)";
export function useIsMobile() {
  const [m, setM] = useState(() => typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return m;
}
