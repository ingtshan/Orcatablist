import { describe, expect, test } from "bun:test";
import {
  BoardOfflineError, BoardRegistry, openBoardDatabase, ProjectBoardStore, SessionTaskStore,
  type BoardTask, type CaptureInput, type SessionRef, type TaskBoard,
} from "../src/boards";
import { OrcaDatabase, type StoredSession } from "../src/db";
import {
  boardOverviews, captureSessionTask, ProjectSelectionRequiredError, refreshSessionTasks,
  sessionTaskMap, unlinkSessionTask, type SessionTaskDeps,
} from "../src/session-tasks";

const SID = "11111111-1111-1111-1111-111111111111";
const OTHER_SID = "22222222-2222-2222-2222-222222222222";
const PROJECT_KEY = "/work/orcatab";
const BOARD_PROJECT = "kan-project";

function storedSession(sid: string): StoredSession {
  return {
    agent: "claude", sid, projectKey: PROJECT_KEY, cwd: PROJECT_KEY, worktreeRoot: PROJECT_KEY,
    branch: "main", title: "t", firstPrompt: "p", lastPrompt: "p", lastInputAt: 1, promptCount: 1,
    filePath: `/tmp/${sid}.jsonl`, fileSize: 1, fileMtime: 1, parsedOffset: 1,
  };
}

interface FakeBoardOptions {
  id?: string;
  backlink?: boolean;
  offline?: boolean;
  captureFails?: boolean;
}

interface FakeBoard { board: TaskBoard; captures: CaptureInput[]; backlinks: Array<[string, SessionRef]>; }

function fakeBoard(options: FakeBoardOptions = {}): FakeBoard {
  const id = options.id ?? "kan";
  const captures: CaptureInput[] = [];
  const backlinks: Array<[string, SessionRef]> = [];
  const tasks = new Map<string, BoardTask>();
  let counter = 0;
  const offline = () => new BoardOfflineError(id, `board "${id}" is unreachable`);
  const board: TaskBoard = {
    id, name: id, kind: id === "local" ? "local" : "kansession",
    capabilities: () => ({ projects: true, capture: true, lookup: true, backlink: options.backlink === true }),
    listProjects: async () => {
      if (options.offline) throw offline();
      return [{ id: BOARD_PROJECT, name: "kansession 板", url: `http://board/${BOARD_PROJECT}` }];
    },
    capture: async (input) => {
      if (options.offline) throw offline();
      if (options.captureFails) throw new Error("capture exploded");
      captures.push(input);
      counter += 1;
      const task: BoardTask = {
        boardId: id, taskId: `task-${counter}`, projectId: input.projectId, title: input.title,
        status: "to-do", statusKind: "open", number: `KAN-${counter}`,
        url: `http://board/task-${counter}`,
      };
      tasks.set(task.taskId, task);
      return task;
    },
    lookup: async (taskIds) => {
      if (options.offline) throw offline();
      return new Map(taskIds.flatMap((taskId) => {
        const task = tasks.get(taskId);
        return task === undefined ? [] : [[taskId, task] as const];
      }));
    },
    ...(options.backlink === true
      ? {
        backlink: async (taskId: string, ref: SessionRef) => {
          if (options.offline) throw offline();
          backlinks.push([taskId, ref]);
        },
      }
      : {}),
  };
  return { board, captures, backlinks, ...(options.backlink === true ? {} : {}) };
}

function harness(boards: TaskBoard[]): SessionTaskDeps & { close(): void } {
  const db = new OrcaDatabase(":memory:");
  db.upsertProject({ key: PROJECT_KEY, name: "orcatab", root: PROJECT_KEY, color: null });
  db.upsertSession(storedSession(SID));
  db.upsertSession(storedSession(OTHER_SID));
  const database = openBoardDatabase(":memory:");
  return {
    db,
    boards: new BoardRegistry(boards),
    store: new SessionTaskStore(database),
    bindings: new ProjectBoardStore(database),
    onError: () => {},
    close: () => { database.close(); db.close(); },
  };
}

