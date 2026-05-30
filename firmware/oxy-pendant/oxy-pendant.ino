/*
 * Oxy Pendant Firmware — Seeed XIAO nRF52840 Sense
 *
 * Captures audio from the onboard PDM microphone when the user
 * touches/presses the button, streams 16-bit PCM @ 16 kHz over
 * BLE Nordic UART Service, and sends "DONE" when finished.
 *
 * Board: Seeed XIAO nRF52840 Sense
 * Arduino core: Seeed nRF52 (Adafruit BSP fork)
 *
 * Pin mapping:
 *   D1 — touch/button input (active LOW with internal pull-up)
 *   Built-in PDM mic on P0.20 (CLK) and P0.21 (DIN)
 *   Built-in LED on LED_BUILTIN
 */

#include <bluefruit.h>
#include <PDM.h>

// ── BLE Nordic UART Service UUIDs ──────────────────────────────
BLEUart bleuart;

// ── Audio config ───────────────────────────────────────────────
static const int SAMPLE_RATE    = 16000;   // 16 kHz
static const int AUDIO_CHANNELS = 1;       // mono
static const int BUFFER_SAMPLES = 512;     // samples per PDM callback
static int16_t   pdmBuffer[BUFFER_SAMPLES];
volatile bool    pdmReady = false;

// ── Button / touch config ──────────────────────────────────────
static const int BUTTON_PIN = D1;          // touch or tactile button
static const unsigned long DEBOUNCE_MS = 50;

// ── State ──────────────────────────────────────────────────────
enum State { IDLE, RECORDING };
volatile State currentState = IDLE;
bool lastButtonState = HIGH;
unsigned long lastDebounceTime = 0;

// ── BLE device name ────────────────────────────────────────────
static const char* DEVICE_NAME = "OxyPendant";

// ── Forward declarations ───────────────────────────────────────
void onPDMData();
void startRecording();
void stopRecording();
void setupBLE();
void connectCallback(uint16_t conn_handle);
void disconnectCallback(uint16_t conn_handle, uint8_t reason);

// ================================================================
// Setup
// ================================================================
void setup() {
  Serial.begin(115200);

  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH); // LED off (active LOW on XIAO)

  setupBLE();

  PDM.onReceive(onPDMData);
  PDM.setBufferSize(BUFFER_SAMPLES * sizeof(int16_t));

  Serial.println("[Oxy] Pendant ready");
}

// ================================================================
// Main loop — poll button, stream audio when recording
// ================================================================
void loop() {
  // Read button with debounce
  bool reading = digitalRead(BUTTON_PIN);
  if (reading != lastButtonState) {
    lastDebounceTime = millis();
  }
  if ((millis() - lastDebounceTime) > DEBOUNCE_MS) {
    static bool buttonState = HIGH;
    if (reading != buttonState) {
      buttonState = reading;
      if (buttonState == LOW) { // pressed
        if (currentState == IDLE) {
          startRecording();
        } else {
          stopRecording();
        }
      }
    }
  }
  lastButtonState = reading;

  // Stream audio chunks over BLE
  if (currentState == RECORDING && pdmReady) {
    pdmReady = false;
    if (Bluefruit.connected() && bleuart.notifyEnabled()) {
      const uint8_t* data = (const uint8_t*)pdmBuffer;
      int remaining = BUFFER_SAMPLES * sizeof(int16_t);
      // BLE MTU is typically 20 bytes for writes; send in chunks
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
// Recording control
// ================================================================
void startRecording() {
  if (!Bluefruit.connected()) {
    Serial.println("[Oxy] Not connected — ignoring button press");
    return;
  }

  Serial.println("[Oxy] Recording started");
  currentState = RECORDING;
  digitalWrite(LED_BUILTIN, LOW); // LED on

  if (!PDM.begin(AUDIO_CHANNELS, SAMPLE_RATE)) {
    Serial.println("[Oxy] Failed to start PDM mic");
    currentState = IDLE;
    digitalWrite(LED_BUILTIN, HIGH);
    return;
  }
}

void stopRecording() {
  Serial.println("[Oxy] Recording stopped");
  PDM.end();
  currentState = IDLE;
  digitalWrite(LED_BUILTIN, HIGH); // LED off

  // Signal the app that audio is complete
  if (Bluefruit.connected() && bleuart.notifyEnabled()) {
    bleuart.write("DONE", 4);
  }
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
  Bluefruit.Advertising.setInterval(32, 244); // fast then slow (in 0.625ms units)
  Bluefruit.Advertising.setFastTimeout(30);   // seconds in fast mode
  Bluefruit.Advertising.start(0);             // 0 = never stop

  Serial.println("[Oxy] BLE advertising as " + String(DEVICE_NAME));
}

void connectCallback(uint16_t conn_handle) {
  Serial.println("[Oxy] BLE connected");
  // Blink LED briefly to acknowledge
  for (int i = 0; i < 3; i++) {
    digitalWrite(LED_BUILTIN, LOW);
    delay(100);
    digitalWrite(LED_BUILTIN, HIGH);
    delay(100);
  }
}

void disconnectCallback(uint16_t conn_handle, uint8_t reason) {
  Serial.print("[Oxy] BLE disconnected, reason: 0x");
  Serial.println(reason, HEX);

  // Stop recording if active
  if (currentState == RECORDING) {
    PDM.end();
    currentState = IDLE;
    digitalWrite(LED_BUILTIN, HIGH);
  }
}
