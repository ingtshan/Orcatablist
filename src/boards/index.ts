import type { Database } from "bun:sqlite";
import { BoardRegistry, type BoardProject, type TaskBoard } from "./board";
import { boardConfigsFromEnv, type RemoteBoardConfig } from "./config";
import { createKansessionBoard } from "./kansession";
import { createLocalBoard } from "./local";

export * from "./board";
export { boardConfigsFromEnv, parseBoardConfigs, type RemoteBoardConfig } from "./config";
export { createKansessionBoard, type KansessionBoardConfig } from "./kansession";
export { createLocalBoard, LOCAL_BOARD_ID } from "./local";
export {
  openBoardDatabase, ProjectBoardStore, SessionTaskStore,
  type ProjectBoardBinding, type SessionTaskLink,
} from "./store";

export interface BoardRegistryDeps {
  database: Database;
  listLocalProjects(): BoardProject[];
  configs?: RemoteBoardConfig[];
}

function createRemoteBoard(config: RemoteBoardConfig): TaskBoard {
  return createKansessionBoard({
    id: config.id, name: config.name, baseUrl: config.baseUrl,
    webUrl: config.webUrl, apiKey: config.apiKey,
  });
}

export function createBoardRegistry(deps: BoardRegistryDeps): BoardRegistry {
  const configs = deps.configs ?? boardConfigsFromEnv();
  return new BoardRegistry([
    createLocalBoard({ database: deps.database, listProjects: deps.listLocalProjects }),
    ...configs.map(createRemoteBoard),
  ]);
}