describe("SessionTaskStore", () => {
  test("links, groups by session, and bumps a version the UI can etag on", () => {
    const deps = harness([]);
    try {
      const before = deps.store.version;
      const task: BoardTask = {
        boardId: "kan", taskId: "t1", projectId: BOARD_PROJECT, title: "想法",
        status: "to-do", statusKind: "open", number: "KAN-1", url: "http://board/t1",
      };
      const link = deps.store.link("claude", SID, task);
      expect(link.createdAt).toBeGreaterThan(0);
      expect(deps.store.version).toBeGreaterThan(before);
      expect(sessionTaskMap(deps.store)[`claude/${SID}`]?.[0]?.title).toBe("想法");
      expect(deps.store.listForSession("claude", OTHER_SID)).toEqual([]);
    } finally { deps.close(); }
  });

  test("re-linking the same task updates the snapshot instead of duplicating", () => {
    const deps = harness([]);
    try {
      const task: BoardTask = {
        boardId: "kan", taskId: "t1", projectId: BOARD_PROJECT, title: "旧标题",
        status: "to-do", statusKind: "open", number: null, url: null,
      };
      deps.store.link("claude", SID, task);
      deps.store.link("claude", SID, { ...task, title: "新标题" });
      const links = deps.store.listForSession("claude", SID);
      expect(links).toHaveLength(1);
      expect(links[0]?.title).toBe("新标题");
    } finally { deps.close(); }
  });

  test("applySnapshots refreshes open tasks and drops the ones the board forgot", () => {
    const deps = harness([]);
    try {
      const base: BoardTask = {
        boardId: "kan", taskId: "t1", projectId: BOARD_PROJECT, title: "a",
        status: "to-do", statusKind: "open", number: null, url: null,
      };
      deps.store.link("claude", SID, base);
      deps.store.link("claude", SID, { ...base, taskId: "t2", title: "b" });
      expect(deps.store.openTaskIds("kan").sort()).toEqual(["t1", "t2"]);

      const changed = deps.store.applySnapshots(
        "kan",
        new Map([["t1", { ...base, title: "a2", status: "done", statusKind: "done" as const }]]),
        ["t2"],
      );
      expect(changed).toBe(2);
      const links = deps.store.listForSession("claude", SID);
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ taskId: "t1", title: "a2", statusKind: "done" });
      expect(deps.store.openTaskIds("kan")).toEqual([]);
    } finally { deps.close(); }
  });

  test("unlink removes only the named link", () => {
    const deps = harness([]);
    try {
      const task: BoardTask = {
        boardId: "kan", taskId: "t1", projectId: BOARD_PROJECT, title: "a",
        status: "to-do", statusKind: "open", number: null, url: null,
      };
      deps.store.link("claude", SID, task);
      deps.store.link("claude", OTHER_SID, task);
      expect(unlinkSessionTask(deps, { agent: "claude", sid: SID }, "kan", "t1")).toBe(true);
      expect(unlinkSessionTask(deps, { agent: "claude", sid: SID }, "kan", "t1")).toBe(false);
      expect(deps.store.listForSession("claude", OTHER_SID)).toHaveLength(1);
    } finally { deps.close(); }
  });
});

