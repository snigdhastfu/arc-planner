package planner

import (
	"arc/internal/model"
)

// ActionRequest applies one user action to one block.
// Action: "done" | "skip" | "snooze" | "undo" (undo returns a done/skipped block to planned).
type ActionRequest struct {
	Action  string        `json:"action"`
	BlockID string        `json:"blockId"`
	Plan    model.Plan    `json:"plan"`
	Items   []model.Item  `json:"items"`
	Profile model.Profile `json:"profile"`
	Now     string        `json:"now"`
	Minutes int           `json:"minutes,omitempty"` // snooze length, default 15
}

// ActionResult returns the updated plan and items (only changed items need
// saving, but all are returned for simplicity).
type ActionResult struct {
	Plan    model.Plan   `json:"plan"`
	Items   []model.Item `json:"items"`
	Changed []string     `json:"changed"` // ids of items whose fields changed
}

// BlockAction is the single place that keeps block status and item DoneMin
// consistent (SPEC pitfall: done state lives on blocks AND item DoneMin).
// It is idempotent: finishing an already-done block changes nothing, which
// guards against a double-fired swipe.
func BlockAction(req ActionRequest) (ActionResult, error) {
	items := append([]model.Item(nil), req.Items...)
	plan := req.Plan
	plan.Blocks = append([]model.Block(nil), req.Plan.Blocks...)
	idx := -1
	for i, b := range plan.Blocks {
		if b.ID == req.BlockID {
			idx = i
		}
	}
	if idx < 0 {
		return ActionResult{}, model.Errf("not_found", "no block %q", req.BlockID)
	}
	b := plan.Blocks[idx]
	itemIdx := -1
	for i, it := range items {
		if it.ID == b.ItemID {
			itemIdx = i
		}
	}
	var changed []string
	touchItem := func(f func(*model.Item)) {
		if itemIdx < 0 {
			return
		}
		f(&items[itemIdx])
		items[itemIdx].UpdatedAt = req.Now
		changed = append(changed, items[itemIdx].ID)
	}
	switch req.Action {
	case "done":
		if b.Status == model.StatusDone {
			break
		}
		b.Status = model.StatusDone
		if b.Kind == model.KindWork {
			m := minutes(b)
			touchItem(func(it *model.Item) {
				it.DoneMin += m
				if it.EffortMin > 0 && it.DoneMin >= it.EffortMin {
					it.Done = true
				}
			})
		}
	case "skip":
		if b.Status == model.StatusSkipped {
			break
		}
		if b.Status == model.StatusDone && b.Kind == model.KindWork {
			undoDone(b, touchItem)
		}
		b.Status = model.StatusSkipped
	case "undo":
		if b.Status == model.StatusDone && b.Kind == model.KindWork {
			undoDone(b, touchItem)
		}
		b.Status = model.StatusPlanned
	case "snooze":
		n := req.Minutes
		if n <= 0 {
			n = 15
		}
		moved, err := snooze(req, b, n)
		if err != nil {
			return ActionResult{}, err
		}
		b = moved
	default:
		return ActionResult{}, model.Errf("bad_action", "unknown action %q", req.Action)
	}
	plan.Blocks[idx] = b
	model.SortBlocks(plan.Blocks)
	if changed == nil {
		changed = []string{}
	}
	return ActionResult{Plan: plan, Items: items, Changed: changed}, nil
}

func undoDone(b model.Block, touch func(func(*model.Item))) {
	m := minutes(b)
	touch(func(it *model.Item) {
		it.DoneMin = max(0, it.DoneMin-m)
		if it.DoneMin < it.EffortMin {
			it.Done = false
		}
	})
}

// snooze moves a block later by n minutes (to the next free spot on the same
// day if that collides) and pins it there: the user asked for it explicitly.
func snooze(req ActionRequest, b model.Block, n int) (model.Block, error) {
	others := make([]model.Block, 0, len(req.Plan.Blocks))
	for _, o := range req.Plan.Blocks {
		if o.ID != b.ID && (o.Kind == model.KindEvent || o.Kind == model.KindRoutine || o.Pinned || o.Status == model.StatusDone) {
			others = append(others, o)
		}
	}
	e, err := newEngine(req.Items, req.Profile, req.Now, 1, nil)
	if err != nil {
		return b, err
	}
	for _, o := range others {
		if active(o) {
			e.markTimes(model.MustTime(o.Start), model.MustTime(o.End))
		}
	}
	start := model.MustTime(b.Start)
	if start.Before(e.now) {
		start = e.earliest
	}
	size := minutes(b)
	d := e.days[0]
	from := d.minuteOf(start, e.loc) + n
	for m := roundUp5(from); m+size <= d.sleep(); m += slotMin {
		if m >= d.past && d.free(m, m+size) {
			b.Start = model.FormatTime(model.AtMin(d.date, m, e.loc))
			b.End = model.FormatTime(model.AtMin(d.date, m+size, e.loc))
			b.Pinned = true
			b.Status = model.StatusPlanned
			b.Why = "Snoozed: you asked for a little more time."
			return b, nil
		}
	}
	return b, model.Errf("no_room", "There is no room later today, so it stays put. Try sleeping in instead.")
}
