// Package projects resolves the directories a remote client is allowed to
// work in.
//
// A client never names a filesystem path. It names a project id, which this
// package resolves against the locally configured catalogue. That is the
// boundary that keeps an arbitrary path arriving over the network from
// becoming an agent's working directory.
//
// A permitted directory is not a sandbox. If an agent runs a shell with the
// user's privileges, it can reach outside whatever this package approves.
// The checks here constrain what Agentik itself resolves, reads, and serves.
package projects

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

var (
	// ErrNotFound is returned when no project matches an id.
	ErrNotFound = errors.New("projects: no such project")
	// ErrOutsideProject is returned when a path escapes its project root.
	ErrOutsideProject = errors.New("projects: path is outside the project")
	// ErrInvalid is returned when a project definition is unusable.
	ErrInvalid = errors.New("projects: invalid project")
)

// Project is one directory the user has permitted, together with the agent
// allowed to run in it.
type Project struct {
	// ID is the stable identifier clients refer to. It never contains a
	// path, so a client cannot learn the layout of the machine from it.
	ID string
	// Name is the display label shown in the Mini App.
	Name string
	// Root is the absolute, symlink-resolved project directory.
	Root string
	// AllowedAgent names the only adapter permitted here.
	AllowedAgent string
}

// Catalogue holds the permitted projects for this computer.
//
// It is populated from local configuration, never from the network.
type Catalogue struct {
	mu   sync.RWMutex
	byID map[string]Project
}

// NewCatalogue validates and indexes a set of projects.
//
// Each root is resolved through symlinks at load time, so the stored root is
// the real directory. Resolving once here means later checks compare real
// paths against a real root rather than re-resolving on every request.
func NewCatalogue(list []Project) (*Catalogue, error) {
	c := &Catalogue{byID: make(map[string]Project, len(list))}
	for _, p := range list {
		if p.ID == "" {
			return nil, fmt.Errorf("%w: empty project id", ErrInvalid)
		}
		if _, exists := c.byID[p.ID]; exists {
			return nil, fmt.Errorf("%w: duplicate project id %q", ErrInvalid, p.ID)
		}
		if p.AllowedAgent == "" {
			return nil, fmt.Errorf("%w: project %q has no allowed agent", ErrInvalid, p.ID)
		}
		root, err := resolveRoot(p.Root)
		if err != nil {
			return nil, fmt.Errorf("%w: project %q: %v", ErrInvalid, p.ID, err)
		}
		p.Root = root
		if p.Name == "" {
			p.Name = filepath.Base(root)
		}
		c.byID[p.ID] = p
	}
	return c, nil
}

// resolveRoot turns a configured path into an absolute, symlink-free
// directory.
//
// The directory must already exist: a project root that is missing, or that
// is a file rather than a directory, is a configuration error worth reporting
// at load time rather than at the moment a task tries to run.
func resolveRoot(path string) (string, error) {
	if path == "" {
		return "", errors.New("empty project path")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve %q: %w", path, err)
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", fmt.Errorf("resolve %q: %w", abs, err)
	}
	info, err := os.Stat(real)
	if err != nil {
		return "", fmt.Errorf("stat %q: %w", real, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%q is not a directory", real)
	}
	return real, nil
}

// Get returns the project with the given id.
func (c *Catalogue) Get(id string) (Project, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	p, ok := c.byID[id]
	if !ok {
		// The error deliberately does not say whether some other project
		// exists at a similar id.
		return Project{}, fmt.Errorf("%w: %q", ErrNotFound, id)
	}
	return p, nil
}

// List returns the permitted projects in a stable order.
//
// The order is by id so that the Mini App sees a consistent list across
// calls rather than Go's randomised map iteration.
func (c *Catalogue) List() []Project {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make([]Project, 0, len(c.byID))
	for _, p := range c.byID {
		out = append(out, p)
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].ID < out[j-1].ID; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// Len reports how many projects are permitted.
func (c *Catalogue) Len() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.byID)
}

