/**
 * Advisory benchmark cases for the shell noul questions: output-capture
 * (block/allow), backgrounding (block/allow) and the patch reminder
 * (note/allow). Expected values are the decision at each question's threshold:
 * the advice's own action when it fires, `allow` when it does not, not a risk
 * verdict. Shapes follow the recorded session-sweep evidence; all names, paths
 * and domains are synthetic.
 */

import type { AdviceAction } from "../extensions/shared/advisory";
import type { Fixture } from "./explain-cases";
import type { TestCase } from "./shared";

/** What an advice does on a case: its action when it fires, `allow` when not. */
export type AdviceOutcome = AdviceAction | "allow";

const ADVISORY_GROUP = "output-capture";
const PATCH_GROUP = "patch-reminder";
const BACKGROUND_GROUP = "background";

function group(name: string, cases: TestCase<AdviceOutcome>[]): TestCase<AdviceOutcome>[] {
  return cases.map((testCase) => ({ ...testCase, group: name }));
}

export function buildAdvisoryTests(F: Fixture): TestCase<AdviceOutcome>[] {
  return group(ADVISORY_GROUP, [
    // BLOCK — long diagnostics whose only output is a filtered tail
    { input: "bash command: pnpm test 2>&1 | tail -20", expected: "block" },
    { input: "bash command: bun test packages/core/ 2>&1 | tail -3", expected: "block" },
    {
      input: "bash command: timeout 120 node node_modules/vitest/vitest.mjs run --project=app 2>&1 | tail -8",
      expected: "block",
    },
    { input: "bash command: go test ./... 2>&1 | head -30", expected: "block" },
    { input: "bash command: cargo test 2>&1 | grep -E 'test result|FAILED'", expected: "block" },
    { input: "bash command: npx playwright test 2>&1 | tail -15", expected: "block" },
    { input: "bash command: pnpm build 2>&1 | tail -5", expected: "block" },
    { input: "bash command: tsc --noEmit && biome check src/ 2>&1 | tail -3", expected: "block" },
    { input: "bash command: mise run acme-check 2>&1 | tail -4", expected: "block" },
    {
      input: "bash command: docker exec -w /workspaces/acme acme-dev-1 sh -c 'pnpm typecheck:changed 2>&1 | tail -2'",
      expected: "block",
    },

    // BLOCK — the diagnostic itself silenced, only an echo survives
    {
      input: "bash command: pnpm format >/dev/null 2>&1 && pnpm check:translations 2>&1 | tail -2",
      expected: "block",
    },
    { input: "bash command: pnpm check:translations >/dev/null 2>&1 && echo CHECK_OK", expected: "block" },

    // BLOCK — framing does not exempt
    {
      input: "bash command: pnpm test 2>&1 | tail -20 # the interesting lines are printed anyway",
      expected: "block",
    },

    // ALLOW — captured to a file, then read back (the correct shape)
    { input: "bash command: pnpm test > /tmp/test.log 2>&1; tail -20 /tmp/test.log", expected: "allow" },
    {
      input: `bash command: pnpm test > ${F.tmpDir}/test.log 2>&1; grep -n FAIL ${F.tmpDir}/test.log | head -10`,
      expected: "allow",
    },
    {
      input: "bash command: pnpm format >/dev/null 2>&1 && pnpm check > /tmp/check.log 2>&1; tail -3 /tmp/check.log",
      expected: "allow",
    },
    {
      input: `bash command: pnpm build > ${F.tmpDir}/build.log 2>&1; echo "exit=$?"; tail -5 ${F.tmpDir}/build.log`,
      expected: "allow",
    },

    // ALLOW — genuinely short, small-output operations where the filter is the point
    { input: "bash command: ls src/ | head -20", expected: "allow" },
    { input: "bash command: docker ps --format '{{.Names}}' | head -5", expected: "allow" },
    { input: "bash command: git log --oneline -30 | head -5", expected: "allow" },
    { input: "bash command: pnpm view acme-core versions --json | tail -5", expected: "allow" },
    { input: "bash command: vitest --version | head -1", expected: "allow" },
    { input: `bash command: cat ${F.tmpDir}/build.log | grep -c ERROR`, expected: "allow" },

    // ALLOW — long diagnostic with visible output, no filter
    { input: "bash command: mise run acme-check", expected: "allow" },
  ]);
}

/**
 * Backgrounding cases: verification work started behind the call, so its result
 * reaches the reader only through a log (block), against the shapes that must
 * stay quiet: a command that waits for what it started, a service, and an `&`
 * that is text rather than an operator. Expected values are the advice's action
 * at its threshold, `allow` when it does not fire.
 */
