"use client";

import { useEffect, useRef } from "react";
import type { ExtensionCustomList } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";

/**
 * A custom panel's `SelectList`, drawn as a native list.
 *
 * The extension wrote its panel against pi's TUI: `SelectList` scrolls, filters and
 * takes mouse clicks there. Rendered as terminal text in the browser it had none of
 * that — so when the panel's component *is* a `SelectList` (detected on the server,
 * `lib/extension-custom-list.ts`), this draws the same entries as buttons.
 *
 * Neither text nor filtering is duplicated here: `list.items` is what the
 * extension's own fuzzy filter matched, in its order, and `selectedIndex` is its
 * cursor. A click reports the index and the server moves that `SelectList` — the
 * extension decides what a click means. Typing keeps going through the panel's
 * hidden textarea (one keystroke at a time, as from a terminal), and `query` is only
 * an echo of what was sent: if it disagrees with the extension, the list is still
 * right and only the echo reads oddly.
 */
export function ExtensionCustomListPanel({
  list,
  query,
  onSelect,
}: {
  list: ExtensionCustomList;
  /** What the user has typed into the panel's hidden textarea. */
  query: string;
  onSelect: (index: number) => void;
}) {
  const { t } = useI18n();
  const selectedRef = useRef<HTMLButtonElement>(null);

  // Keep the extension's cursor on screen as keys move it (each move arrives as a
  // fresh render from the server).
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [list.selectedIndex, list.items.length]);

  const trimmedQuery = query.trim();

  return (
    <div
      style={{
        flex: "1 1 auto",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-panel)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          padding: "8px 14px",
          borderBottom: "1px solid var(--border)",
          color: "var(--text-dim)",
          fontSize: 12,
        }}
      >
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: trimmedQuery ? "var(--text-muted)" : "var(--text-dim)",
          }}
        >
          {trimmedQuery
            ? t("chat.extensionListFilter", { query: trimmedQuery })
            : t("chat.extensionListFilter", { query: "" })}
        </span>
        <span style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
          {t("chat.extensionListCount", { shown: list.items.length, total: list.total })}
        </span>
      </div>

      <div
        role="listbox"
        aria-label={t("chat.extensionPanel")}
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          overflowY: "auto",
          padding: "8px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        {list.items.length === 0 ? (
          <div style={{ padding: "10px 4px", color: "var(--text-dim)", fontSize: 13 }}>
            {t("chat.extensionListEmpty")}
          </div>
        ) : (
          list.items.map((item, index) => {
            const selected = index === list.selectedIndex;
            return (
              <button
                key={`${index}-${item.label}`}
                ref={selected ? selectedRef : undefined}
                type="button"
                role="option"
                aria-selected={selected}
                data-extension-list-item={index}
                onClick={() => onSelect(index)}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 12,
                  width: "100%",
                  padding: "7px 10px",
                  borderRadius: 6,
                  border: "1px solid transparent",
                  borderColor: selected ? "color-mix(in srgb, var(--accent) 45%, transparent)" : "transparent",
                  background: selected ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent",
                  color: "var(--text)",
                  textAlign: "left",
                  cursor: "pointer",
                  fontSize: 13,
                  lineHeight: 1.45,
                }}
              >
                <span
                  style={{
                    flex: "1 1 auto",
                    minWidth: 0,
                    // One line per entry, like the terminal list: the extension already
                    // truncated to its own width, and a second line would fight the
                    // description beside it.
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontWeight: selected ? 600 : 400,
                  }}
                >
                  {item.label}
                </span>
                {item.description && (
                  <span
                    style={{
                      flexShrink: 0,
                      color: "var(--text-dim)",
                      fontSize: 12,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {item.description}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
