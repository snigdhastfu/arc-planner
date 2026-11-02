package ics

import (
	"reflect"
	"strings"
	"testing"
	"time"
	_ "time/tzdata"
)

// A sample university timetable as a typical campus system would export it.
var timetableICS = crlf(`BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Uni//Timetable//EN
BEGIN:VTIMEZONE
TZID:Asia/Kolkata
BEGIN:STANDARD
DTSTART:19700101T000000
TZOFFSETFROM:+0530
TZOFFSETTO:+0530
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:cs201-lecture@uni.example
DTSTAMP:20260901T000000Z
DTSTART;TZID=Asia/Kolkata:20261005T090000
DTEND;TZID=Asia/Kolkata:20261005T100000
RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261202T235959Z
EXDATE;TZID=Asia/Kolkata:20261111T090000
SUMMARY:CS201 Algorithms lecture
LOCATION:LT-2\, Science Block
END:VEVENT
BEGIN:VEVENT
UID:phy-lab@uni.example
DTSTART;TZID=Asia/Kolkata:20261027T140000
DURATION:PT2H
RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;COUNT=4
SUMMARY:Physics lab
END:VEVENT
END:VCALENDAR`)

func TestUniversityTimetable(t *testing.T) {
	res := mustImport(t, timetableICS)
	if len(res.Skipped) != 0 {
		t.Fatalf("skipped: %+v", res.Skipped)
	}
	var lectures, labs []string
	series := map[string]bool{}
	for _, it := range res.Items {
		if it.Type != "event" || it.DoodleSource != "auto" || it.Doodle == "" {
			t.Errorf("bad item meta: %+v", it)
		}
		if !strings.HasPrefix(it.ID, "ics-") || len(it.ID) != 16 {
			t.Errorf("bad id %q", it.ID)
		}
		series[it.SeriesID] = true
		switch it.Title {
		case "CS201 Algorithms lecture":
			lectures = append(lectures, it.Start)
			if it.Notes != "LT-2, Science Block" {
				t.Errorf("notes %q", it.Notes)
			}
			if mustT(it.End).Sub(mustT(it.Start)) != time.Hour {
				t.Errorf("lecture length %s..%s", it.Start, it.End)
			}
		case "Physics lab":
			labs = append(labs, it.Start+"/"+it.End)
		}
	}
	wantLect := []string{
		"2026-11-02T09:00:00+05:30", "2026-11-04T09:00:00+05:30", "2026-11-09T09:00:00+05:30",
		// 11 Nov removed by EXDATE
		"2026-11-16T09:00:00+05:30", "2026-11-18T09:00:00+05:30", "2026-11-23T09:00:00+05:30",
		"2026-11-25T09:00:00+05:30", "2026-11-30T09:00:00+05:30", "2026-12-02T09:00:00+05:30",
	}
	if !reflect.DeepEqual(lectures, wantLect) {
		t.Errorf("lectures:\n got %v\nwant %v", lectures, wantLect)
	}
	// COUNT=4 from 27 Oct every 2 weeks: 27 Oct (past), 10 Nov, 24 Nov, 8 Dec.
	wantLabs := []string{
		"2026-11-10T14:00:00+05:30/2026-11-10T16:00:00+05:30",
		"2026-11-24T14:00:00+05:30/2026-11-24T16:00:00+05:30",
		"2026-12-08T14:00:00+05:30/2026-12-08T16:00:00+05:30",
	}
	if !reflect.DeepEqual(labs, wantLabs) {
		t.Errorf("labs:\n got %v\nwant %v", labs, wantLabs)
	}
	if len(series) != 2 || series[""] {
		t.Errorf("series ids: %v", series)
	}
	lect := res.Items[0]
	if lect.SeriesID != "ics-"+hash12("cs201-lecture@uni.example") {
		t.Errorf("series id %q", lect.SeriesID)
	}
	if lect.ID != "ics-"+hash12("cs201-lecture@uni.example|2026-11-02T09:00:00+05:30") {
		t.Errorf("id %q", lect.ID)
	}
	// Sorted by start.
	for i := 1; i < len(res.Items); i++ {
		if mustT(res.Items[i].Start).Before(mustT(res.Items[i-1].Start)) {
			t.Fatalf("not sorted at %d", i)
		}
	}
}

func TestImportDeterministic(t *testing.T) {
	a := mustImport(t, timetableICS)
	b := mustImport(t, timetableICS)
	if !reflect.DeepEqual(a, b) {
		t.Fatal("import not deterministic")
	}
}

