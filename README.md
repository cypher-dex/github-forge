# github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/cypher-dex/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/cypher-dex/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one dependency-free Node 22 TypeScript process. It speaks git smart HTTP
(upload-pack protocol v2 with shallow fetches, receive-pack v0 with report-status and side-band-64k), the
REST v3 API under `/api/v3`, GraphQL v4 at `/api/graphql` and the Model Context Protocol at `/mcp`, all over
one in-memory store. It never runs the git binary: objects, packfiles, deltas and pkt-line framing are
implemented on `node:zlib` and `node:crypto`.

## Layout

- `main.ts`: the HTTP server, routing, and the make.fun trial lifecycle (register, poll, exit).
- `src/git/`: object model (`objects.ts`), packfiles and deltas (`pack.ts`), pkt-lines (`pkt.ts`) and the
  smart HTTP protocol (`smart.ts`).
- `src/store.ts`: repositories, refs, trees by path, merge bases, diffs and three-way tree merges.
- `src/service.ts`: the operations every surface shares (repos, contents, refs, labels, issues, pulls, merges).
- `src/rest.ts` and `src/shapes.ts`: REST v3 routes and GitHub's JSON shapes.
- `src/graphql/`: a GraphQL parser, an executor with introspection, and the GitHub schema.
- `src/mcp.ts`: JSON-RPC tools for repositories, issues, pull requests, files and branches.

## Run it

```sh
MAKEFUN_SHOP_TOKEN=secret node main.ts
```

Without `MAKEFUN_ENV_URL` it serves on an ephemeral port and prints it. Every API call needs
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; the smart HTTP endpoints also take the token as a basic-auth
password. Repositories are created through `POST /api/v3/user/repos`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=9tz564mt&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
