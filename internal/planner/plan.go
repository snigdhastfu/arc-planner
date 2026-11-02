// Package planner turns items + a profile into a schedule of blocks, and
// proposes (never silently applies) changes when the day drifts.
package planner

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"math"
	"sort"
	"time"

	"arc/internal/model"
)

// PlanRequest is the input to Plan.
type PlanRequest struct {
	Items       []model.Item  `json:"items"`
	Profile     model.Profile `json:"profile"`
	Now         string        `json:"now"`
	Existing    []model.Block `json:"existing"`
	HorizonDays int           `json:"horizonDays,omitempty"`
}

// Plan builds a plan. Existing done, pinned, skipped and still-valid planned
// blocks are kept exactly where they are; only uncovered effort is placed.
func Plan(req PlanRequest) (model.Plan, error) {
	e, err := newEngine(req.Items, req.Profile, req.Now, req.HorizonDays, req.Existing)
	if err != nil {
		return model.Plan{}, err
	}
	return e.run(req.Existing, false), nil
}

type engine struct {
	p        model.Profile
	loc      *time.Location
	now      time.Time
	earliest time.Time // now rounded up to 5 minutes
	days     []*day
	dayIdx   map[string]int
	items    map[string]model.Item
	sorted   []model.Item // by ID

	out      []model.Block
	atRisk   []model.AtRisk
	warnings []string
	maxSeq   map[string]int
	seqPool  map[string][]int
}

func newEngine(items []model.Item, prof model.Profile, nowS string, horizon int, existing []model.Block) (*engine, error) {
	p := prof.Defaults()
	loc, err := model.LoadTZ(p.TZ)
	if err != nil {
		return nil, err
	}
	now, err := model.ParseTime(nowS)
	if err != nil || now.IsZero() {
		return nil, model.Errf("bad_now", "now must be an RFC3339 time")
	}
	e := &engine{p: p, loc: loc, now: now.In(loc), items: map[string]model.Item{}, dayIdx: map[string]int{},
		maxSeq: map[string]int{}, seqPool: map[string][]int{}}
	for _, it := range items {
		if it.ID == "" || it.Deleted {
			continue
		}
		if _, dup := e.items[it.ID]; dup {
			e.warnings = append(e.warnings, fmt.Sprintf("Duplicate item id %q ignored.", it.ID))
			continue
		}
		e.items[it.ID] = it
		e.sorted = append(e.sorted, it)
	}
	sort.Slice(e.sorted, func(i, j int) bool { return e.sorted[i].ID < e.sorted[j].ID })
	for _, b := range existing {
		if b.Seq > e.maxSeq[b.ItemID] {
			e.maxSeq[b.ItemID] = b.Seq
		}
	}

	nowMin := model.MinOfDay(e.now, loc)
	e.earliest = model.AtMin(e.now, roundUp5(nowMin), loc)
	if horizon <= 0 {
		horizon = 21
		for _, it := range e.sorted {
			if !it.IsWork() || it.Done {
				continue
			}
			if d := it.Deadline(); !d.IsZero() {
				if n := int(math.Ceil(d.Sub(e.now).Hours()/24)) + 1; n > horizon {
					horizon = n
				}
			}
		}
	}
	if horizon > 120 {
		horizon = 120
	}
	y, m, d := e.now.Date()
	for i := 0; i < horizon; i++ {
		date := time.Date(y, m, d+i, 0, 0, 0, 0, loc)
		key := date.Format("2006-01-02")
		dd := &day{idx: i, key: key, date: date, wake: p.WakeMin, n: ceilDiv(p.SleepMin-p.WakeMin, slotMin), past: p.WakeMin}
		dd.busy = make([]bool, dd.n)
		base := p.AmbitionMin
		if v, ok := p.DayOverrides[key]; ok {
			base = v
		}
		dd.cap = base
		dd.hard = int(math.Floor(float64(base) * p.OverloadFactor))
		if i == 0 {
			dd.past = max(p.WakeMin, roundUp5(nowMin))
		}
		e.dayIdx[key] = i
		e.days = append(e.days, dd)
	}
	return e, nil
}

