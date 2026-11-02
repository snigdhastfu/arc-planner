# Arc: Build Specification (authoritative)

Precedence: this SPEC beats any summary prompt for behavior and structure; `reference/mockups/` beats this SPEC for visuals. If something is unspecified, decide, record it in `DECISIONS.md`, and continue.

## 1. Product
A planner for ONE user (a student). Item types: exam, assignment, project, fixed event, routine (grunt tasks: meds, supplements, cream, making the bed). It plans backwards from deadlines around the user's daily ambition and energy windows. When the user falls behind it PROPOSES a new plan as a diff that they approve. Look: black + pastel, hand-drawn doodles, playful, never guilt-tripping. Extras: calendar import/export (.ics), end-of-day "tuck-in" postcard, "sleeping in" shelf, quick-add deep links, optional sound.

## 2. Toolchain and environment checks (do first, in M0)
- Run `go version`; require Go >= 1.24. If missing, stop and tell the user exactly how to install it (do not attempt a workaround).
- Run `git --version`, `gh --version`, `gh auth status`. If `gh` is missing or unauthenticated, finish everything else, then print the exact commands for the user to run for GitHub (section 15).
- Node is NOT required to build or run the app. It may be used only for dev-only Playwright tests in `tools/e2e` (own `package.json`, never imported by the app). If Playwright is unavailable, state it and fall back to `go test` plus manual build checks.
- Windows is the user's laptop OS: no bash-only or Makefile-only workflows. All build/dev tasks are `go run ./tools/...`. Use forward slashes in Go, `filepath` for filesystem work. Do not rely on symlinks.

## 3. Repository layout (create exactly)
```
.
  CLAUDE.md  DECISIONS.md  README.md  LICENSE(MIT)  CHANGELOG.md  .gitignore  .nojekyll(in dist via build)
  arc.config.json
  go.mod                         (module github.com/OWNER/REPO is NOT hardcoded: use module "arc")
  cmd/arc-wasm/main.go           //go:build js && wasm
  cmd/arc-server/main.go         (M7, optional)
  internal/model/                types.go json.go
  internal/planner/              plan.go replan.go grid.go why.go *_test.go
  internal/parse/                quickadd.go dates.go *_test.go
  internal/doodle/               match.go *_test.go   (embeds reference doodle-keywords via go:embed copy in internal/doodle/keywords.json)
  internal/ics/                  parse.go expand.go write.go *_test.go
  internal/postcard/             compose.go *_test.go (deterministic layout + summary text)
  tools/build/main.go            build to dist/
  tools/dev/main.go              build + serve dist/ with correct MIME and no-cache
  tools/e2e/                     dev-only Playwright tests + screenshots
  web/
    index.html  manifest.template.json  sw.template.js  offline.html
    css/ tokens.css base.css components.css screens.css
    js/  main.js bridge.js store.js state.js router.js doodle.js arc.js gestures.js anim.js sound.js ics-io.js postcard.js copy.js
    js/ui/ today.js routines.js guided.js review.js horizon.js quickadd.js editor.js picker.js settings.js onboarding.js sheet.js nav.js
    data/ doodles.json doodle-keywords.json sample.json
    fonts/ Fredoka-*.woff2 (+ OFL.txt)
  logos/ (copied from reference/logos at build per arc.config.json)
  reference/ (given; do not modify)
  .github/workflows/ pages.yml ci.yml release.yml
```
`dist/` is generated and git-ignored.

## 4. Build tooling
- `go run ./tools/build [-logo A|B|C] [-out dist]`: (1) read `arc.config.json`; (2) `GOOS=js GOARCH=wasm go build -ldflags="-s -w" -trimpath -o dist/arc.wasm ./cmd/arc-wasm`; (3) copy `wasm_exec.js` from the SAME toolchain (`$(go env GOROOT)/lib/wasm/wasm_exec.js`, fall back to `misc/wasm/wasm_exec.js`): never commit a stale copy; (4) copy `web/` to dist; (5) copy chosen logo icons to `dist/icons/` and `mark.svg` to `dist/img/`; (6) render `manifest.webmanifest` from the template using config (name, short_name, description, theme_color, background_color, `start_url:"./"`, `scope:"./"`, `display:"standalone"`, icons 192/512/maskable-512, `orientation:"portrait"`); (7) render `sw.js` from the template with `__VERSION__` = short sha256 of all dist files + the precache list of every file; (8) write `dist/.nojekyll`; (9) print file sizes.
- `go run ./tools/dev [-port 8080]`: runs build then serves dist/ with `Content-Type: application/wasm` for .wasm, `Cache-Control: no-store`, and rebuilds on a `/__rebuild` request. No external deps.

