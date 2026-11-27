package projects

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// newProject builds a catalogue with a single project rooted at a temporary
// directory, and returns the resolved project.
func newProject(t *testing.T) Project {
	t.Helper()
	// The temporary directory is resolved because macOS places it behind a
	// /var -> /private/var symlink, and the catalogue stores real paths.
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	c, err := NewCatalogue([]Project{{
		ID:           "p1",
		Name:         "Demo",
		Root:         root,
		AllowedAgent: "codex",
	}})
	if err != nil {
		t.Fatalf("NewCatalogue: %v", err)
	}
	p, err := c.Get("p1")
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestCatalogueGetAndList(t *testing.T) {
	rootA, rootB := t.TempDir(), t.TempDir()
	c, err := NewCatalogue([]Project{
		{ID: "b", Root: rootB, AllowedAgent: "codex"},
		{ID: "a", Root: rootA, AllowedAgent: "codex"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if c.Len() != 2 {
		t.Fatalf("Len = %d, want 2", c.Len())
	}

	// A stable order keeps the Mini App's project list from reshuffling
	// between calls.
	list := c.List()
	if list[0].ID != "a" || list[1].ID != "b" {
		t.Fatalf("List order = %q, %q; want a, b", list[0].ID, list[1].ID)
	}

	if _, err := c.Get("missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v, want ErrNotFound", err)
	}
}

func TestCatalogueRejectsBadDefinitions(t *testing.T) {
	dir := t.TempDir()
	cases := map[string][]Project{
		"empty id":      {{ID: "", Root: dir, AllowedAgent: "codex"}},
		"no agent":      {{ID: "p", Root: dir}},
		"empty path":    {{ID: "p", Root: "", AllowedAgent: "codex"}},
		"missing dir":   {{ID: "p", Root: filepath.Join(dir, "nope"), AllowedAgent: "codex"}},
		"duplicate ids": {{ID: "p", Root: dir, AllowedAgent: "codex"}, {ID: "p", Root: dir, AllowedAgent: "codex"}},
	}
	for name, list := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := NewCatalogue(list); !errors.Is(err, ErrInvalid) {
				t.Fatalf("got %v, want ErrInvalid", err)
			}
		})
	}
}

// TestCatalogueRejectsFileAsRoot catches a configuration mistake that would
// otherwise fail later, when a task tried to run in a non-directory.
func TestCatalogueRejectsFileAsRoot(t *testing.T) {
	file := filepath.Join(t.TempDir(), "notadir")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewCatalogue([]Project{{ID: "p", Root: file, AllowedAgent: "codex"}}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("got %v, want ErrInvalid", err)
	}
}

func TestNameDefaultsToDirectory(t *testing.T) {
	root := filepath.Join(t.TempDir(), "my-service")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	c, err := NewCatalogue([]Project{{ID: "p", Root: root, AllowedAgent: "codex"}})
	if err != nil {
		t.Fatal(err)
	}
	p, _ := c.Get("p")
	if p.Name != "my-service" {
		t.Fatalf("Name = %q, want %q", p.Name, "my-service")
	}
}

func TestAllowsAgent(t *testing.T) {
	p := newProject(t)
	if !p.AllowsAgent("codex") {
		t.Fatal("the configured agent must be allowed")
	}
	if p.AllowsAgent("other") {
		t.Fatal("an unconfigured agent must not be allowed")
	}
	// An empty agent name must not match an empty field by accident.
	if p.AllowsAgent("") {
		t.Fatal("an empty agent name must not be allowed")
	}
}

func TestResolveAcceptsPathsInsideProject(t *testing.T) {
	p := newProject(t)
	for _, rel := range []string{"main.go", "cmd/app/main.go", "./nested/file", "dir/../file"} {
		got, err := p.Resolve(rel)
		if err != nil {
			t.Fatalf("Resolve(%q): %v", rel, err)
		}
		if !withinRoot(p.Root, got) {
			t.Fatalf("Resolve(%q) = %q, outside the project root", rel, got)
		}
	}
}

// TestResolveRejectsTraversal is the basic escape attempt: a relative path
// climbing out of the project.
func TestResolveRejectsTraversal(t *testing.T) {
	p := newProject(t)
	for _, rel := range []string{"..", "../outside", "a/../../outside", "../"} {
		if _, err := p.Resolve(rel); !errors.Is(err, ErrOutsideProject) {
			t.Fatalf("Resolve(%q): got %v, want ErrOutsideProject", rel, err)
		}
	}
}

