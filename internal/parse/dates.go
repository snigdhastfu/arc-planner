package parse

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var monthNames = map[string]time.Month{
	"jan": time.January, "january": time.January,
	"feb": time.February, "february": time.February,
	"mar": time.March, "march": time.March,
	"apr": time.April, "april": time.April,
	"may": time.May,
	"jun": time.June, "june": time.June,
	"jul": time.July, "july": time.July,
	"aug": time.August, "august": time.August,
	"sep": time.September, "sept": time.September, "september": time.September,
	"oct": time.October, "october": time.October,
	"nov": time.November, "november": time.November,
	"dec": time.December, "december": time.December,
}

var weekdayNames = map[string]time.Weekday{
	"sun": time.Sunday, "sunday": time.Sunday,
	"mon": time.Monday, "monday": time.Monday,
	"tue": time.Tuesday, "tues": time.Tuesday, "tuesday": time.Tuesday,
	"wed": time.Wednesday, "weds": time.Wednesday, "wednesday": time.Wednesday,
	"thu": time.Thursday, "thur": time.Thursday, "thurs": time.Thursday, "thursday": time.Thursday,
	"fri": time.Friday, "friday": time.Friday,
	"sat": time.Saturday, "saturday": time.Saturday,
}

// ambiguousWeekdays are ordinary English words too; they only count as days
// when qualified ("on sat", "every sun", "due sat").
var ambiguousWeekdays = map[string]bool{"sun": true, "sat": true}

// weekday parses a weekday name. plural reports a trailing "s" form such as
// "mondays" (used for recurrence).
func weekday(s string, qualified bool) (wd time.Weekday, plural, ok bool) {
	if d, ok := weekdayNames[s]; ok {
		if ambiguousWeekdays[s] && !qualified {
			return 0, false, false
		}
		return d, false, true
	}
	if len(s) > 4 && strings.HasSuffix(s, "s") {
		if d, ok := weekdayNames[s[:len(s)-1]]; ok && strings.HasSuffix(s, "days") {
			return d, true, true
		}
	}
	return 0, false, false
}

var (
	reDayNum = regexp.MustCompile(`^(\d{1,2})(st|nd|rd|th)?$`)
	reYear   = regexp.MustCompile(`^(\d{4})$`)
	reISO    = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})$`)
	reAmPm   = regexp.MustCompile(`^(\d{1,2})(?:[:.](\d{2}))?(am|pm)$`)
	reClock  = regexp.MustCompile(`^(\d{1,2})(?:[:.](\d{2}))?$`)
	re24     = regexp.MustCompile(`^(\d{1,2}):(\d{2})$`)
	reDur    = regexp.MustCompile(`^(\d+(?:\.\d+)?)(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)$`)
	reHM     = regexp.MustCompile(`^(\d{1,3})h(?:r|rs)?(\d{1,2})(?:m|min|mins)?$`)
	reNum    = regexp.MustCompile(`^\d+(?:\.\d+)?$`)
)

// midnight returns local midnight of t's day in loc.
func midnight(t time.Time, loc *time.Location) time.Time {
	y, m, d := t.In(loc).Date()
	return time.Date(y, m, d, 0, 0, 0, 0, loc)
}

func addDays(day time.Time, n int, loc *time.Location) time.Time {
	y, m, d := day.In(loc).Date()
	return time.Date(y, m, d+n, 0, 0, 0, 0, loc)
}

// nextWeekday returns the next wd strictly after today.
func nextWeekday(today time.Time, wd time.Weekday, loc *time.Location) time.Time {
	delta := (int(wd) - int(today.Weekday()) + 7) % 7
	if delta == 0 {
		delta = 7
	}
	return addDays(today, delta, loc)
}

func daysIn(y int, m time.Month) int {
	return time.Date(y, m+1, 0, 0, 0, 0, 0, time.UTC).Day()
}

// monthDay resolves "nov 20" style dates. year 0 means infer: this year,
// rolled to next year when the date is already past.
func monthDay(today time.Time, m time.Month, d, year int, loc *time.Location) (time.Time, bool) {
	if d < 1 || d > 31 {
		return time.Time{}, false
	}
	if year != 0 {
		if d > daysIn(year, m) {
			return time.Time{}, false
		}
		return time.Date(year, m, d, 0, 0, 0, 0, loc), true
	}
	y := today.Year()
	for k := 0; k < 8; k++ { // Feb 29 may need a few years
		if d <= daysIn(y+k, m) {
			t := time.Date(y+k, m, d, 0, 0, 0, 0, loc)
			if !t.Before(today) {
				return t, true
			}
		}
	}
	return time.Time{}, false
}

func dayNum(s string) (int, bool) {
	sm := reDayNum.FindStringSubmatch(s)
	if sm == nil {
		return 0, false
	}
	n, err := strconv.Atoi(sm[1])
	if err != nil || n < 1 || n > 31 {
		return 0, false
	}
	return n, true
}

func yearNum(s string) (int, bool) {
	if !reYear.MatchString(s) {
		return 0, false
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 1970 || n > 2999 {
		return 0, false
	}
	return n, true
}

// clockAmPm parses "4pm", "4:30pm" (and "4", "4:30" with a separate am/pm).
func clockAmPm(hs, ms, ap string) (int, bool) {
	h, err := strconv.Atoi(hs)
	if err != nil || h < 1 || h > 12 {
		return 0, false
	}
	m := 0
	if ms != "" {
		if m, err = strconv.Atoi(ms); err != nil || m > 59 {
			return 0, false
		}
	}
	if h == 12 {
		h = 0
	}
	if ap == "pm" {
		h += 12
	}
	return h*60 + m, true
}

func clock24(hs, ms string) (int, bool) {
	h, err1 := strconv.Atoi(hs)
	m, err2 := strconv.Atoi(ms)
	if err1 != nil || err2 != nil || h > 23 || m > 59 {
		return 0, false
	}
	return h*60 + m, true
}

// unitMin returns minutes per unit word, or 0 if s is not a unit.
func unitMin(s string) float64 {
	switch s {
	case "h", "hr", "hrs", "hour", "hours":
		return 60
	case "m", "min", "mins", "minute", "minutes":
		return 1
	}
	return 0
}

// durMinutes converts value*unit to whole minutes, rejecting absurd values.
func durMinutes(v, unit float64) (int, bool) {
	m := v * unit
	if m < 1 || m > 100000*60 {
		return 0, false
	}
	return int(m + 0.5), true
}

// fmtDay renders a day like "Fri 6 Nov" (adding the year when it differs).
func fmtDay(t, now time.Time) string {
	if t.Year() != now.Year() {
		return t.Format("Mon 2 Jan 2006")
	}
	return t.Format("Mon 2 Jan")
}

// fmtClock renders minutes-from-midnight as "9am", "4:30pm", "11:59pm".
func fmtClock(min int) string {
	h, m := min/60, min%60
	ap := "am"
	if h >= 12 {
		ap = "pm"
	}
	h %= 12
	if h == 0 {
		h = 12
	}
	if m == 0 {
		return fmt.Sprintf("%d%s", h, ap)
	}
	return fmt.Sprintf("%d:%02d%s", h, m, ap)
}

// fmtDur renders a duration like "12 h", "90 min" -> "1.5 h", "45 min".
func fmtDur(min int) string {
	switch {
	case min < 60:
		return fmt.Sprintf("%d min", min)
	case min%60 == 0:
		return fmt.Sprintf("%d h", min/60)
	case min%30 == 0:
		return fmt.Sprintf("%d.5 h", min/60)
	default:
		return fmt.Sprintf("%d h %d min", min/60, min%60)
	}
}
