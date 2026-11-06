import { useSyncExternalStore } from "react";

/**
 * How many questions the chat's rail carries at once (Settings › General › Chat).
 *
 * A per-browser choice, like where the sidebar keeps its files: a phone's rail is
 * hidden and a wide desktop can afford more dots, so one browser's answer is not
 * another's. The default is what the rail shipped with; the bounds keep it usable
 * (fewer than five dots is not a rail, more than fifty is the pile it replaced).
 */
export const MINIMAP_WINDOW_STORAGE_KEY = "pi-web:minimap-window";
export const MINIMAP_WINDOW_DEFAULT = 10;
export const MINIMAP_WINDOW_MIN = 5;
export const MINIMAP_WINDOW_MAX = 50;
/** The choices Settings offers; any stored value in range is honoured. */
export const MINIMAP_WINDOW_CHOICES = [5, 10, 20, 50] as const;

export function clampMinimapWindow(value: unknown): number {
  const size = Number(value);
  if (!Number.isFinite(size)) return MINIMAP_WINDOW_DEFAULT;
  return Math.max(MINIMAP_WINDOW_MIN, Math.min(MINIMAP_WINDOW_MAX, Math.round(size)));
}

/** A stored value, or the default when there is none or it makes no sense. */
export function parseMinimapWindow(raw: string | null): number {
  if (raw === null || raw.trim() === "") return MINIMAP_WINDOW_DEFAULT;
  return clampMinimapWindow(raw);
}

function readStoredWindow(): number {
  try {
    return parseMinimapWindow(window.localStorage.getItem(MINIMAP_WINDOW_STORAGE_KEY));
  } catch {
    return MINIMAP_WINDOW_DEFAULT;
  }
}

let windowSize: number | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): number {
  if (windowSize === null) windowSize = readStoredWindow();
  return windowSize;
}

function notify(): void {
  listeners.forEach((listener) => listener());
}

// Another tab chose; `key` is null when that tab cleared its storage.
function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== MINIMAP_WINDOW_STORAGE_KEY) return;
  const next = readStoredWindow();
  if (next === windowSize) return;
  windowSize = next;
  notify();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener("storage", onStorage);
    // Nobody listened for another tab's choice meanwhile.
    windowSize = readStoredWindow();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export function setMinimapWindow(next: number): void {
  const size = clampMinimapWindow(next);
  if (size === getSnapshot()) return;
  windowSize = size;
  try {
    window.localStorage.setItem(MINIMAP_WINDOW_STORAGE_KEY, String(size));
  } catch {
    // Applies in memory even if the browser cannot save it.
  }
  notify();
}

export function useMinimapWindow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, () => MINIMAP_WINDOW_DEFAULT);
}
