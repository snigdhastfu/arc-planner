// Command dev builds dist/ and serves it locally with no caching.
//
//	go run ./tools/dev [-port 8080] [-logo B]
//
// Visit /__rebuild to rebuild without restarting.
package main

import (
	"compress/gzip"
	"flag"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
)

// gzipWriter compresses responses like GitHub Pages does, so local timings are honest.
type gzipWriter struct {
	http.ResponseWriter
	w io.Writer
}

func (g gzipWriter) Write(b []byte) (int, error) { return g.w.Write(b) }

func (g gzipWriter) WriteHeader(code int) {
	g.ResponseWriter.Header().Del("Content-Length") // length is of the uncompressed file
	g.ResponseWriter.WriteHeader(code)
}

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
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") || strings.HasSuffix(r.URL.Path, ".png") || strings.HasSuffix(r.URL.Path, ".woff2") {
			files.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Add("Vary", "Accept-Encoding")
		gz := gzip.NewWriter(w)
		defer gz.Close()
		files.ServeHTTP(gzipWriter{ResponseWriter: w, w: gz}, r)
	})
	addr := fmt.Sprintf("%s:%d", *host, *port)
	log.Printf("Arc dev server on http://%s/  (rebuild: /__rebuild)", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}
