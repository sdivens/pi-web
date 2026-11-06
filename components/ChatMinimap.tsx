"use client";

import { memo, useEffect, useRef, useState, useCallback, useMemo, type RefObject } from "react";
import { isMessageGroupAnchor } from "@/lib/message-display";
import type { UserAnchorEntry } from "@/lib/user-anchors";
import { loadMinimapPreviewLocked, saveMinimapPreviewLocked } from "@/lib/minimap-preview-lock";
import type { AgentMessage, TextContent, UserMessage } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import styles from "./ChatMinimap.module.css";

interface Props {
  messages: AgentMessage[];
  /** Which session this rail belongs to: another one reopens the default window. */
  sessionKey?: string | null;
  /** `entryIds[i]` belongs to `messages[i]`: how a question finds its row. */
  entryIds?: string[];
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
  /**
   * Every question on the branch (`GET /api/sessions/[id]/user-anchors`), in
   * context order. Empty or missing → the rail falls back to the messages the
   * browser has, which is all it can do without the server's list.
   */
  anchors?: UserAnchorEntry[];
  /** Page in and jump to a question that is not loaded yet. */
  onRevealAnchor?: (entryId: string) => void;
  onRevealHistory: () => void;
  /** Turns of the branch the server has not sent yet (#791); fallback only. */
  turnsBefore: number;
}

/**
 * Questions the rail carries at a time, newest last. A session of fifty turns
 * drew fifty evenly spaced dots — too dense to aim at — so it keeps a window and
 * the preview's "earlier questions" row widens it by this much per click.
 */
export const MINIMAP_VISIBLE_QUESTIONS = 10;
const MINIMAP_WIDTH = 36;
const MAX_NODE_GAP = 50;
const MINIMAP_PADDING = 12;
// The lock button sits at the bottom of the rail (6px inset + 30px): nodes stop
// above it so the last turn stays visible and clickable.
const MINIMAP_BOTTOM_PADDING = 36 + MINIMAP_PADDING;
const PREVIEW_HIDE_DELAY = 250;
const NAVIGATION_ACTIVE_LOCK_MS = 1600;

export interface MinimapAnchor {
  /** Index in the message list this anchor was found at. */
  messageIndex: number;
  /** Index into the chat's `messageRefs`, whose walk counts the rows it renders. */
  refIndex: number;
  message: UserMessage;
}

/**
 * The rail lists the user's own messages, one node each: turn numbers and the
 * assistant replies a turn holds are not shown. `refIndex` still counts every
 * row the chat renders (`isMessageGroupAnchor()` messages and assistant
 * replies, as ChatWindow's own walk does), so compaction dividers, subagent
 * notifications and replies take their place in the count without becoming
 * nodes: skipping one here would put every node on another message.
 */
export function collectMinimapAnchors(
  messages: (AgentMessage | Partial<AgentMessage>)[],
): MinimapAnchor[] {
  const anchors: MinimapAnchor[] = [];
  let refIndex = 0;
  messages.forEach((message, messageIndex) => {
    if (!isMessageGroupAnchor(message) && message.role !== "assistant") return;
    const rowIndex = refIndex++;
    if (message.role !== "user") return;
    anchors.push({ messageIndex, refIndex: rowIndex, message: message as UserMessage });
  });
  return anchors;
}

