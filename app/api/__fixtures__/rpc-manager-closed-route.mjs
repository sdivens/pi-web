// lib/rpc-manager's live registry, standing in for it in
// app/api/projects/closed/route.test.mjs: the route's 409 half cannot be
// reached from outside the server process (a fresh Node process has an empty
// AgentSession registry), so the test steers what the registry answers.
//
// The three calls are the ones that route makes; `setRpcState()` is the
// switch, and `calls()` tells the test what the route asked for (the empty
// fast path asks nothing at all).
let state = { running: [], awaiting: [], infos: [] };
let infosCalls = 0;
let lastInfosOptions = null;

/** What the next route call sees: running ids, awaiting ids and live rows. */
export function setRpcState({ running = [], awaiting = [], infos = [] } = {}) {
  state = { running: [...running], awaiting: [...awaiting], infos: infos.map((session) => ({ ...session })) };
  infosCalls = 0;
  lastInfosOptions = null;
}

/** How often the live rows were asked for, and with which options. */
export function calls() {
  return { infos: infosCalls, lastInfosOptions };
}

export function getRunningRpcSessionIds() {
  return [...state.running];
}

export function getAwaitingInputRpcSessionIds() {
  return [...state.awaiting];
}

export function getRpcSessionInfos(options = {}) {
  infosCalls += 1;
  lastInfosOptions = options;
  return state.infos.map((session) => ({ ...session }));
}
