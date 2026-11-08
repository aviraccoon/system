# AGENTS.md Review Checklist

Use this when updating an existing AGENTS.md file.

## Structure Check

- [ ] Has clear one-line project description at top?
- [ ] Commands section has 3-5 most common commands (not exhaustive)?
- [ ] Key paths section maps tasks to file locations?
- [ ] @-mentions are files that genuinely benefit from always-on context?
- [ ] No sections that duplicate README or other existing docs?

## Language Check

- [ ] No prohibitive language ("don't", "avoid", "never")?
  - Reframe as prescriptive: what TO do instead
- [ ] No generic advice that applies to all projects?
  - Remove: "write tests", "use meaningful names", "handle errors"
- [ ] No marketing language ("comprehensive", "robust", "cutting-edge")?
- [ ] Concise - no unnecessary explanation?

## @-mention Audit

For each @-mentioned file:
- [ ] File still exists at that path?
- [ ] Content still relevant?
- [ ] Worth the always-on context cost?
  - Good: coding conventions, testing patterns, short architecture
  - Bad: long reference docs, things only needed sometimes

## Freshness Check

- [ ] Commands still accurate? (verify against build config)
- [ ] Key paths still correct? (project structure may have changed)
- [ ] Project context still accurate?
- [ ] Any new gotchas discovered that should be added?
- [ ] Any old gotchas that are no longer relevant?

## Nested AGENTS.md Check (if in subdirectory)

- [ ] Parent AGENTS.md exists and is current?
- [ ] This file only contains subdirectory-specific content?
- [ ] No duplication of parent instructions?
- [ ] Subdirectory has its own README if complex enough?

## Local Files Check

- [ ] Private context sits in a file the agent loads on its own: a `meta.json` `instructions` entry, or `AGENTS.local.md`?
- [ ] An `AGENTS.local.md` is covered by a git ignore rule?

## Consolidation Check

- [ ] Any AI instructions elsewhere that should be consolidated?
  - `.cursorrules`, `.cursor/rules/`
  - `.github/copilot-instructions.md`
  - Instructions embedded in README
- [ ] If keeping separate (multi-tool team), are they consistent?

## After Update

- [ ] Changes reviewed with user?
- [ ] Any documentation gaps to note for later?
