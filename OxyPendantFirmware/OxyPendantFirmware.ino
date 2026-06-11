/*
  Oxy Pendant Firmware for Seeed Studio XIAO nRF52840 Sense

  What this firmware does:
  - Advertises as a Nordic UART Service BLE peripheral named "Oxy".
  - Exposes the exact UUIDs used by OxyApp's PendantBLEManager:
      Service: 6E400001-B5A3-F393-E0A9-E50E24DCCA9E
      RX:      6E400002-B5A3-F393-E0A9-E50E24DCCA9E  (phone writes here)
      TX:      6E400003-B5A3-F393-E0A9-E50E24DCCA9E  (pendant notifies phone)
  - Sends the text commands the Swift app currently understands:
      SOUND_WAKE, START_RECORDING, STOP_RECORDING, TOGGLE_RECORDING,
      OPEN_CHAT, SEND_MESSAGE, CONFIRM, CANCEL
  - Uses push-to-talk as the main path because OxyApp records and transcribes
    with the iPhone microphone after it receives START_RECORDING/STOP_RECORDING.
  - Samples the onboard PDM microphone for an optional loud-sound wake trigger.

  Board: Seeed Studio XIAO nRF52840 Sense
  Arduino core: Seeed nRF52 Boards package
  Libraries: built-in Bluefruit BLE API from the Seeed/Adafruit nRF52 core, PDM
*/

#include <bluefruit.h>
#include <PDM.h>

#define UART_SERVICE_UUID "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define UART_RX_UUID      "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
#define UART_TX_UUID      "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

#ifndef PENDANT_BUTTON_PIN
#define PENDANT_BUTTON_PIN D1
#endif

#define LED_CONNECTED LED_BUILTIN

BLEService uartService(UART_SERVICE_UUID);
BLECharacteristic rxCharacteristic(UART_RX_UUID);
BLECharacteristic txCharacteristic(UART_TX_UUID);

const unsigned long debounceMs = 35;
const unsigned long longPressMs = 900;
const unsigned long doubleClickWindowMs = 450;
const unsigned long maxPressForClickMs = 700;

const bool enableSoundWakeTrigger = true;
const int soundWakeDeltaThreshold = 10;
const int soundWakePeakFloor = 70;
const int soundWakeConsecutiveWindows = 1;
const unsigned long soundWakeCooldownMs = 1500;
const unsigned long soundWakeAutoStopMs = 8000;
const float soundNoiseAlpha = 0.96f;
const unsigned long soundDebugIntervalMs = 250;

volatile int pdmBytesRead = 0;
volatile bool pdmOverflowed = false;
volatile bool pdmFrameReady = false;
short pdmBuffer[512];
short pdmDrainBuffer[512];

bool connected = false;
bool recording = false;
bool soundTriggeredRecording = false;
bool lastRawButtonState = HIGH;
bool debouncedButtonState = HIGH;
bool pressHandledAsLong = false;
bool clickWaiting = false;

unsigned long lastDebounceAt = 0;
unsigned long pressStartedAt = 0;
unsigned long firstClickAt = 0;
unsigned long lastSoundWakeAt = 0;
unsigned long soundRecordingStartedAt = 0;
unsigned long lastSoundDebugAt = 0;
float soundNoiseFloor = 0.0f;
int soundWakeWindowCount = 0;

void onPDMdata() {
  int available = PDM.available();
  if (available <= 0) return;

  if (pdmFrameReady) {
    pdmOverflowed = true;
    PDM.read(pdmDrainBuffer, min(available, (int)sizeof(pdmDrainBuffer)));
    return;
  }

  pdmBytesRead = PDM.read(pdmBuffer, min(available, (int)sizeof(pdmBuffer)));
  pdmFrameReady = pdmBytesRead > 0;
}

void sendBytes(const uint8_t *data, uint16_t length) {
  if (!connected) return;
  txCharacteristic.notify(data, length);
}

void sendCommand(const char *command) {
  if (!connected) {
    Serial.print("Not connected; dropped command: ");
    Serial.println(command);
    return;
  }

  sendBytes((const uint8_t *)command, strlen(command));
  Serial.print("TX -> ");
  Serial.println(command);
}

void startOxyRecording() {
  if (!recording) {
    sendCommand("OPEN_CHAT");
    delay(25);
    sendCommand("START_RECORDING");
    recording = true;
  }
}

void startPhoneVoiceCommand() {
  if (!recording) {
    sendCommand("CHAT");
    recording = true;
  }
}

void triggerVoiceCommand(const char *source) {
  recording = false;
  Serial.print(source);
  Serial.println(" trigger -> SOUND_WAKE");
  sendCommand("SOUND_WAKE");
  recording = true;
}

