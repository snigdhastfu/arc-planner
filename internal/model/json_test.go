package model

import (
	"errors"
	"strings"
	"testing"
	"time"
	_ "time/tzdata"
)

func TestHandleEnvelope(t *testing.T) {
	ok := Handle(`{"a":1}`, func(in map[string]int) (int, error) { return in["a"] + 1, nil })
	if ok != `{"ok":true,"data":2}` {
		t.Errorf("ok envelope: %s", ok)
	}
	bad := Handle(`{`, func(in map[string]int) (int, error) { return 0, nil })
	if !strings.Contains(bad, `"code":"bad_request"`) {
		t.Errorf("bad json: %s", bad)
	}
	coded := Handle(``, func(in struct{}) (int, error) { return 0, Errf("nope", "no %d", 1) })
	if coded != `{"ok":false,"error":{"code":"nope","message":"no 1"}}` {
		t.Errorf("coded: %s", coded)
	}
	plain := Handle(``, func(in struct{}) (int, error) { return 0, errors.New("x") })
	if !strings.Contains(plain, `"code":"error"`) {
		t.Errorf("plain: %s", plain)
	}
	panicky := Handle(``, func(in struct{}) (int, error) { panic("boom") })
	if !strings.Contains(panicky, `"code":"internal"`) {
		t.Errorf("panic: %s", panicky)
	}
}

func TestTimeHelpers(t *testing.T) {
	loc, err := LoadTZ("Asia/Kolkata")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := LoadTZ("Nope/Nope"); err == nil {
		t.Error("bad tz accepted")
	}
	if l, _ := LoadTZ(""); l != time.UTC {
		t.Error("empty tz should be UTC")
	}
	now := MustTime("2026-11-02T10:00:00+05:30")
	if DayKey(now, loc) != "2026-11-02" || MinOfDay(now, loc) != 600 {
		t.Error("day key / min of day")
	}
	if got := FormatTime(AtMin(now, 975, loc)); got != "2026-11-02T16:15:00+05:30" {
		t.Errorf("AtMin: %s", got)
	}
	if _, err := ParseTime("garbage"); err == nil {
		t.Error("bad time accepted")
	}
	if !MustTime("").IsZero() {
		t.Error("empty time should be zero")
	}
}

func TestProfileDefaultsAndLevels(t *testing.T) {
	p := Profile{Energy: []EnergyWindow{{StartMin: 600, EndMin: 700, Level: "high"}, {StartMin: 420, EndMin: 500, Level: "low"}}}.Defaults()
	if p.WakeMin != 420 || p.SleepMin != 1380 || p.AmbitionMin != 240 || p.BlockMin != 50 || p.OverloadFactor != 1.4 || p.TZ != "UTC" {
		t.Errorf("defaults: %+v", p)
	}
	if p.Energy[0].StartMin != 420 {
		t.Error("energy not sorted")
	}
	if p.LevelAt(650) != "high" || p.LevelAt(450) != "low" || p.LevelAt(550) != "med" {
		t.Error("LevelAt")
	}
	it := Item{Type: TypeExam, Start: "2026-11-12T09:00:00+05:30"}
	if !it.Deadline().Equal(MustTime(it.Start)) || !it.IsWork() {
		t.Error("exam deadline")
	}
	bs := []Block{{ID: "b", Start: "2026-11-02T10:00:00Z"}, {ID: "a", Start: "2026-11-02T10:00:00Z"}, {ID: "c", Start: "2026-11-02T09:00:00Z"}}
	SortBlocks(bs)
	if bs[0].ID != "c" || bs[1].ID != "a" {
		t.Errorf("sort: %v", bs)
	}
}
