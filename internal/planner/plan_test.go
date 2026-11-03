package planner

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"strings"
	"testing"
	"time"
	_ "time/tzdata"

	"arc/internal/model"
)

const testNow = "2026-11-02T10:00:00+05:30"

func kolkata() model.Profile {
	return model.Profile{
		TZ: "Asia/Kolkata", WakeMin: 420, SleepMin: 1380, AmbitionMin: 240, BlockMin: 50, OverloadFactor: 1.4,
		Energy: []model.EnergyWindow{{StartMin: 420, EndMin: 600, Level: "med"}, {StartMin: 600, EndMin: 780, Level: "high"}, {StartMin: 780, EndMin: 960, Level: "low"}, {StartMin: 960, EndMin: 1140, Level: "high"}, {StartMin: 1140, EndMin: 1380, Level: "low"}},
	}
}

func intp(v int) *int { return &v }

func mustPlan(t *testing.T, req PlanRequest) model.Plan {
	t.Helper()
	p, err := Plan(req)
	if err != nil {
		t.Fatal(err)
	}
	checkInvariants(t, req.Items, req.Profile, req.Now, req.Existing, p)
	again, _ := Plan(req)
	a, _ := json.Marshal(p)
	b, _ := json.Marshal(again)
	if string(a) != string(b) {
		t.Errorf("plan is not deterministic")
	}
	return p
}

// checkInvariants asserts SPEC section 6 invariants for a plan.
func checkInvariants(t *testing.T, items []model.Item, prof model.Profile, nowS string, existing []model.Block, p model.Plan) {
	t.Helper()
	prof = prof.Defaults()
	loc, _ := model.LoadTZ(prof.TZ)
	byID := map[string]model.Item{}
	for _, it := range items {
		byID[it.ID] = it
	}
	act := func(b model.Block) bool { return b.Status == model.StatusPlanned || b.Status == model.StatusDone }
	var events []model.Block
	for _, b := range p.Blocks {
		if b.Why == "" || strings.Count(b.Why, ".") < 1 {
			t.Errorf("block %s has no why sentence", b.ID)
		}
		if b.Kind == model.KindEvent && act(b) {
			events = append(events, b)
		}
	}
	seen := map[string]bool{}
	for i, a := range p.Blocks {
		if seen[a.ID] {
			t.Errorf("duplicate block id %s", a.ID)
		}
		seen[a.ID] = true
		if !act(a) {
			continue
		}
		if a.Kind != model.KindEvent {
			s, e := model.MustTime(a.Start).In(loc), model.MustTime(a.End).In(loc)
			sm, em := model.MinOfDay(s, loc), model.MinOfDay(e, loc)
			sleep := prof.SleepMin
			if sleep <= prof.WakeMin {
				sleep += 24 * 60
			}
			if sm < prof.WakeMin {
				sm += 24 * 60
			}
			if em < prof.WakeMin || model.DayKey(s, loc) != model.DayKey(e, loc) {
				em += 24 * 60
			}
			if em < sm || sm < prof.WakeMin || em > sleep {
				t.Errorf("block %s %s..%s outside wake..sleep", a.ItemID, a.Start, a.End)
			}
			for _, ev := range events {
				if overlaps(a, ev) {
					t.Errorf("block %s overlaps event %s", a.ItemID, ev.ItemID)
				}
			}
		}
		for _, b := range p.Blocks[i+1:] {
			if !act(b) || (a.Kind == model.KindEvent && b.Kind == model.KindEvent) {
				continue
			}
			if overlaps(a, b) {
				t.Errorf("overlap: %s(%s %s) and %s(%s %s)", a.ItemID, a.Start, a.End, b.ItemID, b.Start, b.End)
			}
		}
	}
	// per-item sums and buffers
	placed := map[string]int{}
	for _, b := range p.Blocks {
		if b.Kind != model.KindWork {
			continue
		}
		if b.Status == model.StatusPlanned || b.Status == model.StatusSkipped {
			placed[b.ItemID] += minutes(b)
		}
		it := byID[b.ItemID]
		if b.Status == model.StatusPlanned && it.IsWork() && model.MustTime(b.End).After(it.Deadline().Add(-bufferFor(it.Type))) {
			if !model.MustTime(b.Start).Before(model.MustTime(nowS)) {
				t.Errorf("block for %s ends %s inside the %s buffer", it.ID, b.End, it.Type)
			}
		}
	}
	doneBlk := map[string]int{}
	for _, b := range existing {
		if b.Kind == model.KindWork && b.Status == model.StatusDone {
			doneBlk[b.ItemID] += minutes(b)
		}
	}
	short := map[string]int{}
	for _, r := range p.AtRisk {
		short[r.ItemID] += r.ShortMin
	}
	for _, it := range items {
		if !it.IsWork() || it.Done || it.Deleted || it.Deadline().IsZero() {
			continue
		}
		if got, want := placed[it.ID]+short[it.ID], remaining(it, doneBlk[it.ID]); got != want {
			t.Errorf("item %s: placed %d + short %d != remaining %d", it.ID, placed[it.ID], short[it.ID], want)
		}
	}
	// day capacity
	work, forced := map[string]int{}, map[string]bool{}
	for _, b := range p.Blocks {
		if b.Kind == model.KindWork && act(b) {
			k := model.DayKey(model.MustTime(b.Start), loc)
			work[k] += minutes(b)
			forced[k] = forced[k] || b.Forced
		}
	}
	for k, w := range work {
		base := prof.AmbitionMin
		if v, ok := prof.DayOverrides[k]; ok {
			base = v
		}
		hard := int(float64(base) * prof.OverloadFactor)
		if w > hard {
			t.Errorf("day %s work %d > hard max %d", k, w, hard)
		}
		if !forced[k] && w > base {
			t.Errorf("day %s work %d > capacity %d without a forced block", k, w, base)
		}
	}
}