func TestResolveRejectsAbsolutePaths(t *testing.T) {
	p := newProject(t)
	abs := filepath.Join(string(filepath.Separator), "etc", "passwd")
	if _, err := p.Resolve(abs); !errors.Is(err, ErrOutsideProject) {
		t.Fatalf("got %v, want ErrOutsideProject", err)
	}
}

// TestResolveRejectsSymlinkEscape is the case a lexical check alone would
// miss: the path stays inside the project textually, but a symlink inside the
// project points out of it.
func TestResolveRejectsSymlinkEscape(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating symlinks on Windows needs elevated privileges")
	}
	p := newProject(t)
	secret := filepath.Join(t.TempDir(), "secrets")
	if err := os.Mkdir(secret, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(p.Root, "escape")); err != nil {
		t.Fatal(err)
	}

	if _, err := p.Resolve("escape"); !errors.Is(err, ErrOutsideProject) {
		t.Fatalf("symlink to an outside directory: got %v, want ErrOutsideProject", err)
	}
	if _, err := p.Resolve("escape/key.txt"); !errors.Is(err, ErrOutsideProject) {
		t.Fatalf("path through an escaping symlink: got %v, want ErrOutsideProject", err)
	}
}

// TestResolveAllowsSymlinkWithinProject confirms the symlink check rejects
// escapes specifically, rather than all symlinks.
func TestResolveAllowsSymlinkWithinProject(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating symlinks on Windows needs elevated privileges")
	}
	p := newProject(t)
	target := filepath.Join(p.Root, "real")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(p.Root, "link")); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Resolve("link/file.txt"); err != nil {
		t.Fatalf("a symlink staying inside the project was rejected: %v", err)
	}
}

// TestResolveHandlesNonExistentPaths matters because a task may write a file
// that does not exist yet; the check must look at where it would be created.
func TestResolveHandlesNonExistentPaths(t *testing.T) {
	p := newProject(t)
	if _, err := p.Resolve("new/dir/file.txt"); err != nil {
		t.Fatalf("a new path inside the project was rejected: %v", err)
	}
}

// TestResolveRejectsNewPathThroughEscapingSymlink covers a write that does
// not exist yet but whose parent directory leaves the project.
func TestResolveRejectsNewPathThroughEscapingSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating symlinks on Windows needs elevated privileges")
	}
	p := newProject(t)
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(p.Root, "out")); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Resolve("out/created-later.txt"); !errors.Is(err, ErrOutsideProject) {
		t.Fatalf("got %v, want ErrOutsideProject", err)
	}
}

// TestResolveRejectsNulByte guards against a path that the OS truncates at
// the NUL while Go treats it as a longer string.
func TestResolveRejectsNulByte(t *testing.T) {
	p := newProject(t)
	if _, err := p.Resolve("file\x00.txt"); !errors.Is(err, ErrOutsideProject) {
		t.Fatalf("got %v, want ErrOutsideProject", err)
	}
}

// TestWithinRootRequiresSeparator is the sibling-prefix case: a directory
// whose name merely starts with the root's name is not inside it.
func TestWithinRootRequiresSeparator(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), "home", "u", "project")
	sibling := root + "-secrets"
	if withinRoot(root, sibling) {
		t.Fatalf("%q was treated as inside %q", sibling, root)
	}
	if !withinRoot(root, root) {
		t.Fatal("the root must be inside itself")
	}
	if !withinRoot(root, filepath.Join(root, "file")) {
		t.Fatal("a child path must be inside the root")
	}
}

// TestResolveWithSpacesAndUnicode covers the path shapes the acceptance
// checklist calls out explicitly.
func TestResolveWithSpacesAndUnicode(t *testing.T) {
	p := newProject(t)
	for _, rel := range []string{"my folder/file name.txt", "проект/файл.go", "emoji 📁/x"} {
		got, err := p.Resolve(rel)
		if err != nil {
			t.Fatalf("Resolve(%q): %v", rel, err)
		}
		if !withinRoot(p.Root, got) {
			t.Fatalf("Resolve(%q) escaped the project", rel)
		}
	}
}
