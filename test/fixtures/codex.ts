export const CODEX_FIXTURE_LINES = [
  String.raw`{"timestamp":"2026-08-25T11:27:29.935Z","ordinal":0,"type":"session_meta","payload":{"session_id":"01a038ac-e470-76e1-9c39-8abaa62c1042","cwd":"/Users/bb00/workspace/plan-review-skill","originator":"codex-tui","cli_version":"0.149.1","git":{"branch":"main"}}}`,
  String.raw`{"timestamp":"2026-08-25T11:29:19.153Z","ordinal":2,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions\n\n<INSTRUCTIONS>x</INSTRUCTIONS>"}]}}`,
  String.raw`{"timestamp":"2026-08-25T11:29:19.259Z","ordinal":3,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"ROLE: EXECUTOR 真实用户输入"}]}}`,
  String.raw`{"timestamp":"2026-08-25T11:30:00.000Z","ordinal":4,"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"助手回复用于搜索 独特词 鲸鱼"}]}}`,
  String.raw`{"timestamp":"2026-08-25T11:31:00.000Z","ordinal":5,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>cwd=/x</environment_context>"}]}}`,
] as const;

export const CODEX_SID = "01a038ac-e470-76e1-9c39-8abaa62c1042";
