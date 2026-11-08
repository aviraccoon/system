---
name: avi-init-agents
description: Read this file in full before creating or editing an AGENTS.md, a personal instructions file (AGENTS.local.md or the project's instructions file in the notes tree), or before proposing a rule to add to one, including a single line. Mandatory first step whenever project or personal instructions are the subject. Covers new projects, reviewing an existing setup, and repeated AI mistakes.
---

# Initialize or Update AGENTS.md

Create or update AI agent instructions for the current directory.

## Mode Detection

1. Check if `AGENTS.md` exists in the current directory
2. **Exists**: Run update mode (review against checklist)
3. **Missing**: Run create mode (explore and generate)

## Create Mode

### Step 1: Determine Scope

Is this for a project root or a subdirectory?

**Subdirectory AGENTS.md considerations:**
- AI agents inherit instructions from all AGENTS.md files from the current file up to filesystem root
- Subdirectory AGENTS.md should only contain what's *different* from the parent - don't repeat
- If a subdirectory needs its own AGENTS.md, it probably also needs its own README
- Good candidates: monorepo packages, distinct subsystems, areas with different conventions

Ask the user if unclear whether this should be root-level or subdirectory-scoped.

### Step 2: Explore the Project

Discover what kind of project this is:

**Build system indicators:**
- `package.json`, `bun.lock` → Node/Bun project, look for scripts
- `Cargo.toml` → Rust project
- `go.mod` → Go project
- `flake.nix`, `mise.toml` → Check for task definitions
- `Makefile`, `justfile` → Build commands

**Project type indicators:**
- `.obsidian/` → Knowledge vault - look for organization patterns, existing AI commands
- Game-related structure, design docs → Game project - check for hidden mechanics to protect
- `flake.nix` + `modules/` → Config repo - look for rebuild commands, module structure

**Existing documentation:**
- README and contributing guides
- Architecture docs
- Any `docs/` directory contents
- Inline code comments and conventions

**Existing AI instructions:**
- `.cursorrules`, `.cursor/rules/`
- `.github/copilot-instructions.md`
- Tool-specific files without `AGENTS.md` (needs migration)
- AI instructions embedded in README

### Step 3: Identify Key Elements

Based on exploration, identify:

1. **Commands** (3-5 most common): build, test, lint, check, format
2. **Key paths**: where to add features, where tests go, config locations
3. **@-mention candidates**: files worth always-on context (look for coding conventions, testing guides, architecture overviews - but use whatever names the project actually has)
4. **Project context**: what kind of project, key constraints, philosophy
5. **LLM-specific gotchas**: things the AI might repeatedly get wrong

### Step 4: Check for Existing AI Instructions

If found (`.cursorrules`, copilot instructions, etc.):
- Note what they contain
- Options to suggest:
  - **Consolidate**: Migrate content into AGENTS.md, delete the old file
  - **Symlink**: If the tool requires its specific filename, symlink it to AGENTS.md (e.g., `ln -sf AGENTS.md .cursorrules`)
  - **Keep separate**: If team uses multiple AI tools with different needs
- When migrating, reframe negatives as positives

### Step 5: Generate AGENTS.md

**Structure** (adapt based on project - not all sections needed):

```markdown
# AGENTS.md

[One-line project description]

## Quick Reference

[3-5 most common commands]

## Key Paths

[Where to add things, task → file mapping]

## @-mentions (only if files warrant always-on context)

@path/to/actual/file.md

## Project Context

[What kind of project, key constraints, philosophy - only if non-obvious]

## Guidelines

[Prescriptive rules - what TO do, not what to avoid]
```

**Principles:**
- Keep it minimal - if it can be @-mentioned, don't inline it
- Prescriptive, not prohibitive - say what to do, not what to avoid
- LLM-focused - human docs go in README/docs
- No generic advice ("write tests", "use meaningful names")
- Use the project's actual file names, not hypothetical ones

### Step 6: Personal instructions (if applicable)

If the project has private context (references to private files, personal context, development notes not for the public repo), it belongs in a file the project's sessions load: `AGENTS.local.md` reaches every session, and a `meta.json` entry reaches agent children only when it sets `subagents: true`. Unfinished work is not that: it goes in the journal's `TODO.md`.

- **The project has a journal project** (a directory under the notes tree named for the checkout directory; for a worktree, the main project's name): declare the file in its `meta.json` `instructions` list, using the object form when children need it too: `"instructions": [{"path": "~/notes/llm/<project>/.agents/instructions.md", "subagents": true}]`. The journal directory is matched by name, not by the `path` field, so it has to carry the checkout's name. The file then works in every checkout, including git worktrees, and nothing private is written into the repository.
- **No journal project**: create `AGENTS.local.md` in the checkout, holding private file references, personal context, and development notes not for the public repo.

**Verify gitignore** before creating an `AGENTS.local.md` — run `git check-ignore AGENTS.local.md`. If not ignored, suggest adding to `.gitignore` (local or global). These files are personal and should never be committed.

### Step 7: Suggest Missing Docs

If gaps found during exploration, describe what's missing by purpose:
- Development workflow documentation (if setup is complex)
- Code style/conventions guide (if not obvious from tooling config)
- Testing guide (if testing setup is non-trivial)
- Architecture overview (if structure isn't clear from directory layout)

Let the user choose filenames and locations. Don't create these docs - just note the gaps.

## Nested AGENTS.md

When creating AGENTS.md for a subdirectory:

1. **Check parent AGENTS.md** - what's already covered?
2. **Only include differences** - subdirectory-specific commands, paths, conventions
3. **Consider scope** - if this subdir is complex enough for AGENTS.md, suggest:
   - README for the subdirectory
   - Any other docs that would help humans too
4. **Keep it short** - inherited context + subdirectory context shouldn't be overwhelming

## Update Mode

When AGENTS.md already exists, review it against the checklist.

See @checklist.md for the full review process.

Quick checks:
1. Are there negatives to reframe? ("Don't do X" → "Do Y instead")
2. Are @-mentions still valid and useful?
3. Is there stale content that no longer applies?
4. Are there missing sections based on current project state?
5. Are the personal instruction files current, and covered by an ignore rule or a `meta.json` declaration?

## Reframing Negatives

When you encounter prohibitive language, reframe as prescriptive:

| Instead of | Write |
|------------|-------|
| "Don't add frameworks" | "Use vanilla TypeScript" |
| "Don't over-engineer" | "Keep solutions minimal" |
| "Don't skip type checking" | "Run type checks before committing" |
| "Don't expose hidden state" | "Keep hidden state internal" |
| "Avoid marketing language" | "Use direct, technical language" |

The goal is instructions that tell the AI what TO do, creating a positive model to follow rather than a list of mistakes to avoid.