func TestOvernightAwakeWindow(t *testing.T) {
	profile := model.Profile{
		TZ: "Asia/Kolkata", WakeMin: 6 * 60, SleepMin: 60, AmbitionMin: 240,
		BlockMin: 50, OverloadFactor: 1.4,
		Energy: []model.EnergyWindow{{StartMin: 20 * 60, EndMin: 25 * 60, Level: model.EnergyHigh}},
	}
	item := model.Item{ID: "night-routine", Type: model.TypeRoutine, Title: "Wind down",
		Routine: &model.RoutineSpec{Anchor: "evening", DurMin: 10, Recur: model.Recur{Freq: "daily"}}}
	work := model.Item{ID: "night-work", Type: model.TypeExam, Title: "Early exam prep",
		Start: "2026-11-04T09:00:00+05:30", EffortMin: 30}
	event := model.Item{ID: "evening-event", Type: model.TypeEvent, Title: "Evening event",
		Start: "2026-11-02T18:00:00+05:30", End: "2026-11-03T00:30:00+05:30"}
	plan := mustPlan(t, PlanRequest{Items: []model.Item{item}, Profile: profile, Now: "2026-11-02T18:00:00+05:30", HorizonDays: 2})
	loc, err := time.LoadLocation(profile.TZ)
	if err != nil {
		t.Fatal(err)
	}
	var foundToday bool
	for _, block := range plan.Blocks {
		if block.ItemID == item.ID {
			start := model.MustTime(block.Start).In(loc)
			if start.Hour() != 23 || start.Minute() != 30 {
				t.Fatalf("overnight routine starts at %s, want 23:30", block.Start)
			}
			if model.DayKey(start, loc) == "2026-11-02" {
				foundToday = true
			}
		}
	}
	if !foundToday {
		t.Fatal("overnight routine was not planned on the first waking day")
	}
	plan = mustPlan(t, PlanRequest{Items: []model.Item{work, event}, Profile: profile, Now: "2026-11-02T18:00:00+05:30", HorizonDays: 2})
	foundAfterMidnight := false
	for _, block := range plan.Blocks {
		if block.ItemID != work.ID {
			continue
		}
		start := model.MustTime(block.Start).In(loc)
		foundAfterMidnight = start.Hour() == 0 && start.Minute() == 30 && model.DayKey(start, loc) == "2026-11-03"
	}
	if !foundAfterMidnight {
		t.Fatal("planner did not place work in the 00:30 energy window")
	}
	if got := profile.LevelAt(24*60 + 30); got != model.EnergyHigh {
		t.Fatalf("overnight energy level = %q, want high", got)
	}
}

