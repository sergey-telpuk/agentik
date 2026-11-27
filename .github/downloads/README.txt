Agentik daemon for macOS and Windows
====================================

Files
-----
  agentik-darwin-arm64   Apple Silicon (M1, M2, M3, ...)
  agentik-darwin-amd64   Intel Macs
  agentik-windows-amd64.exe   Windows 10 and 11, 64-bit (Intel/AMD)
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
  chmod +x agentik-darwin-arm64
  ./agentik-darwin-arm64 -version
  ./agentik-darwin-arm64 -pair

Use agentik-darwin-amd64 on an Intel Mac. Run with -h to list all options.

Windows
=======
The terminal feature is not available on Windows yet; everything else
(pairing, projects, running agents such as Codex) works the same way.

Download agentik-windows-amd64.exe and SHA256SUMS from the same folder
(https://sergey-telpuk.github.io/agentik/downloads/).

Verify the checksum
-------------------
In PowerShell or Command Prompt, run:

  certutil -hashfile agentik-windows-amd64.exe SHA256

Compare the printed hash with the agentik-windows-amd64.exe line in SHA256SUMS.
They must be identical.

SmartScreen
-----------
The program is not code-signed, so Windows SmartScreen may warn that it
protects your PC from an unrecognized app. Click "More info", then
"Run anyway". Only do this for a file whose checksum you verified.

Run
---
  .\agentik-windows-amd64.exe -version
  .\agentik-windows-amd64.exe -pair

The daemon keeps its data in %AppData%\Agentik. Press Ctrl+C to stop it.
