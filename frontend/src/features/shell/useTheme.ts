"use client";

import { useSyncExternalStore } from "react";
import { SYSTEM_THEME_QUERY, THEME_COLORS, THEME_STORAGE_KEY, type ThemePreference } from "@/lib/theme";

const changeEvent = "ha:theme-change";

function getPreference(): ThemePreference {
  const preference = document.documentElement.dataset.themePreference;
  return preference === "light" || preference === "dark" ? preference : "system";
}

function applyTheme(preference: ThemePreference) {
  const theme = preference === "system" ? (window.matchMedia(SYSTEM_THEME_QUERY).matches ? "dark" : "light") : preference;
  const root = document.documentElement;
  root.dataset.themePreference = preference;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[theme]);
}

function subscribe(onChange: () => void) {
  const media = window.matchMedia(SYSTEM_THEME_QUERY);
  const sync = () => {
    applyTheme(getPreference());
    onChange();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    const preference = event.newValue;
    applyTheme(preference === "light" || preference === "dark" ? preference : "system");
    onChange();
  };

  window.addEventListener(changeEvent, sync);
  window.addEventListener("storage", onStorage);
  media.addEventListener("change", sync);
  sync();

  return () => {
    window.removeEventListener(changeEvent, sync);
    window.removeEventListener("storage", onStorage);
    media.removeEventListener("change", sync);
  };
}

function setTheme(preference: ThemePreference) {
  applyTheme(preference);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Keep switching available even when the browser blocks persistent storage.
  }
  window.dispatchEvent(new Event(changeEvent));
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getPreference, () => "system" as const);
  return { theme, setTheme };
}
