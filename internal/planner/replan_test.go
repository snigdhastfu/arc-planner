package planner

import (
	"encoding/json"
	"testing"

	"arc/internal/model"
)

func findWork(p model.Plan, itemID string) []model.Block {
	var out []model.Block
	for _, b := range p.Blocks {
		if b.ItemID == itemID && b.Kind == model.KindWork {
			out = append(out, b)
		}
	}
	return out
}

func TestSkippedBlockReplan(t *testing.T) {
	items := sampleItems()
	p := mustPlan(t, PlanRequest{Items: items, Profile: kolkata(), Now: testNow})
	first := findWork(p, "ps4")[0]
	act, err := BlockAction(ActionRequest{Action: "skip", BlockID: first.ID, Plan: p, Items: items, Profile: kolkata(), Now: testNow})
	if err != nil {
		t.Fatal(err)
	}
	// plan() must not silently re-place a sleeping-in block's effort
	again := mustPlan(t, PlanRequest{Items: act.Items, Profile: kolkata(), Now: testNow, Existing: act.Plan.Blocks})
	if len(findWork(again, "ps4")) != len(findWork(p, "ps4")) {
		t.Errorf("plan() changed block count after a skip")
	}
	res, err := Replan(ReplanRequest{Items: act.Items, Profile: kolkata(), Now: testNow, Current: act.Plan})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Drifted {
		t.Error("a sleeping-in work block should mark the day drifted")
	}
	var moved *model.Change
	for i, c := range res.Changes {
		if c.Kind == "moved" && c.FromStart == first.Start {
			moved = &res.Changes[i]
		}
		if c.Reason == "" {
			t.Errorf("change %s has no reason", c.ID)
		}
	}
	if moved == nil {
		t.Fatalf("no moved change for skipped block; changes: %+v", res.Changes)
	}
	checkInvariants(t, act.Items, kolkata(), testNow, act.Plan.Blocks, res.Proposed)

	ap, err := ApplyChanges(ApplyRequest{Current: act.Plan, Proposed: res.Proposed, Changes: res.Changes,
		AcceptedIDs: ids(res.Changes), Items: act.Items, Profile: kolkata(), Now: testNow})
	if err != nil {
		t.Fatal(err)
	}
	if len(ap.Conflicts) != 0 {
		t.Errorf("conflicts: %+v", ap.Conflicts)
	}
	for _, b := range ap.Plan.Blocks {
		if b.ID == first.ID && b.Status != model.StatusMoved {
			t.Errorf("skipped block should be marked moved after approval, got %s", b.Status)
		}
	}
	// after approving, the day is no longer drifted
	res2, _ := Replan(ReplanRequest{Items: act.Items, Profile: kolkata(), Now: testNow, Current: ap.Plan})
	if res2.Drifted {
		t.Errorf("still drifted after approval: %+v", res2.Changes)
	}
}

func ids(cs []model.Change) []string {
	out := []string{}
	for _, c := range cs {
		out = append(out, c.ID)
	}
	return out
}

