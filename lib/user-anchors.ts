/**
 * The user's own messages on a session's active branch, as the minimap's rail
 * needs them: an entry id to jump to, and text to show.
 *
 * The rail cannot be built from the messages the browser holds: those are one
 * page of the branch (`?tail=50` and up), so a long session showed a handful of
 * nodes and no way back to anything older. `GET /api/sessions/[id]/user-anchors`
 * reads the whole branch on the server and returns only these rows — an id and
 * a first line, tens of kilobytes for a thousand messages, against the megabytes
 * the same history would cost as messages.
 */

export interface UserAnchorEntry {
  /** The `.jsonl` entry id: what `?before=` pages around and a click jumps to. */
  entryId: string;
  /** First non-empty line of the question, capped for the rail's preview. */
  text: string;
  /** The entry's timestamp, when the file has one. */
  at: string | null;
}

/** How much of a question the rail's preview keeps (it wraps and clamps). */
export const USER_ANCHOR_TEXT_MAX = 200;

/**
 * A question's first non-empty line, with runs of whitespace collapsed.
 *
 * Only the start of it: the rail's preview shows a few lines, and this travels
 * once per question for a whole branch. `max` counts code points, so a cap never
 * cuts a surrogate pair in half.
 */
export function anchorText(content: unknown, max: number = USER_ANCHOR_TEXT_MAX): string {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
        .flatMap((block) => (
          block && typeof block === "object" && (block as { type?: unknown }).type === "text"
            && typeof (block as { text?: unknown }).text === "string"
            ? [(block as { text: string }).text]
            : []
        ))
        .join("\n")
      : "";
  const firstLine = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find((line) => line.length > 0) ?? "";
  const points = Array.from(firstLine);
  return points.length > max ? `${points.slice(0, max).join("")}…` : firstLine;
}

/** One entry of the JSONL, as far as the anchors are read. */
export interface AnchorEntry {
  id: string;
  type?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown } | null;
}

/**
 * The user's messages among `branch`, in context order.
 *
 * "The user's own" is `type === "message" && role === "user"`: `!` commands are
 * `role: "bashExecution"`, and an extension's reminders are `custom_message`
 * entries, neither of which is a question the user asked.
 */
export function collectUserAnchors(branch: readonly AnchorEntry[]): UserAnchorEntry[] {
  const anchors: UserAnchorEntry[] = [];
  for (const entry of branch) {
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    anchors.push({
      entryId: entry.id,
      text: anchorText(entry.message.content),
      at: typeof entry.timestamp === "string" ? entry.timestamp : null,
    });
  }
  return anchors;
}

/** Read the rail's anchors for a session. `null` when the request fails. */
export async function fetchUserAnchors(
  sessionId: string,
  signal?: AbortSignal,
): Promise<UserAnchorEntry[] | null> {
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/user-anchors`, { signal });
    if (!response.ok) return null;
    const data = await response.json() as { anchors?: unknown };
    if (!Array.isArray(data.anchors)) return null;
    return data.anchors.filter((anchor): anchor is UserAnchorEntry => (
      !!anchor && typeof anchor === "object"
      && typeof (anchor as UserAnchorEntry).entryId === "string"
      && typeof (anchor as UserAnchorEntry).text === "string"
    ));
  } catch {
    return null;
  }
}
