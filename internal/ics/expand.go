package ics

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"arc/internal/doodle"
	"arc/internal/model"
)

// DefaultHorizonDays is used when ImportRequest.HorizonDays is zero or negative.
const DefaultHorizonDays = 120

// maxHorizonDays bounds expansion so hostile input cannot blow up output.
const maxHorizonDays = 3660

// maxSteps bounds recurrence iteration per series.
const maxSteps = 200000

// ImportRequest is the input to Import.
type ImportRequest struct {
	ICS         string `json:"ics"`
	TZ          string `json:"tz"`
	Now         string `json:"now"`
	HorizonDays int    `json:"horizonDays"`
}

// Skipped explains, in a human sentence, something that was not imported.
type Skipped struct {
	Reason string `json:"reason"`
}

// ImportResult is the output of Import.
type ImportResult struct {
	Items   []model.Item `json:"items"`
	Skipped []Skipped    `json:"skipped"`
}

// Import parses an .ics document and expands its events into individual
// Type "event" Items between the start of today (in req.TZ) and
// now+HorizonDays. It returns an error only for a bad TZ or Now; problems in
// the calendar content become Skipped entries.
func Import(req ImportRequest) (ImportResult, error) {
	loc, err := model.LoadTZ(req.TZ)
	if err != nil {
		return ImportResult{}, err
	}
	if strings.TrimSpace(req.Now) == "" {
		return ImportResult{}, model.Errf("bad_time", "now is required")
	}
	now, err := model.ParseTime(req.Now)
	if err != nil {
		return ImportResult{}, err
	}
	days := req.HorizonDays
	if days <= 0 {
		days = DefaultHorizonDays
	}
	if days > maxHorizonDays {
		days = maxHorizonDays
	}
	y, m, d := now.In(loc).Date()
	win := window{
		from: time.Date(y, m, d, 0, 0, 0, 0, loc),
		to:   now.Add(time.Duration(days) * 24 * time.Hour),
	}

	im := &importer{loc: loc, win: win, overrides: map[string][]time.Time{}}
	var events []*component
	for _, root := range parseComponents(req.ICS) {
		im.collect(root, &events)
	}
	// Overrides (RECURRENCE-ID) first, so their masters can exclude them.
	for _, ev := range events {
		if _, ok := ev.first("RECURRENCE-ID"); ok {
			im.override(ev)
		}
	}
	for _, ev := range events {
		if _, ok := ev.first("RECURRENCE-ID"); !ok {
			im.event(ev)
		}
	}
	sort.SliceStable(im.items, func(i, j int) bool {
		ti, tj := model.MustTime(im.items[i].Start), model.MustTime(im.items[j].Start)
		if !ti.Equal(tj) {
			return ti.Before(tj)
		}
		return im.items[i].ID < im.items[j].ID
	})
	// Drop exact duplicates (same UID and start appearing twice).
	items := make([]model.Item, 0, len(im.items))
	seen := map[string]bool{}
	for _, it := range im.items {
		if seen[it.ID] {
			continue
		}
		seen[it.ID] = true
		items = append(items, it)
	}
	skipped := im.skipped
	if skipped == nil {
		skipped = []Skipped{}
	}
	return ImportResult{Items: items, Skipped: skipped}, nil
}

type window struct{ from, to time.Time }

type importer struct {
	loc       *time.Location
	win       window
	items     []model.Item
	skipped   []Skipped
	overrides map[string][]time.Time // UID -> RECURRENCE-ID instants
}

func (im *importer) skip(format string, args ...any) {
	im.skipped = append(im.skipped, Skipped{Reason: fmt.Sprintf(format, args...)})
}

// collect walks the tree, gathering VEVENTs and reporting unsupported
// top-level components.
func (im *importer) collect(c *component, events *[]*component) {
	switch c.Name {
	case "VCALENDAR":
		for _, ch := range c.Children {
			im.collect(ch, events)
		}
	case "VEVENT":
		*events = append(*events, c)
	case "VTODO":
		im.skip("To-dos from calendars aren't supported yet: %s", titleOf(c))
	case "VJOURNAL":
		im.skip("Journal entries aren't supported yet: %s", titleOf(c))
	case "VFREEBUSY":
		im.skip("Free/busy blocks aren't supported yet")
	}
	// VTIMEZONE and anything unknown are ignored quietly: zones come from
	// IANA names in TZID parameters.
}

