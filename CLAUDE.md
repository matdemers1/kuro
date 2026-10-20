# CLAUDE.md — Kurō

Kurō is a single-user anime tracker at **kuro.dormice.ai**. It mirrors the owner's Crunchyroll watch
history into an append-only History Vault, maps it onto an open anime catalog, and tracks status per
**show** (Season → Show → Franchise), so it can answer *what do I watch next* and *what's dubbed this
week*. It is a **Dormice** project, not D3 Cloud: its own domain and visual identity, on D3
infrastructure (Zima, Shipyard, D3 Auth).

## Plan of record: Foreman project `KURO`

Start every session with `/start-development KURO`. Requirements, phases, tasks, ADRs and risks are
records in Foreman, not files here.

| Document | Resource |
|---|---|
| Overview | `foreman://KURO/overview` |
| Architecture | `foreman://KURO/architecture` |
| Data Model | `foreman://KURO/data_model` |
| UX Flows & Screen Inventory | `foreman://KURO/ux_flows` |
| Test Strategy | `foreman://KURO/test_strategy` |
| Research Notes | `foreman://KURO/research` |
| Phase plans | `foreman://KURO/phase_plan` (P0, P1, P2) |

Design board: [Kurō (KURO) in Figma](https://www.figma.com/design/SMnPQYr8LvwaoFUrmxOJMz). Code is the
source of truth once it exists; update the board when the UI changes.

## Stack

Node 22 (ESM, TypeScript strict) · Express · Prisma + PostgreSQL 16 · pg-boss (jobs in the server
process, no Redis) · React 19 + Vite 7 · Tailwind v4 + Radix primitives (**not** `@d3cloud/ui`) ·
Vitest · Playwright · pnpm 10 workspaces · Rust (Axum + crunchyroll-rs) for the Crunchyroll sidecar.

```
apps/server     Express API, Prisma schema, auth (ported from Foreman), jobs, adapters
apps/web        React PWA (phone first, desktop sidebar ≥1024px), dark + light
crates/kuro-cr  Rust sidecar: the only thing that talks to Crunchyroll (KURO-ADR-009)
deploy/         compose + Shipyard stack for the Zima
fixtures/       synthetic/ is committed; real/ is gitignored — your real export lives there
```

## Non-negotiables

- **The History Vault is append-only.** Nothing updates or deletes a `play` row (KURO-REQ-004).
- **Derived state is recomputed, never hand-edited** — status, progress and Up Next are a function of
  vault + catalog + mappings + overrides (KURO-ADR-004).
- **The Crunchyroll password is never stored**; the refresh token is AES-256-GCM under
  `KURO_SECRET_KEY` and never logged (KURO-ADR-001, KURO-ADR-008).
- **The sidecar has no published port and no state** (KURO-ADR-009).
- **Nothing personal is committed.** This repo is public. Real history goes in `fixtures/real/`
  (gitignored); CI fails on account-ID or token patterns (KURO-REQ-057).
- **AniList only for shows the owner has**, at most 20 requests/minute, cached forever (KURO-ADR-002).
- **Spoiler gating** on every screen that shows episode titles or thumbnails (KURO-REQ-018).
- Every mutation writes the change log; undo is a change-log operation (KURO-REQ-022).

## Conventions

- Dual login per GL-001: app-native email + password + TOTP **and** Sign in with D3 Auth, ported from
  Foreman's auth module (KURO-ADR-006, KURO-ADR-007). Fixes to Foreman's auth must be carried over by
  hand.
- CI runs on GitHub-hosted runners only (public repo, GL-003). Images:
  `ghcr.io/matdemers1/kuro-server`, `ghcr.io/matdemers1/kuro-cr`, sha tags.
- Deploy through Shipyard, never by SSH.
- No time estimates anywhere; sizes only.
- No `Co-Authored-By` or other Claude attribution in commits or PRs (GL-005).

## Commands (once Phase 0 lands)

```bash
pnpm install
pnpm dev                 # server + web + sidecar via compose
pnpm lint && pnpm typecheck && pnpm test
pnpm kuro spike          # KURO-T-0.6: history depth, rewatch behaviour
pnpm matcher-eval fixtures/real/   # KURO-T-2.3 gate for KURO-R-004
```
