# Visible recovery comparison for PR 3792

This replaces the first caption-driven clips, which did not show the operations
clearly enough. The PR remains draft for review of this replacement evidence.

## Watch

`visible-comparison.gif` is the inline animated rendition of a continuous browser
recording. It plays in the PR without a download and lasts about 55 seconds.
`comparison.webm` is the corresponding full-resolution video.

The animation contains 200 captured frames, loops continuously, and preserves
their recorded timing rounded to GIF centiseconds. Its decoded duration is
54.88 seconds. The WebM is 8 fps. The idle lead-in before the first captured
frame was removed; no operation or outcome was cut. Neither format is a latency
benchmark.

## What is on screen

- Left: unmodified production UI built from baseline
  `83ec4fbde25a9d141785716bebe0371925f895b5`.
- Center: unmodified production UI built from exact PR HEAD
  `0325357654bb189fb0263e9343b95f9c5799d9e1`.
- Right: separately labeled test controls and a real server inspector. Buttons
  issue SDK requests. The inspector shows actual HTTP responses, independently
  fetched history, and event-proxy observations.

Both clients show the same disposable session. They use the hosted-mobile UI in
separate browser frames, recorded together in Chromium on macOS at 1600 × 1000.
Loaded entry modules were checked against the respective built index files.

## Visible sequence

1. Click Create session, then use each app's own session picker to select it.
2. Click Send first turn. The real OpenCode server creates the user message and
   streams a normal assistant response through a local deterministic provider.
3. Click Send follow-up. Both clients show a second completed turn. There is no
   no-reply error card.
4. Click Delete follow-up. The tool arms the notification-loss proxy for those
   two message IDs, deletes the real assistant and user records through the SDK,
   and reads the server history again. The right-hand transcript now contains
   only the first turn. Both clients still show the deleted turn because its
   removal notifications were deliberately withheld.
5. Click Reconnect both clients. The normal event streams reconnect and the
   normal loader fetches authoritative history. The baseline retains the deleted
   follow-up; the PR removes it. The retained turn stays visible in both clients.

The blue pointer indicator follows the actual browser input coordinates. There
are no changing explanatory banners over the application and no injected
message nodes, direct store writes, or direct loader calls.

## Runtime and limits

The backend is real OpenChamber connected to real OpenCode 1.18.31 in an isolated
Docker container. The only model provider is a local OpenAI-compatible fixture
that streams deterministic text. No external model service, user session, or
credential was used. This provider is a test double; OpenCode's persistence and
event generation, the browser event pipeline, and both UI builds are real.

The notification loss is intentionally injected. This demonstrates the recovery
defect, not why the original user's `/compact` operation missed its events.
It does not establish native Electron, VS Code, Capacitor, or relay behavior.

`result.json` contains the real request log, synthetic IDs, frame-relative action
times, and proxy observations. Times in that file include a 9.948-second idle
lead-in removed from the published recording.

`server-deleted-clients-stale.png` shows the server at one turn while both clients
still display two. `after-reconnect.png` shows the resulting client divergence.
