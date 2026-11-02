package planner

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"sort"
	"time"

	"arc/internal/model"
)

// ReplanRequest asks for a proposal against the current plan.
type ReplanRequest struct {
	Items   []model.Item  `json:"items"`
	Profile model.Profile `json:"profile"`
	Now     string        `json:"now"`
	Current model.Plan    `json:"current"`
}

// ReplanResult is a proposal; nothing is applied until the user approves.
type ReplanResult struct {
	Proposed model.Plan     `json:"proposed"`
	Changes  []model.Change `json:"changes"`
	Drifted  bool           `json:"drifted"`
}

// Replan recomputes with done/pinned blocks fixed and skipped/planned work
// released, then diffs old vs new.
func Replan(req ReplanRequest) (ReplanResult, error) {
	e, err := newEngine(req.Items, req.Profile, req.Now, 0, req.Current.Blocks)
	if err != nil {
		return ReplanResult{}, err
	}
	proposed := e.run(req.Current.Blocks, true)
	changes := diff(e, req.Current, proposed)
	return ReplanResult{Proposed: proposed, Changes: changes, Drifted: drifted(e, req.Current, proposed)}, nil
}

// drifted: a past work block still "planned", a skipped work block not yet
// re-homed, or a new at-risk item. Pinned blocks were decided by the user.
// (An overrun of more than 20 minutes shows up as a past planned block.)
func drifted(e *engine, cur, proposed model.Plan) bool {
	for _, b := range cur.Blocks {
		if b.Kind != model.KindWork || b.Pinned {
			continue
		}
		it, ok := e.items[b.ItemID]
		if !ok || it.Done {
			continue
		}
		if b.Status == model.StatusPlanned && model.MustTime(b.End).Before(e.now) {
			return true
		}
		if b.Status == model.StatusSkipped {
			return true
		}
	}
	old := map[string]int{}
	for _, r := range cur.AtRisk {
		old[r.ItemID] = r.ShortMin
	}
	for _, r := range proposed.AtRisk {
		if r.ShortMin > old[r.ItemID] {
			return true
		}
	}
	return false
}

func changeID(parts ...string) string {
	h := sha1.New()
	for _, p := range parts {
		h.Write([]byte(p))
		h.Write([]byte{'|'})
	}
	return hex.EncodeToString(h.Sum(nil))[:12]
}

func key(b model.Block) string { return fmt.Sprintf("%s#%d", b.ItemID, b.Seq) }

