// Package parse turns one line of quick-add text into an Item.
//
// It is rule-based and deterministic: the current time is an input, the
// package never reads the clock, and it never panics on any text.
package parse

import (
	"crypto/sha1"
	"encoding/hex"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"arc/internal/doodle"
	"arc/internal/model"
)

// Request is the parseQuickAdd input.
type Request struct {
	Text string `json:"text"`
	Now  string `json:"now"`
	TZ   string `json:"tz"`
}

// Understood is one recognised piece, for the live preview chips.
type Understood struct {
	Field string `json:"field"`
	Value string `json:"value"`
}

// Result is the parseQuickAdd output.
type Result struct {
	Item       model.Item   `json:"item"`
	Confidence string       `json:"confidence"`
	Understood []Understood `json:"understood"`
}

// Defaults.
const (
	examTimeMin     = 9 * 60
	dueTimeMin      = 23*60 + 59
	eventTimeMin    = 9 * 60
	eventLenMin     = 60
	assignEffortMin = 60
	examEffortMin   = 240
	projEffortMin   = 600
	routineDurMin   = 2
)

// Token kinds.
const (
	kNone   = ""
	kFiller = "filler"
	kDate   = "date"
	kTime   = "time"
	kDur    = "dur"
	kRecur  = "recur"
	kDetail = "detail"
	kAnchor = "anchor"
	kType   = "type" // stays in the title
)

type tok struct {
	orig string // original casing, outer punctuation trimmed
	low  string
	kind string
}

type parser struct {
	loc   *time.Location
	now   time.Time
	today time.Time
	toks  []tok

	date    time.Time
	hasDate bool
	timeMin int
	hasTime bool
	hintMin int // default time from "tonight"/"tomorrow morning"; -1 if none
	durMin  int
	hasDur  bool

	typ     string
	dueWord bool

	recur      *model.Recur
	recurLabel string
	anchor     string // from recurrence ("every night")
	detail     string
	detailAnc  string // anchor implied by the detail ("before bed")
}

var typeWords = map[string]string{
	"exam": model.TypeExam, "exams": model.TypeExam, "test": model.TypeExam,
	"quiz": model.TypeExam, "midterm": model.TypeExam,
	"assignment": model.TypeAssignment, "homework": model.TypeAssignment,
	"essay":   model.TypeAssignment,
	"project": model.TypeProject,
}

var anchorWords = map[string]string{
	"morning": "morning", "mornings": "morning",
	"afternoon": "daytime", "afternoons": "daytime",
	"evening": "evening", "evenings": "evening",
	"night": "evening", "nights": "evening",
}

// anchorHint is the default clock time an anchor word gives a dated event.
var anchorHint = map[string]int{
	"morning": 9 * 60, "mornings": 9 * 60,
	"afternoon": 14 * 60, "afternoons": 14 * 60,
	"evening": 19 * 60, "evenings": 19 * 60,
	"night": 20 * 60, "nights": 20 * 60,
}

// detailObjects: "after shower", "before bed", "with food"... and the anchor
// the phrase implies ("" = none).
var detailObjects = map[string]string{
	"shower": "", "food": "", "meals": "", "meal": "", "water": "",
	"workout": "", "gym": "", "brushing": "",
	"bed": "evening", "bedtime": "evening", "dinner": "evening",
	"breakfast": "morning", "waking": "morning",
	"lunch": "daytime",
}

// QuickAdd parses req.Text relative to req.Now in req.TZ. It errors only for
// a bad Now or TZ; text it cannot understand gives confidence "low".
func QuickAdd(req Request) (Result, error) {
	loc, err := model.LoadTZ(req.TZ)
	if err != nil {
		return Result{}, err
	}
	if strings.TrimSpace(req.Now) == "" {
		return Result{}, model.Errf("bad_time", "now is required")
	}
	now, err := model.ParseTime(req.Now)
	if err != nil {
		return Result{}, err
	}
	now = now.In(loc)
	p := &parser{loc: loc, now: now, today: midnight(now, loc), hintMin: -1}
	p.tokenize(req.Text)
	p.scan()
	return p.build(req), nil
}