function getUserPreview(message: UserMessage): string {
  if (typeof message.content === "string") return message.content.trim();
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

interface TurnInfo {
  /** The question's entry id: what a click pages to and scrolls to. */
  entryId: string;
  /** First line, from the server's list (or the loaded message's own text). */
  text: string;
  scrollTop: number | null;
}

/**
 * The newest `visible` questions: the rail's window over the branch.
 *
 * Newest last, as the list and the chat are ordered, so the dock at the bottom
 * of the rail is always the latest question.
 */
export function windowAnchors<T>(anchors: readonly T[], visible: number): readonly T[] {
  if (visible <= 0) return [];
  return anchors.length > visible ? anchors.slice(-visible) : anchors;
}

/**
 * The rail's nodes: every question the server knows about, each matched to a row
 * the chat has measured. A question whose page is not loaded yet keeps
 * `scrollTop: null`, and a click pages that history in instead of scrolling.
 */
export function mergeMinimapNodes(
  anchors: readonly { entryId: string; text: string }[],
  scrollTopByEntry: ReadonlyMap<string, number>,
): TurnInfo[] {
  return anchors.map((anchor) => ({
    entryId: anchor.entryId,
    text: anchor.text,
    scrollTop: scrollTopByEntry.get(anchor.entryId) ?? null,
  }));
}

interface NodeInfo {
  topRatio: number;
  targetTurn: TurnInfo;
  index: number;
}

function createTurnNodes(turns: TurnInfo[]): NodeInfo[] {
  return turns.map((turn, index) => ({
    topRatio: 0,
    targetTurn: turn,
    index,
  }));
}

interface NodeLayout {
  nodes: NodeInfo[];
  gap: number;
  fillsHeight: boolean;
}

function layoutNodes(allNodes: NodeInfo[], minimapHeight: number): NodeLayout {
  if (allNodes.length === 0) {
    return { nodes: [], gap: MAX_NODE_GAP, fillsHeight: false };
  }

  const height = Math.max(1, minimapHeight);
  const usableHeight = Math.max(0, height - MINIMAP_PADDING - MINIMAP_BOTTOM_PADDING);
  if (allNodes.length === 1) {
    return {
      nodes: [{ ...allNodes[0], topRatio: MINIMAP_PADDING / height }],
      gap: MAX_NODE_GAP,
      fillsHeight: false,
    };
  }

  const naturalGap = usableHeight / (allNodes.length - 1);
  const gap = Math.min(MAX_NODE_GAP, naturalGap);
  return {
    nodes: allNodes.map((node, index) => ({
      ...node,
      topRatio: (MINIMAP_PADDING + index * gap) / height,
    })),
    gap,
    fillsHeight: naturalGap <= MAX_NODE_GAP,
  };
}

/**
 * One question in the preview.
 *
 * Memoized on `located` alone: the rail of a long session lists every question,
 * and a pointer moving along it changed a prop of one row per step — without
 * this, each move re-rendered the whole list.
 */
const PreviewRow = memo(function PreviewRow({
  node,
  located,
  unloadedLabel,
  registerItem,
  onSelect,
}: {
  node: NodeInfo;
  located: boolean;
  unloadedLabel: string;
  registerItem: (index: number, element: HTMLDivElement | null) => void;
  onSelect: (node: NodeInfo, behavior: ScrollBehavior) => void;
}) {
  const unloaded = node.targetTurn.scrollTop === null;
  return (
    <div
      ref={(element) => registerItem(node.index, element)}
      className={styles.turn}
      data-minimap-preview-index={node.index}
      data-located={located ? "true" : undefined}
    >
      <button
        type="button"
        className={styles.user}
        data-unloaded={unloaded ? "true" : undefined}
        title={unloaded ? unloadedLabel : undefined}
        onClick={() => onSelect(node, "smooth")}
      >
        <span className={styles.userText}>{node.targetTurn.text}</span>
      </button>
    </div>
  );
});

export const ChatMinimap = memo(function ChatMinimap({
  messages,
  sessionKey,
  entryIds,
  scrollContainer,
  messageRefs,
  anchors,
  onRevealAnchor,
  onRevealHistory,
  turnsBefore,
}: Props) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  const [allNodes, setAllNodes] = useState<NodeInfo[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [minimapHeight, setMinimapHeight] = useState(600);
  const [minimapHovered, setMinimapHovered] = useState(false);
  const [locked, setLocked] = useState(loadMinimapPreviewLocked);
  const [visibleQuestions, setVisibleQuestions] = useState(MINIMAP_VISIBLE_QUESTIONS);
  const [mouseYRatio, setMouseYRatio] = useState<number | null>(null);
  const draggingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const allNodesRef = useRef<NodeInfo[]>([]);
  const nodeLayoutRef = useRef<NodeLayout>({
    nodes: [],
    gap: MAX_NODE_GAP,
    fillsHeight: false,
  });
  const previewBoxRef = useRef<HTMLDivElement>(null);
  const previewItemRefs = useRef(new Map<number, HTMLDivElement>());
  const previewHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeNodeLockRef = useRef<{ index: number; until: number } | null>(null);
  // A node clicked before its row was mounted (older history still paging in).
  const pendingNavigationRef = useRef<string | null>(null);

  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Another session starts at the default window again.
  useEffect(() => {
    setVisibleQuestions(MINIMAP_VISIBLE_QUESTIONS);
  }, [sessionKey]);

  const shownAnchors = useMemo(
    () => (anchors && anchors.length > 0 ? windowAnchors(anchors, visibleQuestions) : null),
    [anchors, visibleQuestions],
  );
  const hiddenQuestions = anchors ? Math.max(0, anchors.length - visibleQuestions) : 0;
  const entryIdsRef = useRef(entryIds);
  entryIdsRef.current = entryIds;
  const anchorsRef = useRef<readonly UserAnchorEntry[] | null>(shownAnchors);
  anchorsRef.current = shownAnchors;

  const nodeLayout = useMemo(
    () => layoutNodes(allNodes, minimapHeight),
    [allNodes, minimapHeight],
  );
  const { nodes: positionedNodes, gap: nodeGap } = nodeLayout;
  nodeLayoutRef.current = nodeLayout;

  const registerPreviewItem = useCallback((index: number, element: HTMLDivElement | null) => {
    if (element) previewItemRefs.current.set(index, element);
    else previewItemRefs.current.delete(index);
  }, []);

  const lockActiveNode = useCallback((index: number) => {
    activeNodeLockRef.current = {
      index,
      until: Date.now() + NAVIGATION_ACTIVE_LOCK_MS,
    };
    setActiveIndex(index);
  }, []);

  const syncActiveNode = useCallback((scrollEl: HTMLDivElement, nextNodes: NodeInfo[]) => {
    const activeLock = activeNodeLockRef.current;
    if (activeLock && Date.now() < activeLock.until) {
      setActiveIndex(activeLock.index);
      return;
    }
    activeNodeLockRef.current = null;

    const measuredNodes = nextNodes.filter((node) => node.targetTurn.scrollTop !== null);
    if (measuredNodes.length === 0) {
      setActiveIndex(null);
      return;
    }
    const focusTop = scrollEl.scrollTop + scrollEl.clientHeight * 0.3;
    const nextActiveNode = measuredNodes.reduce((bestNode, node) => (
      Math.abs((node.targetTurn.scrollTop ?? 0) - focusTop)
        < Math.abs((bestNode.targetTurn.scrollTop ?? 0) - focusTop)
        ? node
        : bestNode
    ), measuredNodes[0]);
    setActiveIndex(nextActiveNode.index);
  }, []);

  const updateScroll = useCallback(() => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    const scrollable = scrollEl.scrollHeight - scrollEl.clientHeight;
    const currentNodes = allNodesRef.current;
    setVisible(scrollable > 20);
    syncActiveNode(scrollEl, currentNodes);
  }, [scrollContainer, syncActiveNode]);

  const measureThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const measureNodes = useCallback(() => {
    if (measureThrottleRef.current) return;
    measureThrottleRef.current = setTimeout(() => {
      measureThrottleRef.current = null;
      const scrollEl = scrollContainer.current;
      const minimapEl = containerRef.current;
      if (!scrollEl || !minimapEl) return;

      const refs = messageRefs.current;
      const containerRect = scrollEl.getBoundingClientRect();
      // Rows are counted exactly as ChatWindow renders them (anchor messages and
      // replies, one `messageRefs` slot each), so a loaded question's node lands
      // on its own row.
      const scrollTopByEntry = new Map<string, number>();
      const loadedQuestions: { entryId: string; text: string }[] = [];
      const rowEntryIds = entryIdsRef.current;
      let rowIndex = 0;
      messagesRef.current.forEach((message, messageIndex) => {
        if (!isMessageGroupAnchor(message) && message.role !== "assistant") return;
        const refIndex = rowIndex++;
        if (message.role !== "user") return;
        const entryId = rowEntryIds?.[messageIndex] ?? `#${messageIndex}`;
        loadedQuestions.push({ entryId, text: getUserPreview(message as UserMessage) });
        const elementRect = refs?.[refIndex]?.getBoundingClientRect();
        if (elementRect) {
          scrollTopByEntry.set(entryId, elementRect.top - containerRect.top + scrollEl.scrollTop);
        }
      });

      // The server's list when there is one: it knows the questions this page
      // does not hold. Without it, the loaded page is the rail.
      const source = anchorsRef.current && anchorsRef.current.length > 0
        ? anchorsRef.current
        : loadedQuestions;
      const nextNodes = createTurnNodes(mergeMinimapNodes(source, scrollTopByEntry));
      setMinimapHeight(minimapEl.clientHeight);
      allNodesRef.current = nextNodes;
      setAllNodes(nextNodes);
      setVisible(scrollEl.scrollHeight - scrollEl.clientHeight > 20);
      syncActiveNode(scrollEl, nextNodes);

      const pendingId = pendingNavigationRef.current;
      const pendingNode = pendingId === null
        ? null
        : nextNodes.find((node) => node.targetTurn.entryId === pendingId);
      const pendingTop = pendingNode?.targetTurn.scrollTop;
      if (!pendingNode || pendingTop === null || pendingTop === undefined) return;
      pendingNavigationRef.current = null;
      lockActiveNode(pendingNode.index);
      scrollEl.scrollTo({
        top: Math.max(0, pendingTop - scrollEl.clientHeight * 0.3),
        behavior: "smooth",
      });
    }, 150);
  }, [lockActiveNode, messageRefs, scrollContainer, syncActiveNode]);

  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    el.addEventListener("scroll", updateScroll, { passive: true });
    return () => el.removeEventListener("scroll", updateScroll);
  }, [scrollContainer, updateScroll]);

  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    const syncLayout = () => {
      measureNodes();
      updateScroll();
    };
    const ro = new ResizeObserver(syncLayout);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    syncLayout();
    return () => {
      ro.disconnect();
      if (measureThrottleRef.current) {
        clearTimeout(measureThrottleRef.current);
        measureThrottleRef.current = null;
      }
    };
  }, [measureNodes, scrollContainer, updateScroll]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      measureNodes();
      updateScroll();
    }, 50);
    return () => clearTimeout(timeout);
  }, [messages.length, shownAnchors, measureNodes, updateScroll]);

  const scrollToNode = useCallback((node: NodeInfo, behavior: ScrollBehavior) => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    lockActiveNode(node.index);
    if (node.targetTurn.scrollTop === null) {
      pendingNavigationRef.current = node.targetTurn.entryId;
      // The server's list knows questions this page left out: page them in and
      // scroll once the row mounts. Without it, only the window can widen.
      if (onRevealAnchor) onRevealAnchor(node.targetTurn.entryId);
      else onRevealHistory();
      return;
    }
    const targetTop = Math.max(
      0,
      node.targetTurn.scrollTop - scrollEl.clientHeight * 0.3,
    );
    scrollEl.scrollTo({ top: targetTop, behavior });
  }, [lockActiveNode, onRevealAnchor, onRevealHistory, scrollContainer]);

  const findNearestNode = useCallback((ratio: number): NodeInfo | null => {
    const { nodes, gap, fillsHeight } = nodeLayoutRef.current;
    const height = containerRef.current?.clientHeight ?? 0;
    if (nodes.length === 0 || height <= 0) return null;

    const pointerY = Math.max(0, Math.min(height, ratio * height));
    const firstNodeY = nodes[0].topRatio * height;
    const rawIndex = gap > 0 ? Math.round((pointerY - firstNodeY) / gap) : 0;
    const nodeIndex = Math.max(0, Math.min(nodes.length - 1, rawIndex));
    const nearestNode = nodes[nodeIndex];

    if (!fillsHeight) {
      const nodeY = nearestNode.topRatio * height;
      const hitRadius = Math.max(10, gap / 2);
      if (Math.abs(pointerY - nodeY) > hitRadius) return null;
    }
    return nearestNode;
  }, []);

  const cancelPreviewHide = useCallback(() => {
    if (!previewHideTimerRef.current) return;
    clearTimeout(previewHideTimerRef.current);
    previewHideTimerRef.current = null;
  }, []);

  const showPreview = useCallback(() => {
    if (locked) return;
    cancelPreviewHide();
    setMinimapHovered(true);
  }, [cancelPreviewHide, locked]);

  const toggleLock = useCallback(() => {
    const next = !locked;
    setLocked(next);
    saveMinimapPreviewLocked(next);
    if (next) {
      cancelPreviewHide();
      setMinimapHovered(false);
      setMouseYRatio(null);
    }
  }, [cancelPreviewHide, locked]);

  const schedulePreviewHide = useCallback(() => {
    cancelPreviewHide();
    previewHideTimerRef.current = setTimeout(() => {
      previewHideTimerRef.current = null;
      setMinimapHovered(false);
      setMouseYRatio(null);
    }, PREVIEW_HIDE_DELAY);
  }, [cancelPreviewHide]);

  useEffect(() => () => cancelPreviewHide(), [cancelPreviewHide]);

  const handleMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!visible) return;

    draggingRef.current = true;
    showPreview();
    const rect = event.currentTarget.getBoundingClientRect();
    const pointerRatio = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    setMouseYRatio(pointerRatio);
    const jumpToPointer = (clientY: number, behavior: ScrollBehavior) => {
      const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      const node = findNearestNode(ratio);
      if (node) {
        scrollToNode(node, behavior);
      }
    };

    jumpToPointer(event.clientY, "smooth");
    const onMove = (moveEvent: MouseEvent) => {
      if (!draggingRef.current) return;
      jumpToPointer(moveEvent.clientY, "auto");
    };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [findNearestNode, scrollToNode, showPreview, visible]);

  const nearestNode = mouseYRatio === null ? null : findNearestNode(mouseYRatio);
  const nearestNodeIndex = nearestNode?.index ?? null;

  useEffect(() => {
    if (!minimapHovered || nearestNodeIndex === null) return;
    const previewBox = previewBoxRef.current;
    const previewItem = previewItemRefs.current.get(nearestNodeIndex);
    if (!previewBox || !previewItem) return;
    const targetTop = previewItem.offsetTop
      - (previewBox.clientHeight - previewItem.offsetHeight) / 2;
    previewBox.scrollTop = Math.max(0, targetTop);
  }, [allNodes, minimapHovered, nearestNodeIndex]);

  if (!visible) return null;

  const lastNodeTop = positionedNodes.length > 0
    ? positionedNodes[positionedNodes.length - 1].topRatio * minimapHeight
    : MINIMAP_PADDING;
  const railHeight = Math.max(1, lastNodeTop - MINIMAP_PADDING);

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseEnter={showPreview}
      onMouseLeave={schedulePreviewHide}
      onMouseMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setMouseYRatio((event.clientY - rect.top) / rect.height);
      }}
      style={{
        width: MINIMAP_WIDTH,
        flexShrink: 0,
        position: "relative",
        cursor: "pointer",
        userSelect: "none",
        borderLeft: "1px solid var(--border)",
        background: "var(--bg-panel)",
        overflow: "visible",
      }}
    >
      {(hiddenQuestions > 0 || (turnsBefore > 0 && !anchors?.length)) && (
        <div
          data-minimap-earlier=""
          style={{
            position: "absolute",
            left: "50%",
            top: 0,
            height: MINIMAP_PADDING,
            width: 1,
            background: "repeating-linear-gradient(to bottom, var(--text-dim) 0 2px, transparent 2px 4px)",
            transform: "translateX(-50%)",
            zIndex: 0,
          }}
        />
      )}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: MINIMAP_PADDING,
          height: railHeight,
          width: 1,
          background: "var(--border)",
          transform: "translateX(-50%)",
          zIndex: 0,
        }}
      />

      {positionedNodes.map((node) => {
        const isNearest = minimapHovered && nearestNode?.index === node.index;
        const isActive = activeIndex === node.index;

        return (
          <div
            key={node.index}
            data-minimap-node-index={node.index}
            data-minimap-node-active={isActive ? "" : undefined}
            data-minimap-node-unloaded={node.targetTurn.scrollTop === null ? "true" : undefined}
            style={{
              position: "absolute",
              top: `${node.topRatio * 100}%`,
              transform: "translateY(-50%)",
              left: 0,
              right: 0,
              height: Math.max(1, nodeGap),
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
              zIndex: 2,
            }}
          >
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: isActive ? "rgba(128,128,128,0.42)" : "rgba(128,128,128,0.16)",
                border: `1.5px solid ${isActive
                  ? "rgba(128,128,128,0.95)"
                  : node.targetTurn.scrollTop === null
                    ? "rgba(128,128,128,0.35)"
                    : "rgba(128,128,128,0.58)"}`,
                boxShadow: isActive ? "0 0 0 2px var(--bg-panel)" : "none",
                transition: "transform 0.1s, background 0.1s",
                transform: isNearest ? "scale(1.25)" : "scale(1)",
              }}
            />
          </div>
        );
      })}

      <button
        type="button"
        className={styles.lock}
        data-minimap-lock={locked ? "on" : "off"}
        aria-pressed={locked}
        title={t(locked ? "chatMinimap.unlockPreview" : "chatMinimap.lockPreview")}
        aria-label={t("chatMinimap.lockPreview")}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          toggleLock();
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="4" y="11" width="16" height="10" rx="2" />
          {locked ? (
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          ) : (
            <path d="M8 11V7a4 4 0 0 1 7.9-.9" />
          )}
        </svg>
      </button>

      {minimapHovered && allNodes.length > 0 && (
        <div
          ref={previewBoxRef}
          className={styles.preview}
          data-minimap-preview-box=""
          onMouseEnter={showPreview}
          onMouseDown={(event) => event.stopPropagation()}
          onMouseMove={(event) => event.stopPropagation()}
        >
          {hiddenQuestions > 0 && (
            <button
              type="button"
              className={styles.earlier}
              data-minimap-preview-earlier=""
              data-minimap-preview-earlier-questions=""
              // Widen the window by another page of questions; each one then
              // pages its own history in when clicked.
              onClick={() => setVisibleQuestions((count) => count + MINIMAP_VISIBLE_QUESTIONS)}
            >
              {t("chatMinimap.earlierQuestions", { count: hiddenQuestions })}
            </button>
          )}
          {hiddenQuestions === 0 && turnsBefore > 0 && !anchors?.length && (
            <button
              type="button"
              className={styles.earlier}
              data-minimap-preview-earlier=""
              // The chat's top sentinel pages the older history in.
              onClick={() => scrollContainer.current?.scrollTo({ top: 0, behavior: "smooth" })}
            >
              {t("chatMinimap.earlierTurns")}
            </button>
          )}
          {allNodes.map((node) => (
            <PreviewRow
              key={node.index}
              node={node}
              located={nearestNodeIndex === node.index}
              unloadedLabel={t("chatMinimap.loadAnchor")}
              registerItem={registerPreviewItem}
              onSelect={scrollToNode}
            />
          ))}
        </div>
      )}
    </div>
  );
});

// Hook to create a stable array of refs for messages
export function useMessageRefs(count: number): RefObject<(HTMLDivElement | null)[]> {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  refs.current = Array(count).fill(null).map((_, i) => refs.current[i] ?? null);
  return refs;
}
