package ics

import (
	"strings"
	"testing"
	_ "time/tzdata"
	"unicode/utf8"

	"arc/internal/model"
)

func intp(v int) *int { return &v }

func sampleExport() ExportRequest {
	return ExportRequest{
		Now:     testNow,
		Profile: model.Profile{TZ: testTZ, WakeMin: 420, SleepMin: 1380},
		Include: []string{"events", "routines", "blocks"},
		Items: []model.Item{
			{ID: "e2", Type: "event", Title: "Dentist", Start: "2026-11-05T16:00:00+05:30", End: "2026-11-05T16:30:00+05:30"},
			{ID: "e1", Type: "event", Title: "a, b; c\\d\nnew line", Start: "2026-11-03T09:00:00+05:30", End: "2026-11-03T10:30:00+05:30"},
			{ID: "e0", Type: "event", Title: "Deleted", Start: "2026-11-03T09:00:00+05:30", End: "2026-11-03T10:00:00+05:30", Deleted: true},
			{ID: "x1", Type: "exam", Title: "Algorithms exam", Start: "2026-11-20T09:00:00+05:30"},
			{ID: "r1", Type: "routine", Title: "Vitamin D", Routine: &model.RoutineSpec{Anchor: "morning", DurMin: 2, Recur: model.Recur{Freq: "daily"}}},
			{ID: "r2", Type: "routine", Title: "Cream", Routine: &model.RoutineSpec{Anchor: "evening", DurMin: 0, Recur: model.Recur{Freq: "weekly", Interval: 2, Days: []int{5, 1, 1}, Until: "2026-12-31"}}},
			{ID: "r3", Type: "routine", Title: "Call home", Routine: &model.RoutineSpec{Anchor: "time", AtMin: intp(1200), DurMin: 20, Recur: model.Recur{Freq: "weekly", Days: []int{0}}}},
			{ID: "r4", Type: "routine", Title: "Old habit", Routine: &model.RoutineSpec{Anchor: "daytime", DurMin: 5, Recur: model.Recur{Freq: "daily", Until: "2026-10-01"}}},
		},
		Plan: model.Plan{Blocks: []model.Block{
			{ID: "b2", ItemID: "x1", Start: "2026-11-04T10:00:00+05:30", End: "2026-11-04T10:50:00+05:30", Kind: "work", Status: "planned"},
			{ID: "b1", ItemID: "x1", Start: "2026-11-03T10:00:00+05:30", End: "2026-11-03T10:50:00+05:30", Kind: "work", Status: "done"},
			{ID: "b3", ItemID: "x1", Start: "2026-11-03T12:00:00+05:30", End: "2026-11-03T12:50:00+05:30", Kind: "work", Status: "skipped"},
			{ID: "b4", ItemID: "r1", Start: "2026-11-03T07:15:00+05:30", End: "2026-11-03T07:17:00+05:30", Kind: "routine", Status: "planned"},
		}},
	}
}

func mustExport(t *testing.T, req ExportRequest) string {
	t.Helper()
	res, err := Export(req)
	if err != nil {
		t.Fatal(err)
	}
	return res.ICS
}

func TestExportStructureAndCRLF(t *testing.T) {
	out := mustExport(t, sampleExport())
	if !strings.HasPrefix(out, "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Arc//Arc Planner//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\n") {
		t.Fatalf("bad header:\n%s", out)
	}
	if !strings.HasSuffix(out, "END:VCALENDAR\r\n") {
		t.Fatal("bad footer")
	}
	b := []byte(out)
	for i, c := range b {
		if c == '\n' && (i == 0 || b[i-1] != '\r') {
			t.Fatalf("bare LF at byte %d", i)
		}
		if c == '\r' && (i+1 >= len(b) || b[i+1] != '\n') {
			t.Fatalf("bare CR at byte %d", i)
		}
	}
	for _, want := range []string{
		"UID:e1@arc\r\nDTSTAMP:20261102T043000Z\r\nDTSTART:20261103T033000Z\r\nDTEND:20261103T050000Z\r\nSUMMARY:a\\, b\\; c\\\\d\\nnew line\r\n",
		"UID:b1@arc\r\n",
		"UID:b2@arc\r\n",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q", want)
		}
	}
	for _, bad := range []string{"e0@arc", "b3@arc", "b4@arc", "r4@arc", "x1@arc", "LOCATION"} {
		if strings.Contains(out, bad) {
			t.Errorf("should not contain %q", bad)
		}
	}
	// Order: events (e1, e2), routines, blocks (b1, b2).
	order := []string{"UID:e1@arc", "UID:e2@arc", "UID:r1@arc", "UID:b1@arc", "UID:b2@arc"}
	last := -1
	for _, u := range order {
		i := strings.Index(out, u)
		if i <= last {
			t.Fatalf("order wrong at %s", u)
		}
		last = i
	}
	if n := strings.Count(out, "BEGIN:VEVENT"); n != 7 {
		t.Errorf("vevent count %d", n)
	}
}