## 5. Go core
### 5.1 Conventions
All exported core entry points take and return JSON strings. Envelope: success `{"ok":true,"data":...}`; failure `{"ok":false,"error":{"code":"...","message":"..."}}`. Never panic across the boundary (recover and return an error envelope). Deterministic: identical input gives byte-identical output (sort everything; no map-iteration order, no randomness, no `time.Now()` inside core; `now` is an input). Import `_ "time/tzdata"` in cmd/arc-wasm and in tests so IANA zones work in WASM. Times in JSON are RFC3339 with offset. Day keys are `YYYY-MM-DD` in the profile's IANA zone. Minutes-from-midnight are ints.

### 5.2 Types (internal/model; JSON tags are lowerCamelCase)
```go
type Profile struct {
  TZ string                  // IANA e.g. "Asia/Kolkata"
  WakeMin, SleepMin int      // e.g. 420, 1380
  AmbitionMin int            // default deep-work minutes/day, e.g. 240
  DayOverrides map[string]int// day key -> minutes
  Energy []EnergyWindow      // sorted, non-overlapping, covers wake..sleep; gaps = "med"
  BlockMin int               // default 50
  OverloadFactor float64     // default 1.4
}
type EnergyWindow struct{ StartMin, EndMin int; Level string } // "high"|"med"|"low"
type Recur struct{ Freq string; Interval int; Days []int; Until string } // Freq "daily"|"weekly"; Days 0=Sun
type RoutineSpec struct{ Anchor string; AtMin *int; DurMin int; Detail, Group string; Order int; Recur Recur } // Anchor "morning"|"daytime"|"evening"|"time"
type Item struct {
  ID, Type, Title, Doodle, DoodleSource string // Type: exam|assignment|project|event|routine; DoodleSource: auto|user
  Start, End, Due string        // RFC3339 (event: Start/End; exam: Start is exam time; assignment/project: Due)
  StartBy string                // optional RFC3339
  EffortMin, DoneMin int; Done bool
  Topics []string; ParentID string; Notes string
  Routine *RoutineSpec
  Recurrence *Recur             // for events from ICS (expanded instances are separate Items with SeriesID)
  SeriesID string
  Deleted bool; UpdatedAt string
}
type Block struct {
  ID, ItemID string; Seq int; Start, End string
  Kind string                   // work|routine|event
  Why string; Forced, Pinned bool
  Status string                 // planned|done|skipped|moved
}
type AtRisk struct{ ItemID string; ShortMin int; Reason string }
type Plan struct{ Blocks []Block; AtRisk []AtRisk; GeneratedAt string; Warnings []string }
type Change struct {
  ID, ItemID, BlockID string
  Kind string                   // moved|shortened|dropped|added|atRisk|watch
  FromStart, FromEnd, ToStart, ToEnd string
  Reason string
}
```
### 5.3 Bridge API (cmd/arc-wasm registers on `globalThis.arc`; all sync, return JSON string)
`arc.plan(req)`, `arc.replan(req)`, `arc.applyChanges(req)`, `arc.parseQuickAdd(req)`, `arc.matchDoodle(req)`, `arc.icsImport(req)`, `arc.icsExport(req)`, `arc.postcard(req)`, `arc.version()`. `main()` registers them, sets `globalThis.arcReady = true`, dispatches a `arc-ready` event, then blocks with `select{}`. Requests: `plan {items, profile, now, existing:[Block], horizonDays?}`; `replan {items, profile, now, current:Plan}` returns `{proposed:Plan, changes:[Change], drifted:bool}`; `applyChanges {current:Plan, proposed:Plan, changes:[Change], acceptedIDs:[string], items, profile, now}` returns `{plan, conflicts:[{changeId,reason}]}`; `parseQuickAdd {text, now, tz}` returns `{item, confidence:"high"|"low", understood:[{field,value}]}`; `matchDoodle {title, type}` returns `{doodle}`; `icsImport {ics, tz, now, horizonDays}` returns `{items, skipped:[{reason}]}`; `icsExport {items, plan, profile, include:["events","routines","blocks"], now}` returns `{ics}`; `postcard {day, blocks, items, seed}` returns `{summary, stickers:[{doodle,x,y,rot,scale}]}`.