describe("captureSessionTask", () => {
  test("captures, links, back-links, and remembers the repository's board project", async () => {
    const fake = fakeBoard({ backlink: true });
    const deps = harness([fake.board]);
    try {
      const result = await captureSessionTask(deps, {
        agent: "claude", sid: SID, title: "  把 IDF 降权做掉  ", projectId: BOARD_PROJECT,
      });
      expect(fake.captures).toEqual([{ projectId: BOARD_PROJECT, title: "把 IDF 降权做掉" }]);
      expect(result.task).toMatchObject({ agent: "claude", sid: SID, taskId: "task-1", number: "KAN-1" });
      expect(result.backlinkError).toBeNull();
      expect(fake.backlinks).toEqual([["task-1", {
        providerId: "orcatab", sessionId: SID, agent: "claude",
      }]]);
      expect(result.binding).toEqual({
        projectKey: PROJECT_KEY, boardId: "kan",
        boardProjectId: BOARD_PROJECT, boardProjectName: "kansession 板",
      });
      expect(deps.bindings.get(PROJECT_KEY)?.boardProjectId).toBe(BOARD_PROJECT);
    } finally { deps.close(); }
  });

  test("a second capture in the same repository needs no project", async () => {
    const fake = fakeBoard();
    const deps = harness([fake.board]);
    try {
      await captureSessionTask(deps, { agent: "claude", sid: SID, title: "第一个", projectId: BOARD_PROJECT });
      const second = await captureSessionTask(deps, { agent: "claude", sid: OTHER_SID, title: "第二个" });
      expect(second.task.projectId).toBe(BOARD_PROJECT);
      expect(second.binding).toBeNull();
      expect(fake.captures.map((capture) => capture.title)).toEqual(["第一个", "第二个"]);
    } finally { deps.close(); }
  });

  test("asks for a project when the repository has no binding yet", async () => {
    const deps = harness([fakeBoard().board]);
    try {
      const promise = captureSessionTask(deps, { agent: "claude", sid: SID, title: "想法" });
      await expect(promise).rejects.toBeInstanceOf(ProjectSelectionRequiredError);
      await promise.catch((error: ProjectSelectionRequiredError) => {
        expect(error.boardId).toBe("kan");
        expect(error.projectKey).toBe(PROJECT_KEY);
      });
    } finally { deps.close(); }
  });

  test("a failed back-link does not lose the task", async () => {
    const fake = fakeBoard({ backlink: true });
    const board: TaskBoard = {
      ...fake.board,
      backlink: async () => { throw new Error("link endpoint said no"); },
    };
    const deps = harness([board]);
    try {
      const result = await captureSessionTask(deps, {
        agent: "claude", sid: SID, title: "想法", projectId: BOARD_PROJECT,
      });
      expect(result.backlinkError).toBe("link endpoint said no");
      expect(deps.store.listForSession("claude", SID)).toHaveLength(1);
    } finally { deps.close(); }
  });

  test("a failed capture stores nothing", async () => {
    const deps = harness([fakeBoard({ captureFails: true }).board]);
    try {
      await expect(captureSessionTask(deps, {
        agent: "claude", sid: SID, title: "想法", projectId: BOARD_PROJECT,
      })).rejects.toThrow("capture exploded");
      expect(deps.store.listAll()).toEqual([]);
      expect(deps.bindings.get(PROJECT_KEY)).toBeNull();
    } finally { deps.close(); }
  });

  test("an explicit board overrides the remembered one", async () => {
    const first = fakeBoard({ id: "kan" });
    const second = fakeBoard({ id: "other" });
    const deps = harness([first.board, second.board]);
    try {
      await captureSessionTask(deps, { agent: "claude", sid: SID, title: "a", projectId: BOARD_PROJECT });
      await captureSessionTask(deps, {
        agent: "claude", sid: SID, title: "b", boardId: "other", projectId: BOARD_PROJECT,
      });
      expect(second.captures).toHaveLength(1);
      expect(deps.bindings.get(PROJECT_KEY)?.boardId).toBe("other");
    } finally { deps.close(); }
  });
});

describe("refreshSessionTasks", () => {
  test("updates open tasks and leaves an offline board's snapshots alone", async () => {
    const online = fakeBoard({ id: "kan" });
    const deps = harness([online.board]);
    try {
      await captureSessionTask(deps, { agent: "claude", sid: SID, title: "想法", projectId: BOARD_PROJECT });
      const offlineDeps: SessionTaskDeps = {
        ...deps, boards: new BoardRegistry([fakeBoard({ id: "kan", offline: true }).board]),
      };
      const summary = await refreshSessionTasks(offlineDeps);
      expect(summary).toEqual({ boards: 1, updated: 0, offline: ["kan"] });
      expect(deps.store.listForSession("claude", SID)[0]?.title).toBe("想法");

      expect((await refreshSessionTasks(deps)).offline).toEqual([]);
    } finally { deps.close(); }
  });

  test("skips boards with nothing open", async () => {
    const deps = harness([fakeBoard().board]);
    try {
      expect(await refreshSessionTasks(deps)).toEqual({ boards: 0, updated: 0, offline: [] });
    } finally { deps.close(); }
  });
});

describe("boardOverviews", () => {
  test("keeps an offline board visible with its error", async () => {
    const deps = harness([fakeBoard({ id: "kan", offline: true }).board, fakeBoard({ id: "up" }).board]);
    try {
      const overviews = await boardOverviews(deps);
      expect(overviews.map((board) => board.online)).toEqual([false, true]);
      expect(overviews[0]?.error).toContain("unreachable");
      expect(overviews[1]?.projects).toHaveLength(1);
    } finally { deps.close(); }
  });
});
