// Command build produces the static site in dist/.
//
//	go run ./tools/build [-logo A|B|C] [-out dist]
//
// It works the same on Windows, macOS and Linux (no shell scripts).
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

// Config mirrors arc.config.json.
type Config struct {
	Name            string `json:"name"`
	ShortName       string `json:"shortName"`
	Description     string `json:"description"`
	Logo            string `json:"logo"`
	ThemeColor      string `json:"themeColor"`
	BackgroundColor string `json:"backgroundColor"`
}

func main() {
	logo := flag.String("logo", "", "logo set to use (A, B or C); defaults to arc.config.json")
	out := flag.String("out", "dist", "output directory")
	quiet := flag.Bool("q", false, "only print errors")
	flag.Parse()
	if err := Build(".", *out, *logo, *quiet); err != nil {
		fmt.Fprintln(os.Stderr, "build failed:", err)
		os.Exit(1)
	}
}

// Build runs every step. root is the repo root.
func Build(root, out, logoFlag string, quiet bool) error {
	logf := func(f string, a ...any) {
		if !quiet {
			fmt.Printf(f+"\n", a...)
		}
	}
	// 1. config
	var cfg Config
	raw, err := os.ReadFile(filepath.Join(root, "arc.config.json"))
	if err != nil {
		return err
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return fmt.Errorf("arc.config.json: %w", err)
	}
	if logoFlag != "" {
		cfg.Logo = logoFlag
	}
	cfg.Logo = strings.ToUpper(cfg.Logo)
	if cfg.Name == "" {
		cfg.Name = "Arc"
	}
	if cfg.ShortName == "" {
		cfg.ShortName = cfg.Name
	}
	if cfg.ThemeColor == "" {
		cfg.ThemeColor = "#000000"
	}
	if cfg.BackgroundColor == "" {
		cfg.BackgroundColor = "#000000"
	}
	logoDir := filepath.Join(root, "logos", cfg.Logo)
	if _, err := os.Stat(logoDir); err != nil {
		return fmt.Errorf("logo %q not found in logos/ (pick A, B or C)", cfg.Logo)
	}

	outDir := filepath.Join(root, out)
	if err := os.RemoveAll(outDir); err != nil {
		return err
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}

	// 2. wasm
	logf("building wasm…")
	cmd := exec.Command("go", "build", "-ldflags=-s -w", "-trimpath", "-o", filepath.Join(outDir, "arc.wasm"), "./cmd/arc-wasm")
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GOOS=js", "GOARCH=wasm")
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("wasm build: %w", err)
	}

	// 3. wasm_exec.js from the same toolchain
	gr, err := exec.Command("go", "env", "GOROOT").Output()
	if err != nil {
		return fmt.Errorf("go env GOROOT: %w", err)
	}
	goroot := strings.TrimSpace(string(gr))
	var copied bool
	for _, p := range []string{filepath.Join(goroot, "lib", "wasm", "wasm_exec.js"), filepath.Join(goroot, "misc", "wasm", "wasm_exec.js")} {
		if err := copyFile(p, filepath.Join(outDir, "wasm_exec.js")); err == nil {
			copied = true
			break
		}
	}
	if !copied {
		return fmt.Errorf("wasm_exec.js not found under %s", goroot)
	}

	// 4. web/ (templates are rendered, not copied)
	web := filepath.Join(root, "web")
	err = filepath.WalkDir(web, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(web, p)
		if d.IsDir() {
			return os.MkdirAll(filepath.Join(outDir, rel), 0o755)
		}
		if strings.Contains(d.Name(), ".template.") {
			return nil
		}
		if rel == "index.html" || rel == "offline.html" {
			b, err := os.ReadFile(p)
			if err != nil {
				return err
			}
			mark, err := os.ReadFile(filepath.Join(logoDir, "mark.svg"))
			if err != nil {
				return err
			}
			return os.WriteFile(filepath.Join(outDir, rel), []byte(renderHTML(string(b), cfg, string(mark))), 0o644)
		}
		return copyFile(p, filepath.Join(outDir, rel))
	})
	if err != nil {
		return err
	}

	// 5. icons + marks
	icons := filepath.Join(outDir, "icons")
	img := filepath.Join(outDir, "img")
	os.MkdirAll(icons, 0o755)
	os.MkdirAll(img, 0o755)
	for _, f := range []string{"icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon-180.png", "favicon-32.png", "icon.svg"} {
		if err := copyFile(filepath.Join(logoDir, f), filepath.Join(icons, f)); err != nil {
			return err
		}
	}
	if err := copyFile(filepath.Join(logoDir, "mark.svg"), filepath.Join(img, "mark.svg")); err != nil {
		return err
	}
	// All marks ship so Settings can switch the in-app mark without a rebuild.
	entries, _ := os.ReadDir(filepath.Join(root, "logos"))
	for _, e := range entries {
		if e.IsDir() {
			src := filepath.Join(root, "logos", e.Name(), "mark.svg")
			if _, err := os.Stat(src); err == nil {
				copyFile(src, filepath.Join(img, "mark-"+e.Name()+".svg"))
			}
		}
	}

	// 6. manifest
	manifest := map[string]any{
		"name": cfg.Name, "short_name": cfg.ShortName, "description": cfg.Description,
		"start_url": "./", "scope": "./", "display": "standalone", "orientation": "portrait",
		"theme_color": cfg.ThemeColor, "background_color": cfg.BackgroundColor, "id": "./",
		"icons": []map[string]string{
			{"src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
			{"src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
			{"src": "icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
		},
	}
	if tpl, err := os.ReadFile(filepath.Join(web, "manifest.template.json")); err == nil {
		var extra map[string]any
		if json.Unmarshal(tpl, &extra) == nil {
			for k, v := range extra {
				if _, set := manifest[k]; !set {
					manifest[k] = v
				}
			}
		}
	}
	mb, _ := json.MarshalIndent(manifest, "", "  ")
	if err := os.WriteFile(filepath.Join(outDir, "manifest.webmanifest"), mb, 0o644); err != nil {
		return err
	}

	// 8. .nojekyll (before hashing so it is part of the file list)
	os.WriteFile(filepath.Join(outDir, ".nojekyll"), nil, 0o644)

	// 7. sw.js with version hash + precache list
	files, hash, err := listAndHash(outDir)
	if err != nil {
		return err
	}
	tpl, err := os.ReadFile(filepath.Join(web, "sw.template.js"))
	if err != nil {
		return err
	}
	var list []string
	list = append(list, "./")
	for _, f := range files {
		if f == ".nojekyll" {
			continue
		}
		list = append(list, "./"+f)
	}
	lj, _ := json.Marshal(list)
	sw := strings.ReplaceAll(string(tpl), "__VERSION__", hash)
	sw = strings.ReplaceAll(sw, "__PRECACHE__", string(lj))
	if err := os.WriteFile(filepath.Join(outDir, "sw.js"), []byte(sw), 0o644); err != nil {
		return err
	}

	// 9. sizes
	logf("built %s (logo %s, version %s)", out, cfg.Logo, hash)
	total := int64(0)
	files = append(files, "sw.js")
	sort.Strings(files)
	for _, f := range files {
		st, _ := os.Stat(filepath.Join(outDir, filepath.FromSlash(f)))
		total += st.Size()
		logf("  %8.1f KB  %s", float64(st.Size())/1024, f)
	}
	logf("  %8.1f KB  total", float64(total)/1024)
	return nil
}

func renderHTML(s string, cfg Config, mark string) string {
	// Inline the logo mark unchanged (only sizing/a11y attributes are added).
	mark = strings.TrimSpace(mark)
	mark = strings.Replace(mark, "<svg ", `<svg width="100%" height="100%" aria-hidden="true" focusable="false" `, 1)
	// pathLength lets the boot screen draw solid strokes on; dotted strokes keep their dashes.
	var parts []string
	for i, seg := range strings.Split(mark, "<path ") {
		if i > 0 && !strings.Contains(strings.SplitN(seg, ">", 2)[0], "stroke-dasharray") {
			seg = `pathLength="1" ` + seg
		}
		parts = append(parts, seg)
	}
	mark = strings.Join(parts, "<path ")
	r := strings.NewReplacer("__MARK_INLINE__", mark, "__APP_NAME__", htmlEsc(cfg.Name), "__APP_SHORT__", htmlEsc(cfg.ShortName),
		"__APP_DESC__", htmlEsc(cfg.Description), "__THEME__", cfg.ThemeColor, "__LOGO__", cfg.Logo)
	return r.Replace(s)
}

func htmlEsc(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace(s)
}

// listAndHash returns all files (slash paths, sorted) and a short sha256.
func listAndHash(dir string) ([]string, string, error) {
	var files []string
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		files = append(files, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return nil, "", err
	}
	sort.Strings(files)
	h := sha256.New()
	for _, f := range files {
		h.Write([]byte(f))
		fh, err := os.Open(filepath.Join(dir, filepath.FromSlash(f)))
		if err != nil {
			return nil, "", err
		}
		io.Copy(h, fh)
		fh.Close()
	}
	return files, hex.EncodeToString(h.Sum(nil))[:10], nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