## 6. Planner (internal/planner)
**Grid.** Per local day, a 5-minute slot grid between WakeMin and SleepMin. Mark slots busy for: fixed events, done blocks, pinned blocks, and past time today (before `now`, rounded up to 5).
**Routines first.** Place routine blocks at their anchors: morning = WakeMin+15, daytime = AtMin or 13:00, evening = SleepMin-90, "time" = AtMin. Routines in the same Group pack sequentially by Order. Honor Recur (daily/weekly, Interval, Days, Until). Skipped routines are not re-placed same day.
**Capacity.** Day capacity = DayOverrides[day] or AmbitionMin, minus work minutes already done that day. Hard max = capacity x OverloadFactor.
**Demands.** For each non-done exam/assignment/project: `remaining = EffortMin - DoneMin - minutes of done blocks`. Deadline D: exam = Start; assignment/project = Due. Buffer: exam: no work in the final 12 hours; assignment: end >= 2 h before Due; project: end >= 24 h before Due. Eligible days: from max(today, StartBy) to the last day with usable time before (D - buffer). Process items ordered by (D asc, ID asc).
**Distribution (exact).** `blocks = ceil(remaining/BlockMin)`; last block may be shorter but >= 15 min (merge into previous if smaller). `perDay = max(1, ceil(blocks/eligibleDays))` blocks. Walk eligible days earliest to latest, placing up to `perDay` blocks per day within normal capacity; carry shortfall forward. For exams reserve the last 2 eligible days for a refresher (the final block of up to BlockMin each) when remaining allows ("spaced revision"). If blocks remain after the pass, run a second pass over all eligible days placing within hard max, flagging `Forced=true`. Anything still unplaced becomes `AtRisk{ShortMin, Reason}`.
**Slot choice.** For deep work, order free runs by energy level (high, med, low) then earliest start; gap of 10 min between consecutive work blocks; never split a block across a busy slot. Light items (blocks <= 30 min) prefer low energy.
**IDs.** `Block.ID = hex(sha1(itemID|dayKey|seq))[:12]`. Output sorted by (Start, ID).
**Why strings** (exactly one non-empty sentence per block), e.g.: "Wednesday morning is a peak-energy window." / "Starting early so the last week stays light." / "A short refresher the day before keeps it fresh." / "Forced by the deadline: this day is over your usual goal." / "Routines sit where you asked them to."
**Invariants (property-tested over generated inputs):** no overlapping blocks; every block inside wake..sleep; no block overlaps an event; sum of placed work for an item + AtRisk.ShortMin = remaining; no day's work exceeds hard max; non-forced days never exceed capacity; deterministic (run twice, compare bytes); every block has non-empty Why; buffers respected.
**Drift:** `drifted = any block with End < now and Status=="planned"` OR new AtRisk appeared vs current OR overrun > 20 min.
**Replan:** compute the new plan with done blocks and accepted/pinned blocks fixed and skipped blocks released (their effort returns to `remaining`). Match old vs new FUTURE blocks by (ItemID, Seq). Diff kinds: `moved` (start differs), `shortened` (shorter), `dropped`, `added`, `atRisk` (new risk), `watch` (buffer to deadline fell below 1 day). Each Change has a plain one-sentence Reason ("Tonight already passes your 4 h goal.").
**applyChanges:** accepted changes are applied exactly, rejected ones keep the old block pinned. Re-validate; if an accepted change would overlap, skip it and report in `conflicts`. Keep the last 5 prior plans in history (store side) for undo within 24 h.
**Tests (table-driven; use now=2026-11-02T10:00+05:30 Asia/Kolkata unless noted):** deadline crunch; overloaded day forced + flagged; empty days; back-to-back exams; fixed event blocking the peak window; DST transition (America/New_York, 2026-11-01 fall back); skipped-block replan; partial acceptance; routine recurrence (weekly Days, Interval 2, Until); a 12h exam 10 days out at 240 min/day yields blocks summing to 720, none within 12 h of the exam, a refresher on each of the last 2 eligible days, none over 240 min/day.

