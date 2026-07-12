# viser — working conventions

- **Dock/panel changes require a spec trace.** `design/dock-ux-spec.md` is
  normative for the dock system; after any behavior change, re-trace the
  touched claims per its §10 protocol (normative text, gesture table,
  decision index). Where code and spec disagree, decide on paper first.
- **Gates before committing client code** (from `src/viser/client`):
  `npx tsc --noEmit`, `npx eslint src/`, `npx prettier --check src/`,
  `npx vitest run src`.
- **Gates for Python**: `ruff check`, `ruff format --check`, `pytest tests`
  (e2e suites under `tests/e2e` are slow; CI shards them).
- **Message protocol**: never hand-edit `WebsocketMessages.ts`; change
  `src/viser/_messages.py` and run `python sync_client_server.py
  --sync-messages`.
- **Panel placement is write-only**: the server never reads layout state
  back; keep new placement features as independent per-axis
  `update_simple` messages (see spec §8).
