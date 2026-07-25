import { type RefObject, useEffect, useState } from "react";

/** Animation loops pause while off-screen or while the document is hidden. */
export function useLoopGate(ref: RefObject<HTMLElement | null>): boolean {
  const [onScreen, setOnScreen] = useState(true);
  const [hidden, setHidden] = useState(
    typeof document !== "undefined" && document.hidden,
  );

  useEffect(() => {
    const host = ref.current;
    if (host === null || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver((entries) => {
      setOnScreen(entries.some((entry) => entry.isIntersecting));
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [ref]);

  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  return onScreen && !hidden;
}