func titleOf(c *component) string {
	if p, ok := c.first("SUMMARY"); ok {
		if t := unescapeText(p.Value); strings.TrimSpace(t) != "" {
			return t
		}
	}
	return "Untitled event"
}

func uidOf(c *component) string {
	if p, ok := c.first("UID"); ok && strings.TrimSpace(p.Value) != "" {
		return strings.TrimSpace(p.Value)
	}
	start := ""
	if p, ok := c.first("DTSTART"); ok {
		start = p.Value
	}
	sum := ""
	if p, ok := c.first("SUMMARY"); ok {
		sum = p.Value
	}
	return "derived:" + sum + "|" + start
}

func cancelled(c *component) bool {
	p, ok := c.first("STATUS")
	return ok && strings.EqualFold(strings.TrimSpace(p.Value), "CANCELLED")
}

func hash12(s string) string {
	h := sha1.Sum([]byte(s))
	return hex.EncodeToString(h[:])[:12]
}

// override handles a VEVENT that replaces one instance of a series.
func (im *importer) override(c *component) {
	uid := uidOf(c)
	title := titleOf(c)
	rp, _ := c.first("RECURRENCE-ID")
	rid, _, err := parseDT(rp, im.loc)
	if err != nil {
		im.skip("A changed repeat couldn't be read (%s): %s", err.Error(), title)
		return
	}
	im.overrides[uid] = append(im.overrides[uid], rid)
	if cancelled(c) {
		return
	}
	ev, ok := im.base(c, title)
	if !ok {
		return
	}
	if ev.end.After(im.win.from) && ev.start.Before(im.win.to) {
		im.emit(uid, "ics-"+hash12(uid), title, ev, ev.start)
	}
}

// baseEvent is the parsed timing of a VEVENT.
type baseEvent struct {
	start, end time.Time
	allDay     bool
	dur        time.Duration // timed events
	days       int           // all-day events: length in days
	notes      string
}

// base parses DTSTART/DTEND/DURATION/LOCATION. It reports problems itself.
func (im *importer) base(c *component, title string) (baseEvent, bool) {
	sp, ok := c.first("DTSTART")
	if !ok {
		im.skip("This event has no start time, so it was left out: %s", title)
		return baseEvent{}, false
	}
	start, allDay, err := parseDT(sp, im.loc)
	if err != nil {
		im.skip("This event's start time couldn't be read (%s): %s", err.Error(), title)
		return baseEvent{}, false
	}
	ev := baseEvent{start: start, allDay: allDay}
	if ep, ok := c.first("DTEND"); ok {
		end, _, err := parseDT(ep, im.loc)
		if err != nil {
			im.skip("This event's end time couldn't be read (%s): %s", err.Error(), title)
			return baseEvent{}, false
		}
		if end.Before(start) {
			end = start
		}
		if allDay {
			ev.days = int((end.Sub(start) + 12*time.Hour) / (24 * time.Hour))
		} else {
			ev.dur = end.Sub(start)
		}
	} else if dp, ok := c.first("DURATION"); ok {
		dd, dt, err := parseDuration(dp.Value)
		if err != nil {
			im.skip("This event's length couldn't be read (%s): %s", dp.Value, title)
			return baseEvent{}, false
		}
		if allDay && dt == 0 {
			ev.days = dd
		} else {
			allDay = false
			ev.allDay = false
			ev.dur = time.Duration(dd)*24*time.Hour + dt
		}
	} else if allDay {
		ev.days = 1
	}
	if allDay && ev.days < 1 {
		ev.days = 1
	}
	if ev.dur < 0 {
		ev.dur = 0
	}
	ev.end = ev.endFor(start)
	if lp, ok := c.first("LOCATION"); ok {
		ev.notes = strings.TrimSpace(unescapeText(lp.Value))
	}
	return ev, true
}