// diff compares the old and proposed plans' movable work blocks.
func diff(e *engine, cur, proposed model.Plan) []model.Change {
	oldBy := map[string]model.Block{}
	var skipped []model.Block
	for _, b := range cur.Blocks {
		if b.Kind != model.KindWork || b.Pinned {
			continue
		}
		switch b.Status {
		case model.StatusPlanned:
			oldBy[key(b)] = b
		case model.StatusSkipped:
			skipped = append(skipped, b)
		}
	}
	newBy := map[string]model.Block{}
	var newOnly []model.Block
	for _, b := range proposed.Blocks {
		if b.Kind != model.KindWork || b.Status != model.StatusPlanned || b.Pinned {
			continue
		}
		newBy[key(b)] = b
		if _, ok := oldBy[key(b)]; !ok {
			newOnly = append(newOnly, b)
		}
	}
	model.SortBlocks(newOnly)
	model.SortBlocks(skipped)

	dayWork := map[string]int{}
	for _, b := range proposed.Blocks {
		if b.Kind == model.KindWork && b.Status != model.StatusSkipped && b.Status != model.StatusMoved {
			dayWork[model.DayKey(model.MustTime(b.Start), e.loc)] += minutes(b)
		}
	}

	var out []model.Change
	add := func(c model.Change) {
		c.ID = changeID(c.Kind, c.ItemID, c.BlockID, c.FromStart, c.ToStart)
		out = append(out, c)
	}
	movedReason := func(old, nb model.Block) string {
		ot := model.MustTime(old.Start)
		dk := model.DayKey(ot, e.loc)
		sameDay := dk == model.DayKey(model.MustTime(nb.Start), e.loc)
		if d, ok := e.dayIdx[dk]; ok && ot.After(e.now) && !sameDay {
			if dayWork[dk]+minutes(old) > e.days[d].cap {
				return fmt.Sprintf("%s already passes your %s goal.", e.relDay(ot), hoursText(e.days[d].cap))
			}
		}
		if sameDay && ot.After(e.now) {
			return "Shuffled a little later today to make room."
		}
		return nb.Why
	}
	for k, ob := range oldBy {
		nb, ok := newBy[k]
		switch {
		case !ok:
			add(model.Change{ItemID: ob.ItemID, BlockID: ob.ID, Kind: "dropped", FromStart: ob.Start, FromEnd: ob.End,
				Reason: "Not needed any more: the work is already covered."})
		case ob.Start != nb.Start:
			add(model.Change{ItemID: ob.ItemID, BlockID: nb.ID, Kind: "moved", FromStart: ob.Start, FromEnd: ob.End,
				ToStart: nb.Start, ToEnd: nb.End, Reason: movedReason(ob, nb)})
		case minutes(nb) < minutes(ob):
			add(model.Change{ItemID: ob.ItemID, BlockID: nb.ID, Kind: "shortened", FromStart: ob.Start, FromEnd: ob.End,
				ToStart: nb.Start, ToEnd: nb.End, Reason: "Shortened a little so everything still fits."})
		}
	}
	// Pair each sleeping-in block with the first new block of the same item.
	used := map[string]bool{}
	for _, sb := range skipped {
		for _, nb := range newOnly {
			if nb.ItemID == sb.ItemID && !used[nb.ID] {
				used[nb.ID] = true
				add(model.Change{ItemID: sb.ItemID, BlockID: nb.ID, Kind: "moved", FromStart: sb.Start, FromEnd: sb.End,
					ToStart: nb.Start, ToEnd: nb.End, Reason: nb.Why})
				break
			}
		}
	}
	for _, nb := range newOnly {
		if !used[nb.ID] {
			add(model.Change{ItemID: nb.ItemID, BlockID: nb.ID, Kind: "added", ToStart: nb.Start, ToEnd: nb.End, Reason: nb.Why})
		}
	}
	oldRisk := map[string]int{}
	for _, r := range cur.AtRisk {
		oldRisk[r.ItemID] = r.ShortMin
	}
	for _, r := range proposed.AtRisk {
		if r.ShortMin > oldRisk[r.ItemID] {
			add(model.Change{ItemID: r.ItemID, Kind: "atRisk", Reason: r.Reason})
		}
	}
	// Watch: buffer between the last block and the deadline fell below 1 day.
	lastEnd := func(p model.Plan, id string) time.Time {
		var t time.Time
		for _, b := range p.Blocks {
			if b.ItemID == id && b.Kind == model.KindWork && (b.Status == model.StatusPlanned || b.Status == model.StatusDone) {
				if en := model.MustTime(b.End); en.After(t) {
					t = en
				}
			}
		}
		return t
	}
	for _, it := range e.sorted {
		if !it.IsWork() || it.Done {
			continue
		}
		dl := it.Deadline()
		o, n := lastEnd(cur, it.ID), lastEnd(proposed, it.ID)
		if o.IsZero() || n.IsZero() || dl.IsZero() {
			continue
		}
		if dl.Sub(o) >= 24*time.Hour && dl.Sub(n) < 24*time.Hour {
			reason := fmt.Sprintf("Watch this: the buffer before the %s drops under a day.", ordinal(dl.In(e.loc).Day()))
			found := false
			for i := range out { // fold into this item's latest change if there is one
				if out[i].ItemID == it.ID && out[i].Kind != "atRisk" {
					out[i].Reason, found = reason, true
				}
			}
			if !found {
				add(model.Change{ItemID: it.ID, Kind: "watch", Reason: reason})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		ti, tj := firstTime(out[i]), firstTime(out[j])
		if !ti.Equal(tj) {
			return ti.Before(tj)
		}
		return out[i].ID < out[j].ID
	})
	if out == nil {
		out = []model.Change{}
	}
	return out
}

func firstTime(c model.Change) time.Time {
	if c.FromStart != "" {
		return model.MustTime(c.FromStart)
	}
	if c.ToStart != "" {
		return model.MustTime(c.ToStart)
	}
	return time.Date(9999, 1, 1, 0, 0, 0, 0, time.UTC)
}

func (e *engine) relDay(t time.Time) string {
	lt := t.In(e.loc)
	switch civilDays(e.days[0].date, lt) {
	case 0:
		if lt.Hour() >= 18 {
			return "Tonight"
		}
		return "Today"
	case 1:
		return "Tomorrow"
	}
	return lt.Weekday().String()
}

// --- applyChanges -----------------------------------------------------------

// ApplyRequest carries the proposal and the user's per-change choices.
type ApplyRequest struct {
	Current     model.Plan     `json:"current"`
	Proposed    model.Plan     `json:"proposed"`
	Changes     []model.Change `json:"changes"`
	AcceptedIDs []string       `json:"acceptedIDs"`
	Items       []model.Item   `json:"items"`
	Profile     model.Profile  `json:"profile"`
	Now         string         `json:"now"`
}

// Conflict reports an accepted change that could not be applied.
type Conflict struct {
	ChangeID string `json:"changeId"`
	Reason   string `json:"reason"`
}

// ApplyResult is the new plan plus any conflicts.
type ApplyResult struct {
	Plan      model.Plan `json:"plan"`
	Conflicts []Conflict `json:"conflicts"`
}

// ApplyChanges starts from the proposal and reverts each rejected change
// (the old block comes back pinned). An accepted change that would overlap a
// reverted block is reverted too and reported as a conflict.
func ApplyChanges(req ApplyRequest) (ApplyResult, error) {
	if _, err := model.LoadTZ(req.Profile.Defaults().TZ); err != nil {
		return ApplyResult{}, err
	}
	if _, err := model.ParseTime(req.Now); err != nil || req.Now == "" {
		return ApplyResult{}, model.Errf("bad_now", "now must be an RFC3339 time")
	}
	titles := map[string]string{}
	for _, it := range req.Items {
		titles[it.ID] = it.Title
	}
	accepted := map[string]bool{}
	for _, id := range req.AcceptedIDs {
		accepted[id] = true
	}
	cur := map[string]model.Block{}
	for _, b := range req.Current.Blocks {
		cur[b.ID] = b
	}
	findOld := func(c model.Change) (model.Block, bool) {
		for _, b := range req.Current.Blocks {
			if b.ItemID == c.ItemID && b.Kind == model.KindWork && b.Start == c.FromStart {
				return b, true
			}
		}
		return model.Block{}, false
	}

	blocks := map[string]model.Block{}
	for _, b := range req.Proposed.Blocks {
		blocks[b.ID] = b
	}
	// revert undoes one change in the working set.
	revert := func(c model.Change) {
		switch c.Kind {
		case "moved", "shortened", "added":
			delete(blocks, c.BlockID)
			if c.Kind == "added" {
				return
			}
			fallthrough
		case "dropped":
			if old, ok := findOld(c); ok {
				old.Pinned = true
				blocks[old.ID] = old
			}
		}
	}
	changes := append([]model.Change(nil), req.Changes...)
	sort.Slice(changes, func(i, j int) bool { return changes[i].ID < changes[j].ID })
	reverted := map[string]bool{}
	for _, c := range changes {
		if !accepted[c.ID] {
			revert(c)
			reverted[c.ID] = true
		}
	}
	var conflicts []Conflict
	for {
		bad := ""
		var other model.Block
		for _, c := range changes {
			if reverted[c.ID] || c.BlockID == "" || c.Kind == "dropped" {
				continue
			}
			nb, ok := blocks[c.BlockID]
			if !ok {
				continue
			}
			for _, ob := range sortedBlocks(blocks) {
				if ob.ID == nb.ID || !active(ob) || !active(nb) {
					continue
				}
				if overlaps(nb, ob) {
					bad, other = c.ID, ob
					break
				}
			}
			if bad != "" {
				break
			}
		}
		if bad == "" {
			break
		}
		for _, c := range changes {
			if c.ID == bad {
				revert(c)
				reverted[c.ID] = true
				name := titles[other.ItemID]
				if name == "" {
					name = "another block"
				}
				conflicts = append(conflicts, Conflict{ChangeID: c.ID, Reason: fmt.Sprintf("It would bump into %s, so it stayed put.", name)})
			}
		}
	}
	plan := model.Plan{Blocks: sortedBlocks(blocks), AtRisk: req.Proposed.AtRisk, GeneratedAt: req.Now, Warnings: req.Proposed.Warnings}
	if plan.AtRisk == nil {
		plan.AtRisk = []model.AtRisk{}
	}
	if plan.Warnings == nil {
		plan.Warnings = []string{}
	}
	if conflicts == nil {
		conflicts = []Conflict{}
	}
	return ApplyResult{Plan: plan, Conflicts: conflicts}, nil
}

func active(b model.Block) bool {
	return b.Status != model.StatusSkipped && b.Status != model.StatusMoved
}

func overlaps(a, b model.Block) bool {
	as, ae := model.MustTime(a.Start), model.MustTime(a.End)
	bs, be := model.MustTime(b.Start), model.MustTime(b.End)
	return as.Before(be) && bs.Before(ae)
}

func sortedBlocks(m map[string]model.Block) []model.Block {
	out := make([]model.Block, 0, len(m))
	for _, b := range m {
		out = append(out, b)
	}
	model.SortBlocks(out)
	return out
}
