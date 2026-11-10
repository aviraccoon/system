/**
 * A wake: the message that tells a session a background run finished, sent once and re-sent once if an
 * abort ate it.
 *
 * `sendMessage` has no receipt. The one proof a custom message arrived is the session showing it
 * starting, so the ledger holds a wake until `message_start` names it. Every producer needs the same
 * three pieces (the ledger key, the receipt match, the retry-after-an-abort), and the two that exist
 * (shell jobs, subagent runs) will not drift apart if they share them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WakeLedger } from "./wake-ledger";

export interface Wake {
  /** Stable per unit of work; the ledger's key and the receipt's match. */
  key: string;
  customType: string;
  content: string;
  details?: Record<string, unknown>;
}

type Sender = Pick<ExtensionAPI, "sendMessage" | "on">;

export class WakeDelivery {
  private readonly owed = new WakeLedger<Wake>((wake) => wake.key);

  constructor(private readonly pi: Sender) {
    // A queued message is shown as it starts, which is the only delivery receipt a custom message has.
    pi.on("message_start", (event) => {
      const message = event.message;
      if (message.role !== "custom") return;
      const key = (message.details as { wakeKey?: string } | undefined)?.wakeKey;
      if (key !== undefined) this.owed.delivered(key);
    });
    // An abort clears the queue the wake waits in, so the first settle after one re-sends what is
    // still owed. A normal settle needs no retry: pi starts a run for a steer still queued.
    pi.on("agent_settled", (event) => {
      if (!event.aborted) return;
      for (const wake of this.owed.takeForRetry()) this.send(wake);
    });
  }

  /** A caller showed the wake's result itself, so nothing is owed for it any more. */
  ack(key: string): void {
    this.owed.delivered(key);
  }

  send(wake: Wake): void {
    this.owed.owe(wake);
    try {
      this.pi.sendMessage(
        {
          customType: wake.customType,
          content: wake.content,
          display: true,
          details: { ...wake.details, wakeKey: wake.key },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    } catch {
      /* the session is closing; the record the producer wrote is the durable half */
    }
  }
}
