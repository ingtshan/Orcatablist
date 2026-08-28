import { describe, expect, test } from "bun:test";
import {
  BoardRegistry, createBoardRegistry, createLocalBoard, LOCAL_BOARD_ID, MAX_TASK_TITLE_CHARS,
  normalizeTaskTitle, openBoardDatabase, parseBoardConfigs, UnknownBoardError, type TaskBoard,
} from "../src/boards";

const PROJECT_ID = "proj";

function localBoard(): TaskBoard {
  return createLocalBoard({
    database: openBoardDatabase(":memory:"),
    listProjects: () => [{ id: PROJECT_ID, name: "orcatab", url: null }],
  });
}

function stubBoard(id: string, kind: TaskBoard["kind"]): TaskBoard {
  return {
    id, name: id, kind,
    capabilities: () => ({ projects: true, capture: true, lookup: true, backlink: false }),
    listProjects: async () => [],
    capture: async () => { throw new Error("not used"); },
    lookup: async () => new Map(),
  };
}

describe("normalizeTaskTitle", () => {
  test("collapses whitespace so a title stays one line on both sides of the seam", () => {
    expect(normalizeTaskTitle("  把 suggest 的\n IDF  降权做掉 ")).toBe("把 suggest 的 IDF 降权做掉");
  });

  test("rejects empty, non-string and oversized titles", () => {
    expect(() => normalizeTaskTitle("   ")).toThrow("title is required");
    expect(() => normalizeTaskTitle(42)).toThrow("title must be a string");
    expect(() => normalizeTaskTitle("x".repeat(MAX_TASK_TITLE_CHARS + 1)))
      .toThrow(`at most ${MAX_TASK_TITLE_CHARS}`);
  });
});

describe("local board adapter", () => {
  test("captures a task, then finds it again by id", async () => {
    const board = localBoard();
    expect(board.kind).toBe("local");
    expect(board.capabilities().backlink).toBe(false);
    expect(board.backlink).toBeUndefined();

    const task = await board.capture({ projectId: PROJECT_ID, title: "  捕捉 一个 想法 " });
    expect(task).toMatchObject({
      boardId: LOCAL_BOARD_ID, projectId: PROJECT_ID, title: "捕捉 一个 想法",
      statusKind: "open", number: null, url: null,
    });

    const found = await board.lookup([task.taskId, "missing"]);
    expect(found.size).toBe(1);
    expect(found.get(task.taskId)?.title).toBe("捕捉 一个 想法");
  });

  test("lookup of nothing does not query", async () => {
    expect((await localBoard().lookup([])).size).toBe(0);
  });

  test("projects mirror OrcaTab's own project list", async () => {
    expect(await localBoard().listProjects()).toEqual([{ id: PROJECT_ID, name: "orcatab", url: null }]);
  });
});

describe("parseBoardConfigs", () => {
  test("normalizes urls and defaults the name to the id", () => {
    const [config] = parseBoardConfigs(JSON.stringify([{
      id: "kansession", kind: "kansession", baseUrl: "http://127.0.0.1:1337/", webUrl: "http://localhost:5173/",
    }]));
    expect(config).toEqual({
      id: "kansession", name: "kansession", kind: "kansession",
      baseUrl: "http://127.0.0.1:1337", webUrl: "http://localhost:5173", apiKey: null,
    });
  });

  test("rejects malformed config instead of silently dropping a board", () => {
    expect(() => parseBoardConfigs("{}")).toThrow("must be a JSON array");
    expect(() => parseBoardConfigs("not json")).toThrow("must be a JSON array");
    expect(() => parseBoardConfigs('[{"kind":"kansession","baseUrl":"http://x"}]')).toThrow("id must be");
    expect(() => parseBoardConfigs('[{"id":"a","kind":"jira","baseUrl":"http://x"}]')).toThrow("kind must be one of");
    expect(() => parseBoardConfigs('[{"id":"a","kind":"kansession","baseUrl":"nope"}]')).toThrow("valid URL");
    expect(() => parseBoardConfigs(JSON.stringify([
      { id: "a", kind: "kansession", baseUrl: "http://x" },
      { id: "a", kind: "kansession", baseUrl: "http://y" },
    ]))).toThrow('duplicate id "a"');
  });

  test("reserves the local id so an adapter cannot shadow the built-in board", () => {
    expect(() => parseBoardConfigs('[{"id":"local","kind":"kansession","baseUrl":"http://x"}]'))
      .toThrow('duplicate id "local"');
  });
});

describe("BoardRegistry", () => {
  test("prefers a configured board over local as the capture default", () => {
    const registry = new BoardRegistry([stubBoard("local", "local"), stubBoard("kansession", "kansession")]);
    expect(registry.defaultBoardId).toBe("kansession");
    expect(registry.list().map((board) => board.id)).toEqual(["local", "kansession"]);
  });

  test("falls back to local when nothing is configured", () => {
    const registry = createBoardRegistry({
      database: openBoardDatabase(":memory:"), listLocalProjects: () => [], configs: [],
    });
    expect(registry.defaultBoardId).toBe(LOCAL_BOARD_ID);
    expect(registry.get("nope")).toBeNull();
    expect(() => registry.require("nope")).toThrow(UnknownBoardError);
  });

  test("builds a kansession adapter from config", () => {
    const registry = createBoardRegistry({
      database: openBoardDatabase(":memory:"),
      listLocalProjects: () => [],
      configs: [{
        id: "kan", name: "板子", kind: "kansession",
        baseUrl: "http://127.0.0.1:1337", webUrl: null, apiKey: null,
      }],
    });
    const board = registry.require("kan");
    expect(board.name).toBe("板子");
    expect(board.capabilities()).toEqual({ projects: true, capture: true, lookup: true, backlink: true });
    expect(typeof board.backlink).toBe("function");
  });
});
