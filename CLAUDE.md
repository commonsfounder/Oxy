# Oxy — Claude Code instructions

**Read and follow [AGENTS.md](AGENTS.md) — it is the shared playbook for all agents in this repo (project layout, deploy, tests, git discipline, editing rules, memory handoff). Every rule there applies to Claude.**

Claude-specific notes:

- Claude Code's auto-memory directory is the same shared memory referenced in AGENTS.md (`~/.claude/projects/-Users-chizigamonyewuchi-Documents-Oxy/memory/`). The handoff-note rule in AGENTS.md applies on top of Claude's own memory behavior: update memory files at session end or when context is >80% used, not only when something notable happens.
