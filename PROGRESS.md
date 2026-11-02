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
- [x] **M3** Today, Routines, Guided, Editor, Quick add, Picker (motion engine + hand-drawn aliveness)
- [x] **M4** Replan/Review, Horizon, ICS in app, postcard
- [x] **M5** Settings, onboarding, backup/import, sample data, desktop layout, delight pass
- [~] **M6** PWA polish + README done and verified locally; GitHub deploy NOT done (`gh` not installed): exact commands in README > Publish
- [ ] **M7** (stretch) sync server: only after v1.0.0 is live

## Log
- M0/M1 (commit c2cb09a): `go vet`, `go test` green; coverage doodle 97.5, ics 92.8, model 94.1, parse 96.4, planner 90.1, postcard 93.1 %. ics/parse/postcard written by subagents, verified by me (vet + tests rerun, APIs read).
- M2: wasm boots in ~60 ms after fetch; `arc.version()` = 1.0.0; IndexedDB persists across reload; offline shell verified with the server stopped; SW update banner -> SKIP_WAITING -> reload -> old caches deleted. All in `tools/e2e/run.mjs`.
- M3-M5 (in progress together): every screen built; `tools/e2e/run.mjs` passes all SPEC 14 flows; `tools/e2e/shots.mjs` captures 11 screens x 2 sizes with no console errors / other-origin requests.
- M3-M5 done: 26/26 acceptance checks in `tools/e2e/run.mjs` (all SPEC 14 flows + M2 checks), no console errors, no other-origin requests; screenshots of 11 screens at 390x844 and 1280x800 in `tools/e2e/shots/`, compared with `reference/mockups/*.png` (fixes applied: arc smoothing, node crowding, label collisions, peek/actions spacing, same-day moved reason, desktop horizon width, focus ring on <main>).
- Bugs found by e2e and fixed: settings listeners leaking across visits (double sheets/imports); postcard SVG invalid XML (boolean attrs) blocked PNG export; first-install controllerchange reloaded the page; sleeping-in shelf only showed today's blocks.
- Perf (tools/e2e/perf.mjs, 4x CPU): all six main interactions 58.7-60 fps, p95 16.8 ms, <=1 frame over 25 ms each. Cold load (4x CPU, 9 Mbps/60 ms, gzip like Pages): first paint ~0.2 s, shell interactive ~0.92 s, Go planner ready ~2.27 s (shell renders from IndexedDB before wasm).
- a11y: all targets >= 44 px (tools/e2e/a11y.mjs); all text/background pairs AA (lowest 8.2:1); line boil on visible doodles only, off under reduced motion.
- Installability: CDP Page.getInstallabilityErrors = none (tools/e2e/install.mjs).
- Next: user runs README > Publish commands; then verify live URL, tag v1.0.0. M7 not started (only after v1.0.0 is live).
