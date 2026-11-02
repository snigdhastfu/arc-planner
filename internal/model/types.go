// Package model holds the plain data types shared by every Arc core package.
// Everything here is JSON-friendly (lowerCamelCase tags) and free of any
// browser, database or filesystem dependency.
package model

// Item types.
const (
	TypeExam       = "exam"
	TypeAssignment = "assignment"
	TypeProject    = "project"
	TypeEvent      = "event"
	TypeRoutine    = "routine"
)

// Block kinds and statuses.
const (
	KindWork    = "work"
	KindRoutine = "routine"
	KindEvent   = "event"

	StatusPlanned = "planned"
	StatusDone    = "done"
	StatusSkipped = "skipped"
	StatusMoved   = "moved"
)

// Energy levels.
const (
	EnergyHigh = "high"
	EnergyMed  = "med"
	EnergyLow  = "low"
)

// Profile describes the single user's day shape and ambition.
type Profile struct {
	TZ             string         `json:"tz"`
	WakeMin        int            `json:"wakeMin"`
	SleepMin       int            `json:"sleepMin"`
	AmbitionMin    int            `json:"ambitionMin"`
	DayOverrides   map[string]int `json:"dayOverrides,omitempty"`
	Energy         []EnergyWindow `json:"energy"`
	BlockMin       int            `json:"blockMin"`
	OverloadFactor float64        `json:"overloadFactor"`
}

// EnergyWindow is a span of the day with a given energy level.
type EnergyWindow struct {
	StartMin int    `json:"startMin"`
	EndMin   int    `json:"endMin"`
	Level    string `json:"level"`
}

// Recur is a minimal recurrence rule. Days use 0=Sunday.
type Recur struct {
	Freq     string `json:"freq"`
	Interval int    `json:"interval,omitempty"`
	Days     []int  `json:"days,omitempty"`
	Until    string `json:"until,omitempty"`
}

// RoutineSpec says where a routine sits in the day and how often.
type RoutineSpec struct {
	Anchor string `json:"anchor"` // morning|daytime|evening|time
	AtMin  *int   `json:"atMin,omitempty"`
	DurMin int    `json:"durMin"`
	Detail string `json:"detail,omitempty"`
	Group  string `json:"group,omitempty"`
	Order  int    `json:"order"`
	Recur  Recur  `json:"recur"`
}

// Item is anything the user wants to get done or attend.
type Item struct {
	ID           string       `json:"id"`
	Type         string       `json:"type"`
	Title        string       `json:"title"`
	Doodle       string       `json:"doodle,omitempty"`
	DoodleSource string       `json:"doodleSource,omitempty"`
	Start        string       `json:"start,omitempty"`
	End          string       `json:"end,omitempty"`
	Due          string       `json:"due,omitempty"`
	StartBy      string       `json:"startBy,omitempty"`
	EffortMin    int          `json:"effortMin,omitempty"`
	DoneMin      int          `json:"doneMin,omitempty"`
	Done         bool         `json:"done,omitempty"`
	Topics       []string     `json:"topics,omitempty"`
	ParentID     string       `json:"parentId,omitempty"`
	Notes        string       `json:"notes,omitempty"`
	Routine      *RoutineSpec `json:"routine,omitempty"`
	Recurrence   *Recur       `json:"recurrence,omitempty"`
	SeriesID     string       `json:"seriesId,omitempty"`
	Deleted      bool         `json:"deleted,omitempty"`
	UpdatedAt    string       `json:"updatedAt,omitempty"`
}

// Block is one scheduled slot of time.
type Block struct {
	ID     string `json:"id"`
	ItemID string `json:"itemId"`
	Seq    int    `json:"seq"`
	Start  string `json:"start"`
	End    string `json:"end"`
	Kind   string `json:"kind"`
	Why    string `json:"why"`
	Forced bool   `json:"forced,omitempty"`
	Pinned bool   `json:"pinned,omitempty"`
	Status string `json:"status"`
}

// AtRisk flags work that could not be placed before its deadline.
type AtRisk struct {
	ItemID   string `json:"itemId"`
	ShortMin int    `json:"shortMin"`
	Reason   string `json:"reason"`
}

// Plan is the full schedule output.
type Plan struct {
	Blocks      []Block  `json:"blocks"`
	AtRisk      []AtRisk `json:"atRisk"`
	GeneratedAt string   `json:"generatedAt"`
	Warnings    []string `json:"warnings"`
}

// Change is one line of a proposed replan diff.
type Change struct {
	ID        string `json:"id"`
	ItemID    string `json:"itemId"`
	BlockID   string `json:"blockId,omitempty"`
	Kind      string `json:"kind"` // moved|shortened|dropped|added|atRisk|watch
	FromStart string `json:"fromStart,omitempty"`
	FromEnd   string `json:"fromEnd,omitempty"`
	ToStart   string `json:"toStart,omitempty"`
	ToEnd     string `json:"toEnd,omitempty"`
	Reason    string `json:"reason"`
}