## 7. Quick-add parser (internal/parse)
Rule-based, deterministic. Recognises: item-type words (exam, test, quiz = exam; assignment, due, homework, essay = assignment; project = project; every/daily/each + night|morning|day = routine; time/date with no type word = event), durations (`12h`, `90m`, `2 hours`, `want 12h prep`), dates (`nov 20`, `20 nov`, `tomorrow`, `today`, weekday names = next occurrence STRICTLY after today unless "today"), times (`4pm`, `16:00`), recurrence (every day/night/morning, every mon/tue.., weekdays), anchors (`morning`, `after shower`, `before bed`, `with food` become Detail). Defaults: exam time 09:00, due time 23:59, event length 60 min, assignment effort 60 min, exam effort 240 min, routine duration 2 min. Unparseable input returns confidence "low" with the raw text as title; never errors. Cases (now = Mon 2026-11-02T10:00 Asia/Kolkata):
| input | expected |
|---|---|
| chem exam Nov 20, want 12h prep | exam, "Chem exam", Start 2026-11-20T09:00, effort 720, doodle flask |
| stats assignment due fri 3h | assignment, "Stats assignment", Due 2026-11-06T23:59, effort 180, doodle laptop |
| cream every night after shower | routine, "Cream", anchor evening, daily, detail "after shower", doodle cream |
| vitamin d morning with food | routine, "Vitamin D", anchor morning, daily, detail "with food", doodle sun |
| dentist tomorrow 4pm | event, "Dentist", 2026-11-03T16:00 to 17:00 |
| read ch 4 due thu | assignment, "Read ch 4", Due 2026-11-05T23:59, effort 60, doodle book |
| project report due nov 30 10h | project, "Project report", Due 2026-11-30T23:59, effort 600 |

## 8. Doodle matcher (internal/doodle)
Lowercase the title. For each doodle, for each keyword matched as a whole word/phrase, add `len(keyword)`. Highest total wins; ties break alphabetically by doodle name. Zero score falls back by type: exam=book, assignment=laptop, project=laptop, event=clock, routine=sparkle. User-chosen doodles (`DoodleSource:"user"`) are never overridden. Tests: "vitamin d3"=sun, "chem lab"=flask, "wind down"=moon, "gym"=dumbbell, "wake up"=clock, "face moisturiser"=cream, "xyzzy" routine=sparkle, "meds"=pill.

## 9. Calendar (internal/ics)
**Import:** RFC 5545 subset: VEVENT with DTSTART/DTEND (UTC `Z`, `TZID=` zones, floating, all-day `VALUE=DATE`), DURATION, SUMMARY, LOCATION, RRULE (FREQ DAILY|WEEKLY, INTERVAL, BYDAY, COUNT, UNTIL), EXDATE, line unfolding, escaped text. Expand recurrences into individual `event` Items (shared SeriesID) for `horizonDays` (default 120) from `now`. Unsupported constructs go to `skipped` with a reason, never an error. Doodle via matcher. **Export:** CRLF line endings, fold at 75 octets, stable `UID:<id>@arc`, DTSTAMP, escape `, ; \ newline`. Routines export as recurring VEVENTs (RRULE) with `BEGIN:VALARM / ACTION:DISPLAY / TRIGGER:PT0S / DESCRIPTION:<title>` so the phone's Calendar notifies. Fixed events export as VEVENTs; optional work blocks export as VEVENTs. Tests: a sample university timetable (weekly lectures with TZID=Asia/Kolkata and an EXDATE), all-day events, folded lines, export then import round-trip equality, byte-exact CRLF and folding.
**In the app:** Settings, "Import timetable (.ics)" file input (`accept=".ics,text/calendar"`) with a preview list before confirming; "Export routines / events / plan (.ics)" uses `navigator.share({files})` when available, else a Blob download link; both paths must work in installed iOS PWAs and Windows Edge/Chrome. Provide a clear in-app note on how to open the file in Calendar.

