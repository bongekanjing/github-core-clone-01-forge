# A GitHub-compatible forge, one process

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/bongekanjing/github-core-clone-01-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/bongekanjing/github-core-clone-01-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

An entry for [github-core-clone-01](https://make.fun/bounty/github-core-clone-01): a single Node process
serving the four surfaces an agent already speaks to GitHub, over an in-memory store of its own.

    node main.ts

## What it answers

| Surface | Path | Notes |
| --- | --- | --- |
| Health probe | `GET /healthz` | `200 {"ok": true}`, no token |
| REST v3 | `/api/v3/...` | repositories, branches, refs, commits, trees, contents, issues, comments, labels, pull requests, files, merges, user, rate limit |
| GraphQL v4 | `POST /api/graphql` | a parser and executor, not a matcher on fixed documents |
| MCP | `POST /mcp` | JSON-RPC 2.0 over streamable HTTP: `initialize`, `server/discover`, `tools/list`, `tools/call` |
| git smart HTTP | `/{owner}/{repo}.git/...` | protocol v2 and v0: `ls-refs`, `fetch` (with `deepen` and `shallow`), `receive-pack` |
| anything else | - | `404 {"message": "Not Found"}` |

Every path but `/healthz` requires `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`, and answers `401` with
GitHub's body and a `Www-Authenticate` header when it is missing or wrong. Every reply carries a
non-empty `X-GitHub-Request-Id`.

## The files

    main.ts        the lifecycle: bind an ephemeral port, register it, poll until done, exit 0
    app.ts         the server: auth, then the surface its path names
    rest.ts        REST v3 routing and GitHub's JSON shapes
    graphql.ts     a lexer, a recursive-descent parser, and the resolvers behind the document
    mcp.ts         the tool list and the JSON-RPC dispatch
    gitserver.ts   pkt-line framing, pack writing and reading, ls-refs, fetch, receive-pack
    objects.ts     git objects: hashing, framing, tree and commit parsing
    mergegraph.ts  merge bases, ancestry, fast-forward and three-way merges
    store.ts       the store: repositories, refs, objects, issues, pulls, comments, labels
    viewer.ts      the login the token names, derived from the trial's published scenario seed

There are no dependencies: only `node:http`, `node:crypto`, `node:zlib` and the standard library. The
git protocol, the pack format, the delta chains and the GraphQL language are all implemented here.

## Design notes

**One store, four views.** REST, GraphQL, MCP and git read and write the same `Forge`. An issue created
over MCP is visible over REST and in GraphQL at once, because there is only one issue.

**Packs are content-addressed, so caching them is exact.** An object's id is the hash of its bytes, so
the same id always means the same bytes and therefore the same deflate output. The pack writer keeps
each object's deflated form and the whole pack for a given object list, so fifty concurrent clones of
one tip share one build instead of racing to produce identical bytes. That is a cache, not an
approximation: what it returns is byte-for-byte what rebuilding would return.

**Shallow clones are a boundary, not a filter.** The fetch planner walks generations from each wanted
tip and records the commits at the depth limit as the boundary. A deepen fetch starts from the client's
own shallow points, treats those commits as held but does not walk past their parents, which is exactly
what that client has.

**GraphQL is parsed, not pattern-matched.** The executor resolves `__typename`, inline fragments,
aliases, variables, nested argument objects, cursor pagination and introspection. A field the schema
does not hold becomes an `errors` entry naming it at HTTP 200, which is how GraphQL reports a bad query.

## Grading

The kit's own suite runs against a server started here:

    node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token TOK [--perf]

All 120 checks pass: git 30, repos 15, issues 15, pulls 20, graphql 20, mcp 15, protocol 5. The four
timed workloads measure push, clone, read and write against the house reference's calibrated times.

## Rules and limits

Node 22 only, no dependencies at run time, no internet and no `git` binary in the trial; the repository
is mounted read-only at `/bot` and writes go under `/tmp`. The rules, scoring weights, deadline and
prizes are on the [contest page](https://make.fun/bounty/github-core-clone-01).

## Licence

MIT. See `LICENSE`.
