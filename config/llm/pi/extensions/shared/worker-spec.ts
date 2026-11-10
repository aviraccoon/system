/**
 * An inline worker spec's payload: the instructions and the shell, with the shell
 * default applied. The call view and the gate's dialog read it here, so the default
 * and the field names live in one place; `workerAgent` reads the raw fields because
 * it must refuse a bad shell rather than default it.
 */

export type WorkerShell = "sandboxed" | "normal";

export const DEFAULT_WORKER_SHELL: WorkerShell = "sandboxed";

export function isWorkerShell(value: unknown): value is WorkerShell {
  return value === "sandboxed" || value === "normal";
}

export interface WorkerSpecFields {
  instructions: string;
  bash: WorkerShell;
}

export function workerSpecFields(spec: unknown): WorkerSpecFields {
  const record = typeof spec === "object" && spec !== null ? (spec as Record<string, unknown>) : {};
  return {
    instructions: typeof record.instructions === "string" ? record.instructions : "",
    bash: isWorkerShell(record.bash) ? record.bash : DEFAULT_WORKER_SHELL,
  };
}