// endFor returns the end of an instance starting at s.
func (ev baseEvent) endFor(s time.Time) time.Time {
	if ev.allDay {
		y, m, d := s.Date()
		return time.Date(y, m, d+ev.days, 0, 0, 0, 0, s.Location())
	}
	return s.Add(ev.dur)
}

func (im *importer) emit(uid, seriesID, title string, ev baseEvent, s time.Time) {
	startStr := model.FormatTime(s.In(im.loc))
	im.items = append(im.items, model.Item{
		ID:           "ics-" + hash12(uid+"|"+startStr),
		Type:         model.TypeEvent,
		Title:        title,
		Doodle:       doodle.Match(title, model.TypeEvent),
		DoodleSource: "auto",
		Start:        startStr,
		End:          model.FormatTime(ev.endFor(s).In(im.loc)),
		Notes:        ev.notes,
		SeriesID:     seriesID,
	})
}

// event handles a master or one-off VEVENT.
func (im *importer) event(c *component) {
	if cancelled(c) {
		return
	}
	title := titleOf(c)
	uid := uidOf(c)
	ev, ok := im.base(c, title)
	if !ok {
		return
	}
	if len(c.all("RDATE")) > 0 {
		im.skip("Extra one-off dates (RDATE) aren't supported yet, so only the regular pattern was imported: %s", title)
	}
	rules := c.all("RRULE")
	if len(rules) == 0 {
		if ev.end.After(im.win.from) && ev.start.Before(im.win.to) {
			im.emit(uid, "", title, ev, ev.start)
		}
		return
	}
	if len(rules) > 1 {
		im.skip("Events with more than one repeat rule aren't supported yet: %s", title)
		return
	}
	rr, reason := parseRRule(rules[0].Value, ev.start.Location(), ev.allDay)
	if reason != "" {
		im.skip("%s: %s", reason, title)
		return
	}
	// Exclusions: EXDATEs and RECURRENCE-ID overrides.
	var exInstants []time.Time
	exDays := map[string]bool{}
	for _, xp := range c.all("EXDATE") {
		for _, v := range strings.Split(xp.Value, ",") {
			v = strings.TrimSpace(v)
			if v == "" {
				continue
			}
			one := prop{Name: "EXDATE", Params: xp.Params, Value: v}
			t, isDate, err := parseDT(one, im.loc)
			if err != nil {
				im.skip("A skipped date couldn't be read (%s): %s", v, title)
				continue
			}
			if isDate || ev.allDay {
				exDays[t.Format("2006-01-02")] = true
			} else {
				exInstants = append(exInstants, t)
			}
		}
	}
	exInstants = append(exInstants, im.overrides[uid]...)
	excluded := func(s time.Time) bool {
		if exDays[s.Format("2006-01-02")] {
			return true
		}
		for _, x := range exInstants {
			if x.Equal(s) {
				return true
			}
		}
		return false
	}
	seriesID := "ics-" + hash12(uid)
	rr.expand(ev.start, im.win.to, func(s time.Time) {
		if excluded(s) {
			return
		}
		if ev.endFor(s).After(im.win.from) {
			im.emit(uid, seriesID, title, ev, s)
		}
	})
}

// parseDT parses a DATE or DATE-TIME property value. Floating times and
// dates use loc; TZID parameters must be IANA zone names.
func parseDT(p prop, loc *time.Location) (t time.Time, isDate bool, err error) {
	v := strings.TrimSpace(p.Value)
	if strings.EqualFold(p.Param("VALUE"), "DATE") || (len(v) == 8 && !strings.Contains(v, "T")) {
		t, err = time.ParseInLocation("20060102", v, loc)
		if err != nil {
			return time.Time{}, true, fmt.Errorf("bad date %q", v)
		}
		return t, true, nil
	}
	if strings.HasSuffix(v, "Z") || strings.HasSuffix(v, "z") {
		t, err = time.ParseInLocation("20060102T150405", v[:len(v)-1], time.UTC)
		if err != nil {
			return time.Time{}, false, fmt.Errorf("bad time %q", v)
		}
		return t, false, nil
	}
	zone := loc
	if tzid := strings.TrimSpace(strings.TrimPrefix(p.Param("TZID"), "/")); tzid != "" {
		z, lerr := time.LoadLocation(tzid)
		if lerr != nil || tzid == "Local" {
			return time.Time{}, false, fmt.Errorf("unknown time zone %q", tzid)
		}
		zone = z
	}
	t, err = time.ParseInLocation("20060102T150405", v, zone)
	if err != nil {
		return time.Time{}, false, fmt.Errorf("bad time %q", v)
	}
	return t, false, nil
}

