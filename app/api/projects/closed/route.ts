import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  getClosedProjectKeys,
  getClosedProjectsRevision,
  setProjectClosed,
} from "@/lib/project-closed";
import {
  getAwaitingInputRpcSessionIds,
  getRpcSessionInfos,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import { attachSessionProjectInfo, listAllSessions } from "@/lib/session-reader";
import { projectCloseBlock, type ProjectCloseBlockReason } from "@/lib/sidebar-actions";

export const dynamic = "force-dynamic";

// GET /api/projects/closed - the closed projects of this process, on their
// own. The sidebar never asks here: it takes the set from its 2.5s running
// poll (which fires on mount anyway, so a read of its own would buy nothing,
// D8) and from the answer to its own POST. This route answers the same state
// for tools and tests.
//
// POST { projectKey, closed } - close (the default) or reopen one project.
// Closing refuses a project with a session that runs or waits for input: the
// rows would come straight back (a closed project with a running member shows
// again, D4), and the menu's disabled item is only the polite half of the
// check (D3). The session table is the merged one: the list on disk plus the
// live sessions that have no file yet.

const NO_STORE = { "Cache-Control": "no-store" };

function refusal(status: number, error: string, reason?: ProjectCloseBlockReason) {
  return NextResponse.json(reason ? { error, reason } : { error }, { status, headers: NO_STORE });
}

/**
 * The session table the menu judges (`treeSelectionInput`): the list on disk
 * plus the live sessions it does not know yet.
 */
async function busySessions() {
  const listed = await listAllSessions({ allowStale: true });
  const known = new Set(listed.map((session) => session.id));
  const live = getRpcSessionInfos({ includeTransient: true }).filter((session) => !known.has(session.id));
  // A live session without a file has no project identity yet: resolve it the
  // same way the list does, so its worktree joins its project's key.
  return live.length > 0 ? [...listed, ...(await attachSessionProjectInfo(live))] : listed;
}

// GET /api/projects/closed
export async function GET() {
  return NextResponse.json(
    { closedProjectKeys: getClosedProjectKeys(), revision: getClosedProjectsRevision() },
    { headers: NO_STORE },
  );
}

// POST /api/projects/closed
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return refusal(403, "Untrusted API request");
  if (!hasJsonContentType(req)) return refusal(415, "Content-Type must be application/json");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refusal(400, "Invalid JSON body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return refusal(400, "Expected a JSON object");
  }
  const { projectKey, closed } = body as { projectKey?: unknown; closed?: unknown };
  if (typeof projectKey !== "string" || projectKey === "") {
    return refusal(400, "projectKey must be a non-empty string");
  }
  if (closed !== undefined && typeof closed !== "boolean") {
    return refusal(400, "closed must be a boolean");
  }

  if (closed !== false) {
    const runningIds = new Set(getRunningRpcSessionIds());
    const awaitingIds = new Set(getAwaitingInputRpcSessionIds());
    // Nothing running anywhere: no session can block this project, so the
    // session table need not be built (a scan of every file).
    if (runningIds.size > 0 || awaitingIds.size > 0) {
      // The menu's own rule, so both halves of D3 refuse the same projects: a
      // family's project is its root's, and a subagent that ran in another cwd
      // blocks its root's project too.
      const block = projectCloseBlock({ sessions: await busySessions(), runningIds, awaitingIds }, projectKey);
      if (block.blocked) {
        return refusal(409, block.reason === "awaiting"
          ? "A session of this project is waiting for input"
          : "A session of this project is running", block.reason);
      }
    }
  }

  return NextResponse.json(setProjectClosed(projectKey, closed !== false), { headers: NO_STORE });
}
