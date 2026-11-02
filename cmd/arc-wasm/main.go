//go:build js && wasm

// Command arc-wasm exposes the Arc core to the browser as globalThis.arc.
// Every function takes one JSON string and returns one JSON envelope string.
package main

import (
	"syscall/js"
	_ "time/tzdata"

	"arc/internal/doodle"
	"arc/internal/ics"
	"arc/internal/model"
	"arc/internal/parse"
	"arc/internal/planner"
	"arc/internal/postcard"
)

// Version is the core version reported by arc.version().
const Version = "1.0.0"

type matchReq struct {
	Title string `json:"title"`
	Type  string `json:"type"`
}

func wrap(fn func(string) string) js.Func {
	return js.FuncOf(func(this js.Value, args []js.Value) any {
		req := ""
		if len(args) > 0 && args[0].Type() == js.TypeString {
			req = args[0].String()
		}
		return fn(req)
	})
}

func main() {
	api := map[string]func(string) string{
		"plan":          func(r string) string { return model.Handle(r, planner.Plan) },
		"replan":        func(r string) string { return model.Handle(r, planner.Replan) },
		"applyChanges":  func(r string) string { return model.Handle(r, planner.ApplyChanges) },
		"blockAction":   func(r string) string { return model.Handle(r, planner.BlockAction) },
		"parseQuickAdd": func(r string) string { return model.Handle(r, parse.QuickAdd) },
		"matchDoodle": func(r string) string {
			return model.Handle(r, func(in matchReq) (map[string]string, error) {
				return map[string]string{"doodle": doodle.Match(in.Title, in.Type)}, nil
			})
		},
		"icsImport": func(r string) string { return model.Handle(r, ics.Import) },
		"icsExport": func(r string) string { return model.Handle(r, ics.Export) },
		"postcard":  func(r string) string { return model.Handle(r, postcard.Compose) },
		"version": func(string) string {
			return model.Handle("", func(struct{}) (map[string]string, error) {
				return map[string]string{"version": Version}, nil
			})
		},
	}
	obj := js.Global().Get("Object").New()
	for name, fn := range api {
		obj.Set(name, wrap(fn))
	}
	js.Global().Set("arc", obj)
	js.Global().Set("arcReady", true)
	ev := js.Global().Get("Event").New("arc-ready")
	js.Global().Call("dispatchEvent", ev)
	select {}
}
