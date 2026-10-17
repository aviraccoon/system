---
name: refactor-split
description: Split a large file into smaller modules. Use when a file exceeds ~500 lines or has mixed concerns that should be separated into domain-specific files.
---

# Refactor: Split Large File into Modules

Split a file that has grown too large or mixes concerns into focused, cohesive modules.

## Before Starting

1. Read the full file. Identify logical sections by scanning for:
   - Section comments or doc headers
   - Groups of related types/interfaces
   - Functions that share a domain (e.g., all rendering, all I/O, all protocol handling)
2. Check how other modules in the same project are already split — follow existing patterns
3. Propose the split plan to the user before making changes. Include:
   - File names and approximate line counts
   - Which functions/types go where
   - Whether the target is a **new file** or an **existing file**
   - Dependencies between new files (imports)
   - Whether any new file is pure/testable
4. If moving code into an **existing file**, read it first to understand its imports, conventions, and where the new code fits.

## Workflow

### 1. Extract or move sections

For **new files**: extract in any order. Use LSP for symbol-level moves when available, otherwise use text tools.

- **`sed -n 'START,ENDp' file > newfile`** — extract a section into a new file (use `>` not `>>` for the first section)
- **targeted replacement** (pi: `patch`) — fix imports, add exports, adjust signatures

For **existing files**: same mechanics, but:
- **Read the target file first** to avoid duplicating imports and to respect its conventions
- **Merge imports** rather than appending a second `use`/`import` block
- **Place code where it logically belongs**, not just at the end. Use `sed -n 'START,ENDp' source > /tmp/section` then `sed -i 'TARGET_LINEr /tmp/section' target` to insert at the right position (e.g., grouped with related functions, after types they depend on). On macOS, use `gsed` since BSD `sed` handles `-i` differently.

**Do NOT use `write`** for moving code between files. It loses context and makes review harder.

**Line numbers are stable during extraction** — you're only creating/modifying target files and fixing imports in the source, not deleting from it yet. Re-check line numbers with `rg -n` only if you've already started deleting (step 3).

### 2. Fix exports and imports

Use targeted replacement to add `export` to public functions/types in the new files, and add corresponding `import` statements in the source file.

### 3. Delete extracted sections from source (end first)

After **all** extractions and imports are done, delete the old code from the source file.
**Delete from highest line numbers to lowest** so earlier references stay stable across deletions.

For large multi-line blocks, reproducing the whole block as the old text is error-prone; `gsed -i 'START,ENDd'` is acceptable — but always verify line numbers with `rg -n` first since they may have shifted from imports added in step 2.

### 4. Iterate on diagnostics

After each extraction, run `lsp diagnostics` on the changed files. Fix type errors before proceeding to the next extraction. Common fixes:
- Missing imports (forgot to import a type from the new module)
- Unused imports (the old import is no longer needed after extraction)
- Type mismatches (a function now receives a different parameter type)

### 5. Format and test

- Run the project's formatter and linter
- Run the project's tests
- Fix any remaining warnings

## Rules

- **Never use `write` to create files containing extracted code.** `write` is for genuinely new content. For moving code, use LSP or sed to extract and targeted replacement to fix up.
- **Never use `any`.** If a type doesn't match, fix the types properly — narrower parameter types, proper casts with intermediate types, or adjusting the function signature.
- **Work from the end when deleting.** Delete extracted sections from highest line numbers to lowest so earlier references stay valid.
- **One section at a time.** Extract one logical section, fix all errors, then proceed to the next. Don't batch extractions and hope they work out.
- **Don't over-split.** If a function is long but forms one cohesive unit (e.g., a state machine, a single algorithm), leave it together. Splitting it would scatter related logic and make it harder to follow.

## Identifying Good Split Boundaries

Good candidates for extraction:
- **Pure utility functions** with no framework imports — these are also easy to test
- **Groups of related types** that define a domain (e.g., all config types together)
- **Rendering/formatting functions** that only depend on a theme or output type
- **Protocol/transport code** (IPC, RPC, HTTP) that's self-contained

Poor candidates for extraction:
- A single large function that's one coherent algorithm
- Code that has circular dependencies with the rest of the file (both sides call each other)
- Tiny helpers (3-5 lines) used once — not worth a separate file

## Adding Tests

After splitting, the newly pure modules should get tests. Test the most isolated module first (the one with the fewest dependencies). Use the project's existing test patterns — check nearby test files for conventions.
