/*
 * Oxy Pendant Firmware — Seeed XIAO nRF52840 Sense
 *
 * Streams audio from the onboard PDM microphone over BLE Nordic UART
 * as soon as a central (the iOS app) connects. Recording stops when
 * the central disconnects.
 *
 * Board: Seeed XIAO nRF52840 Sense
 * Arduino core: Seeed nRF52 (Adafruit BSP fork)
 *
 * Pin mapping:
 *   Built-in PDM mic on P0.20 (CLK) and P0.21 (DIN)
 *   Built-in LED on LED_BUILTIN
 */

#include <bluefruit.h>
#include <PDM.h>

// ── BLE Nordic UART Service ────────────────────────────────────
BLEUart bleuart;

// ── Audio config ───────────────────────────────────────────────
static const int SAMPLE_RATE    = 16000;   // 16 kHz
static const int AUDIO_CHANNELS = 1;       // mono
static const int BUFFER_SAMPLES = 512;     // samples per PDM callback
static int16_t   pdmBuffer[BUFFER_SAMPLES];
volatile bool    pdmReady = false;

// ── State ──────────────────────────────────────────────────────
volatile bool isStreaming = false;

// ── BLE device name ────────────────────────────────────────────
static const char* DEVICE_NAME = "OxyPendant";

// ── Forward declarations ───────────────────────────────────────
void onPDMData();
void startStreaming();
void stopStreaming();
void setupBLE();
void connectCallback(uint16_t conn_handle);
void disconnectCallback(uint16_t conn_handle, uint8_t reason);

// ================================================================
// Setup
// ================================================================
void setup() {
  Serial.begin(115200);

  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH); // LED off (active LOW on XIAO)

  setupBLE();

  PDM.onReceive(onPDMData);
  PDM.setBufferSize(BUFFER_SAMPLES * sizeof(int16_t));

  Serial.println("[Oxy] Pendant ready — will stream on BLE connect");
}

// ================================================================
// Main loop — stream audio when connected
// ================================================================
void loop() {
  if (isStreaming && pdmReady) {
    pdmReady = false;
    if (Bluefruit.connected() && bleuart.notifyEnabled()) {
      const uint8_t* data = (const uint8_t*)pdmBuffer;
      int remaining = BUFFER_SAMPLES * sizeof(int16_t);
      // BLE MTU is typically 20 bytes; send in chunks
      while (remaining > 0) {
        int chunk = min(remaining, 20);
        bleuart.write(data, chunk);
        data += chunk;
        remaining -= chunk;
      }
    }
  }
}

// ================================================================
// PDM callback — called by the PDM driver when buffer is full
// ================================================================
void onPDMData() {
  int bytesAvailable = PDM.available();
  if (bytesAvailable > 0) {
    PDM.read(pdmBuffer, bytesAvailable);
    pdmReady = true;
  }
}

// ================================================================
// Streaming control
// ================================================================
void startStreaming() {
  Serial.println("[Oxy] Starting audio stream");
  isStreaming = true;
  digitalWrite(LED_BUILTIN, LOW); // LED on while streaming

  if (!PDM.begin(AUDIO_CHANNELS, SAMPLE_RATE)) {
    Serial.println("[Oxy] Failed to start PDM mic");
    isStreaming = false;
    digitalWrite(LED_BUILTIN, HIGH);
  }
}

void stopStreaming() {
  Serial.println("[Oxy] Stopping audio stream");
  PDM.end();
  isStreaming = false;
  digitalWrite(LED_BUILTIN, HIGH); // LED off
}

// ================================================================
// BLE setup
// ================================================================
void setupBLE() {
  Bluefruit.begin();
  Bluefruit.setTxPower(4);
  Bluefruit.setName(DEVICE_NAME);

  Bluefruit.Periph.setConnectCallback(connectCallback);
  Bluefruit.Periph.setDisconnectCallback(disconnectCallback);

  bleuart.begin();

  // Start advertising
  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addService(bleuart);
  Bluefruit.ScanResponse.addName();

  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244); // fast then slow
  Bluefruit.Advertising.setFastTimeout(30);
  Bluefruit.Advertising.start(0);             // never stop

  Serial.println("[Oxy] BLE advertising as " + String(DEVICE_NAME));
}

void connectCallback(uint16_t conn_handle) {
  Serial.println("[Oxy] BLE connected — starting audio stream");

  // Blink LED to acknowledge connection
  for (int i = 0; i < 3; i++) {
    digitalWrite(LED_BUILTIN, LOW);
    delay(100);
    digitalWrite(LED_BUILTIN, HIGH);
    delay(100);
  }

  // Small delay to let BLE negotiation complete
  delay(500);
  startStreaming();
}

void disconnectCallback(uint16_t conn_handle, uint8_t reason) {
  Serial.print("[Oxy] BLE disconnected, reason: 0x");
  Serial.println(reason, HEX);
  stopStreaming();
}
