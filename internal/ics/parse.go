// Package ics imports and exports iCalendar (RFC 5545) data for Arc.
//
// It supports a deliberately small, well-tested subset: VEVENTs with
// DTSTART/DTEND/DURATION, SUMMARY, LOCATION, simple DAILY/WEEKLY RRULEs and
// EXDATEs. Anything outside that subset is reported back as a "skipped"
// reason rather than an error. The package is pure: it never reads the clock,
// the filesystem or the network.
package ics

import (
	"strings"
)

// prop is one parsed content line: NAME;PARAM=VALUE:value.
type prop struct {
	Name   string            // upper-cased
	Params map[string]string // keys upper-cased, values unquoted
	Value  string            // raw (still escaped) value
}

// Param returns a parameter value (upper-cased key lookup).
func (p prop) Param(k string) string { return p.Params[strings.ToUpper(k)] }

// component is a BEGIN/END block with its properties and children.
type component struct {
	Name     string
	Props    []prop
	Children []*component
}

// first returns the first property with the given name.
func (c *component) first(name string) (prop, bool) {
	for _, p := range c.Props {
		if p.Name == name {
			return p, true
		}
	}
	return prop{}, false
}

// all returns every property with the given name, in order.
func (c *component) all(name string) []prop {
	var out []prop
	for _, p := range c.Props {
		if p.Name == name {
			out = append(out, p)
		}
	}
	return out
}

// unfold joins folded lines (CRLF or LF followed by a space or tab) and
// returns the logical content lines. Empty lines are dropped.
func unfold(s string) []string {
	s = strings.TrimPrefix(s, "\ufeff")
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	var out []string
	var cur strings.Builder
	has := false
	for _, ln := range strings.Split(s, "\n") {
		if len(ln) > 0 && (ln[0] == ' ' || ln[0] == '\t') {
			if has {
				cur.WriteString(ln[1:])
				continue
			}
			ln = ln[1:]
		}
		if has && cur.Len() > 0 {
			out = append(out, cur.String())
		}
		cur.Reset()
		cur.WriteString(ln)
		has = true
	}
	if has && cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}

// parseLine splits a content line into name, params and value.
// ok is false when the line has no ':' separator or no name.
func parseLine(line string) (prop, bool) {
	inQuote := false
	colon := -1
	for i := 0; i < len(line); i++ {
		c := line[i]
		if c == '"' {
			inQuote = !inQuote
		} else if c == ':' && !inQuote {
			colon = i
			break
		}
	}
	if colon <= 0 {
		return prop{}, false
	}
	head, value := line[:colon], line[colon+1:]
	parts := splitUnquoted(head, ';')
	name := strings.ToUpper(strings.TrimSpace(parts[0]))
	if name == "" {
		return prop{}, false
	}
	p := prop{Name: name, Params: map[string]string{}, Value: value}
	for _, kv := range parts[1:] {
		k, v, found := strings.Cut(kv, "=")
		if !found {
			continue
		}
		v = strings.TrimSpace(v)
		if len(v) >= 2 && v[0] == '"' && v[len(v)-1] == '"' {
			v = v[1 : len(v)-1]
		}
		p.Params[strings.ToUpper(strings.TrimSpace(k))] = v
	}
	return p, true
}

// splitUnquoted splits s on sep, ignoring separators inside double quotes.
func splitUnquoted(s string, sep byte) []string {
	var out []string
	inQuote := false
	start := 0
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '"':
			inQuote = !inQuote
		case sep:
			if !inQuote {
				out = append(out, s[start:i])
				start = i + 1
			}
		}
	}
	return append(out, s[start:])
}

// parseComponents builds the component tree. The returned slice holds the
// top-level components (normally a single VCALENDAR). Lines outside any
// component and unbalanced END lines are ignored; unterminated components
// are closed at end of input.
func parseComponents(s string) []*component {
	var roots []*component
	var stack []*component
	for _, ln := range unfold(s) {
		p, ok := parseLine(ln)
		if !ok {
			continue
		}
		switch p.Name {
		case "BEGIN":
			c := &component{Name: strings.ToUpper(strings.TrimSpace(p.Value))}
			if len(stack) == 0 {
				roots = append(roots, c)
			} else {
				parent := stack[len(stack)-1]
				parent.Children = append(parent.Children, c)
			}
			stack = append(stack, c)
		case "END":
			name := strings.ToUpper(strings.TrimSpace(p.Value))
			// Pop up to and including the matching component.
			for i := len(stack) - 1; i >= 0; i-- {
				if stack[i].Name == name {
					stack = stack[:i]
					break
				}
			}
		default:
			if len(stack) > 0 {
				top := stack[len(stack)-1]
				top.Props = append(top.Props, p)
			}
		}
	}
	return roots
}

// unescapeText reverses RFC 5545 TEXT escaping (\\ \; \, \n \N).
func unescapeText(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c != '\\' || i+1 >= len(s) {
			b.WriteByte(c)
			continue
		}
		i++
		switch s[i] {
		case 'n', 'N':
			b.WriteByte('\n')
		default: // \\ \; \, and anything unknown: keep the escaped char
			b.WriteByte(s[i])
		}
	}
	return b.String()
}

// escapeText applies RFC 5545 TEXT escaping.
func escapeText(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	var b strings.Builder
	for _, r := range s {
		switch r {
		case '\\':
			b.WriteString(`\\`)
		case ';':
			b.WriteString(`\;`)
		case ',':
			b.WriteString(`\,`)
		case '\n':
			b.WriteString(`\n`)
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}
