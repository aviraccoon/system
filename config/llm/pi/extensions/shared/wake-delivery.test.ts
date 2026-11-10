import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WakeDelivery } from "./wake-delivery";

function fakePi() {
  const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const pi = {
    on: (name: string, handler: (event: Record<string, unknown>) => void) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) => {
      sent.push({ message, options });
    },
  };
  return { pi: pi as unknown as ExtensionAPI, sent, handlers };
}

const wake = { key: "run-1", customType: "thing-done", content: "finished", details: { runId: "run-1" } };

describe("WakeDelivery", () => {
  test("sends one steer with the key in its details", () => {
    const { pi, sent } = fakePi();
    new WakeDelivery(pi).send(wake);
    expect(sent).toHaveLength(1);
    expect(sent[0].message.customType).toBe("thing-done");
    expect(sent[0].message.details).toEqual({ runId: "run-1", wakeKey: "run-1" });
    expect(sent[0].options).toEqual({ triggerTurn: true, deliverAs: "steer" });
  });

  test("a settle without an abort does not re-send", () => {
    const { pi, sent, handlers } = fakePi();
    new WakeDelivery(pi).send(wake);
    handlers.get("agent_settled")?.({ aborted: false });
    expect(sent).toHaveLength(1);
  });

  test("the first settle after an abort re-sends once", () => {
    const { pi, sent, handlers } = fakePi();
    new WakeDelivery(pi).send(wake);
    handlers.get("agent_settled")?.({ aborted: true });
    expect(sent).toHaveLength(2);
    handlers.get("agent_settled")?.({ aborted: true });
    expect(sent).toHaveLength(2);
  });

  test("only our own message clears the wake", () => {
    const { pi, sent, handlers } = fakePi();
    new WakeDelivery(pi).send(wake);
    // A different message that happens to carry the key is not ours.
    handlers.get("message_start")?.({ message: { role: "assistant", details: { wakeKey: "run-1" } } });
    handlers.get("message_start")?.({ message: { role: "custom", details: {} } });
    handlers.get("agent_settled")?.({ aborted: true });
    expect(sent).toHaveLength(2);
  });

  test("an acknowledged wake is not re-sent", () => {
    const { pi, sent, handlers } = fakePi();
    const delivery = new WakeDelivery(pi);
    delivery.send(wake);
    delivery.ack(wake.key);
    handlers.get("agent_settled")?.({ aborted: true });
    expect(sent).toHaveLength(1);
  });

  test("a wake the session shows is never re-sent", () => {
    const { pi, sent, handlers } = fakePi();
    new WakeDelivery(pi).send(wake);
    handlers.get("message_start")?.({ message: { role: "custom", details: { wakeKey: "run-1" } } });
    handlers.get("agent_settled")?.({ aborted: true });
    expect(sent).toHaveLength(1);
  });
});
