package parse

import (
	"bytes"
	"encoding/json"
	"math/rand"
	"reflect"
	"strings"
	"testing"
	_ "time/tzdata"

	"arc/internal/model"
)

const (
	testNow = "2026-11-02T10:00:00+05:30" // a Monday
	testTZ  = "Asia/Kolkata"
)

func qa(t *testing.T, text string) Result {
	t.Helper()
	r, err := QuickAdd(Request{Text: text, Now: testNow, TZ: testTZ})
	if err != nil {
		t.Fatalf("%q: unexpected error %v", text, err)
	}
	return r
}

type want struct {
	typ, title, start, end, due, doodle, conf string
	effort                                    int
	anchor, detail, freq                      string
	days                                      []int
	atMin                                     int // -1 = must be nil
	durMin                                    int
}

func TestQuickAddTable(t *testing.T) {
	cases := []struct {
		in string
		w  want
	}{
		{"chem exam Nov 20, want 12h prep", want{typ: "exam", title: "Chem exam", start: "2026-11-20T09:00:00+05:30", effort: 720, doodle: "flask", conf: "high"}},
		{"stats assignment due fri 3h", want{typ: "assignment", title: "Stats assignment", due: "2026-11-06T23:59:00+05:30", effort: 180, doodle: "laptop", conf: "high"}},
		{"cream every night after shower", want{typ: "routine", title: "Cream", anchor: "evening", freq: "daily", detail: "after shower", doodle: "cream", conf: "high", atMin: -1, durMin: 2}},
		{"vitamin d morning with food", want{typ: "routine", title: "Vitamin D", anchor: "morning", freq: "daily", detail: "with food", doodle: "sun", conf: "high", atMin: -1, durMin: 2}},
		{"dentist tomorrow 4pm", want{typ: "event", title: "Dentist", start: "2026-11-03T16:00:00+05:30", end: "2026-11-03T17:00:00+05:30", doodle: "clock", conf: "high"}},
		{"read ch 4 due thu", want{typ: "assignment", title: "Read ch 4", due: "2026-11-05T23:59:00+05:30", effort: 60, doodle: "book", conf: "high"}},
		{"project report due nov 30 10h", want{typ: "project", title: "Project report", due: "2026-11-30T23:59:00+05:30", effort: 600, doodle: "laptop", conf: "high"}},
		// extra cases
		{"call mom mon 6pm", want{typ: "event", title: "Call mom", start: "2026-11-09T18:00:00+05:30", end: "2026-11-09T19:00:00+05:30", doodle: "clock", conf: "high"}},
		{"today 5pm gym", want{typ: "event", title: "Gym", start: "2026-11-02T17:00:00+05:30", end: "2026-11-02T18:00:00+05:30", doodle: "dumbbell", conf: "high"}},
		{"quiz friday", want{typ: "exam", title: "Quiz", start: "2026-11-06T09:00:00+05:30", effort: 240, doodle: "book", conf: "high"}},
		{"meds every weekday 8am", want{typ: "routine", title: "Meds", anchor: "time", freq: "weekly", days: []int{1, 2, 3, 4, 5}, atMin: 480, doodle: "pill", conf: "high", durMin: 2}},
		{"asdf qwer", want{typ: "event", title: "asdf qwer", doodle: "clock", conf: "low"}},
		{"", want{typ: "event", title: "", doodle: "clock", conf: "low"}},
		{"   \t ", want{typ: "event", title: "", doodle: "clock", conf: "low"}},
		{"history essay 20 nov", want{typ: "assignment", title: "History essay", due: "2026-11-20T23:59:00+05:30", effort: 60, doodle: "laptop", conf: "high"}},
		{"bio exam 2026-11-20 at 2pm 90m", want{typ: "exam", title: "Bio exam", start: "2026-11-20T14:00:00+05:30", effort: 90, doodle: "book", conf: "high"}},
		{"physics test oct 3", want{typ: "exam", title: "Physics test", start: "2027-10-03T09:00:00+05:30", effort: 240, doodle: "book", conf: "high"}},
		{"stretch every mon and wed before bed", want{typ: "routine", title: "Stretch", anchor: "evening", freq: "weekly", days: []int{1, 3}, detail: "before bed", doodle: "dumbbell", conf: "high", atMin: -1, durMin: 2}},
		{"walk weekends 15 min", want{typ: "routine", title: "Walk", anchor: "daytime", freq: "weekly", days: []int{0, 6}, doodle: "sun", conf: "high", atMin: -1, durMin: 15}},
		{"lunch with sam at 1", want{typ: "event", title: "Lunch with sam", start: "2026-11-02T13:00:00+05:30", end: "2026-11-02T14:00:00+05:30", doodle: "apple", conf: "high"}},
		{"standup 9:30", want{typ: "event", title: "Standup", start: "2026-11-03T09:30:00+05:30", end: "2026-11-03T10:30:00+05:30", doodle: "clock", conf: "high"}},
		{"party sat 8 pm for 2 hours", want{typ: "event", title: "Party sat", start: "2026-11-02T20:00:00+05:30", end: "2026-11-02T22:00:00+05:30", doodle: "sparkle", conf: "high"}},
		{"party on sat 20:00", want{typ: "event", title: "Party", start: "2026-11-07T20:00:00+05:30", end: "2026-11-07T21:00:00+05:30", doodle: "sparkle", conf: "high"}},
		{"dinner tomorrow evening", want{typ: "event", title: "Dinner", start: "2026-11-03T19:00:00+05:30", end: "2026-11-03T20:00:00+05:30", doodle: "apple", conf: "high"}},
		{"maths exam", want{typ: "exam", title: "Maths exam", effort: 240, doodle: "book", conf: "low"}},
		{"water plants daily", want{typ: "routine", title: "Water plants", anchor: "daytime", freq: "daily", doodle: "plant", conf: "high", atMin: -1, durMin: 2}},
		{"skincare at 22:00 nightly", want{typ: "routine", title: "Skincare", anchor: "time", freq: "daily", atMin: 1320, doodle: "cream", conf: "high", durMin: 2}},
	}
	for _, c := range cases {
		r := qa(t, c.in)
		it, w := r.Item, c.w
		check := func(field, got, exp string) {
			if got != exp {
				t.Errorf("%q: %s = %q, want %q", c.in, field, got, exp)
			}
		}
		check("type", it.Type, w.typ)
		check("title", it.Title, w.title)
		check("start", it.Start, w.start)
		check("end", it.End, w.end)
		check("due", it.Due, w.due)
		check("doodle", it.Doodle, w.doodle)
		check("confidence", r.Confidence, w.conf)
		check("doodleSource", it.DoodleSource, "auto")
		if it.EffortMin != w.effort {
			t.Errorf("%q: effort = %d, want %d", c.in, it.EffortMin, w.effort)
		}
		if !strings.HasPrefix(it.ID, "qa-") || len(it.ID) != 13 {
			t.Errorf("%q: bad id %q", c.in, it.ID)
		}
		if w.typ != "routine" {
			if it.Routine != nil {
				t.Errorf("%q: unexpected routine spec", c.in)
			}
			continue
		}
		rs := it.Routine
		if rs == nil {
			t.Fatalf("%q: missing routine spec", c.in)
		}
		check("anchor", rs.Anchor, w.anchor)
		check("detail", rs.Detail, w.detail)
		check("freq", rs.Recur.Freq, w.freq)
		if rs.Anchor != "time" {
			check("group", rs.Group, rs.Anchor)
		}
		if rs.DurMin != w.durMin {
			t.Errorf("%q: durMin = %d, want %d", c.in, rs.DurMin, w.durMin)
		}
		if w.freq == "daily" && rs.Recur.Interval != 1 {
			t.Errorf("%q: interval = %d", c.in, rs.Recur.Interval)
		}
		if !reflect.DeepEqual(rs.Recur.Days, w.days) {
			t.Errorf("%q: days = %v, want %v", c.in, rs.Recur.Days, w.days)
		}
		if w.atMin < 0 && rs.AtMin != nil {
			t.Errorf("%q: atMin = %d, want nil", c.in, *rs.AtMin)
		}
		if w.atMin >= 0 && (rs.AtMin == nil || *rs.AtMin != w.atMin) {
			t.Errorf("%q: atMin = %v, want %d", c.in, rs.AtMin, w.atMin)
		}
	}
}

