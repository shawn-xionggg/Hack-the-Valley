# ESP32 light and buzzer

The browser reads the existing `EngineState.surfaces[*].status`. If any surface is
`action-required`, the ESP flashes **red, off, amber, off** and beeps on red.
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

## Upload and connect

1. In Arduino IDE, install **esp32 by Espressif Systems**, select your board and
   USB port, and open `esp32-alert/esp32-alert.ino`. Upload it; no extra libraries
   are needed. Close Serial Monitor so the browser can open the port.
2. Run `npm.cmd run dev` from the app folder and open its localhost URL in desktop
   Chrome or Edge. Hosted use requires HTTPS and permission to use serial devices.
3. Under **Exposure tracking**, click **Connect ESP** and select the board's port.
   USB may reset the ESP; allow a few seconds for it to boot.
4. Click **Replay Act 2 (simulated)**. Picking up the handle and dipping the tips
   leave the LED blue. Serving onto the meal starts red/amber flashes and beeping.
   The scripted acknowledgement leaves those outputs active.
5. Click **Reset session**: blue and silent. Live camera events use the same engine
   subscription and hardware connection.

The browser can open a serial port without proving the correct firmware is loaded;
check the physical output during this demo. There is no separate hardware-test
button that fabricates an engine risk event.

## Protocol and connection loss

USB serial is **115200 baud**, newline-delimited ASCII:

```text
GT:ALERT
GT:IDLE
```

The browser sends the latest verdict immediately when it changes, on connection,
and every second. This also restores the output after an ESP reboot. The sketch
ignores unknown/oversized lines and never uses blocking delays.

Before the first command, or after five seconds without a valid command, the ESP
shows **steady amber** and silences the buzzer to indicate a missing connection.
The engine's risk state is unchanged. This can also happen if the browser tab is
suspended or its timers are throttled; keep the demo tab visible. **Disconnect ESP**
sends idle before releasing USB. Reconnecting sends the engine's current verdict,
including an alert that was already active.

Implementation references: [Chrome Web Serial](https://developer.chrome.com/docs/capabilities/serial)
and [Espressif GPIO API](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/gpio.html).
