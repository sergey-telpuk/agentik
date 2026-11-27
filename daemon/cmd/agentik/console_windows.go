//go:build windows

package main

import "syscall"

// prepareConsole switches the console output code page to UTF-8, so the
// pairing QR code (Unicode block characters) is not garbled by a legacy OEM
// code page. Failure is ignored: output then only looks wrong.
func prepareConsole() {
	setOutputCP := syscall.NewLazyDLL("kernel32.dll").NewProc("SetConsoleOutputCP")
	_, _, _ = setOutputCP.Call(65001)
}
