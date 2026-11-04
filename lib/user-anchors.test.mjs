import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { anchorText, collectUserAnchors, fetchUserAnchors } = await jiti.import("./user-anchors.ts");

test("a question's label is its first non-empty line", () => {
  assert.equal(anchorText("\n\n  第一条\n第二条  "), "第一条");
  assert.equal(anchorText("一条很长的提问"), "一条很长的提问");
});

test("whitespace inside the line is collapsed, so one row is one line", () => {
  assert.equal(anchorText("第一段   有很多\t空白\n第二段"), "第一段 有很多 空白");
});

test("content blocks: text joined, images do not become text", () => {
  assert.equal(
    anchorText([{ type: "image", data: "…", mimeType: "image/png" }, { type: "text", text: "看这张图" }]),
    "看这张图",
  );
});

test("the cap counts code points, so an emoji is never cut in half", () => {
  const text = anchorText("😀".repeat(10), 4);
  assert.equal(Array.from(text).length, 5);
  assert.ok(text.endsWith("…"));
  assert.equal(text, "😀😀😀😀…");
});

test("only the user's own messages become anchors", () => {
  const anchors = collectUserAnchors([
    { id: "h", type: "session" },
    { id: "u1", type: "message", timestamp: "t1", message: { role: "user", content: "第一个问题" } },
    { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
    { id: "t1", type: "message", message: { role: "toolResult", content: [] } },
    { id: "b1", type: "message", message: { role: "bashExecution", command: "ls" } },
    { id: "c1", type: "custom_message", message: { role: "custom", content: "reminder" } },
    { id: "k1", type: "compaction", summary: "sum" },
    { id: "u2", type: "message", message: { role: "user", content: [{ type: "text", text: "第二个问题" }] } },
  ]);
  assert.deepEqual(anchors, [
    { entryId: "u1", text: "第一个问题", at: "t1" },
    { entryId: "u2", text: "第二个问题", at: null },
  ]);
});

test("an image-only question keeps its place with an empty label", () => {
  const [anchor] = collectUserAnchors([
    { id: "u1", type: "message", message: { role: "user", content: [{ type: "image", data: "…", mimeType: "image/png" }] } },
  ]);
  assert.equal(anchor.text, "");
});

test("the fetch keeps only well-formed rows, and null means 'no list'", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      anchors: [{ entryId: "u1", text: "ok" }, { entryId: 2 }, "nope", { entryId: "u2" }],
    }), { status: 200 });
    assert.deepEqual(await fetchUserAnchors("s"), [{ entryId: "u1", text: "ok" }]);

    globalThis.fetch = async () => new Response("no", { status: 500 });
    assert.equal(await fetchUserAnchors("s"), null);

    globalThis.fetch = async () => { throw new Error("offline"); };
    assert.equal(await fetchUserAnchors("s"), null);
  } finally {
    globalThis.fetch = original;
  }
});