void stopOxyRecording() {
  if (recording) {
    sendCommand("STOP_RECORDING");
    recording = false;
    soundTriggeredRecording = false;
  }
}

void toggleOxyRecording() {
  sendCommand("OPEN_CHAT");
  delay(25);
  sendCommand("TOGGLE_RECORDING");
  recording = !recording;
  soundTriggeredRecording = false;
}

void handleCentralCommand(const uint8_t *data, uint16_t length) {
  char incoming[245];
  length = min(length, (uint16_t)244);
  memcpy(incoming, data, length);
  incoming[length] = '\0';

  Serial.print("RX <- ");
  Serial.println(incoming);

  if (strcasecmp(incoming, "START") == 0) {
    Serial.println("Phone requested pendant audio capture; current firmware uses phone-side speech.");
  } else if (strcasecmp(incoming, "STOP") == 0) {
    sendBytes((const uint8_t *)"DONE", 4);
  }
}

void rxWriteCallback(uint16_t conn_hdl, BLECharacteristic *chr, uint8_t *data, uint16_t len) {
  (void)conn_hdl;
  (void)chr;
  handleCentralCommand(data, len);
}

void connectCallback(uint16_t conn_hdl) {
  (void)conn_hdl;
  connected = true;
  digitalWrite(LED_CONNECTED, HIGH);
  Serial.println("Central connected");
  sendCommand("CONNECTED");
}

void disconnectCallback(uint16_t conn_hdl, uint8_t reason) {
  (void)conn_hdl;
  connected = false;
  recording = false;
  soundTriggeredRecording = false;
  clickWaiting = false;
  digitalWrite(LED_CONNECTED, LOW);
  Serial.print("Central disconnected, reason: 0x");
  Serial.println(reason, HEX);
}

void handleButton() {
  bool rawState = digitalRead(PENDANT_BUTTON_PIN);
  unsigned long now = millis();

  if (rawState != lastRawButtonState) {
    lastDebounceAt = now;
    lastRawButtonState = rawState;
  }

  if ((now - lastDebounceAt) < debounceMs || rawState == debouncedButtonState) {
    if (debouncedButtonState == LOW && !pressHandledAsLong && (now - pressStartedAt) >= longPressMs) {
      pressHandledAsLong = true;
      startOxyRecording();
    }
    return;
  }

  debouncedButtonState = rawState;

  if (debouncedButtonState == LOW) {
    pressStartedAt = now;
    pressHandledAsLong = true;
    clickWaiting = false;
    triggerVoiceCommand("Button");
  } else {
    unsigned long pressDuration = now - pressStartedAt;

    if (pressHandledAsLong) {
      return;
    }

    if (pressDuration > maxPressForClickMs) {
      toggleOxyRecording();
      return;
    }

    if (clickWaiting && (now - firstClickAt) <= doubleClickWindowMs) {
      clickWaiting = false;
      sendCommand("SEND_MESSAGE");
    } else {
      clickWaiting = true;
      firstClickAt = now;
    }
  }
}

void handlePendingClickTimeout() {
  unsigned long now = millis();
  if (clickWaiting && (now - firstClickAt) > doubleClickWindowMs) {
    clickWaiting = false;
    sendCommand("OPEN_CHAT");
  }
}

void handleSerialCommands() {
  if (!Serial.available()) return;

  String value = Serial.readStringUntil('\n');
  value.trim();
  value.toUpperCase();

  if (value == "START" || value == "START_RECORDING") startOxyRecording();
  else if (value == "STOP" || value == "STOP_RECORDING") stopOxyRecording();
  else if (value == "TOGGLE" || value == "TOGGLE_RECORDING") toggleOxyRecording();
  else if (value == "CHAT") startPhoneVoiceCommand();
  else if (value == "OPEN_CHAT") sendCommand("OPEN_CHAT");
  else if (value == "SEND" || value == "SEND_MESSAGE") sendCommand("SEND_MESSAGE");
  else if (value == "YES" || value == "CONFIRM" || value == "OK") sendCommand("CONFIRM");
  else if (value == "NO" || value == "CANCEL" || value == "REJECT") sendCommand("CANCEL");
  else if (value == "PING") {
    Serial.println("PONG");
    sendCommand("PONG");
  }
  else if (value.length()) {
    Serial.print("Unknown serial command: ");
    Serial.println(value);
  }
}

