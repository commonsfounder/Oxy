# adam-link

The BOX-3 (or any ESP32-S3 board) talking to the real Adam over Wi-Fi: your account, your
connected services, approvals on your phone. It replaces the USB-to-laptop bridge
(`api/physical/box3-voice.js`) as the way a device reaches Adam.

| Piece | What it is | Proven |
|---|---|---|
| `adam_link.c/.h` | WAV framing, sound-event queue (offline buffering, dedupe, 15-min expiry), backoff and unpairing, ISO time. Plain C, no heap, no OS. | `make test`, plus ASan/UBSan |
| `adam_net/` | ESP-IDF component: Wi-Fi and pairing from NVS, SNTP, the two HTTPS calls. | **Syntax-checked only.** Build it with the board firmware. |
| `api/services/device-*.js` + `/display/:id/voice`, `/display/:id/sounds` | Server side. | `test/smoke/home-device*.test.js`, including the routes end to end |
| `scripts/home-device.js` | Pair a device, run voice and sound turns from a laptop, write the NVS provisioning file. | Same end-to-end test |

## What happens on a spoken turn

```
button down → record 16 kHz mono into PSRAM (≤ 15 s) → button up
  → POST /display/{id}/voice  (WAV)
      server: transcribe → refuse approval words → /chat as the paired user (channel home_device:
      "reply is spoken in a shared room") → waiting on approval? say "it's on your phone"
      → speech → resample to 16 kHz → WAV
  ← play the reply bytes as they are
```

**Streamed replies** (`?stream=1`, `adam_net_voice_stream`): the server sends raw 16 kHz PCM
(`audio/L16`) while the reply is being synthesised, resampled on the fly with the same filter, so
it is sample-for-sample the downloaded reply. The network task writes into an `adam_ring_t`; the
speaker task reads whole samples from it and starts after a ~250 ms pre-roll, so playback begins
roughly when the first sentence is ready instead of after the whole reply has downloaded.
`node scripts/home-device.js voice ask.wav --stream` prints when the words were known, when the first
audio arrived and when the reply finished — measure both modes on the bench.

A shared device can never approve or cancel anything; the yes always happens on the phone.

## What happens when the box hears something

`alarm_pattern_process()` and `se_update()` already run on the device. Hand their results to
`adam_net_heard_alarm()` / `adam_net_heard_model()`; `adam_net_flush_sounds()` sends them. The server
supplies the words ("Smoke alarm heard"), uses the same ids as the iPhone so one alarm heard by both is
one notification, and only interrupts for sounds whose catch rate is good enough today: smoke and CO
alarms, steady beeping, glass, knock, doorbell, baby crying, a tap left running. Scream, gunshot, door
slam and the rest are recorded and kept quiet until the model earns it.

## Bring-up on the BOX-3

Do these in order on the Mac, against production after deploying this branch.

1. **Prove the server path with no hardware:**
   ```sh
   # In the app: pair a display. Copy its link and code.
   node scripts/home-device.js pair 'https://…/display?challenge=…' ABC123 --name Kitchen
   ffmpeg -f avfoundation -i ":0" -t 4 -ar 16000 -ac 1 -c:a pcm_s16le ask.wav   # say something
   node scripts/home-device.js voice ask.wav --out reply.wav && afplay reply.wav
   node scripts/home-device.js sound smoke_alarm          # your phone should get the alert
   ```
   Record the time `voice` prints: that's the latency budget the device inherits.
2. **Provision the board:**
   ```sh
   node scripts/home-device.js nvs --ssid 'Home' --password '…' > adam-nvs.csv
   python $IDF_PATH/components/nvs_flash/nvs_partition_generator/nvs_partition_gen.py generate adam-nvs.csv adam-nvs.bin 0x6000
   parttool.py --port PORT write_partition --partition-name=nvs --input adam-nvs.bin
   rm adam-nvs.csv adam-nvs.bin    # they hold the Wi-Fi password and the device token
   ```
   Check the `nvs` partition size in the board's partition table; 0x6000 is the ESP-IDF default.
3. **Add the component** to the BOX-3 project: `set(EXTRA_COMPONENT_DIRS <Oxy>/firmware/adam-link/adam_net)`
   in its top-level `CMakeLists.txt`, `REQUIRES adam_net` in main. Enable the certificate bundle
   (`CONFIG_MBEDTLS_CERTIFICATE_BUNDLE`, on by default) and PSRAM.
4. **Wire it into the board code** (the bench firmware already records and plays 16 kHz):
   ```c
   static adam_net_t net;
   ESP_ERROR_CHECK(adam_net_start(&net));
   // push-to-talk released
   uint8_t *reply = heap_caps_malloc(REPLY_CAP, MALLOC_CAP_SPIRAM);   // ~1.3 MB holds a 40 s reply
   size_t got; int status;
   adam_net_voice(&net, pcm, samples, reply, REPLY_CAP, &got, &status);
   const uint8_t *speech; size_t bytes;
   if (status == 200 && adam_wav_samples(reply, got, &speech, &bytes) == 0) play_pcm16(speech, bytes);
   // or streamed: a speaker task loops on adam_ring_read(&ring, buf, sizeof buf) -> I2S while
   //   adam_net_voice_stream(&net, pcm, samples, &ring, &status);   // ring: adam_ring_init(&ring, psram, 256 * 1024, 250)
   // detector task, after each block:
   alarm_kind_t a = alarm_pattern_process(&alarm, block, n); if (a) adam_net_heard_alarm(&net, a);
   int k = se_update(&se, scores, events, 4); adam_net_heard_model(&net, SOUND_EVENT_CONFIG, SOUND_EVENT_CLASSES, events, k);
   adam_net_flush_sounds(&net);   // from a task that may block on the network for a few seconds
   ```
5. **Measure** and write the numbers into `api/physical/HARDWARE_INTEGRATION.md`: button-up to first
   reply audio (median and worst of 20), alarm-to-phone-notification time, behaviour across a Wi-Fi
   drop (sounds queue and arrive afterwards; a 401 forgets the token and logs "pair it again").

## Showing online in the app

The app shows a device online while Adam has heard from it in the last 3 minutes. Every voice turn
and sound report counts; `adam_net_heartbeat()` sends `POST /display/{id}/heartbeat` only after 60 s
with nothing else successful, so call it from any loop that runs every few seconds.

## Known limits

- Streaming starts playback once the words are known; the words themselves still wait for the whole
  agent turn. Speaking a first sentence earlier is the next latency win.
- No wake word: push-to-talk only.
- Pairing a box uses the display-pairing flow and a laptop. On-device pairing (code on the screen)
  is not built.
