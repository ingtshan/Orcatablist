/** Read only the latest typed settings; transcript bytes/cursors and remote files stay untouched. */
export const REMOTE_EXECUTION_SCRIPT = String.raw`
EXECUTION_READ_BATCH = 8
EXECUTION_READ_BLOCK = 65536

def execution_label(value, limit):
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value if value and len(value) <= limit and not any(ord(c) < 32 or c in "<>" for c in value) else None

def reverse_complete_lines(path, size):
    with open(path, "rb") as stream:
        position, pending, tail = size, b"", True
        while position > 0:
            count = min(position, EXECUTION_READ_BLOCK)
            position -= count
            stream.seek(position)
            parts = (stream.read(count) + pending).split(b"\n")
            pending = parts[0]
            if tail and len(parts) > 1:
                parts.pop()  # Ignore the final partial record (or empty trailing line).
                tail = False
            for line in reversed(parts[1:]):
                yield line
        if not tail and pending:
            yield pending

def read_execution(path, size, agent):
    effort, effort_seen = None, False
    for line in reverse_complete_lines(path, size):
        try:
            event = json.loads(line)
        except (ValueError, UnicodeDecodeError):
            continue
        if not isinstance(event, dict):
            continue
        if agent == "codex" and event.get("type") == "turn_context":
            payload = event.get("payload")
            if not isinstance(payload, dict):
                continue
            model = payload.get("model")
            value = payload.get("effort")
            value = payload.get("reasoning_effort") if value is None else value
        elif agent == "claude" and event.get("type") == "assistant":
            message = event.get("message")
            model = message.get("model") if isinstance(message, dict) else None
            value = event.get("effort")
        else:
            continue
        if model == "<synthetic>":
            continue
        model = execution_label(model, 160)
        value = execution_label(value, 32)
        if not effort_seen and (value is not None or model is not None):
            effort, effort_seen = value, True
        if model is not None:
            return {"model": model, "reasoningEffort": effort}
    return {"model": None, "reasoningEffort": effort}
`;