func TestPastPlannedDriftAndPartialAcceptance(t *testing.T) {
	items := sampleItems()
	p := mustPlan(t, PlanRequest{Items: items, Profile: kolkata(), Now: testNow})
	later := "2026-11-03T21:30:00+05:30" // a day and a half later, nothing marked done
	res, err := Replan(ReplanRequest{Items: items, Profile: kolkata(), Now: later, Current: p})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Drifted {
		t.Fatal("expected drift")
	}
	var movable []model.Change
	for _, c := range res.Changes {
		if c.Kind == "moved" || c.Kind == "added" || c.Kind == "shortened" || c.Kind == "dropped" {
			movable = append(movable, c)
		}
	}
	if len(movable) < 2 {
		t.Fatalf("want at least 2 changes, got %+v", res.Changes)
	}
	accepted := []string{movable[0].ID}
	ap, err := ApplyChanges(ApplyRequest{Current: p, Proposed: res.Proposed, Changes: res.Changes,
		AcceptedIDs: accepted, Items: items, Profile: kolkata(), Now: later})
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]model.Block{}
	for _, b := range ap.Plan.Blocks {
		byID[b.ID] = b
	}
	// accepted: new block present at proposed time
	if c := movable[0]; c.Kind != "dropped" {
		if b, ok := byID[c.BlockID]; !ok || b.Start != c.ToStart {
			t.Errorf("accepted change not applied: %+v", c)
		}
	}
	// rejected moved/dropped: old block is back and pinned
	for _, c := range movable[1:] {
		if c.Kind != "moved" && c.Kind != "dropped" {
			continue
		}
		found := false
		for _, b := range ap.Plan.Blocks {
			if b.ItemID == c.ItemID && b.Start == c.FromStart && b.Pinned {
				found = true
			}
		}
		if !found {
			t.Errorf("rejected change %s did not keep the old block pinned", c.Kind)
		}
	}
	// active blocks never overlap after applying
	for i, a := range ap.Plan.Blocks {
		for _, b := range ap.Plan.Blocks[i+1:] {
			if active(a) && active(b) && !(a.Kind == model.KindEvent && b.Kind == model.KindEvent) && overlaps(a, b) {
				t.Errorf("overlap after apply: %s %s", a.ID, b.ID)
			}
		}
	}
	// Rejecting everything leaves no drift: pinned blocks are the user's call.
	none, _ := ApplyChanges(ApplyRequest{Current: p, Proposed: res.Proposed, Changes: res.Changes, Items: items, Profile: kolkata(), Now: later})
	res3, _ := Replan(ReplanRequest{Items: items, Profile: kolkata(), Now: later, Current: none.Plan})
	if res3.Drifted {
		t.Errorf("drift after rejecting all")
	}
}

