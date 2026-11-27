//go:build !windows

package main

// prepareConsole is a no-op outside Windows, where terminals use UTF-8.
func prepareConsole() {}
