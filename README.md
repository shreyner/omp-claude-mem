# omp-claude-mem

A maintained fork of [claude-mem](https://github.com/thedotmack/claude-mem)'s official
[oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) hook. It records omp sessions into the
same claude-mem store that Claude Code and other agents write to, and injects project memory into
every model call.

`src/claude-mem.ts` is upstream `omp/hooks/claude-mem.ts` **v15.9.0** plus the fixes below. omp
loads a plain copy of it from `~/.omp/agent/hooks/pre/claude-mem.ts`.

Tested with omp **18.16.0** and a claude-mem worker **13.35.0** (the hook's extra v15 fields are
accepted by the 13.35 worker).

## Differences from upstream

Upstream v15.9.0 still has these problems on omp; each fix has a regression test that fails on the
pristine upstream file.

| Problem in upstream | Fix here |
|---|---|
| omp binds one imported hook factory for the parent session and every subagent. Upstream keeps the session in module state, so a subagent's `session_start` re-points the parent: parent tool calls and summaries land in the child's claude-mem session. | All session state (session id, context cache, last assistant reply, worker address) lives inside the factory. The circuit breaker stays module-level: every binding talks to the same worker. |
| Observations carry no `tool_use_id`, so the worker's raw `tool_uses` index stays empty for omp. | `tool_use_id` is omp's `event.toolCallId`. |
| `session_shutdown` drops the finalize Promise, so the summary can be lost when omp exits. | Shutdown awaits the finalize chain within omp's 2 s handler budget. |
| Calls to omp's own memory tools and to claude-mem's MCP server are stored as observations: memory about memory. | `retain`, `recall`, `reflect`, `learn`, `memory_*` and `mcp__claude_mem_*` are skipped, also when called through an `xd://` device path. |
| omp truncates long tool-output lines (768 bytes) before hooks see them. A `<private>` block cut that way loses its closing tag, and upstream keeps an unclosed tag as literal text, so the private content is stored. | An opening private tag left after the balanced strip drops the rest of the tool response. Output that mentions `<private>` literally is stored only up to that point. |

Taken from upstream as is: memory injection as a transient `custom` message, `<private>` stripping
before the 1000-char cap, `CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES`, telemetry timestamps.

## Requirements

- [Bun](https://bun.sh) and omp. Tests and the load check import omp's SDK from
  `~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent`; set `OMP_SDK_DIR` to the package
  root if it lives elsewhere.
- A running claude-mem worker (`npx claude-mem install`). The hook reads the worker address the
  way claude-mem does: `CLAUDE_MEM_WORKER_HOST` / `CLAUDE_MEM_WORKER_PORT`, then
  `~/.claude-mem/settings.json`, then the per-user default port.

## Install

```bash
bun test tests
bash deploy.sh
```

`deploy.sh` runs the tests, then copies `src/claude-mem.ts` to
`$PI_CODING_AGENT_DIR/hooks/pre/claude-mem.ts` (default `~/.omp/agent`) and verifies its SHA256.
It refuses a symlinked destination and an installed file it does not recognize. It recognizes a
missing file, any upstream original under `upstream/`, its own last deployment
(`.last-deployed.sha256`) and the current source. The previous file is kept in `backups/`.

Install a regular copy, not a symlink: claude-mem's installer writes through the link into your
source. Do not install the official hook next to this one under another name; both would record
every event.

The hook takes effect in a **new omp process**; `/reload-plugins` does not rebuild an already
loaded hook. To check that a file loads with omp's real loader (three bindings, nine handlers
each, no events sent):

```bash
bun scripts/verify-load.ts [path/to/claude-mem.ts]
```

## Tests

`bun test tests` runs the hook through omp's real extension loader, runner and `convertToLlm`
against a loopback HTTP server. It needs no model, no network and no claude-mem database.
`tests/deploy.test.ts` exercises `deploy.sh` in temporary directories.

## Updating from upstream

`npx claude-mem install --ide omp` (or a claude-mem update with omp selected) overwrites the
installed hook with the official one. The source here is not affected.

1. Save the new upstream file and its metadata to `upstream/<version>/`; keep the older originals.
2. Run `tests/hook.test.ts` against a pristine copy of the new upstream file to see which of the
   fixes above upstream now covers.
3. Port the upstream changes into `src/claude-mem.ts`. Drop a local fix only when its test passes
   on the pristine upstream file.
4. `bun test tests`, then `bash deploy.sh`, then start a new omp process.

## Limitations

- Delivery is best effort. omp gives shutdown handlers 2 s and each worker request times out after
  5 s, so a slow summary can still be cut off. A worker that accepted a request may lose it from
  its in-memory queue if it restarts.
- The bridge session id (`omp-<pid>-<uuid>`) changes when omp restarts, even for a resumed session.
- Tool results that arrive after a mid-run compaction, with no later prompt, are recorded without
  a summary.
- If the worker starts requiring an auth token
  ([claude-mem#5147](https://github.com/thedotmack/claude-mem/pull/5147)), this hook needs the
  matching change before the worker update.

## Layout

| Path | Purpose |
|---|---|
| `src/claude-mem.ts` | The hook |
| `upstream/claude-mem.ts`, `upstream/metadata.json` | Original baseline of this fork (claude-mem 13.35.0) |
| `upstream/<version>/` | Later upstream originals; the current base is `v15.9.0` |
| `tests/` | Hook and deploy tests |
| `deploy.sh`, `scripts/verify-load.ts` | Guarded install and load check |

## License

Apache-2.0, as claude-mem. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
