# PR 3792: live missed-removal recovery

These recordings show the full production-built OpenChamber UI connected to a
real, isolated OpenCode 1.18.31 server running in Docker. All visible messages
and session IDs belong to disposable synthetic test sessions.

## Builds

| Version | Source commit | Loaded entry module |
|---|---|---|
| Baseline | `83ec4fbde25a9d141785716bebe0371925f895b5` | `/assets/main-1tz4ZiKT.js` |
| PR 3792 | `0325357654bb189fb0263e9343b95f9c5799d9e1` | `/assets/main-BxFj1hI5.js` |

Each source tree was exported from its pinned commit and built with
`bun install --frozen-lockfile` and `bun run build:web`. The recorder checked the
loaded script URL in each browser against that build's `index.html`. Service
workers and the browser HTTP cache were bypassed.

## Procedure

1. Create a disposable session through the official SDK.
2. Submit two synthetic prompts with `noReply: true`, named KEEP and REMOVE.
3. Open the session through the real UI session picker and verify both messages
   are mounted.
4. Delete REMOVE through `session.deleteMessage`. Read the real server history
   again and confirm that only KEEP remains.
5. A loopback test proxy deliberately withholds the actual `message.removed`
   notification for that one message. The stale bubble remains in the client.
6. Close the browser's normal global-event WebSocket with code 1012. Let the
   real event pipeline reconnect and run its normal authoritative tail refresh.
7. Observe the rendered transcript without reloading, changing sessions, calling
   the loader directly, or editing the message DOM or store.

The caption band is a test annotation over the real app. It explains the
injected event gap; it does not replace any chat content.

## Results

| Browser surface | Baseline after reconnect | PR after reconnect |
|---|---|---|
| Web desktop, 1280 × 900 | REMOVE still visible | REMOVE gone, KEEP preserved |
| Hosted mobile, 390 × 844 | REMOVE still visible | REMOVE gone, KEEP preserved |

Every run recorded exactly one withheld `message.removed`, a second WebSocket
connection, HTTP 200 history containing only KEEP, and a completed
`session-messages.refresh` diagnostic. No SSE fallback occurred. The JSON logs
contain the synthetic record IDs, request results, and read-only DOM outcome.
The desktop PR run also logged ordinary prefetch of the preceding baseline
session. Assertions use the current run's session ID, not the last unrelated
request.

## Recordings and screenshots

- `baseline-desktop.webm` and `fixed-desktop.webm`
- `baseline-mobile.webm` and `fixed-mobile.webm`
- Matching `*-result.png` screenshots show the settled result.
- `results-desktop.json` and `results-mobile.json` contain the network and
  loader diagnostics for the recorded runs.

The recordings use sequential browser screenshots encoded as 8 fps WebM. They
show state transitions, not real-time latency or performance measurements.

The visible "OpenCode did not start a reply" notice is expected in this fixture:
`noReply: true` deliberately suppresses a model response. No paid or external
model was called. That notice is present on both builds and is not the bug
under test.

## Limits

This reproduces the real UI's failure to recover from a deliberately missed
removal notification. It does not establish why the original user's client
missed a removal during revert/compaction. These are Chromium web and hosted
mobile runs on macOS, not native Electron, VS Code, Capacitor, or relay tests.
No new light-theme evidence was captured because the patch changes transcript
membership, not colors or styling.
