# AGENTS.md — OpenHuddle AI Engineering Constitution

> This file is the authoritative engineering guide for all AI coding agents (Antigravity, OpenAI Codex, Claude Code, Cursor, DeepSeek, etc.) working in **OpenHuddle**. Read and obey these rules on every task.

## 1. Project Overview & Tech Stack
**OpenHuddle** is an open-source, self-hostable multi-agent group huddle & human decision platform. Personal AI agents across heterogeneous hosts and hosted models collaborate, cross-check, and converge into structured proposals for human approval.

- **Monorepo**: `pnpm` workspace + `Turborepo` + `Biome` + `Vitest` + `Playwright`
- **Contracts & Domain Core**: `TypeScript 5.8+` (`strict`) + `Zod` (`packages/protocol`) + pure zero-I/O state machines (`packages/core-governance`)
- **Backend (`apps/server`)**: `Node.js 22 LTS` + `Hono` (`@hono/zod-openapi` + RPC) + `Better Auth` (human) + `oh_agt_` SHA-256 Bearer Tokens (agent) + `Pino` structured JSON logging
- **Storage & Realtime (`packages/db`)**: `Drizzle ORM` on unified **PostgreSQL** dialect (`@electric-sql/pglite` for zero-Docker local/single-node; `PostgreSQL 16+` for production) + `RealtimeBus` (`InMemoryBus` single-node / `Postgres LISTEN/NOTIFY` multi-process; no Redis required on 2C4G hosts)
- **Web (`apps/web`)**: `Vite 6` + `React 19` + `TanStack Router` + `TanStack Query` + `Tailwind CSS v4` + `shadcn/ui` (statically served by Hono in single-container production)
- **Agent Access (`packages/cli`, `packages/mcp`)**: `esbuild` zero-dependency `openhuddle.mjs` (macOS `launchd`, Linux `systemd`, Windows `schtasks + windowsHide` SSE listener) + `@modelcontextprotocol/sdk` (Streamable HTTP & `stdio`) + `Vercel AI SDK` (`ai`) for Moderator/BYOK synthesis

## 2. Architecture & Strict Dependency Boundaries
Read [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) and [`docs/CODING_STANDARDS.md`](./docs/CODING_STANDARDS.md) before designing or modifying modules.

- **Unidirectional Dependency Law**:
  - `packages/protocol` depends on nothing internal.
  - `packages/core-governance` depends **only** on `packages/protocol` (100% pure deterministic functions; **zero I/O, zero DB, zero HTTP, zero `Date.now()`** — pass timestamps explicitly).
  - `apps/server/src/modules/<domain>/` splits strictly into `.routes.ts` (HTTP/OpenAPI validation only) -> `.service.ts` (transactions, domain orchestration, post-commit bus events) -> `.repo.ts` (Drizzle SQL & row locks; never leak raw DB rows with secrets like `token_hash`).
  - `apps/web/src/features/<feature>/` colocates UI, queries, and hooks; sibling features **never** deep-import each other's internals; treat SSE strictly as a delta patcher/invalidator into `TanStack Query` (`QueryClient`), never as a duplicate store or `useEffect` fetch loop.

## 3. Mandatory Coding, Commenting & Documentation Standards
Code without proper architecture design, comments, tests, and doc updates is **incomplete**:

1. **Strict TypeScript**:
   - Zero `any` (`unknown` + Zod/type-guard narrowing only). Enable `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
   - Use **Named Exports** (`export function/const/type`), **Branded IDs** (`UserId`, `AgentId`, `RoomId`, `MessageSeq`), `readonly` data structures, and `assertNever` exhaustive `switch` checks.
2. **Three-Tier High-Value Comments (Mandatory, Chinese for domain explanations + standard TSDoc tags)**:
   - **File Header Docblock (`@module` & `@description`)**: Every core source file must state its architectural role, layer, and **key invariants** at line 1.
   - **Exported Symbol TSDoc**: 100% of exported schemas, types, state transitions, services, and hooks must carry TSDoc (`@remarks`, `@param`, `@returns`, `@throws`).
   - **Inline "Why & Invariant" Comments**: Explain *why* (lock ordering, race-condition prevention, security boundary, OS daemon quirk), never trivial *what*.
3. **Architecture-First & Living Documentation**:
   - Before implementing non-trivial subsystems, align data flow and update [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).
   - Record significant architectural or protocol trade-offs as an ADR in [`docs/adr/`](./docs/adr/) using [`docs/adr/TEMPLATE.md`](./docs/adr/TEMPLATE.md).
   - Keep `/api/docs` (OpenAPI schemas) and `/install.md` + `/skill.md` synchronized in the same commit/PR whenever endpoints or CLI flags change.

## 4. Non-Negotiable Security & Concurrency Invariants
- **Owner-First Trust Boundary**: `author.kind`, `author.isYourOwner`, and `author.trustLevel` (`owner_command` | `owner_sibling_agent` | `external_participant`) **MUST** be computed exclusively on the server from verified credentials. Never read identity fields from client payloads.
- **Monotonic Room `seq` & Optimistic Read Lock**: Increment `rooms.last_seq` inside a `db.transaction` under row lock (`FOR UPDATE`). Enforce `409 CONFLICT_UNREAD_MESSAGES` when `requireReadBeforeSend` is active and `lastReadSeq < room.lastSeq`.
- **Post-Commit Event Emission**: Publish SSE `wake` / `message.created` events to `RealtimeBus` **only after** the database transaction commits.

## 5. Verification Commands & Workflow Rules
- **Verify before finishing any task** (once scaffolded):
  - `pnpm typecheck` — Full workspace TypeScript strict check
  - `pnpm lint` — Biome format & static lint check
  - `pnpm test` — Vitest unit (`core-governance`) + in-memory `PGlite` concurrency/integration tests
  - `pnpm verify` — Runs all gates above in sequence
- **Contract Lock**: Any breaking change to `packages/protocol` or DB schema requires an isolated `contract:` PR/commit and full workspace verification.
- **2C4G Deployment Discipline**: Never design workflows that compile TypeScript/Vite on small production hosts; images are built in GitHub Actions (`ghcr.io`) and pulled via `docker compose pull`.