// blockID implements hex(sha1(itemID|dayKey|seq))[:12].
func blockID(itemID, dayKey string, seq int) string {
	h := sha1.Sum([]byte(fmt.Sprintf("%s|%s|%d", itemID, dayKey, seq)))
	return hex.EncodeToString(h[:])[:12]
}

func minutes(b model.Block) int {
	return int(model.MustTime(b.End).Sub(model.MustTime(b.Start)).Minutes())
}

func isAllDay(it model.Item, loc *time.Location) bool {
	s, en := model.MustTime(it.Start), model.MustTime(it.End)
	if s.IsZero() || en.IsZero() {
		return false
	}
	return model.MinOfDay(s, loc) == 0 && model.MinOfDay(en, loc) == 0 && en.Sub(s) >= 20*time.Hour
}

// remaining is EffortMin minus finished work. DoneMin already includes the
// minutes of blocks finished in the app (completeBlock keeps both in step),
// so we take the larger of the two rather than double counting.
func remaining(it model.Item, doneBlockMin int) int {
	done := max(it.DoneMin, doneBlockMin)
	return max(0, it.EffortMin-done)
}

// run executes the full pipeline. release=true is replan mode: planned
// (non-pinned) work blocks and skipped work blocks are released.
func (e *engine) run(existing []model.Block, release bool) model.Plan {
	ex := append([]model.Block(nil), existing...)
	model.SortBlocks(ex)

	// 1. fixed events
	e.placeEvents(ex)

	// 2. done + pinned blocks are immovable
	doneMin := map[string]int{}
	for _, b := range ex {
		if b.Kind == model.KindWork && b.Status == model.StatusDone {
			doneMin[b.ItemID] += minutes(b)
		}
	}
	held := map[string]int{} // work minutes per item already accounted for
	for _, b := range ex {
		if b.Kind == model.KindEvent {
			continue
		}
		if _, ok := e.items[b.ItemID]; !ok && b.Status != model.StatusDone {
			continue
		}
		fixed := b.Status == model.StatusDone || (b.Pinned && (b.Status == model.StatusPlanned || b.Status == model.StatusSkipped))
		if !fixed {
			continue
		}
		e.out = append(e.out, b)
		if b.Status == model.StatusSkipped {
			if b.Kind == model.KindWork {
				held[b.ItemID] += minutes(b)
			}
			continue
		}
		e.claim(b)
		if b.Kind == model.KindWork && b.Status != model.StatusDone {
			held[b.ItemID] += minutes(b)
		}
	}

	// 3. routines at their anchors
	e.placeRoutines(ex)

	// 4. keep (or release) the rest of the existing work blocks
	need := map[string]int{}
	for _, it := range e.sorted {
		if it.IsWork() && !it.Done {
			need[it.ID] = remaining(it, doneMin[it.ID])
		}
	}
	var candidates []model.Block
	for _, b := range ex {
		if b.Kind != model.KindWork || b.Status == model.StatusDone || b.Pinned {
			continue
		}
		it, ok := e.items[b.ItemID]
		if !ok || it.Done || !it.IsWork() {
			continue
		}
		switch b.Status {
		case model.StatusMoved:
			e.out = append(e.out, b) // a record only: its effort lives elsewhere
		case model.StatusSkipped:
			if release {
				b.Status = model.StatusMoved
				e.out = append(e.out, b)
			} else {
				e.out = append(e.out, b)
				held[b.ItemID] += minutes(b)
			}
		case model.StatusPlanned:
			if release {
				e.seqPool[b.ItemID] = append(e.seqPool[b.ItemID], b.Seq)
			} else {
				candidates = append(candidates, b)
			}
		}
	}
	for _, b := range candidates {
		m := minutes(b)
		past := model.MustTime(b.Start).Before(e.earliest)
		if held[b.ItemID]+m > need[b.ItemID] || (!past && !e.fits(b)) {
			e.seqPool[b.ItemID] = append(e.seqPool[b.ItemID], b.Seq)
			continue
		}
		held[b.ItemID] += m
		e.claim(b)
		e.out = append(e.out, b)
	}
	for _, pool := range e.seqPool {
		sort.Ints(pool)
	}

	// 5. demands, by (deadline, id)
	demands := make([]model.Item, 0, len(e.sorted))
	for _, it := range e.sorted {
		if it.IsWork() && !it.Done {
			demands = append(demands, it)
		}
	}
	sort.SliceStable(demands, func(i, j int) bool {
		di, dj := demands[i].Deadline(), demands[j].Deadline()
		if !di.Equal(dj) {
			return di.Before(dj)
		}
		return demands[i].ID < demands[j].ID
	})
	for _, it := range demands {
		e.placeDemand(it, need[it.ID]-held[it.ID])
	}

	model.SortBlocks(e.out)
	sort.Slice(e.atRisk, func(i, j int) bool { return e.atRisk[i].ItemID < e.atRisk[j].ItemID })
	plan := model.Plan{Blocks: e.out, AtRisk: e.atRisk, GeneratedAt: model.FormatTime(e.now), Warnings: e.warnings}
	if plan.Blocks == nil {
		plan.Blocks = []model.Block{}
	}
	if plan.AtRisk == nil {
		plan.AtRisk = []model.AtRisk{}
	}
	if plan.Warnings == nil {
		plan.Warnings = []string{}
	}
	return plan
}

