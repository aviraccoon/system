A pin (a test that locks down one behavior) is evidence only if it can fail. Where green could be coincidence (presence rather than effect; a proxy true under both implementations, such as a count, an ordering or a snapshot; either/or asserted on one side; an expectation that cannot disagree; the subject replaced by a mock), prove it: undo the behavior, watch it go red, restore. Green under the undo asserts nothing; tighten or delete. Run the proof against the pin's own file so the run actually includes it.

One undo at a time, baseline green between (a stacked or unrestored edit lies). Check the undo reached the asserted behavior: a green round trip can mean the mutation never exercised the path, as a fake modeling only the happy path does. Prefer the real implementation; a fake must model the contract, failure modes included.

Every new branch (`else if`, early return, guard) needs a test that fails when it is deleted, and an assertion added to an existing test needs the same can-fail proof.

A universal claim (`never`, `every`, `each`, `all`, `no …`) in a comment, doc, or commit message needs one test per case it spans.

A hand-edited input file (config, settings, secrets) gets one parser and a table test over its value domain; the parser reports every entry it drops, and one row per way the file can be wrong asserts that report. A file checked per consumer drifts into two rules.

A check is fixed at the cause, never greened by weakening (a relaxed assertion, a skipped test, a widened catch, a disabled rule). An expectation edited to match new output claims that output is correct. A result a rerun, sleep, or run order decides is a defect, not noise: make the test deterministic.

Before reporting done, run the full check in one-shot form, the suite and not just the touched files. A run that never exits is not a gate; a run that selects no tests exits 0 proving nothing.
