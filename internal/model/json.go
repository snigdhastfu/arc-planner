package model

import (
	"encoding/json"
	"fmt"
	"sort"
	"time"
)

// Error is the error half of the JSON envelope.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Envelope wraps every bridge response.
type Envelope struct {
	OK    bool   `json:"ok"`
	Data  any    `json:"data,omitempty"`
	Error *Error `json:"error,omitempty"`
}

// CodedError carries a machine-readable code across the boundary.
type CodedError struct{ Code, Msg string }

func (e *CodedError) Error() string { return e.Msg }

// Errf builds a CodedError.
func Errf(code, format string, args ...any) error {
	return &CodedError{Code: code, Msg: fmt.Sprintf(format, args...)}
}

// Handle decodes req into T, runs fn and returns an envelope as a JSON string.
// It never panics: panics become an "internal" error envelope.
func Handle[T any, R any](req string, fn func(T) (R, error)) (out string) {
	defer func() {
		if r := recover(); r != nil {
			out = Fail("internal", fmt.Sprint(r))
		}
	}()
	var in T
	if req != "" {
		if err := json.Unmarshal([]byte(req), &in); err != nil {
			return Fail("bad_request", err.Error())
		}
	}
	res, err := fn(in)
	if err != nil {
		if ce, ok := err.(*CodedError); ok {
			return Fail(ce.Code, ce.Msg)
		}
		return Fail("error", err.Error())
	}
	b, err := json.Marshal(Envelope{OK: true, Data: res})
	if err != nil {
		return Fail("encode", err.Error())
	}
	return string(b)
}

// Fail returns a failure envelope string.
func Fail(code, msg string) string {
	b, _ := json.Marshal(Envelope{OK: false, Error: &Error{Code: code, Message: msg}})
	return string(b)
}

// ParseTime parses an RFC3339 time. Empty input returns the zero time.
func ParseTime(s string) (time.Time, error) {
	if s == "" {
		return time.Time{}, nil
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}, Errf("bad_time", "bad time %q", s)
	}
	return t, nil
}

// MustTime parses s or returns the zero time.
func MustTime(s string) time.Time {
	t, _ := ParseTime(s)
	return t
}

// FormatTime formats t as RFC3339 with offset.
func FormatTime(t time.Time) string { return t.Format(time.RFC3339) }

// DayKey returns YYYY-MM-DD for t in loc.
func DayKey(t time.Time, loc *time.Location) string { return t.In(loc).Format("2006-01-02") }

// LoadTZ loads an IANA zone, defaulting to UTC when empty.
func LoadTZ(tz string) (*time.Location, error) {
	if tz == "" {
		return time.UTC, nil
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return nil, Errf("bad_tz", "unknown time zone %q", tz)
	}
	return loc, nil
}

// AtMin returns the instant at minutes-from-midnight on the given local day.
// It uses wall-clock arithmetic so DST days still map 09:00 to 09:00.
func AtMin(day time.Time, min int, loc *time.Location) time.Time {
	y, m, d := day.In(loc).Date()
	return time.Date(y, m, d, min/60, min%60, 0, 0, loc)
}

// MinOfDay returns minutes since local midnight (wall clock).
func MinOfDay(t time.Time, loc *time.Location) int {
	lt := t.In(loc)
	return lt.Hour()*60 + lt.Minute()
}

// Defaults fills zero profile fields with sensible defaults.
func (p Profile) Defaults() Profile {
	if p.WakeMin == 0 && p.SleepMin == 0 {
		p.WakeMin, p.SleepMin = 420, 1380
	}
	if p.SleepMin == p.WakeMin {
		p.SleepMin = (p.WakeMin + 60) % (24 * 60)
	}
	if p.AmbitionMin == 0 {
		p.AmbitionMin = 240
	}
	if p.BlockMin == 0 {
		p.BlockMin = 50
	}
	if p.OverloadFactor == 0 {
		p.OverloadFactor = 1.4
	}
	if p.TZ == "" {
		p.TZ = "UTC"
	}
	sort.SliceStable(p.Energy, func(i, j int) bool { return p.Energy[i].StartMin < p.Energy[j].StartMin })
	return p
}

// LevelAt returns the energy level at minute m (gaps are "med").
func (p Profile) LevelAt(m int) string {
	for _, candidate := range []int{m, m - 24*60, m + 24*60} {
		for _, w := range p.Energy {
			if candidate >= w.StartMin && candidate < w.EndMin {
				return w.Level
			}
		}
	}
	return EnergyMed
}

// SortBlocks sorts by (Start, ID).
func SortBlocks(bs []Block) {
	sort.SliceStable(bs, func(i, j int) bool {
		ti, tj := MustTime(bs[i].Start), MustTime(bs[j].Start)
		if !ti.Equal(tj) {
			return ti.Before(tj)
		}
		return bs[i].ID < bs[j].ID
	})
}

// Deadline returns the item's deadline: exam=Start, assignment/project=Due.
func (it Item) Deadline() time.Time {
	if it.Type == TypeExam {
		return MustTime(it.Start)
	}
	return MustTime(it.Due)
}

// IsWork reports whether the item gets planned work blocks.
func (it Item) IsWork() bool {
	return it.Type == TypeExam || it.Type == TypeAssignment || it.Type == TypeProject
}