// parseDuration parses an RFC 5545 DURATION such as PT1H30M, P1D or P2W.
// It returns whole days and the remaining time part separately so all-day
// events can keep calendar-day arithmetic.
func parseDuration(s string) (days int, rest time.Duration, err error) {
	s = strings.ToUpper(strings.TrimSpace(s))
	neg := false
	if strings.HasPrefix(s, "+") || strings.HasPrefix(s, "-") {
		neg = s[0] == '-'
		s = s[1:]
	}
	if !strings.HasPrefix(s, "P") || len(s) < 3 {
		return 0, 0, fmt.Errorf("bad duration")
	}
	s = s[1:]
	inTime := false
	num := ""
	any := false
	for _, r := range s {
		switch {
		case r >= '0' && r <= '9':
			num += string(r)
		case r == 'T':
			if inTime || num != "" {
				return 0, 0, fmt.Errorf("bad duration")
			}
			inTime = true
		default:
			if num == "" {
				return 0, 0, fmt.Errorf("bad duration")
			}
			n, cerr := strconv.Atoi(num)
			if cerr != nil || n > 100000 {
				return 0, 0, fmt.Errorf("bad duration")
			}
			num = ""
			any = true
			switch {
			case r == 'W' && !inTime:
				days += 7 * n
			case r == 'D' && !inTime:
				days += n
			case r == 'H' && inTime:
				rest += time.Duration(n) * time.Hour
			case r == 'M' && inTime:
				rest += time.Duration(n) * time.Minute
			case r == 'S' && inTime:
				rest += time.Duration(n) * time.Second
			default:
				return 0, 0, fmt.Errorf("bad duration")
			}
		}
	}
	if num != "" || !any {
		return 0, 0, fmt.Errorf("bad duration")
	}
	if neg {
		return 0, 0, nil // negative lengths make no sense for an event
	}
	return days, rest, nil
}

// rrule is the supported subset of an RRULE.
type rrule struct {
	freq     string // DAILY | WEEKLY
	interval int
	byDay    []time.Weekday // sorted relative to wkst
	count    int
	until    time.Time
	hasUntil bool
	wkst     time.Weekday
}

var dayCodes = map[string]time.Weekday{
	"SU": time.Sunday, "MO": time.Monday, "TU": time.Tuesday, "WE": time.Wednesday,
	"TH": time.Thursday, "FR": time.Friday, "SA": time.Saturday,
}

