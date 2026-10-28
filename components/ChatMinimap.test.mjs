import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createJiti } from "jiti";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".module.css")) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: "export default new Proxy({}, { get: (_, key) => String(key) });",
    };
  },
});

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { collectMinimapAnchors } = await jiti.import("./ChatMinimap.tsx");

// The shapes ChatWindow's own walk and this one must agree on.
const user = (text) => ({ role: "user", content: text });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
const toolResult = () => ({ role: "toolResult", content: [{ type: "text", text: "out" }] });
const compaction = () => ({ role: "custom", customType: "compaction", display: true, content: "summary" });
const subagentNotice = () => ({
  role: "custom",
  customType: "pi-web:subagent-notification",
  display: true,
  content: "done",
});
const hiddenCustom = () => ({ role: "custom", customType: "note", display: false, content: "hidden" });
const otherCustom = () => ({ role: "custom", customType: "note", display: true, content: "inside the turn" });

test("lists only the user's own messages, in order", () => {
  const anchors = collectMinimapAnchors([
    user("first prompt"),
    assistant("answer"),
    user("second prompt"),
    assistant("answer"),
    user("third prompt"),
  ]);

  assert.deepEqual(anchors.map((anchor) => anchor.message.content), [
    "first prompt",
    "second prompt",
    "third prompt",
  ]);
  assert.deepEqual(anchors.map((anchor) => anchor.messageIndex), [0, 2, 4]);
});

test("counts every row the chat renders, so later nodes keep their row", () => {
  // Compaction dividers, subagent notifications and assistant replies are rows
  // in the chat (`messageRefs`). They take a refIndex and no node: skipping them
  // would move the next user message's node onto another message.
  const anchors = collectMinimapAnchors([
    user("before"),
    assistant("answer"),
    compaction(),
    assistant("answer"),
    subagentNotice(),
    assistant("answer"),
    user("after"),
  ]);

  assert.deepEqual(anchors.map((anchor) => anchor.message.content), ["before", "after"]);
  // u0 · a1 · compaction2 · a3 · notice4 · a5 → u6 is the sixth row.
  assert.deepEqual(anchors.map((anchor) => anchor.refIndex), [0, 6]);
});

test("ignores rows the chat does not render", () => {
  const anchors = collectMinimapAnchors([
    user("prompt"),
    hiddenCustom(),
    otherCustom(),
    toolResult(),
    assistant("answer"),
  ]);

  assert.deepEqual(anchors.map((anchor) => anchor.message.content), ["prompt"]);
  assert.deepEqual(anchors.map((anchor) => anchor.refIndex), [0]);
});

test("lists nothing for a page without a user message", () => {
  // A compaction divider plus the replies that follow it, e.g. the first page of
  // a compacted session whose prompt sits above it.
  const anchors = collectMinimapAnchors([compaction(), assistant("step"), toolResult(), assistant("answer")]);
  assert.deepEqual(anchors, []);
});

test("reads the text of an image prompt and skips empty ones", () => {
  const anchors = collectMinimapAnchors([
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "", mimeType: "image/png" }] },
    { role: "user", content: [] },
  ]);
  assert.equal(anchors.length, 2);
  assert.deepEqual(anchors.map((anchor) => anchor.refIndex), [0, 1]);
});