## 10. Frontend architecture
- ES modules, no bundler. `main.js` boots: register SW, load wasm (`WebAssembly.instantiateStreaming` with an ArrayBuffer fallback when the MIME is wrong), run `new Go().run(instance)`, await `arcReady`, open IndexedDB, load state, render. Show a gentle loading doodle during boot.
- State: a small store (`state.js`) holding items, profile, plan, UI state; actions mutate IndexedDB then call `arc.plan`/`arc.replan` and re-render. Rendering is plain DOM (template functions + event delegation); no frameworks.
- Router: hash routes `#/today #/routines #/horizon #/review #/settings #/guided/<group>`; sheets (editor, quick add, picker) are overlays with focus trapping and Esc to close.
- IndexedDB `arc` v1: stores `items`(id), `blocks`(id, index `day`), `profile`(key), `routineLog`(key [day,itemId]), `history`(autoIncrement; snapshots for undo), `postcards`(day), `meta`(key). Include `migrate(oldVersion)`; schemaVersion in meta. Call `navigator.storage.persist()` after first use. Handle IndexedDB unavailable (private mode): run in memory and show a gentle banner.
- Export/Import: single JSON `{version, exportedAt, items, profile, blocks, routineLog, postcards, meta}`; import validates, previews counts, then replaces after confirmation. Never auto-overwrite.
- `?add=<text>` deep link: parse via quick add, open the quick-add sheet pre-filled (do not auto-save), then strip the param from the URL.
- Service worker (`sw.template.js`): precache the full file list under cache name `arc-__VERSION__`; fetch handler: navigation requests = network-first falling back to cached `index.html`/`offline.html`; same-origin GET = cache-first with background update; never cache non-GET or cross-origin. New SW waits (no auto skipWaiting); the page shows "A new version is ready, tap to refresh", which posts `SKIP_WAITING`, then reload on `controllerchange`. Delete old caches on activate.
- iOS/PWA meta in index.html: `viewport-fit=cover`, `apple-mobile-web-app-capable=yes`, `apple-mobile-web-app-status-bar-style=black-translucent`, `apple-mobile-web-app-title`, apple-touch-icon, `theme-color #000000`. Use `100dvh`, `env(safe-area-inset-*)`, inputs >= 16px font to prevent iOS zoom, `touch-action` set on swipe/drag surfaces, Pointer Events (no hover reliance).
- Sound (off by default, toggle in Settings): tiny WebAudio-synthesized pop and pencil-scratch, no audio files. Respect `prefers-reduced-motion` (replace motion with fades) and keep sound off by default.

