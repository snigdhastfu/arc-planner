# Decisions and assumptions

Each entry: what was decided and why. Newest at the bottom.

1. **Go toolchain.** Go 1.27.3 was found at `~/.local/go` (not on PATH). SPEC section 2 asks for Go >= 1.24, so it is used as is. `go.mod` says `go 1.24` so CI (`setup-go` with `go-version-file`) and forks can use any toolchain from 1.24 up.
2. **`gh` missing.** The GitHub CLI is not installed on the build machine. Everything else is finished, and the exact publish commands are in README "Publish" and the final report (SPEC section 15).
3. **Fredoka.** Downloaded the variable `Fredoka[wdth,wght].ttf` from google/fonts, then instanced it to static 400/500/600 at width 100 and subset it to Latin + Latin-1 + Latin Extended-A + a few symbols (arrows, middle dot, ellipsis), saved as woff2 (about 15 KB each) with fontTools. OFL.txt is bundled next to the fonts.
4. **Text colour.** The mockups use `#F4F1EA` for body text, but the fixed palette has Platinum `#F0EFEF` and SPEC tokens say `--text:#F0EFEF`. The palette wins. The difference is invisible on black.
5. **Playwright.** `playwright-core` only (no browser download), pointed at the system Chrome. It lives in `tools/e2e/package.json` and is never imported by the app.
6. **Doodle matcher word boundaries.** A "whole word" boundary is any non-letter character, so digits count as boundaries. That is what makes the SPEC case "vitamin d3" score `vitamin d` (sun, 9) above `vitamin` (pill, 7).
7. **Quick-add doodle matching.** "Chem exam" ties `chem` (flask, 4) with `exam` (book, 4), and alphabetical tie-breaking would pick book, but SPEC expects flask. The parser therefore matches on the title with the recognised type word removed ("chem"), falling back to the full title and then to the type default. The standalone matcher still follows SPEC section 8 exactly.