func TestExam12hTenDaysOut(t *testing.T) {
	exam := model.Item{ID: "stats", Type: model.TypeExam, Title: "Stats exam", Start: "2026-11-12T09:00:00+05:30", EffortMin: 720}
	p := mustPlan(t, PlanRequest{Items: []model.Item{exam}, Profile: kolkata(), Now: testNow})
	loc, _ := time.LoadLocation("Asia/Kolkata")
	sum, perDay := 0, map[string]int{}
	for _, b := range p.Blocks {
		if b.Kind != model.KindWork {
			continue
		}
		sum += minutes(b)
		perDay[model.DayKey(model.MustTime(b.Start), loc)] += minutes(b)
		if model.MustTime(b.End).After(model.MustTime(exam.Start).Add(-12 * time.Hour)) {
			t.Errorf("block %s within 12h of exam", b.Start)
		}
	}
	if sum != 720 {
		t.Fatalf("sum %d want 720", sum)
	}
	for d, m := range perDay {
		if m > 240 {
			t.Errorf("%s has %d min", d, m)
		}
	}
	// last 2 eligible days: Nov 10 and Nov 11 (exam Nov 12 09:00, 12h buffer = Nov 11 21:00)
	for _, d := range []string{"2026-11-10", "2026-11-11"} {
		found := false
		for _, b := range p.Blocks {
			if b.Kind == model.KindWork && model.DayKey(model.MustTime(b.Start), loc) == d && strings.Contains(b.Why, "refresher") {
				found = true
			}
		}
		if !found {
			t.Errorf("no refresher on %s", d)
		}
	}
	if len(p.AtRisk) != 0 {
		t.Errorf("unexpected at risk %+v", p.AtRisk)
	}
}

func TestDeadlineCrunchForcedAndAtRisk(t *testing.T) {
	a := model.Item{ID: "essay", Type: model.TypeAssignment, Title: "Essay", Due: "2026-11-03T12:00:00+05:30", EffortMin: 900}
	p := mustPlan(t, PlanRequest{Items: []model.Item{a}, Profile: kolkata(), Now: testNow})
	forced := 0
	for _, b := range p.Blocks {
		if b.Forced {
			forced++
			if b.Why != whyForced {
				t.Errorf("forced block why %q", b.Why)
			}
		}
	}
	if forced == 0 {
		t.Errorf("expected forced blocks")
	}
	if len(p.AtRisk) != 1 || p.AtRisk[0].ShortMin <= 0 {
		t.Fatalf("expected at-risk, got %+v", p.AtRisk)
	}
}

func TestOverloadedDayForcedFlagged(t *testing.T) {
	prof := kolkata()
	prof.DayOverrides = map[string]int{"2026-11-02": 60}
	a := model.Item{ID: "ps", Type: model.TypeAssignment, Title: "PS", Due: "2026-11-02T23:00:00+05:30", EffortMin: 80}
	p := mustPlan(t, PlanRequest{Items: []model.Item{a}, Profile: prof, Now: testNow})
	var flagged bool
	for _, b := range p.Blocks {
		if b.Kind == model.KindWork && b.Forced {
			flagged = true
		}
	}
	if !flagged {
		t.Fatalf("expected a forced block on the light day: %+v", p.Blocks)
	}
}

func TestEmptyDays(t *testing.T) {
	p := mustPlan(t, PlanRequest{Profile: kolkata(), Now: testNow})
	if len(p.Blocks) != 0 || len(p.AtRisk) != 0 {
		t.Fatalf("expected empty plan, got %+v", p)
	}
	b, _ := json.Marshal(p)
	if !strings.Contains(string(b), `"blocks":[]`) {
		t.Errorf("empty blocks should encode as []: %s", b)
	}
}

