import { describe, expect, test } from "bun:test";
import { WakeLedger } from "./wake-ledger";

interface Wake {
  jobId: string;
  message: string;
}

const wake = (jobId: string): Wake => ({ jobId, message: `[job ${jobId} finished]` });

function ledger(): WakeLedger<Wake> {
  return new WakeLedger<Wake>((value) => value.jobId);
}

describe("WakeLedger", () => {
  test("a delivered wake is never retried", () => {
    const wakes = ledger();
    wakes.owe(wake("j-a"));
    wakes.delivered("j-a");
    expect(wakes.size).toBe(0);
    expect(wakes.takeForRetry()).toHaveLength(0);
  });

  test("an undelivered wake is retried once, with its message intact", () => {
    const wakes = ledger();
    wakes.owe(wake("j-a"));
    expect(wakes.takeForRetry()).toEqual([{ jobId: "j-a", message: "[job j-a finished]" }]);
    expect(wakes.size).toBe(0);
  });

  test("a retry that is lost again is dropped rather than looping", () => {
    const wakes = ledger();
    wakes.owe(wake("j-a"));
    // Sending re-owes the message, so a second abort reaches takeForRetry with it owed again.
    for (const retried of wakes.takeForRetry()) wakes.owe(retried);
    expect(wakes.takeForRetry()).toHaveLength(0);
  });

  test("one job's delivery does not retry another's", () => {
    const wakes = ledger();
    wakes.owe(wake("j-a"));
    wakes.owe(wake("j-b"));
    wakes.delivered("j-a");
    expect(wakes.takeForRetry().map((value) => value.jobId)).toEqual(["j-b"]);
  });

  test("re-owing the same job replaces its message rather than queueing twice", () => {
    const wakes = ledger();
    wakes.owe(wake("j-a"));
    wakes.owe({ jobId: "j-a", message: "second" });
    expect(wakes.size).toBe(1);
    expect(wakes.takeForRetry()).toEqual([{ jobId: "j-a", message: "second" }]);
  });
});
