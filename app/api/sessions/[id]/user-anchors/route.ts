import { NextResponse } from "next/server";
import { resolveSessionPath, openSessionManager, sliceActiveBranch } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { collectUserAnchors } from "@/lib/user-anchors";
import type { SessionEntry } from "@/lib/types";

/**
 * Every question on the session's active branch, for the chat's rail.
 *
 * The rail used to be built from the messages the browser had paged in, so a
 * long session listed a few nodes and the rest of the history was unreachable
 * from it. This reads the branch the server can already read (a live wrapper's
 * `SessionManager`, or the file) and returns ids and first lines only.
 *
 * `?leafId=` reads another branch, as the context route does; without it the
 * session's current leaf is used.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const requestedLeaf = url.searchParams.get("leafId");

  try {
    const rpc = getRpcSession(id);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const filePath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = liveRpc?.inner.sessionManager ?? openSessionManager(filePath!);
    const entries = sm.getEntries() as unknown as SessionEntry[];
    const leafId = requestedLeaf ?? sm.getLeafId();
    // A tail this large walks the whole chain: the rail has to know about the
    // first question too, which is the point of the request.
    const branch = sliceActiveBranch(entries, leafId ?? null, Number.MAX_SAFE_INTEGER);
    const anchors = collectUserAnchors(branch);
    return NextResponse.json({ anchors, total: anchors.length, leafId: leafId ?? null });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
