import {
  observeSse,
  SseReplayObserver,
  type StreamSnapshot,
} from "../src/mod.ts";

const encoder = new TextEncoder();

function frame(data: string, event?: string, lineEnding = "\n"): Uint8Array {
  const prefix = event ? "event: " + event + lineEnding : "";
  return encoder.encode(prefix + "data: " + data + lineEnding + lineEnding);
}

function snapshotWithoutCounters(
  snapshot: StreamSnapshot,
): Omit<StreamSnapshot, "eventCount" | "malformedEventCount"> {
  const { eventCount: _eventCount, malformedEventCount: _malformed, ...rest } =
    snapshot;
  return rest;
}

Deno.test("tracks a split UTF-8 Chat Completions delta and DONE", () => {
  const observer = new SseReplayObserver();
  const bytes = frame(
    JSON.stringify({
      id: "chatcmpl_123",
      object: "chat.completion.chunk",
      choices: [{ delta: { content: "✓" } }],
    }),
  );
  const split = bytes.findIndex((byte, index) => byte > 127 && index > 0);
  observer.push(bytes.slice(0, split + 1));
  observer.push(bytes.slice(split + 1));
  observer.push(frame("[DONE]"));

  const state = observer.finish();
  if (state.protocol !== "chat_completions") throw new Error("wrong protocol");
  if (!state.hasOutput) throw new Error("expected output");
  if (state.termination !== "done") throw new Error("expected done");
  if (!state.sawTerminalEvent) throw new Error("expected terminal event");
  if (state.eventCount !== 2) throw new Error("wrong event count");
});

Deno.test("does not mistake a role-only delta for visible output", () => {
  const observer = new SseReplayObserver();
  observer.push(
    frame(
      JSON.stringify({
        id: "chatcmpl_123",
        object: "chat.completion.chunk",
        choices: [{ delta: { role: "assistant" } }],
      }),
    ),
  );

  const state = observer.finish();
  if (state.protocol !== "chat_completions") throw new Error("wrong protocol");
  if (state.hasOutput) throw new Error("role-only delta is not output");
  if (state.termination !== "unexpected_eof") throw new Error("expected EOF");
});

Deno.test("accepts CRLF Responses events and tracks output before completion", () => {
  const observer = new SseReplayObserver();
  observer.push(
    frame(
      JSON.stringify({ type: "response.output_text.delta", delta: "hello" }),
      "response.output_text.delta",
      "\r\n",
    ),
  );
  observer.push(
    frame(
      JSON.stringify({ type: "response.completed" }),
      "response.completed",
      "\r\n",
    ),
  );

  const state = observer.finish();
  if (state.protocol !== "responses") throw new Error("wrong protocol");
  if (!state.hasOutput) throw new Error("expected output");
  if (state.termination !== "done") throw new Error("expected done");
  if (state.lastEventType !== "response.completed") {
    throw new Error("wrong event type");
  }
});

Deno.test("captures a bounded provider error code without retaining body text", () => {
  const observer = new SseReplayObserver();
  observer.push(
    frame(
      JSON.stringify({
        error: {
          code: "rate_limit_exceeded",
          message: "provider-controlled detail that is not in the snapshot",
        },
      }),
      "error",
    ),
  );

  const state = observer.finish();
  if (state.termination !== "error") throw new Error("expected error");
  if (state.errorCode !== "rate_limit_exceeded") throw new Error("wrong code");
  if (JSON.stringify(state).includes("provider-controlled")) {
    throw new Error("provider text leaked");
  }
});

Deno.test("fails closed for malformed data-bearing frames", () => {
  const observer = new SseReplayObserver();
  observer.push(frame("{bad json", "message"));

  const state = observer.finish();
  if (!state.hasOutput) throw new Error("malformed data must be conservative");
  if (state.termination !== "unexpected_eof") throw new Error("expected EOF");
  if (state.malformedEventCount !== 1) throw new Error("wrong malformed count");
});

Deno.test("bounds an unterminated frame", () => {
  const observer = new SseReplayObserver({ maxFrameBytes: 256 });
  observer.push(encoder.encode("data: " + "x".repeat(300)));

  const state = observer.finish();
  if (state.termination !== "error") throw new Error("expected bounded error");
  if (!state.hasOutput) throw new Error("must fail closed on oversized frame");
  if (state.malformedEventCount !== 1) throw new Error("wrong malformed count");
});

Deno.test("observeSse consumes a standard ReadableStream", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        frame(
          JSON.stringify({
            id: "chatcmpl_123",
            object: "chat.completion.chunk",
            choices: [{ delta: { content: "ok" } }],
          }),
        ),
      );
      controller.enqueue(frame("[DONE]"));
      controller.close();
    },
  });

  const state = await observeSse(stream);
  const expected = {
    protocol: "chat_completions",
    termination: "done",
    hasOutput: true,
    sawTerminalEvent: true,
    lastEventType: null,
    errorCode: null,
  };
  const actual = snapshotWithoutCounters(state);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("wrong state " + JSON.stringify(actual));
  }
});
