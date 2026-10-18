#include <Arduino.h>
#include <string.h>

// Bluetooth alerts with USB serial as a fallback.
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <atomic>
constexpr const char *BLE_SERVICE_UUID = "b584b401-7e4b-4ec3-b6c4-781203a99270";
constexpr const char *BLE_COMMAND_UUID = "b584b402-7e4b-4ec3-b6c4-781203a99270";
QueueHandle_t bleCommands = nullptr;
BLEServer *bleServer = nullptr;
std::atomic<bool> restartBleAdvertising{false};
bool bleRestartPending = false;
unsigned long bleRestartAt = 0;

// Classic ESP32 DevKit defaults. Change these to match your wiring/board.
constexpr uint8_t RED_PIN = 25;
constexpr uint8_t GREEN_PIN = 26;
constexpr uint8_t BLUE_PIN = 27;
constexpr uint8_t BUZZER_PIN = 33;
constexpr bool COMMON_ANODE = false;
// Default: active buzzer module with a 3.3 V-compatible signal input.
constexpr bool BUZZER_ACTIVE_HIGH = true;
constexpr unsigned long LINK_TIMEOUT_MS = 5000;
constexpr unsigned long FLASH_MS = 250;

bool alertActive = false;
bool receivedCommand = false;
unsigned long lastCommandAt = 0;
unsigned long alertStartedAt = 0;
char line[24];
size_t lineLength = 0;
bool overflow = false;

void rgb(bool red, bool green, bool blue) {
  digitalWrite(RED_PIN, red != COMMON_ANODE ? HIGH : LOW);
  digitalWrite(GREEN_PIN, green != COMMON_ANODE ? HIGH : LOW);
  digitalWrite(BLUE_PIN, blue != COMMON_ANODE ? HIGH : LOW);
}

void buzzer(bool on) {
  digitalWrite(BUZZER_PIN, on == BUZZER_ACTIVE_HIGH ? HIGH : LOW);
}

void command(const char *text) {
  bool nextAlert;
  if (strcmp(text, "GT:ALERT") == 0) nextAlert = true;
  else if (strcmp(text, "GT:IDLE") == 0) nextAlert = false;
  else return; // Ignore unrelated or malformed serial input.
  const unsigned long now = millis();
  if (nextAlert && (!alertActive || !receivedCommand || now - lastCommandAt > LINK_TIMEOUT_MS)) {
    alertStartedAt = now;
  }
  alertActive = nextAlert;
  receivedCommand = true;
  lastCommandAt = now;
}

class AlertBleCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *characteristic) override {
    // BLE callbacks run on another task. Queue the latest command for loop(),
    // which owns alert state and all GPIO writes.
    const auto value = characteristic->getValue();
    size_t length = value.length();
    if (length == 0 || length >= 24) return;
    char text[24];
    memcpy(text, value.c_str(), length);
    while (length && (text[length - 1] == '\n' || text[length - 1] == '\r')) --length;
    text[length] = '\0';
    bool nextAlert;
    if (length == 8 && strcmp(text, "GT:ALERT") == 0) nextAlert = true;
    else if (length == 7 && strcmp(text, "GT:IDLE") == 0) nextAlert = false;
    else return;
    xQueueOverwrite(bleCommands, &nextAlert);
  }
};

class AlertBleServerCallbacks : public BLEServerCallbacks {
  void onDisconnect(BLEServer *) override {
    restartBleAdvertising.store(true);
  }
};

void startBluetooth() {
  bleCommands = xQueueCreate(1, sizeof(bool));
  if (!bleCommands) {
    Serial.println("BLE command queue could not be created; reset the ESP.");
    return;
  }
  BLEDevice::init("GhostTrace-ESP");
  bleServer = BLEDevice::createServer();
  bleServer->setCallbacks(new AlertBleServerCallbacks());
  BLEService *service = bleServer->createService(BLE_SERVICE_UUID);
  BLECharacteristic *characteristic = service->createCharacteristic(BLE_COMMAND_UUID, BLECharacteristic::PROPERTY_WRITE);
  characteristic->setCallbacks(new AlertBleCallbacks());
  service->start();
  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(BLE_SERVICE_UUID);
  advertising->setScanResponse(true);
  advertising->start();
  Serial.println("Bluetooth ready: select GhostTrace-ESP in the app's Connect ESP chooser.");
}

void pollBluetooth() {
  bool nextAlert;
  if (bleCommands && xQueueReceive(bleCommands, &nextAlert, 0) == pdTRUE) {
    command(nextAlert ? "GT:ALERT" : "GT:IDLE");
  }
  if (restartBleAdvertising.exchange(false)) {
    bleRestartAt = millis();
    bleRestartPending = true;
  }
  // Give the BLE stack time to close the previous connection without blocking.
  if (bleRestartPending && millis() - bleRestartAt >= 500) {
    if (bleServer->getConnectedCount() == 0) BLEDevice::startAdvertising();
    bleRestartPending = false;
  }
}

void setup() {
  pinMode(RED_PIN, OUTPUT);
  pinMode(GREEN_PIN, OUTPUT);
  pinMode(BLUE_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  rgb(false, false, false);
  buzzer(false);
  Serial.begin(115200);
  startBluetooth();
}

void loop() {
  pollBluetooth();
  // Bounded work and no delay(): receive reset commands even while flashing.
  for (int i = 0; i < 64 && Serial.available(); ++i) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\n') {
      if (!overflow) {
        line[lineLength] = '\0';
        command(line);
      }
      lineLength = 0;
      overflow = false;
    } else if (c != '\r') {
      if (lineLength < sizeof(line) - 1 && !overflow) line[lineLength++] = c;
      else overflow = true;
    }
  }

  const unsigned long now = millis();
  if (!receivedCommand || now - lastCommandAt > LINK_TIMEOUT_MS) {
    // Lost app connection: steady amber, silent.
    rgb(true, true, false);
    buzzer(false);
  } else if (alertActive) {
    const unsigned long phase = ((now - alertStartedAt) / FLASH_MS) % 4;
    // Red, off, red, off. Beep on the first red flash of each cycle.
    rgb(phase == 0 || phase == 2, false, false);
    buzzer(phase == 0);
  } else {
    // No action-required verdict: neutral blue, silent.
    rgb(false, false, true);
    buzzer(false);
  }
}
