// Command dev builds dist/ and serves it locally with no caching.
//
//	go run ./tools/dev [-port 8080] [-logo B]
//
// Visit /__rebuild to rebuild without restarting.
package main

import (
	"flag"
	"fmt"
	"log"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"sync"
)

func main() {
	port := flag.Int("port", 8080, "port to listen on")
	logo := flag.String("logo", "", "logo override (A, B or C)")
	host := flag.String("host", "localhost", "interface to bind (use 0.0.0.0 to test from a phone on your network)")
	flag.Parse()

	mime.AddExtensionType(".wasm", "application/wasm")
	mime.AddExtensionType(".webmanifest", "application/manifest+json")
	mime.AddExtensionType(".js", "text/javascript; charset=utf-8")
	mime.AddExtensionType(".woff2", "font/woff2")

	var mu sync.Mutex
	build := func() error {
		mu.Lock()
		defer mu.Unlock()
		args := []string{"run", "./tools/build", "-q"}
		if *logo != "" {
			args = append(args, "-logo", *logo)
		}
		cmd := exec.Command("go", args...)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		return cmd.Run()
	}
	if err := build(); err != nil {
		log.Fatal(err)
	}
	files := http.FileServer(http.Dir("dist"))
	http.HandleFunc("/__rebuild", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if err := build(); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		fmt.Fprintln(w, "rebuilt")
	})
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		files.ServeHTTP(w, r)
	})
	addr := fmt.Sprintf("%s:%d", *host, *port)
	log.Printf("Arc dev server on http://%s/  (rebuild: /__rebuild)", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}
