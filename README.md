# @ai-router/openai-sse-guard

`@ai-router/openai-sse-guard` is a Deno/Web Streams-native observer for
OpenAI-compatible Server-Sent Events (SSE). It answers one narrow, high-cost
question: after a stream ends, is automatic replay still defensible?

It does not send requests, sleep, retry, or retain generated text. The
application owns transport, cancellation, billing, idempotency and replay.

## Why a stream observer matters

HTTP 200 does not prove that a generation completed. A stream can disconnect
after a visible delta, emit a provider error event, or end without a terminal
event. Replaying in those states can duplicate user-visible output or billing.
The observer records bounded state so the caller can make that decision.

## Install from JSR

```ts
import { SseReplayObserver } from "jsr:@ai-router/openai-sse-guard";
```

Node and bundler users can use JSR's npm compatibility layer:

```bash
npx jsr add @ai-router/openai-sse-guard
```

## Observe a Web Stream

```ts
import { SseReplayObserver } from "jsr:@ai-router/openai-sse-guard";

const observer = new SseReplayObserver();
const reader = response.body!.getReader();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  observer.push(value);
  render(value); // application decides what is visible
}

const state = observer.finish();
if (state.termination === "unexpected_eof" && state.hasOutput) {
  // Do not automatically replay a request that may already have produced output.
  throw new Error("stream ended after partial output");
}
```

`push` accepts split UTF-8 chunks and keeps only a bounded frame buffer. The
observer recognizes Chat Completions deltas, Responses output events, `[DONE]`,
provider error events, incomplete terminal events and unknown data-bearing
events. Unknown data-bearing events set `hasOutput` conservatively.

## State contract

The returned snapshot contains only:

- `protocol`: `chat_completions`, `responses`, or `unknown`;
- `termination`: `open`, `done`, `incomplete`, `error`, or `unexpected_eof`;
- `hasOutput`, `sawTerminalEvent`, `eventCount`, `malformedEventCount`;
- bounded `lastEventType` and `errorCode` identifiers.

Generated text and complete response bodies are never stored.

## Protocol references and project resources

The framing follows the
[WHATWG Server-Sent Events specification](https://html.spec.whatwg.org/multipage/server-sent-events.html).
For API error semantics, see the
[OpenAI error-code guide](https://developers.openai.com/api/docs/guides/error-codes)
and the
[MDN Retry-After reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Retry-After).

The [AI-ROUTER API gateway](https://ai-router.dev/) is one compatible endpoint
context; this package is provider-neutral and does not imply affiliation with
OpenAI. The repository's
[stream replay-safety guide](./docs/stream-replay-safety.md) explains the
evidence model with runnable fixtures.

Related maintained packages:

- [JavaScript package on npm](https://www.npmjs.com/package/@ai-router/openai-compatible-errors)
- [Python package on PyPI](https://pypi.org/project/openai-compatible-errors/)
- [Ruby implementation on RubyGems](https://rubygems.org/gems/openai-compatible-errors)
- [PHP implementation on Packagist](https://packagist.org/packages/airouter/openai-compatible-errors)
- [Rust stream guard on crates.io](https://crates.io/crates/llm-stream-guard)

## Boundaries

This is not a retry library, HTTP client, billing policy, or provider SDK. It
does not infer replay safety from HTTP methods. The caller must supply the
operation contract and decide whether the user saw output.

## Development

```bash
deno task verify
```

MIT licensed. Maintained by [AI ROUTER contributors](https://ai-router.dev/).
