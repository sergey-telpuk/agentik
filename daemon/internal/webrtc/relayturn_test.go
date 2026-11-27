package webrtc

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestRelayTURNServesStoredCredentialsUntilTheyExpire(t *testing.T) {
	base := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	clock := base
	r := &RelayTURN{Now: func() time.Time { return clock }}

	// Nothing until the relay has answered: a phone must not be handed an
	// empty list that looks like a working configuration.
	if _, err := r.Servers(context.Background()); !errors.Is(err, ErrNoRelayCredentials) {
		t.Fatalf("got %v, want ErrNoRelayCredentials", err)
	}

	r.Store([]ICEServer{{URLs: []string{"turn:turn.example:3478"}, Username: "u", Credential: "c"}}, 10*time.Minute)

	servers, err := r.Servers(context.Background())
	if err != nil {
		t.Fatalf("Servers failed: %v", err)
	}
	if len(servers) != 1 || servers[0].Username != "u" {
		t.Fatalf("unexpected servers: %+v", servers)
	}

	// Expired credentials are absent, not stale: trying them would fail ICE
	// for a reason the phone could not see.
	clock = base.Add(11 * time.Minute)
	if _, err := r.Servers(context.Background()); !errors.Is(err, ErrNoRelayCredentials) {
		t.Fatalf("expired credentials were served: %v", err)
	}

	// A reconnect brings fresh ones.
	r.Store([]ICEServer{{URLs: []string{"turn:turn.example:3478"}, Username: "u2", Credential: "c2"}}, 10*time.Minute)
	servers, err = r.Servers(context.Background())
	if err != nil || len(servers) != 1 || servers[0].Username != "u2" {
		t.Fatalf("fresh credentials not served: %+v, %v", servers, err)
	}
}

func TestRelayTURNCopiesWhatItHandsOut(t *testing.T) {
	r := &RelayTURN{}
	r.Store([]ICEServer{{URLs: []string{"turn:turn.example:3478"}}}, time.Hour)

	first, err := r.Servers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	first[0].Username = "tampered"

	second, err := r.Servers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if second[0].Username != "" {
		t.Fatal("a caller could alter the stored credentials")
	}
}
