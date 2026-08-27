# Protocol v1 golden fixtures

These fixtures are the shared TypeScript and C++ examples for the engine JSON-RPC v1 contract.
`messages/` contains accepted requests, responses, and notifications. `cases/` contains a request and
its expected error response for each rejected input. `manifest.json` records the exchange order and
expected error codes without duplicating protocol payloads.

Each protocol fixture contains exactly one compact JSON object followed by LF, matching the NDJSON
transport. Request IDs are non-empty strings. Notifications omit `id`. A missing optional field and an
explicit `null` are distinct: the canonical synthesis request uses `null` for absent `speaker` and
`instruct`, while requests with no parameters omit `params`. The empty object on `engine.shutdown` is
intentional because that method has a defined, empty params shape.

`speech-audio.notification.json` contains the RFC 4648 Base64 value `AAAAAA==`, which decodes to four
bytes, or two signed 16-bit PCM samples. Tests must construct the 1 MiB message-limit case in memory;
the fixture set intentionally contains no oversized file.

Error-case requests remain valid JSON-RPC envelopes. They are rejected at protocol dispatch or method
parameter validation, as identified by the paired response and `manifest.json` error code.