func TestAllDayEvents(t *testing.T) {
	src := crlf(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:break
DTSTART;VALUE=DATE:20261105
DTEND;VALUE=DATE:20261107
SUMMARY:Diwali break
END:VEVENT
BEGIN:VEVENT
UID:oneday
DTSTART;VALUE=DATE:20261102
SUMMARY:Founders day
END:VEVENT
BEGIN:VEVENT
UID:fest
DTSTART:20261110
DURATION:P1D
RRULE:FREQ=DAILY;COUNT=3
EXDATE;VALUE=DATE:20261111
SUMMARY:Tech fest
END:VEVENT
BEGIN:VEVENT
UID:old
DTSTART;VALUE=DATE:20261101
SUMMARY:Yesterday
END:VEVENT
END:VCALENDAR`)
	res := mustImport(t, src)
	got := spans(res)
	want := []string{
		"Founders day 2026-11-02T00:00:00+05:30 2026-11-03T00:00:00+05:30",
		"Diwali break 2026-11-05T00:00:00+05:30 2026-11-07T00:00:00+05:30",
		"Tech fest 2026-11-10T00:00:00+05:30 2026-11-11T00:00:00+05:30",
		"Tech fest 2026-11-12T00:00:00+05:30 2026-11-13T00:00:00+05:30",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v\nwant %v", got, want)
	}
	if res.Items[0].SeriesID != "" {
		t.Errorf("one-off should have no series id")
	}
}

func TestTimeForms(t *testing.T) {
	src := crlf(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:utc
DTSTART:20261103T040000Z
DTEND:20261103T050000Z
SUMMARY:UTC call
END:VEVENT
BEGIN:VEVENT
UID:float
DTSTART:20261104T150000
DURATION:PT1H30M
SUMMARY:Floating study group
END:VEVENT
BEGIN:VEVENT
UID:ny
DTSTART;TZID=America/New_York:20261105T090000
DTEND;TZID=America/New_York:20261105T093000
SUMMARY:NY standup
END:VEVENT
BEGIN:VEVENT
UID:nodur
DTSTART:20261106T120000
SUMMARY:Instant
END:VEVENT
END:VCALENDAR`)
	got := spans(mustImport(t, src))
	want := []string{
		"UTC call 2026-11-03T09:30:00+05:30 2026-11-03T10:30:00+05:30",
		"Floating study group 2026-11-04T15:00:00+05:30 2026-11-04T16:30:00+05:30",
		"NY standup 2026-11-05T19:30:00+05:30 2026-11-05T20:00:00+05:30",
		"Instant 2026-11-06T12:00:00+05:30 2026-11-06T12:00:00+05:30",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v\nwant %v", got, want)
	}
}

func TestFloatingUsesRequestTZ(t *testing.T) {
	src := crlf(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:f
DTSTART:20261104T150000
DTEND:20261104T160000
SUMMARY:Float
END:VEVENT
END:VCALENDAR`)
	res, err := Import(ImportRequest{ICS: src, TZ: "Europe/London", Now: testNow})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Items) != 1 || res.Items[0].Start != "2026-11-04T15:00:00Z" {
		t.Fatalf("got %+v", res.Items)
	}
}

func TestDSTWallClockKept(t *testing.T) {
	src := crlf(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:dst
DTSTART;TZID=America/New_York:20261026T090000
DTEND;TZID=America/New_York:20261026T100000
RRULE:FREQ=WEEKLY;BYDAY=MO
SUMMARY:Seminar
END:VEVENT
END:VCALENDAR`)
	res, err := Import(ImportRequest{ICS: src, TZ: "America/New_York", Now: testNow, HorizonDays: 140})
	if err != nil {
		t.Fatal(err)
	}
	for _, it := range res.Items {
		if !strings.Contains(it.Start, "T09:00:00") {
			t.Fatalf("wall clock drifted: %s", it.Start)
		}
	}
	last := res.Items[len(res.Items)-1].Start
	if last != "2027-03-15T09:00:00-04:00" {
		t.Fatalf("last %s", last)
	}
}

