import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { beforeEach } from "node:test";
import { createJiti } from "jiti";

// POST /api/projects/closed's 409, the half of A2 that cannot be checked from
// outside the server process: a fresh Node process has an empty AgentSession
// registry, so `getRunningRpcSessionIds()` is empty here and a real run cannot
// be started inside a test. The route's two sources are aliased to fixtures the
// test steers: the live registry (`@/lib/rpc-manager`) and the disk catalogue
// (`@/lib/session-reader`). The alias takes each module's absolute path without
// its extension ("@/…" resolves first and is never matched), in the form jiti
// compares it with: forward slashes and an upper-case drive letter on Windows.
// This process must not share a jiti cache with a test that loaded the real
// modules, which is why it lives under app/, where no other test loads both.
function modulePath(url) {
  return fileURLToPath(url).replaceAll("\\", "/").replace(/^[a-z]:/, (drive) => drive.toUpperCase());
}
const rpcManager = modulePath(new URL("../../../../lib/rpc-manager", import.meta.url));
const sessionReader = modulePath(new URL("../../../../lib/session-reader", import.meta.url));
const rpcFixture = fileURLToPath(new URL("../../__fixtures__/rpc-manager-closed-route.mjs", import.meta.url));
const readerFixture = fileURLToPath(new URL("../../__fixtures__/session-reader-closed-route.mjs", import.meta.url));

const jiti = createJiti(import.meta.url, {
  tsconfigPaths: true,
  alias: { [rpcManager]: rpcFixture, [sessionReader]: readerFixture },
});
const { GET, POST } = await jiti.import("./route.ts");
const rpc = await jiti.import(rpcFixture);
const reader = await jiti.import(readerFixture);
const { getClosedProjectKeys, getClosedProjectsRevision, resetClosedProjectsForTests } = await jiti.import("@/lib/project-closed");

const HOST = "127.0.0.1:30141";

beforeEach(() => {
  // Both stores outlive a test: the closed set lives on globalThis, the fixtures
  // in their module, so the cases run in any order.
  resetClosedProjectsForTests();
  rpc.setRpcState();
  reader.setSessionReaderState();
});

/** A catalogue row as listAllSessions() answers one: its project is its own key. */
function session(id, projectRoot, extra = {}) {
  return {
    path: `/sessions/${id}.jsonl`,
    id,
    cwd: projectRoot,
    projectRoot,
    projectKey: projectRoot,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-02T00:00:00.000Z",
    messageCount: 1,
    firstMessage: id,
    ...extra,
  };
}

