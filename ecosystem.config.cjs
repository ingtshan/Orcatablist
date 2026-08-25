const path = require("node:path");
const home = process.env.HOME || require("node:os").homedir();
module.exports = {
  apps: [{
    name: "orcatab",
    cwd: __dirname,
    script: "src/main.ts",
    interpreter: "/opt/homebrew/bin/bun",
    env: { ORCATAB_PORT: "47831" },
    autorestart: true, watch: false, max_restarts: 10, restart_delay: 2000,
    out_file: path.join(home, ".orcatab", "logs", "out.log"),
    error_file: path.join(home, ".orcatab", "logs", "err.log"),
    merge_logs: true, time: true,
  }],
};