func (p *parser) tokenize(text string) {
	for _, f := range strings.Fields(text) {
		o := strings.TrimFunc(f, func(r rune) bool {
			return unicode.IsPunct(r) && r != '&'
		})
		if o == "" {
			p.toks = append(p.toks, tok{orig: f, low: f, kind: kFiller})
			continue
		}
		p.toks = append(p.toks, tok{orig: o, low: strings.ToLower(o)})
	}
}

func (p *parser) low(i int) string {
	if i < 0 || i >= len(p.toks) || p.toks[i].kind != kNone {
		return ""
	}
	return p.toks[i].low
}

func (p *parser) mark(i, n int, kind string) {
	for j := i; j < i+n && j < len(p.toks); j++ {
		p.toks[j].kind = kind
	}
}

// scan walks the tokens once, consuming what it recognises.
func (p *parser) scan() {
	for i := 0; i < len(p.toks); {
		if p.toks[i].kind != kNone {
			i++
			continue
		}
		w := p.toks[i].low
		switch w {
		case "due":
			p.dueWord = true
			p.mark(i, 1, kFiller)
			if n := p.matchQualified(i+1, false); n > 0 {
				i += 1 + n
			} else {
				i++
			}
			continue
		case "at", "on", "by", "this", "next":
			if n := p.matchQualified(i+1, w == "at"); n > 0 {
				p.mark(i, 1, kFiller)
				i += 1 + n
				continue
			}
		}
		if n := p.matchAt(i, false, false); n > 0 {
			i += n
			continue
		}
		i++
	}
	p.markDurationFiller()
}

// matchQualified matches a date/time/recurrence right after a qualifier
// word, allowing ambiguous weekdays ("on sat") and, after "at", bare hours.
func (p *parser) matchQualified(i int, bareHour bool) int {
	if p.low(i) == "" {
		return 0
	}
	return p.matchWhen(i, true, bareHour)
}

func (p *parser) matchAt(i int, qualified, bareHour bool) int {
	if n := p.matchWhen(i, qualified, bareHour); n > 0 {
		return n
	}
	if t, ok := typeWords[p.low(i)]; ok {
		if p.typ == "" {
			p.typ = t
		}
		p.mark(i, 1, kType)
		return 1
	}
	return 0
}

// matchWhen tries every non-type matcher at i.
func (p *parser) matchWhen(i int, qualified, bareHour bool) int {
	for _, m := range []func(int, bool, bool) int{
		p.matchISO, p.matchRecur, p.matchDetail, p.matchRelDay, p.matchMonthDay,
		p.matchWeekday, p.matchTime, p.matchDur,
	} {
		if n := m(i, qualified, bareHour); n > 0 {
			return n
		}
	}
	return 0
}

func (p *parser) setDate(t time.Time) {
	if !p.hasDate {
		p.date, p.hasDate = t, true
	}
}

func (p *parser) setTime(m int) {
	if !p.hasTime {
		p.timeMin, p.hasTime = m, true
	}
}

func (p *parser) setRecur(r model.Recur, label, anchor string) {
	if p.recur == nil {
		p.recur, p.recurLabel = &r, label
		if anchor != "" && p.anchor == "" {
			p.anchor = anchor
		}
	}
}

func (p *parser) matchISO(i int, _, _ bool) int {
	sm := reISO.FindStringSubmatch(p.low(i))
	if sm == nil {
		return 0
	}
	y, _ := strconv.Atoi(sm[1])
	mo, _ := strconv.Atoi(sm[2])
	d, _ := strconv.Atoi(sm[3])
	if mo < 1 || mo > 12 {
		return 0
	}
	t, ok := monthDay(p.today, time.Month(mo), d, y, p.loc)
	if !ok {
		return 0
	}
	p.setDate(t)
	p.mark(i, 1, kDate)
	return 1
}

var weekdaysAll = []int{1, 2, 3, 4, 5}

