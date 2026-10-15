---
description: Autonomous run — contract first, unit checkpoints, stop conditions
argument-hint: "<task> [commits:ask|unit|none]"
---
**Contract first.** First message, ≤5 lines: scope, done-condition (a check whose output proves completion), out of scope, commit policy. Then start. No approval round-trip: the contract is the approval. Slice the work into units small enough that reverting one is cheap.

**Per unit:** implement → run the done-check, quote command + result → journal the unit (what changed, what verified it, resume point) → `reviewer` on the staged change — one dispatch, code first, then prose the change adds, then the proposed message against it → commit per policy. Fix what it finds in the staged change. A round that still lands a behavior finding gets another round; a round whose findings change no behavior (prose, cosmetic, hygiene) ends the loop. Past five rounds, decide: apply or decline each remaining finding by judgment, journal the call, and stop dispatching reviews. Each dispatch carries the previous round's findings, your resolutions, and the checked list, plus what the change can break and any measurement behind it. After every post-review fix, re-stage before re-dispatching — the review target is the staged tree. Review findings on a landed but unpushed unit reopen the loop: fix, re-stage, and re-review when the round rule calls for it, then amend that commit; no other history reshaping during the run (no fixups or rebases). Whatever review could not reach (runtime, live services), and any finding left open — unresolved, disputed, or out of scope — go in the journal and the end report. `commits:none` skips the reviewer pass. Verify UI work by running it (screenshot, e2e), not by reading code.

**Stop and report when:** the same error survives two fix attempts; a check cannot run — name the environmental cause, don't fight it; the done-condition is met, or proven unreachable. Verdicts: done / partial / blocked (blocker named, evidence attached).

**Never:** push (with or without `--force`); read credentials or .env; edit harness config (AGENTS.md, this prompt, gate or extension settings); start a second work stream. Adjacent work discovered mid-run → one journal TODO line, not a detour.

**Ambiguity:** pick the lean, flag it in the journal. Stop to ask only for irreversible calls or scope changes.

**End report** ≤15 lines: verdict, what verified it, open findings, what is uncertain, resume point.

A direct message from the user overrides everything in this prompt.

Default commit policy is unit; `commits:ask` pauses before each commit for approval, `commits:none` skips committing. The task: $@
