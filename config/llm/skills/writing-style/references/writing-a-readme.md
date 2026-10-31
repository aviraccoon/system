# Writing a README

Covers the README itself. The docs around it, and where material moves when it leaves, are in `docs.md`.

## What it is for

The first page every reader lands on. Its job: let someone decide whether this does what they need, then reach a
first working command. It is not a feature manual, not a design record, and not a changelog. A reader who wants
task-by-task help gets it from the tool's own help or from a doc.

## Order

Order by how fast a line lets a reader leave: whatever disqualifies them first, then what makes them stay.

1. **Name and one or two sentences** of what it is, in the project's voice.
2. **What you need**: platform, runtime, permissions, an account. A requirement at the bottom wastes an install
   the reader could have skipped.
3. **Install and first run**: one end-to-end example beats five fragments.
4. **Limits and footguns**: what would otherwise read as a bug, plus the workaround.
5. **Where to go next**: the doc list, and how to reach you if that matters.

A badge, a maintainer list, a contributor wall, or a table of contents earns its place only when it answers
something a reader asks, and most READMEs are too short to need one.

## The lead

Concrete, in the project's voice. What it is, not what category it belongs to.

- Good: "Turns a folder of markdown into a static site. No build step."
- Bad: "A comprehensive, modern solution for content publishing."

A personal project can be playful; specificity carries the personality better than adjectives do. A tool other
people put into production reads in plain prose.

## Examples

- Runnable as printed: exact flags, exact paths, no `<your-value>` left where a real value belongs.
- Real output, trimmed to what matters. A screenshot of text is not output.
- Sample data is synthetic (`acme`, `example.com`), so nothing private leaks and nothing needs anonymizing later.

## No inventories

An overview of what the thing does is fine. What the README must not carry is an inventory of what the product or the
code declares (see One fact, one home in `docs.md`).

One example per common job may show a command and its flags, and a default that would otherwise read as a bug gets its
one line under Limits and footguns.

## Design decisions

The skill keeps one line where a limitation would otherwise read as a bug. This adds a second: a decision that changes
how the reader uses the thing gets one bullet stating the consequence.

- Worth keeping: "No daemon. It runs once and exits, so a cron job is enough."
- Does not: alternatives considered, the history of the design, or anything only a maintainer acts on.

## Length

As short as it can be without being shorter.

Anything a reader needs in order to start stays. What has outgrown the README moves to a doc with one link left behind
(split triggers: When to split, in `docs.md`). If install and first run no longer fit the first screen or two, that is
the signal to move something out.

## What never belongs

1. Anything the status rules ban, such as test counts, benchmark numbers, or verification claims.
2. A roadmap. Unbuilt work goes where plans live, not where users arrive.
3. History and migrations. Say what the current behavior is, and link the note if a reader must know what changed.
4. Contributor instructions. Those are for someone changing the code.

## Before shipping

- Someone can install and run the first example on a clean machine without opening the source.
- Every link resolves and the page it points at exists.

Then run the shared checks under Before shipping in `docs.md`.