// claim marks a kept block busy and counts its work minutes.
func (e *engine) claim(b model.Block) {
	s, en := model.MustTime(b.Start), model.MustTime(b.End)
	e.markTimes(s, en)
	if b.Kind != model.KindWork {
		return
	}
	if d := e.dayOf(s); d != nil {
		d.work += minutes(b)
		a := d.minuteOf(s, e.loc)
		d.workIv = append(d.workIv, [2]int{a, a + minutes(b)})
	}
}

// fits reports whether a block lies on the grid without touching busy slots.
func (e *engine) fits(b model.Block) bool {
	s, en := model.MustTime(b.Start), model.MustTime(b.End)
	d := e.dayOf(s)
	if d == nil {
		return false
	}
	return d.free(d.minuteOf(s, e.loc), d.minuteOf(en, e.loc))
}

func (e *engine) placeEvents(ex []model.Block) {
	status := map[string]string{}
	for _, b := range ex {
		if b.Kind == model.KindEvent {
			status[b.ID] = b.Status
		}
	}
	if len(e.days) == 0 {
		return
	}
	hStart, hEnd := e.days[0].date, e.days[len(e.days)-1].date.AddDate(0, 0, 1)
	for _, it := range e.sorted {
		if it.Type != model.TypeEvent {
			continue
		}
		s, en := model.MustTime(it.Start), model.MustTime(it.End)
		if s.IsZero() {
			continue
		}
		if en.IsZero() || !en.After(s) {
			en = s.Add(time.Hour)
		}
		if !en.After(hStart) || !s.Before(hEnd) || isAllDay(it, e.loc) {
			continue
		}
		key := model.DayKey(s, e.loc)
		b := model.Block{ID: blockID(it.ID, key, 0), ItemID: it.ID, Seq: 0, Start: model.FormatTime(s.In(e.loc)),
			End: model.FormatTime(en.In(e.loc)), Kind: model.KindEvent, Why: whyEvent, Status: model.StatusPlanned}
		if st, ok := status[b.ID]; ok && st != "" {
			b.Status = st
		}
		e.markTimes(s, en)
		e.out = append(e.out, b)
	}
}

// --- routines ---------------------------------------------------------------