## 11. Design system
**Tokens (css/tokens.css):** `--bg:#000000; --text:#F0EFEF; --muted:#A8A8B0; --vanilla:#FFF7E6; --blush:#F7C8D3; --sage:#A6B58A; --mist:#A9B7C6; --teal:#7CBB93; --navajo:#FDDEB2; --bubblegum:#FF84A2; --platinum:#F0EFEF; --ice:#B3D7F2; --rosewood:#B46A72; --lagoon:#2D3A47; --ink:#111111`. Roles: exam=bubblegum, assignment=ice, project=mist, event=platinum outline, routine groups morning=navajo / daytime=vanilla / evening=blush, success=teal, overload/warn=rosewood or navajo (never red), now-marker and primary buttons=vanilla. Radii 24-32 for cards/tiles, 999 for pills. Type: Fredoka 400/500/600 bundled as woff2 (download from the google/fonts repo; if offline use `ui-rounded, "SF Pro Rounded", system-ui` and note it in DECISIONS.md).
**Two visual languages:** routine/grunt tiles = solid pastel with `--ink` doodle; deadline items = black fill, 2px pastel stroke, pastel doodle.
**Doodle rendering (`js/doodle.js`):** `doodleSVG(name, size, color)` returns an inline `<svg viewBox="0 0 64 64" width=size height=size fill="none" stroke=color stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` with `w = max(1.7, round(64/size*1.5, 1))`; `main` path at width w; `thick` at round(w*1.9,1) with opacity .85; `fine` at round(w*.55,1); `dots` at round(w*1.7,1); skip empty layers. Match the `d()` output in the mockups exactly. Doodles have no faces; never alter paths.
**Arc geometry (`js/arc.js`):** the mockups' arc is static; the real one is generated. x maps linearly from WakeMin..SleepMin to 10..350 of a 358x200 viewBox. y(x) is derived from the profile's energy windows (high=50, med=110, low=170) smoothed with a smoothstep blend of ~40 minutes at boundaries, sampled every 10 minutes, then drawn as a smooth cubic path (Catmull-Rom to Bezier). Nodes are placed at their block's midpoint time with y sampled from the same function, so nodes always sit exactly on the curve. Past portion of the curve is butter/vanilla solid; future is dotted muted. "Now" marker = outline ring with dashed halo and a gentle bob. Node size radius = clamp(8 + minutes/6, 8, 24). Tap expands in place; dragging a node snaps to 5-minute times, asks `arc.plan` for conflicts, and previews a conflict as a Rosewood outline pulse before committing.
**Motion:** tile press squish (scale .96, 120ms); completion = stamped check with bounce (260ms) + doodle wiggle (rotate +/-6deg, 400ms); node movement eases 300ms; focus card swipe follows the pointer with a spring-back below 40% threshold. All guarded by `prefers-reduced-motion`.
**Copy bank (`js/copy.js`):** warm and quirky, never guilt: e.g. "Pill bottle: opened. You: a legend." / "Cream: applied. Skin: thrilled." / "Your day got interesting. Want a new plan?" / "Sleeping in until tomorrow." / "Nothing on right now. Breathe." / "Tucked in. Good day's work." Include 3+ variants per moment and pick deterministically by day to avoid flicker. Empty states are cute, not blank.
**Accessibility:** AA contrast, 44px minimum targets, ARIA labels/roles, every swipe/drag has a button or keyboard alternative (Enter/Space/Arrow keys), visible focus ring in vanilla, screen-reader live region for completions and sync/plan messages.

