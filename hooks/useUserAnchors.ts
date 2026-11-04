"use client";

import { useEffect, useState } from "react";
import { fetchUserAnchors, type UserAnchorEntry } from "@/lib/user-anchors";

/**
 * Every question on the session's branch, for the chat's rail.
 *
 * Refetched when the session changes and when a turn adds messages: a queued
 * prompt or a compaction can add a question the rail has not seen. While a reply
 * streams in, nothing is refetched — the prompt already landed, and a request
 * per chunk would be noise. The list stays empty on failure, which leaves the
 * rail on its own loaded page rather than on nothing.
 */
export function useUserAnchors(sessionId: string | null | undefined, revision: number, busy: boolean): UserAnchorEntry[] {
  const [anchors, setAnchors] = useState<UserAnchorEntry[]>([]);

  useEffect(() => {
    if (!sessionId) {
      setAnchors([]);
      return;
    }
    if (busy) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetchUserAnchors(sessionId, controller.signal).then((next) => {
        if (controller.signal.aborted || !next) return;
        setAnchors(next);
      });
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [busy, revision, sessionId]);

  return anchors;
}
