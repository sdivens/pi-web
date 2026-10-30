import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

function makeInner(overrides = {}) {
  return {
    sessionId: "custom-list-session",
    sessionFile: undefined,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    model: undefined,
    modelRuntime: { getModel: () => undefined, refresh: async () => {} },
    sessionManager: { getCwd: () => process.cwd(), getEntries: () => [] },
    settingsManager: { setProjectTrusted: () => {}, getDefaultTools: () => undefined },
    agent: { state: {} },
    extensionRunner: {
      getRegisteredCommands: () => [],
      setUIContext: () => {},
      emit: async () => {},
    },
    promptTemplates: [],
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    subscribe: () => () => {},
    getContextUsage: () => null,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    getActiveToolNames: () => ["read"],
    getAllTools: () => [],
    setActiveToolsByName: () => {},
    pendingMessageCount: 0,
    dispose: () => {},
    reload: async () => {},
    ...overrides,
  };
}

/**
 * A pi-tui `SelectList` stand-in: `value`/`label`/`description` entries, a filter
 * the test drives, and the behaviour the wrapper relies on (`setSelectedIndex`
 * moves the cursor, `handleInput("\r")` confirms through `onSelect`).
 */
function fakeList(values) {
  const items = values.map((value, index) => ({
    value,
    label: `question ${index + 1}`,
    description: `#${index + 1}`,
  }));
  const list = {
    items,
    filteredItems: items,
    selectedIndex: items.length - 1,
    confirms: [],
    setFilter(query) {
      this.filteredItems = query ? items.filter((item) => item.label.includes(query)) : items;
      this.selectedIndex = 0;
    },
    setSelectedIndex(index) {
      this.selectedIndex = index;
    },
    handleInput(data) {
      if (data === "\x1b[A") this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      else if (data === "\x1b[B") this.selectedIndex = Math.min(this.filteredItems.length - 1, this.selectedIndex + 1);
      else if (data === "\r") {
        const item = this.filteredItems[this.selectedIndex];
        if (item) list.onSelect?.(item);
      }
    },
    render: () => ["ignored text panel line"],
    onSelect: undefined,
  };
  return list;
}

async function withContext(run) {
  const events = [];
  const wrapper = new AgentSessionWrapper(makeInner());
  wrapper.onEvent((event) => events.push(event));
  try {
    // `custom()` mounts the component in a microtask; wait for its first render.
    await run({ context: wrapper.createExtensionUiContext(), events, wrapper });
  } finally {
    wrapper.destroy();
  }
}

/** `custom()` mounts the component in a microtask; wait for its first render. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

function customEvents(events) {
  return events.filter((event) => event.type === "extension_ui_request" && event.method === "custom");
}

test("a custom panel backed by a SelectList also travels as a list", () => withContext(async ({ context, events, wrapper }) => {
  const list = fakeList(["u1", "u2", "u3"]);

  const done = context.custom((_tui, _theme, _keybindings, finish) => {
    list.onSelect = (item) => finish(item.value);
    return list;
  });
  await settled();

  const event = customEvents(events).at(-1);
  assert.deepEqual(event.lines, ["ignored text panel line"]);
  assert.deepEqual(event.list, {
    items: [
      { label: "question 1", description: "#1" },
      { label: "question 2", description: "#2" },
      { label: "question 3", description: "#3" },
    ],
    selectedIndex: 2,
    total: 3,
  });

  // The terminal path still works: keys go to the extension's list.
  await wrapper.send({ type: "extension_ui_input", id: event.id, data: "\x1b[A" });
  assert.equal(list.selectedIndex, 1);

  list.setFilter("question 2");
  await wrapper.send({ type: "extension_ui_input", id: event.id, data: "x" });
  assert.deepEqual(customEvents(events).at(-1).list.items, [{ label: "question 2", description: "#2" }]);
  assert.equal(customEvents(events).at(-1).list.total, 3);

  // A click selects and confirms through the extension's own list.
  await wrapper.send({ type: "extension_ui_list_select", id: event.id, index: 0 });
  assert.equal(await done, "u2");
  assert.equal(customEvents(events).at(-1).closed, true);
}));

test("a click on a custom panel that is not a list does nothing", () => withContext(async ({ context, events, wrapper }) => {
  context.custom(() => ({ render: () => ["plain text"], handleInput: () => {} }));
  await settled();

  const event = customEvents(events).at(-1);
  assert.equal(event.list, undefined);
  await wrapper.send({ type: "extension_ui_list_select", id: event.id, index: 0 });
  assert.equal(customEvents(events).at(-1).closed, undefined);
}));

test("an out-of-range or unknown click is ignored", () => withContext(async ({ context, events, wrapper }) => {
  const list = fakeList(["u1"]);
  context.custom((_tui, _theme, _keybindings, finish) => {
    list.onSelect = (item) => finish(item.value);
    return list;
  });
  await settled();

  const event = customEvents(events).at(-1);
  const before = customEvents(events).length;
  await wrapper.send({ type: "extension_ui_list_select", id: event.id, index: 9 });
  await wrapper.send({ type: "extension_ui_list_select", id: event.id, index: -1 });
  await wrapper.send({ type: "extension_ui_list_select", id: "nope", index: 0 });
  assert.equal(customEvents(events).length, before);
}));

test("a container with a single list child is a list panel too", () => withContext(async ({ context, events }) => {
  const list = fakeList(["u1", "u2"]);
  // A real `Container` renders too; without `render` pi-web does not mount the panel.
  const container = { children: [list], render: () => [], addChild() {} };

  context.custom(() => container);
  await settled();

  assert.deepEqual(customEvents(events).at(-1).list.selectedIndex, 1);
  assert.equal(customEvents(events).at(-1).list.total, 2);
}));
