# Description Writing Guide

The description is the only thing an agent sees when deciding whether to load a skill. It's surfaced in the system prompt alongside all other installed skills. The agent reads these descriptions and picks the relevant skill based on the user's request.

## Goals

Give the agent just enough info to know:
1. What capability this skill provides
2. When/why to trigger it (specific keywords, contexts)

## Format

- Max 1024 characters
- Third person only
- First sentence: what it does
- Second sentence: "Use when [specific triggers]"

## Good Examples

```
Analyzes Excel spreadsheets, creates pivot tables, generates charts. Use when analyzing Excel files, spreadsheets, tabular data, or .xlsx files.
```
→ Covers capability + file-type triggers + domain keywords.

```
Generate descriptive commit messages by analyzing git diffs. Use when the user asks for help writing commit messages or reviewing staged changes.
```
→ Covers capability + natural-language triggers ("help writing", "reviewing").

```
Extract text and tables from PDF files, fill forms, and merge multiple PDFs. Use when working with PDF documents, filling forms, or merging PDFs.
```
→ Covers all sub-capabilities + multiple trigger contexts.

## Bad Examples

```
Helps with documents.
```
→ Vague, no specific triggers, doesn't distinguish from other skills.

```
Processes data.
```
→ Too generic to be useful for skill selection.

```
You can use this to process Excel files.
```
→ Second person (should be third person). Also vague on what "process" means.

## Trigger Patterns

Include natural language patterns users might say:
- File types: `.xlsx`, `PDFs`, `CSV`
- Actions: "analyze", "create pivot tables", "fill forms"
- Context: "working with spreadsheets", "reviewing staged changes"
- Domain keywords: "Excel", "tabular data", "commit messages"

## Common Mistakes

**Too few triggers**: Only mentioning one aspect of the skill's capability. If a skill does three things, mention all three in the description so the agent can trigger on any of them.

**Second person**: "You can use this to..." → always third person: "Extracts text from PDF files."

**Vague verbs**: "Helps with", "deals with", "handles" → be specific: "extracts", "generates", "analyzes", "validates".

**No triggers**: A description that says what the skill does but never says when to use it. The agent needs both pieces.

**Unquoted colon**: `description: Exports: CSV and JSON` is invalid YAML — the loader skips the skill and warns at startup. A ` #` in an unquoted value truncates the text with no warning at all. Quote the value when it contains either.
