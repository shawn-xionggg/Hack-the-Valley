#include <Arduino.h>
#include <string.h>
#include <WiFi.h>
#include <WebServer.h>

// Optional: copy wifi-config.example.h to wifi-config.h to join your router/hotspot.
#if __has_include("wifi-config.h")
#include "wifi-config.h"
#endif
#ifndef GHOSTTRACE_WIFI_SSID
#define GHOSTTRACE_WIFI_SSID ""
#define GHOSTTRACE_WIFI_PASSWORD ""
#endif
constexpr const char *AP_SSID = "GhostTrace-ESP";
constexpr const char *AP_PASSWORD = "ghosttrace32";
WebServer server(80);
bool printedStationIp = false;

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

void corsHeaders() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.sendHeader("Access-Control-Allow-Private-Network", "true");
  server.sendHeader("Cache-Control", "no-store");
}

void startWifi() {
  WiFi.mode(strlen(GHOSTTRACE_WIFI_SSID) ? WIFI_AP_STA : WIFI_AP);
  // Keep the direct connection available even if venue Wi-Fi is unavailable.
  const IPAddress apIp(192, 168, 4, 1);
  WiFi.softAPConfig(apIp, apIp, IPAddress(255, 255, 255, 0));
  if (WiFi.softAP(AP_SSID, AP_PASSWORD)) {
    Serial.print("Join GhostTrace-ESP Wi-Fi. ESP address: http://");
    Serial.println(WiFi.softAPIP());
  } else {
    Serial.println("ESP Wi-Fi access point failed to start; reset the board.");
  }
  if (strlen(GHOSTTRACE_WIFI_SSID)) {
    WiFi.setAutoReconnect(true);
    WiFi.begin(GHOSTTRACE_WIFI_SSID, GHOSTTRACE_WIFI_PASSWORD);
  }
  server.on("/", HTTP_GET, []() {
    corsHeaders();
    server.send(200, "application/json", "{\"device\":\"ghosttrace-esp32\",\"endpoint\":\"/alert\"}");
  });
  server.on("/alert", HTTP_OPTIONS, []() {
    corsHeaders();
    server.send(204, "text/plain", "");
  });
  server.on("/alert", HTTP_POST, []() {
    corsHeaders();
    String body = server.arg("plain");
    body.trim();
    if (body != "GT:ALERT" && body != "GT:IDLE") {
      server.send(400, "text/plain", "Expected GT:ALERT or GT:IDLE");
      return;
    }
    command(body.c_str());
    server.send(200, "application/json", String("{\"device\":\"ghosttrace-esp32\",\"command\":\"") + body + "\"}");
  });
  server.onNotFound([]() {
    corsHeaders();
    server.send(404, "text/plain", "Not found");
  });
  server.begin();
}

void setup() {
  pinMode(RED_PIN, OUTPUT);
  pinMode(GREEN_PIN, OUTPUT);
  pinMode(BLUE_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  rgb(false, false, false);
  buzzer(false);
  Serial.begin(115200);
  startWifi();
}

void loop() {
  server.handleClient();
  if (strlen(GHOSTTRACE_WIFI_SSID) && WiFi.status() == WL_CONNECTED && !printedStationIp) {
    Serial.print("Router/hotspot ESP address: http://");
    Serial.println(WiFi.localIP());
    printedStationIp = true;
  }
  if (WiFi.status() != WL_CONNECTED) printedStationIp = false;
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
    // Lost app connection (Wi-Fi or USB): steady amber, silent.
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
