// Projects the user closed in the sidebar: their group and sessions leave the
// tree and the archive view, and nothing on disk changes. The set lives in
// this process only, so a page reload keeps it and a restart of Pi Web forgets
// it (the plan's D1: closing is a "not now", not a preference).
//
// Route handlers are bundled separately and hot reload re-evaluates modules,
// so the store lives on globalThis under a Symbol.for name, as the MCP status
// records do; the dedupe by symbol keeps one set in a dev server.
//
// `revision` moves on every real change of the set and not on a repeat of the
// current state: the sidebar replaces what it holds only when it sees a new
// revision, so a no-op POST (two windows, the same project) changes nothing.

const STORE_KEY: symbol = Symbol.for("pi-web:closed-projects");

interface ClosedProjectsStore {
  keys: Set<string>;
  revision: number;
}

function store(): ClosedProjectsStore {
  const holder = globalThis as Record<symbol, ClosedProjectsStore | undefined>;
  return (holder[STORE_KEY] ??= { keys: new Set<string>(), revision: 0 });
}

/** The closed project keys, in the order they were closed. */
export function getClosedProjectKeys(): string[] {
  return [...store().keys];
}

/** Bumped whenever the closed set changes; the sidebar syncs on it. */
export function getClosedProjectsRevision(): number {
  return store().revision;
}

export function isProjectClosed(projectKey: string): boolean {
  return store().keys.has(projectKey);
}

/**
 * Closes or reopens `projectKey`, answering with the set as it is now. A
 * request that changes nothing leaves the revision alone.
 */
export function setProjectClosed(projectKey: string, closed: boolean): { revision: number; closedProjectKeys: string[] } {
  const held = store();
  const changed = closed ? !held.keys.has(projectKey) : held.keys.has(projectKey);
  if (changed) {
    if (closed) held.keys.add(projectKey);
    else held.keys.delete(projectKey);
    held.revision += 1;
  }
  return { revision: held.revision, closedProjectKeys: [...held.keys] };
}

/** Forgets every closed project; for tests. */
export function resetClosedProjectsForTests(): void {
  const held = store();
  held.keys.clear();
  held.revision = 0;
}
