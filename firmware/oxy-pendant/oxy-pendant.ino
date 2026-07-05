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
// PDM hardware gain (nRF52 PDM GAIN register: 0=-20dB, 40=0dB, 80=+20dB).
// The XIAO Sense onboard mic is very quiet, so run near the top of the range.
static const int MIC_GAIN       = 80;
static int16_t   pdmBuffer[BUFFER_SAMPLES];

// ── Audio ring buffer ──────────────────────────────────────────
// Decouples the PDM capture interrupt from BLE transmission so the
// two never touch the same memory at the same time. Without this the
// loop reads pdmBuffer while a new PDM interrupt overwrites it, splicing
// corrupted samples into the stream (healthy level, unusable waveform).
// 8192 samples = 16 KB ≈ 0.5 s of headroom. Must stay a power of two so
// the index wrap is a cheap mask.
#define RING_SAMPLES 8192
#define RING_MASK    (RING_SAMPLES - 1)
static int16_t          ring[RING_SAMPLES];
static volatile uint32_t ringHead = 0;   // written by PDM ISR
static volatile uint32_t ringTail = 0;   // read by loop()

// ── State ──────────────────────────────────────────────────────
bool     isStreaming  = false;
bool     isConnected  = false;
uint16_t connHandle   = BLE_CONN_HANDLE_INVALID;

// ── BLE device name ────────────────────────────────────────────
static const char* DEVICE_NAME = "Milgrain";

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
  Serial.println("[Oxy] Connected");
  isConnected = true;
  connHandle  = conn_handle;

  // Request a larger MTU + data length so each BLE notification carries
  // many audio samples instead of 20 bytes. This is what lets the link
  // sustain the 256 kbps the 16 kHz/16-bit stream needs.
  BLEConnection* conn = Bluefruit.Connection(conn_handle);
  if (conn) {
    conn->requestMtuExchange(247);
    conn->requestDataLengthUpdate();
  }

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
  connHandle  = BLE_CONN_HANDLE_INVALID;
  stopStreaming();
}

// ── PDM callback (interrupt context) ───────────────────────────
// Reads captured samples and enqueues them into the ring buffer. It
// never touches the BLE transmit path, so capture and send can't collide.
void onPDMData() {
  int bytes = PDM.available();
  if (bytes <= 0) return;

  int toRead  = min(bytes, (int)sizeof(pdmBuffer));
  PDM.read(pdmBuffer, toRead);
  int samples = toRead / 2;

  uint32_t head = ringHead;
  uint32_t tail = ringTail;
  for (int i = 0; i < samples; i++) {
    uint32_t next = (head + 1) & RING_MASK;
    if (next == tail) break;   // ring full — drop rather than corrupt
    ring[head] = pdmBuffer[i];
    head = next;
  }
  ringHead = head;
}

// ── Streaming control ──────────────────────────────────────────
void startStreaming() {
  Serial.println("[Oxy] Starting audio stream");
  isStreaming = true;
  digitalWrite(LED_BUILTIN, LOW);

  PDM.onReceive(onPDMData);
  PDM.setBufferSize(BUFFER_SAMPLES * sizeof(int16_t));
  if (!PDM.begin(AUDIO_CHANNELS, SAMPLE_RATE)) {
    Serial.println("[Oxy] ERROR: PDM start failed");
    isStreaming = false;
    digitalWrite(LED_BUILTIN, HIGH);
  } else {
    // Gain MUST be set after begin(): begin() reinitialises the PDM
    // peripheral at its default gain, so any setGain() before it is lost.
    // The XIAO Sense onboard mic is quiet — use max gain (80 = +20 dB).
    PDM.setGain(MIC_GAIN);
    Serial.print("[Oxy] PDM started OK, gain=");
    Serial.println(MIC_GAIN);
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
  Bluefruit.Advertising.addName();   // also in adv packet — iOS needs name here for reliable didDiscover
  Bluefruit.ScanResponse.addName();

  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244);  // fast then slow (units of 0.625ms)
  Bluefruit.Advertising.setFastTimeout(30);
  Bluefruit.Advertising.start(0);               // 0 = advertise forever

  Serial.print("[Milgrain] BLE advertising as ");
  Serial.println(DEVICE_NAME);
}

// ================================================================
// Main loop
// ================================================================
void loop() {
  updateLED();
  drainAudio();
}

// Drain the audio ring buffer into BLE UART. Writes the largest
// contiguous span the negotiated MTU allows, and advances the tail only
// by the bytes the BLE stack actually accepted — so a full TX FIFO causes
// backpressure (we retry next loop) instead of silently dropping samples.
void drainAudio() {
  if (!isStreaming || !isConnected) return;

  // Payload per notification = MTU - 3 (ATT header), capped to a sane size.
  uint16_t payload = 20;
  BLEConnection* conn = Bluefruit.Connection(connHandle);
  if (conn) {
    uint16_t mtu = conn->getMtu();
    if (mtu > 3) payload = mtu - 3;
  }
  if (payload > 244) payload = 244;
  payload &= ~1u;  // keep an even byte count so Int16 samples never split

  // Periodic diagnostic: depth + first samples
  static unsigned long lastLog = 0;
  if (millis() - lastLog > 5000) {
    lastLog = millis();
    uint32_t depth = (ringHead - ringTail) & RING_MASK;
    Serial.print("[Oxy] ring depth=");
    Serial.print(depth);
    Serial.print(" payload=");
    Serial.print(payload);
    Serial.print(" samples: ");
    for (uint32_t i = 0; i < 5 && i < depth; i++) {
      Serial.print(ring[(ringTail + i) & RING_MASK]);
      Serial.print(" ");
    }
    Serial.println();
  }

  // Bound the work per loop so the LED/BLE housekeeping still runs.
  for (int guard = 0; guard < 64; guard++) {
    uint32_t head = ringHead;          // snapshot (ISR may advance it)
    if (ringTail == head) break;       // nothing to send

    // Contiguous span from tail up to either head or the end of the ring.
    uint32_t spanEnd     = (head > ringTail) ? head : RING_SAMPLES;
    uint32_t spanSamples = spanEnd - ringTail;
    uint32_t spanBytes   = spanSamples * 2;
    if (spanBytes > payload) spanBytes = payload;

    int sent = bleuart.write((const uint8_t*)&ring[ringTail], spanBytes);
    if (sent <= 0) break;              // TX FIFO full — retry next loop

    ringTail = (ringTail + (sent / 2)) & RING_MASK;
    if ((uint32_t)sent < spanBytes) break;  // partial write → FIFO full
  }
}
