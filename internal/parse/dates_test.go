package parse

import (
	"testing"
	"time"
)

func TestFormatting(t *testing.T) {
	for m, s := range map[int]string{0: "12am", 540: "9am", 720: "12pm", 990: "4:30pm", 1439: "11:59pm"} {
		if got := fmtClock(m); got != s {
			t.Errorf("fmtClock(%d) = %q, want %q", m, got, s)
		}
	}
	for m, s := range map[int]string{45: "45 min", 60: "1 h", 90: "1.5 h", 720: "12 h", 75: "1 h 15 min"} {
		if got := fmtDur(m); got != s {
			t.Errorf("fmtDur(%d) = %q, want %q", m, got, s)
		}
	}
	now := time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC)
	if got := fmtDay(time.Date(2027, 2, 3, 0, 0, 0, 0, time.UTC), now); got != "Wed 3 Feb 2027" {
		t.Errorf("fmtDay next year = %q", got)
	}
}

func TestMonthDay(t *testing.T) {
	today := time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
	cases := []struct {
		m      time.Month
		d, y   int
		want   string
		wantOK bool
	}{
		{time.November, 2, 0, "2026-11-02", true},
		{time.November, 1, 0, "2027-11-01", true},
		{time.February, 29, 0, "2028-02-29", true},
		{time.February, 30, 0, "", false},
		{time.February, 29, 2027, "", false},
		{time.April, 31, 0, "", false},
	}
	for _, c := range cases {
		got, ok := monthDay(today, c.m, c.d, c.y, time.UTC)
		if ok != c.wantOK || (ok && got.Format("2006-01-02") != c.want) {
			t.Errorf("monthDay(%v %d %d) = %v %v", c.m, c.d, c.y, got, ok)
		}
	}
}

func TestNextWeekday(t *testing.T) {
	today := time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC) // Monday
	if got := nextWeekday(today, time.Monday, time.UTC).Day(); got != 9 {
		t.Errorf("next monday = %d", got)
	}
	if got := nextWeekday(today, time.Sunday, time.UTC).Day(); got != 8 {
		t.Errorf("next sunday = %d", got)
	}
}
