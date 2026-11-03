// Package doodle picks one of the 16 reference doodles for an item title.
package doodle

import (
	_ "embed"
	"encoding/json"
	"sort"
	"strings"
	"unicode"

	"arc/internal/model"
)

//go:embed keywords.json
var keywordsJSON []byte

var (
	keywords map[string][]string
	names    []string // sorted doodle names
)

func init() {
	if err := json.Unmarshal(keywordsJSON, &keywords); err != nil {
		panic("doodle: bad keywords.json: " + err.Error())
	}
	for n := range keywords {
		names = append(names, n)
	}
	sort.Strings(names)
}

// Names returns all doodle names, sorted.
func Names() []string { return append([]string(nil), names...) }

// Valid reports whether name is a known doodle.
func Valid(name string) bool { _, ok := keywords[name]; return ok }

// Fallback returns the default doodle for an item type.
func Fallback(typ string) string {
	switch typ {
	case model.TypeExam:
		return "book"
	case model.TypeAssignment, model.TypeProject:
		return "laptop"
	case model.TypeEvent:
		return "clock"
	case model.TypeRoutine:
		return "sparkle"
	default:
		return "sparkle"
	}
}

// Score returns the best keyword-matching doodle and its score (0 if none).
// Each keyword that appears as a whole word/phrase adds len(keyword).
// Word boundaries are any non-letter characters. Ties break alphabetically.
func Score(title string) (string, int) {
	t := strings.ToLower(title)
	best, bestScore := "", 0
	for _, n := range names { // sorted, so the first max wins ties
		s := 0
		for _, k := range keywords[n] {
			if containsWord(t, k) {
				s += len(k)
			}
		}
		if s > bestScore {
			best, bestScore = n, s
		}
	}
	return best, bestScore
}

// Match returns the doodle for a title, falling back by item type.
func Match(title, typ string) string {
	if n, s := Score(title); s > 0 {
		return n
	}
	return Fallback(typ)
}

// Resolve keeps a user-chosen doodle, otherwise matches automatically.
func Resolve(it model.Item) string {
	if it.DoodleSource == "user" && Valid(it.Doodle) {
		return it.Doodle
	}
	return Match(it.Title, it.Type)
}

func containsWord(s, w string) bool {
	for i := 0; ; {
		j := strings.Index(s[i:], w)
		if j < 0 {
			return false
		}
		start, end := i+j, i+j+len(w)
		if isBoundary(s, start-1) && isBoundary(s, end) {
			return true
		}
		i = start + 1
	}
}

func isBoundary(s string, i int) bool {
	if i < 0 || i >= len(s) {
		return true
	}
	return !unicode.IsLetter(rune(s[i]))
}