// parseRRule parses an RRULE value. A non-empty reason means the rule is
// outside the supported subset (a sentence prefix for the Skipped entry).
func parseRRule(v string, loc *time.Location, allDay bool) (rrule, string) {
	r := rrule{interval: 1, wkst: time.Monday}
	parts := map[string]string{}
	for _, kv := range strings.Split(v, ";") {
		k, val, ok := strings.Cut(strings.TrimSpace(kv), "=")
		if !ok {
			continue
		}
		parts[strings.ToUpper(k)] = strings.ToUpper(strings.TrimSpace(val))
	}
	switch parts["FREQ"] {
	case "DAILY", "WEEKLY":
		r.freq = parts["FREQ"]
	case "MONTHLY":
		return r, "Monthly repeats aren't supported yet"
	case "YEARLY":
		return r, "Yearly repeats aren't supported yet"
	case "":
		return r, "A repeat rule without a frequency couldn't be read"
	default:
		return r, "Repeats more often than daily aren't supported yet"
	}
	keys := make([]string, 0, len(parts))
	for k := range parts {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		switch k {
		case "FREQ", "INTERVAL", "BYDAY", "COUNT", "UNTIL", "WKST":
		case "BYSETPOS":
			return r, "Repeats like \"the last weekday\" (BYSETPOS) aren't supported yet"
		default:
			return r, fmt.Sprintf("Repeat rules using %s aren't supported yet", k)
		}
	}
	if s, ok := parts["INTERVAL"]; ok {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 {
			return r, "A repeat rule with a strange interval couldn't be read"
		}
		r.interval = n
	}
	if s, ok := parts["COUNT"]; ok {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 {
			return r, "A repeat rule with a strange count couldn't be read"
		}
		r.count = n
	}
	if s, ok := parts["WKST"]; ok {
		if wd, ok := dayCodes[s]; ok {
			r.wkst = wd
		}
	}
	if s, ok := parts["BYDAY"]; ok {
		seen := map[time.Weekday]bool{}
		for _, d := range strings.Split(s, ",") {
			d = strings.TrimSpace(d)
			wd, ok := dayCodes[d]
			if !ok {
				return r, "Repeats like \"the first Monday\" aren't supported yet"
			}
			if !seen[wd] {
				seen[wd] = true
				r.byDay = append(r.byDay, wd)
			}
		}
		wk := r.wkst
		sort.Slice(r.byDay, func(i, j int) bool {
			return (r.byDay[i]-wk+7)%7 < (r.byDay[j]-wk+7)%7
		})
	}
	if s, ok := parts["UNTIL"]; ok {
		p := prop{Name: "UNTIL", Params: map[string]string{}, Value: s}
		t, isDate, err := parseDT(p, loc)
		if err != nil {
			return r, "A repeat rule with an unreadable end date couldn't be read"
		}
		if isDate && !allDay {
			// Inclusive through the whole of that day.
			t = t.AddDate(0, 0, 1).Add(-time.Second)
		}
		r.until, r.hasUntil = t, true
	}
	return r, ""
}

// expand calls fn for each instance start (in dtstart's location) from
// dtstart up to (but excluding) limit, honouring COUNT and UNTIL. COUNT
// includes instances later removed by EXDATE, as in RFC 5545.
func (r rrule) expand(dtstart, limit time.Time, fn func(time.Time)) {
	loc := dtstart.Location()
	h, mi, sec := dtstart.Clock()
	y, m, d := dtstart.Date()
	at := func(dayOffset int) time.Time {
		return time.Date(y, m, d+dayOffset, h, mi, sec, 0, loc)
	}
	n := 0
	// stop reports whether iteration is finished after considering s.
	visit := func(s time.Time) bool {
		if r.hasUntil && s.After(r.until) {
			return true
		}
		if !s.Before(limit) {
			return true
		}
		n++
		fn(s)
		return r.count > 0 && n >= r.count
	}
	switch r.freq {
	case "DAILY":
		allowed := map[time.Weekday]bool{}
		for _, wd := range r.byDay {
			allowed[wd] = true
		}
		for step := 0; step < maxSteps; step++ {
			s := at(step * r.interval)
			if len(allowed) > 0 && !allowed[s.Weekday()] {
				// Still respect the overall end conditions.
				if (r.hasUntil && s.After(r.until)) || !s.Before(limit) {
					return
				}
				continue
			}
			if visit(s) {
				return
			}
		}
	case "WEEKLY":
		days := r.byDay
		if len(days) == 0 {
			days = []time.Weekday{dtstart.Weekday()}
		}
		// Offset (in days) from dtstart back to the start of its week.
		back := (int(dtstart.Weekday()) - int(r.wkst) + 7) % 7
		for week := 0; week < maxSteps; week++ {
			base := week*7*r.interval - back
			for _, wd := range days {
				off := base + (int(wd)-int(r.wkst)+7)%7
				if off < 0 {
					continue // before DTSTART in its first week
				}
				if visit(at(off)) {
					return
				}
			}
		}
	}
}
