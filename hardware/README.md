# ESP32 light and buzzer

The browser reads existing meal alerts and `EngineState.surfaces[*].status`. While
there is an **unacknowledged** alert on an `action-required` meal, the ESP flashes
**red on and off** and beeps on red. **Acknowledgement turns off the red flashes
and buzzer**, returning the hardware to steady **blue** and silent. The meal's risk
and exposure remain recorded; **Reset session** clears them. A later unacknowledged
alert triggers the hardware again.
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
| GPIO 32 | One side of a normally-open momentary acknowledge button |
| GND | Other side of the acknowledge button |
| Module-rated supply | Buzzer module VCC |

Use one resistor per LED colour. Check the LED's pinout; leg order varies.
Change the pin constants in `esp32-alert/esp32-alert.ino` to match existing wiring.
For a common-anode LED, connect its common leg to **3.3 V** and set `COMMON_ANODE`
to `true`. For an active-low buzzer module, set `BUZZER_ACTIVE_HIGH` to `false`.
These defaults do not target ESP32-C3/S3 boards; select GPIOs available on your board.

A bare two-wire active buzzer needs a suitable transistor driver if its current
exceeds the GPIO rating (and a flyback diode for an inductive buzzer). A passive
piezo needs a tone/PWM driver instead of this sketch's on/off buzzer output.

## Physical acknowledge button

Connect a **normally-open momentary button between GPIO 32 and GND**. The sketch
uses `INPUT_PULLUP`, so no external pull-up resistor is needed. With a four-leg
tactile switch, use two contacts that are disconnected when released and connected
when pressed; two legs on the same side are often permanently joined.

Upload the updated sketch and refresh/reconnect the app over **Bluetooth**. While
an alert is flashing red, press the button once: the app marks every currently
unacknowledged alert as acknowledged, using the same `alert-acknowledged` event as
the on-screen button. **The red flashes and buzzer turn off**, just as they do when
acknowledging on screen. The meal stays on hold until session reset. Pressing during either
the lit or dark part of the flash cycle works.

The input is debounced for 40 ms and sends one notification per press. Holding it
does not repeatedly acknowledge or automatically acknowledge a later alert. Presses
without an active alert or with a missing connection do nothing. The physical button
uses Bluetooth; USB fallback still supports light/buzzer output and the on-screen
acknowledgement button. Older firmware must be re-uploaded to add button notifications.

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
5. The LED turns blue when connected with no unacknowledged alert. **Replay Act 2**
   triggers red-only flashes and the active buzzer when the meal gets an alert.
   Acknowledgement returns the LED to blue and silences the buzzer. The meal's
   recorded risk remains until **Reset session**.

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
The button notifies **GT:ACK** on characteristic
**b584b403-7e4b-4ec3-b6c4-781203a99270**. The app subscribes before sending the initial
verdict, accepts notifications only while connected with an active verdict, and
removes the listener on disconnect. The resulting acknowledgement sends **GT:IDLE**
to stop red flashing and the buzzer. Button events never directly clear exposure.

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
