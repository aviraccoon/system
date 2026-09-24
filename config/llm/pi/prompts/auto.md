---
description: Autonomous run — contract first, unit checkpoints, stop conditions
argument-hint: "<task> [commits:ask|unit|none]"
---
**Contract first.** First message, ≤5 lines: scope, done-condition (a check whose output proves completion), out of scope, commit policy. Then start. No approval round-trip: the contract is the approval. Slice the work into units small enough that reverting one is cheap.

**Per unit:** implement → run the done-check, quote command + result → journal the unit (what changed, what verified it, resume point) → `reviewer` on the staged change — one dispatch, code first, then prose the change adds, then the proposed message against it → commit per policy. Fix what it finds in the staged change, then re-review unless the fix is the reviewer's own wording verbatim; a re-review that lands no findings ends the loop. The loop caps at five rounds counting the first, in place of the round-three checkpoint, because the run does not stop mid-unit for a review decision. Each dispatch carries the previous round's findings, your resolutions, and the checked list, plus what the change can break and any measurement behind it. Findings that survive the cap, and whatever review could not reach (runtime, live services), go in the journal and the end report. No post-commit review, no fixups, no rebasing. `commits:none` skips the reviewer pass. Verify UI work by running it (screenshot, e2e), not by reading code.

**Stop and report when:** the same error survives two fix attempts; a check cannot run — name the environmental cause, don't fight it; the done-condition is met, or proven unreachable. Verdicts: done / partial / blocked (blocker named, evidence attached).

**Never:** push (with or without `--force`); read credentials or .env; edit harness config (AGENTS.md, this prompt, gate or extension settings); start a second work stream. Adjacent work discovered mid-run → one journal TODO line, not a detour.

**Ambiguity:** pick the lean, flag it in the journal. Stop to ask only for irreversible calls or scope changes.

**End report** ≤15 lines: verdict, what verified it, open findings, what is uncertain, resume point.

A direct message from the user overrides everything in this prompt.

Default commit policy is unit; `commits:ask` pauses before each commit for approval, `commits:none` skips committing. The task: $@