func TestExportRoutines(t *testing.T) {
	req := sampleExport()
	req.Include = []string{"routines"}
	out := mustExport(t, req)
	// Vitamin D: morning = 07:15 IST today (Mon 2 Nov) = 01:45Z, 2 min.
	if !strings.Contains(out, "UID:r1@arc\r\nDTSTAMP:20261102T043000Z\r\nDTSTART:20261102T014500Z\r\nDTEND:20261102T014700Z\r\nRRULE:FREQ=DAILY\r\nSUMMARY:Vitamin D\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:PT0S\r\nDESCRIPTION:Vitamin D\r\nEND:VALARM\r\nEND:VEVENT\r\n") {
		t.Errorf("vitamin d block wrong:\n%s", out)
	}
	// Cream: evening = 21:30 IST, Mon (today) first; DurMin 0 -> 1 min.
	if !strings.Contains(out, "DTSTART:20261102T160000Z\r\nDTEND:20261102T160100Z\r\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;UNTIL=20261231T182959Z\r\n") {
		t.Errorf("cream block wrong:\n%s", out)
	}
	// Call home: 20:00 IST on the next Sunday (8 Nov).
	if !strings.Contains(out, "DTSTART:20261108T143000Z\r\nDTEND:20261108T145000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=SU\r\n") {
		t.Errorf("call home block wrong:\n%s", out)
	}
	if strings.Count(out, "BEGIN:VALARM") != 3 || strings.Count(out, "RRULE:") != 3 {
		t.Errorf("want 3 alarms and rrules:\n%s", out)
	}
}

func TestExportRoutineDSTZoneUsesTZID(t *testing.T) {
	req := ExportRequest{
		Now:     testNow,
		Profile: model.Profile{TZ: "America/New_York"},
		Include: []string{"routines"},
		Items: []model.Item{{ID: "r", Type: "routine", Title: "Stretch",
			Routine: &model.RoutineSpec{Anchor: "daytime", DurMin: 10, Recur: model.Recur{Freq: "daily"}}}},
	}
	out := mustExport(t, req)
	// now is 1 Nov 23:30 in New York; daytime default 13:00.
	if !strings.Contains(out, "DTSTART;TZID=America/New_York:20261101T130000\r\nDTEND;TZID=America/New_York:20261101T131000\r\n") {
		t.Fatalf("tzid routine wrong:\n%s", out)
	}
	// And it imports back at 13:00 wall clock on both sides of DST.
	res, err := Import(ImportRequest{ICS: out, TZ: "America/New_York", Now: testNow, HorizonDays: 150})
	if err != nil || len(res.Skipped) != 0 {
		t.Fatal(err, res.Skipped)
	}
	for _, it := range res.Items {
		if !strings.Contains(it.Start, "T13:00:00") {
			t.Fatalf("drift: %s", it.Start)
		}
	}
}

func TestExportFolding(t *testing.T) {
	long := strings.Repeat("Quantum mechanics revision with the whole study group. ", 4)[:200]
	multi := strings.Repeat("Café ☕ revision ", 10)
	req := ExportRequest{
		Now:     testNow,
		Profile: model.Profile{TZ: testTZ},
		Include: []string{"events"},
		Items: []model.Item{
			{ID: "long", Type: "event", Title: long, Start: "2026-11-03T09:00:00+05:30", End: "2026-11-03T10:00:00+05:30"},
			{ID: "multi", Type: "event", Title: multi, Start: "2026-11-04T09:00:00+05:30", End: "2026-11-04T10:00:00+05:30"},
		},
	}
	out := mustExport(t, req)
	phys := strings.Split(strings.TrimSuffix(out, "\r\n"), "\r\n")
	folded := 0
	for _, ln := range phys {
		if len(ln) > 75 {
			t.Errorf("line %d octets: %q", len(ln), ln)
		}
		if !utf8.ValidString(ln) {
			t.Errorf("split a UTF-8 sequence: %q", ln)
		}
		if strings.HasPrefix(ln, " ") {
			folded++
		}
	}
	if folded < 4 {
		t.Errorf("expected folding, got %d continuation lines", folded)
	}
	// Unfolding restores the titles exactly.
	var sums []string
	for _, ln := range unfold(out) {
		if strings.HasPrefix(ln, "SUMMARY:") {
			sums = append(sums, unescapeText(strings.TrimPrefix(ln, "SUMMARY:")))
		}
	}
	if len(sums) != 2 || sums[0] != long || sums[1] != multi {
		t.Fatalf("unfold mismatch: %q", sums)
	}
	res := mustImport(t, out)
	if len(res.Items) != 2 || res.Items[0].Title != long || res.Items[1].Title != multi {
		t.Fatalf("import mismatch: %+v", res.Items)
	}
}

