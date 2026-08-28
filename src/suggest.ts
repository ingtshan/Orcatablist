import { sessionIdentityKey } from "./session-identity";
import type { Goal, SessionRow, SessionSuggestion, SuggestionReason } from "./types";

const MAX_TITLE_SCORE = 3;
const BRANCH_SCORE = 3;
const PROJECT_SCORE = 2;
const CONTEXT_SCORE = 2;
const MINIMUM_SCORE = 2;
const DEFAULT_LIMIT = 8;
const LATIN_WORD_PATTERN = /[a-z]+/g;
// A default branch shared by nearly every repo is not evidence of shared intent.
const GENERIC_BRANCHES = new Set(["main", "master", "develop", "dev", "trunk", "release"]);
const CJK_CHARACTER_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

export function tokens(value: string): Set<string> {
  const normalized = value.toLocaleLowerCase();
  const result = new Set<string>();
  for (const match of normalized.matchAll(LATIN_WORD_PATTERN)) {
    const word = match[0];
    if (word.length >= 3 && !/^\d+$/.test(word)) result.add(word);
  }
  const characters = Array.from(normalized);
  for (let index = 0; index < characters.length - 1; index += 1) {
    const first = characters[index]!;
    const second = characters[index + 1]!;
    if (CJK_CHARACTER_PATTERN.test(first) && CJK_CHARACTER_PATTERN.test(second)) result.add(first + second);
  }
  return result;
}

function matchingTokens(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((token) => right.has(token));
}

function finalProjectSegment(projectKey: string): string {
  const normalized = projectKey.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() ?? normalized;
}

function validBranch(branch: string | null): branch is string {
  return Boolean(branch && branch !== "HEAD");
}

// Branch is a *discriminating* signal only when it is not a repo-wide default.
function discriminatingBranch(branch: string | null): branch is string {
  return validBranch(branch) && !GENERIC_BRANCHES.has(branch.toLocaleLowerCase());
}

export function suggestSessions(
  goal: Goal,
  confirmed: SessionRow[],
  excluded: Set<`${string}/${string}`>,
  pool: SessionRow[],
  limit = DEFAULT_LIMIT,
  options: { contextPath?: string } = {},
): SessionSuggestion[] {
  const confirmedKeys = new Set(confirmed.map((row) => sessionIdentityKey(row.agent, row.sid)));
  const confirmedBranches = new Set(confirmed.map((row) => row.branch).filter(discriminatingBranch));
  const confirmedProjects = new Set(confirmed.map((row) => row.projectKey));
  const goalTokens = tokens(goal.name);
  const contextPath = options.contextPath?.trim();
  for (const row of confirmed) {
    for (const token of tokens(row.displayTitle)) goalTokens.add(token);
  }

  const suggestions: SessionSuggestion[] = [];
  for (const row of pool) {
    const key = sessionIdentityKey(row.agent, row.sid);
    if (excluded.has(key) || confirmedKeys.has(key)) continue;
    let score = 0;
    const reasons: SuggestionReason[] = [];

    if (confirmed.length > 0) {
      if (discriminatingBranch(row.branch) && confirmedBranches.has(row.branch)) {
        score += BRANCH_SCORE;
        reasons.push({ code: "branch", label: `同分支 ${row.branch}` });
      }
      if (confirmedProjects.has(row.projectKey)) {
        score += PROJECT_SCORE;
        reasons.push({ code: "project", label: `同项目 ${finalProjectSegment(row.projectKey)}` });
      }
    } else {
      const projectMatches = matchingTokens(tokens(finalProjectSegment(row.projectKey)), goalTokens);
      if (projectMatches.length > 0) {
        score += PROJECT_SCORE;
        reasons.push({ code: "project", label: `项目含 “${projectMatches[0]}”` });
      }
      const branchMatches = discriminatingBranch(row.branch) ? matchingTokens(tokens(row.branch), goalTokens) : [];
      if (branchMatches.length > 0) {
        score += BRANCH_SCORE;
        reasons.push({ code: "branch", label: `分支含 “${branchMatches[0]}”` });
      }
    }

    if (contextPath && (row.cwd === contextPath || row.projectKey.includes(contextPath))) {
      score += CONTEXT_SCORE;
      reasons.push({ code: "project", label: `同上下文 ${finalProjectSegment(contextPath)}` });
    }

    const titleMatches = matchingTokens(tokens(`${row.displayTitle} ${row.firstPrompt ?? ""}`), goalTokens);
    if (titleMatches.length > 0) {
      score += Math.min(MAX_TITLE_SCORE, titleMatches.length);
      reasons.push({ code: "title", label: `标题含 “${titleMatches[0]}”` });
    }
    if (score >= MINIMUM_SCORE) suggestions.push({ ...row, score, reasons });
  }

  return suggestions
    .sort((left, right) => right.score - left.score
      || (right.lastInputAt ?? -1) - (left.lastInputAt ?? -1)
      || left.agent.localeCompare(right.agent)
      || left.sid.localeCompare(right.sid))
    .slice(0, Math.max(0, limit));
}
