# Oxy Pendant Firmware

Arduino firmware for the Oxy pendant, targeting the **Seeed XIAO nRF52840 Sense** dev board.

## What it does

1. Advertises over BLE as **"OxyPendant"** using Nordic UART Service
2. Waits for the iOS app to connect
3. When the user presses the button (pin D1), captures audio from the onboard PDM microphone
4. Streams 16-bit PCM @ 16 kHz mono over BLE UART in 20-byte chunks
5. When the button is pressed again, stops recording and sends `"DONE"`

## Hardware requirements

- **Seeed XIAO nRF52840 Sense** (has built-in PDM microphone)
- A tactile button or touch sensor connected between **D1** and **GND**
  - Internal pull-up is enabled; button should short D1 to GND when pressed
  - For the production pendant with Infineon CY8CMBR3102 touch IC, adapt the button pin accordingly

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
   - You should see `[Oxy] Pendant ready` and `[Oxy] BLE advertising as OxyPendant`

## Pin mapping

| Function | Pin | Notes |
|----------|-----|-------|
| Button/Touch | D1 | Active LOW, internal pull-up |
| PDM Mic CLK | P0.20 | Built-in on Sense board |
| PDM Mic DIN | P0.21 | Built-in on Sense board |
| LED | LED_BUILTIN | On during recording |

## Audio format

- **Sample rate:** 16,000 Hz
- **Bit depth:** 16-bit signed PCM (little-endian)
- **Channels:** 1 (mono)
- **BLE chunk size:** 20 bytes (10 samples per BLE packet)
- **End signal:** ASCII `"DONE"` (4 bytes)

## Adapting for production hardware

The production pendant uses:
- **Raytac MDBT50Q-512K** (nRF52840 module) instead of XIAO
- **Knowles SPH0645LM4H** I2S microphone instead of PDM
- **Infineon CY8CMBR3102** capacitive touch IC instead of a button

To adapt:
1. Replace PDM with I2S driver for the SPH0645
2. Replace GPIO button reading with I2C communication to CY8CMBR3102
3. Update pin assignments for the production PCB
