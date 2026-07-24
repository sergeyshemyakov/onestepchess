import { type RefObject, useEffect } from "react";

/** Keep board-adjacent overlays on the same square-size custom property. */
export function useSquareSize(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const host = ref.current;
    if (host === null || typeof ResizeObserver !== "function") return;
    const refit = () =>
      host.style.setProperty("--sq", `${host.clientWidth / 8}px`);
    refit();
    const observer = new ResizeObserver(refit);
    observer.observe(host);
    return () => observer.disconnect();
  }, [ref]);
}
