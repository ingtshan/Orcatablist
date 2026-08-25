// Process entry for `bun run` and pm2. Kept separate from server.ts on purpose:
// pm2 wraps Bun scripts in ProcessContainerForkBun.js and imports them, so an
// `import.meta.main` guard inside server.ts never fires under pm2.
import { createServer } from "./server";

try {
  await createServer();
} catch (error) {
  console.error("orcatab startup failed", error instanceof Error ? error.stack : error);
  process.exit(1);
}
