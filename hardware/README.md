# ESP32 light and buzzer

The browser reads the existing `EngineState.surfaces[*].status`. If any surface is
`action-required`, the ESP flashes **red on and off** and beeps on red.
Otherwise it shows steady **blue** and stays silent. Acknowledgement, hand washing,
and utensil replacement do not clear an existing meal alert; **Reset session** does.
No risk thresholds, engine events, vision rules, or shared types are changed.

## Wiring

Defaults target a **classic ESP32 DevKit**, a **common-cathode 4-pin RGB LED**, and
an **active buzzer module with a 3.3 V-compatible signal input**.

| ESP32 | Connect to |
| --- | --- |
| GPIO 25 | 220–330 ohm resistor → LED red leg |
| GPIO 26 | 220–330 ohm resistor → LED green leg |
| GPIO 27 | 220–330 ohm resistor → LED blue leg |
| GND | LED common cathode and buzzer module GND |
| GPIO 33 | Buzzer module signal input |
| Module-rated supply | Buzzer module VCC |

Use one resistor per LED colour. Check the LED's pinout; leg order varies.
Change the pin constants in `esp32-alert/esp32-alert.ino` to match existing wiring.
For a common-anode LED, connect its common leg to **3.3 V** and set `COMMON_ANODE`
to `true`. For an active-low buzzer module, set `BUZZER_ACTIVE_HIGH` to `false`.
These defaults do not target ESP32-C3/S3 boards; select GPIOs available on your board.

A bare two-wire active buzzer needs a suitable transistor driver if its current
exceeds the GPIO rating (and a flyback diode for an inductive buzzer). A passive
piezo needs a tone/PWM driver instead of this sketch's on/off buzzer output.

## Wireless setup (default)

1. In Arduino IDE, install **esp32 by Espressif Systems**, select your board and
   USB port, and open `esp32-alert/esp32-alert.ino`. Upload the updated firmware
   **once over USB**. WiFi and WebServer are included with the ESP32 board package;
   no extra libraries are needed.
2. Unplug the board from your laptop. Power its USB connector from a **power bank
   or USB wall supply**. It still needs power, but the laptop connection is wireless.
3. Start the app with `npm.cmd run dev` and open its localhost URL in desktop
   Chrome or Edge. **Start the camera while your laptop still has internet** so
   MediaPipe can download its model and WASM files before switching Wi-Fi networks.
4. Join **GhostTrace-ESP** from your laptop's Wi-Fi settings, password
   **ghosttrace32**. Stay connected even if Windows says there is no internet.
   The app stays at its **localhost URL**; don't move the camera app to the ESP IP.
5. Under **Exposure tracking**, select **Wi-Fi (wireless)**, leave the ESP address
   at **http://192.168.4.1**, and click **Connect ESP**. Allow local-network access
   if your browser asks. Blue means the app is connected with no action-required alert.
6. Click **Replay Act 2 (simulated)**. Picking up the handle and dipping the tips
   leave the LED blue. Serving onto the meal starts red flashes and beeping.
   The scripted acknowledgement leaves those outputs active.
7. Click **Reset session**: blue and silent. Live camera events use the same engine
   subscription and hardware connection.

The ESP creates its own Wi-Fi network, so no venue router is required. It does not
provide internet access. You can open **http://192.168.4.1/** in another tab to check
that the board responds with `{"device":"ghosttrace-esp32","endpoint":"/alert"}`.
Keep only one app tab connected to a board to avoid competing output commands.

### Use your existing Wi-Fi or phone hotspot instead

Copy `esp32-alert/wifi-config.example.h` to **wifi-config.h** in the same folder,
fill in the network name and password, and upload again. `wifi-config.h` is ignored
by Git. Use a **2.4 GHz** network without a captive portal or client isolation.
Connect the laptop to that same network. During setup, Serial Monitor at 115200
baud prints **Router/hotspot ESP address** once connected; enter that address in
the app. You can then unplug USB and power the board separately. Its own
GhostTrace-ESP access point remains available as a fallback. A router-assigned IP
can change after reboot; check the address or reserve it in your router.

### USB fallback

Connect the board to the laptop with a USB data cable, close Serial Monitor, select
**USB serial** in the app, then click **Connect ESP** and select its COM port.

## Protocol and connection loss

Wi-Fi sends **POST /alert** with `Content-Type: text/plain` and one of the commands
below as the body. The board validates it and acknowledges the device identity and
accepted command as JSON. CORS and OPTIONS responses allow the localhost app to
communicate with the board. USB fallback uses **115200 baud**, newline-delimited ASCII:

```text
GT:ALERT
GT:IDLE
```

The browser sends the latest verdict immediately when it changes, on connection,
and every second. This also restores the output after an ESP reboot. Requests time
out after two seconds; failures appear in the app and can be retried with
**Connect ESP**. The sketch ignores invalid commands. It serves HTTP requests from
the main loop, so flashing continues between requests.

Before the first command, or after five seconds without a valid command, the ESP
shows **steady amber** and silences the buzzer to indicate a missing connection.
The engine's risk state is unchanged. This can also happen if the browser tab is
suspended or its timers are throttled; keep the demo tab visible. **Disconnect ESP**
sends idle before stopping Wi-Fi requests or releasing USB. Reconnecting sends the engine's current verdict,
including an alert that was already active.

For the direct ESP network, run the camera app from **localhost**. A remotely hosted
HTTPS app's access to the board's HTTP endpoint depends on the browser's local-network
and mixed-content rules; use localhost if the browser blocks it. Local-network
permission must be allowed. Reconnecting the laptop to another Wi-Fi network can
also break the link until you restore access to the ESP.

Implementation references: [ESP32 Wi-Fi API](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/wifi.html),
[Espressif WebServer example](https://github.com/espressif/arduino-esp32/blob/master/libraries/WebServer/examples/HelloServer/HelloServer.ino),
[Chrome local network access](https://developer.chrome.com/blog/local-network-access),
[Chrome Web Serial](https://developer.chrome.com/docs/capabilities/serial)
and [Espressif GPIO API](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/gpio.html).