## 12. Screens (interactive versions of the mockups; match them)
1. **Today** (01-today): header date + title, drift pill (only when drifted) -> Review, the Arc, Focus Card, bottom nav (Today, Routines, big + , Horizon). Focus Card shows the current block (start <= now < end) else the next one; if none, an "Nothing on right now. Breathe." state with the next item. Swipe right = finish (adds block minutes to the item's DoneMin, status done), swipe left = snooze 15 min (moves block, re-plans), swipe up or "skip" button = skip (to the sleeping-in shelf). Timer is a real countdown with pause; it survives reloads using timestamps. End-of-day pill "Tuck in" appears from SleepMin-90 on (and always from the Settings > Postcards archive).
2. **Routines** (02): week strip (7 circles fill with fraction of that day's routine blocks done; today ringed), groups Morning/Daytime/Evening with Play buttons, 3-column pastel tiles, stamped check on done, tap = quick edit sheet, long-press/drag to reorder (also move up/down buttons in the editor), "Sleeping in" shelf row if any skipped.
3. **Guided routine** (03): step through a group, big tilted tile with doodle, detail text, optional timer, progress dots, big done button, "Sleep on this one" skip, completion celebration at the end.
4. **Review plan** (04): shown from the drift pill. Thread of Changes (doodle, title, before to after, reason), per-change Accept/Skip (Accept pre-selected), "Approve all N", "Reject all", undo note. Approving calls `applyChanges`, shows conflicts gently, and offers "Undo" for 24 h.
5. **Horizon** (05): 14-21 days of capsules (height = scheduled minutes / ambition), dashed goal line, capsules above goal in Navajo/Rosewood family, deadline flags with doodles and names, "heaviest stretch" insight with "Preview the earlier start" (runs `arc.plan` with a hypothetical StartBy and shows the flattened capsules before confirm).
6. **Quick add** (bottom sheet): one text field (>= 16px), live parse preview as editable chips + doodle preview, Save. Plus a "Fill in a form" fallback.
7. **Item editor** (bottom sheet): type-specific fields, doodle button -> picker, delete (soft delete), effort steppers.
8. **Doodle picker**: searchable grid of the 16 doodles (name + keywords), selecting sets `DoodleSource:"user"`; "Auto" button resets.
9. **Settings**: profile (wake/sleep, daily ambition with per-day override "light day/push day", energy windows editor with 3 levels), timetable import (.ics), exports (.ics), backup export/import (JSON), sound toggle, logo choice (A/B/C changes the in-app mark; note that the home-screen icon changes via `go run ./tools/build -logo X`), "Load sample data", "Erase everything" (typed confirmation), Postcards archive, About (version from `arc.version()`, link to repo).
10. **Onboarding** (first run, 3 gentle steps): wake/sleep -> energy windows (tap to cycle levels) -> daily goal; then offer "Load sample data" or "Start empty". Skippable.
11. **Tuck-in postcard**: 390x520 portrait black card with 2px pastel border, date stamp, finished items' doodles scattered with slight rotation (positions from `arc.postcard` seeded by the day key so the same day always renders the same), a hand-lettered summary line from templates ("3 blocks of Chem, 1 hero cream moment."), a "Tucked in" stamp. Rendered as SVG, rasterized to PNG via canvas for Save/Share (`navigator.share` with a file else download), stored in `postcards`.
**Sample data (`web/data/sample.json`):** reproduce the mockups: today Tue 3 Nov: Lecture (fixed 11:00-12:00 style), Meds, Chem PS4 (assignment, due Fri 6 Nov), Stats exam (Thu 12 Nov, 12h prep), Project report (due Mon 16 Nov, 10h), Cream (evening), plus morning group Wake up / Make bed / Meds, daytime Water / Lunch / Study, evening Face cream / Wind down / Plan tomorrow. Dates are relative to "today" at load time.
**Layout:** mobile-first 390px exactly like the mockups; desktop >= 900px uses a two-column layout in the same style (Arc + focus card on one side, tiles/horizon on the other); never a stretched phone.

## 13. Logo and name (changeable)
`arc.config.json` holds `name`, `shortName`, `logo` (A|B|C), colors. The build tool copies `reference/logos/<logo>/` icons into dist and renders manifest/title from the config. In-app mark = inline `mark.svg` (color currentColor). Changing the logo or name never requires code edits, only config + rebuild. Document this in README.

## 14. Acceptance checklist per milestone (do not proceed until green)
- **M0:** `go run ./tools/build` produces dist with arc.wasm, wasm_exec.js, manifest, sw.js, icons; `go run ./tools/dev` serves it; CI skeleton present.
- **M1:** `go vet ./...` and `go test ./...` pass; `GOOS=js GOARCH=wasm go vet ./cmd/arc-wasm` passes; all invariant, planner, parser, matcher, ics and postcard tests exist and pass; a coverage report is printed.
- **M2:** headless Chromium loads dist, wasm initialises, `arc.version()` works, IndexedDB read/write works, app shell loads offline (verified by going offline in Playwright), SW update banner works.
- **M3-M5:** every screen exists, is interactive, and matches the mockups: palette, doodles, spacing, arc, tiles, capsules. Screenshots at 390x844 and 1280x800 for each screen are saved in `tools/e2e/shots/` and compared against `reference/mockups/*.png`; list and fix visible differences. Flows verified end-to-end: quick add -> plan -> complete -> skip -> drift -> review -> approve -> undo; routine guided flow; ICS import then export; backup export then import; postcard save.
- **M6:** deployed to GitHub Pages; the live URL loads, installs, works offline; README complete.
- Quality gates: no console errors; no requests to any other origin (assert in Playwright); Lighthouse-style checks for manifest/installability done manually via DevTools protocol or documented.

## 15. GitHub (M6) and sharing
- `.github/workflows/pages.yml`:
```yaml
name: Deploy Pages
on: { push: { branches: [main] }, workflow_dispatch: {} }
permissions: { contents: read, pages: write, id-token: write }
concurrency: { group: pages, cancel-in-progress: true }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version-file: go.mod }
      - run: go vet ./... && go test ./...
      - run: GOOS=js GOARCH=wasm go vet ./cmd/arc-wasm
      - run: go run ./tools/build
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: "${{ steps.deployment.outputs.page_url }}" }
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```
(If you know newer major versions of these actions, use them; do not invent versions.) `ci.yml` runs vet/test on pull requests. `release.yml` (tags `v*`) builds `cmd/arc-server` for windows/amd64, darwin/arm64, linux/amd64 once M7 exists.
- Everything must work on forks and under any repo name: no hardcoded owner/repo anywhere; all asset URLs relative; module name `arc`.
- Create the repo: `gh repo create arc-planner --public --source=. --remote=origin --push`; mark as template: `gh repo edit --template`; enable Pages: `gh api -X POST repos/{owner}/{repo}/pages -f build_type=workflow` (if it already exists, use `-X PUT`); watch the run (`gh run watch`); print the live URL `https://<owner>.github.io/arc-planner/`. If `gh` is unavailable, write these exact commands into README under "Publish" and tell the user.
- Public repo is expected (Pages on private repos needs a paid plan). The repo contains no personal data; the user's data lives only in their browser.
- README must contain: what Arc is (with a mockup PNG), live URL, "Install on iPhone" (Safari > Share > Add to Home Screen) and "Install on Windows" (Edge/Chrome > Install app), "Back up your data", "Use your own copy" (Use this template / fork, then Settings > Pages > Source: GitHub Actions, or run `gh api` command), "Run locally" (`go run ./tools/dev`), "Change the name/logo" (`arc.config.json`, `go run ./tools/build -logo C`), Go package tour for a Go learner, privacy statement, known limitations (no push notifications; use .ics export alarms; iOS may evict storage for non-installed sites; data is per device unless sync is enabled).

## 16. M7 (stretch, only after v1.0.0 is tagged and live): optional sync server
`cmd/arc-server`: net/http (Go 1.22 routing), `go:embed` of dist, `modernc.org/sqlite` (no CGO), `/api/sync` with a bearer token from env `ARC_TOKEN`/flag, merge by `updatedAt` last-write-wins per item, tombstones for deletes. The app Settings gets server URL + token, an offline change queue and a visible sync status. App stays 100% usable without it. Document `tailscale serve` for HTTPS to the iPhone.

## 17. Known pitfalls (avoid these)
wasm_exec.js version must match the Go toolchain; serve .wasm as `application/wasm`; absolute URLs break on GitHub Pages sub-paths; the service worker scope must be `./`; do not cache `sw.js` itself in a way that blocks updates; Safari `100vh` bug (use dvh); iOS zooms inputs below 16px; `navigator.vibrate` does not exist on iOS (guard); Web Push is out of scope; `time.LoadLocation` needs `time/tzdata` in WASM; never use map iteration order for output; never call `time.Now()` in core; do not store derived plan blocks as the only source of truth for done state (done/skip state lives on blocks AND item DoneMin, kept consistent in one `completeBlock` action with a test); guard against double-fire of swipe completion; make drag handlers cancel on pointercancel; keep wasm size reasonable (strip, no heavy dependencies); GitHub Pages serves with gzip automatically.

## 18. Final report (your last message)
Live URL; what you verified (commands + results); every decision/assumption (also in `DECISIONS.md`); known gaps; exactly how to install on iPhone and Windows; how to change logo/name; how to publish a fork.
