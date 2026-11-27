// Package webrtc carries the phone-to-daemon data path over a WebRTC
// DataChannel.
//
// The Cloudflare relay is used for signaling only. This package answers the
// phone's SDP offer, exchanges ICE candidates through a Signaler, and opens a
// reliable, ordered DataChannel on which the Noise XX handshake and every RPC
// frame then travel. There is no fallback that sends application data through
// the relay: if the DataChannel does not open within the connect timeout, the
// connection is dropped and the phone reports the failure.
//
// Signaling is untrusted. SDP carries each peer's DTLS certificate
// fingerprint, and whoever sits on the signaling path could swap one. The
// acceptor therefore reads both fingerprints out of the SDP it received and
// the SDP it produced, and binds them into the Noise prologue
// (secure.WebRTCPrologue). A swapped fingerprint makes the two peers derive
// different prologues, so the Noise handshake fails and no session is created.
package webrtc
