import { basename } from "node:path";
import type { OrcaDatabase, ProjectRecord, StoredSession } from "../db";
import { parseLine } from "../parse";
import { ORCA_WORKSPACE_PATTERN } from "../projects";
import {
  DEFAULT_REMOTE_PENDING_MAX_BYTES, legacyRemoteReadState, receiveRemoteChunk, remoteReadCursor,
  remoteReadStats, type RemoteReadCursor, type RemoteReadState, type RemoteReadStats,
} from "../remote-read-state";
import type { PullAgentsRequest, PullResult, RemoteFileStat } from "../remote-pull";
import { isSessionId } from "../session-identity";
import {
  selectSessionOwners, sourceIssue,
  type DiscoveryResult, type SessionFileInfo, type SessionSource, type SessionUpdate,
} from "../session-source";
import type { ParsedEvent } from "../types";
import { EXECUTION_METADATA_VERSION } from "../session-execution";
import { fullInputRebuildPaths } from "../session-input-rebuild";
import { completeLines, indexJsonlSession, type JsonlWindow } from "./jsonl";
import { parseCodexTitles, parseCodexLine, ROLLOUT_FILE_PATTERN } from "./codex";

const SESSION_FILE_SUFFIX = ".jsonl";
const EMPTY_BYTES = new Uint8Array(0);

export interface RemoteEnvironmentSources {
  sources: SessionSource[];
  /**
   * One ssh round for the whole environment — both agents' listings and bytes ride the same
   * exec. Runs before indexAll each tick; the sources then serve from the captured round.
   */
  runRound(): Promise<PullResult>;
  /** Transfer work still owed, counted over the files the indexer will actually consume. */
  stats(): RemoteReadStats;
  /**
   * Fences this handle: a pull already in flight can still resolve, but nothing it carries may
   * reach durable state, the title cache or health afterwards.
   */
  close(): void;
}

export interface RemoteEnvironmentSourcesOptions {
  env: string;
  db: OrcaDatabase;
  agents: PullAgentsRequest;
  pull(
    cursors: Record<string, RemoteReadCursor>, agents: PullAgentsRequest,
    /** Where the previous completed round stopped; the collector resumes after it. */
    lastPath: string | null,
  ): Promise<PullResult>;
  /** Ceiling on buffered bytes of one incomplete record per file. */
  maxPendingBytes?: number;
}

interface RemoteAgentIngest {
  parseLine(line: string): ParsedEvent;
  /** Absent when the agent carries no out-of-band title channel. */
  title?: string | null;
}

/** The listed files this round, split into what the indexer will consume and what it will not. */
interface RemoteInventory {
  claude: SessionFileInfo[];
  codex: SessionFileInfo[];
  winners: Map<string, SessionFileInfo>;
  losers: Set<string>;
}

function emptyRound(): PullResult {
  return {
    files: [], codexFiles: [], chunks: new Map(), rebuilds: new Set(), codexIndex: null,
    truncated: false, done: false, lastPath: null, errors: [], missing: [],
  };
}

function claudeFiles(stats: readonly RemoteFileStat[], env: string): SessionFileInfo[] {
  return stats.flatMap((file): SessionFileInfo[] => {
    const name = basename(file.path);
    if (!name.endsWith(SESSION_FILE_SUFFIX)) return [];
    const sid = name.slice(0, -SESSION_FILE_SUFFIX.length);
    if (!isSessionId(sid)) return [];
    return [{ agent: "claude", env, sid, path: file.path, size: file.size, mtime: file.mtime }];
  });
}

// The rollout filename's trailing uuid is the session id. The local source double-checks it
// against the first line's session_meta; doing that remotely would cost a read per file per
// round, so the rare forked-rollout mismatch is accepted as filename identity here.
function codexFiles(stats: readonly RemoteFileStat[], env: string): SessionFileInfo[] {
  return stats.flatMap((file): SessionFileInfo[] => {
    const sid = ROLLOUT_FILE_PATTERN.exec(basename(file.path))?.[1];
    if (sid === undefined || !isSessionId(sid)) return [];
    return [{ agent: "codex", env, sid, path: file.path, size: file.size, mtime: file.mtime }];
  });
}

/** Reception and indexing agree on ownership because both go through the one selection rule. */
function readInventory(round: PullResult, env: string, agents: PullAgentsRequest): RemoteInventory {
  const claude = agents.claude ? claudeFiles(round.files, env) : [];
  const codex = agents.codex === null ? [] : codexFiles(round.codexFiles, env);
  const listed = [...claude, ...codex];
  const winners = new Map(selectSessionOwners(listed, (file) => file).map((file) => [file.path, file]));
  const losers = new Set(listed.map((file) => file.path).filter((path) => !winners.has(path)));
  return { claude, codex, winners, losers };
}

