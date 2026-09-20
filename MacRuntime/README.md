# Adam Mac runtime

`AdamMacRuntime` contains capabilities that must execute on the user's Mac rather than on the hosted backend.

## Agent CLI bridge

The `adam-agent` executable asks an installed agent to inspect an explicitly selected folder, captures its exact final response, turns that response into screenless speech in a separate renderer step, and speaks it through macOS.

List detected providers:

```sh
swift run adam-agent --list
```

Run Codex against a folder without allowing edits:

```sh
swift run adam-agent \
  --agent codex \
  --model gpt-5.5 \
  --renderer-model gpt-5.5 \
  --folder /path/to/folder \
  --prompt "Tell me the three most important things still unfinished."
```

From the folder you want inspected, the same bridge also accepts Adam's natural command form:

```sh
ADAM_CODEX_MODEL=gpt-5.5 swift run --package-path /path/to/Oxy/MacRuntime adam-agent \
  "Adam, ask Codex what's unfinished in this folder"
```

Use `--no-speak` to return text without playing it, or `--json` for a bounded receipt containing the provider, exact final response, rendered speech, and whether speech was requested.

Codex runs in an ephemeral session behind a macOS boundary that allows reads only from the selected folder and prevents writes there. Claude runs non-interactively with only its read/search tools and no saved session behind the same boundary. Voice rendering stays with the same provider that produced the response, so captured project text is never silently sent to a second vendor. `ADAM_CODEX_MODEL` and `ADAM_CLAUDE_MODEL` can set independent defaults.

A stored login is not treated as proof of live access; a server-side authentication failure is returned exactly when the provider is invoked. Provider credentials are copied into a short-lived isolated home for each invocation, and other user folders and mounted volumes remain outside the command's read boundary. Only invoke the bridge on folders whose contents are appropriate for the selected provider.

The command-line entry point is local and is not exposed as a hosted model action.

## Adam Mac interface

Build the local Adam app bundle, then open it:

```sh
./scripts/build-app.sh
open .build/Adam.app
```

The **Ask an agent** screen uses the same bridge from typed chat or macOS speech recognition. The person chooses the folder and visible provider first. A phrase such as “Adam, ask Claude to inspect the tests” can override the visible provider; ordinary requests use the visible selection. The response is shown exactly, rendered separately for speech by the same provider, and played on the Mac.

The Mac interface is real and local. The iPhone and pendant still use the hosted chat path; connecting them to this Mac capability requires an authenticated device-pairing channel and is deliberately not approximated with an open LAN endpoint.