func occursOn(spec *model.RoutineSpec, it model.Item, date time.Time, loc *time.Location) bool {
	r := spec.Recur
	if r.Until != "" {
		u := r.Until
		if len(u) > 10 {
			if t, err := time.Parse(time.RFC3339, u); err == nil {
				u = t.In(loc).Format("2006-01-02")
			} else {
				u = u[:10]
			}
		}
		if date.Format("2006-01-02") > u {
			return false
		}
	}
	interval := max(1, r.Interval)
	// Recurrence anchor: the item's Start day when given, else a fixed Sunday.
	anchor := time.Date(2000, 1, 2, 0, 0, 0, 0, loc)
	if t := model.MustTime(it.Start); !t.IsZero() {
		y, m, d := t.In(loc).Date()
		anchor = time.Date(y, m, d, 0, 0, 0, 0, loc)
		if date.Before(anchor) {
			return false
		}
	}
	days := civilDays(anchor, date)
	switch r.Freq {
	case "weekly":
		wd := int(date.Weekday())
		if len(r.Days) > 0 {
			ok := false
			for _, x := range r.Days {
				if x == wd {
					ok = true
				}
			}
			if !ok {
				return false
			}
		} else if wd != int(anchor.Weekday()) {
			return false
		}
		// weeks counted from the Sunday on/before the anchor
		weekStart := anchor.AddDate(0, 0, -int(anchor.Weekday()))
		return (civilDays(weekStart, date)/7)%interval == 0
	default: // daily
		return days%interval == 0
	}
}

func civilDays(a, b time.Time) int {
	ay, am, ad := a.Date()
	by, bm, bd := b.Date()
	ua := time.Date(ay, am, ad, 0, 0, 0, 0, time.UTC)
	ub := time.Date(by, bm, bd, 0, 0, 0, 0, time.UTC)
	return int(ub.Sub(ua).Hours() / 24)
}

func (e *engine) anchorMin(spec *model.RoutineSpec) int {
	switch spec.Anchor {
	case "morning":
		return e.p.WakeMin + 15
	case "daytime":
		if spec.AtMin != nil {
			return *spec.AtMin
		}
		return 13 * 60
	case "evening":
		return e.p.SleepMin - 90
	default:
		if spec.AtMin != nil {
			return *spec.AtMin
		}
		return 13 * 60
	}
}

func (e *engine) placeRoutines(ex []model.Block) {
	kept := map[string]bool{} // ID of done/skipped routine blocks already in out
	for _, b := range e.out {
		if b.Kind == model.KindRoutine {
			kept[b.ID] = true
		}
	}
	prior := map[string]model.Block{}
	for _, b := range ex {
		if b.Kind == model.KindRoutine && (b.Status == model.StatusDone || b.Status == model.StatusSkipped) {
			prior[b.ID] = b
		}
	}
	type entry struct {
		it   model.Item
		spec *model.RoutineSpec
	}
	groups := map[string][]entry{}
	var keys []string
	for _, it := range e.sorted {
		if it.Type != model.TypeRoutine || it.Routine == nil {
			continue
		}
		g := it.Routine.Group
		if g == "" {
			g = it.Routine.Anchor
		}
		if g == "time" || g == "" {
			g = "time:" + it.ID
		}
		if _, ok := groups[g]; !ok {
			keys = append(keys, g)
		}
		groups[g] = append(groups[g], entry{it, it.Routine})
	}
	for _, g := range keys {
		es := groups[g]
		sort.SliceStable(es, func(i, j int) bool {
			if es[i].spec.Order != es[j].spec.Order {
				return es[i].spec.Order < es[j].spec.Order
			}
			return es[i].it.ID < es[j].it.ID
		})
	}
	// Place groups by anchor time so earlier groups claim their spot first.
	sort.SliceStable(keys, func(i, j int) bool {
		ai, aj := e.anchorMin(groups[keys[i]][0].spec), e.anchorMin(groups[keys[j]][0].spec)
		if ai != aj {
			return ai < aj
		}
		return keys[i] < keys[j]
	})
	for _, d := range e.days {
		for _, g := range keys {
			var todays []entry
			total := 0
			for _, en := range groups[g] {
				if !occursOn(en.spec, en.it, d.date, e.loc) {
					continue
				}
				id := blockID(en.it.ID, d.key, 0)
				if kept[id] {
					continue
				}
				if b, ok := prior[id]; ok { // done/skipped already: keep, never re-place
					e.out = append(e.out, b)
					if b.Status == model.StatusDone {
						e.claim(b)
					}
					continue
				}
				todays = append(todays, en)
				total += max(1, en.spec.DurMin)
			}
			if len(todays) == 0 {
				continue
			}
			start := max(d.wake, e.anchorMin(todays[0].spec))
			found := -1
			for m := start; m+total <= d.sleep(); m = roundUp5(m + 1) {
				if d.free(m, m+total) {
					found = m
					break
				}
			}
			if found < 0 {
				e.warnings = append(e.warnings, fmt.Sprintf("No room for %s routines on %s.", g, d.key))
				continue
			}
			m := found
			for _, en := range todays {
				dur := max(1, en.spec.DurMin)
				b := model.Block{ID: blockID(en.it.ID, d.key, 0), ItemID: en.it.ID, Seq: 0,
					Start: model.FormatTime(model.AtMin(d.date, m, e.loc)), End: model.FormatTime(model.AtMin(d.date, m+dur, e.loc)),
					Kind: model.KindRoutine, Why: whyRoutine, Status: model.StatusPlanned}
				e.out = append(e.out, b)
				m += dur
			}
			d.mark(found, m)
		}
	}
}

