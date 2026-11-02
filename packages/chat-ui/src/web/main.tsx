import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import WebChat from "./WebChat";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WebChat />
  </StrictMode>,
);

// Installable PWA: register the app-shell worker in production builds only
// (in dev it would cache stale modules and fight Vite's HMR).
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => undefined);
  });
}
