import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getClosedProjectKeys,
  getClosedProjectsRevision,
  isProjectClosed,
  resetClosedProjectsForTests,
  setProjectClosed,
} = await jiti.import("./project-closed.ts");

beforeEach(() => resetClosedProjectsForTests());

test("a process starts with nothing closed", () => {
  assert.deepEqual(getClosedProjectKeys(), []);
  assert.equal(getClosedProjectsRevision(), 0);
  assert.equal(isProjectClosed("/work/alpha"), false);
});

test("closing a project bumps the revision once, and repeating it changes nothing", () => {
  assert.deepEqual(setProjectClosed("/work/alpha", true), { revision: 1, closedProjectKeys: ["/work/alpha"] });
  assert.equal(getClosedProjectsRevision(), 1);
  assert.equal(isProjectClosed("/work/alpha"), true);
  // A second window closing the same project is no change: the sidebar only
  // replaces what it holds when the revision moves.
  assert.deepEqual(setProjectClosed("/work/alpha", true), { revision: 1, closedProjectKeys: ["/work/alpha"] });
  assert.deepEqual(setProjectClosed("/work/beta", true), { revision: 2, closedProjectKeys: ["/work/alpha", "/work/beta"] });
  assert.deepEqual(getClosedProjectKeys(), ["/work/alpha", "/work/beta"]);
});

test("reopening removes the key and moves the revision forward", () => {
  setProjectClosed("/work/alpha", true);
  setProjectClosed("/work/beta", true);
  assert.deepEqual(setProjectClosed("/work/alpha", false), { revision: 3, closedProjectKeys: ["/work/beta"] });
  assert.equal(isProjectClosed("/work/alpha"), false);
  // Reopening what is not closed is no change either.
  assert.deepEqual(setProjectClosed("/work/alpha", false), { revision: 3, closedProjectKeys: ["/work/beta"] });
  assert.equal(getClosedProjectsRevision(), 3);
});

test("the store is shared through globalThis, as a separate route bundle sees it", () => {
  setProjectClosed("/work/alpha", true);
  const shared = globalThis[Symbol.for("pi-web:closed-projects")];
  assert.ok(shared.keys.has("/work/alpha"));
  assert.equal(shared.revision, 1);
});

test("the test reset clears the set and the revision", () => {
  setProjectClosed("/work/alpha", true);
  setProjectClosed("/work/beta", true);
  resetClosedProjectsForTests();
  assert.deepEqual(getClosedProjectKeys(), []);
  assert.equal(getClosedProjectsRevision(), 0);
});
