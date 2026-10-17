// Rclone filter rules for one target. The rules are the definition of what a
// target mirrors: `run` passes the file to `rclone sync` together with
// --delete-excluded, so adding a rule here also deletes the matching files
// from the destination.

export interface RepoIgnores {
  /** Repository directory relative to the target root, "" for the root itself. */
  repo: string;
  /** Paths from `git ls-files --ignored --others --exclude-standard --directory`. */
  entries: string[];
}

export interface FilterStats {
  include: number;
  exclude: number;
  gitignore: number;
  user: number;
  repos: number;
}

export interface FilterResult {
  lines: string[];
  errors: string[];
  stats: FilterStats;
}

/** Escape the glob characters rclone would otherwise read as wildcards. */
export function escapeGlob(path: string): string {
  return path.replace(/[\\*?[\]{}]/g, (char) => `\\${char}`);
}

function normalizeSlashes(path: string): string {
  return path.split("\\").join("/");
}

/**
 * Map a `~/.config/raccache/ignore` line onto a rule for `dest`.
 *
 * Lines are paths under $HOME, so a single file can describe every target:
 * `dev/reference/**` becomes `- /reference/**` for the target whose dest is
 * `dev` and is ignored by the others. Globs are allowed and pass through.
 */
function userRule(line: string, dest: string): { rule?: string; error?: string } {
  const trailingSlash = normalizeSlashes(line).endsWith("/");
  const path = normalizeSlashes(line).replace(/\/+$/, "").replace(/^~?\//, "");
  if (!path) return {};
  if (path !== dest && !path.startsWith(`${dest}/`)) return {};
  const rest = path.slice(dest.length).replace(/^\//, "");
  if (!rest) return { error: `'${line}' would exclude the whole '${dest}' target` };
  const parts = rest.split("/");
  if (parts.includes("..") || parts.includes(".")) return { error: `'${line}' has a relative path segment` };
  if (parts.some((part) => !part)) return { error: `'${line}' has an empty path segment` };
  // A path made only of glob syntax (`*`, `**`, `?`, brackets, braces) matches
  // every entry at some level, and with --delete-excluded that empties part of
  // the destination instead of failing the run: require one literal character.
  if (!/[A-Za-z0-9_.-]/.test(rest)) {
    return { error: `'${line}' would exclude the whole '${dest}' target` };
  }
  return { rule: `- /${rest}${trailingSlash ? "/" : ""}` };
}

export function buildFilters(opts: {
  dest: string;
  include: string[];
  exclude: string[];
  repoIgnores?: RepoIgnores[];
  userIgnore: string[];
}): FilterResult {
  const repoIgnores = opts.repoIgnores ?? [];
  const lines: string[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];
  const stats: FilterStats = { include: 0, exclude: 0, gitignore: 0, user: 0, repos: repoIgnores.length };

  const push = (rule: string, kind: "include" | "exclude" | "gitignore" | "user") => {
    if (seen.has(rule)) return;
    seen.add(rule);
    lines.push(rule);
    stats[kind]++;
  };

  // Exceptions first: the first match wins, and everything unmatched is kept.
  for (const pattern of opts.include) push(`+ ${pattern}`, "include");
  for (const pattern of opts.exclude) push(`- ${pattern}`, "exclude");

  for (const { repo, entries } of repoIgnores) {
    const prefix = repo ? `${escapeGlob(normalizeSlashes(repo))}/` : "";
    for (const entry of entries) {
      const path = normalizeSlashes(entry);
      if (!path) continue;
      if (path.endsWith("/")) push(`- /${prefix}${escapeGlob(path)}`, "gitignore");
      else push(`- /${prefix}${escapeGlob(path)}`, "gitignore");
    }
  }

  for (const line of opts.userIgnore) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const { rule, error } = userRule(trimmed, opts.dest);
    if (error) errors.push(error);
    else if (rule) push(rule, "user");
  }

  return { lines, errors, stats };
}

/** The generated filter file: a header, then one rule per line. */
export function renderFilter(dest: string, lines: string[]): string {
  return [`# raccache filters for '${dest}' — generated, edits are overwritten`, ...lines, ""].join("\n");
}
