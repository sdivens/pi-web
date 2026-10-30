/**
 * Reading a pi-tui `SelectList` out of an extension's custom UI component.
 *
 * `ctx.ui.custom()` hands the extension a TUI; whatever component the factory
 * returns is rendered headlessly here (`render(width)` → `lines`) and painted as
 * terminal text in the browser. A `SelectList` takes mouse input in the terminal,
 * and pi-web has no mouse there — so a list panel was keyboard-only.
 *
 * This module recognizes the list the extension already returned (pi-tui's
 * `SelectList`, either the component itself, a lone child of a `Container`, or a
 * `list` property of a wrapper) and describes it well enough to be drawn as a
 * native list. Nothing is asked of the extension: no option, no field, no
 * convention — an extension that returns something else keeps the text panel.
 *
 * Everything here reads the component through duck typing: pi-tui's class
 * declares those members `private`, which is compile-time only, so `items`,
 * `filteredItems` and `selectedIndex` are ordinary properties at runtime.
 *
 * The rules are deliberately narrow (see `findCustomUiList`): a container with
 * several children is *not* unwrapped, because a list inside a larger layout is
 * only part of what the extension draws, and dropping the rest would break it.
 */

import type { ExtensionCustomList, ExtensionCustomListItem } from "./types";

/** How deep `findCustomUiList` looks for the list below the returned component. */
const MAX_LIST_DEPTH = 2;

/** The members a `SelectList` must have before we treat an object as one. */
export interface CustomUiListLike {
  items?: unknown;
  filteredItems: unknown[];
  selectedIndex?: unknown;
  setSelectedIndex?: unknown;
  handleInput?: unknown;
}

function isListLike(value: unknown): value is CustomUiListLike {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.filteredItems)
    && typeof candidate.setSelectedIndex === "function"
    && typeof candidate.handleInput === "function"
  );
}

function isListLikeItem(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as { label?: unknown; value?: unknown };
  return typeof item.label === "string" || typeof item.value === "string";
}

/**
 * The `SelectList` an extension's custom UI component renders, or null.
 *
 * Recognized shapes, in order:
 *   - the component *is* the list (extensions may return `SelectList` directly);
 *   - a `Container` with exactly one child that is the list (`new Container().addChild(list)`);
 *   - a wrapper object with a `list` property (`class Picker { list = new SelectList(...) }`).
 *
 * A container with two or more children is left alone: the list would be one part
 * of a bigger frame, and rendering only the list would hide the rest.
 */
export function findCustomUiList(component: unknown, depth = 0): CustomUiListLike | null {
  if (!component || typeof component !== "object") return null;
  if (isListLike(component)) return isListLikeItems(component.filteredItems) ? component : null;
  if (depth >= MAX_LIST_DEPTH) return null;

  const children = (component as { children?: unknown }).children;
  if (Array.isArray(children) && children.length === 1) {
    return findCustomUiList(children[0], depth + 1);
  }
  if (Array.isArray(children) && children.length > 1) return null;

  return findCustomUiList((component as { list?: unknown }).list, depth + 1);
}

/** A list whose entries we can actually label; an opaque list stays a text panel. */
function isListLikeItems(items: unknown[]): boolean {
  return items.length === 0 || items.every(isListLikeItem);
}

function toListItem(value: unknown): ExtensionCustomListItem {
  const item = value as { label?: unknown; value?: unknown; description?: unknown };
  const label = typeof item.label === "string" && item.label.length > 0
    ? item.label
    : typeof item.value === "string"
      ? item.value
      : "";
  return typeof item.description === "string" && item.description.length > 0
    ? { label, description: item.description }
    : { label };
}

/**
 * What the browser needs to draw the list: the *filtered* entries in the order the
 * component shows them, plus which one is selected.
 *
 * `total` is the unfiltered count, so the client can say "3/120" while the
 * extension's own fuzzy filter is what decides the matches — the browser never
 * filters anything itself.
 */
export function describeCustomUiList(component: unknown): ExtensionCustomList | null {
  const list = findCustomUiList(component);
  if (!list) return null;
  const items = list.filteredItems.map(toListItem);
  const rawIndex = typeof list.selectedIndex === "number" ? list.selectedIndex : -1;
  const selectedIndex = Number.isFinite(rawIndex)
    ? Math.min(Math.max(Math.round(rawIndex), -1), items.length - 1)
    : -1;
  const total = Array.isArray(list.items) ? list.items.length : items.length;
  return { items, selectedIndex, total };
}

/**
 * The query the user has typed into the native panel, updated exactly like the
 * hidden textarea's keys already reach the extension.
 *
 * This is an **echo only**: the list itself always shows what the extension's own
 * filter produced. Getting this text wrong can only mislabel the box, never pick
 * the wrong entry — which is why it is allowed to duplicate these three rules.
 */
export function applyListQuery(query: string, data: string): string {
  if (data === "\x7f" || data === "\x08") return Array.from(query).slice(0, -1).join("");
  if (data === "\x15") return "";

  const pasteStart = "\x1b[200~";
  const pasteEnd = "\x1b[201~";
  if (data.startsWith(pasteStart)) {
    const body = data.slice(pasteStart.length);
    const text = body.endsWith(pasteEnd) ? body.slice(0, -pasteEnd.length) : body;
    return query + text.replace(/[\r\n\t]+/g, " ");
  }

  // Escape sequences (arrows, Esc) and Enter/Tab/Ctrl-C are navigation, not text.
  if (data.startsWith("\x1b")) return query;
  if (data === "\r" || data === "\n" || data === "\t" || data === "\x03") return query;

  let printable = true;
  for (const char of data) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) printable = false;
  }
  return printable ? query + data.replace(/[\r\n\t]+/g, " ") : query;
}
