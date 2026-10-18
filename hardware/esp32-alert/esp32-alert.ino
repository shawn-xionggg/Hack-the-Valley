#include <Arduino.h>
#include <string.h>

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

void setup() {
  pinMode(RED_PIN, OUTPUT);
  pinMode(GREEN_PIN, OUTPUT);
  pinMode(BLUE_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  rgb(false, false, false);
  buzzer(false);
  Serial.begin(115200);
}

void loop() {
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
    // Lost browser/USB link: steady amber, silent. This is a connection status.
    rgb(true, true, false);
    buzzer(false);
  } else if (alertActive) {
    const unsigned long phase = ((now - alertStartedAt) / FLASH_MS) % 4;
    // Red, off, amber, off. Beep during the red flash.
    rgb(phase == 0 || phase == 2, phase == 2, false);
    buzzer(phase == 0);
  } else {
    // No action-required verdict: neutral blue, silent.
    rgb(false, false, true);
    buzzer(false);
  }
}
