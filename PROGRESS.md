# Arc build progress

Re-read `CLAUDE.md`, this file and `DECISIONS.md` after any context reset.

## Environment
- Go 1.27.3 at `~/.local/go/bin` (not on PATH: prefix commands with `export PATH=$HOME/.local/go/bin:$PATH`).
- Node 24 + `playwright-core` in `tools/e2e` (dev-only), driving system `/usr/bin/google-chrome` headless.
- `gh` NOT installed: the publish step ends with printed commands (SPEC 15).

## Milestones
- [x] **M0** scaffold, tooling (`tools/build`, `tools/dev`), CI skeleton
- [x] **M1** Go core (`model`, `planner`, `parse`, `doodle`, `ics`, `postcard`) with full tests + coverage
- [x] **M2** wasm bridge, IndexedDB store, PWA shell offline, SW update banner
- [ ] **M3** Today, Routines, Guided, Editor, Quick add, Picker (motion engine + hand-drawn aliveness)
- [ ] **M4** Replan/Review, Horizon, ICS in app, postcard
- [ ] **M5** Settings, onboarding, backup/import, sample data, desktop layout, delight pass
- [ ] **M6** PWA polish, README, GitHub deploy (blocked on `gh`: commands printed)
- [ ] **M7** (stretch) sync server: only after v1.0.0 is live

## Log
- M0/M1 (commit c2cb09a): `go vet`, `go test` green; coverage doodle 97.5, ics 92.8, model 94.1, parse 96.4, planner 90.1, postcard 93.1 %. ics/parse/postcard written by subagents, verified by me (vet + tests rerun, APIs read).
- M2: wasm boots in ~60 ms after fetch; `arc.version()` = 1.0.0; IndexedDB persists across reload; offline shell verified with the server stopped; SW update banner -> SKIP_WAITING -> reload -> old caches deleted. All in `tools/e2e/run.mjs`.
- M3-M5 (in progress together): every screen built; `tools/e2e/run.mjs` passes all SPEC 14 flows; `tools/e2e/shots.mjs` captures 11 screens x 2 sizes with no console errors / other-origin requests.
