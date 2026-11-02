# Reference pack for Arc

- `SPEC.md`: the authoritative build specification (architecture, schemas, algorithms, screens, tests, CI, pitfalls). Read it fully before coding.
- `mockups/*.html` + `*.png`: the approved design, one phone screen per file (390x844; doodle sheet 780x640; logos 780x520). SOURCE OF TRUTH for colors, spacing, type and layout. Read the HTML/CSS/inline SVG directly. PNG previews use a fallback font because Fredoka could not load offline; the real app bundles Fredoka.
- `doodles/doodles.json`: 16 hand-drawn doodles as path data on a 64x64 grid (`main`, `thick`, `fine`, `dots`). `doodles/doodle-keywords.json`: keywords for the matcher. `doodles/doodles.svg`: sprite for preview only.
- `logos/{A,B,C}/`: three logo options with ready icon PNGs and SVGs. B is the default (set in `arc.config.json`).
- `inspiration/`: mood references (Dawn, Play Your Routine, hand-drawn doodle style boards, color palettes). Use for feel, not to copy.
