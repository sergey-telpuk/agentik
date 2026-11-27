package codex

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"time"
)

const (
	modelListTimeout  = 15 * time.Second
	maxModelPages     = 5
	// maxModelsTotal and the text bounds keep an agent.list response well
	// inside the 32 KiB relay frame.
	maxModelsTotal    = 50
	maxModelIDBytes   = 128
	maxModelDescBytes = 160
)

// Models asks the Codex App Server for the models the signed-in account can
// run (`model/list`). When the App Server cannot be started or queried the
// result is an empty static fallback: the caller can then only use the
// agent's own default model, and no model identifier is guessed.
func (a *AppServerAdapter) Models(ctx context.Context) ModelCatalog {
	models, err := a.listModels(ctx)
	if err != nil {
		return ModelCatalog{
			Models: []Model{},
			Source: ModelSourceStatic,
			Detail: fmt.Sprintf("could not list models from codex app-server: %v", err),
		}
	}
	return ModelCatalog{Models: models, Source: ModelSourceLive}
}

func (a *AppServerAdapter) listModels(ctx context.Context) ([]Model, error) {
	path, err := exec.LookPath(a.binary)
	if err != nil {
		return nil, fmt.Errorf("binary unavailable: %w", err)
	}

	ctx, cancel := context.WithTimeout(ctx, modelListTimeout)
	defer cancel()

	fullArgs := append(append([]string(nil), a.extraArgs...), "app-server", "--listen", "stdio://")
	cmd := exec.CommandContext(ctx, path, fullArgs...)
	cmd.WaitDelay = time.Second
	if len(a.extraEnv) > 0 {
		cmd.Env = append(cmd.Environ(), a.extraEnv...)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &limitedWriter{w: &stderr, limit: 4 * 1024}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start app-server: %w", err)
	}
	defer func() {
		_ = stdin.Close()
		killProcessTree(cmd.Process)
		_ = cmd.Wait()
	}()

	reader := bufio.NewReaderSize(stdout, 64*1024)
	write := func(v any) error {
		data, err := json.Marshal(v)
		if err != nil {
			return err
		}
		_, err = stdin.Write(append(data, '\n'))
		return err
	}
	// call sends one request and returns the matching response, skipping
	// notifications and anything else the server emits in between.
	nextID := 0
	call := func(method string, params any) (json.RawMessage, error) {
		nextID++
		id := nextID
		if err := write(map[string]any{"id": id, "method": method, "params": params}); err != nil {
			return nil, err
		}
		for {
			line, err := readBoundedLine(reader, maxJSONLLineBytes)
			if len(bytes.TrimSpace(line)) > 0 {
				var msg wireMessage
				if json.Unmarshal(bytes.TrimSpace(line), &msg) == nil && msg.Method == "" && len(msg.ID) > 0 &&
					canonicalIDKey(msg.ID) == fmt.Sprint(id) {
					if msg.Error != nil {
						return nil, fmt.Errorf("rpc %d: %s", msg.Error.Code, msg.Error.Message)
					}
					return msg.Result, nil
				}
			}
			if err != nil {
				if ctx.Err() != nil {
					return nil, ctx.Err()
				}
				if errors.Is(err, io.EOF) {
					if detail := strings.TrimSpace(stderr.String()); detail != "" {
						return nil, fmt.Errorf("app-server closed: %s", truncateStr(detail, 200))
					}
					return nil, errors.New("app-server closed before responding")
				}
				return nil, err
			}
		}
	}

	if _, err := call("initialize", map[string]any{
		"clientInfo":   map[string]any{"name": "agentik-daemon", "title": "Agentik", "version": a.clientVersion},
		"capabilities": map[string]any{"experimentalApi": false},
	}); err != nil {
		return nil, fmt.Errorf("initialize: %w", err)
	}
	if err := write(map[string]any{"method": "initialized"}); err != nil {
		return nil, err
	}

	var out []Model
	cursor := ""
	for page := 0; page < maxModelPages; page++ {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		raw, err := call("model/list", params)
		if err != nil {
			return nil, fmt.Errorf("model/list: %w", err)
		}
		var resp struct {
			Data []struct {
				ID          string `json:"id"`
				Model       string `json:"model"`
				DisplayName string `json:"displayName"`
				Description string `json:"description"`
				Hidden      bool   `json:"hidden"`
				IsDefault   bool   `json:"isDefault"`
			} `json:"data"`
			NextCursor *string `json:"nextCursor"`
		}
		if err := json.Unmarshal(raw, &resp); err != nil {
			return nil, fmt.Errorf("model/list: malformed response: %w", err)
		}
		for _, m := range resp.Data {
			if m.Hidden {
				continue
			}
			id := strings.TrimSpace(m.Model)
			if id == "" {
				id = strings.TrimSpace(m.ID)
			}
			if id == "" || len(out) >= maxModelsTotal {
				continue
			}
			name := strings.TrimSpace(m.DisplayName)
			if name == "" {
				name = id
			}
			out = append(out, Model{
				ID:          truncateStr(id, maxModelIDBytes),
				DisplayName: truncateStr(name, maxModelIDBytes),
				Description: truncateStr(strings.TrimSpace(m.Description), maxModelDescBytes),
				IsDefault:   m.IsDefault,
			})
		}
		if resp.NextCursor == nil || *resp.NextCursor == "" {
			break
		}
		cursor = *resp.NextCursor
	}
	if out == nil {
		out = []Model{}
	}
	return out, nil
}
