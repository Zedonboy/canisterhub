// Light / dark / system theme for the customer chat page. The choice is a
// per-browser convenience, so it lives in localStorage; "system" (the
// default) follows the OS and reacts live when the OS flips.
//
// The same resolution runs as an inline script in chat.html before first
// paint, so there's no dark flash for light-mode users - keep the two in sync.

import { useCallback, useEffect, useState } from "react";

export type ThemePref = "system" | "light" | "dark";
const KEY = "storefront-theme";
const THEME_COLOR = { light: "#f8fafc", dark: "#0a0e1a" };

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // Storage blocked - fall back to system.
  }
  return "system";
}

function resolve(pref: ThemePref): "light" | "dark" {
  if (pref !== "system") return pref;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function apply(pref: ThemePref) {
  const theme = resolve(pref);
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(readPref);

  useEffect(() => {
    apply(pref);
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  const set = useCallback((next: ThemePref) => {
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Not persisted; still applies for this page load.
    }
    setPref(next);
  }, []);

  return { pref, set };
}
