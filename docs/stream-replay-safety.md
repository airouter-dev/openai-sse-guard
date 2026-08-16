# Stream replay safety in OpenAI-compatible APIs

Updated: 2026-08-09

## What this guide answers

An OpenAI-compatible stream is not automatically safe to replay just because the
TCP connection closed or the HTTP status was 200. This guide shows how a Deno or
edge-runtime client can preserve the small amount of evidence needed to decide
whether a second request could duplicate output, tool activity, or billable
work.

The examples use the [AI-ROUTER API gateway](https://ai-router.dev/) as one
compatible-endpoint context, but the observer works with any provider using SSE.
It is not an OpenAI product and does not establish compatibility with a
provider's entire event schema.

## The boundary

An OpenAI-compatible endpoint can return HTTP 200 and still fail at the stream
boundary. A client may receive a delta, lose the connection, and have no
reliable way to know whether the upstream completed the generation. The safe
default is to preserve evidence and let the application refuse an automatic
replay when output may already be visible.

An HTTP method is not sufficient evidence either. A POST can be replay-safe when
it carries an application idempotency key and the caller has not observed
output. The same POST can be unsafe after a response delta reaches a browser or
after a tool-call fragment reaches an agent loop. The operation contract is
owned by the application; the stream observer supplies only stream evidence.

## Evidence states

| Evidence                                     | Conservative action                                                 |
| -------------------------------------------- | ------------------------------------------------------------------- |
| Explicit [DONE] or Responses completed event | Treat the stream as complete                                        |
| Provider error event before output           | Surface the error; replay only if the operation contract permits it |
| Unexpected EOF after a delta                 | Do not automatically replay                                         |
| Unexpected EOF with no data-bearing event    | Ask the application for operation-specific evidence                 |
| Unknown data-bearing event                   | Treat as possible output                                            |

This observer intentionally does not decide billing, idempotency, or user
interface behavior. Those facts belong to the caller.

## Inspect bytes without buffering output

Web Streams expose Uint8Array chunks, not complete text events. A Unicode
character can be split across packets and a single SSE event can span many
chunks. Decode incrementally, preserve an incomplete frame only up to a fixed
limit, and discard the frame immediately after parsing:

```ts
import { SseReplayObserver } from "jsr:@ai-router/openai-sse-guard";

const observer = new SseReplayObserver({ maxFrameBytes: 64 * 1024 });
const reader = response.body!.getReader();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  observer.push(value);
  render(value); // the UI owns visible output
}

const streamState = observer.finish();
```

The observer does not store the decoded generated text. Its snapshot is limited
to protocol, termination, output evidence, event counts, a bounded event type,
and a bounded error code. This makes it practical to attach the snapshot to an
application log without accidentally turning logs into prompt or completion
storage.

## Why frame parsing needs limits

The
[WHATWG Server-Sent Events specification](https://html.spec.whatwg.org/multipage/server-sent-events.html)
defines a text framing protocol, but a production client still needs resource
limits. A peer can send an unterminated event or an invalid UTF-8 sequence. This
package treats a frame that exceeds the configured byte limit as a terminal
error and marks possible output conservatively. It never grows a buffer
unboundedly waiting for a delimiter.

The same conservative approach applies to malformed JSON. An event with nonempty
data that cannot be parsed might be a provider extension, an error message, or a
visible fragment. Reporting it as a malformed event while allowing automatic
replay would create the unsafe failure mode; the observer therefore records
possible output.

## Chat Completions and Responses are not interchangeable

Chat Completions commonly carry a choices array with delta content. Responses
streams commonly name events such as response.output_text.delta and
response.completed. A role-only Chat Completions delta is not treated as visible
text, while a content delta, tool-call array, Responses text delta, or unknown
data-bearing event is treated as possible output.

This distinction makes the snapshot useful for the common retry decision:

```ts
if (streamState.termination === "done") {
  commitSuccess();
} else if (streamState.hasOutput) {
  surfaceInterruptedResultWithoutAutomaticReplay();
} else if (operationHasReplayContract && requestWasNotCommittedElsewhere) {
  scheduleApplicationOwnedRetry();
} else {
  askForManualRecovery();
}
```

The package does not call the scheduler, re-open a connection, or repeat a
request. A retry library cannot infer whether a tool call has side effects,
whether an idempotency key was accepted, or whether a browser already rendered
the bytes.

## Error and rate-limit handling live beside, not inside, the stream observer

For a non-streaming response, an application can classify errors and interpret
server retry guidance with the
[OpenAI error-code guide](https://developers.openai.com/api/docs/guides/error-codes)
and the
[MDN Retry-After reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Retry-After).
Those signals do not erase stream evidence: a rate-limit response before any
stream data may be retryable, while a connection loss after output is a separate
replay boundary.

Maintained packages in the project cover other language-specific boundaries:

- [TypeScript error normalization on npm](https://www.npmjs.com/package/@ai-router/openai-compatible-errors)
- [Python error boundary on PyPI](https://pypi.org/project/openai-compatible-errors/)
- [Ruby error boundary on RubyGems](https://rubygems.org/gems/openai-compatible-errors)
- [PHP error boundary on Packagist](https://packagist.org/packages/airouter/openai-compatible-errors)
- [Rust stream guard on crates.io](https://crates.io/crates/llm-stream-guard)

## References

- [WHATWG Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [OpenAI error-code guide](https://developers.openai.com/api/docs/guides/error-codes)
- [AI-ROUTER API gateway](https://ai-router.dev/)
- [Package API documentation on JSR](https://jsr.io/@ai-router/openai-sse-guard)
- [Cross-language PHP boundary](https://packagist.org/packages/airouter/openai-compatible-errors)