export function createRemoteEnvironmentSources(options: RemoteEnvironmentSourcesOptions): RemoteEnvironmentSources {
  const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_REMOTE_PENDING_MAX_BYTES;
  let round = emptyRound();
  let inventory: RemoteInventory = { claude: [], codex: [], winners: new Map(), losers: new Set() };
  let states = new Map<string, RemoteReadState>();
  let excluded = new Set<string>();
  let active = new Set<string>();
  let codexTitles = new Map<string, string>();
  let codexIndexStat: { size: number; mtime: number } | null = null;
  let generation = 0;
  let closed = false;

  /** Read state first, then any pre-read-state session row, so an upgraded index keeps its cursor. */
  const knownStates = (): Map<string, RemoteReadState> => {
    const known = options.db.remoteReadStates(options.env);
    for (const cursor of options.db.sessionCursors(options.env)) {
      if (!known.has(cursor.path)) known.set(cursor.path, legacyRemoteReadState(cursor));
    }
    return known;
  };

  const buildCursors = (known: Map<string, RemoteReadState>): Record<string, RemoteReadCursor> => {
    const cursors: Record<string, RemoteReadCursor> = {};
    for (const [path, state] of known) cursors[path] = remoteReadCursor(state);
    for (const path of fullInputRebuildPaths(options.db.raw, options.env)) {
      const state = known.get(path);
      if (state && !state.replacePending) cursors[path] = { ...remoteReadCursor(state), rebuild: true, skip: false };
    }
    for (const session of options.db.sessionCursors(options.env)) {
      const state = known.get(session.path);
      if (session.executionMetadataVersion === 0 && state && !state.replacePending && !state.blocked && !cursors[session.path]?.rebuild
        && state.receivedFrom >= state.observedSize && (session.agent === "claude" || session.agent === "codex")) {
        cursors[session.path] = { ...remoteReadCursor(state), executionAgent: session.agent };
      }
    }
    // Duplicate losers are named explicitly rather than hidden behind a forged offset, and the
    // set is rebuilt from every completed inventory so a promoted file is asked for again.
    for (const path of excluded) cursors[path] = { offset: 0, size: 0, mtime: 0, exclude: true };
    return cursors;
  };

  /**
   * Byte reception commits before anything is parsed: a restart resumes from the durable buffer,
   * and a chunk that does not continue the received range is refused rather than spliced in.
   * Only files this round's owner rule actually selected are stored, so a disabled agent's
   * payload or a duplicate loser can never accumulate a buffer nobody will ever read.
   */
  const receive = (result: PullResult, known: Map<string, RemoteReadState>): void => {
    const next = new Map<string, RemoteReadState>();
    for (const [path, stat] of inventory.winners) {
      const prior = known.get(path) ?? null;
      const chunk = result.chunks.get(path) ?? null;
      const pending = chunk === null || prior === null
        ? EMPTY_BYTES : options.db.remotePendingBytes(options.env, path);
      const reception = receiveRemoteChunk({
        path, state: prior, pending, stat, chunk,
        rebuild: result.rebuilds.has(path), maxPendingBytes,
      });
      if (reception.error !== null) result.errors.push(reception.error);
      if (reception.changed) {
        options.db.saveRemoteReadState(options.env, path, reception.state, reception.pending);
      }
      next.set(path, reception.state);
    }
    states = next;
    active = new Set(inventory.winners.keys());
    // Only an inventory that actually completed can prove a path is gone or demoted. Buffered
    // transfer state for those files goes; their indexed sessions and transcripts stay.
    if (result.errors.length === 0) options.db.pruneRemoteReadState(options.env, active);
  };

  const indexRemoteTranscript = (
    info: SessionFileInfo, stored: StoredSession | null, agent: RemoteAgentIngest,
  ): SessionUpdate | null => {
    const titled = "title" in agent ? { title: agent.title } : {};
    const state = states.get(info.path);
    const buffered = state !== undefined && state.receivedTo > state.receivedFrom;
    if (state === undefined || (!buffered && !state.replacePending)) {
      return indexJsonlSession({ info, stored, window: null, parseLine: agent.parseLine, ...titled });
    }
    const bytes = buffered ? options.db.remotePendingBytes(options.env, info.path) : EMPTY_BYTES;
    // A new read generation only takes effect once it carries a record that can actually be read.
    // Until then the committed row, cursor and transcript stand: neither a missing chunk nor a
    // half-delivered one proves anything about the replacement. Only a file the remote reports as
    // empty proves the old content is gone, and only a stored session has anything to clear.
    if (state.replacePending && completeLines(bytes).consumedBytes === 0
      && (state.observedSize > 0 || stored === null)) return null;
    const window: JsonlWindow = {
      offset: state.receivedFrom, rebuild: state.replacePending, bytes,
    };
    return indexJsonlSession({
      info, stored, window, parseLine: agent.parseLine, ...titled,
      ack: (consumed) => ({
        env: options.env, path: info.path, generation: state.generation,
        receivedFrom: state.receivedFrom, consumed,
      }),
    });
  };

  const indexRemote = (info: SessionFileInfo, stored: StoredSession | null, agent: RemoteAgentIngest): SessionUpdate | null => {
    const update = indexRemoteTranscript(info, stored, agent);
    const metadata = round.executionMetadata?.get(info.path);
    const base = update?.session ?? stored;
    if (!metadata || !base || stored?.executionMetadataVersion !== 0) return update;
    return {
      ...(update ?? { fts: [], replaceFts: false }),
      session: { ...base, ...metadata, executionMetadataVersion: EXECUTION_METADATA_VERSION },
    };
  };

  // A round's failures leave every agent's listing incomplete, so each adapter reports them under
  // its own name: an inventory that lost one directory must not hand any agent's ownership away.
  const discovered = (agent: "claude" | "codex", files: SessionFileInfo[]): DiscoveryResult => ({
    files,
    errors: round.errors.map((message) => sourceIssue("discover", agent, message, { env: options.env })),
  });

  const claudeSource: SessionSource = {
    agent: "claude",
    discover: () => discovered("claude", inventory.claude),
    index: (info, stored) => indexRemote(info, stored, { parseLine }),
  };

  const codexSource: SessionSource = {
    agent: "codex",
    discover: () => discovered("codex", inventory.codex),
    index: (info, stored) => indexRemote(info, stored, {
      parseLine: parseCodexLine, title: codexTitles.get(info.sid) ?? null,
    }),
  };

  return {
    sources: [
      ...(options.agents.claude ? [claudeSource] : []),
      ...(options.agents.codex === null ? [] : [codexSource]),
    ],
    stats: () => remoteReadStats(options.db.remoteReadStates(options.env), active),
    close: () => {
      closed = true;
      generation += 1;
    },
    runRound: async () => {
      if (closed) return emptyRound();
      const fence = generation;
      const known = knownStates();
      const agents: PullAgentsRequest = {
        claude: options.agents.claude,
        codex: options.agents.codex === null ? null : { ...options.agents.codex, index: codexIndexStat },
      };
      const fresh = await options.pull(
        buildCursors(known), agents, options.db.getRemoteFairnessCursor(options.env),
      );
      // A stop or reload during the pull retires this handle. The result may still arrive, but it
      // describes a machine state this runner no longer owns, so nothing it carries is stored.
      if (closed || fence !== generation) return fresh;
      // A round that never reached its done marker may carry a truncated listing; nothing it
      // brought — bytes, listings or the title index — is allowed to advance any durable state.
      if (!fresh.done) {
        round = { ...fresh, files: [], codexFiles: [], chunks: new Map() };
        inventory = { claude: [], codex: [], winners: new Map(), losers: new Set() };
        return fresh;
      }
      if (fresh.codexIndex !== null && options.agents.codex !== null) {
        codexTitles = parseCodexTitles(Buffer.from(fresh.codexIndex.data).toString("utf8"));
        codexIndexStat = { size: fresh.codexIndex.size, mtime: fresh.codexIndex.mtime };
      }
      round = fresh;
      inventory = readInventory(fresh, options.env, options.agents);
      excluded = inventory.losers;
      receive(fresh, known);
      options.db.setRemoteFairnessCursor(options.env, fresh.lastPath);
      return fresh;
    },
  };
}

/**
 * Remote cwds must never be stat'ed or git-probed locally: project identity is derived from the
 * path alone, namespaced by environment, with an empty root so local folding and worktree
 * resource probes skip these projects entirely.
 */
export function createRemoteProjectResolver(env: string) {
  return async (cwd: string | null): Promise<ProjectRecord> => {
    if (cwd === null || !cwd.startsWith("/")) {
      return { key: `${env}:unknown`, name: `未知 @${env}`, root: "", color: null };
    }
    const workspace = ORCA_WORKSPACE_PATTERN.exec(cwd);
    if (workspace) {
      return { key: `${env}:orca-workspaces:${workspace[2]}`, name: `${workspace[2]} @${env}`, root: "", color: null };
    }
    return { key: `${env}:${cwd}`, name: `${basename(cwd)} @${env}`, root: "", color: null };
  };
}

export type { RemoteFileStat };
