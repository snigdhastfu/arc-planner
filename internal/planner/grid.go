package planner

import (
	"time"

	"arc/internal/model"
)

const slotMin = 5

// day is one local day of the 5-minute slot grid between WakeMin and SleepMin.
type day struct {
	idx  int
	key  string
	date time.Time // local midnight
	wake int
	n    int    // number of slots
	busy []bool // events, done/pinned/kept blocks, routines, placed work
	past int    // minutes before this are in the past (today only); wake otherwise

	cap, hard int // capacity and hard max (minutes of work for the whole day)
	work      int // work minutes counted on this day (done + held + placed)
	workIv    [][2]int
}

func (d *day) sleep() int { return d.wake + d.n*slotMin }

// minuteOf returns minutes from this day's local midnight (wall clock), or a
// large negative/positive sentinel when t is on an earlier/later local day.
func (d *day) minuteOf(t time.Time, loc *time.Location) int {
	lt := t.In(loc)
	y, m, dd := lt.Date()
	dy, dm, ddd := d.date.Date()
	a := time.Date(y, m, dd, 0, 0, 0, 0, time.UTC)
	b := time.Date(dy, dm, ddd, 0, 0, 0, 0, time.UTC)
	switch {
	case a.Before(b):
		return -1 << 30
	case a.After(b):
		return 1 << 30
	}
	return lt.Hour()*60 + lt.Minute()
}

// slotSpan maps a minute range to the slot indexes it touches, clipped.
func (d *day) slotSpan(a, b int) (int, int) {
	i := floorDiv(a-d.wake, slotMin)
	j := ceilDiv(b-d.wake, slotMin)
	if i < 0 {
		i = 0
	}
	if j > d.n {
		j = d.n
	}
	return i, j
}

func (d *day) mark(a, b int) {
	i, j := d.slotSpan(a, b)
	for k := i; k < j; k++ {
		d.busy[k] = true
	}
}

// free reports whether minutes [a,b) are inside the grid and not busy.
func (d *day) free(a, b int) bool {
	if a < d.wake || b > d.sleep() || a >= b {
		return false
	}
	i, j := d.slotSpan(a, b)
	for k := i; k < j; k++ {
		if d.busy[k] {
			return false
		}
	}
	return true
}

// gapOK enforces the 10-minute breather between consecutive work blocks.
func (d *day) gapOK(a, b int) bool {
	for _, iv := range d.workIv {
		if !(a >= iv[1]+workGap || b <= iv[0]-workGap) {
			return false
		}
	}
	return true
}

const workGap = 10

func (e *engine) markTimes(start, end time.Time) {
	for _, d := range e.days {
		a, b := d.minuteOf(start, e.loc), d.minuteOf(end, e.loc)
		if b <= d.wake || a >= d.sleep() {
			continue
		}
		if a < 0 {
			a = 0
		}
		if b > 1<<29 {
			b = 24 * 60
		}
		d.mark(a, b)
	}
}

// dayOf returns the grid day containing t, or nil.
func (e *engine) dayOf(t time.Time) *day {
	if i, ok := e.dayIdx[model.DayKey(t, e.loc)]; ok {
		return e.days[i]
	}
	return nil
}

func floorDiv(a, b int) int {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return q
}

func ceilDiv(a, b int) int { return -floorDiv(-a, b) }

func roundUp5(m int) int { return ceilDiv(m, slotMin) * slotMin }
