# Install i-have-adhd

A Claude Code plugin. One skill inside.

## TL;DR

```bash
git clone https://github.com/ayghri/i-have-adhd ./i-have-adhd
claude plugin marketplace add ./i-have-adhd
claude plugin install i-have-adhd@i-have-adhd
```

Open Claude Code, type `/i-have-adhd`.

To disable: `claude plugin disable i-have-adhd` (or `/plugin disable i-have-adhd` from within Claude Code). Re-enable later with `enable` instead of `disable`.

## Verify

```bash
claude plugin list
```

Look for `i-have-adhd  (enabled)`.

## Update

```bash
cd ./i-have-adhd && git pull
```

The marketplace re-reads the local checkout. Next Claude Code session picks up changes.

## Uninstall

```bash
claude plugin uninstall i-have-adhd
claude plugin marketplace remove i-have-adhd
```

## Always-on (optional)

To skip `/i-have-adhd` and apply the rules from message one, add to `~/.claude/CLAUDE.md`:

```markdown
## Output style

Always follow the rules in the `i-have-adhd` skill: action-first, numbered steps, no preamble, no closers, state restated each turn.
```

## Troubleshooting

**`/i-have-adhd` not in autocomplete.** Restart Claude Code. The plugin index is read at startup.

**`claude plugin marketplace add` fails.** Point at the repo root, not at `.claude-plugin/`. The path must contain `.claude-plugin/marketplace.json`.

**Skill activates but model still preambles.** Open a new session. Old context may carry. If it still drifts, tighten the rule wording in `skills/i-have-adhd/SKILL.md`, then re-invoke.

**Want different rules.** Edit `skills/i-have-adhd/SKILL.md`. Re-invoke `/i-have-adhd` (or restart) and the new rules apply.