func (p *parser) matchRecur(i int, _, _ bool) int {
	w := p.low(i)
	switch w {
	case "daily", "everyday":
		p.setRecur(model.Recur{Freq: "daily", Interval: 1}, "every day", "")
		p.mark(i, 1, kRecur)
		return 1
	case "nightly":
		p.setRecur(model.Recur{Freq: "daily", Interval: 1}, "every night", "evening")
		p.mark(i, 1, kRecur)
		return 1
	case "weekdays":
		p.setRecur(model.Recur{Freq: "weekly", Interval: 1, Days: weekdaysAll}, "weekdays", "")
		p.mark(i, 1, kRecur)
		return 1
	case "weekends":
		p.setRecur(model.Recur{Freq: "weekly", Interval: 1, Days: []int{0, 6}}, "weekends", "")
		p.mark(i, 1, kRecur)
		return 1
	case "every", "each":
	default:
		// "mondays" on its own means every Monday.
		if wd, plural, ok := weekday(w, false); ok && plural {
			return p.recurDays(i, i, wd)
		}
		return 0
	}
	nx := p.low(i + 1)
	daily := model.Recur{Freq: "daily", Interval: 1}
	switch nx {
	case "day", "days":
		p.setRecur(daily, "every day", "")
	case "night", "nights":
		p.setRecur(daily, "every night", "evening")
	case "evening", "evenings":
		p.setRecur(daily, "every evening", "evening")
	case "morning", "mornings":
		p.setRecur(daily, "every morning", "morning")
	case "afternoon", "afternoons":
		p.setRecur(daily, "every afternoon", "daytime")
	case "weekday", "weekdays":
		p.setRecur(model.Recur{Freq: "weekly", Interval: 1, Days: weekdaysAll}, "weekdays", "")
	case "weekend", "weekends":
		p.setRecur(model.Recur{Freq: "weekly", Interval: 1, Days: []int{0, 6}}, "weekends", "")
	case "week":
		wd := int(p.today.Weekday())
		p.setRecur(model.Recur{Freq: "weekly", Interval: 1, Days: []int{wd}}, "every "+time.Weekday(wd).String()[:3], "")
	case "other":
		if d := p.low(i + 2); d == "day" {
			p.setRecur(model.Recur{Freq: "daily", Interval: 2}, "every other day", "")
			p.mark(i, 3, kRecur)
			return 3
		}
		return 0
	default:
		if wd, _, ok := weekday(nx, true); ok {
			return p.recurDays(i, i+1, wd)
		}
		return 0
	}
	p.mark(i, 2, kRecur)
	return 2
}

// recurDays consumes a weekday list starting at j ("mon", "mon and wed").
func (p *parser) recurDays(i, j int, first time.Weekday) int {
	days := []int{int(first)}
	end := j + 1
	for k := end; k < len(p.toks); {
		w := p.low(k)
		if w == "and" || w == "&" {
			if wd, _, ok := weekday(p.low(k+1), true); ok {
				days = append(days, int(wd))
				k += 2
				end = k
				continue
			}
			break
		}
		if wd, _, ok := weekday(w, true); ok {
			days = append(days, int(wd))
			k++
			end = k
			continue
		}
		break
	}
	sort.Ints(days)
	uniq := days[:0]
	for _, d := range days {
		if len(uniq) == 0 || uniq[len(uniq)-1] != d {
			uniq = append(uniq, d)
		}
	}
	names := make([]string, len(uniq))
	for k, d := range uniq {
		names[k] = time.Weekday(d).String()[:3]
	}
	p.setRecur(model.Recur{Freq: "weekly", Interval: 1, Days: append([]int(nil), uniq...)}, "every "+strings.Join(names, ", "), "")
	p.mark(i, end-i, kRecur)
	return end - i
}

func (p *parser) matchDetail(i int, _, _ bool) int {
	w := p.low(i)
	if w != "after" && w != "before" && w != "with" {
		return 0
	}
	obj := p.low(i + 1)
	anc, ok := detailObjects[obj]
	if !ok {
		return 0
	}
	if p.detail == "" {
		p.detail = w + " " + obj
		p.detailAnc = anc
	}
	p.mark(i, 2, kDetail)
	return 2
}

