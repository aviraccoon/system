// Bun ships the Temporal API; TypeScript below 6.0 has no built-in types for it.
// TypeScript 6.0+ declares the namespace via `lib: esnext.temporal`, which makes
// this file unnecessary. Only the pieces this CLI uses are declared here.
declare namespace Temporal {
  namespace Now {
    function timeZoneId(): string;
  }

  namespace ZonedDateTime {
    function from(
      item: {
        timeZone: string;
        year: number;
        month: number;
        day: number;
        hour?: number;
        minute?: number;
        second?: number;
      },
      options?: { disambiguation?: "compatible" | "earlier" | "later" | "reject" },
    ): { epochMilliseconds: number };
  }
}
