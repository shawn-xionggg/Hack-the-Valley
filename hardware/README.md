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

## Bluetooth setup (default)

Bluetooth Low Energy connects the app directly to the ESP32 while the laptop keeps
its normal Wi-Fi/internet connection. No IP address or router configuration is needed.

1. In Arduino IDE, select your ESP32 board and USB port, then upload the updated
   **esp32-alert/esp32-alert.ino** once over USB. Install **esp32 by Espressif Systems**
   if needed; its BLE library is included.
2. Power the ESP32 from a **power bank or USB wall supply**. Turn on your laptop's
   Bluetooth and keep its normal Wi-Fi connected.
3. Open the app in **desktop Chrome or Edge** at its localhost URL (or HTTPS).
   Under **Exposure tracking**, select **Bluetooth** and click **Connect ESP**.
4. In the browser's Bluetooth chooser, select **GhostTrace-ESP** and connect.
   Select it through the app, rather than pairing it in Windows Bluetooth settings.
5. The LED turns blue when connected with no action-required alert. **Replay Act 2**
   triggers red-only flashes and the active buzzer when the meal gets an alert.
   Acknowledgement leaves the alert active; **Reset session** returns it to blue.

The browser uses **Bluetooth Low Energy (BLE)**, not Bluetooth Classic serial.
The classic ESP32/WROOM boards support this. ESP32-S2 has no Bluetooth; other board
variants need their own GPIO selections. Web Bluetooth requires a supported browser,
Bluetooth hardware enabled, and localhost or HTTPS. An unsupported browser shows an
explanation in the app; USB is available as a fallback.

If the device is missing, upload this Bluetooth firmware, check its power, move it
nearby, and disconnect it from other app tabs/devices. It only advertises the
GhostTrace service with the updated firmware. After a disconnect it starts
advertising again so **Connect ESP** can reconnect. Keep one app connected at a time.

## USB fallback

Connect the board to the laptop with a USB data cable, close Serial Monitor, select
**USB serial** in the app, then click **Connect ESP** and select its COM port.

## Protocol and connection loss

Bluetooth advertises service **b584b401-7e4b-4ec3-b6c4-781203a99270** with writable
command characteristic **b584b402-7e4b-4ec3-b6c4-781203a99270**. The browser sends
the text commands below using acknowledged GATT writes, serializing writes and
coalescing pending updates to the latest verdict. The firmware validates BLE input
and queues it for the main loop; the BLE task never writes GPIOs or engine state.
BLE writes time out after three seconds and release the connection on failure.

USB fallback uses **115200 baud**, newline-delimited ASCII:

```text
GT:ALERT
GT:IDLE
```

The browser sends the latest verdict immediately when it changes, on connection,
and every second. After a Bluetooth disconnect or ESP reboot, click **Connect ESP**
again; the current verdict is sent on reconnection. Failures appear in the app
and can be retried with **Connect ESP**. The sketch ignores invalid commands and
processes received commands in its main loop while flashing.

Before the first command, or after five seconds without a valid command, the ESP
shows **steady amber** and silences the buzzer to indicate a missing connection.
The engine's risk state is unchanged. This can also happen if the browser tab is
suspended or its timers are throttled; keep the demo tab visible. **Disconnect ESP**
sends idle before stopping requests and releasing Bluetooth/USB. Reconnecting sends the engine's current verdict,
including an alert that was already active.

Implementation references: [Chrome Web Bluetooth](https://developer.chrome.com/docs/capabilities/bluetooth),
[Espressif BLE UART example](https://github.com/espressif/arduino-esp32/blob/master/libraries/BLE/examples/UART/UART.ino),
[Chrome Web Serial](https://developer.chrome.com/docs/capabilities/serial)
and [Espressif GPIO API](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/gpio.html).
