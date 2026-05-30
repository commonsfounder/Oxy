/*
 * Oxy Pendant Firmware — Seeed XIAO nRF52840 Sense
 *
 * Streams audio from the onboard PDM microphone over BLE Nordic UART
 * as soon as a central (the iOS app) connects. Recording stops when
 * the central disconnects.
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
// Standard NUS UUIDs
#define NUS_SERVICE_UUID     "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define NUS_RX_CHAR_UUID     "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"  // App writes to pendant
#define NUS_TX_CHAR_UUID     "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"  // Pendant sends to app

BLEService        nusService(NUS_SERVICE_UUID);
BLECharacteristic txChar(NUS_TX_CHAR_UUID, BLENotify, 20);  // 20 bytes max per notification
BLECharacteristic rxChar(NUS_RX_CHAR_UUID, BLEWrite, 20);

// ── Audio config ───────────────────────────────────────────────
static const int SAMPLE_RATE    = 16000;   // 16 kHz
static const int AUDIO_CHANNELS = 1;       // mono
static const int BUFFER_SAMPLES = 256;     // samples per PDM callback
static int16_t   pdmBuffer[BUFFER_SAMPLES];
volatile bool    pdmReady    = false;
volatile int     pdmBytesAvail = 0;

// ── State ──────────────────────────────────────────────────────
bool isStreaming = false;

// ── BLE device name ────────────────────────────────────────────
static const char* DEVICE_NAME = "OxyPendant";

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
  digitalWrite(LED_BUILTIN, LOW); // LED on (active LOW on XIAO)

  PDM.onReceive(onPDMData);
  PDM.setBufferSize(BUFFER_SAMPLES * sizeof(int16_t));
  PDM.setGain(40);  // Boost mic gain (default is 20, range 0-80)
  if (!PDM.begin(AUDIO_CHANNELS, SAMPLE_RATE)) {
    Serial.println("[Oxy] ERROR: Failed to start PDM mic!");
    isStreaming = false;
    digitalWrite(LED_BUILTIN, HIGH);
  } else {
    Serial.println("[Oxy] PDM mic started OK");
  }
}

void stopStreaming() {
  Serial.println("[Oxy] Stopping audio stream");
  PDM.end();
  isStreaming = false;
  digitalWrite(LED_BUILTIN, HIGH); // LED off
}

// ================================================================
// Setup
// ================================================================
void setup() {
  Serial.begin(115200);
  // Don't wait for serial — pendant should work without USB connected
  delay(1000);

  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH); // LED off

  // Initialize BLE
  if (!BLE.begin()) {
    Serial.println("[Oxy] ERROR: BLE init failed!");
    while (1) {
      digitalWrite(LED_BUILTIN, LOW);
      delay(200);
      digitalWrite(LED_BUILTIN, HIGH);
      delay(200);
    }
  }

  BLE.setLocalName(DEVICE_NAME);
  BLE.setDeviceName(DEVICE_NAME);

  // Add NUS service and characteristics
  nusService.addCharacteristic(txChar);
  nusService.addCharacteristic(rxChar);
  BLE.addService(nusService);

  // Advertise
  BLE.setAdvertisedService(nusService);
  BLE.advertise();

  Serial.print("[Oxy] BLE advertising as ");
  Serial.println(DEVICE_NAME);
  Serial.println("[Oxy] Pendant ready — will stream on BLE connect");
}

// ================================================================
// Main loop
// ================================================================
void loop() {
  BLE.poll();

  BLEDevice central = BLE.central();

  if (central) {
    Serial.print("[Oxy] Connected to: ");
    Serial.println(central.address());

    // Blink LED to acknowledge connection
    for (int i = 0; i < 3; i++) {
      digitalWrite(LED_BUILTIN, LOW);
      delay(100);
      digitalWrite(LED_BUILTIN, HIGH);
      delay(100);
    }

    delay(500);  // Let BLE negotiation settle
    startStreaming();

    // Stream while connected
    while (central.connected()) {
      BLE.poll();

      if (isStreaming && pdmReady) {
        pdmReady = false;
        int bytesToSend = pdmBytesAvail;

        // Log first few values periodically for debugging
        static unsigned long lastLog = 0;
        if (millis() - lastLog > 5000) {
          lastLog = millis();
          Serial.print("[Oxy] Audio samples: ");
          int samplesToShow = min(5, bytesToSend / 2);
          for (int i = 0; i < samplesToShow; i++) {
            Serial.print(pdmBuffer[i]);
            Serial.print(" ");
          }
          Serial.println();
        }

        // Send in 20-byte BLE chunks
        const uint8_t* data = (const uint8_t*)pdmBuffer;
        int remaining = bytesToSend;
        while (remaining > 0) {
          int chunk = min(remaining, 20);
          txChar.writeValue(data, chunk);
          data += chunk;
          remaining -= chunk;
          // Small delay to prevent BLE congestion
          delayMicroseconds(500);
        }
      }
    }

    // Central disconnected
    stopStreaming();
    Serial.println("[Oxy] Disconnected — stopped streaming");
    BLE.advertise();  // Resume advertising
  }
}
