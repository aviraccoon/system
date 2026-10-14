/**
 * Advisory benchmark cases: output-capture shapes the advisory question should
 * block or allow. Expected values are the block decision at the threshold, not
 * a risk verdict. Shapes follow the recorded session-sweep evidence; all
 * names, paths and domains are synthetic.
 */

import type { Fixture } from "./explain-cases";
import type { TestCase } from "./shared";

export type AdviceOutcome = "block" | "allow";

const ADVISORY_GROUP = "output-capture";

function group(cases: TestCase<AdviceOutcome>[]): TestCase<AdviceOutcome>[] {
  return cases.map((testCase) => ({ ...testCase, group: ADVISORY_GROUP }));
}

export function buildAdvisoryTests(F: Fixture): TestCase<AdviceOutcome>[] {
  return group([
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
