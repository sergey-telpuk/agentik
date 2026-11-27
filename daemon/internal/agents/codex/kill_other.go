//go:build !windows

package codex

import "os"

// killProcessTree stops the agent process. On Unix a plain kill is used, as
// before.
func killProcessTree(p *os.Process) {
	if p != nil {
		_ = p.Kill()
	}
}
