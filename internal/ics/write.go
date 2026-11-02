package ics

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"arc/internal/model"
)

// ExportRequest is the input to Export. Include lists any of "events",
// "routines" and "blocks"; empty means events and routines.
type ExportRequest struct {
	Items   []model.Item  `json:"items"`
	Plan    model.Plan    `json:"plan"`
	Profile model.Profile `json:"profile"`
	Include []string      `json:"include"`
	Now     string        `json:"now"`
}

// ExportResult is the output of Export.
type ExportResult struct {
	ICS string `json:"ics"`
}

const (
	prodID   = "-//Arc//Arc Planner//EN"
	utcBasic = "20060102T150405Z"
	maxOctet = 75
)

// vevent is one exportable event before serialisation.
type vevent struct {
	uid        string
	start, end time.Time
	hasEnd     bool
	summary    string
	rrule      string
	alarm      bool
	tzid       string // when set, DTSTART/DTEND are local times in this zone
}

// Export renders items and plan blocks as an RFC 5545 calendar with CRLF
// line endings and lines folded at 75 octets. Output is deterministic.
func Export(req ExportRequest) (ExportResult, error) {
	if strings.TrimSpace(req.Now) == "" {
		return ExportResult{}, model.Errf("bad_time", "now is required")
	}
	now, err := model.ParseTime(req.Now)
	if err != nil {
		return ExportResult{}, err
	}
	loc, err := model.LoadTZ(req.Profile.TZ)
	if err != nil {
		return ExportResult{}, err
	}
	inc := map[string]bool{}
	for _, s := range req.Include {
		inc[strings.ToLower(strings.TrimSpace(s))] = true
	}
	if len(req.Include) == 0 {
		inc["events"], inc["routines"] = true, true
	}

	var events, routines, blocks []vevent
	if inc["events"] {
		events = exportEvents(req.Items)
	}
	if inc["routines"] {
		routines = exportRoutines(req.Items, req.Profile, now, loc)
	}
	if inc["blocks"] {
		blocks = exportBlocks(req.Items, req.Plan.Blocks)
	}

	var w lineWriter
	w.line("BEGIN:VCALENDAR")
	w.line("VERSION:2.0")
	w.line("PRODID:" + prodID)
	w.line("CALSCALE:GREGORIAN")
	w.line("METHOD:PUBLISH")
	stamp := now.UTC().Format(utcBasic)
	for _, group := range [][]vevent{events, routines, blocks} {
		sortVevents(group)
		for _, ev := range group {
			ev.write(&w, stamp)
		}
	}
	w.line("END:VCALENDAR")
	return ExportResult{ICS: w.b.String()}, nil
}

func sortVevents(vs []vevent) {
	sort.SliceStable(vs, func(i, j int) bool {
		if !vs[i].start.Equal(vs[j].start) {
			return vs[i].start.Before(vs[j].start)
		}
		return vs[i].uid < vs[j].uid
	})
}

func (ev vevent) write(w *lineWriter, stamp string) {
	w.line("BEGIN:VEVENT")
	w.line("UID:" + escapeText(ev.uid))
	w.line("DTSTAMP:" + stamp)
	if ev.tzid != "" {
		z, _ := time.LoadLocation(ev.tzid) // validated by the caller
		w.line("DTSTART;TZID=" + ev.tzid + ":" + ev.start.In(z).Format("20060102T150405"))
		if ev.hasEnd {
			w.line("DTEND;TZID=" + ev.tzid + ":" + ev.end.In(z).Format("20060102T150405"))
		}
	} else {
		w.line("DTSTART:" + ev.start.UTC().Format(utcBasic))
		if ev.hasEnd {
			w.line("DTEND:" + ev.end.UTC().Format(utcBasic))
		}
	}
	if ev.rrule != "" {
		w.line("RRULE:" + ev.rrule)
	}
	w.line("SUMMARY:" + escapeText(ev.summary))
	if ev.alarm {
		w.line("BEGIN:VALARM")
		w.line("ACTION:DISPLAY")
		w.line("TRIGGER:PT0S")
		w.line("DESCRIPTION:" + escapeText(ev.summary))
		w.line("END:VALARM")
	}
	w.line("END:VEVENT")
}

func exportEvents(items []model.Item) []vevent {
	var out []vevent
	for _, it := range items {
		if it.Deleted || it.Type != model.TypeEvent {
			continue
		}
		s, err := model.ParseTime(it.Start)
		if err != nil || s.IsZero() {
			continue
		}
		ev := vevent{uid: it.ID + "@arc", start: s, summary: it.Title}
		if e, err := model.ParseTime(it.End); err == nil && !e.IsZero() && !e.Before(s) {
			ev.end, ev.hasEnd = e, true
		}
		out = append(out, ev)
	}
	return out
}