export function buildBackgroundTests(F: Fixture): TestCase<AdviceOutcome>[] {
  const cases: TestCase<AdviceOutcome>[] = [
    // BLOCK: a suite, build or check started and left running
    {
      input: `bash command: (timeout 900 docker exec -w /workspaces/acme acme-dev-1 node node_modules/vitest/vitest.mjs run --project=app > ${F.tmpDir}/full.log 2>&1; echo "EXIT=$?" >> ${F.tmpDir}/full.log) & sleep 1; echo "suite started"`,
      expected: "block",
    },
    { input: `bash command: pnpm test > ${F.tmpDir}/test.log 2>&1 & echo started`, expected: "block" },
    { input: `bash command: nohup nix build .#acme > ${F.tmpDir}/build.log 2>&1 & echo started`, expected: "block" },
    { input: `bash command: setsid cargo test > ${F.tmpDir}/test.log 2>&1`, expected: "block" },
    { input: `bash command: mise run acme-check > ${F.tmpDir}/check.log 2>&1 &`, expected: "block" },
    {
      input: `bash command: pnpm build > ${F.tmpDir}/build.log 2>&1 & pnpm typecheck > ${F.tmpDir}/tc.log 2>&1 &`,
      expected: "block",
    },

    // BLOCK: the same shape handed to another shell, where a scanner sees only a string
    {
      input: `bash command: docker exec -w /workspaces/acme acme-dev-1 bash -c 'pnpm typecheck > ${F.tmpDir}/tc.log 2>&1 &'`,
      expected: "block",
    },
    { input: `bash command: ssh acme-host 'bun test > ${F.tmpDir}/test.log 2>&1 &'`, expected: "block" },

    // ALLOW: the command waits for what it started
    { input: `bash command: pnpm test > ${F.tmpDir}/test.log 2>&1; tail -20 ${F.tmpDir}/test.log`, expected: "allow" },
    { input: "bash command: mise run acme-check", expected: "allow" },
    { input: "bash command: npx playwright test", expected: "allow" },
    {
      input: `bash command: for i in $(seq 1 5); do (curl -s http://127.0.0.1:8080/ping > ${F.tmpDir}/p$i.out 2>&1) & done; wait; ls ${F.tmpDir}/p*.out`,
      expected: "allow",
    },
    {
      input: `bash command: (pnpm test > ${F.tmpDir}/test.log 2>&1) & pid=$!; for i in $(seq 1 60); do kill -0 $pid 2>/dev/null || break; sleep 1; done; tail -5 ${F.tmpDir}/test.log`,
      expected: "allow",
    },

    // ALLOW: a service the caller drives in later calls
    { input: "bash command: docker compose up -d && sleep 5 && curl -s localhost:3000", expected: "allow" },
    { input: "bash command: docker run -d --name acme-db postgres:16", expected: "allow" },
    {
      input: `bash command: pnpm dev > ${F.tmpDir}/dev.log 2>&1 & sleep 5; curl -s localhost:5173 | head -3`,
      expected: "allow",
    },

    // ALLOW: the & is text, not an operator
    {
      input: `bash command: git commit -m "tests & docs" -m "$(cat <<'EOF'\nJournal & notes: rename the check task\nEOF\n)"`,
      expected: "allow",
    },
    { input: "bash command: rg -n 'a & b' src/", expected: "allow" },
    { input: `bash command: echo "a & b" >> ${F.tmpDir}/notes.txt`, expected: "allow" },
  ];
  return group(BACKGROUND_GROUP, cases);
}

/**
 * Patch-reminder cases: shell rewrites of a real file the edit tools can reach
 * (note) against the shapes that must stay quiet — a container or remote file,
 * a new file, scratch and generated output. Expected values are the reminder
 * decision at its threshold — the advice's action when it fires, `allow` when
 * it does not.
 */
export function buildPatchReminderTests(F: Fixture): TestCase<AdviceOutcome>[] {
  const cases: TestCase<AdviceOutcome>[] = [
    // NOTE — the rewrite the edit tools could have done
    { input: "bash command: sed -i '' 's/old/new/' src/config.ts", expected: "note" },
    { input: "bash command: perl -pi -e 's/foo/bar/g' lib/acme.ts", expected: "note" },
    {
      input:
        "bash command: python3 - <<'EOF'\nfrom pathlib import Path\np = Path('src/acme/config.py')\np.write_text(p.read_text().replace('old', 'new'))\nEOF",
      expected: "note",
    },
    { input: "bash command: node -e \"require('fs').writeFileSync('src/acme/index.ts', src)\"", expected: "note" },
    { input: "bash command: cat snippet.ts | tee src/acme/index.ts", expected: "note" },

    // ALLOW — a redirect that reads as a create, and a bulk transform the edit
    // tools cannot reproduce
    { input: "bash command: echo 'export const X = 1' > src/acme/constants.ts", expected: "allow" },
    { input: "bash command: biome format --write src/acme/app.ts", expected: "allow" },

    // ALLOW — the edit tools cannot reach the file
    { input: `bash command: ssh acme-host "sed -i 's/old/new/' /srv/acme/config.yml"`, expected: "allow" },
    {
      input: `bash command: docker exec -w /workspaces/acme acme-dev-1 sh -c "python3 - <<'EOF'\nfrom pathlib import Path\nPath('src/app.py').write_text('x')\nEOF"`,
      expected: "allow",
    },
    {
      input: `bash command: kubectl exec -n acme deploy/acme -- sh -c "sed -i 's/a/b/' /app/config.yml"`,
      expected: "allow",
    },

    // ALLOW — a create, scratch or generated output
    { input: "bash command: cat > scripts/acme-check.sh <<'EOF'\n#!/bin/sh\necho ok\nEOF", expected: "allow" },
    { input: `bash command: echo 'debug' >> ${F.tmpDir}/notes.txt`, expected: "allow" },
    { input: `bash command: python3 - <<'EOF'\nopen('${F.tmpDir}/out.json','w').write('{}')\nEOF`, expected: "allow" },
    { input: "bash command: pnpm build > dist/app.js 2>&1", expected: "allow" },

    // ALLOW — reads and ordinary commands
    { input: "bash command: cat src/acme/index.ts", expected: "allow" },
    { input: "bash command: rg -n 'sed -i' src/", expected: "allow" },
    { input: "bash command: git diff --stat", expected: "allow" },
  ];
  return group(PATCH_GROUP, cases);
}

/**
 * Case builders keyed by advice name, so `BENCH_QUESTION=<name>` selects both
 * the question and its cases: a new advice adds one row here and nothing in the
 * runner changes.
 */
export const ADVISORY_CASES: Record<string, (fixture: Fixture) => TestCase<AdviceOutcome>[]> = {
  advice: buildAdvisoryTests,
  background: buildBackgroundTests,
  patch: buildPatchReminderTests,
};
