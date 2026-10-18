#include <Arduino.h>
#include <string.h>

// Bluetooth alerts with USB serial as a fallback.
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <atomic>
constexpr const char *BLE_SERVICE_UUID = "b584b401-7e4b-4ec3-b6c4-781203a99270";
constexpr const char *BLE_COMMAND_UUID = "b584b402-7e4b-4ec3-b6c4-781203a99270";
constexpr const char *BLE_RESET_UUID = "b584b403-7e4b-4ec3-b6c4-781203a99270";
QueueHandle_t bleCommands = nullptr;
BLEServer *bleServer = nullptr;
BLECharacteristic *bleResetButton = nullptr;
std::atomic<bool> restartBleAdvertising{false};
bool bleRestartPending = false;
unsigned long bleRestartAt = 0;

// Classic ESP32 DevKit defaults. Change these to match your wiring/board.
constexpr uint8_t RED_PIN = 27;
constexpr uint8_t GREEN_PIN = 26;
constexpr uint8_t BLUE_PIN = 25;
constexpr uint8_t BUZZER_PIN = 33;
constexpr uint8_t RESET_BUTTON_PIN = 32; // Momentary button between this pin and GND.
constexpr unsigned long BUTTON_DEBOUNCE_MS = 40;
constexpr bool COMMON_ANODE = false;
// Default: active buzzer module with a 3.3 V-compatible signal input.
constexpr bool BUZZER_ACTIVE_HIGH = true;
constexpr unsigned long LINK_TIMEOUT_MS = 5000;
constexpr unsigned long FLASH_MS = 250;
constexpr uint8_t MODE_IDLE = 0;
constexpr uint8_t MODE_ALERT = 1;
constexpr uint8_t MODE_ACKED = 2;

bool alertActive = false;
bool outputsAcknowledged = false;
bool receivedCommand = false;
unsigned long lastCommandAt = 0;
unsigned long alertStartedAt = 0;
char line[24];
size_t lineLength = 0;
bool overflow = false;
int buttonRaw = HIGH;
int buttonStable = HIGH;
unsigned long buttonChangedAt = 0;

void rgb(bool red, bool green, bool blue) {
  digitalWrite(RED_PIN, red != COMMON_ANODE ? HIGH : LOW);
  digitalWrite(GREEN_PIN, green != COMMON_ANODE ? HIGH : LOW);
  digitalWrite(BLUE_PIN, blue != COMMON_ANODE ? HIGH : LOW);
}

void buzzer(bool on) {
  digitalWrite(BUZZER_PIN, on == BUZZER_ACTIVE_HIGH ? HIGH : LOW);
}

int parseCommand(const char *text) {
  if (strcmp(text, "GT:ALERT") == 0) return MODE_ALERT;
  if (strcmp(text, "GT:IDLE") == 0) return MODE_IDLE;
  if (strcmp(text, "GT:ACKED") == 0) return MODE_ACKED;
  return -1;
}

void applyCommand(uint8_t mode) {
  const bool nextAlert = mode == MODE_ALERT;
  const unsigned long now = millis();
  if (nextAlert && (!alertActive || !receivedCommand || now - lastCommandAt > LINK_TIMEOUT_MS)) {
    alertStartedAt = now;
  }
  alertActive = nextAlert;
  outputsAcknowledged = mode == MODE_ACKED;
  receivedCommand = true;
  lastCommandAt = now;
}

void command(const char *text) {
  const int mode = parseCommand(text);
  if (mode >= 0) applyCommand(static_cast<uint8_t>(mode));
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
    if (strlen(text) != length) return;
    const int mode = parseCommand(text);
    if (mode < 0) return;
    const uint8_t nextMode = static_cast<uint8_t>(mode);
    xQueueOverwrite(bleCommands, &nextMode);
  }
};

class AlertBleServerCallbacks : public BLEServerCallbacks {
  void onDisconnect(BLEServer *) override {
    restartBleAdvertising.store(true);
  }
};

void startBluetooth() {
  bleCommands = xQueueCreate(1, sizeof(uint8_t));
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
  bleResetButton = service->createCharacteristic(BLE_RESET_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  bleResetButton->addDescriptor(new BLE2902());
  service->start();
  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(BLE_SERVICE_UUID);
  advertising->setScanResponse(true);
  advertising->start();
  Serial.println("Bluetooth ready: select GhostTrace-ESP in the app's Connect ESP chooser.");
}

void pollBluetooth() {
  uint8_t nextMode;
  if (bleCommands && xQueueReceive(bleCommands, &nextMode, 0) == pdTRUE) {
    applyCommand(nextMode);
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

void pollResetButton(unsigned long now) {
  const int raw = digitalRead(RESET_BUTTON_PIN);
  if (raw != buttonRaw) {
    buttonRaw = raw;
    buttonChangedAt = now;
  }
  if (buttonStable == raw || now - buttonChangedAt < BUTTON_DEBOUNCE_MS) return;
  buttonStable = raw;
  // One reset request per press in any connected state, like the website button.
  // The app resets its engine and replay, then sends the fresh session's verdict.
  if (raw == LOW && receivedCommand && now - lastCommandAt <= LINK_TIMEOUT_MS &&
      bleResetButton && bleServer->getConnectedCount() > 0) {
    bleResetButton->setValue("GT:RESET\n");
    bleResetButton->notify();
    Serial.println("Physical session reset button pressed.");
  }
}

void setup() {
  pinMode(RED_PIN, OUTPUT);
  pinMode(GREEN_PIN, OUTPUT);
  pinMode(BLUE_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(RESET_BUTTON_PIN, INPUT_PULLUP);
  buttonRaw = buttonStable = digitalRead(RESET_BUTTON_PIN);
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
  pollResetButton(now);
  if (!receivedCommand || now - lastCommandAt > LINK_TIMEOUT_MS) {
    // Lost app connection: steady amber, silent.
    rgb(true, true, false);
    buzzer(false);
  } else if (alertActive) {
    const unsigned long phase = ((now - alertStartedAt) / FLASH_MS) % 4;
    // Red, off, red, off. Beep on the first red flash of each cycle.
    rgb(phase == 0 || phase == 2, false, false);
    buzzer(phase == 0);
  } else if (outputsAcknowledged) {
    // High risk remains after acknowledgement: steady red, buzzer silent.
    rgb(true, false, false);
    buzzer(false);
  } else {
    // No alert in this session: neutral blue, silent.
    rgb(false, false, true);
    buzzer(false);
  }
}
