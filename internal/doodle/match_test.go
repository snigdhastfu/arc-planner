package doodle

import (
	"testing"

	"arc/internal/model"
)

func TestMatch(t *testing.T) {
	cases := []struct{ title, typ, want string }{
		{"vitamin d3", model.TypeRoutine, "sun"},
		{"chem lab", model.TypeAssignment, "flask"},
		{"wind down", model.TypeRoutine, "moon"},
		{"gym", model.TypeRoutine, "dumbbell"},
		{"wake up", model.TypeRoutine, "clock"},
		{"face moisturiser", model.TypeRoutine, "cream"},
		{"xyzzy", model.TypeRoutine, "sparkle"},
		{"meds", model.TypeRoutine, "pill"},
		{"Make bed", model.TypeRoutine, "bed"},
		{"Lunch", model.TypeRoutine, "apple"},
		{"Drink water", model.TypeRoutine, "water"},
		{"xyzzy", model.TypeExam, "book"},
		{"xyzzy", model.TypeAssignment, "laptop"},
		{"xyzzy", model.TypeProject, "laptop"},
		{"xyzzy", model.TypeEvent, "clock"},
		{"chemistry", model.TypeExam, "flask"},    // "chem" must not match inside "chemistry"... but chemistry itself does
		{"breadth", model.TypeRoutine, "sparkle"}, // "read" inside a word does not count
		{"MEDS!!", model.TypeRoutine, "pill"},     // punctuation is a boundary
		{"night skincare", model.TypeRoutine, "cream"},
		{"shower", model.TypeRoutine, "water"},
		{"brush teeth", model.TypeRoutine, "sparkle"},
		{"take vitamins", model.TypeRoutine, "pill"},
		{"stretching", model.TypeRoutine, "dumbbell"},
	}
	for _, c := range cases {
		if got := Match(c.title, c.typ); got != c.want {
			t.Errorf("Match(%q,%q)=%q want %q", c.title, c.typ, got, c.want)
		}
	}
}

func TestTieBreakAlphabetical(t *testing.T) {
	// "chem exam": flask(chem=4) vs book(exam=4) -> book wins alphabetically.
	if got := Match("chem exam", model.TypeExam); got != "book" {
		t.Fatalf("tie break: got %q", got)
	}
}

func TestResolveUserWins(t *testing.T) {
	it := model.Item{Title: "gym", Type: model.TypeRoutine, Doodle: "moon", DoodleSource: "user"}
	if got := Resolve(it); got != "moon" {
		t.Fatalf("user doodle overridden: %q", got)
	}
	it.DoodleSource = "auto"
	if got := Resolve(it); got != "dumbbell" {
		t.Fatalf("auto: %q", got)
	}
}

func TestNames(t *testing.T) {
	if n := len(Names()); n != 16 {
		t.Fatalf("want 16 doodles, got %d", n)
	}
}
