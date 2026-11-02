package postcard

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"testing"

	_ "time/tzdata"

	"arc/internal/model"
)

const day = "2026-11-03"

func blk(id, item, start, status string) model.Block {
	return model.Block{ID: id, ItemID: item, Start: start, End: start, Kind: model.KindWork, Status: status}
}

func at(d string, h int) string { return fmt.Sprintf("%sT%02d:00:00+11:00", d, h) }

func exampleReq() Request {
	return Request{
		Day:  day,
		Seed: "arc",
		Items: []model.Item{
			{ID: "chem", Type: model.TypeAssignment, Title: "Chem PS4"},
			{ID: "cream", Type: model.TypeRoutine, Title: "Cream", Doodle: "cream",
				Routine: &model.RoutineSpec{Group: "evening"}},
		},
		Blocks: []model.Block{
			blk("b1", "chem", at(day, 9), model.StatusDone),
			blk("b2", "chem", at(day, 13), model.StatusDone),
			blk("b3", "chem", at(day, 15), model.StatusDone),
			blk("b4", "cream", at(day, 21), model.StatusDone),
		},
	}
}

func mustCompose(t *testing.T, r Request) Result {
	t.Helper()
	res, err := Compose(r)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestExampleSummary(t *testing.T) {
	res := mustCompose(t, exampleReq())
	if want := "3 blocks of Chem, 1 hero cream moment."; res.Summary != want {
		t.Fatalf("summary = %q, want %q", res.Summary, want)
	}
	if res.Done != 4 || res.Sleeping != 0 {
		t.Fatalf("done/sleeping = %d/%d", res.Done, res.Sleeping)
	}
	if len(res.Stickers) != 2 {
		t.Fatalf("stickers = %d", len(res.Stickers))
	}
	s0, s1 := res.Stickers[0], res.Stickers[1]
	if s0.Label != "Chem PS4" || s0.Doodle != "flask" || s0.Color != "#B3D7F2" {
		t.Errorf("sticker0 = %+v", s0)
	}
	if s1.Label != "Cream" || s1.Doodle != "cream" || s1.Color != "#F7C8D3" {
		t.Errorf("sticker1 = %+v", s1)
	}
}

func TestDeterministic(t *testing.T) {
	a, _ := json.Marshal(mustCompose(t, exampleReq()))
	b, _ := json.Marshal(mustCompose(t, exampleReq()))
	if string(a) != string(b) {
		t.Fatalf("not deterministic:\n%s\n%s", a, b)
	}
}

func TestDifferentDayDifferentPositions(t *testing.T) {
	r1 := exampleReq()
	r2 := exampleReq()
	r2.Day = "2026-11-04"
	for i := range r2.Blocks {
		r2.Blocks[i].Start = strings.Replace(r2.Blocks[i].Start, day, r2.Day, 1)
	}
	a, b := mustCompose(t, r1), mustCompose(t, r2)
	if a.Stickers[0].X == b.Stickers[0].X && a.Stickers[0].Y == b.Stickers[0].Y {
		t.Fatalf("same position on different days: %+v", a.Stickers[0])
	}
}

func manyReq(n int) Request {
	r := Request{Day: day, Seed: "s"}
	types := []string{model.TypeExam, model.TypeAssignment, model.TypeProject, model.TypeEvent, model.TypeRoutine}
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("i%02d", i)
		r.Items = append(r.Items, model.Item{ID: id, Type: types[i%len(types)], Title: fmt.Sprintf("Thing%d stuff", i)})
		r.Blocks = append(r.Blocks, blk("b"+id, id, fmt.Sprintf("%sT%02d:%02d:00Z", day, 6+i/4, (i%4)*15), model.StatusDone))
	}
	return r
}

func TestBoundsAndRanges(t *testing.T) {
	for _, seed := range []string{"a", "b", "c", "d", "e"} {
		r := manyReq(15)
		r.Seed = seed
		res := mustCompose(t, r)
		if len(res.Stickers) != MaxStickers {
			t.Fatalf("stickers = %d, want %d", len(res.Stickers), MaxStickers)
		}
		for _, s := range res.Stickers {
			if s.X < MinX || s.X > MaxX || s.Y < MinY || s.Y > MaxY {
				t.Errorf("out of bounds: %+v", s)
			}
			if s.Rot < -14 || s.Rot > 14 {
				t.Errorf("rot out of range: %v", s.Rot)
			}
			if s.Scale < 0.85 || s.Scale > 1.15 {
				t.Errorf("scale out of range: %v", s.Scale)
			}
			if math.Round(s.X*10)/10 != s.X || math.Round(s.Rot*100)/100 != s.Rot {
				t.Errorf("not rounded: %+v", s)
			}
		}
	}
}