func TestRecurrenceVariants(t *testing.T) {
	src := crlf(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:daily
DTSTART;TZID=Asia/Kolkata:20261101T070000
DTEND;TZID=Asia/Kolkata:20261101T073000
RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261107
SUMMARY:Run
END:VEVENT
BEGIN:VEVENT
UID:weekdays
DTSTART;TZID=Asia/Kolkata:20261106T180000
DTEND;TZID=Asia/Kolkata:20261106T183000
RRULE:FREQ=DAILY;BYDAY=FR,MO;COUNT=3
SUMMARY:Gym
END:VEVENT
BEGIN:VEVENT
UID:sunweek
DTSTART;TZID=Asia/Kolkata:20261108T100000
DTEND;TZID=Asia/Kolkata:20261108T110000
RRULE:FREQ=WEEKLY;WKST=SU;BYDAY=SU,SA;COUNT=3
EXDATE;TZID=Asia/Kolkata:20261114T100000,20261115T100000
SUMMARY:Choir
END:VEVENT
END:VCALENDAR`)
	got := spans(mustImport(t, src))
	want := []string{
		"Run 2026-11-03T07:00:00+05:30 2026-11-03T07:30:00+05:30",
		"Run 2026-11-05T07:00:00+05:30 2026-11-05T07:30:00+05:30",
		"Gym 2026-11-06T18:00:00+05:30 2026-11-06T18:30:00+05:30",
		"Run 2026-11-07T07:00:00+05:30 2026-11-07T07:30:00+05:30",
		"Choir 2026-11-08T10:00:00+05:30 2026-11-08T11:00:00+05:30",
		"Gym 2026-11-09T18:00:00+05:30 2026-11-09T18:30:00+05:30",
		"Gym 2026-11-13T18:00:00+05:30 2026-11-13T18:30:00+05:30",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v\nwant %v", got, want)
	}
}

func TestHorizonAndPast(t *testing.T) {
	src := crlf(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:d
DTSTART;TZID=Asia/Kolkata:20200101T080000
DTEND;TZID=Asia/Kolkata:20200101T090000
RRULE:FREQ=DAILY
SUMMARY:Breakfast
END:VEVENT
BEGIN:VEVENT
UID:p
DTSTART:20261001T080000
SUMMARY:Past one
END:VEVENT
END:VCALENDAR`)
	res, err := Import(ImportRequest{ICS: src, TZ: testTZ, Now: testNow, HorizonDays: 3})
	if err != nil {
		t.Fatal(err)
	}
	got := spans(res)
	want := []string{
		"Breakfast 2026-11-02T08:00:00+05:30 2026-11-02T09:00:00+05:30",
		"Breakfast 2026-11-03T08:00:00+05:30 2026-11-03T09:00:00+05:30",
		"Breakfast 2026-11-04T08:00:00+05:30 2026-11-04T09:00:00+05:30",
		"Breakfast 2026-11-05T08:00:00+05:30 2026-11-05T09:00:00+05:30",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
	// Default horizon is 120 days.
	res = mustImport(t, src)
	if n := len(res.Items); n != 121 {
		t.Fatalf("default horizon gave %d items", n)
	}
}

func TestRecurrenceOverride(t *testing.T) {
	src := crlf(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:s
DTSTART;TZID=Asia/Kolkata:20261102T110000
DTEND;TZID=Asia/Kolkata:20261102T120000
RRULE:FREQ=DAILY;COUNT=3
SUMMARY:Tutorial
END:VEVENT
BEGIN:VEVENT
UID:s
RECURRENCE-ID;TZID=Asia/Kolkata:20261103T110000
DTSTART;TZID=Asia/Kolkata:20261103T150000
DTEND;TZID=Asia/Kolkata:20261103T160000
SUMMARY:Tutorial (moved)
END:VEVENT
BEGIN:VEVENT
UID:s
RECURRENCE-ID;TZID=Asia/Kolkata:20261104T110000
DTSTART;TZID=Asia/Kolkata:20261104T110000
STATUS:CANCELLED
SUMMARY:Tutorial
END:VEVENT
BEGIN:VEVENT
UID:gone
DTSTART:20261105T110000
STATUS:CANCELLED
SUMMARY:Cancelled thing
END:VEVENT
END:VCALENDAR`)
	got := spans(mustImport(t, src))
	want := []string{
		"Tutorial 2026-11-02T11:00:00+05:30 2026-11-02T12:00:00+05:30",
		"Tutorial (moved) 2026-11-03T15:00:00+05:30 2026-11-03T16:00:00+05:30",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
}

func TestSkippedReasons(t *testing.T) {
	src := crlf(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:m
DTSTART:20261105T100000
RRULE:FREQ=MONTHLY;BYMONTHDAY=5
SUMMARY:Team sync
END:VEVENT
BEGIN:VEVENT
UID:nostart
SUMMARY:Mystery meeting
END:VEVENT
BEGIN:VEVENT
UID:y
DTSTART:20261105T100000
RRULE:FREQ=YEARLY
SUMMARY:Birthday
END:VEVENT
BEGIN:VEVENT
UID:sp
DTSTART:20261105T100000
RRULE:FREQ=WEEKLY;BYDAY=MO,TU;BYSETPOS=-1
SUMMARY:Odd one
END:VEVENT
BEGIN:VEVENT
UID:tz
DTSTART;TZID=Mars/Olympus:20261105T100000
SUMMARY:Rover check
END:VEVENT
BEGIN:VEVENT
UID:rd
DTSTART:20261105T100000
RDATE:20261120T100000
SUMMARY:Extra
END:VEVENT
BEGIN:VEVENT
UID:nth
DTSTART:20261105T100000
RRULE:FREQ=WEEKLY;BYDAY=1MO
SUMMARY:Nth
END:VEVENT
BEGIN:VEVENT
UID:hourly
DTSTART:20261105T100000
RRULE:FREQ=HOURLY
SUMMARY:Ping
END:VEVENT
BEGIN:VEVENT
UID:baddur
DTSTART:20261105T100000
DURATION:1 hour
SUMMARY:Bad length
END:VEVENT
BEGIN:VTODO
SUMMARY:Buy chalk
END:VTODO
END:VCALENDAR`)
	res := mustImport(t, src)
	var reasons []string
	for _, s := range res.Skipped {
		reasons = append(reasons, s.Reason)
	}
	for _, want := range []string{
		"Monthly repeats aren't supported yet: Team sync",
		"This event has no start time, so it was left out: Mystery meeting",
		"Yearly repeats aren't supported yet: Birthday",
		"BYSETPOS",
		"unknown time zone \"Mars/Olympus\"",
		"RDATE",
		"\"the first Monday\"",
		"more often than daily",
		"length couldn't be read",
		"To-dos from calendars aren't supported yet: Buy chalk",
	} {
		found := false
		for _, r := range reasons {
			if strings.Contains(r, want) {
				found = true
			}
		}
		if !found {
			t.Errorf("missing reason containing %q in %q", want, reasons)
		}
	}
	// RDATE events still import their base occurrence.
	if len(res.Items) != 1 || res.Items[0].Title != "Extra" {
		t.Fatalf("items: %+v", res.Items)
	}
}

func TestMissingUIDDerived(t *testing.T) {
	src := crlf(`BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART:20261105T100000
SUMMARY:Coffee
END:VEVENT
END:VCALENDAR`)
	a := mustImport(t, src)
	b := mustImport(t, src)
	if len(a.Items) != 1 || a.Items[0].ID != b.Items[0].ID {
		t.Fatalf("unstable derived id")
	}
	want := "ics-" + hash12("derived:Coffee|20261105T100000|2026-11-05T10:00:00+05:30")
	if a.Items[0].ID != want {
		t.Fatalf("id %q want %q", a.Items[0].ID, want)
	}
}

func TestImportErrorsAndEmpty(t *testing.T) {
	if _, err := Import(ImportRequest{TZ: "Nowhere/Land", Now: testNow}); err == nil {
		t.Error("expected bad tz error")
	}
	if _, err := Import(ImportRequest{TZ: testTZ, Now: "yesterday"}); err == nil {
		t.Error("expected bad now error")
	}
	if _, err := Import(ImportRequest{TZ: testTZ}); err == nil {
		t.Error("expected missing now error")
	}
	res := mustImport(t, "garbage\nnot a calendar")
	if res.Items == nil || res.Skipped == nil || len(res.Items) != 0 {
		t.Fatalf("want empty non-nil slices, got %+v", res)
	}
}

func TestParseDuration(t *testing.T) {
	cases := []struct {
		in   string
		days int
		rest time.Duration
		ok   bool
	}{
		{"PT1H30M", 0, 90 * time.Minute, true},
		{"P1D", 1, 0, true},
		{"P2W", 14, 0, true},
		{"P1DT2H", 1, 2 * time.Hour, true},
		{"PT45S", 0, 45 * time.Second, true},
		{"+PT15M", 0, 15 * time.Minute, true},
		{"-PT15M", 0, 0, true},
		{"P", 0, 0, false},
		{"PT", 0, 0, false},
		{"P1H", 0, 0, false},
		{"PT1D", 0, 0, false},
		{"P1", 0, 0, false},
		{"1H", 0, 0, false},
		{"PTH", 0, 0, false},
		{"P1T", 0, 0, false},
	}
	for _, c := range cases {
		d, r, err := parseDuration(c.in)
		if (err == nil) != c.ok || d != c.days || r != c.rest {
			t.Errorf("%s: got %d %s %v", c.in, d, r, err)
		}
	}
}

func spans(res ImportResult) []string {
	var out []string
	for _, it := range res.Items {
		out = append(out, it.Title+" "+it.Start+" "+it.End)
	}
	return out
}

func mustT(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}
