# Adam BOX-3

USB firmware for ESP32-S3-BOX-3, with a touch **Talk** button, eight-second microphone capture, speaker playback, and live sensor display. The device updates temperature/humidity and radar signal every second without a Mac process. Talk is enabled during a host connection. The Mac bridge uses the existing `api/physical` runtime and voice providers. Without a host it also works on its own over Wi-Fi as a paired Adam display with a microphone (see below). There is no wake word: tap Talk.

Firmware uses Espressif's [BOX-3 BSP](https://components.espressif.com/components/espressif/esp-box-3/versions/3.2.0). `i2c_bus` is pinned to 1.2.0 because later releases require an API absent in the installed base ESP-IDF v5.3. Dependencies are locked in `dependencies.lock`.

```sh
source ~/esp/esp-idf/export.sh
cd hardware/esp32-box3
idf.py build
idf.py -p /dev/cu.usbmodemXXXX flash
```

Run from the repository root with Node 26+, ffmpeg, pyserial, and the existing `.env` provider credentials:

```sh
python3 hardware/esp32-box3/bridge.py --turns 3 --wait 120
```

Each tap records eight seconds. Only that clip is sent to transcription. Raw clips and reply audio live in a temporary directory removed when the bridge exits. Transcriptions, conversation turns, and capture provenance persist in the ignored `data/box3/runtime.sqlite`. Per-device credentials are local files with mode 0600. The bridge validates the USB vendor, serial identity, and firmware handshake; this is a trusted local USB setup, not remote device attestation.

Every voice turn reads a fresh sensor snapshot into the existing physical context before asking the agent. Device acceleration/rotation are separate from radar room-movement signals. No radar signal is never projected into an empty-room claim. Unavailable or stale environmental data are excluded. The BOX bridge allows 35 seconds for TTS unless configured otherwise; the shared voice provider's default is unchanged.

```sh
python3 hardware/esp32-box3/bridge.py --sensors --seconds 30
python3 hardware/esp32-box3/bridge.py --ask 'In 40 words, describe the current sensor readings.'
```

Sensors verified on 2026-10-05: IMU ID 0x60, live acceleration/rotation, nearby temperature approximately 26.4–26.6°C, humidity approximately 55–56%, and AT581x radar configuration readback at dock address 0x28. The temperature/humidity device responds at 0x38. The 45-second radar test stayed low; controlled movement detection has not yet been demonstrated. Infrared and Wi-Fi CSI remain untested on this firmware.

The base ESP-IDF v5.3 lacks a public bus lookup, and BSP 3.2 exposes only its main I2C handle. A linker wrapper observes the real `i2c_new_master_bus` call to retain the dock handle, preserving the driver's behavior. AT581x register settings follow Espressif's [driver defaults](https://github.com/espressif/esp-iot-solution/blob/master/components/sensors/radar/at581x/at581x.c); they are not calibrated range or person-count measurements.

The transport is `ADAM`, a one-byte frame type, little-endian uint32 byte length, then payload. `H` handshakes, `D` ends a host session, `P` requests/returns a sensor JSON snapshot, `R` requests capture, `A` returns mono PCM16 at 16 kHz, `S` plays that format, `K` acknowledges codec completion, `T` updates the display, and `E` reports an error. The maximum payload is 30 seconds of audio. A speaker acknowledgement proves codec completion, not that a person heard sound.

The original 16 MB flash backup is `data/box3/factory-backup.bin`. Restore only to the same physical device:

```sh
python -m esptool --chip esp32s3 -p /dev/cu.usbmodem2101 write_flash 0 data/box3/factory-backup.bin
```

The bridge exits after the requested number of turns or timeout and closes its serial port. Firmware remains on the device. No Wi-Fi credentials or API keys are provisioned to it.

## Standalone over Wi-Fi (paired display)

The box pairs to the Adam backend as an ordinary paired display, so it gets the same rules as any screen: it can talk to Adam but can never approve or cancel anything (those words, or a waiting approval, send you to your phone).

1. In the Adam app, open Your Home and add a display. It shows a link and a one-time code.
2. Run the backend where the box can reach it, for example `npm start` on the Mac (the box talks to `http://<mac address>:3000`).
3. With the box plugged into the Mac: `python3 hardware/esp32-box3/provision.py`. It asks for the server address, Wi-Fi name and password, the link and the code (password and code are hidden). It redeems the pairing on the server and stores Wi-Fi, address and the display's own token in the box's flash, then the box restarts and shows "Online".
4. Tap Talk: 8 seconds are recorded, sent to `POST /display/:id/voice`, and Adam's spoken answer plays. Room readings go to `/display/:id/sensors` every minute and are added to room questions only.

An always-on microphone task runs the smoke/CO beep-pattern detector from `firmware/alarm-pattern/` (not neural; no learned sounds run on the box). A detection goes to `/display/:id/sound`, which raises it as an urgent household event, and is also sent over USB as a `B` frame while a bridge is connected. The detector is paused while the speaker is playing.

Routes and their rules are in `api/services/box-gateway.js` and `test/smoke/box-gateway.test.js`. Partition table: `partitions.csv` (3 MB app). Startup checkpoints are sent as `D` frames, which the bridge ignores.

Verified 2026-10-08 on the bench: Wi-Fi-free USB handshake, 8 s recording, IMU readings, and a synthetic three-beep smoke pattern played from the Mac speaker was reported as `smoke_alarm`. Not yet verified: the Wi-Fi and pairing path end to end, a real alarm, and the sensor base (it was not detected this session: no 0x28/0x38 devices, and its setup blocks, so it now runs in its own task).
