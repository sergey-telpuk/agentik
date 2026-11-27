// Command agentik is the local Agentik daemon.
//
// At this stage it initialises the pieces that must exist before any remote
// connection is possible: the device identity and the local database. The
// relay transport, pairing flow, and agent adapters are added on top of these
// in later stages.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/sergey-telpuk/agentik/daemon/internal/identity"
	"github.com/sergey-telpuk/agentik/daemon/internal/storage"
)

func main() {
	// Signals are handled so that a shutdown in progress can be observed
	// by the setup steps rather than killing the process mid-write.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, os.Args[1:], os.Stdout); err != nil {
		if errors.Is(err, context.Canceled) {
			return
		}
		fmt.Fprintf(os.Stderr, "agentik: %v\n", err)
		os.Exit(1)
	}
}

// run holds the real entry point so it returns errors instead of exiting,
// which keeps it testable.
func run(ctx context.Context, args []string, out *os.File) error {
	fs := flag.NewFlagSet("agentik", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	dataDir := fs.String("data-dir", "", "directory for identity and database (default: platform data directory)")
	showStatus := fs.Bool("status", false, "print the device identity and exit")
	if err := fs.Parse(args); err != nil {
		return err
	}

	store, err := identity.NewStore(*dataDir)
	if err != nil {
		return err
	}
	id, created, err := store.LoadOrCreate()
	if err != nil {
		return err
	}

	db, err := storage.Open(ctx, storage.DefaultPath(store.Dir()))
	if err != nil {
		return err
	}
	defer db.Close()

	version, err := db.SchemaVersion(ctx)
	if err != nil {
		return err
	}

	if created {
		fmt.Fprintln(out, "Created a new device identity.")
	}
	// The public identifier is safe to print; the private keys are not and
	// are never written to stdout or to logs.
	fmt.Fprintf(out, "device id:     %s\n", id.DeviceIDString())
	fmt.Fprintf(out, "data dir:      %s\n", store.Dir())
	fmt.Fprintf(out, "database:      %s (schema v%d)\n", db.Path(), version)

	if *showStatus {
		return nil
	}

	fmt.Fprintln(out, "\nThe relay connection is not implemented yet; nothing is listening.")
	fmt.Fprintln(out, "Press Ctrl+C to exit.")
	<-ctx.Done()
	fmt.Fprintln(out, "Shutting down.")
	return nil
}
