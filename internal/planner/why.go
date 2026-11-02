package planner

import (
	"fmt"
	"strconv"
	"time"

	"arc/internal/model"
)

const (
	whyRoutine = "Routines sit where you asked them to."
	whyEvent   = "Fixed in your calendar, so everything else flows around it."
	whyForced  = "Forced by the deadline: this day is over your usual goal."
	whyEarly   = "Starting early so the last week stays light."
)

func partOfDay(min int) string {
	switch {
	case min < 12*60:
		return "morning"
	case min < 17*60:
		return "afternoon"
	default:
		return "evening"
	}
}

// why returns exactly one plain sentence explaining a work block's spot.
func (e *engine) why(it model.Item, d *day, start, size int, forced bool) string {
	if forced {
		return whyForced
	}
	level := e.p.LevelAt(start)
	wd := d.date.Weekday().String()
	part := partOfDay(start)
	switch {
	case level == model.EnergyHigh && size > 30:
		return fmt.Sprintf("%s %s is a peak-energy window.", wd, part)
	case level == model.EnergyLow && size <= 30:
		return fmt.Sprintf("A light task for a gentle %s %s.", wd, part)
	case it.Deadline().Sub(d.date) > 8*24*time.Hour:
		return whyEarly
	default:
		return fmt.Sprintf("%s %s has room before the deadline.", wd, part)
	}
}

func refresherWhy(it model.Item, d *day, loc *time.Location) string {
	n := civilDays(d.date, it.Deadline().In(loc))
	switch n {
	case 1:
		return "A short refresher the day before keeps it fresh."
	case 2:
		return "A short refresher two days out keeps it fresh."
	default:
		return "A short refresher before the exam keeps it fresh."
	}
}

// hoursText renders minutes as "4 h", "4.5 h" or "45 min".
func hoursText(min int) string {
	if min < 60 {
		return fmt.Sprintf("%d min", min)
	}
	h := float64(min) / 60
	return strconv.FormatFloat(float64(int(h*10+0.5))/10, 'f', -1, 64) + " h"
}

func ordinal(n int) string {
	suf := "th"
	if n%100 < 11 || n%100 > 13 {
		switch n % 10 {
		case 1:
			suf = "st"
		case 2:
			suf = "nd"
		case 3:
			suf = "rd"
		}
	}
	return strconv.Itoa(n) + suf
}