func (p *parser) matchRelDay(i int, _, _ bool) int {
	switch p.low(i) {
	case "today":
		p.setDate(p.today)
	case "tonight":
		p.setDate(p.today)
		if p.hintMin < 0 {
			p.hintMin = 20 * 60
		}
	case "tomorrow", "tmrw", "tmr", "tomorow":
		p.setDate(addDays(p.today, 1, p.loc))
	default:
		return 0
	}
	p.mark(i, 1, kDate)
	return 1
}

func (p *parser) matchMonthDay(i int, _, _ bool) int {
	// month day [year]
	if m, ok := monthNames[p.low(i)]; ok {
		if d, ok := dayNum(p.low(i + 1)); ok {
			n, y := 2, 0
			if yy, ok := yearNum(p.low(i + 2)); ok {
				n, y = 3, yy
			}
			if t, ok := monthDay(p.today, m, d, y, p.loc); ok {
				p.setDate(t)
				p.mark(i, n, kDate)
				return n
			}
		}
		return 0
	}
	// day month [year], also "20th of nov"
	if d, ok := dayNum(p.low(i)); ok {
		j := i + 1
		if p.low(j) == "of" {
			j++
		}
		if m, ok := monthNames[p.low(j)]; ok {
			n, y := j+1-i, 0
			if yy, ok := yearNum(p.low(j + 1)); ok {
				n, y = n+1, yy
			}
			if t, ok := monthDay(p.today, m, d, y, p.loc); ok {
				p.setDate(t)
				p.mark(i, n, kDate)
				return n
			}
		}
	}
	return 0
}

func (p *parser) matchWeekday(i int, qualified, _ bool) int {
	wd, plural, ok := weekday(p.low(i), qualified)
	if !ok || plural {
		return 0
	}
	p.setDate(nextWeekday(p.today, wd, p.loc))
	p.mark(i, 1, kDate)
	return 1
}

func (p *parser) matchTime(i int, _, bareHour bool) int {
	w := p.low(i)
	if w == "noon" || w == "midday" {
		p.setTime(12 * 60)
		p.mark(i, 1, kTime)
		return 1
	}
	if sm := reAmPm.FindStringSubmatch(w); sm != nil {
		if m, ok := clockAmPm(sm[1], sm[2], sm[3]); ok {
			p.setTime(m)
			p.mark(i, 1, kTime)
			return 1
		}
		return 0
	}
	if sm := reClock.FindStringSubmatch(w); sm != nil {
		if ap := p.low(i + 1); ap == "am" || ap == "pm" {
			if m, ok := clockAmPm(sm[1], sm[2], ap); ok {
				p.setTime(m)
				p.mark(i, 2, kTime)
				return 2
			}
			return 0
		}
	}
	if sm := re24.FindStringSubmatch(w); sm != nil {
		if m, ok := clock24(sm[1], sm[2]); ok {
			p.setTime(m)
			p.mark(i, 1, kTime)
			return 1
		}
		return 0
	}
	if bareHour {
		if h, err := strconv.Atoi(w); err == nil && len(w) <= 2 && h >= 0 && h <= 23 {
			if h >= 1 && h <= 6 {
				h += 12 // "at 5" means 5pm
			}
			p.setTime(h * 60)
			p.mark(i, 1, kTime)
			return 1
		}
	}
	return 0
}

func (p *parser) setDur(m int) {
	if !p.hasDur {
		p.durMin, p.hasDur = m, true
	}
}

func (p *parser) matchDur(i int, _, _ bool) int {
	w := p.low(i)
	if sm := reDur.FindStringSubmatch(w); sm != nil {
		v, err := strconv.ParseFloat(sm[1], 64)
		if err != nil {
			return 0
		}
		if m, ok := durMinutes(v, unitMin(sm[2])); ok {
			p.setDur(m)
			p.mark(i, 1, kDur)
			return 1
		}
		return 0
	}
	if sm := reHM.FindStringSubmatch(w); sm != nil {
		h, _ := strconv.Atoi(sm[1])
		mm, _ := strconv.Atoi(sm[2])
		if mm < 60 && h*60+mm > 0 {
			p.setDur(h*60 + mm)
			p.mark(i, 1, kDur)
			return 1
		}
		return 0
	}
	if reNum.MatchString(w) {
		if u := unitMin(p.low(i + 1)); u > 0 {
			v, err := strconv.ParseFloat(w, 64)
			if err != nil {
				return 0
			}
			if m, ok := durMinutes(v, u); ok {
				p.setDur(m)
				p.mark(i, 2, kDur)
				return 2
			}
		}
		return 0
	}
	if (w == "an" || w == "a") && p.low(i+1) == "hour" {
		p.setDur(60)
		p.mark(i, 2, kDur)
		return 2
	}
	return 0
}

