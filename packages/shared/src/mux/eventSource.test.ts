import { assert, describe, it } from "@effect/vitest";

import { type FetchEventSourceMessage, makeFetchEventSource } from "./eventSource.ts";

/** A fetch that answers each call from the next script entry, recording the headers it got. */
const scriptedFetch = (
  script: ReadonlyArray<{
    readonly status?: number;
    readonly contentType?: string;
    readonly chunks: ReadonlyArray<string>;
  }>,
) => {
  const calls: Array<Record<string, string>> = [];
  const fetch = async (_url: string, init?: RequestInit) => {
    calls.push({ ...(init?.headers as Record<string, string>) });
    const step = script[Math.min(calls.length - 1, script.length - 1)]!;
    const encoder = new TextEncoder();
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = step.chunks[index];
        index += 1;
        if (chunk === undefined) controller.close();
        else controller.enqueue(encoder.encode(chunk));
      },
    });
    return new Response(body, {
      status: step.status ?? 200,
      headers: { "content-type": step.contentType ?? "text/event-stream" },
    });
  };
  return { fetch, calls };
};

const collect = (source: InstanceType<ReturnType<typeof makeFetchEventSource>>, count: number) =>
  new Promise<Array<FetchEventSourceMessage>>((resolve) => {
    const seen: Array<FetchEventSourceMessage> = [];
    source.onmessage = (event) => {
      seen.push(event);
      if (seen.length === count) resolve(seen);
    };
  });

describe("fetch EventSource", () => {
  it("parses fields split across chunks and line endings, and named events", async () => {
    const { fetch } = scriptedFetch([
      {
        chunks: [
          "﻿: comment\r\nretry: 5\r\n",
          "data: one\r",
          "\ndata: two\n\nevent: custom\nid: 7\ndata:x\n\n",
          "data: three\r\n\r\n",
        ],
      },
    ]);
    const EventSource = makeFetchEventSource(fetch);
    const source = new EventSource("https://k3host.invalid/events");
    const custom = new Promise<FetchEventSourceMessage>((resolve) =>
      source.addEventListener("custom", (event) => resolve(event as FetchEventSourceMessage)),
    );
    const messages = await collect(source, 2);
    source.close();
    assert.deepEqual(
      messages.map((message) => [message.data, message.lastEventId]),
      [
        ["one\ntwo", ""],
        ["three", "7"],
      ],
    );
    const named = await custom;
    assert.equal(named.data, "x");
    assert.equal(named.lastEventId, "7");
    assert.equal(source.readyState, EventSource.CLOSED);
  });

  it("reconnects after the stream ends, sending Last-Event-ID, at the server's retry", async () => {
    const { fetch, calls } = scriptedFetch([
      { chunks: ["retry: 1\nid: 1\ndata: a\n\nid: 2\ndata: b\n\n"] },
      { chunks: ["id: 3\ndata: c\n\n"] },
    ]);
    const EventSource = makeFetchEventSource(fetch);
    const source = new EventSource("https://k3host.invalid/events");
    let errors = 0;
    source.onerror = () => {
      errors += 1;
    };
    const messages = await collect(source, 3);
    source.close();
    assert.deepEqual(
      messages.map((message) => message.data),
      ["a", "b", "c"],
    );
    assert.equal(calls[0]!["last-event-id"], undefined);
    assert.equal(calls[1]!["last-event-id"], "2");
    assert.isAtLeast(errors, 1);
  });

  it("gives up for good on a refusal, as the browser does", async () => {
    const { fetch, calls } = scriptedFetch([
      { status: 403, contentType: "application/json", chunks: ['{"code":"relay-unsupported"}'] },
    ]);
    const EventSource = makeFetchEventSource(fetch);
    const reconnects: Array<number> = [];
    const source = new EventSource("https://k3host.invalid/events", {
      schedule: (_run, ms) => {
        reconnects.push(ms);
        return () => undefined;
      },
    });
    await new Promise<void>((resolve) => {
      source.onerror = () => resolve();
    });
    assert.equal(source.readyState, EventSource.CLOSED);
    assert.deepEqual(reconnects, []);
    assert.equal(calls.length, 1);
  });
});