func TestApplyConflict(t *testing.T) {
	cur := model.Plan{Blocks: []model.Block{
		{ID: "old1", ItemID: "a", Seq: 1, Start: "2026-11-02T14:00:00+05:30", End: "2026-11-02T14:50:00+05:30", Kind: "work", Status: "planned", Why: "x."},
		{ID: "old2", ItemID: "b", Seq: 1, Start: "2026-11-02T16:00:00+05:30", End: "2026-11-02T16:50:00+05:30", Kind: "work", Status: "planned", Why: "x."},
	}}
	prop := model.Plan{Blocks: []model.Block{
		{ID: "new1", ItemID: "a", Seq: 1, Start: "2026-11-02T16:00:00+05:30", End: "2026-11-02T16:50:00+05:30", Kind: "work", Status: "planned", Why: "x."},
		{ID: "new2", ItemID: "b", Seq: 1, Start: "2026-11-02T18:00:00+05:30", End: "2026-11-02T18:50:00+05:30", Kind: "work", Status: "planned", Why: "x."},
	}}
	changes := []model.Change{
		{ID: "c1", ItemID: "a", BlockID: "new1", Kind: "moved", FromStart: cur.Blocks[0].Start, ToStart: prop.Blocks[0].Start},
		{ID: "c2", ItemID: "b", BlockID: "new2", Kind: "moved", FromStart: cur.Blocks[1].Start, ToStart: prop.Blocks[1].Start},
	}
	items := []model.Item{{ID: "a", Title: "Alpha"}, {ID: "b", Title: "Beta"}}
	res, err := ApplyChanges(ApplyRequest{Current: cur, Proposed: prop, Changes: changes, AcceptedIDs: []string{"c1"}, Items: items, Profile: kolkata(), Now: testNow})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Conflicts) != 1 || res.Conflicts[0].ChangeID != "c1" {
		t.Fatalf("expected c1 conflict, got %+v", res.Conflicts)
	}
	b, _ := json.Marshal(res.Plan.Blocks)
	if want := `"old1"`; !contains(string(b), want) {
		t.Errorf("old1 should be restored: %s", b)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 || indexOf(s, sub) >= 0)
}
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func TestBlockActionDoneIsConsistentAndIdempotent(t *testing.T) {
	items := sampleItems()
	p := mustPlan(t, PlanRequest{Items: items, Profile: kolkata(), Now: testNow})
	b := findWork(p, "ps4")[0]
	r1, err := BlockAction(ActionRequest{Action: "done", BlockID: b.ID, Plan: p, Items: items, Profile: kolkata(), Now: testNow})
	if err != nil {
		t.Fatal(err)
	}
	r2, _ := BlockAction(ActionRequest{Action: "done", BlockID: b.ID, Plan: r1.Plan, Items: r1.Items, Profile: kolkata(), Now: testNow})
	var it model.Item
	for _, x := range r2.Items {
		if x.ID == "ps4" {
			it = x
		}
	}
	if it.DoneMin != minutes(b) {
		t.Fatalf("DoneMin %d want %d (double fire must not double count)", it.DoneMin, minutes(b))
	}
	// replanning after completion keeps the total consistent (no double count)
	p2 := mustPlan(t, PlanRequest{Items: r2.Items, Profile: kolkata(), Now: testNow, Existing: r2.Plan.Blocks})
	sum := 0
	for _, x := range findWork(p2, "ps4") {
		sum += minutes(x)
	}
	if sum != 240 {
		t.Errorf("done+planned = %d, want effort 240", sum)
	}
	// undo restores
	r3, _ := BlockAction(ActionRequest{Action: "undo", BlockID: b.ID, Plan: r2.Plan, Items: r2.Items, Profile: kolkata(), Now: testNow})
	for _, x := range r3.Items {
		if x.ID == "ps4" && x.DoneMin != 0 {
			t.Errorf("undo left DoneMin=%d", x.DoneMin)
		}
	}
	if _, err := BlockAction(ActionRequest{Action: "nope", BlockID: b.ID, Plan: p, Items: items, Profile: kolkata(), Now: testNow}); err == nil {
		t.Error("bad action accepted")
	}
	if _, err := BlockAction(ActionRequest{Action: "done", BlockID: "missing", Plan: p, Items: items, Profile: kolkata(), Now: testNow}); err == nil {
		t.Error("missing block accepted")
	}
}

func TestSnooze(t *testing.T) {
	items := sampleItems()
	p := mustPlan(t, PlanRequest{Items: items, Profile: kolkata(), Now: testNow})
	b := findWork(p, "ps4")[0]
	r, err := BlockAction(ActionRequest{Action: "snooze", BlockID: b.ID, Plan: p, Items: items, Profile: kolkata(), Now: testNow})
	if err != nil {
		t.Fatal(err)
	}
	var nb model.Block
	for _, x := range r.Plan.Blocks {
		if x.ID == b.ID {
			nb = x
		}
	}
	if !nb.Pinned || !model.MustTime(nb.Start).After(model.MustTime(b.Start)) {
		t.Fatalf("snooze did not move+pin: %+v", nb)
	}
	// plan() releases any kept block that now collides with the snoozed one
	mustPlan(t, PlanRequest{Items: items, Profile: kolkata(), Now: testNow, Existing: r.Plan.Blocks})
}

func TestMovedReasonSameDay(t *testing.T) {
	items := sampleItems()
	p := mustPlan(t, PlanRequest{Items: items, Profile: kolkata(), Now: testNow})
	res, err := Replan(ReplanRequest{Items: items, Profile: kolkata(), Now: "2026-11-02T15:21:00+05:30", Current: p})
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range res.Changes {
		if c.Kind != "moved" || c.FromStart == "" || c.ToStart == "" {
			continue
		}
		if c.FromStart[:10] == c.ToStart[:10] && model.MustTime(c.FromStart).After(model.MustTime("2026-11-02T15:21:00+05:30")) && contains(c.Reason, "already passes") {
			t.Errorf("same-day shuffle claims the day is full: %+v", c)
		}
	}
}