func TestUnderstood(t *testing.T) {
	cases := map[string][]Understood{
		"chem exam Nov 20, want 12h prep": {
			{"type", "exam"}, {"title", "Chem exam"}, {"date", "Fri 20 Nov"}, {"time", "9am"}, {"effort", "12 h"}, {"doodle", "flask"},
		},
		"stats assignment due fri 3h": {
			{"type", "assignment"}, {"title", "Stats assignment"}, {"date", "Fri 6 Nov"}, {"time", "11:59pm"}, {"effort", "3 h"}, {"doodle", "laptop"},
		},
		"cream every night after shower": {
			{"type", "routine"}, {"title", "Cream"}, {"recur", "every night"}, {"anchor", "evening"}, {"detail", "after shower"}, {"doodle", "cream"},
		},
		"dentist tomorrow 4:30pm": {
			{"type", "event"}, {"title", "Dentist"}, {"date", "Tue 3 Nov"}, {"time", "4:30pm"}, {"duration", "1 h"}, {"doodle", "clock"},
		},
		"meds every weekday 8am": {
			{"type", "routine"}, {"title", "Meds"}, {"time", "8am"}, {"recur", "weekdays"}, {"anchor", "time"}, {"doodle", "pill"},
		},
		"asdf qwer": {{"title", "asdf qwer"}, {"doodle", "clock"}},
	}
	for in, exp := range cases {
		if got := qa(t, in).Understood; !reflect.DeepEqual(got, exp) {
			t.Errorf("%q: understood = %v, want %v", in, got, exp)
		}
	}
}

