# Oxy Pendant Firmware

Arduino firmware for the Oxy pendant, targeting the **Seeed XIAO nRF52840 Sense** dev board.

## What it does

1. Advertises over BLE as **"OxyPendant"** using Nordic UART Service
2. Waits for the iOS app to connect
3. **Immediately starts streaming** audio from the onboard PDM microphone once connected
4. Streams 16-bit PCM @ 16 kHz mono over BLE UART in 20-byte chunks
5. LED stays on while streaming
6. Stops streaming when BLE disconnects

The iOS app handles voice activity detection (VAD) — it detects when you start/stop speaking and automatically transcribes your words into Oxy commands.

## Hardware requirements

- **Seeed XIAO nRF52840 Sense** (has built-in PDM microphone — no external mic needed)
- No button or touch sensor required for testing

## Setup — Arduino IDE

1. **Add Seeed board package:**
   - Open Arduino IDE → Settings → Additional Board Manager URLs
   - Add: `https://files.seeedstudio.com/arduino/package_seeedstudio_boards_index.json`
   - Go to Tools → Board Manager → search "Seeed nRF52" → Install

2. **Select board:**
   - Tools → Board → Seeed nRF52 Boards → Seeed XIAO nRF52840 Sense

3. **Open sketch:**
   - File → Open → navigate to `firmware/oxy-pendant/oxy-pendant.ino`

4. **Upload:**
   - Connect the XIAO board via USB-C
   - Tools → Port → select the board's serial port
   - Click Upload (→)

5. **Verify:**
   - Open Serial Monitor (115200 baud)
   - You should see `[Oxy] Pendant ready — will stream on BLE connect`

## Testing end-to-end

1. Flash the firmware to your XIAO nRF52840 Sense
2. Build the iOS app in Xcode and install on your iPhone
3. Open the app → Settings → Pendant → Scan for Pendant
4. Once connected, the pendant LED turns on and starts streaming
5. Speak near the pendant — the app detects your voice, transcribes it, and sends it to Oxy
6. Enable **Voice Replies** in the app's Settings for spoken responses

## Audio format

- **Sample rate:** 16,000 Hz
- **Bit depth:** 16-bit signed PCM (little-endian)
- **Channels:** 1 (mono)
- **BLE chunk size:** 20 bytes (10 samples per BLE packet)

## How voice detection works

The pendant streams audio continuously. The iOS app (`PendantAudioBridge`) handles:
- **Voice Activity Detection (VAD):** Monitors RMS energy of incoming audio
- **Speech start:** When energy exceeds threshold, starts Apple Speech recognition
- **Speech end:** After 2 seconds of silence, finalizes transcription and sends to Oxy
- **Automatic restart:** Ready for the next utterance immediately

## Pin mapping

| Function | Pin | Notes |
|----------|-----|-------|
| PDM Mic CLK | P0.20 | Built-in on Sense board |
| PDM Mic DIN | P0.21 | Built-in on Sense board |
| LED | LED_BUILTIN | On while streaming |

## Adapting for production hardware

The production pendant uses:
- **Raytac MDBT50Q-512K** (nRF52840 module) instead of XIAO
- **Knowles SPH0645LM4H** I2S microphone instead of PDM
- **Infineon CY8CMBR3102** capacitive touch IC for input

To adapt:
1. Replace PDM with I2S driver for the SPH0645
2. Add touch IC integration for recording control (instead of always-on streaming)
3. Update pin assignments for the production PCB
4. Consider adding on-device wake word detection to save battery
