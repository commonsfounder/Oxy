# Oxy Pendant Firmware

Arduino firmware for the Seeed Studio XIAO nRF52840 Sense that pairs with the Oxy iOS app over BLE using the Nordic UART Service.

## What the Oxy app expects

The Swift app scans for this BLE service, not a fixed peripheral name:

- Nordic UART Service: `6E400001-B5A3-F393-E0A9-E50E24DCCA9E`
- RX/write characteristic: `6E400002-B5A3-F393-E0A9-E50E24DCCA9E`
- TX/notify characteristic: `6E400003-B5A3-F393-E0A9-E50E24DCCA9E`

`PendantBLEManager` reads UTF-8 text commands from the TX characteristic. The commands currently handled by the app are:

- `START_RECORDING`
- `STOP_RECORDING`
- `TOGGLE_RECORDING`
- `OPEN_CHAT`
- `SEND_MESSAGE`
- `CONFIRM`
- `CANCEL`

The app’s current end-to-end voice flow is phone-side speech recognition. The pendant tells the app when to start and stop recording; the iPhone records and transcribes the voice. This firmware sends text control commands instead of streaming microphone audio.

## Required Arduino setup

Use the Seeed nRF52 board package and the Bluefruit BLE API bundled with that package. Do not install or include `ArduinoBLE` for this sketch; mixing ArduinoBLE with the Seeed/Adafruit nRF52 SoftDevice stack can cause undefined BLE/HCI references at link time.

In Arduino IDE:

1. Install/select the `Seeed nRF52 Boards` package.
2. Select board `Seeed XIAO nRF52840 Sense`.
3. Use the built-in Bluefruit BLE API from the board package via `#include <bluefruit.h>`.
4. Use `PDM`, normally included with the nRF52840 board support, for the onboard microphone.
5. If Arduino IDE still links `ArduinoBLE`, remove or disable the separate `ArduinoBLE` library from the sketch/libraries path for this project.

Recommended Arduino IDE board settings:

- Board: `Seeed XIAO nRF52840 Sense`
- Port: the XIAO serial port after plugging it in
- Programmer: default

## Flashing

1. Open `OxyPendantFirmware.ino` in Arduino IDE.
2. Connect the XIAO nRF52840 Sense by USB-C.
3. Select the XIAO nRF52840 Sense board and port.
4. Click Upload.
5. If upload fails, double-tap reset to enter bootloader mode, then upload again.

## Button controls

The firmware defaults the pendant button to `D1` because the XIAO reset button is not a normal application button. If your wiring uses another GPIO button, change `PENDANT_BUTTON_PIN` near the top of the `.ino` file.

- Single click: opens the Chat tab with `OPEN_CHAT`.
- Hold: sends `OPEN_CHAT`, then `START_RECORDING`; release sends `STOP_RECORDING` and the app sends the transcript.
- Double click: sends the current draft with `SEND_MESSAGE`.
- Medium press: toggles recording with `TOGGLE_RECORDING`.

The firmware also samples the onboard PDM microphone for a conservative loud-sound wake trigger. When it detects a sharp local sound, it opens chat, starts recording, and auto-stops after 8 seconds. The audio is not streamed to the app in the current implementation.

## Serial test commands

Open Serial Monitor at `115200` baud and type any of these to test every app command:

- `START_RECORDING`
- `STOP_RECORDING`
- `TOGGLE_RECORDING`
- `OPEN_CHAT`
- `SEND_MESSAGE`
- `CONFIRM`
- `CANCEL`

Aliases such as `START`, `STOP`, `CHAT`, `SEND`, `YES`, and `NO` also work.

## End-to-end test

1. Flash the firmware and leave the XIAO powered on.
2. Open OxyApp on the iPhone.
3. Watch the Xcode console for pendant logs like “Discovered Nordic UART Service” and “Subscribed to TX notifications”.
4. Hold the pendant button and speak a request, for example “remind me to drink water in ten minutes”.
5. Release the button.
6. Oxy should stop recording, transcribe the speech on the iPhone, send the chat message, and run the matching native action when supported.

## Notes

- BLE advertisement name is set to `Oxy`, but the app scans by the Nordic UART Service UUID.
- `RX` is kept functional for future app-to-pendant commands. If the app writes `START`, the firmware logs it. If the app writes `STOP`, the firmware replies with `DONE`.
- If the button does nothing, wire a momentary button between `D1` and `GND`, or change `PENDANT_BUTTON_PIN` to the GPIO you are using.
