// The scheduled job: mirror every target into this machine's directory on the
// destination remote, then report. Exits 0 when the run completed or was
// skipped, 1 on any failure; the notification carries the counts either way.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { loadMachine, type Paths, paths, type Settings, type Target } from "./config";
import { buildFilters, type FilterResult, type RepoIgnores, renderFilter } from "./filters";
import { guardVerdict, observe } from "./guards";
import { acquireLock, releaseLock } from "./lock";
import { notify } from "./notify";
import { type Counts, parseCounts, rcloneReady, remoteConfigured, remotes, runSync, syncArgs } from "./rclone";
import { collectRepoIgnores, discoverRepos } from "./repos";

const LOG_ROTATE_BYTES = 10_000_000;

export interface RunOptions {
  dryRun?: boolean;
  /** Run only this target, by dest. */
  only?: string;
  /** Run only this destination, by name. */
  destination?: string;
  configDir?: string;
  platform?: NodeJS.Platform;
}

export interface GeneratedFilter {
  file: string;
  rules: FilterResult;
  repoErrors: string[];
}

/**
 * Write the filter file for one target. With `gitignore`, every repo under the
 * target contributes the paths git ignores; `~/.config/raccache/ignore` adds
 * whole trees by $HOME-relative path.
 */
export function generateFilter(target: Target, settings: Settings, p: Paths): GeneratedFilter {
  const userIgnore = existsSync(p.ignore) ? readFileSync(p.ignore, "utf8").split("\n") : [];
  let repoIgnores: RepoIgnores[] = [];
  let repoErrors: string[] = [];
  if (target.gitignore) {
    const collected = collectRepoIgnores(target.src, discoverRepos(target.src), settings.git);
    repoIgnores = collected.ignores;
    repoErrors = collected.errors;
  }
  const rules = buildFilters({
    dest: target.dest,
    include: settings.include,
    exclude: settings.exclude,
    repoIgnores,
    userIgnore,
  });
  const file = join(p.dir, `filter.${target.dest.replaceAll("/", "_")}`);
  writeFileSync(`${file}.tmp`, renderFilter(target.dest, rules.lines));
  renameSync(`${file}.tmp`, file);
  return { file, rules, repoErrors };
}

