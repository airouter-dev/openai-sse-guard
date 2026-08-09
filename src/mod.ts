const DEFAULT_MAX_FRAME_BYTES = 64 * 1024;
const DEFAULT_MAX_EVENTS = 10_000;
const MAX_IDENTIFIER_LENGTH = 96;

export type Protocol = "chat_completions" | "responses" | "unknown";
export type Termination =
  | "open"
  | "done"
  | "incomplete"
  | "error"
  | "unexpected_eof";

export interface ObserverOptions {
  maxFrameBytes?: number;
  maxEvents?: number;
}

export interface StreamSnapshot {
  readonly protocol: Protocol;
  readonly termination: Termination;
  readonly hasOutput: boolean;
  readonly sawTerminalEvent: boolean;
  readonly eventCount: number;
  readonly malformedEventCount: number;
  readonly lastEventType: string | null;
  readonly errorCode: string | null;
}

function boundedIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_IDENTIFIER_LENGTH) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) return null;
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasNonEmptyString(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.some(hasNonEmptyString);
  return false;
}

function firstRecord(
  value: unknown,
  keys: string[],
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const candidate = value[key];
    if (isRecord(candidate)) return candidate;
  }
  return null;
}

function choiceMayContainOutput(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const delta = firstRecord(value, ["delta", "message"]);
  if (!delta) return false;
  return hasNonEmptyString(delta.content) ||
    Array.isArray(delta.tool_calls) ||
    isRecord(delta.function_call);
}

function parseFrame(frame: string): {
  eventType: string | null;
  data: string;
} {
  let eventType: string | null = null;
  const dataLines: string[] = [];
  for (const line of frame.replaceAll("\r\n", "\n").split("\n")) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = (colon < 0 ? line : line.slice(0, colon)).trim();
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") eventType = value || null;
    if (field === "data") dataLines.push(value);
  }
  return { eventType, data: dataLines.join("\n") };
}

export class SseReplayObserver {
  #decoder = new TextDecoder("utf-8", { fatal: true });
  #frame = "";
  #protocol: Protocol = "unknown";
  #termination: Termination = "open";
  #hasOutput = false;
  #sawTerminalEvent = false;
  #eventCount = 0;
  #malformedEventCount = 0;
  #lastEventType: string | null = null;
  #errorCode: string | null = null;
  readonly #maxFrameBytes: number;
  readonly #maxEvents: number;

  constructor(options: ObserverOptions = {}) {
    this.#maxFrameBytes = Math.max(
      256,
      Math.min(
        options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
        4 * 1024 * 1024,
      ),
    );
    this.#maxEvents = Math.max(
      1,
      Math.min(options.maxEvents ?? DEFAULT_MAX_EVENTS, 1_000_000),
    );
  }

  push(chunk: Uint8Array): void {
    if (this.#termination !== "open") return;
    let text: string;
    try {
      text = this.#decoder.decode(chunk, { stream: true });
    } catch {
      this.#malformedEventCount++;
      this.#termination = "error";
      return;
    }
    this.#frame += text;
    this.#drainFrames();
    this.#enforceFrameLimit();
  }

  finish(): StreamSnapshot {
    if (this.#termination === "open") {
      try {
        this.#frame += this.#decoder.decode();
      } catch {
        this.#malformedEventCount++;
        this.#termination = "error";
      }
      this.#drainFrames();
      this.#enforceFrameLimit();
      if (this.#termination === "open") this.#termination = "unexpected_eof";
    }
    return this.snapshot();
  }

  snapshot(): StreamSnapshot {
    return Object.freeze({
      protocol: this.#protocol,
      termination: this.#termination,
      hasOutput: this.#hasOutput,
      sawTerminalEvent: this.#sawTerminalEvent,
      eventCount: this.#eventCount,
      malformedEventCount: this.#malformedEventCount,
      lastEventType: this.#lastEventType,
      errorCode: this.#errorCode,
    });
  }

  #drainFrames(): void {
    let boundary = this.#nextBoundary();
    while (boundary && this.#termination === "open") {
      const frame = this.#frame.slice(0, boundary.index);
      this.#frame = this.#frame.slice(boundary.index + boundary.length);
      this.#consume(frame);
      boundary = this.#nextBoundary();
    }
  }

  #nextBoundary(): { index: number; length: number } | null {
    const lf = this.#frame.indexOf("\n\n");
    const crlf = this.#frame.indexOf("\r\n\r\n");
    if (lf < 0 && crlf < 0) return null;
    if (lf < 0 || (crlf >= 0 && crlf < lf)) return { index: crlf, length: 4 };
    return { index: lf, length: 2 };
  }

  #enforceFrameLimit(): void {
    if (this.#termination !== "open") return;
    if (
      new TextEncoder().encode(this.#frame).byteLength <= this.#maxFrameBytes
    ) return;
    this.#malformedEventCount++;
    this.#hasOutput = true;
    this.#termination = "error";
    this.#frame = "";
  }

  #consume(frame: string): void {
    if (this.#eventCount >= this.#maxEvents) {
      this.#malformedEventCount++;
      this.#termination = "error";
      return;
    }
    this.#eventCount++;
    const parsed = parseFrame(frame);
    this.#lastEventType = boundedIdentifier(parsed.eventType);
    if (parsed.data === "[DONE]") {
      this.#sawTerminalEvent = true;
      this.#termination = "done";
      return;
    }
    if (!parsed.data) return;
    let payload: unknown;
    try {
      payload = JSON.parse(parsed.data);
    } catch {
      this.#malformedEventCount++;
      this.#hasOutput = true;
      return;
    }
    const type = boundedIdentifier(
      parsed.eventType ?? (isRecord(payload) ? payload.type : null),
    );
    if (type) this.#lastEventType = type;
    if (type?.startsWith("response.")) this.#protocol = "responses";
    if (
      isRecord(payload) &&
      ("choices" in payload || ("id" in payload && "object" in payload))
    ) {
      this.#protocol = this.#protocol === "responses"
        ? this.#protocol
        : "chat_completions";
    }
    const error = firstRecord(payload, ["error"]);
    if (error) {
      this.#errorCode = boundedIdentifier(error.code ?? error.type);
      this.#termination = "error";
      return;
    }
    if (
      type === "response.completed" ||
      type === "response.done" ||
      type === "response.incomplete"
    ) {
      this.#sawTerminalEvent = true;
      this.#termination = type === "response.incomplete"
        ? "incomplete"
        : "done";
      return;
    }
    const choices = isRecord(payload) && Array.isArray(payload.choices)
      ? payload.choices
      : [];
    const responseOutput = type === "response.output_text.delta" ||
      type === "response.output_item.added" ||
      type === "response.content_part.added" ||
      type === "response.function_call_arguments.delta";
    if (choices.some(choiceMayContainOutput) || responseOutput) {
      this.#hasOutput = true;
      return;
    }
    if (this.#protocol === "unknown") this.#hasOutput = true;
  }
}

export async function observeSse(
  stream: ReadableStream<Uint8Array>,
  options: ObserverOptions = {},
): Promise<StreamSnapshot> {
  const observer = new SseReplayObserver(options);
  const reader = stream.getReader();
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      observer.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return observer.finish();
}
