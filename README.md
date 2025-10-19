# MIDI Piano Player

This project is a browser-based player that can stream MIDI files to an electronic piano over either USB (Web MIDI) or Bluetooth Low Energy (Web Bluetooth). It ships with a curated library of MIDI files under `assets/midi`, lets you search and play them immediately, and also supports uploading additional songs from your computer.

## Features
- Discover and connect to USB MIDI outputs via the Web MIDI API.
- Pair with BLE MIDI instruments using the standard MIDI service UUID.
- Browse the bundled MIDI catalogue with live search backed by `assets/midi_manifest.json`.
- Upload `.mid` / `.midi` files and queue them alongside the built-in songs.
- Parse and schedule playback with [`@tonejs/midi`](https://github.com/Tonejs/Midi), including program changes, control change data, pitch bends, and note release velocity for natural playback.

## Requirements
- A modern Chromium-based browser (Chrome, Edge, or Arc) with Web MIDI enabled. Firefox currently requires the [`dom.webmidi.enabled`](https://developer.mozilla.org/docs/Web/API/MIDIAccess#browser_compatibility) flag and lacks Bluetooth support.
- HTTPS hosting or `localhost`. Web MIDI and Web Bluetooth are both restricted to secure contexts.
- An electronic piano or sound module that supports USB MIDI or BLE MIDI (UUID `03B80E5A-EDE8-4B33-A751-6CE34EC4C700`).

## Project Structure
```
assets/
  midi/                  # Bundled MIDI library (nested folders supported)
  midi_manifest.json     # Auto-generated list consumed by the UI
js/app.js                # Main frontend logic (connections, playback, UI)
index.html               # Single-page application shell
styles.css               # Styling for the player
generate_midi_manifest.py# Utility to rebuild the manifest
```

## Running Locally
Because the browser features require a secure origin, serve the directory over HTTPS:

### Option 1: Caddy (recommended)
1. Install [Caddy](https://caddyserver.com/docs/install).
2. Adjust the site address in `Caddyfile` if needed (defaults to `192.168.20.10`).
3. Start the server:
   ```sh
   caddy run
   ```
4. Visit the configured HTTPS URL from a supported browser. Accept the local TLS certificate the first time.

### Option 2: `http-server` (development only)
Chromium treats `http://localhost` as secure, so you can use any static server locally:
```sh
npx http-server -c-1 -p 8080
```
Then open <http://localhost:8080/>.

> **Note:** BLE MIDI discovery does not work from plain HTTP on remote IPs; prefer HTTPS for real devices.

## Updating the MIDI Library
1. Drop new `.mid` / `.midi` files anywhere under `assets/midi` (subdirectories are used as categories in the UI).
2. Regenerate the manifest so the frontend can list them:
   ```sh
   python3 generate_midi_manifest.py
   ```
   The script prints how many files were indexed and rewrites `assets/midi_manifest.json`.

Uploaded files during runtime are stored in-memory; if you want them to persist for all users, add them under `assets/midi` and rebuild the manifest.

## Using the Player
1. Load the page and choose **USB MIDI (Web MIDI)** or **Bluetooth LE (Web Bluetooth)**.
2. Click **Connect**:
   - USB: pick the desired MIDI output from the dropdown and grant browser access.
   - BLE: when prompted, select your instrument from the Bluetooth chooser.
3. Browse or search the library, or upload your own MIDI file.
4. Select a song and press **Play** to stream it to the connected instrument. Use **Stop** to send “all notes off” immediately.

Keep the tab in focus while playing for the most accurate timing, and ensure your device remains connected—Web Bluetooth will automatically stop if the GATT connection drops.

## License
No explicit license has been provided. Treat this repository as “all rights reserved” until the project owner specifies otherwise.