void handleSoundWake() {
  if (!enableSoundWakeTrigger || !pdmFrameReady) return;

  int bytesRead = pdmBytesRead;
  pdmFrameReady = false;
  if (pdmOverflowed) {
    pdmOverflowed = false;
    Serial.println("PDM buffer overrun recovered.");
  }

  int sampleCount = bytesRead / 2;
  if (sampleCount <= 0) return;

  long sumSquares = 0;
  int peak = 0;
  for (int i = 0; i < sampleCount; i++) {
    int amplitude = abs((int)pdmBuffer[i]);
    if (amplitude > peak) peak = amplitude;
    sumSquares += (long)amplitude * amplitude;
  }

  int rms = sqrt((float)sumSquares / sampleCount);
  if (soundNoiseFloor <= 0.0f) {
    soundNoiseFloor = rms;
  } else if (!recording) {
    soundNoiseFloor = soundNoiseAlpha * soundNoiseFloor + (1.0f - soundNoiseAlpha) * rms;
  }

  int soundDelta = rms - (int)soundNoiseFloor;
  bool speechLikeSound = peak >= soundWakePeakFloor && soundDelta >= soundWakeDeltaThreshold;
  if (speechLikeSound) {
    soundWakeWindowCount++;
  } else if (soundWakeWindowCount > 0) {
    soundWakeWindowCount--;
  }

  unsigned long now = millis();
  if ((now - lastSoundDebugAt) >= soundDebugIntervalMs || speechLikeSound) {
    lastSoundDebugAt = now;
    Serial.print("mic sound peak/rms/noise/delta/windows: ");
    Serial.print(peak);
    Serial.print("/");
    Serial.print(rms);
    Serial.print("/");
    Serial.print((int)soundNoiseFloor);
    Serial.print("/");
    Serial.print(soundDelta);
    Serial.print("/");
    Serial.println(soundWakeWindowCount);
  }

  if (!recording && soundWakeWindowCount >= soundWakeConsecutiveWindows && (now - lastSoundWakeAt) > soundWakeCooldownMs) {
    lastSoundWakeAt = now;
    soundWakeWindowCount = 0;
    soundTriggeredRecording = true;
    soundRecordingStartedAt = now;
    Serial.print("Sound wake peak/rms/noise/delta: ");
    Serial.println(peak);
    Serial.print(rms);
    Serial.print("/");
    Serial.print((int)soundNoiseFloor);
    Serial.print("/");
    Serial.println(soundDelta);
    if (connected) {
      triggerVoiceCommand("Sound wake");
    } else {
      Serial.println("Sound wake detected; BLE not connected, SOUND_WAKE not sent.");
    }
  }

  if (soundTriggeredRecording && recording && (now - soundRecordingStartedAt) > soundWakeAutoStopMs) {
    stopOxyRecording();
  }
}

void configureBLE() {
  Bluefruit.begin();
  Bluefruit.setTxPower(4);
  Bluefruit.setName("Oxy");
  Bluefruit.Periph.setConnectCallback(connectCallback);
  Bluefruit.Periph.setDisconnectCallback(disconnectCallback);

  uartService.begin();

  rxCharacteristic.setProperties(CHR_PROPS_WRITE | CHR_PROPS_WRITE_WO_RESP);
  rxCharacteristic.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  rxCharacteristic.setMaxLen(244);
  rxCharacteristic.setWriteCallback(rxWriteCallback);
  rxCharacteristic.begin();

  txCharacteristic.setProperties(CHR_PROPS_NOTIFY);
  txCharacteristic.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  txCharacteristic.setMaxLen(244);
  txCharacteristic.begin();

  Bluefruit.Advertising.stop();
  Bluefruit.Advertising.clearData();
  Bluefruit.ScanResponse.clearData();
  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addService(uartService);
  Bluefruit.ScanResponse.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244);
  Bluefruit.Advertising.setFastTimeout(30);
  Bluefruit.Advertising.start(0);

  Serial.println("Advertising Nordic UART Service as Oxy");
}

void configurePDM() {
  PDM.setPins(PIN_PDM_DIN, PIN_PDM_CLK, PIN_PDM_PWR);
  PDM.setBufferSize(1024);
  PDM.onReceive(onPDMdata);
  if (!PDM.begin(1, 16000)) {
    Serial.println("PDM microphone failed to start; button BLE commands still work.");
  } else {
    PDM.setGain(40);
    Serial.print("PDM pins data/clk/pwr: ");
    Serial.print(PIN_PDM_DIN);
    Serial.print("/");
    Serial.print(PIN_PDM_CLK);
    Serial.print("/");
    Serial.println(PIN_PDM_PWR);
    Serial.println("PDM microphone ready for speech wake trigger.");
  }
}

void setup() {
  pinMode(LED_CONNECTED, OUTPUT);
  digitalWrite(LED_CONNECTED, LOW);
  pinMode(PENDANT_BUTTON_PIN, INPUT_PULLUP);

  Serial.begin(115200);
  delay(1200);
  Serial.println("Oxy Pendant Firmware starting");

  configureBLE();
  configurePDM();
}

void loop() {
  handleButton();
  handlePendingClickTimeout();
  handleSerialCommands();
  handleSoundWake();
  delay(2);
}