/** Log lines written after `offset`, which is a *byte* count from statSync. */
export function logLinesSince(file: string, offset: number): string[] {
  try {
    return readFileSync(file).subarray(offset).toString("utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export async function runBackup(options: RunOptions = {}): Promise<number> {
  const p = paths({ platform: options.platform, dir: options.configDir });
  mkdirSync(p.dir, { recursive: true });
  mkdirSync(dirname(p.log), { recursive: true });
  const log = (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    appendFileSync(p.log, `${stamped}\n`);
    // A manual run should say what it is doing; launchd redirects stdout anyway.
    if (process.stdout.isTTY) process.stdout.write(`${stamped}\n`);
  };
  const host = hostname().split(".")[0];
  const title = `raccache ${host || "run"}`;
  const machine = loadMachine(p);
  const { settings } = machine;
  const env = { ...process.env, ...machine.env };
  const ntfyUrl = machine.env.RACCACHE_NTFY_URL;
  const fail = async (message: string): Promise<number> => {
    log(`ERROR: ${message}`);
    await notify(p.ntfy, {
      title: `${title}: FAILED`,
      message,
      priority: "high",
      tags: "rotating_light",
      url: ntfyUrl,
    });
    return 1;
  };
  for (const warning of machine.warnings) log(`config: ${warning}`);

  const ready = rcloneReady(settings.rclone, env);
  if (!ready.ok) return fail(ready.reason ?? "rclone not runnable");
  if (machine.errors.length > 0) return fail(machine.errors.join("; "));
  const configured = remotes(settings.rclone, env);
  const missing = machine.destinations.filter((destination) => !remoteConfigured(configured, destination.remote));
  if (missing.length > 0) {
    return fail(`not configured as rclone remotes: ${missing.map((d) => `${d.name} (${d.remote})`).join(", ")}`);
  }

  if (existsSync(p.pause)) {
    log(`paused: ${p.pause} exists - skipping (remove the file to resume)`);
    return 0;
  }

  const lock = acquireLock(p.lock);
  if (!lock.acquired) {
    log(`${lock.reason} - skipping`);
    return 0;
  }
  try {
    const size = statSync(p.log, { throwIfNoEntry: false })?.size ?? 0;
    if (size > LOG_ROTATE_BYTES) renameSync(p.log, `${p.log}.1`);

    const guards = () =>
      guardVerdict(observe(options.platform), { powerGuard: settings.powerGuard, homeGateway: settings.homeGateway });
    const start = guards();
    if (!start.ok) {
      log(`skip: guard condition not met at start (${start.reason})`);
      return 0;
    }

    const targets = options.only ? machine.targets.filter((target) => target.dest === options.only) : machine.targets;
    const destinations = options.destination
      ? machine.destinations.filter((destination) => destination.name === options.destination)
      : machine.destinations;
    if (options.only && targets.length === 0) return fail(`no target named '${options.only}'`);
    if (options.destination && destinations.length === 0) return fail(`no destination named '${options.destination}'`);

    const scope = `${targets.length} target${targets.length === 1 ? "" : "s"} x ${destinations.length} destination${destinations.length === 1 ? "" : "s"}`;
    log(`raccache start (${scope}${options.dryRun ? ", dry run" : ""})`);
    const startTs = Date.now();
    let rc = 0;
    const pairs: Array<{ label: string; counts: Counts }> = [];

    for (const target of targets) {
      if (!existsSync(target.src)) {
        log(`${target.dest} SKIPPED (missing): ${target.src}`);
        continue;
      }
      const midRun = guards();
      if (!midRun.ok) {
        log(`${target.dest} ABORTED: ${midRun.reason}`);
        rc = 1;
        continue;
      }

      let filter: GeneratedFilter;
      try {
        filter = generateFilter(target, settings, p);
      } catch (error) {
        log(`${target.dest} FAILED to build filters: ${error instanceof Error ? error.message : String(error)}`);
        rc = 1;
        continue;
      }
      for (const warning of filter.repoErrors) log(`filters ${target.dest}: ${warning}`);
      if (filter.rules.errors.length > 0) {
        // An exclusion the config asked for cannot be honored; uploading with
        // the rules that remain would be silent data loss of intent.
        log(`${target.dest} FAILED: ${filter.rules.errors.join("; ")}`);
        rc = 1;
        continue;
      }
      const { include, exclude, gitignore, user, repos } = filter.rules.stats;
      log(
        `${target.dest} filters: ${gitignore} from ${repos} repos, ${user} from ignore, ${exclude + include} built in`,
      );

      for (const destination of destinations) {
        const label = `${destination.name}/${target.dest}`;
        const offset = statSync(p.log, { throwIfNoEntry: false })?.size ?? 0;
        const status = runSync(
          settings.rclone,
          syncArgs({
            src: target.src,
            dest: `${destination.remote}/${target.dest}`,
            filterFile: filter.file,
            logFile: p.log,
            bwLimit: settings.bwLimit,
            dryRun: options.dryRun,
            mode: destination.mode,
            extraFlags: destination.flags,
          }),
          p.log,
          env,
        );
        const counts = parseCounts(logLinesSince(p.log, offset));
        pairs.push({ label, counts });
        if (status === 0) {
          log(`${label} ok (${counts.copied} new, ${counts.changed} changed, ${counts.deleted} deleted)`);
        } else {
          log(`${label} FAILED rc=${status}`);
          rc = 1;
        }
      }
    }

    const total = pairs.reduce<Counts>(
      (sum, pair) => ({
        copied: sum.copied + pair.counts.copied,
        changed: sum.changed + pair.counts.changed,
        deleted: sum.deleted + pair.counts.deleted,
      }),
      { copied: 0, changed: 0, deleted: 0 },
    );
    const took = Math.round((Date.now() - startTs) / 1000);
    log(`raccache done rc=${rc} (${total.copied} new, ${total.changed} changed, ${total.deleted} deleted in ${took}s)`);

    const moved = pairs.filter((pair) => pair.counts.copied + pair.counts.changed + pair.counts.deleted > 0);
    const breakdown = moved
      .map(
        (pair) =>
          `${pair.label}: ${pair.counts.copied} new, ${pair.counts.changed} changed, ${pair.counts.deleted} deleted`,
      )
      .join("\n");
    const suffix = `${options.dryRun ? " (dry run)" : ""}`;
    const totals = `${total.copied} new, ${total.changed} changed, ${total.deleted} deleted`;
    if (rc !== 0) {
      await notify(p.ntfy, {
        title: `${title}: FAILED`,
        message: `rc=${rc} after ${took}s — ${totals}${suffix}. Log: ${p.log}${breakdown ? `\n${breakdown}` : ""}`,
        priority: "high",
        tags: "rotating_light",
        url: ntfyUrl,
      });
    } else if (moved.length > 0) {
      await notify(p.ntfy, {
        title: `${title}: ${totals}`,
        message: `uploaded to ${destinations.map((d) => d.name).join(", ")} in ${took}s${suffix}\n${breakdown}`,
        url: ntfyUrl,
      });
    }
    return rc;
  } finally {
    releaseLock(p.lock);
  }
}
