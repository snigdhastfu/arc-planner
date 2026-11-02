# CLAUDE.md: Arc (read this first, every session)

Arc is a whimsical, adaptive personal planner: Go core compiled to WebAssembly, vanilla-JS installable PWA, hosted on GitHub Pages, all data local to the device.

**Authoritative docs:** `reference/SPEC.md` (build spec: follow it exactly), `reference/README.md` (what each reference file is), `reference/mockups/` (visual source of truth), `arc.config.json` (name, logo, colors).

## Non-negotiables
1. Work autonomously. Do not ask the user questions. Make a sensible decision, record it in `DECISIONS.md`, move on.
2. Never redraw, simplify, restyle or add faces to the doodles in `reference/doodles/doodles.json`. Same for `reference/logos/`.
3. Palette is fixed (see SPEC section 11). Pure black #000000 background. No light theme. No red for errors or warnings.
4. Never guilt-trip in copy: no streak-shaming, no "you missed". Skipped things are "sleeping in".
5. Zero third-party requests at runtime: no CDNs, no analytics, no remote fonts. Everything is bundled. All URLs relative (the app is served from a sub-path on GitHub Pages and on forks).
6. The planner never silently moves things: it proposes a diff, the user approves.
7. Core logic stays pure Go in `internal/*` (no browser, DB or filesystem dependencies) and is covered by `go test`.
8. Verify, don't claim: run `go vet`, `go test`, build the wasm, run the app in headless Chromium, screenshot every screen and compare against `reference/mockups/*.png`.
9. Commit after every milestone with a clear message. Push once M6 is green.
10. Keep dependencies minimal; justify any addition in `DECISIONS.md`.
