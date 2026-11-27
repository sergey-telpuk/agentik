package main

import (
	"context"
	"fmt"

	"github.com/sergey-telpuk/agentik/daemon/internal/projects"
	"github.com/sergey-telpuk/agentik/daemon/internal/storage"
)

// loadProjects reads the permitted projects from the database.
//
// A row whose directory has since been renamed or deleted is skipped rather
// than failing the start: the rest of the setup still works, and the phone
// can remove or replace the entry.
func loadProjects(ctx context.Context, db *storage.DB) ([]projects.Project, error) {
	rows, err := db.SQL().QueryContext(ctx,
		`SELECT id, name, path, allowed_agent FROM projects WHERE removed_at IS NULL ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("read stored projects: %w", err)
	}
	defer rows.Close()

	var out []projects.Project
	for rows.Next() {
		var p projects.Project
		if err := rows.Scan(&p.ID, &p.Name, &p.Root, &p.AllowedAgent); err != nil {
			return nil, fmt.Errorf("read stored project: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// mergeProjects puts the command-line projects on top of the stored ones, so
// a --project flag wins for the id it names and the rest are kept.
func mergeProjects(stored, configured []projects.Project) []projects.Project {
	byID := make(map[string]projects.Project, len(stored)+len(configured))
	order := make([]string, 0, len(stored)+len(configured))
	for _, p := range append(append([]projects.Project(nil), stored...), configured...) {
		if _, seen := byID[p.ID]; !seen {
			order = append(order, p.ID)
		}
		byID[p.ID] = p
	}
	out := make([]projects.Project, 0, len(order))
	for _, id := range order {
		out = append(out, byID[id])
	}
	return out
}
