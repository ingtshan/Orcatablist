import { assertSameOriginWrite, json } from "./http";
import type { IndexSummary, SourceIssue } from "./indexer";
import type { LiveSourceHealth } from "./live-source";
import type { SessionLiveReader } from "./session-live";

/**
 * The board reads two independently-cached truths: an index rebuilt from session files on a rescan
 * timer, and a live snapshot held for `LIVE_CACHE_MS` that keeps serving a failed source's last
 * good entries for the whole staleness budget. Both are right for a page that polls, and both can
 * leave an operator staring at a row they can see is wrong with nothing to do but wait — so this
 * is the one place that asks every layer to look again now.
 */

export interface RefreshDeps {
  /** Coalescing, so repeated presses collapse into one pass instead of stacking scans. */
  indexAll(): Promise<IndexSummary>;
  liveReader: SessionLiveReader;
  /** Schedules an immediate pull for each enabled environment; returns the ones kicked. */
  kickEnvironments(): string[];
  indexedAt(): number | null;
}

export interface RefreshSummary {
  indexed: { files: number; changed: number; ms: number; errors: SourceIssue[] };
  /** Per-source health after the forced read, so the page can say which truth is still missing. */
  sources: LiveSourceHealth[];
  environments: string[];
  indexedAt: number | null;
}

export async function handleRefreshRequest(
  request: Request,
  url: URL,
  deps: RefreshDeps,
): Promise<Response | null> {
  if (request.method !== "POST" || url.pathname !== "/api/refresh") return null;
  assertSameOriginWrite(request);
  // The index pass reads files and the live snapshot reads the runtime; neither needs the other.
  const [indexed, snapshot] = await Promise.all([
    deps.indexAll(),
    deps.liveReader.refreshSnapshot(true),
  ]);
  // A remote pull owns its own loop, so kicking it is a schedule rather than something to await —
  // its rows arrive with the round it just started, not with this response.
  const environments = deps.kickEnvironments();
  return json({
    indexed: { files: indexed.files, changed: indexed.changed, ms: indexed.ms, errors: indexed.errors },
    sources: snapshot.sources,
    environments,
    // Read after the pass so it reports the index this request produced, not the one it replaced.
    indexedAt: deps.indexedAt(),
  } satisfies RefreshSummary);
}
