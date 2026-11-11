# Writing repo docs

Covers the docs that live around a README: which file a piece of content belongs in, when one doc becomes two, and
how a doc should read. README anatomy is in `writing-a-readme.md`. The status and change-relative rules are in the
skill itself.

## One reader need per doc

Four kinds:

| Kind | Reader | Shape |
|------|--------|-------|
| Tutorial | New to it, learning | A guided first run, one path, no choices |
| How-to | Working, past the basics | Steps to a goal, prerequisites stated, no teaching |
| Reference | Working, looking something up | Facts and limits, grouped for lookup |
| Explanation | Learning why | Design, constraints, trade-offs |

A page that mixes them serves none: a how-to that stops to justify itself, or a reference with a tutorial at the
top. Two exceptions: a README, including a docs index, and any root file that serves one reader, such as
CONTRIBUTING.md. They may hold a few kinds, judged section by section; When to split decides when one of their sections
has outgrown the file. Any other mixed page gets split, or the stray section moves out, as When to split decides; until
then each section is judged on its own kind.

## Which file

- **README**: the user's entry point (see `writing-a-readme.md`).
- **CONTRIBUTING.md**: for someone changing the code. Development setup, checks, conventions, tests, release steps.
  One file until it outgrows itself, then split by task and link the parts from the root file. Install and first
  run stay in the README: a user needs them too.
- **AGENTS.md**: rules for agents, such as key paths, commands, and gotchas. The `avi-init-agents` skill owns its
  content; point at the docs instead of copying them in.
- **CHANGELOG.md**: dated entries per release. Not a plan for the next one.
- **Everything else**: whatever a user or maintainer will ask later. Mechanism, architecture, data model,
  operations, history. One question per file.
- **Decision records** are optional and usually skipped; where a repo keeps them, one dated record per decision,
  and a reversal is a new record rather than an edit.

## When to split

Split when the reader's question changes. Length is a symptom, not the reason.

1. A section grows subsections of its own.
2. Two readers ask different things of the same doc: a user and a contributor, or someone doing the task and
   someone understanding it.
3. A section has its own prerequisites and its own context to establish.

Do not split when:

- The result is a one- or two-sentence page. Merge it into the task it introduces.
- The result is only its prerequisites and no steps. Merge it into the doc it introduces.
- Nothing would link to it. A page reachable only by search is effectively absent.

## Layout

- One `docs/` directory serves most repos. Add `docs/README.md` as its index when the root README's list of docs
  grows into a section of its own.
- An index is the one page allowed to be only links. Every other page carries content.
- Group into subdirectories once the index needs groups, and give each subdirectory its own index of that area's
  documents; the top index lists the areas and their few key documents. Two levels are usually enough for a normal
  repo.
- Keep the layout the repo already has. Reorganizing to match a template costs links and readers, and buys
  nothing.
- A docs site is for versioned docs, search, or an audience outside the repo. Until one of those exists, a README
  plus `docs/` is the whole site.

## How a doc opens

- A tutorial or how-to opens with the reader's situation: "You have `acme` installed; this adds a second worker." Not
  "This document describes the testing setup", which names the page.
- A reference or explanation opens with what it covers and what it leaves out.
- Then a task page gives prerequisites, steps, and what success looks like.

## Titles

- The reader's words and the task: "Rotating credentials", not "Credential subsystem".
- Do not repeat the parent's words. Under a product's section, "Troubleshooting" beats "Troubleshooting acme".
- Skip "Overview" and "Introduction". They name the shape rather than the content, and a page that is only an
  introduction is a paragraph that belongs above the first real heading.

## One fact, one home

The skill covers the general rule (see *One Fact, One Home*). The doc set adds one: a
command's invocation may appear in two entry points, but its explanation lives in one.

Code-level and product-level facts are the same case: an inventory of what the product or the code declares, such as
features, commands, flags, defaults, config keys, signatures, or directory trees, is a copy the source owns. Generate
it, or link the page that owns it.

## Diagrams

- Write the caption first. The caption states the takeaway, so writing it is also the test of whether the diagram
  earns its place.
- One idea per diagram. If it needs a legend to be read, it is two diagrams.
- A text format (Mermaid, ASCII, the repo's diagram tooling) beats a binary image: it diffs, it can be fixed by
  whoever spots the error, and it survives a move. A screenshot of text is not a diagram.
- Label boxes with the names the code uses, so the reader can search for them.
- Diagrams belong in the doc that explains the thing. In a README a diagram is a welcome picture, not the
  explanation.

## Before shipping

- Every page except a README, a docs index, or a root file for one reader is one kind, and opens the way that kind
  opens (see How a doc opens).
- Every doc is reachable from the README's doc list, or from `docs/README.md` where the repo has one.
- Nothing is stated twice, and no inventory duplicates the product or the code (see One fact, one home).
- Every command runs in the environment the doc names, with the flags it shows.
- A public README names the license in one line with a link.
