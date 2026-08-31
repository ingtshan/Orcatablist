import { conditionalJson } from "./http";

/**
 * Every conditional route composed its own ETag string by hand — nine literals, four prefixes,
 * and two different database counters (`listVersion` vs `dataVersion`) that had to be picked
 * correctly from memory. Nothing linked a payload's inputs to its ETag's inputs, so omitting a
 * counter produced a board that silently never updated, and the existing tests only asserted the
 * ETag's *shape*, which such a bug leaves intact.
 *
 * A route now names the versions its payload actually reads. The format lives here, once, and
 * `test/freshness.test.ts` holds every route to the rule that each declared source moves its ETag.
 */

export type Version = number | string;

export interface VersionSource {
  readonly name: string;
  read(): Version;
}

export function versionSource(name: string, read: () => Version): VersionSource {
  return { name, read };
}

/**
 * Deterministic and order-sensitive: a route's source list is part of its identity, so two routes
 * reading the same versions in a different order do not collide.
 */
export function composeEtag(tag: string, sources: readonly VersionSource[]): string {
  return `"${tag}:${sources.map((source) => String(source.read())).join(".")}"`;
}

/** Serves `build()` under a derived ETag, or 304 when the client already holds that version. */
export function serveFresh(
  request: Request,
  tag: string,
  sources: readonly VersionSource[],
  build: () => unknown,
): Response {
  return conditionalJson(request, composeEtag(tag, sources), build);
}
