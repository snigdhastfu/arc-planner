package ics

import (
	"strings"
	"testing"
	_ "time/tzdata"
)

const (
	testNow = "2026-11-02T10:00:00+05:30"
	testTZ  = "Asia/Kolkata"
)

func crlf(s string) string { return strings.ReplaceAll(s, "\n", "\r\n") }

func TestUnfoldCRLFAndLF(t *testing.T) {
	long := "DESCRIPTION:Week 1: introduction to algorithms\r\n  and data structures\r\n\t, with a short quiz at the end of the lecture."
	got := unfold(long + "\r\nSUMMARY:x\n y\n")
	want := []string{
		"DESCRIPTION:Week 1: introduction to algorithms and data structures, with a short quiz at the end of the lecture.",
		"SUMMARY:xy",
	}
	if len(got) != len(want) {
		t.Fatalf("got %d lines %q", len(got), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("line %d: got %q want %q", i, got[i], want[i])
		}
	}
}

func TestParseLineParams(t *testing.T) {
	p, ok := parseLine(`DTSTART;TZID="Asia/Kolkata";VALUE=DATE-TIME:20261102T090000`)
	if !ok || p.Name != "DTSTART" || p.Param("tzid") != "Asia/Kolkata" || p.Value != "20261102T090000" {
		t.Fatalf("bad parse: %+v", p)
	}
	p, ok = parseLine(`X-NOTE;ALTREP="cid:a:b":v:w`)
	if !ok || p.Value != "v:w" || p.Param("ALTREP") != "cid:a:b" {
		t.Fatalf("quoted colon: %+v", p)
	}
	if _, ok := parseLine("no separator"); ok {
		t.Fatal("expected failure")
	}
	if _, ok := parseLine(":value"); ok {
		t.Fatal("expected failure for empty name")
	}
}

func TestEscapeRoundTrip(t *testing.T) {
	in := "a, b; c\\d\nnew line"
	esc := escapeText(in)
	if esc != `a\, b\; c\\d\nnew line` {
		t.Fatalf("escape: %q", esc)
	}
	if got := unescapeText(esc); got != in {
		t.Fatalf("unescape: %q", got)
	}
	if got := unescapeText(`x\Ny\`); got != "x\ny\\" {
		t.Fatalf("unescape N/trailing: %q", got)
	}
	if got := escapeText("a\r\nb\rc"); got != `a\nb\nc` {
		t.Fatalf("CR handling: %q", got)
	}
}

func TestParseComponentsNesting(t *testing.T) {
	src := crlf(`BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:Outer
BEGIN:VALARM
DESCRIPTION:Alarm text
END:VALARM
END:VEVENT
END:VCALENDAR`)
	roots := parseComponents(src)
	if len(roots) != 1 || len(roots[0].Children) != 1 {
		t.Fatalf("bad tree")
	}
	ev := roots[0].Children[0]
	if ev.Name != "VEVENT" || len(ev.Children) != 1 || ev.Children[0].Name != "VALARM" {
		t.Fatalf("bad event: %+v", ev)
	}
	if _, ok := ev.first("DESCRIPTION"); ok {
		t.Fatal("alarm property leaked into event")
	}
}

func TestImportFoldedLongDescription(t *testing.T) {
	src := crlf(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:fold-1
DTSTART:20261103T040000Z
DTEND:20261103T050000Z
SUMMARY:Data Struc
 tures lecture
LOCATION:Room 4\,
  Main Block
DESCRIPTION:This is a deliberately long description that goes well past the
  seventy-five octet limit so that it has to be folded across several physi
 cal lines by the producer.
END:VEVENT
END:VCALENDAR`)
	res := mustImport(t, src)
	if len(res.Items) != 1 {
		t.Fatalf("items: %+v skipped: %+v", res.Items, res.Skipped)
	}
	it := res.Items[0]
	if it.Title != "Data Structures lecture" || it.Notes != "Room 4, Main Block" {
		t.Fatalf("got %q / %q", it.Title, it.Notes)
	}
	ev := parseComponents(src)[0].Children[0]
	d, _ := ev.first("DESCRIPTION")
	want := "This is a deliberately long description that goes well past the seventy-five octet limit so that it has to be folded across several physical lines by the producer."
	if d.Value != want {
		t.Fatalf("description: %q", d.Value)
	}
}

func mustImport(t *testing.T, ics string) ImportResult {
	t.Helper()
	res, err := Import(ImportRequest{ICS: ics, TZ: testTZ, Now: testNow})
	if err != nil {
		t.Fatal(err)
	}
	return res
}