func TestFoldExact(t *testing.T) {
	s := strings.Repeat("a", 75)
	if got := fold(s); got != s+"\r\n" {
		t.Errorf("75 octets should not fold: %q", got)
	}
	s = strings.Repeat("a", 76)
	if got := fold(s); got != strings.Repeat("a", 75)+"\r\n a\r\n" {
		t.Errorf("76 octets: %q", got)
	}
	s = strings.Repeat("a", 74) + "é" // é straddles octet 75/76
	if got := fold(s); got != strings.Repeat("a", 74)+"\r\n é\r\n" {
		t.Errorf("multibyte: %q", got)
	}
}

func TestExportImportRoundTrip(t *testing.T) {
	events := []model.Item{
		{ID: "a", Type: "event", Title: "Guest lecture: AI, ethics; society", Start: "2026-11-03T14:00:00+05:30", End: "2026-11-03T15:30:00+05:30"},
		{ID: "b", Type: "event", Title: "Café ☕ revision", Start: "2026-11-06T18:45:00+05:30", End: "2026-11-06T20:00:00+05:30"},
		{ID: "c", Type: "event", Title: "Line one\nline two \\ back", Start: "2026-12-01T00:00:00+05:30", End: "2026-12-02T00:00:00+05:30"},
	}
	out := mustExport(t, ExportRequest{Items: events, Profile: model.Profile{TZ: testTZ}, Include: []string{"events"}, Now: testNow})
	res := mustImport(t, out)
	if len(res.Items) != len(events) || len(res.Skipped) != 0 {
		t.Fatalf("got %+v", res)
	}
	for i, ev := range events {
		got := res.Items[i]
		if got.Title != ev.Title || got.Start != ev.Start || got.End != ev.End {
			t.Errorf("round trip %d:\n got %q %s %s\nwant %q %s %s", i, got.Title, got.Start, got.End, ev.Title, ev.Start, ev.End)
		}
	}
	// Re-exporting imported items is stable too (ids are deterministic).
	again := mustExport(t, ExportRequest{Items: res.Items, Profile: model.Profile{TZ: testTZ}, Include: []string{"events"}, Now: testNow})
	if res2 := mustImport(t, again); res2.Items[0].ID != mustImport(t, again).Items[0].ID {
		t.Error("unstable ids")
	}
}

func TestExportDeterministic(t *testing.T) {
	a := mustExport(t, sampleExport())
	b := mustExport(t, sampleExport())
	if a != b {
		t.Fatal("export not byte-identical")
	}
}

func TestExportDefaultsAndErrors(t *testing.T) {
	req := sampleExport()
	req.Include = nil
	out := mustExport(t, req)
	if !strings.Contains(out, "UID:e1@arc") || !strings.Contains(out, "UID:r1@arc") || strings.Contains(out, "UID:b1@arc") {
		t.Errorf("default include should be events+routines")
	}
	empty := mustExport(t, ExportRequest{Now: testNow})
	if empty != "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Arc//Arc Planner//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\nEND:VCALENDAR\r\n" {
		t.Errorf("empty calendar: %q", empty)
	}
	if _, err := Export(ExportRequest{}); err == nil {
		t.Error("expected missing now error")
	}
	if _, err := Export(ExportRequest{Now: "nope"}); err == nil {
		t.Error("expected bad now error")
	}
	if _, err := Export(ExportRequest{Now: testNow, Profile: model.Profile{TZ: "Bad/Zone"}}); err == nil {
		t.Error("expected bad tz error")
	}
	// Defaults for zero wake/sleep and items with bad times are tolerated.
	out = mustExport(t, ExportRequest{Now: testNow, Profile: model.Profile{TZ: testTZ}, Items: []model.Item{
		{ID: "m", Type: "routine", Title: "Meds", Routine: &model.RoutineSpec{Anchor: "morning", DurMin: 2, Recur: model.Recur{Freq: "daily", Until: "2027-01-01T00:00:00Z"}}},
		{ID: "n", Type: "routine", Title: "No spec"},
		{ID: "z", Type: "event", Title: "No start"},
		{ID: "h", Type: "event", Title: "No end", Start: "2026-11-03T09:00:00+05:30"},
	}})
	if !strings.Contains(out, "DTSTART:20261102T014500Z") || !strings.Contains(out, "UNTIL=20270101T000000Z") {
		t.Errorf("defaults wrong:\n%s", out)
	}
	if strings.Contains(out, "n@arc") || strings.Contains(out, "z@arc") {
		t.Errorf("invalid items exported:\n%s", out)
	}
	if !strings.Contains(out, "UID:h@arc\r\nDTSTAMP:20261102T043000Z\r\nDTSTART:20261103T033000Z\r\nSUMMARY:No end\r\n") {
		t.Errorf("no-end event wrong:\n%s", out)
	}
}
