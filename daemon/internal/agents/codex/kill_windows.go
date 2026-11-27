//go:build windows

package codex

import (
	"os"
	"os/exec"
	"strconv"
)

// killProcessTree stops the agent process and its children.
//
// On Windows the npm shim codex.cmd runs through cmd.exe, which starts node
// and the real agent as children. Process.Kill only ends cmd.exe and would
// leave the agent running, so taskkill /T is asked to end the whole tree first.
// If taskkill is unavailable or fails, the process is killed directly.
func killProcessTree(p *os.Process) {
	if p == nil {
		return
	}
	if err := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(p.Pid)).Run(); err == nil {
		return
	}
	_ = p.Kill()
}
