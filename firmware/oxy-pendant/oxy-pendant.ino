/*
 * Oxy Pendant Firmware — Seeed XIAO nRF52840 Sense
 *
 * Streams audio from the onboard PDM microphone over BLE Nordic UART
 * as soon as a central (the iOS app) connects. Recording stops when
 * the central disconnects.
 *
 * Bidirectional control: the app writes short command strings to the
 * RX characteristic to trigger LED feedback:
 *   "THINK" — AI is processing (slow double-blink)
 *   "DONE"  — AI responded (fast triple-blink)
 *   "PING"  — connectivity test (single blink)
 *
 * Board package: Adafruit nRF52 (Seeed XIAO nRF52840 Sense)
 * Libraries:
 *   Bluefruit (built into Adafruit nRF52 BSP)
 *   PDM (built into BSP)
 */

#include <bluefruit.h>
#include <PDM.h>

// ── BLE Nordic UART Service ────────────────────────────────────
BLEUart bleuart;

// ── Audio config ───────────────────────────────────────────────
static const int SAMPLE_RATE    = 16000;
static const int AUDIO_CHANNELS = 1;
static const int BUFFER_SAMPLES = 256;
static int16_t   pdmBuffer[BUFFER_SAMPLES];
volatile bool    pdmReady      = false;
volatile int     pdmBytesAvail = 0;

// ── State ──────────────────────────────────────────────────────
bool isStreaming  = false;
bool isConnected  = false;

// ── BLE device name ────────────────────────────────────────────
static const char* DEVICE_NAME = "Oxy";

// ── Non-blocking LED blink state machine ──────────────────────
struct LEDBlinker {
  int           remaining;    // half-cycles left (on + off = 2 per blink)
  unsigned long intervalMs;
  unsigned long lastChange;
  bool          active;
};

static LEDBlinker led = {0, 0, 0, false};

void triggerBlink(int count, unsigned long intervalMs) {
  led.remaining  = count * 2;  // each blink = 1 on + 1 off
  led.intervalMs = intervalMs;
  led.lastChange = millis();
  led.active     = true;
  digitalWrite(LED_BUILTIN, LOW);  // start on (active LOW)
}

// Call every loop iteration — never blocks.
void updateLED() {
  if (!led.active) return;
  if (millis() - led.lastChange < led.intervalMs) return;

  led.remaining--;
  led.lastChange = millis();

  if (led.remaining <= 0) {
    led.active = false;
    // Return to streaming-state LED
    digitalWrite(LED_BUILTIN, isStreaming ? LOW : HIGH);
    return;
  }

  // Toggle: odd remaining = on, even = off
  digitalWrite(LED_BUILTIN, (led.remaining % 2 == 1) ? LOW : HIGH);
}

// ── RX command handler (called by Bluefruit when app writes) ───
void bleuart_rx_callback(uint16_t conn_hdl) {
  (void)conn_hdl;

  char buf[21] = {};
  int len = bleuart.read(buf, sizeof(buf) - 1);
  if (len <= 0) return;

  String cmd = String(buf);
  cmd.trim();

  Serial.print("[Oxy] RX: ");
  Serial.println(cmd);

  if (cmd == "THINK") {
    triggerBlink(2, 300);   // slow double-blink: AI is thinking
  } else if (cmd == "DONE") {
    triggerBlink(3, 70);    // fast triple-blink: AI responded
  } else if (cmd == "PING") {
    triggerBlink(1, 100);   // single blink: connectivity check
  }
}

// ── BLE connection callbacks ───────────────────────────────────
void connect_callback(uint16_t conn_handle) {
  (void)conn_handle;
  Serial.println("[Oxy] Connected");
  isConnected = true;

  // Blink 3× to signal connection
  for (int i = 0; i < 3; i++) {
    digitalWrite(LED_BUILTIN, LOW);  delay(100);
    digitalWrite(LED_BUILTIN, HIGH); delay(100);
  }

  delay(500);
  startStreaming();
}

void disconnect_callback(uint16_t conn_handle, uint8_t reason) {
  (void)conn_handle;
  (void)reason;
  Serial.println("[Oxy] Disconnected");
  isConnected = false;
  stopStreaming();
}

// ── PDM callback ───────────────────────────────────────────────
void onPDMData() {
  int bytes = PDM.available();
  if (bytes > 0) {
    int toRead = min(bytes, (int)sizeof(pdmBuffer));
    PDM.read(pdmBuffer, toRead);
    pdmBytesAvail = toRead;
    pdmReady = true;
  }
}

// ── Streaming control ──────────────────────────────────────────
void startStreaming() {
  Serial.println("[Oxy] Starting audio stream");
  isStreaming = true;
  digitalWrite(LED_BUILTIN, LOW);

  PDM.onReceive(onPDMData);
  PDM.setBufferSize(BUFFER_SAMPLES * sizeof(int16_t));
  PDM.setGain(40);
  if (!PDM.begin(AUDIO_CHANNELS, SAMPLE_RATE)) {
    Serial.println("[Oxy] ERROR: PDM start failed");
    isStreaming = false;
    digitalWrite(LED_BUILTIN, HIGH);
  } else {
    Serial.println("[Oxy] PDM started OK");
  }
}

void stopStreaming() {
  Serial.println("[Oxy] Stopping audio stream");
  PDM.end();
  isStreaming = false;
  digitalWrite(LED_BUILTIN, HIGH);
}

// ================================================================
// Setup
// ================================================================
void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH);

  // Initialise Bluefruit with max bandwidth for audio streaming
  Bluefruit.configPrphBandwidth(BANDWIDTH_MAX);
  Bluefruit.begin();
  Bluefruit.setTxPower(4);
  Bluefruit.setName(DEVICE_NAME);

  // Set connection callbacks
  Bluefruit.Periph.setConnectCallback(connect_callback);
  Bluefruit.Periph.setDisconnectCallback(disconnect_callback);

  // Start BLE UART service
  bleuart.begin();
  bleuart.setRxCallback(bleuart_rx_callback);

  // Start advertising
  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addService(bleuart);
  Bluefruit.ScanResponse.addName();

  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244);  // fast then slow (units of 0.625ms)
  Bluefruit.Advertising.setFastTimeout(30);
  Bluefruit.Advertising.start(0);               // 0 = advertise forever

  Serial.print("[Oxy] BLE advertising as ");
  Serial.println(DEVICE_NAME);
}

// ================================================================
// Main loop
// ================================================================
void loop() {
  updateLED();

  if (isStreaming && pdmReady) {
    pdmReady = false;
    int bytesToSend = pdmBytesAvail;

    // Periodic diagnostic: print first few samples to Serial
    static unsigned long lastLog = 0;
    if (millis() - lastLog > 5000) {
      lastLog = millis();
      Serial.print("[Oxy] Audio samples: ");
      int n = min(5, bytesToSend / 2);
      for (int i = 0; i < n; i++) {
        Serial.print(pdmBuffer[i]);
        Serial.print(" ");
      }
      Serial.println();
    }

    // Send audio over BLE UART in 20-byte chunks
    const uint8_t* data = (const uint8_t*)pdmBuffer;
    int remaining = bytesToSend;
    while (remaining > 0 && isConnected) {
      int chunk = min(remaining, 20);
      bleuart.write(data, chunk);
      data      += chunk;
      remaining -= chunk;
      delayMicroseconds(500);
    }
  }
}