// markDurationFiller drops "want 12h prep" / "for 2 hours" style words that
// sit next to a recognised duration.
func (p *parser) markDurationFiller() {
	for i := range p.toks {
		if p.toks[i].kind != kDur {
			continue
		}
		for j := i - 1; j >= 0 && j >= i-2; j-- {
			switch p.low(j) {
			case "want", "need", "needs", "for", "about":
				p.mark(j, 1, kFiller)
				continue
			}
			break
		}
		for j := i + 1; j < len(p.toks); j++ {
			if p.toks[j].kind == kDur {
				continue
			}
			switch p.low(j) {
			case "of", "prep", "preparation", "revision":
				p.mark(j, 1, kFiller)
				continue
			}
			break
		}
	}
}

// adjacentToDate reports whether token i sits right next to a date token.
func (p *parser) adjacentToDate(i int) bool {
	return (i > 0 && p.toks[i-1].kind == kDate) || (i+1 < len(p.toks) && p.toks[i+1].kind == kDate)
}

func (p *parser) build(req Request) Result {
	// Anchor words ("morning", "night") are resolved after the main scan
	// because whether they are an anchor depends on the item type.
	var anchorIdx []int
	for i, t := range p.toks {
		if t.kind == kNone {
			if _, ok := anchorWords[t.low]; ok {
				anchorIdx = append(anchorIdx, i)
			}
		}
	}

	typ, typeKnown := p.typ, p.typ != ""
	if !typeKnown && p.dueWord {
		typ, typeKnown = model.TypeAssignment, true
	}
	wordAnchor := ""
	switch {
	case typeKnown:
	case p.recur != nil || p.detail != "" || (len(anchorIdx) > 0 && !p.hasDate && !p.hasTime):
		typ, typeKnown = model.TypeRoutine, true
	case p.hasDate || p.hasTime:
		typ, typeKnown = model.TypeEvent, true
	default:
		typ = model.TypeEvent
	}
	for _, i := range anchorIdx {
		if typ == model.TypeRoutine {
			if wordAnchor == "" {
				wordAnchor = anchorWords[p.toks[i].low]
			}
			p.mark(i, 1, kAnchor)
		} else if p.adjacentToDate(i) {
			if p.hintMin < 0 {
				p.hintMin = anchorHint[p.toks[i].low]
			}
			p.mark(i, 1, kAnchor)
		}
	}

	nothing := true
	for _, t := range p.toks {
		if t.kind != kNone && t.kind != kFiller {
			nothing = false
		}
	}

	// Title.
	var words, doodleWords []string
	for _, t := range p.toks {
		if t.kind == kNone || t.kind == kType {
			words = append(words, t.orig)
			if t.kind == kNone {
				doodleWords = append(doodleWords, t.orig)
			}
		}
	}
	title := titleCase(strings.Join(words, " "))
	if nothing {
		title = strings.Join(strings.Fields(req.Text), " ")
	}

	sum := sha1.Sum([]byte(req.Text + "|" + req.Now))
	it := model.Item{
		ID:           "qa-" + hex.EncodeToString(sum[:])[:10],
		Type:         typ,
		Title:        title,
		DoodleSource: "auto",
	}

	var und []Understood
	add := func(f, v string) { und = append(und, Understood{f, v}) }
	if typeKnown {
		add("type", typ)
	}
	if title != "" {
		add("title", title)
	}

	// Resolve the day: a time without a date means the next time it occurs.
	day, haveDay := p.date, p.hasDate
	if !haveDay && p.hasTime {
		day, haveDay = p.today, true
		if !model.AtMin(p.today, p.timeMin, p.loc).After(p.now) {
			day = addDays(p.today, 1, p.loc)
		}
	}
	clock := func(def int) int {
		if p.hasTime {
			return p.timeMin
		}
		if p.hintMin >= 0 {
			return p.hintMin
		}
		return def
	}

	switch typ {
	case model.TypeExam:
		it.EffortMin = examEffortMin
		if haveDay {
			m := clock(examTimeMin)
			it.Start = model.FormatTime(model.AtMin(day, m, p.loc))
			add("date", fmtDay(day, p.now))
			add("time", fmtClock(m))
		}
	case model.TypeAssignment, model.TypeProject:
		it.EffortMin = assignEffortMin
		if typ == model.TypeProject {
			it.EffortMin = projEffortMin
		}
		if haveDay {
			m := dueTimeMin
			if p.hasTime {
				m = p.timeMin
			}
			it.Due = model.FormatTime(model.AtMin(day, m, p.loc))
			add("date", fmtDay(day, p.now))
			add("time", fmtClock(m))
		}
	case model.TypeEvent:
		if haveDay {
			m := clock(eventTimeMin)
			length := eventLenMin
			if p.hasDur {
				length = p.durMin
			}
			st := model.AtMin(day, m, p.loc)
			it.Start = model.FormatTime(st)
			it.End = model.FormatTime(st.Add(time.Duration(length) * time.Minute))
			add("date", fmtDay(day, p.now))
			add("time", fmtClock(m))
			add("duration", fmtDur(length))
		}
	case model.TypeRoutine:
		rs := &model.RoutineSpec{DurMin: routineDurMin, Detail: p.detail}
		if p.hasDur {
			rs.DurMin = p.durMin
		}
		if p.recur != nil {
			rs.Recur = *p.recur
		} else {
			rs.Recur = model.Recur{Freq: "daily", Interval: 1}
			p.recurLabel = "every day"
		}
		switch {
		case p.hasTime:
			m := p.timeMin
			rs.Anchor, rs.AtMin = "time", &m
			switch {
			case m < 12*60:
				rs.Group = "morning"
			case m < 17*60:
				rs.Group = "daytime"
			default:
				rs.Group = "evening"
			}
		case p.anchor != "":
			rs.Anchor = p.anchor
		case wordAnchor != "":
			rs.Anchor = wordAnchor
		case p.detailAnc != "":
			rs.Anchor = p.detailAnc
		default:
			rs.Anchor = "daytime"
		}
		if rs.Group == "" {
			rs.Group = rs.Anchor
		}
		it.Routine = rs
		if p.hasTime {
			add("time", fmtClock(p.timeMin))
		}
		if p.hasDur {
			add("duration", fmtDur(rs.DurMin))
		}
		add("recur", p.recurLabel)
		add("anchor", rs.Anchor)
		if rs.Detail != "" {
			add("detail", rs.Detail)
		}
	}
	if it.IsWork() {
		if p.hasDur {
			it.EffortMin = p.durMin
		}
		add("effort", fmtDur(it.EffortMin))
	}

	// Doodle: title minus the type word first ("chem exam" -> flask), then
	// the whole title, then the type fallback.
	if n, s := doodle.Score(strings.Join(doodleWords, " ")); s > 0 {
		it.Doodle = n
	} else if n, s := doodle.Score(title); s > 0 {
		it.Doodle = n
	} else {
		it.Doodle = doodle.Fallback(typ)
	}
	add("doodle", it.Doodle)

	conf := "low"
	if typeKnown && (p.hasDate || p.hasTime || typ == model.TypeRoutine) {
		conf = "high"
	}
	return Result{Item: it, Confidence: conf, Understood: und}
}

// titleCase capitalises the first letter of s and any standalone
// single-letter word except "a" ("vitamin d" -> "Vitamin D").
func titleCase(s string) string {
	ws := strings.Fields(s)
	for i, w := range ws {
		r, size := utf8.DecodeRuneInString(w)
		if r == utf8.RuneError {
			continue
		}
		single := size == len(w) && unicode.IsLetter(r) && r != 'a'
		if i == 0 || single {
			ws[i] = string(unicode.ToUpper(r)) + w[size:]
		}
	}
	return strings.Join(ws, " ")
}
