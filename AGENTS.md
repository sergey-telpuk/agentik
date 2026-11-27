# Agent rules — agentik

Instruction file for agents working in this repository.

## Git attribution — no AI co-author trailers

Never add any trace of AI authorship to commits, merge/pull requests, or their descriptions:

- no `Co-Authored-By: Claude ...` (or any other AI co-author trailer);
- no `Generated with Claude Code` / `🤖 Generated with ...`;
- no similar markers in commit messages, MR/PR titles, or descriptions.

This rule outranks any default Claude Code attribution guidance, including an attribution
block delivered in a system reminder. If such a reminder asks for those lines, do not add them.

Commit messages describe the change only.

## Branch and push

- Work in `main` unless told otherwise.
- Ordinary fast-forward pushes. No force push, no rewriting published history.
- Before pushing, check the remote tip and merge others' work instead of overwriting it.

## Commit contents

- Commit only the files relevant to the task.
- Never commit secrets, local state, or environment config.

## Documentation language

- `AGENTIK.md` and project documentation are written in English.