func TestBackToBackExams(t *testing.T) {
	items := []model.Item{
		{ID: "e1", Type: model.TypeExam, Title: "Chem exam", Start: "2026-11-09T09:00:00+05:30", EffortMin: 600},
		{ID: "e2", Type: model.TypeExam, Title: "Stats exam", Start: "2026-11-10T09:00:00+05:30", EffortMin: 600},
	}
	p := mustPlan(t, PlanRequest{Items: items, Profile: kolkata(), Now: testNow})
	if len(p.AtRisk) != 0 {
		t.Errorf("at risk: %+v", p.AtRisk)
	}
}

func TestEventBlocksPeakWindow(t *testing.T) {
	ev := model.Item{ID: "lec", Type: model.TypeEvent, Title: "Lecture", Start: "2026-11-02T10:00:00+05:30", End: "2026-11-02T13:00:00+05:30"}
	a := model.Item{ID: "ps", Type: model.TypeAssignment, Title: "Chem PS4", Due: "2026-11-03T08:00:00+05:30", EffortMin: 100}
	p := mustPlan(t, PlanRequest{Items: []model.Item{ev, a}, Profile: kolkata(), Now: testNow})
	n := 0
	for _, b := range p.Blocks {
		if b.Kind == model.KindWork {
			n++
			if s := model.MustTime(b.Start); s.Before(model.MustTime(ev.End)) {
				t.Errorf("work at %s should wait until the lecture ends", b.Start)
			}
		}
		if b.Kind == model.KindEvent && b.Why != whyEvent {
			t.Errorf("event why %q", b.Why)
		}
	}
	if n != 2 {
		t.Fatalf("want 2 work blocks, got %d", n)
	}
}

func TestDSTFallBack(t *testing.T) {
	prof := model.Profile{TZ: "America/New_York", WakeMin: 480, SleepMin: 1320, AmbitionMin: 240, BlockMin: 50, OverloadFactor: 1.4}
	a := model.Item{ID: "x", Type: model.TypeAssignment, Title: "Essay", Due: "2026-11-03T12:00:00-05:00", EffortMin: 400}
	r := model.Item{ID: "r", Type: model.TypeRoutine, Title: "Meds", Routine: &model.RoutineSpec{Anchor: "morning", DurMin: 2, Recur: model.Recur{Freq: "daily"}}}
	now := "2026-10-31T09:00:00-04:00"
	p := mustPlan(t, PlanRequest{Items: []model.Item{a, r}, Profile: prof, Now: now})
	for _, b := range p.Blocks {
		if b.Kind == model.KindRoutine && strings.HasPrefix(b.Start, "2026-11-01") {
			if b.Start != "2026-11-01T08:15:00-05:00" {
				t.Errorf("DST day routine at %s, want 08:15 EST", b.Start)
			}
		}
		if b.Kind == model.KindRoutine && strings.HasPrefix(b.Start, "2026-10-31") && b.Start != "2026-10-31T08:15:00-04:00" {
			t.Errorf("pre-DST routine at %s", b.Start)
		}
	}
}