// --- work demands -----------------------------------------------------------

type window struct {
	d      *day
	lo, hi int
}

// splitSizes splits rem into BlockMin blocks; a final block < 15 is merged.
func splitSizes(rem, blockMin int) []int {
	if rem <= 0 {
		return nil
	}
	n := ceilDiv(rem, blockMin)
	sizes := make([]int, n)
	for i := range sizes {
		sizes[i] = blockMin
	}
	sizes[n-1] = rem - (n-1)*blockMin
	if n > 1 && sizes[n-1] < 15 {
		sizes[n-2] += sizes[n-1]
		sizes = sizes[:n-1]
	}
	return sizes
}

func bufferFor(typ string) time.Duration {
	switch typ {
	case model.TypeExam:
		return 12 * time.Hour
	case model.TypeAssignment:
		return 2 * time.Hour
	default:
		return 24 * time.Hour
	}
}

func (e *engine) eligible(it model.Item) []window {
	dl := it.Deadline()
	latest := dl.Add(-bufferFor(it.Type)).In(e.loc)
	earliest := e.earliest
	if sb := model.MustTime(it.StartBy); sb.After(earliest) {
		earliest = sb.In(e.loc)
	}
	var ws []window
	for _, d := range e.days {
		lo, hi := max(d.wake, d.past), d.sleep()
		if m := d.minuteOf(earliest, e.loc); m > 1<<29 {
			continue
		} else if m > -1<<29 {
			lo = max(lo, roundUp5(m))
		}
		if m := d.minuteOf(latest, e.loc); m < -1<<29 {
			break
		} else if m < 1<<29 {
			hi = min(hi, m)
		}
		if hi-lo >= 15 {
			ws = append(ws, window{d, lo, hi})
		}
	}
	return ws
}

type placed struct {
	b      model.Block
	d      *day
	reason string
}

