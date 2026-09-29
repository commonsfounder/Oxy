# ESP32-S3-BOX-3 arrival steps

Espressif's [BOX-3 hardware overview](https://github.com/espressif/esp-box/blob/master/docs/hardware_overview/esp32_s3_box_3/hardware_overview_for_box_3.md) describes a 2.4-inch touch display, two digital microphones, speaker, three buttons, accelerometer, gyroscope, Wi-Fi, and BLE. These are board capabilities, not validated Adam capabilities. Espressif's [firmware guide](https://github.com/espressif/esp-box/blob/master/docs/firmware_update.md) warns that an older v0.5.0 release is for BOX and BOX-Lite, so confirm the exact BOX-3 board revision and compatible current firmware before flashing.

1. Inspect the delivered board and its exact revision, USB cable, accessories, and current firmware. Confirm a BOX-3-compatible ESP-IDF example builds and flashes.
   Follow Espressif's [development guide](https://github.com/espressif/esp-box/blob/master/docs/development_guide.md): use an ESP-IDF version supported by the chosen `esp-box` revision, clone recursively, select BOX-3 in `idf.py menuconfig`, build the `factory_demo`, then flash with the actual serial port. The command sequence is:
   ```sh
   git clone --recursive https://github.com/espressif/esp-box.git
   cd esp-box/examples/factory_demo
   idf.py set-target esp32s3
   idf.py menuconfig
   idf.py build
   idf.py -p PORT flash monitor
   ```
   Replace `PORT` with the port detected on the day. Do not flash a BOX or BOX-Lite-only binary onto BOX-3.
2. Start Adam on a trusted LAN with `ADAM_HOST=0.0.0.0`, `ADAM_ADMIN_TOKEN`, and a reachable server address. Add TLS termination before any untrusted network use.
3. Create a room with `POST /v1/rooms`, then register the physical device with `POST /v1/devices/register`, adapter `esp32-box3`, the room ID, firmware version, and only capabilities confirmed by the actual firmware. Securely provision the returned per-device secret; it is shown once.
4. Implement the firmware's HTTP JSON client: registration provisioning, timed heartbeat, unique message IDs, observation messages, command polling, acknowledgements, retry with new message IDs only after uncertain outcomes are resolved, and clock sync.
5. Map actual button/touch/audio/telemetry outputs to canonical observation types. Keep raw payload metadata bounded and never send continuous raw audio by default. Test one observation and inspect its device provenance in `/v1/snapshot`.
6. Implement and test display and speaker commands separately. For voice, choose a consented capture mode, local VAD or push-to-talk, and a bounded audio transfer endpoint; the current local laptop voice CLI does not implement BOX audio transport.
7. Check disconnection after missed heartbeats, command timeout, observation latency, clock skew, reconnection, and secret recovery. Repeat the same watch scenario with physical evidence and confirm the action status changes from simulated only when evidence and permission permit it.

The Node `ESP32Box3Adapter` intentionally reports disconnected until firmware transport has been implemented and validated. Do not advertise BOX microphone, speaker, display, or sensors as working Adam features before that proof.