func TestRoutineRecurrence(t *testing.T) {
	items := []model.Item{
		{ID: "gym", Type: model.TypeRoutine, Title: "Gym", Start: "2026-11-02T00:00:00+05:30",
			Routine: &model.RoutineSpec{Anchor: "time", AtMin: intp(1080), DurMin: 45, Recur: model.Recur{Freq: "weekly", Interval: 2, Days: []int{1, 4}, Until: "2026-11-30"}}},
		{ID: "a", Type: model.TypeRoutine, Title: "Wake up", Routine: &model.RoutineSpec{Anchor: "morning", Group: "morning", Order: 0, DurMin: 2, Recur: model.Recur{Freq: "daily"}}},
		{ID: "b", Type: model.TypeRoutine, Title: "Make bed", Routine: &model.RoutineSpec{Anchor: "morning", Group: "morning", Order: 1, DurMin: 2, Recur: model.Recur{Freq: "daily"}}},
		{ID: "c", Type: model.TypeRoutine, Title: "Cream", Routine: &model.RoutineSpec{Anchor: "evening", DurMin: 2, Recur: model.Recur{Freq: "daily", Interval: 2}}},
	}
	p := mustPlan(t, PlanRequest{Items: items, Profile: kolkata(), Now: testNow, HorizonDays: 35})
	gymDays := []string{}
	var wake, bed string
	creamDays := 0
	for _, b := range p.Blocks {
		switch b.ItemID {
		case "gym":
			gymDays = append(gymDays, b.Start[:10])
			if !strings.HasSuffix(b.Start, "T18:00:00+05:30") {
				t.Errorf("gym at %s", b.Start)
			}
		case "a":
			if wake == "" {
				wake = b.Start
			}
		case "b":
			if bed == "" {
				bed = b.Start
			}
		case "c":
			creamDays++
		}
	}
	want := []string{"2026-11-02", "2026-11-05", "2026-11-16", "2026-11-19", "2026-11-30"} // Until is inclusive
	if fmt.Sprint(gymDays) != fmt.Sprint(want) {
		t.Errorf("gym days %v want %v", gymDays, want)
	}
	if wake != "2026-11-02T07:15:00+05:30" || bed != "2026-11-02T07:17:00+05:30" {
		t.Errorf("group packing: wake %s bed %s", wake, bed)
	}
	if creamDays < 17 || creamDays > 18 {
		t.Errorf("every-other-day cream: %d days in 35", creamDays)
	}
}

func TestStableReplanWithExisting(t *testing.T) {
	items := sampleItems()
	p1 := mustPlan(t, PlanRequest{Items: items, Profile: kolkata(), Now: testNow})
	p2 := mustPlan(t, PlanRequest{Items: items, Profile: kolkata(), Now: testNow, Existing: p1.Blocks})
	a, _ := json.Marshal(p1.Blocks)
	b, _ := json.Marshal(p2.Blocks)
	if string(a) != string(b) {
		t.Fatalf("plan with its own blocks as existing should be unchanged")
	}
	// Adding a new item must not move existing blocks.
	items = append(items, model.Item{ID: "new", Type: model.TypeAssignment, Title: "Quiz prep", Due: "2026-11-04T12:00:00+05:30", EffortMin: 100})
	p3 := mustPlan(t, PlanRequest{Items: items, Profile: kolkata(), Now: testNow, Existing: p1.Blocks})
	keep := map[string]string{}
	for _, b := range p3.Blocks {
		keep[b.ID] = b.Start
	}
	for _, b := range p1.Blocks {
		if b.Kind == model.KindWork && keep[b.ID] != b.Start {
			t.Errorf("block %s moved silently", b.ID)
		}
	}
}

func sampleItems() []model.Item {
	return []model.Item{
		{ID: "lec", Type: model.TypeEvent, Title: "Lecture", Start: "2026-11-02T11:00:00+05:30", End: "2026-11-02T12:00:00+05:30"},
		{ID: "ps4", Type: model.TypeAssignment, Title: "Chem PS4", Due: "2026-11-06T23:59:00+05:30", EffortMin: 240},
		{ID: "stats", Type: model.TypeExam, Title: "Stats exam", Start: "2026-11-12T09:00:00+05:30", EffortMin: 720},
		{ID: "proj", Type: model.TypeProject, Title: "Project report", Due: "2026-11-16T23:59:00+05:30", EffortMin: 600},
		{ID: "meds", Type: model.TypeRoutine, Title: "Meds", Routine: &model.RoutineSpec{Anchor: "morning", Group: "morning", Order: 2, DurMin: 2, Recur: model.Recur{Freq: "daily"}}},
		{ID: "cream", Type: model.TypeRoutine, Title: "Cream", Routine: &model.RoutineSpec{Anchor: "evening", Group: "evening", DurMin: 2, Recur: model.Recur{Freq: "daily"}}},
	}
}

func TestStartByRespected(t *testing.T) {
	a := model.Item{ID: "p", Type: model.TypeProject, Title: "P", Due: "2026-11-20T23:59:00+05:30", StartBy: "2026-11-10T00:00:00+05:30", EffortMin: 200}
	p := mustPlan(t, PlanRequest{Items: []model.Item{a}, Profile: kolkata(), Now: testNow})
	for _, b := range p.Blocks {
		if b.Start < "2026-11-10" {
			t.Errorf("block before StartBy: %s", b.Start)
		}
	}
}

