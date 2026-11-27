package pairing

import (
	"fmt"
	"os"
	"strings"

	"rsc.io/qr"
)

// QRQuietZone is the number of blank modules around the code. Four is the
// width the QR specification asks for; narrower margins scan unreliably.
const QRQuietZone = 4

// QRLevel is the error correction level of the pairing QR code. Level M
// survives about 15% damage, which covers a terminal's font rendering and a
// phone camera at an angle.
const QRLevel = qr.M

// QRVersion returns the QR symbol version (1..40) needed for payload at
// QRLevel.
func QRVersion(payload string) (int, error) {
	code, err := qr.Encode(payload, QRLevel)
	if err != nil {
		return 0, fmt.Errorf("pairing: encode QR code: %w", err)
	}
	return (code.Size - 17) / 4, nil
}

// RenderQR encodes payload as a terminal QR code drawn with Unicode half-block
// characters, so each text line carries two module rows and the code takes
// about half the height of a plain two-characters-per-module rendering.
//
// Unless NO_COLOR is set or TERM is "dumb", the code is drawn in black on an
// explicit white background so it has the right polarity on both dark and
// light terminals. Without colour it falls back to inverted glyphs, which are
// correct on a dark terminal.
func RenderQR(payload string) (string, error) {
	return renderQR(payload, useColor())
}

func useColor() bool {
	return os.Getenv("NO_COLOR") == "" && os.Getenv("TERM") != "dumb"
}

const (
	ansiBlackOnWhite = "\x1b[30;47m"
	ansiReset        = "\x1b[0m"
)

func renderQR(payload string, color bool) (string, error) {
	code, err := qr.Encode(payload, QRLevel)
	if err != nil {
		return "", fmt.Errorf("pairing: encode QR code: %w", err)
	}
	total := code.Size + 2*QRQuietZone
	dark := func(x, y int) bool {
		qx, qy := x-QRQuietZone, y-QRQuietZone
		if qx < 0 || qy < 0 || qx >= code.Size || qy >= code.Size {
			return false
		}
		return code.Black(qx, qy)
	}

	// Glyph for (top, bottom) module pairs.
	glyph := func(top, bottom bool) rune {
		if color { // black foreground on white background
			switch {
			case top && bottom:
				return '█'
			case top:
				return '▀'
			case bottom:
				return '▄'
			}
			return ' '
		}
		// Dark terminal: the glyph's lit part is a light module.
		switch {
		case top && bottom:
			return ' '
		case top:
			return '▄'
		case bottom:
			return '▀'
		}
		return '█'
	}

	var b strings.Builder
	for y := 0; y < total; y += 2 {
		if color {
			b.WriteString(ansiBlackOnWhite)
		}
		for x := range total {
			b.WriteRune(glyph(dark(x, y), y+1 < total && dark(x, y+1)))
		}
		if color {
			b.WriteString(ansiReset)
		}
		b.WriteByte('\n')
	}
	return b.String(), nil
}