func TestRoutineGroupByHour(t *testing.T) {
	for in, g := range map[string]string{
		"meds 8am daily":   "morning",
		"meds 1pm daily":   "daytime",
		"meds 9pm daily":   "evening",
		"pill 17:00 daily": "evening",
	} {
		rs := qa(t, in).Item.Routine
		if rs == nil || rs.Anchor != "time" || rs.Group != g {
			t.Errorf("%q: routine = %+v, want group %s", in, rs, g)
		}
	}
}

func TestErrors(t *testing.T) {
	for _, r := range []Request{
		{Text: "x", Now: "", TZ: testTZ},
		{Text: "x", Now: "not a time", TZ: testTZ},
		{Text: "x", Now: testNow, TZ: "Mars/Olympus"},
	} {
		if _, err := QuickAdd(r); err == nil {
			t.Errorf("%+v: expected error", r)
		}
	}
	// Empty TZ defaults to UTC.
	r, err := QuickAdd(Request{Text: "gym tomorrow 7am", Now: "2026-11-02T10:00:00Z"})
	if err != nil || r.Item.Start != "2026-11-03T07:00:00Z" {
		t.Errorf("utc: %v %q", err, r.Item.Start)
	}
}

func TestDeterminism(t *testing.T) {
	for _, in := range []string{"chem exam Nov 20, want 12h prep", "asdf", "cream every night after shower"} {
		a, _ := json.Marshal(qa(t, in))
		b, _ := json.Marshal(qa(t, in))
		if !bytes.Equal(a, b) {
			t.Errorf("%q: not deterministic:\n%s\n%s", in, a, b)
		}
	}
	if qa(t, "a").Item.ID == qa(t, "b").Item.ID {
		t.Error("ids should differ for different text")
	}
}

func TestFuzzNoPanic(t *testing.T) {
	words := []string{
		"every", "each", "night", "morning", "mon", "sun", "sat", "due", "at", "on", "by", "next",
		"exam", "project", "essay", "4pm", "16:00", "99:99", "13pm", "0am", "12h", "1.5h", "0h",
		"999999999999h", "nov", "feb", "29", "31", "2026-02-30", "2028-02-29", "today", "tomorrow",
		"after", "shower", "with", "food", "and", "&", "other", "day", "want", "prep", ",", "—",
		"é", "日本", "a", "hour", "2", "hours", "1h30m", "20th", "of", "2027", "weekdays", "mondays",
		"noon", "tonight", "\x00", "\xff", "..", "'", "\"",
	}
	rng := rand.New(rand.NewSource(42))
	tzs := []string{testTZ, "", "America/New_York", "Pacific/Chatham"}
	for i := 0; i < 5000; i++ {
		n := rng.Intn(8)
		parts := make([]string, n)
		for j := range parts {
			if rng.Intn(5) == 0 {
				b := make([]byte, rng.Intn(6))
				rng.Read(b)
				parts[j] = string(b)
			} else {
				parts[j] = words[rng.Intn(len(words))]
			}
		}
		text := strings.Join(parts, " ")
		r, err := QuickAdd(Request{Text: text, Now: testNow, TZ: tzs[i%len(tzs)]})
		if err != nil {
			t.Fatalf("%q: error %v", text, err)
		}
		if r.Confidence != "high" && r.Confidence != "low" {
			t.Fatalf("%q: confidence %q", text, r.Confidence)
		}
		for _, s := range []string{r.Item.Start, r.Item.End, r.Item.Due} {
			if _, err := model.ParseTime(s); err != nil {
				t.Fatalf("%q: bad time %q", text, s)
			}
		}
	}
}
