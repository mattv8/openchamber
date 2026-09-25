# Managed OpenChamber Agent Tool

## Purpose

This module exposes OpenChamber to agents as typed OpenCode custom tools. There
are two, because controlling sessions and driving a page are separate intents
the user can want independently:

- `openchamber` — projects, sessions, worktrees, scheduled tasks, and showing
  a file to the user (`file.open`). Enabled while the persisted
  `agentControlToolEnabled` setting is not `false`.
- `openchamber_web` — looking at and interacting with the page in OpenChamber's
  browser panel. Enabled while `agentWebToolEnabled` is not `false`.
- `openchamber_notify` — `notify.send`, a notification to the user through
  `lib/notifications/emit-route.js` (same limits and rate window as
  `POST /api/notifications/emit`). Off by default: enabled only while
  `agentNotifyToolEnabled` is `true`, and the control service refuses the
  action when the setting is off, so a stale plugin cannot keep paging.

Both default to on, are toggled in Settings → General → OpenCode CLI, and take
effect through OpenCode's watched global plugin directory. Each tool carries
only its own actions and parameters. A tool disabled in every registered
OpenChamber backend is absent from the schema.

The default shared-service path publishes a plugin under the effective OpenCode
config root's `plugins/openchamber-agent-tool/`. It works when the CLI started
first and requires no edit to the user's `opencode.json`. An ownership marker
prevents overwriting an unrelated plugin at that path. Explicit external-server
connections do not install it.

Each backend publishes a separate private callback record. The oldest healthy
backend supplies tools, with PID and instance ID as stable tiebreakers. A second
backend does not take over; after the first closes, the next healthy backend
serves calls. This can direct browser actions to a different OpenChamber window
than the one currently visible. Result metadata identifies the serving instance;
there is no per-session window affinity. If the elected backend has a tool
disabled, execution reports that rather than choosing another backend.

- The plugin accepts the action's inputs either inside `parameters` or beside
  `action`, because models produce both shapes; an explicit `parameters` object
  wins on a conflict. Rejecting the flattened shape turned a call that plainly
  carried a `url` into "url is required", which reads as a broken tool rather
  than a malformed call.

## Runtime flow

### Shared service

1. The HTTP listener binds. `buildSharedServiceEnv()` reads the tool settings and
   publishes this backend's callback under
   `<opencode-config-root>/openchamber-agent-tool/`.
2. The generated global plugin reads the capability union from live callback
   records. Registration and settings changes atomically rewrite its entrypoint
   with a reload marker so OpenCode refreshes the tool schema.
3. Before each action, the plugin checks the candidate's PID and authenticates a
   bounded `GET /api/openchamber/agent-tool` liveness request. The returned
   instance ID must match its record. It then sends the action once by POST.
   Failed action requests are not replayed against another backend.
4. Shutdown removes only this backend's callback and triggers a reload. The
   owned plugin can remain installed with no tools when no callbacks remain;
   this avoids deleting a concurrently starting backend's plugin. Dead-process
   records do not participate in selection.

### Legacy private child

The existing private-child helpers use the following environment-based flow;
the shared plugin never falls back to those credentials.

1. The OpenChamber HTTP listener binds and publishes its authoritative port.
2. `materializePlugin()` writes the plugin under
   `<openchamber-data-dir>/agent-tool/` and returns its directory; the managed
   config layer lists that directory in `<data-dir>/opencode.managed.json` and
   rewrites the file whenever a tool setting changes.
3. `createChildEnv()` adds a random per-child token and the callback URL to the
   managed OpenCode child environment. They are present even while every tool
   is off, so a tool switched on later can call back without a restart. The URL
   points at loopback, except when the listener is bound to one concrete
   address (`--host <ip>`): that socket does not answer on loopback, so the URL
   uses the bound address instead.
4. The plugin calls `POST /api/openchamber/agent-tool` with its typed input and
   the session id OpenCode gives the tool; OpenChamber resolves the session's
   directory on its own side.
5. The route delegates the fixed action allowlist directly to the shared
   OpenChamber control service. The CLI uses the same service through its
   authenticated HTTP adapter, so Goal Mode ordering, wait behavior,
   partial-failure reporting, and scheduled-task contracts have one owner.
6. Each action definition owns a short presentation title and a separate
   agent-facing description. The generated schema uses the description to state
   required inputs or one non-obvious behavior, while completed calls use the
   short title in native tool metadata.

## Agent context budget

- The tool exposes one shared parameter object rather than repeating parameters
  in a large per-action union. Action descriptions carry only required inputs,
  defaults, or one non-obvious semantic detail.
