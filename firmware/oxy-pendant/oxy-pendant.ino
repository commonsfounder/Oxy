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
 * Board package: Seeed nRF52 mbed-enabled Boards
 *   (NOT the Adafruit nRF52 BSP — the mbed BSP has working PDM)
 * Board: Seeed XIAO nRF52840 Sense
 *
 * Libraries:
 *   ArduinoBLE (built into mbed BSP)
 *   PDM (built into mbed BSP)
 */

#include <ArduinoBLE.h>
#include <PDM.h>

// ── BLE Nordic UART Service ────────────────────────────────────
#define NUS_SERVICE_UUID     "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define NUS_RX_CHAR_UUID     "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"  // App writes to pendant
#define NUS_TX_CHAR_UUID     "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"  // Pendant sends to app

BLEService        nusService(NUS_SERVICE_UUID);
BLECharacteristic txChar(NUS_TX_CHAR_UUID, BLENotify, 20);
BLECharacteristic rxChar(NUS_RX_CHAR_UUID, BLEWrite | BLEWriteWithoutResponse, 20);

// ── Audio config ───────────────────────────────────────────────
static const int SAMPLE_RATE    = 16000;
static const int AUDIO_CHANNELS = 1;
static const int BUFFER_SAMPLES = 256;
static int16_t   pdmBuffer[BUFFER_SAMPLES];
volatile bool    pdmReady      = false;
volatile int     pdmBytesAvail = 0;

// ── State ──────────────────────────────────────────────────────
bool isStreaming = false;

// ── BLE device name ────────────────────────────────────────────
static const char* DEVICE_NAME = "OxyPendant";

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

// ── RX command handler ─────────────────────────────────────────
void handleRXCommand() {
  if (!rxChar.written()) return;

  int           len = rxChar.valueLength();
  if (len == 0 || len > 20) return;

  char buf[21] = {};
  memcpy(buf, rxChar.value(), len);
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

  if (!BLE.begin()) {
    Serial.println("[Oxy] ERROR: BLE init failed");
    while (1) {
      digitalWrite(LED_BUILTIN, LOW);  delay(200);
      digitalWrite(LED_BUILTIN, HIGH); delay(200);
    }
  }

  BLE.setLocalName(DEVICE_NAME);
  BLE.setDeviceName(DEVICE_NAME);

  nusService.addCharacteristic(txChar);
  nusService.addCharacteristic(rxChar);
  BLE.addService(nusService);
  BLE.setAdvertisedService(nusService);
  BLE.advertise();

  Serial.print("[Oxy] BLE advertising as ");
  Serial.println(DEVICE_NAME);
}

// ================================================================
// Main loop
// ================================================================
void loop() {
  BLE.poll();

  BLEDevice central = BLE.central();

  if (central) {
    Serial.print("[Oxy] Connected: ");
    Serial.println(central.address());

    for (int i = 0; i < 3; i++) {
      digitalWrite(LED_BUILTIN, LOW);  delay(100);
      digitalWrite(LED_BUILTIN, HIGH); delay(100);
    }

    delay(500);
    startStreaming();

    while (central.connected()) {
      BLE.poll();
      handleRXCommand();
      updateLED();

      if (isStreaming && pdmReady) {
        pdmReady = false;
        int bytesToSend = pdmBytesAvail;

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

        const uint8_t* data = (const uint8_t*)pdmBuffer;
        int remaining = bytesToSend;
        while (remaining > 0) {
          int chunk = min(remaining, 20);
          txChar.writeValue(data, chunk);
          data      += chunk;
          remaining -= chunk;
          delayMicroseconds(500);
        }
      }
    }

    stopStreaming();
    Serial.println("[Oxy] Disconnected");
    BLE.advertise();
  }
}
