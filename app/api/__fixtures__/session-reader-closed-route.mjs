// lib/session-reader's disk catalogue, standing in for it in
// app/api/projects/closed/route.test.mjs: the route judges the rows this
// returns, so the test decides them (and sees whether the route built the
// table at all).
//
// `attachSessionProjectInfo()` answers its argument unchanged: a fixture row
// carries its own projectKey, and the route test is about which ids reach it,
// not about resolving project roots.
let rows = [];
let listCalls = 0;
let attachedIds = [];

/** The catalogue the next route call judges; also clears the call record. */
export function setSessionReaderState({ sessions = [] } = {}) {
  rows = sessions.map((session) => ({ ...session }));
  listCalls = 0;
  attachedIds = [];
}

/** How often the catalogue was listed, and which live rows were resolved. */
export function calls() {
  return { list: listCalls, attachedIds: [...attachedIds] };
}

export function listAllSessions() {
  listCalls += 1;
  return rows.map((session) => ({ ...session }));
}

export function attachSessionProjectInfo(sessions) {
  attachedIds.push(...sessions.map((session) => session.id));
  return sessions;
}
