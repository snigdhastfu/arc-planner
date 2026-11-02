// Package postcard composes the end-of-day "Tuck in" postcard: which doodle
// stickers go where on a 390x520 card, and a warm one-line summary.
// It is pure and deterministic: identical requests give identical results.
package postcard

import (
	"fmt"
	"hash/fnv"
	"math"
	"sort"
	"strings"
	"time"
	"unicode"

	"arc/internal/doodle"
	"arc/internal/model"
)

// Request is the input to Compose.
type Request struct {
	Day    string        `json:"day"`
	Blocks []model.Block `json:"blocks"`
	Items  []model.Item  `json:"items"`
	Seed   string        `json:"seed"`
}

// Sticker is one doodle placed on the card. X and Y are the center.
type Sticker struct {
	Doodle string  `json:"doodle"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Rot    float64 `json:"rot"`
	Scale  float64 `json:"scale"`
	Color  string  `json:"color"`
	Label  string  `json:"label"`
}

// Result is the composed postcard.
type Result struct {
	Summary  string    `json:"summary"`
	Stickers []Sticker `json:"stickers"`
	Done     int       `json:"done"`
	Sleeping int       `json:"sleeping"`
}

// Card geometry and sticker limits.
const (
	CardW       = 390
	CardH       = 520
	MinX, MaxX  = 40.0, 350.0
	MinY, MaxY  = 110.0, 400.0
	MaxStickers = 12
	MinDist     = 70.0
	maxTries    = 40
	maxRot      = 14.0
	minScale    = 0.85
	maxScale    = 1.15
	maxSummary  = 90
)

var quietLines = []string{
	"A quiet day. Those count too.",
	"Rest is part of the plan.",
	"Tomorrow's a fresh page.",
	"A soft day. You showed up for yourself.",
	"Slow days help the fast ones.",
}

const sleepingLine = " A few things are sleeping in."

// group collects the done blocks of one item on the day.
type group struct {
	item  model.Item
	n     int
	first time.Time
	start string
}

// Compose builds the postcard for req.Day.
func Compose(req Request) (Result, error) {
	if _, err := time.Parse("2006-01-02", req.Day); err != nil || len(req.Day) != 10 {
		return Result{}, model.Errf("bad_day", "bad day %q (want YYYY-MM-DD)", req.Day)
	}
	items := make(map[string]model.Item, len(req.Items))
	for _, it := range req.Items {
		if _, dup := items[it.ID]; !dup {
			items[it.ID] = it
		}
	}

	res := Result{Stickers: []Sticker{}}
	groups := map[string]*group{}
	for _, b := range req.Blocks {
		if len(b.Start) < 10 || b.Start[:10] != req.Day {
			continue
		}
		switch b.Status {
		case model.StatusSkipped:
			res.Sleeping++
		case model.StatusDone:
			it, ok := items[b.ItemID]
			if !ok {
				continue
			}
			res.Done++
			t := model.MustTime(b.Start)
			g := groups[it.ID]
			if g == nil {
				groups[it.ID] = &group{item: it, n: 1, first: t, start: b.Start}
				continue
			}
			g.n++
			if t.Before(g.first) {
				g.first, g.start = t, b.Start
			}
		}
	}

	ordered := make([]*group, 0, len(groups))
	for _, g := range groups {
		ordered = append(ordered, g)
	}
	sort.Slice(ordered, func(i, j int) bool {
		a, b := ordered[i], ordered[j]
		if !a.first.Equal(b.first) {
			return a.first.Before(b.first)
		}
		if a.start != b.start {
			return a.start < b.start
		}
		return a.item.ID < b.item.ID
	})

	res.Stickers = place(ordered, req.Seed+"|"+req.Day)
	res.Summary = summary(ordered, req.Day, res.Sleeping)
	return res, nil
}

func doodleFor(it model.Item) string {
	if it.Doodle != "" {
		return it.Doodle
	}
	return doodle.Match(it.Title, it.Type)
}

func colorFor(it model.Item) string {
	switch it.Type {
	case model.TypeExam:
		return "#FF84A2"
	case model.TypeAssignment:
		return "#B3D7F2"
	case model.TypeProject:
		return "#A9B7C6"
	case model.TypeEvent:
		return "#F0EFEF"
	case model.TypeRoutine:
		if it.Routine != nil {
			switch it.Routine.Group {
			case "morning":
				return "#FDDEB2"
			case "daytime":
				return "#FFF7E6"
			case "evening":
				return "#F7C8D3"
			}
		}
	}
	return "#A6B58A"
}

// rng is a splitmix64 generator.
type rng struct{ s uint64 }

func (r *rng) next() uint64 {
	r.s += 0x9E3779B97F4A7C15
	z := r.s
	z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9
	z = (z ^ (z >> 27)) * 0x94D049BB133111EB
	return z ^ (z >> 31)
}

// float returns a value in [0, 1).
func (r *rng) float() float64 { return float64(r.next()>>11) / (1 << 53) }

func (r *rng) between(lo, hi float64) float64 { return lo + (hi-lo)*r.float() }

func hash64(s string) uint64 {
	h := fnv.New64a()
	h.Write([]byte(s))
	return h.Sum64()
}

// round snaps v to 1/scale (scale 10 -> 0.1, 100 -> 0.01) so JSON is stable.
func round(v, scale float64) float64 { return math.Round(v*scale) / scale }

func place(groups []*group, seed string) []Sticker {
	r := &rng{s: hash64(seed)}
	out := []Sticker{}
	for _, g := range groups {
		if len(out) == MaxStickers {
			break
		}
		var x, y float64
		for try := 0; try < maxTries; try++ {
			x = round(r.between(MinX, MaxX), 10)
			y = round(r.between(MinY, MaxY), 10)
			if farEnough(out, x, y) {
				break
			}
		}
		out = append(out, Sticker{
			Doodle: doodleFor(g.item),
			X:      x,
			Y:      y,
			Rot:    round(r.between(-maxRot, maxRot), 100),
			Scale:  round(r.between(minScale, maxScale), 100),
			Color:  colorFor(g.item),
			Label:  g.item.Title,
		})
	}
	return out
}

func farEnough(placed []Sticker, x, y float64) bool {
	for _, s := range placed {
		if math.Hypot(s.X-x, s.Y-y) < MinDist {
			return false
		}
	}
	return true
}

// shortName is the first word of a title, trimmed of edge punctuation.
func shortName(title string) string {
	f := strings.Fields(title)
	if len(f) == 0 {
		return "focus"
	}
	w := strings.TrimFunc(f[0], func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
	if w == "" {
		return f[0]
	}
	return w
}

func plural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf(one, n)
	}
	return fmt.Sprintf(many, n)
}

// routinePhrase returns a fun phrase for n done blocks of a routine with
// the given doodle; ok is false when the doodle has no special phrase.
func routinePhrase(d string, n int) (string, bool) {
	switch d {
	case "cream":
		return plural(n, "%d hero cream moment", "%d hero cream moments"), true
	case "pill":
		return "meds: handled", true
	case "water":
		return "hydration achieved", true
	case "bed":
		return "a bed made with style", true
	case "mug":
		return "a cozy cup moment", true
	case "apple":
		return "snack: secured", true
	case "plant":
		return "plants: thriving", true
	case "dumbbell":
		return "muscles: moved", true
	case "moon":
		return "a gentle wind-down", true
	case "sun":
		return "morning: greeted", true
	}
	return "", false
}

func summary(groups []*group, day string, sleeping int) string {
	var line string
	if len(groups) == 0 {
		line = quietLines[hash64(day)%uint64(len(quietLines))]
	} else {
		line = doneLine(groups)
	}
	if sleeping > 0 {
		line += sleepingLine
	}
	return line
}

func doneLine(groups []*group) string {
	type part struct {
		key  string
		n    int
		text func(n int) string
	}
	var parts []*part
	idx := map[string]*part{}
	add := func(key string, n int, text func(int) string) {
		if p, ok := idx[key]; ok {
			p.n += n
			return
		}
		p := &part{key: key, n: n, text: text}
		idx[key] = p
		parts = append(parts, p)
	}
	for _, g := range groups {
		it := g.item
		switch {
		case it.IsWork():
			name := shortName(it.Title)
			add("work:"+name, g.n, func(n int) string {
				return plural(n, "%d block of "+escape(name), "%d blocks of "+escape(name))
			})
		case it.Type == model.TypeEvent:
			name := shortName(it.Title)
			add("event:"+name, g.n, func(int) string { return "showed up for " + name })
		default:
			d := doodleFor(it)
			if _, ok := routinePhrase(d, 1); ok {
				add("routine:"+d, g.n, func(n int) string { s, _ := routinePhrase(d, n); return s })
			} else {
				add("routine:*", g.n, func(n int) string {
					return plural(n, "%d tiny routine win", "%d tiny routine wins")
				})
			}
		}
	}
	texts := make([]string, len(parts))
	for i, p := range parts {
		texts[i] = p.text(p.n)
	}
	line := strings.Join(texts, ", ") + "."
	if len([]rune(line)) > maxSummary && len(texts) > 2 {
		line = texts[0] + ", " + texts[1] + " and more."
	}
	return line
}

// escape protects user text from being read as a format verb.
func escape(s string) string { return strings.ReplaceAll(s, "%", "%%") }
