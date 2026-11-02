import { useEffect } from "react";
import { EMBED } from "./router";

/** When embedded (`?embed=1`), tells the host page how tall the content is so
 * it can size the iframe instead of showing a nested scrollbar:
 *   window.addEventListener("message", e => {
 *     if (e.data?.type === "STOREFRONT_HEIGHT") iframe.style.height = e.data.height + "px";
 *   });
 * The payload is a number only - no customer data ever crosses this channel. */
export function useEmbedHeight() {
  useEffect(() => {
    if (!EMBED || window.parent === window) return;
    const post = () => window.parent.postMessage({ type: "STOREFRONT_HEIGHT", height: document.documentElement.scrollHeight }, "*");
    const ro = new ResizeObserver(post);
    ro.observe(document.body);
    post();
    return () => ro.disconnect();
  }, []);
}
