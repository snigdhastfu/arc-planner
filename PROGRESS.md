# Arc build progress

Re-read `CLAUDE.md`, this file and `DECISIONS.md` after any context reset.

## Environment
- Go 1.27.3 at `~/.local/go/bin` (not on PATH: prefix commands with `export PATH=$HOME/.local/go/bin:$PATH`).
- Node 24 + `playwright-core` in `tools/e2e` (dev-only), driving system `/usr/bin/google-chrome` headless.
- `gh` NOT installed: the publish step ends with printed commands (SPEC 15).

## Milestones
- [ ] **M0** scaffold, tooling (`tools/build`, `tools/dev`), CI skeleton
- [ ] **M1** Go core (`model`, `planner`, `parse`, `doodle`, `ics`, `postcard`) with full tests + coverage
- [ ] **M2** wasm bridge, IndexedDB store, PWA shell offline, SW update banner
- [ ] **M3** Today, Routines, Guided, Editor, Quick add, Picker (motion engine + hand-drawn aliveness)
- [ ] **M4** Replan/Review, Horizon, ICS in app, postcard
- [ ] **M5** Settings, onboarding, backup/import, sample data, desktop layout, delight pass
- [ ] **M6** PWA polish, README, GitHub deploy (blocked on `gh`: commands printed)
- [ ] **M7** (stretch) sync server: only after v1.0.0 is live

## Log
