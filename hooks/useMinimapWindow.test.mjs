import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("./useMinimapWindow.ts", import.meta.url), "utf8");
const script = new Script(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText);
const KEY = "pi-web:minimap-window";

// A fresh module per fixture: the store caches the choice at module level. The
// stand-in useSyncExternalStore subscribes once, as a mounted component does,
// and renders the server snapshot where there is no window.
function fixture({ initial = {}, blocked = false, server = false } = {}) {
  const stored = new Map(Object.entries(initial));
  const events = new Map();
  let unsubscribe = null;
  let notifications = 0;
  const storage = {
    getItem(key) { if (blocked) throw new Error("blocked"); return stored.get(key) ?? null; },
    setItem(key, value) { if (blocked) throw new Error("blocked"); stored.set(key, value); },
  };
  const exports = {};
  script.runInNewContext({
    exports,
    require(id) {
      if (id !== "react") throw new Error(`Unexpected import ${id}`);
      return {
        useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot) {
          if (server) return getServerSnapshot();
          unsubscribe ??= subscribe(() => notifications++);
          return getSnapshot();
        },
      };
    },
    ...(!server && {
      window: {
        localStorage: storage,
        addEventListener(type, listener) { assert.equal(events.has(type), false); events.set(type, listener); },
        removeEventListener(type, listener) { assert.equal(events.get(type), listener); events.delete(type); },
      },
    }),
  });
  return {
    ...exports,
    stored,
    events,
    get notifications() { return notifications; },
    unmount() { unsubscribe?.(); unsubscribe = null; },
  };
}

test("the rail carries ten questions unless something else was saved", () => {
  const store = fixture();
  for (const [raw, expected] of [[null, 10], ["", 10], ["nonsense", 10], ["20", 20], ["0", 5], ["999", 50], ["7.6", 8]]) {
    assert.equal(store.parseMinimapWindow(raw), expected, String(raw));
  }
  assert.equal(store.MINIMAP_WINDOW_STORAGE_KEY, KEY);
  assert.equal(store.MINIMAP_WINDOW_DEFAULT, 10);
  assert.deepEqual([...store.MINIMAP_WINDOW_CHOICES], [5, 10, 20, 50]);
});

test("the window stays inside its bounds", () => {
  const store = fixture();
  assert.equal(store.clampMinimapWindow(1), 5);
  assert.equal(store.clampMinimapWindow(4.4), 5);
  assert.equal(store.clampMinimapWindow(50), 50);
  assert.equal(store.clampMinimapWindow(51), 50);
  assert.equal(store.clampMinimapWindow(Number.NaN), 10);
  assert.equal(store.clampMinimapWindow("12"), 12);
});

test("the server renders the default without touching browser APIs", () => {
  const store = fixture({ server: true, initial: { [KEY]: "20" } });
  assert.equal(store.useMinimapWindow(), 10);
});

test("a saved size is restored, and a new one is saved, clamped and announced", () => {
  const store = fixture({ initial: { [KEY]: "20" } });
  assert.equal(store.useMinimapWindow(), 20);
  store.setMinimapWindow(50);
  assert.equal(store.useMinimapWindow(), 50);
  assert.equal(store.stored.get(KEY), "50");
  assert.equal(store.notifications, 1);
  store.setMinimapWindow(50);
  assert.equal(store.notifications, 1, "the same size again changes nothing");
  store.setMinimapWindow(999);
  assert.equal(store.useMinimapWindow(), 50, "out of range clamps, and 50 is already set");
  assert.equal(store.notifications, 1);
});

test("another tab's size, or a cleared storage, is followed", () => {
  const store = fixture();
  assert.equal(store.useMinimapWindow(), 10);
  const onStorage = store.events.get("storage");
  store.stored.set(KEY, "20");
  onStorage({ key: "pi-web:sidebar-tab" });
  assert.equal(store.useMinimapWindow(), 10, "another key is not this choice");
  assert.equal(store.notifications, 0);
  onStorage({ key: KEY });
  assert.equal(store.useMinimapWindow(), 20);
  assert.equal(store.notifications, 1);
  store.stored.clear();
  onStorage({ key: null });
  assert.equal(store.useMinimapWindow(), 10);
  assert.equal(store.notifications, 2);
  store.unmount();
  assert.equal(store.events.size, 0, "the last consumer stops listening");
});

test("blocked storage leaves the default, and a choice still applies for the page", () => {
  const store = fixture({ blocked: true });
  assert.equal(store.useMinimapWindow(), 10);
  store.setMinimapWindow(20);
  assert.equal(store.useMinimapWindow(), 20);
  assert.equal(store.notifications, 1);
});
