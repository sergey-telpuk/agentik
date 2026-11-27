Agentik daemon for macOS
========================

Files
-----
  agentik-darwin-arm64   Apple Silicon (M1, M2, M3, ...)
  agentik-darwin-amd64   Intel Macs
  SHA256SUMS             SHA-256 checksums of all binaries

Not sure which Mac you have? Run `uname -m` in Terminal:
arm64 means Apple Silicon, x86_64 means Intel.

Download with curl (recommended)
--------------------------------
  curl -fLO https://sergey-telpuk.github.io/agentik/downloads/agentik-darwin-arm64
  curl -fLO https://sergey-telpuk.github.io/agentik/downloads/SHA256SUMS

Files downloaded with curl are not quarantined, so macOS Gatekeeper does not
block them. If you download through a browser instead, macOS may refuse to run
the binary; approve it in System Settings > Privacy & Security ("Allow Anyway"),
or remove the quarantine flag: xattr -d com.apple.quarantine agentik-darwin-arm64

Verify the checksum
-------------------
Put the binary and SHA256SUMS in the same directory, then run:

  shasum -a 256 -c SHA256SUMS --ignore-missing

Each file you downloaded must be reported as OK. (Without --ignore-missing,
shasum also reports the binary you did not download as missing.)

Run
---
A downloaded file is not executable yet, whichever way you got it, so the
first step is not optional:

  chmod +x agentik-darwin-arm64
  ./agentik-darwin-arm64

That prints a QR code. Scan it with Agentik in Telegram, then confirm the
phone here with y. Nothing else has to be configured: you add the folders an
agent may work in from the phone.

Use agentik-darwin-amd64 on an Intel Mac. Run with -h to list all options.