// Add validates a project and puts it in the catalogue, replacing any project
// with the same id. It returns the stored form, with the root resolved.
//
// Validation is the same as at load time, so a directory that does not exist,
// or a path that is not a directory, is refused here rather than when a task
// tries to run in it.
func (c *Catalogue) Add(p Project) (Project, error) {
	if p.ID == "" {
		return Project{}, fmt.Errorf("%w: empty project id", ErrInvalid)
	}
	if p.AllowedAgent == "" {
		return Project{}, fmt.Errorf("%w: project %q has no allowed agent", ErrInvalid, p.ID)
	}
	root, err := resolveRoot(p.Root)
	if err != nil {
		return Project{}, fmt.Errorf("%w: project %q: %v", ErrInvalid, p.ID, err)
	}
	p.Root = root
	if p.Name == "" {
		p.Name = filepath.Base(root)
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	// Two ids for one directory would let the same work look like two
	// projects, and the concurrency rule is per directory.
	for id, existing := range c.byID {
		if id != p.ID && existing.Root == root {
			return Project{}, fmt.Errorf("%w: %q is already the project %q", ErrInvalid, root, id)
		}
	}
	c.byID[p.ID] = p
	return p, nil
}

// Remove drops a project. It reports whether one was there.
func (c *Catalogue) Remove(id string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, ok := c.byID[id]
	delete(c.byID, id)
	return ok
}

// AllowsAgent reports whether the named agent may run in this project.
func (p Project) AllowsAgent(agent string) bool {
	return agent != "" && agent == p.AllowedAgent
}

// Resolve turns a project-relative path into an absolute path inside the
// project, or reports that it escapes.
//
// Both the lexical form and the symlink-resolved form are checked. A lexical
// check alone would miss a symlink inside the project pointing outside it; a
// symlink check alone would reject paths that do not exist yet. Where the
// target does not exist, the nearest existing ancestor is resolved instead,
// which catches a path that would be created through a symlink out of the
// project.
func (p Project) Resolve(relative string) (string, error) {
	if filepath.IsAbs(relative) {
		return "", fmt.Errorf("%w: %q is absolute", ErrOutsideProject, relative)
	}
	// Reject NUL outright: it terminates a path for the OS but not for Go,
	// so it can make a checked string differ from the path actually used.
	if strings.ContainsRune(relative, 0) {
		return "", fmt.Errorf("%w: path contains a NUL byte", ErrOutsideProject)
	}

	candidate := filepath.Join(p.Root, relative)
	if !withinRoot(p.Root, candidate) {
		return "", fmt.Errorf("%w: %q", ErrOutsideProject, relative)
	}

	resolved, err := resolveExisting(candidate)
	if err != nil {
		return "", fmt.Errorf("%w: resolve %q: %v", ErrOutsideProject, relative, err)
	}
	if !withinRoot(p.Root, resolved) {
		return "", fmt.Errorf("%w: %q resolves outside the project", ErrOutsideProject, relative)
	}
	return candidate, nil
}

// resolveExisting resolves symlinks for path, falling back to the nearest
// ancestor that exists.
//
// A path that has not been created yet cannot be resolved directly, but the
// directory it would be created in can be, and that is what determines
// whether the write lands inside the project.
func resolveExisting(path string) (string, error) {
	remainder := ""
	current := path
	for {
		resolved, err := filepath.EvalSymlinks(current)
		if err == nil {
			if remainder == "" {
				return resolved, nil
			}
			return filepath.Join(resolved, remainder), nil
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		parent := filepath.Dir(current)
		if parent == current {
			// Reached the filesystem root without finding anything that
			// exists, which should not happen for an absolute path.
			return "", err
		}
		remainder = filepath.Join(filepath.Base(current), remainder)
		current = parent
	}
}

// withinRoot reports whether path is root itself or lies beneath it.
//
// The separator check is what stops "/home/user/project-secrets" from being
// treated as inside "/home/user/project".
func withinRoot(root, path string) bool {
	if path == root {
		return true
	}
	return strings.HasPrefix(path, root+string(filepath.Separator))
}
