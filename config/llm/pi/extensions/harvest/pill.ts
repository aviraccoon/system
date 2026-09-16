// Pure pill formatting for the harvest extension. No I/O.

export interface StatusJson {
  running: null | {
    id: number;
    project: { id: number; name: string };
    task: { id: number; name: string };
    is_running: boolean;
    timer_started_at: string | null;
    started_time: string | null;
    /** Precomputed H:MM elapsed from `harvest status --json`. */
    elapsed?: string;
  };
  today: unknown[];
  total: number;
}

/** "Acme / Website" -> "Website" (short pill label). */
export function shortProject(name: string): string {
  const tail = name.split("/").pop()?.trim() ?? "";
  return tail === "" ? name : tail;
}

/** Pill text + warn flag from `harvest status --json` output. */
export function formatPill(status: StatusJson): { text: string; warn: boolean } {
  const running = status.running;
  if (!running) return { text: "⏱ idle", warn: true };
  return { text: `⏱ ${running.elapsed ?? "?"} ${shortProject(running.project.name)}`, warn: false };
}
