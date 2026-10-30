import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { applyListQuery, describeCustomUiList, findCustomUiList } = await jiti.import("./extension-custom-list.ts");

/** Just enough of pi-tui's `SelectList` for the duck typing: TS `private`, runtime plain. */
function fakeSelectList({ items = [], filtered = items, selectedIndex = 0, onSelect } = {}) {
  return {
    items,
    filteredItems: filtered,
    selectedIndex,
    setSelectedIndex(index) {
      this.selectedIndex = index;
    },
    handleInput(data) {
      if (data !== "\r") return;
      const item = this.filteredItems[this.selectedIndex];
      if (item) onSelect?.(item);
    },
    render: () => [],
  };
}

const ITEMS = [
  { value: "u1", label: "第一个问题", description: "第 1 条" },
  { value: "u2", label: "第二个问题" },
];

test("recognizes the list an extension returns directly", () => {
  const list = fakeSelectList({ items: ITEMS });
  assert.equal(findCustomUiList(list), list);
});

test("recognizes a list inside a container with a single child", () => {
  const list = fakeSelectList({ items: ITEMS });
  const container = { children: [list], addChild() {} };
  assert.equal(findCustomUiList(container), list);
});

test("recognizes a wrapper that keeps the list in a property", () => {
  const list = fakeSelectList({ items: ITEMS });
  const picker = { list, render: () => [], handleInput: () => {} };
  assert.equal(findCustomUiList(picker), list);
});

test("leaves a container with several children alone", () => {
  // A list inside a bigger frame is only part of what the extension draws; drawing
  // just the list would hide the rest.
  const list = fakeSelectList({ items: ITEMS });
  const frame = { children: [{ render: () => ["title"] }, list], addChild() {} };
  assert.equal(findCustomUiList(frame), null);
});

test("ignores components that are not lists", () => {
  assert.equal(findCustomUiList({ render: () => ["hello"] }), null);
  assert.equal(findCustomUiList(undefined), null);
  assert.equal(findCustomUiList("text"), null);
});

test("ignores a list whose entries cannot be labelled", () => {
  const opaque = fakeSelectList({ items: [{ id: 1 }, { id: 2 }] });
  assert.equal(findCustomUiList(opaque), null);
});

test("describes the filtered entries with the extension's cursor", () => {
  const filtered = [ITEMS[0]];
  const list = fakeSelectList({ items: ITEMS, filtered, selectedIndex: 0 });
  assert.deepEqual(describeCustomUiList(list), {
    items: [{ label: "第一个问题", description: "第 1 条" }],
    selectedIndex: 0,
    total: 2,
  });
});

test("clamps a stale cursor and reports an empty filter", () => {
  const list = fakeSelectList({ items: ITEMS, filtered: [], selectedIndex: 7 });
  assert.deepEqual(describeCustomUiList(list), { items: [], selectedIndex: -1, total: 2 });
});

test("falls back to the value when an entry has no label", () => {
  const list = fakeSelectList({ items: [{ value: "no-label" }] });
  assert.deepEqual(describeCustomUiList(list).items, [{ label: "no-label" }]);
});

test("returns null for components that are not lists", () => {
  assert.equal(describeCustomUiList({ render: () => [] }), null);
});

test("applyListQuery mirrors the extension's own key handling", () => {
  assert.equal(applyListQuery("", "旧"), "旧");
  assert.equal(applyListQuery("旧", "问"), "旧问");
  assert.equal(applyListQuery("旧问", "\x7f"), "旧");
  assert.equal(applyListQuery("旧问", "\x15"), "");
  // navigation, Enter and Ctrl-C are not text
  assert.equal(applyListQuery("旧问", "\x1b[A"), "旧问");
  assert.equal(applyListQuery("旧问", "\r"), "旧问");
  assert.equal(applyListQuery("旧问", "\x03"), "旧问");
  // bracketed paste keeps its text, newlines folded to spaces
  assert.equal(applyListQuery("", "\x1b[200~旧\n问\x1b[201~"), "旧 问");
  // an emoji is one character for backspace
  assert.equal(applyListQuery("旧😀", "\x7f"), "旧");
});