// Property test: invariants hold over generated inputs.
func TestInvariantsGenerated(t *testing.T) {
	r := rand.New(rand.NewSource(7))
	types := []string{model.TypeExam, model.TypeAssignment, model.TypeProject}
	for n := 0; n < 150; n++ {
		prof := kolkata()
		prof.AmbitionMin = 60 + r.Intn(8)*30
		prof.BlockMin = []int{25, 45, 50, 60, 90}[r.Intn(5)]
		if r.Intn(3) == 0 {
			prof.DayOverrides = map[string]int{"2026-11-03": r.Intn(5) * 60}
		}
		base := model.MustTime(testNow)
		var items []model.Item
		for i := 0; i < 1+r.Intn(6); i++ {
			typ := types[r.Intn(3)]
			dl := base.Add(time.Duration(2+r.Intn(20*24)) * time.Hour).Truncate(5 * time.Minute)
			it := model.Item{ID: fmt.Sprintf("i%d", i), Type: typ, Title: "x", EffortMin: 15 + r.Intn(40)*15, DoneMin: r.Intn(3) * 20}
			if typ == model.TypeExam {
				it.Start = model.FormatTime(dl)
			} else {
				it.Due = model.FormatTime(dl)
			}
			items = append(items, it)
		}
		for i := 0; i < r.Intn(4); i++ {
			s := base.Add(time.Duration(r.Intn(6*24)) * time.Hour).Truncate(5 * time.Minute)
			items = append(items, model.Item{ID: fmt.Sprintf("ev%d", i), Type: model.TypeEvent, Title: "ev",
				Start: model.FormatTime(s), End: model.FormatTime(s.Add(time.Duration(30+r.Intn(5)*30) * time.Minute))})
		}
		if r.Intn(2) == 0 {
			items = append(items, model.Item{ID: "rt", Type: model.TypeRoutine, Title: "Meds",
				Routine: &model.RoutineSpec{Anchor: []string{"morning", "daytime", "evening"}[r.Intn(3)], DurMin: 2 + r.Intn(20), Recur: model.Recur{Freq: "daily"}}})
		}
		t.Run(fmt.Sprint(n), func(t *testing.T) {
			p := mustPlan(t, PlanRequest{Items: items, Profile: prof, Now: testNow})
			// replanning the result and applying everything must keep invariants too
			res, err := Replan(ReplanRequest{Items: items, Profile: prof, Now: testNow, Current: p})
			if err != nil {
				t.Fatal(err)
			}
			checkInvariants(t, items, prof, testNow, nil, res.Proposed)
		})
	}
}

func TestErrors(t *testing.T) {
	if _, err := Plan(PlanRequest{Now: "nope"}); err == nil {
		t.Error("bad now accepted")
	}
	if _, err := Plan(PlanRequest{Now: testNow, Profile: model.Profile{TZ: "Mars/Base"}}); err == nil {
		t.Error("bad tz accepted")
	}
	out := model.Handle("{bad json", func(r PlanRequest) (model.Plan, error) { return Plan(r) })
	if !strings.Contains(out, `"ok":false`) {
		t.Errorf("bad json: %s", out)
	}
	out = model.Handle("{}", func(r PlanRequest) (model.Plan, error) { panic("boom") })
	if !strings.Contains(out, `"code":"internal"`) {
		t.Errorf("panic not recovered: %s", out)
	}
}

func TestHelpers(t *testing.T) {
	if hoursText(240) != "4 h" || hoursText(270) != "4.5 h" || hoursText(45) != "45 min" {
		t.Error("hoursText")
	}
	if ordinal(1) != "1st" || ordinal(12) != "12th" || ordinal(16) != "16th" || ordinal(23) != "23rd" {
		t.Error("ordinal")
	}
	if fmt.Sprint(splitSizes(110, 50)) != "[50 60]" || fmt.Sprint(splitSizes(120, 50)) != "[50 50 20]" {
		t.Errorf("splitSizes %v %v", splitSizes(110, 50), splitSizes(120, 50))
	}
}
