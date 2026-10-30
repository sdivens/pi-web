import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ExtensionCustomListPanel } = await jiti.import("./ExtensionCustomListPanel.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function render(props) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(ExtensionCustomListPanel, props)),
  );
}

const list = {
  items: [
    { label: "第一个问题", description: "第 1 条" },
    { label: "第二个问题" },
  ],
  selectedIndex: 1,
  total: 5,
};

test("draws one option per entry the extension matched", () => {
  const html = render({ list, query: "", onSelect: () => {} });

  assert.match(html, /role="listbox"/);
  assert.match(html, /role="option"/g);
  assert.match(html, /第一个问题/);
  assert.match(html, /第 1 条/);
  assert.match(html, /第二个问题/);
  // the count line uses the unfiltered total, so a filter reads as "2 of 5"
  assert.match(html, /2 of 5/);
});

test("marks the extension's own cursor, not a local one", () => {
  const html = render({ list, query: "", onSelect: () => {} });
  const options = html.split('role="option"').slice(1);

  assert.match(options[0], /aria-selected="false"/);
  assert.match(options[1], /aria-selected="true"/);
  assert.match(options[1], /data-extension-list-item="1"/);
});

test("shows the echoed filter and an empty state", () => {
  const html = render({
    list: { items: [], selectedIndex: -1, total: 5 },
    query: " 不存在 ",
    onSelect: () => {},
  });

  // The provider defaults to English in this harness (as in ExtensionWidgets.test.mjs).
  assert.match(html, /Nothing matches\./);
  assert.doesNotMatch(html, /role="option"/);
  assert.match(html, /Filter: 不存在/);
});

test("without a query the header row carries the key hints instead", () => {
  const html = render({ list, query: "", onSelect: () => {} });
  assert.match(html, /Enter confirm/);
  assert.doesNotMatch(html, /Filter:/);
  assert.doesNotMatch(html, /undefined/);
});
