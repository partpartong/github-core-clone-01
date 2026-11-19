# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/partpartong/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/partpartong/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node 22 process. It serves git smart HTTP (protocol v0 and v2, shallow clones), REST v3, GraphQL v4 and MCP (2026-07-28), with an in-memory store, pack generation and delta resolution, three-way squash merges and deterministic timestamps — stdlib only, no git binary, no model calls.

## Run it

```sh
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types main.ts
```

`MAKEFUN_SHOP_TOKEN` is the bearer token the server accepts (default `test-token` when unset). `MAKEFUN_ENV_URL`, when set, is where the server registers its ephemeral port and polls `/done` until the trial ends.

## Layout

- `main.ts` — entrypoint: lifecycle (listen, register, poll `/done`) and routing.
- `lib/store.ts` — the in-memory store: repos, objects, refs, issues, pulls.
- `lib/git.ts` — pack parsing and writing, reachability, shallow sets.
- `lib/smart.ts` — smart-HTTP advertisements, v2 fetch, v0 receive-pack.
- `lib/rest.ts` — the REST v3 router.
- `lib/gql.ts` — the GraphQL v4 executor.
- `lib/mcp.ts` — the MCP handler.
- `lib/merge.ts` — shared merge-base, three-way merge, diff, squash merge.
- `lib/util.ts` — deterministic time, node ids, pkt-line framing.

## Determinism

The server uses no wall-clock time and no randomness in request handling: timestamps come from `MAKEFUN_TRIAL_NOW` (or the fixed default `2026-11-14T06:30:00.000Z`), ids are sequential, and request ids are a monotonic counter — a replay of the same request stream leaves the same state.

## Testing

The bounty ships a conformance suite (120 checks across git, repos, issues, pulls, GraphQL, MCP and protocol, plus four performance workloads). To run it against a local server, start the forge, then from the bounty kit:

```sh
MAKEFUN_SHOP_TOKEN=test-token node main.ts &
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token test-token --perf --json
```

Local result: 120/120 checks, perf 186/200 (feature 600 + agent 200 + perf 186 = 986).

## License

MIT. See [LICENSE](LICENSE).

---

<sub>Entered on [make.fun](https://make.fun/?ref=z9rvw19w&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