func exportBlocks(items []model.Item, blocks []model.Block) []vevent {
	titles := map[string]string{}
	deleted := map[string]bool{}
	for _, it := range items {
		titles[it.ID] = it.Title
		deleted[it.ID] = it.Deleted
	}
	var out []vevent
	for _, b := range blocks {
		if b.Kind != model.KindWork || (b.Status != model.StatusPlanned && b.Status != model.StatusDone) {
			continue
		}
		if deleted[b.ItemID] {
			continue
		}
		s, err1 := model.ParseTime(b.Start)
		e, err2 := model.ParseTime(b.End)
		if err1 != nil || err2 != nil || s.IsZero() {
			continue
		}
		title := titles[b.ItemID]
		if title == "" {
			title = "Focus time"
		}
		ev := vevent{uid: b.ID + "@arc", start: s, summary: title}
		if !e.IsZero() && !e.Before(s) {
			ev.end, ev.hasEnd = e, true
		}
		out = append(out, ev)
	}
	return out
}

var weekdayCodes = [7]string{"SU", "MO", "TU", "WE", "TH", "FR", "SA"}

func exportRoutines(items []model.Item, p model.Profile, now time.Time, loc *time.Location) []vevent {
	wake, sleep := p.WakeMin, p.SleepMin
	if wake == 0 {
		wake = 420
	}
	if sleep == 0 {
		sleep = 1380
	}
	tzid := ""
	if hasDST(loc, now) {
		tzid = loc.String()
	}
	var out []vevent
	for _, it := range items {
		if it.Deleted || it.Type != model.TypeRoutine || it.Routine == nil {
			continue
		}
		rs := it.Routine
		at := 13 * 60
		switch rs.Anchor {
		case "morning":
			at = wake + 15
		case "evening":
			at = sleep - 90
		case "daytime", "time":
			if rs.AtMin != nil {
				at = *rs.AtMin
			}
		}
		if at < 0 {
			at = 0
		}
		if at > 1439 {
			at = 1439
		}
		dur := rs.DurMin
		if dur < 1 {
			dur = 1
		}

		rec := rs.Recur
		freq := "DAILY"
		if strings.EqualFold(rec.Freq, "weekly") {
			freq = "WEEKLY"
		}
		var days []int
		seen := map[int]bool{}
		for _, d := range rec.Days {
			if d >= 0 && d <= 6 && !seen[d] {
				seen[d] = true
				days = append(days, d)
			}
		}
		sort.Ints(days)

		// First occurrence day on/after today (local).
		y, m, d := now.In(loc).Date()
		first := -1
		for off := 0; off < 7; off++ {
			wd := int(time.Date(y, m, d+off, 12, 0, 0, 0, loc).Weekday())
			if len(days) == 0 || seen[wd] {
				first = off
				break
			}
		}
		if first < 0 {
			first = 0
		}
		start := time.Date(y, m, d+first, at/60, at%60, 0, 0, loc)

		parts := []string{"FREQ=" + freq}
		if rec.Interval > 1 {
			parts = append(parts, fmt.Sprintf("INTERVAL=%d", rec.Interval))
		}
		if len(days) > 0 {
			codes := make([]string, len(days))
			for i, wd := range days {
				codes[i] = weekdayCodes[wd]
			}
			parts = append(parts, "BYDAY="+strings.Join(codes, ","))
		}
		if u, ok := parseUntil(rec.Until, loc); ok {
			if u.Before(start) {
				continue // already finished; nothing to remind
			}
			parts = append(parts, "UNTIL="+u.UTC().Format(utcBasic))
		}
		out = append(out, vevent{
			uid:     it.ID + "@arc",
			start:   start,
			end:     start.Add(time.Duration(dur) * time.Minute),
			hasEnd:  true,
			summary: it.Title,
			rrule:   strings.Join(parts, ";"),
			alarm:   true,
			tzid:    tzid,
		})
	}
	return out
}

// parseUntil accepts YYYY-MM-DD (inclusive, end of that local day) or RFC3339.
func parseUntil(s string, loc *time.Location) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, false
	}
	if t, err := time.ParseInLocation("2006-01-02", s, loc); err == nil {
		y, m, d := t.Date()
		return time.Date(y, m, d, 23, 59, 59, 0, loc), true
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t, true
	}
	return time.Time{}, false
}

// hasDST reports whether loc's UTC offset changes within a year of now.
// Recurring routines in such zones are exported with TZID so the wall-clock
// time survives DST; fixed-offset zones use plain UTC.
func hasDST(loc *time.Location, now time.Time) bool {
	_, off0 := now.In(loc).Zone()
	for w := 1; w <= 53; w++ {
		if _, off := now.Add(time.Duration(w) * 7 * 24 * time.Hour).In(loc).Zone(); off != off0 {
			return true
		}
	}
	return false
}

// lineWriter emits CRLF-terminated content lines folded at 75 octets.
type lineWriter struct{ b strings.Builder }

func (w *lineWriter) line(s string) { w.b.WriteString(fold(s)) }

// fold splits a content line into physical lines of at most 75 octets
// (continuations start with one space) without splitting a UTF-8 sequence.
// Every physical line ends in CRLF.
func fold(s string) string {
	var b strings.Builder
	limit := maxOctet
	for len(s) > limit {
		cut := limit
		for cut > 0 && isCont(s[cut]) {
			cut--
		}
		if cut == 0 { // cannot happen with valid UTF-8; avoid looping
			cut = limit
		}
		b.WriteString(s[:cut])
		b.WriteString("\r\n ")
		s = s[cut:]
		limit = maxOctet - 1
	}
	b.WriteString(s)
	b.WriteString("\r\n")
	return b.String()
}

func isCont(c byte) bool { return c&0xC0 == 0x80 }