func TestMinDistanceMostlyRespected(t *testing.T) {
	ok, total := 0, 0
	for i := 0; i < 50; i++ {
		r := manyReq(6)
		r.Seed = fmt.Sprint(i)
		res := mustCompose(t, r)
		for a := range res.Stickers {
			for b := a + 1; b < len(res.Stickers); b++ {
				total++
				sa, sb := res.Stickers[a], res.Stickers[b]
				if math.Hypot(sa.X-sb.X, sa.Y-sb.Y) >= MinDist {
					ok++
				}
			}
		}
	}
	if float64(ok)/float64(total) < 0.95 {
		t.Fatalf("only %d/%d pairs >= %v apart", ok, total, MinDist)
	}
}

var forbidden = []string{"missed", "failed", "skipped", "behind", "lazy"}

func checkGentle(t *testing.T, s string) {
	t.Helper()
	if strings.TrimSpace(s) == "" {
		t.Fatal("empty summary")
	}
	low := strings.ToLower(s)
	for _, w := range forbidden {
		if strings.Contains(low, w) {
			t.Errorf("summary %q contains %q", s, w)
		}
	}
}

func TestEmptyDayGentle(t *testing.T) {
	seen := map[string]bool{}
	for d := 1; d <= 28; d++ {
		res := mustCompose(t, Request{Day: fmt.Sprintf("2026-02-%02d", d)})
		checkGentle(t, res.Summary)
		if len(res.Stickers) != 0 || res.Stickers == nil {
			t.Errorf("want empty non-nil stickers, got %v", res.Stickers)
		}
		seen[res.Summary] = true
	}
	if len(seen) < 2 {
		t.Errorf("expected variety across days, got %v", seen)
	}
}

func TestSleepingCountedGently(t *testing.T) {
	r := exampleReq()
	r.Blocks = append(r.Blocks, blk("s1", "chem", at(day, 17), model.StatusSkipped),
		blk("s2", "ghost", at(day, 18), model.StatusSkipped))
	res := mustCompose(t, r)
	if res.Sleeping != 2 || res.Done != 4 {
		t.Fatalf("done/sleeping = %d/%d", res.Done, res.Sleeping)
	}
	checkGentle(t, res.Summary)
	if !strings.HasPrefix(res.Summary, "3 blocks of Chem, 1 hero cream moment.") || !strings.Contains(res.Summary, "sleeping in") {
		t.Errorf("summary = %q", res.Summary)
	}
	empty := mustCompose(t, Request{Day: day, Blocks: []model.Block{blk("s", "x", at(day, 9), model.StatusSkipped)}})
	checkGentle(t, empty.Summary)
}

func TestOtherDaysAndMissingItemsIgnored(t *testing.T) {
	r := exampleReq()
	r.Blocks = append(r.Blocks,
		blk("o1", "chem", at("2026-11-02", 9), model.StatusDone),
		blk("o2", "chem", at("2026-11-04", 9), model.StatusSkipped),
		blk("m1", "nope", at(day, 10), model.StatusDone),
		blk("p1", "chem", at(day, 11), model.StatusPlanned),
		blk("e1", "chem", "", model.StatusDone),
	)
	res := mustCompose(t, r)
	if res.Summary != "3 blocks of Chem, 1 hero cream moment." || res.Done != 4 || res.Sleeping != 0 || len(res.Stickers) != 2 {
		t.Fatalf("got %+v", res)
	}
}

