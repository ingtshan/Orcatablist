import { REMOTE_EXECUTION_SCRIPT } from "./remote-execution";

/**
 * The remote half of the pull protocol. Runs on the remote /usr/bin/python3 (macOS ships 3.9+ with
 * the CLI tools) and is shipped inside argv, so it lives apart from the local assembly code.
 */

/**
 * Runs on the remote /usr/bin/python3 (macOS ships 3.9+ with the CLI tools). Read-only by
 * design: stat listings and ranged reads, never a write. Freshest files are shipped first so an
 * over-budget bootstrap surfaces active sessions before historical ones.
 */
export const COLLECTOR_SCRIPT = `
import sys, os, re, json, base64, time, errno

${REMOTE_EXECUTION_SCRIPT}

def emit(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\\n")
    sys.stdout.flush()

def report(agent, action, path, exc):
    # A listing this round could not read is a hole in the inventory, and the caller must know:
    # silently shorter listings would look like deletions and hand ownership to a stale duplicate.
    emit({"type": "error", "agent": agent, "path": path,
          "message": "failed to %s %s for %s: %s" % (action, path, agent, exc.strerror or exc)})

def vanished(exc):
    """A path that disappeared mid-scan is a race, not a fault worth degrading the round."""
    return exc.errno == errno.ENOENT

def root_state(path):
    """ok / missing / error. A root that cannot be examined is not an absent root."""
    try:
        os.stat(path)
    except OSError as exc:
        return ("missing", None) if vanished(exc) else ("error", exc)
    return ("ok", None) if os.path.isdir(path) else ("missing", None)

try:
    req = json.load(sys.stdin)
except Exception as exc:
    emit({"type": "error", "message": "bad request: %s" % exc})
    emit({"type": "done", "truncated": False})
    raise SystemExit(0)

probe = bool(req.get("probe"))

SESSION_PAT = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.jsonl$")
claude = req.get("claude") or None
claude_root = os.path.expanduser(((claude or {}).get("dir")) or "~/.claude/projects")
files = []
claude_state, claude_error = root_state(claude_root) if claude else ("missing", None)
if claude and claude_state == "error":
    report("claude", "read", claude_root, claude_error)
elif claude and claude_state == "missing":
    if not probe:
        # A machine that never ran the claude CLI has no projects directory. That is a normal
        # empty state, not a failure: report it as informational so the poller stays green.
        emit({"type": "missing", "agent": "claude", "dir": claude_root})
elif claude:
    try:
        project_entries = sorted(os.listdir(claude_root))
    except OSError as exc:
        project_entries = []
        report("claude", "list", claude_root, exc)
    for entry in project_entries:
        directory = os.path.join(claude_root, entry)
        if not os.path.isdir(directory):
            continue
        try:
            names = sorted(os.listdir(directory))
        except OSError as exc:
            if not vanished(exc):
                report("claude", "list", directory, exc)
            continue
        for name in names:
            if not SESSION_PAT.match(name):
                continue
            path = os.path.join(directory, name)
            try:
                st = os.stat(path)
            except OSError as exc:
                if not vanished(exc):
                    report("claude", "stat", path, exc)
                continue
            files.append({"path": path, "size": st.st_size, "mtime": int(st.st_mtime * 1000)})

ROLLOUT_PAT = re.compile(r"^rollout-.*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.jsonl$")
codex = req.get("codex") or None
codex_base = os.path.expanduser(((codex or {}).get("dir")) or "~/.codex")
codex_root = os.path.join(codex_base, "sessions")
codex_files = []
codex_state, codex_error = root_state(codex_root) if codex else ("missing", None)
if codex and codex_state == "error":
    report("codex", "read", codex_root, codex_error)
elif codex and codex_state == "missing":
    if not probe:
        emit({"type": "missing", "agent": "codex", "dir": codex_root})
elif codex:
    cutoff = 0.0
    since_days = codex.get("sinceDays")
    if since_days:
        cutoff = (time.time() - float(since_days) * 86400.0) * 1000.0
    walk_errors = []
    for dirpath, dirnames, filenames in os.walk(codex_root, onerror=walk_errors.append):
        for name in filenames:
            if not ROLLOUT_PAT.match(name):
                continue
            path = os.path.join(dirpath, name)
            try:
                st = os.stat(path)
            except OSError as exc:
                if not vanished(exc):
                    report("codex", "stat", path, exc)
                continue
            mtime = int(st.st_mtime * 1000)
            if mtime < cutoff:
                continue
            codex_files.append({"path": path, "size": st.st_size, "mtime": mtime})
    # os.walk swallows directory errors by default, which would silently shorten the listing.
    for exc in walk_errors:
        if not vanished(exc):
            report("codex", "walk", getattr(exc, "filename", None) or codex_root, exc)
    codex_files.sort(key=lambda f: f["path"])

if probe:
    emit({"type": "probe", "python": sys.version.split()[0], "home": os.path.expanduser("~"),
          "claude": {"dir": claude_root, "ok": os.path.isdir(claude_root), "files": len(files),
                     "bytes": sum(f["size"] for f in files)},
          "codex": {"dir": codex_root, "ok": os.path.isdir(codex_root), "files": len(codex_files),
                    "bytes": sum(f["size"] for f in codex_files)}})
    emit({"type": "done", "truncated": False})
    raise SystemExit(0)

if claude:
    emit({"type": "list", "agent": "claude", "files": files})
if codex:
    emit({"type": "list", "agent": "codex", "files": codex_files})
    # Codex thread names live in one small append-mostly index file; ship it whole when its
    # stat moved past what the caller last applied.
    index_path = os.path.join(codex_base, "session_index.jsonl")
    prev = codex.get("index") or {}
    try:
        ist = os.stat(index_path)
        imtime = int(ist.st_mtime * 1000)
        if (ist.st_size != prev.get("size") or imtime != prev.get("mtime")) and ist.st_size <= 4194304:
            with open(index_path, "rb") as fh:
                emit({"type": "aux", "name": "codex-session-index", "size": ist.st_size,
                      "mtime": imtime, "data": base64.b64encode(fh.read()).decode("ascii")})
    except OSError:
        pass

cursors = req.get("cursors") or {}
budget = int(req.get("maxBytes") or 8388608)
quantum = int(req.get("quantum") or 0) or 1048576
last_path = req.get("lastPath")
CHUNK = 262144

def as_int(value):
    return None if value is None else int(value)

# Stable path order, not mtime order: a file whose mtime keeps moving cannot keep jumping ahead
# of colder files and starve them round after round.
eligible = []
execution_reads = 0
for f in sorted(files + codex_files, key=lambda entry: entry["path"]):
    cur = cursors.get(f["path"])
    prev_size = None
    prev_mtime = None
    skip = False
    exclude = False
    rebuild = False
    if isinstance(cur, dict):
        # offset is what the caller durably received; size/mtime describe the file it received from.
        offset = int(cur.get("offset") or 0)
        prev_size = as_int(cur.get("size"))
        prev_mtime = as_int(cur.get("mtime"))
        skip = bool(cur.get("skip"))
        exclude = bool(cur.get("exclude"))
        rebuild = cur.get("rebuild") is True
    else:
        offset = int(cur or 0)
    if exclude:
        # A duplicate the caller's owner rule will never consume: shipping it only buffers bytes.
        continue
    execution_agent = cur.get("executionAgent") if isinstance(cur, dict) else None
    if execution_agent in ("claude", "codex") and execution_reads < EXECUTION_READ_BATCH:
        try:
            settings = read_execution(f["path"], f["size"], execution_agent)
            emit({"type": "execution", "path": f["path"], "settings": settings})
            execution_reads += 1
        except OSError as exc:
            report(execution_agent, "read execution settings", f["path"], exc)
    size = f["size"]
    mtime = f["mtime"]
    # Growth is an append; a shrink or a same-size file whose mtime moved is a different file.
    replaced = prev_size is not None and (
        size < prev_size or (size == prev_size and prev_mtime is not None and prev_mtime != mtime))
    if rebuild or size < offset or replaced:
        emit({"type": "rebuild", "path": f["path"]})
        offset = 0
        skip = False
    if skip and prev_size == size and prev_mtime == mtime:
        # A record the caller cannot buffer; do not spend the budget on it until the file moves.
        continue
    if size <= offset:
        continue
    eligible.append({"path": f["path"], "offset": offset, "size": size, "mtime": mtime, "stopped": False})

start = 0
if eligible:
    if isinstance(last_path, str) and last_path:
        # Resume after the file served last round, or at its lexical successor if it is gone.
        start = 0
        for i, e in enumerate(eligible):
            if e["path"] > last_path:
                start = i
                break
    else:
        for i, e in enumerate(eligible):
            if e["mtime"] > eligible[start]["mtime"]:
                start = i

order = [eligible[(start + i) % len(eligible)] for i in range(len(eligible))]
visited = None
while budget > 0:
    moved = False
    for e in order:
        if budget <= 0:
            break
        if e["stopped"] or e["offset"] >= e["size"]:
            continue
        want = min(quantum, e["size"] - e["offset"], budget)
        sent = 0
        try:
            with open(e["path"], "rb") as fh:
                fh.seek(e["offset"])
                while sent < want:
                    data = fh.read(min(CHUNK, want - sent))
                    if not data:
                        e["stopped"] = True
                        break
                    emit({"type": "chunk", "path": e["path"], "offset": e["offset"] + sent,
                          "data": base64.b64encode(data).decode("ascii")})
                    sent += len(data)
        except OSError as exc:
            e["stopped"] = True
            emit({"type": "error", "path": e["path"], "message": str(exc)})
        if sent > 0:
            e["offset"] += sent
            budget -= sent
            visited = e["path"]
            moved = True
    if not moved:
        break

# Truncated means the byte budget cut the round short, not that a file hit EOF or was skipped.
truncated = any(e["offset"] < e["size"] and not e["stopped"] for e in order)
emit({"type": "done", "truncated": truncated, "lastPath": visited})
`;

export function remoteCollectorCommand(script = COLLECTOR_SCRIPT): string {
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return `python3 -c 'import base64;exec(base64.b64decode("${encoded}"))'`;
}
