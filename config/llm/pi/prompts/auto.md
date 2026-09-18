---
description: Autonomous run — contract first, unit checkpoints, stop conditions
argument-hint: "<task> [commits:ask|unit|none]"
---
**Contract first.** First message, ≤5 lines: scope, done-condition (a check whose output proves completion), out of scope, commit policy. Then start. No approval round-trip: the contract is the approval. Slice the work into units small enough that reverting one is cheap.

**Per unit:** implement → run the done-check, quote command + result → journal 1–3 lines (what changed, what verified it, resume point) → commit per policy. Commit messages get a `reviewer` pass: draft the message, dispatch "Judge this proposed message against the staged diff" before committing — or batch adjacent small commits and review `git log <base>..HEAD` once after. Amend per findings, one round, then move on. `commits:none` skips the review. Verify UI work by running it (screenshot, e2e), not by reading code.

**Stop and report when:** the same error survives two fix attempts; a check cannot run — name the environmental cause, don't fight it; the done-condition is met, or proven unreachable. Verdicts: done / partial / blocked (blocker named, evidence attached).

**Never:** push (with or without `--force`); read credentials or .env; edit harness config (AGENTS.md, this prompt, gate or extension settings); start a second work stream. Adjacent work discovered mid-run → one journal TODO line, not a detour.

**Ambiguity:** pick the lean, flag it in the journal. Stop to ask only for irreversible calls or scope changes.

**End report** ≤15 lines: verdict, what verified it, what is uncertain, resume point.

A direct message from the user overrides everything in this prompt.

Default commit policy is unit; `commits:ask` pauses before each commit for approval, `commits:none` skips committing. The task: $@
