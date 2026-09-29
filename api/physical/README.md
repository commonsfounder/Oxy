# Adam physical context runtime

This is a local, hardware-independent context module inside Oxy. It does not replace the existing Oxy agent loop or action execution boundary. It accepts device observations, stores evidence and derived room state, evaluates durable watches, and exposes a small developer console.

Requires Node 26 or newer for `node:sqlite`.

```sh
node api/physical/server.js
# open http://127.0.0.1:4317
node api/physical/demo.js
node --test test/smoke/physical-runtime.test.js
```

The server stores data in `data/adam-physical.sqlite` by default. Set `ADAM_PHYSICAL_DB` to change it. The server binds loopback by default. To bind the LAN for a device, set both `ADAM_HOST=0.0.0.0` and a strong `ADAM_ADMIN_TOKEN`; use TLS termination or a trusted network before sending device secrets. `NODE_ENV=production` defaults Adam's environment to production; `ADAM_ENVIRONMENT=production` also explicitly rejects simulator and replay traffic. `ADAM_LOCAL_SPEECH=1` enables macOS `say` for real-evidence `speak` watches; `ADAM_LOCAL_NOTIFICATIONS=1` enables macOS notifications. Simulated and replayed watch actions remain recorded as simulated and are never delivered.

The text agent reuses Oxy's `brain-provider.js` and its `OXY_BRAIN_PROVIDER` selection. It requires the selected provider's configured key or local model. Without one, observation, state, watch, device, and demo flows work; `/v1/chat` reports provider failure. This runtime stores its own local conversations, not Oxy's user account history.

For optional voice input on macOS, install `ffmpeg` and set `OPENAI_API_KEY` for transcription, then run `node api/physical/voice-cli.js --listen --room ROOM_ID --speak`. Use `--mic-index N` to choose an AVFoundation audio device; the default is 0. This records at most eight seconds only after the command, detects speech activity by audio energy, trims silence, transcribes the clip, sends text to local Adam, and deletes both temporary WAV files. Text input works with `node api/physical/voice-cli.js --room ROOM_ID 'What is happening here?'`. Microphone permission still needs to be granted locally. There is no continuous listening or wake word.

See [ARCHITECTURE.md](ARCHITECTURE.md), [DEVICE_PROTOCOL.md](DEVICE_PROTOCOL.md), [EVENT_MODEL.md](EVENT_MODEL.md), [WORLD_MODEL.md](WORLD_MODEL.md), [PROVENANCE.md](PROVENANCE.md), [DEMO.md](DEMO.md), and [HARDWARE_INTEGRATION.md](HARDWARE_INTEGRATION.md).
