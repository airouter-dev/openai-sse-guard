# Contributing

This package has a deliberately narrow boundary: Web Streams SSE observation
without request execution, retries, sleeps, or generated-text retention.

Before opening a pull request:

1. Add a synthetic fixture for a protocol or boundary change.
2. Keep decoded provider output out of snapshots, errors, and logs.
3. Run `deno task verify`.
4. Explain whether a change can alter automatic-replay evidence.

Do not paste production prompts, completions, credentials, headers, or customer
data into tests or issues.