- The action schema carries `oneOf` and no `enum`. A node combining `enum` and
  `oneOf` is valid JSON Schema, but some OpenAI-compatible gateways reject it
  and answer with an empty completion instead of an error.
- Obvious fields rely on their names and JSON types. Parameter descriptions are
  reserved for formats, dependencies, scope, and behavior that cannot be safely
  inferred from the field name.
- Session dispatches do not wait by default. Agents are told to set `wait` only
  when the user asks or the next step requires the completed result.
- The tool exposes only agent-relevant actions
  (`OPENCHAMBER_AGENT_TOOL_ACTIONS`): `schedule.status` stays CLI-only because
  `schedule.list` already returns scheduler status, and enable/disable are one
  `schedule.toggle` action driven by the `disabled` boolean.
- The tool description frames intent: created sessions and scheduled tasks are
  user-facing work the user follows up with. The agent must not decide on its
  own to delegate parts of its current task, but an explicit user request to
  create, send, or schedule always wins, even when it relates to the current
  task (strict models otherwise read the old unconditional "never delegate" as
  a hard ban and refused user-requested sends).
- Optional behavior switches (`worktree`, `goal`, `agent`, `variant`, `wait`)
  state their default and an explicit "only when the user asks" rule so agents
  do not invent worktrees, goal mode, or waits the user never requested.
- Detailed combination rules are enforced by the shared control service and
  returned as actionable usage errors only after an invalid call. Per-action
  examples and a repeated per-action parameter schema are intentionally omitted.

## Security invariants

- The callback accepts same-machine requests only and requires the current
  per-child bearer token using a timing-safe comparison. Same-machine means a
  loopback source, or, for a listener bound to one concrete address, a source
  equal to that address: the OS sources a local connection to `<ip>` from
  `<ip>`. A wildcard bind keeps the loopback-only rule, and another machine on
  the network always arrives with its own address.
- Shared callback tokens are persisted only in per-instance files created with
  mode `0600` in a `0700` registry directory. They are never logged, returned to
  the UI, or embedded in generated plugin source. Private-child tokens remain
  environment-only. Each backend authorizes its own token with the existing
  same-machine and timing-safe checks.
- The shared plugin adds the selected callback host to `NO_PROXY`/`no_proxy`
  before each health or action request. Without that, an `HTTP_PROXY` in the child's environment
  would receive a non-loopback callback, token included, because `fetch` has no
  per-request way to skip the environment proxy.
- Inputs map to a fixed action and parameter allowlist. There is no arbitrary
  CLI, shell, route, or URL forwarding.
- Session/worktree deletion and project-path registration are not exposed.
- A cancelled turn aborts the session's in-flight actions. OpenCode 2 gives a
  plugin tool no abort signal and the plugin's request stays open, so the
  server tracks in-flight actions per session and `abortSession(sessionID)` is
  called from the event dispatch in `server/index.js` when the stream reports
  `session.idle` with `aborted: true`; the abort signal then reaches the
  shared service as before. A dropped HTTP request still aborts as well.

## Result contract

Every completed call returns JSON:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "action": "session.create",
  "data": {}
}
```

Command and operational failures use the same envelope with `ok: false` and
an `error` object. OpenCode-level cancellation can still produce a native tool
error state.

## Runtime parity

- Web and Desktop default local service: globally watched plugin and private
  callback registration, regardless of which client started OpenCode first.
- External OpenCode selected with `OPENCODE_HOST` or skip-start: not injected,
  because OpenChamber does not control that process environment.
- VS Code: shares the CLI service but publishes no callback. If a web/desktop
  backend is running, its plugin is available in that shared service.
- Hosted and Capacitor mobile clients use the server's managed OpenCode tool
  when connected to such a server; no tool runs in the client runtime.

A CLI-first service retains its built-in `opencode.browser` plugin. OpenChamber
does not rewrite user configuration to disable it. The OpenChamber-owned config
layer can still disable it when supplied at a new service's startup. A service
started with a different effective config root must watch the publication root
for hot registration to apply.

## The calling tool is part of the request

Each generated tool sends its own name with every callback. Models routinely
drop the namespace their tool's name appears to supply — `openchamber_memory`
asked for `memory.read` gets called as `read` — and resolving the bare name
inside the calling tool's action set makes that unambiguous even where it is not
globally (`delete` belongs to both schedule and memory).

Resolution never reaches outside the tool that asked: `open` from the memory
tool fails rather than driving the browser. An unresolvable action answers with
the actions that tool actually has, because an error that only says
"unsupported" leaves the model to guess a second wrong name — which is exactly
what happened before this existed.