func (e *engine) placeDemand(it model.Item, rem int) {
	if rem <= 0 {
		return
	}
	if it.Deadline().IsZero() {
		e.warnings = append(e.warnings, fmt.Sprintf("%q has no deadline, so it is not scheduled.", it.Title))
		return
	}
	queue := splitSizes(rem, e.p.BlockMin)
	ws := e.eligible(it)
	if len(ws) == 0 {
		e.atRisk = append(e.atRisk, model.AtRisk{ItemID: it.ID, ShortMin: rem, Reason: "There is no time left before the deadline to fit this in."})
		return
	}
	var got []placed
	mainWs := ws
	// Spaced revision: the last 2 eligible days each get one refresher block.
	if it.Type == model.TypeExam && len(ws) >= 3 && len(queue) >= 3 {
		mainWs = ws[:len(ws)-2]
		for k := 0; k < 2; k++ {
			w := ws[len(ws)-2+k]
			size := queue[0]
			if p, ok := e.tryPlace(it, w, size, false); ok {
				p.reason = refresherWhy(it, w.d, e.loc)
				got = append(got, p)
				queue = queue[1:]
			}
		}
	}
	perDay := max(1, ceilDiv(len(queue), len(mainWs)))
	carry := 0
	for _, w := range mainWs {
		target, n := perDay+carry, 0
		for n < target && len(queue) > 0 {
			p, ok := e.tryPlace(it, w, queue[0], false)
			if !ok {
				break
			}
			got = append(got, p)
			queue = queue[1:]
			n++
		}
		carry = target - n
	}
	// Second pass: allow up to the hard max, flagged as forced.
	for _, w := range ws {
		for len(queue) > 0 {
			p, ok := e.tryPlace(it, w, queue[0], true)
			if !ok {
				break
			}
			got = append(got, p)
			queue = queue[1:]
		}
	}
	short := 0
	for _, s := range queue {
		short += s
	}
	if short > 0 {
		e.atRisk = append(e.atRisk, model.AtRisk{ItemID: it.ID, ShortMin: short,
			Reason: fmt.Sprintf("Short by %d min before the deadline, even counting busier days.", short)})
	}
	// Assign seqs in chronological order (reusing released seqs first).
	sort.SliceStable(got, func(i, j int) bool {
		return model.MustTime(got[i].b.Start).Before(model.MustTime(got[j].b.Start))
	})
	for _, p := range got {
		seq := 0
		if pool := e.seqPool[it.ID]; len(pool) > 0 {
			seq, e.seqPool[it.ID] = pool[0], pool[1:]
		} else {
			e.maxSeq[it.ID]++
			seq = e.maxSeq[it.ID]
			if seq == 0 {
				seq = 1
			}
		}
		if seq > e.maxSeq[it.ID] {
			e.maxSeq[it.ID] = seq
		}
		b := p.b
		b.Seq = seq
		b.ID = blockID(it.ID, p.d.key, seq)
		if p.reason != "" && !b.Forced {
			b.Why = p.reason
		}
		e.out = append(e.out, b)
	}
}

// tryPlace finds the best slot for one block in window w and claims it.
func (e *engine) tryPlace(it model.Item, w window, size int, forced bool) (placed, bool) {
	d := w.d
	limit := d.cap
	if forced {
		limit = d.hard
	}
	if d.work+size > limit {
		return placed{}, false
	}
	light := size <= 30
	best, bestRank := -1, 99
	for m := roundUp5(w.lo); m+size <= w.hi; m += slotMin {
		if !d.free(m, m+size) || !d.gapOK(m, m+size) {
			continue
		}
		if r := levelRank(e.p.LevelAt(m), light); r < bestRank {
			best, bestRank = m, r
		}
	}
	if best < 0 {
		return placed{}, false
	}
	d.mark(best, best+size)
	d.work += size
	d.workIv = append(d.workIv, [2]int{best, best + size})
	isForced := forced && d.work > d.cap
	b := model.Block{ItemID: it.ID, Start: model.FormatTime(model.AtMin(d.date, best, e.loc)),
		End: model.FormatTime(model.AtMin(d.date, best+size, e.loc)), Kind: model.KindWork,
		Status: model.StatusPlanned, Forced: isForced}
	b.Why = e.why(it, d, best, size, isForced)
	return placed{b: b, d: d}, true
}

func levelRank(level string, light bool) int {
	r := map[string]int{model.EnergyHigh: 0, model.EnergyMed: 1, model.EnergyLow: 2}[level]
	if light {
		return 2 - r
	}
	return r
}