func TestSingularAndPhrases(t *testing.T) {
	r := Request{Day: day, Items: []model.Item{
		{ID: "a", Type: model.TypeExam, Title: "Stats exam"},
		{ID: "b", Type: model.TypeRoutine, Title: "Meds"},
		{ID: "c", Type: model.TypeRoutine, Title: "Stretch thing", Routine: &model.RoutineSpec{Group: "morning"}},
		{ID: "d", Type: model.TypeRoutine, Title: "Journal", Doodle: "pencil"},
		{ID: "e", Type: model.TypeEvent, Title: "Lecture hall"},
	}, Blocks: []model.Block{
		blk("1", "a", at(day, 8), model.StatusDone),
		blk("2", "b", at(day, 9), model.StatusDone),
		blk("3", "c", at(day, 10), model.StatusDone),
		blk("4", "d", at(day, 11), model.StatusDone),
		blk("5", "e", at(day, 12), model.StatusDone),
	}}
	res := mustCompose(t, r)
	if !strings.HasPrefix(res.Summary, "1 block of Stats, meds: handled") {
		t.Fatalf("summary = %q", res.Summary)
	}
	if len(res.Summary) > maxSummary+len(sleepingLine) {
		t.Errorf("summary too long: %q", res.Summary)
	}
	if res.Stickers[0].Color != "#FF84A2" || res.Stickers[2].Color != "#FDDEB2" || res.Stickers[4].Color != "#F0EFEF" {
		t.Errorf("colors: %+v", res.Stickers)
	}
}

func TestDefaultRoutineWinsAggregate(t *testing.T) {
	r := Request{Day: day, Items: []model.Item{
		{ID: "a", Type: model.TypeRoutine, Title: "Journal", Doodle: "pencil", Routine: &model.RoutineSpec{Group: "daytime"}},
		{ID: "b", Type: model.TypeRoutine, Title: "Floss", Doodle: "sparkle"},
		{ID: "c", Type: model.TypeProject, Title: "Project report"},
	}, Blocks: []model.Block{
		blk("1", "a", at(day, 8), model.StatusDone),
		blk("2", "b", at(day, 9), model.StatusDone),
		blk("3", "c", at(day, 10), model.StatusDone),
		blk("4", "c", at(day, 11), model.StatusDone),
	}}
	res := mustCompose(t, r)
	if want := "2 tiny routine wins, 2 blocks of Project."; res.Summary != want {
		t.Fatalf("summary = %q, want %q", res.Summary, want)
	}
	if res.Stickers[0].Color != "#FFF7E6" || res.Stickers[2].Color != "#A9B7C6" {
		t.Errorf("colors: %+v", res.Stickers)
	}
}

func TestLongSummaryTruncated(t *testing.T) {
	r := Request{Day: day}
	for i, title := range []string{"Organic chemistry", "Statistics paper", "Philosophy essay", "Linguistics reading", "Thermodynamics"} {
		id := fmt.Sprint(i)
		r.Items = append(r.Items, model.Item{ID: id, Type: model.TypeAssignment, Title: title})
		r.Blocks = append(r.Blocks, blk(id, id, at(day, 8+i), model.StatusDone))
	}
	res := mustCompose(t, r)
	if want := "1 block of Organic, 1 block of Statistics and more."; res.Summary != want {
		t.Fatalf("summary = %q, want %q", res.Summary, want)
	}
}

func TestOrderingAndShortName(t *testing.T) {
	r := Request{Day: day, Items: []model.Item{
		{ID: "z", Type: model.TypeAssignment, Title: "  Bio: lab "},
		{ID: "y", Type: model.TypeAssignment, Title: ""},
		{ID: "x", Type: model.TypeAssignment, Title: "--"},
	}, Blocks: []model.Block{
		blk("1", "z", at(day, 9), model.StatusDone),
		blk("2", "y", at(day, 9), model.StatusDone),
		blk("3", "x", at(day, 7), model.StatusDone),
		blk("4", "z", at(day, 6), model.StatusDone),
	}}
	res := mustCompose(t, r)
	got := []string{res.Stickers[0].Label, res.Stickers[1].Label, res.Stickers[2].Label}
	if got[0] != "  Bio: lab " || got[1] != "--" || got[2] != "" {
		t.Errorf("order = %q", got)
	}
	if want := "2 blocks of Bio, 1 block of --, 1 block of focus."; res.Summary != want {
		t.Errorf("summary = %q, want %q", res.Summary, want)
	}
}

func TestBadDay(t *testing.T) {
	for _, d := range []string{"", "2026-13-01", "Nov 3"} {
		if _, err := Compose(Request{Day: d}); err == nil {
			t.Errorf("day %q: want error", d)
		}
	}
}

func TestJSONShape(t *testing.T) {
	b, _ := json.Marshal(mustCompose(t, exampleReq()))
	for _, k := range []string{`"summary"`, `"stickers"`, `"done"`, `"sleeping"`, `"doodle"`, `"rot"`, `"scale"`, `"color"`, `"label"`} {
		if !strings.Contains(string(b), k) {
			t.Errorf("missing %s in %s", k, b)
		}
	}
}
