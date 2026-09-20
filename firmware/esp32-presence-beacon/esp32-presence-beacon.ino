/*
  Adam ESP32 presence beacon — a connection-only BLE experiment.

  It advertises the Nordic UART Service that Adam already discovers. The iPhone
  can therefore prove a direct, nearby BLE connection without inventing a new
  transport. This sketch does not identify a person, stream audio, or transmit
  household data. A production presence device needs explicit pairing and a
  rotating authenticated token before a connection can be associated with a
  household member.

  Board: ESP32 Dev Module (Arduino-ESP32)
*/

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

namespace {
constexpr char kDeviceName[] = "Adam Presence";
constexpr char kServiceUUID[] = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E";
constexpr char kRXUUID[] = "6E400002-B5A3-F393-E0A9-E50E24DCCA9E";
constexpr char kTXUUID[] = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E";
constexpr char kDoorwayPresenceFrame[] = "PRESENCE:doorway-v1";

BLECharacteristic* transmit = nullptr;
bool adamConnected = false;
unsigned long lastPresenceAt = 0;

class ConnectionCallbacks final : public BLEServerCallbacks {
  void onConnect(BLEServer*) override {
    adamConnected = true;
    Serial.println("Adam connected");
  }

  void onDisconnect(BLEServer*) override {
    adamConnected = false;
    Serial.println("Adam disconnected; advertising again");
    BLEDevice::startAdvertising();
  }
};

class ReceiveCallbacks final : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    const String value = characteristic->getValue();
    Serial.printf("Received %u bytes\n", static_cast<unsigned>(value.length()));
  }
};
}  // namespace

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("Adam ESP32 presence beacon starting");

  BLEDevice::init(kDeviceName);
  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new ConnectionCallbacks());

  BLEService* service = server->createService(kServiceUUID);
  BLECharacteristic* receive = service->createCharacteristic(
    kRXUUID,
    BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR
  );
  receive->setCallbacks(new ReceiveCallbacks());

  transmit = service->createCharacteristic(
    kTXUUID,
    BLECharacteristic::PROPERTY_NOTIFY
  );
  transmit->addDescriptor(new BLE2902());
  service->start();

  BLEAdvertising* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(kServiceUUID);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.println("Advertising Adam Presence over Nordic UART Service");
}

void loop() {
  const unsigned long now = millis();
  // The iPhone subscribes shortly after connection. Repeating a tiny bounded
  // frame lets it recover if that first subscription races the connection.
  if (adamConnected && transmit && now - lastPresenceAt >= 3'000) {
    lastPresenceAt = now;
    transmit->setValue(kDoorwayPresenceFrame);
    transmit->notify();
    Serial.println("Sent doorway presence frame");
  }
  delay(50);
}