function request({ body, contentType = "application/json", method = "POST" } = {}) {
  return new Request(`http://${HOST}/api/projects/closed`, {
    method,
    headers: { Host: HOST, "Content-Type": contentType },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

async function closeProject(projectKey, closed) {
  const response = await POST(request({ body: closed === undefined ? { projectKey } : { projectKey, closed } }));
  return { response, body: await response.json() };
}

const alpha = "/work/alpha";
const beta = "/work/beta";

test("nothing running anywhere: a project with sessions closes, and the table is never built", async () => {
  reader.setSessionReaderState({ sessions: [session("alpha-1", alpha)] });
  const before = await (await GET()).json();

  const { response, body } = await closeProject(alpha);

  assert.equal(response.status, 200);
  assert.deepEqual(body.closedProjectKeys, [alpha]);
  assert.ok(body.revision > before.revision, "the revision moves");
  assert.deepEqual(getClosedProjectKeys(), [alpha]);
  // The empty-registry fast path: no session can block anything, so the route
  // skips the scan (and the live rows) entirely.
  assert.deepEqual(reader.calls().list, 0);
  assert.deepEqual(rpc.calls().infos, 0);
});

test("a running session of the project is refused with reason running", async () => {
  reader.setSessionReaderState({ sessions: [session("alpha-1", alpha)] });
  rpc.setRpcState({ running: ["alpha-1"] });

  const { response, body } = await closeProject(alpha);

  assert.equal(response.status, 409);
  assert.equal(body.reason, "running");
  assert.match(body.error, /running/);
  assert.deepEqual(body.closedProjectKeys, undefined, "a refusal carries no set");
  assert.deepEqual(getClosedProjectKeys(), []);
  // The route built the merged table and asked for the live rows, transient ones included.
  assert.equal(reader.calls().list, 1);
  assert.equal(rpc.calls().infos, 1);
  assert.deepEqual(rpc.calls().lastInfosOptions, { includeTransient: true });
});

test("a session waiting for input is refused with reason awaiting, even with a run beside it", async () => {
  reader.setSessionReaderState({ sessions: [session("alpha-1", alpha), session("alpha-2", alpha)] });
  rpc.setRpcState({ running: ["alpha-1", "alpha-2"], awaiting: ["alpha-2"] });

  const { response, body } = await closeProject(alpha);

  assert.equal(response.status, 409);
  assert.equal(body.reason, "awaiting");
  assert.match(body.error, /waiting for input/);
  assert.deepEqual(getClosedProjectKeys(), []);
});

test("a run in another project lets this one close", async () => {
  reader.setSessionReaderState({ sessions: [session("alpha-1", alpha), session("beta-1", beta)] });
  rpc.setRpcState({ running: ["beta-1"] });

  const { response, body } = await closeProject(alpha);

  assert.equal(response.status, 200);
  assert.deepEqual(body.closedProjectKeys, [alpha]);
  // Not the fast path this time: the table was built, and beta's run is not alpha's.
  assert.equal(reader.calls().list, 1);
});

test("a running subagent whose own cwd is elsewhere blocks its root's project", async () => {
  // The family rule the menu shares: a subagent's project is its root's, even
  // when the subagent ran in another folder.
  reader.setSessionReaderState({
    sessions: [
      session("alpha-1", alpha),
      session("alpha-sub", "/elsewhere", {
        relation: { kind: "subagent", parentSessionId: "alpha-1", profile: "scout", description: "look", status: "running" },
      }),
    ],
  });
  rpc.setRpcState({ running: ["alpha-sub"] });

  const { response, body } = await closeProject(alpha);

  assert.equal(response.status, 409);
  assert.equal(body.reason, "running");
  assert.deepEqual(getClosedProjectKeys(), []);
});

test("a live session without a file joins its project's table", async () => {
  // The composer's transient runtime: no JSONL yet, so the list does not know
  // it, and only the registry does.
  rpc.setRpcState({
    running: ["live-1"],
    infos: [{ ...session("live-1", alpha), transient: true }],
  });

  const { response, body } = await closeProject(alpha);

  assert.equal(response.status, 409);
  assert.equal(body.reason, "running");
  assert.deepEqual(reader.calls().attachedIds, ["live-1"]);
});

test("closed false reopens a closed project, and GET reflects the set", async () => {
  reader.setSessionReaderState({ sessions: [session("alpha-1", alpha)] });
  await closeProject(alpha);
  assert.deepEqual(getClosedProjectKeys(), [alpha]);
  const closedRevision = getClosedProjectsRevision();

  const { response, body } = await closeProject(alpha, false);

  assert.equal(response.status, 200);
  assert.deepEqual(body.closedProjectKeys, []);
  assert.ok(body.revision > closedRevision, "reopening moves the revision too");
  assert.deepEqual(getClosedProjectKeys(), []);

  const reflected = await (await GET()).json();
  assert.deepEqual(reflected, { closedProjectKeys: [], revision: body.revision });
});

test("the body is checked before anything else", async () => {
  reader.setSessionReaderState({ sessions: [session("alpha-1", alpha)] });
  rpc.setRpcState({ running: ["alpha-1"] });

  // No projectKey at all.
  const missing = await POST(request({ body: {} }));
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /projectKey/);

  const { response, body } = await closeProject(alpha, "yes");
  assert.equal(response.status, 400);
  assert.match(body.error, /closed must be a boolean/);
  assert.deepEqual(getClosedProjectKeys(), [], "a refused body closes nothing");

  const plain = await POST(request({ body: { projectKey: alpha }, contentType: "text/plain" }));
  assert.equal(plain.status, 415);
});
