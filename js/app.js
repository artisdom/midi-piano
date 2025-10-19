import { Midi } from "https://esm.sh/@tonejs/midi@2.0.28";

const BLE_MIDI_SERVICE = "03b80e5a-ede8-4b33-a751-6ce34ec4c700";
const BLE_MIDI_CHARACTERISTIC = "7772e5db-3868-4112-a1a9-f2669d106bf3";
const MANIFEST_URL = "assets/midi_manifest.json";

const ui = {
  connectionType: document.getElementById("connection-type"),
  midiOutputField: document.getElementById("midi-output-field"),
  midiOutputSelect: document.getElementById("midi-output-select"),
  connectBtn: document.getElementById("connect-btn"),
  connectionStatus: document.getElementById("connection-status"),
  library: document.getElementById("library"),
  search: document.getElementById("search"),
  refreshLibraryBtn: document.getElementById("refresh-library-btn"),
  fileInput: document.getElementById("file-input"),
  selectedFile: document.getElementById("selected-file"),
  playBtn: document.getElementById("play-btn"),
  stopBtn: document.getElementById("stop-btn"),
  playbackStatus: document.getElementById("playback-status"),
};

const state = {
  manifest: [],
  filteredManifest: [],
  uploads: [],
  selectedEntry: null,
  parsedMidi: null,
  midiAccess: null,
  midiOutput: null,
  bleDevice: null,
  bleCharacteristic: null,
  bleWriteChain: Promise.resolve(),
  player: null,
};

class MidiPlayer {
  constructor(sendFn) {
    this.send = sendFn;
    this.events = [];
    this.duration = 0;
    this.queueIndex = 0;
    this.isPlaying = false;
    this.startTime = 0;
    this.lookAheadMs = 120;
    this.scheduleTickMs = 30;
    this.scheduledTimers = new Set();
    this.activeNotes = new Map();
    this.channelsUsed = new Set();
    this.stateChangeHandler = null;
  }

  load(events, duration) {
    this.stop();
    this.events = events;
    this.duration = duration ?? 0;
    this.queueIndex = 0;
    this.channelsUsed = new Set(
      events
        .map((evt) => evt.channel)
        .filter((channel) => typeof channel === "number")
    );
  }

  play() {
    if (!this.events.length || this.isPlaying) {
      return;
    }
    this.isPlaying = true;
    this.startTime = performance.now() / 1000;
    this.queueIndex = 0;
    this.emitState("started");
    this.loop();
  }

  loop() {
    if (!this.isPlaying) {
      return;
    }
    const now = performance.now() / 1000;
    const elapsed = now - this.startTime;
    const horizon = elapsed + this.lookAheadMs / 1000;

    while (
      this.queueIndex < this.events.length &&
      this.events[this.queueIndex].time <= horizon
    ) {
      const evt = this.events[this.queueIndex];
      this.dispatch(evt);
      this.queueIndex += 1;
    }

    if (this.queueIndex >= this.events.length) {
      const remaining = Math.max(0, this.duration - elapsed);
      this.scheduleTimeout(() => this.stop(true), remaining * 1000 + 200);
    } else {
      this.scheduleTimeout(() => this.loop(), this.scheduleTickMs);
    }
  }

  dispatch(evt) {
    try {
      this.send(evt.message);
    } catch (error) {
      console.error("Failed to send MIDI message", error);
      this.stop();
      return;
    }

    if (evt.type === "noteOn") {
      const key = `${evt.channel}:${evt.note}`;
      this.activeNotes.set(key, evt);
    } else if (evt.type === "noteOff") {
      const key = `${evt.channel}:${evt.note}`;
      this.activeNotes.delete(key);
    }
  }

  stop(completed = false) {
    this.isPlaying = false;
    for (const timer of this.scheduledTimers) {
      clearTimeout(timer);
    }
    this.scheduledTimers.clear();

    if (!completed) {
      this.sendAllNotesOff();
    }
    this.queueIndex = 0;
    this.emitState(completed ? "finished" : "stopped");
  }

  sendAllNotesOff() {
    for (const key of this.activeNotes.keys()) {
      const [channel, note] = key.split(":").map((value) => Number(value));
      const msg = new Uint8Array([0x80 | (channel & 0x0f), note & 0x7f, 0]);
      this.send(msg);
    }
    this.activeNotes.clear();
    for (const channel of this.channelsUsed) {
      const msg = new Uint8Array([0xb0 | (channel & 0x0f), 123, 0]);
      this.send(msg);
    }
  }

  scheduleTimeout(callback, delay) {
    const id = setTimeout(() => {
      this.scheduledTimers.delete(id);
      callback();
    }, delay);
    this.scheduledTimers.add(id);
  }

  setStateChangeHandler(handler) {
    this.stateChangeHandler = handler;
  }

  emitState(state) {
    if (typeof this.stateChangeHandler === "function") {
      try {
        this.stateChangeHandler(state);
      } catch (error) {
        console.error("stateChange handler failed", error);
      }
    }
  }
}

async function init() {
  state.player = new MidiPlayer(sendMessage);
  state.player.setStateChangeHandler((status) => {
    updatePlaybackControls();
    if (status === "started") {
      ui.playbackStatus.textContent = "Playing…";
    } else if (status === "finished") {
      ui.playbackStatus.textContent = "Playback finished.";
    } else if (status === "stopped") {
      ui.playbackStatus.textContent = "Playback stopped.";
    }
  });
  wireUi();
  await loadLibrary();
  updatePlaybackControls();
}

function wireUi() {
  ui.connectionType.addEventListener("change", onConnectionTypeChanged);
  ui.connectBtn.addEventListener("click", onConnectClicked);
  ui.refreshLibraryBtn.addEventListener("click", () => loadLibrary(true));
  ui.search.addEventListener("input", () => filterLibrary(ui.search.value));
  ui.fileInput.addEventListener("change", onFileUpload);
  ui.playBtn.addEventListener("click", () => {
    if (state.player.isPlaying) {
      return;
    }
    state.player.play();
  });
  ui.stopBtn.addEventListener("click", () => {
    state.player.stop();
  });
}

function onConnectionTypeChanged() {
  const type = ui.connectionType.value;
  state.midiOutput = null;
  state.bleCharacteristic = null;
  state.bleDevice = null;
  state.bleWriteChain = Promise.resolve();
  updatePlaybackControls();

  if (type === "midi") {
    ui.midiOutputField.hidden = false;
    ui.connectionStatus.textContent = "Select an available MIDI output.";
    populateMidiOutputs();
  } else {
    ui.midiOutputField.hidden = true;
    ui.connectionStatus.textContent = "Ready to connect to a Bluetooth LE MIDI device.";
  }
}

async function onConnectClicked() {
  const type = ui.connectionType.value;
  if (type === "midi") {
    await connectWebMidi();
  } else {
    await connectBluetooth();
  }
  updatePlaybackControls();
}

async function connectWebMidi() {
  try {
    await ensureMidiAccess();
  } catch (error) {
    console.error(error);
    ui.connectionStatus.textContent =
      "Web MIDI is unavailable. Confirm browser support and HTTPS.";
    return;
  }

  const selected = ui.midiOutputSelect.value;
  if (!selected) {
    ui.connectionStatus.textContent = "Choose a MIDI output first.";
    return;
  }

  const output = state.midiAccess.outputs.get(selected);
  if (!output) {
    ui.connectionStatus.textContent = "Selected MIDI output is no longer available.";
    await populateMidiOutputs();
    return;
  }

  state.midiOutput = output;
  ui.connectionStatus.textContent = `Connected to MIDI output "${output.name}".`;
}

async function connectBluetooth() {
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE_MIDI_SERVICE] }],
      optionalServices: [BLE_MIDI_SERVICE],
    });
    device.addEventListener("gattserverdisconnected", () => {
      state.bleDevice = null;
      state.bleCharacteristic = null;
      state.bleWriteChain = Promise.resolve();
      ui.connectionStatus.textContent = "Bluetooth device disconnected.";
      updatePlaybackControls();
    });

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(BLE_MIDI_SERVICE);
    const characteristic = await service.getCharacteristic(
      BLE_MIDI_CHARACTERISTIC
    );

    state.bleDevice = device;
    state.bleCharacteristic = characteristic;
    state.bleWriteChain = Promise.resolve();
    ui.connectionStatus.textContent = `Connected to Bluetooth device "${device.name ?? "MIDI Device"}".`;
  } catch (error) {
    console.error(error);
    ui.connectionStatus.textContent =
      "Failed to connect over Bluetooth. Ensure the device is discoverable.";
  }
}

async function ensureMidiAccess() {
  if (state.midiAccess) {
    return state.midiAccess;
  }
  if (!navigator.requestMIDIAccess) {
    throw new Error("Web MIDI API is not available.");
  }
  state.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
  state.midiAccess.onstatechange = populateMidiOutputs;
  populateMidiOutputs();
  return state.midiAccess;
}

function populateMidiOutputs() {
  if (!state.midiAccess) {
    ui.midiOutputSelect.innerHTML =
      '<option value="">Web MIDI unavailable</option>';
    return;
  }

  const options = [];
  for (const output of state.midiAccess.outputs.values()) {
    options.push(
      `<option value="${output.id}">${escapeHtml(output.name)}</option>`
    );
  }
  if (!options.length) {
    ui.midiOutputSelect.innerHTML =
      '<option value="">No MIDI outputs detected</option>';
  } else {
    ui.midiOutputSelect.innerHTML =
      '<option value="">Select an output…</option>' + options.join("");
  }
}

async function loadLibrary(force = false) {
  if (!force && state.manifest.length) {
    renderCurrentLibraryView();
    return;
  }

  ui.library.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const response = await fetch(`${MANIFEST_URL}?cacheBust=${Date.now()}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch manifest: ${response.status}`);
    }
    const data = (await response.json()) ?? [];
    state.manifest = data.map((path) => buildEntry("library", path));
    state.filteredManifest = [];
    renderCurrentLibraryView();
  } catch (error) {
    console.error(error);
    ui.library.innerHTML =
      '<div class="empty">Could not load MIDI library. Check console for details.</div>';
  }
}

function filterLibrary(query) {
  const trimmed = query.trim();
  if (!trimmed) {
    state.filteredManifest = [];
    renderLibrary([...state.manifest, ...state.uploads]);
    return;
  }

  const lower = trimmed.toLowerCase();
  state.filteredManifest = [
    ...state.manifest.filter((entry) => entry.searchText.includes(lower)),
    ...state.uploads.filter((entry) => entry.searchText.includes(lower)),
  ];
  renderLibrary(state.filteredManifest);
}

function renderLibrary(entries) {
  const libraryEntries = entries.filter((entry) => entry.source === "library");
  const uploadEntries = entries.filter((entry) => entry.source === "upload");
  const hasLibrary = libraryEntries.length > 0 || state.manifest.length > 0;
  const hasUploads = uploadEntries.length > 0 || state.uploads.length > 0;

  if (!entries.length) {
    const emptyText = hasLibrary
      ? "No songs match your search."
      : "No MIDI files available yet.";
    ui.library.innerHTML = `<div class="empty">${emptyText}</div>`;
    return;
  }

  const list = document.createElement("div");
  list.className = "library-content";

  if (hasLibrary) {
    const section = document.createElement("div");
    section.className = "library-section";
    section.appendChild(sectionHeading("Built-in library"));
    const items =
      libraryEntries.length > 0 ? libraryEntries : state.manifest;
    section.appendChild(buildList(items));
    list.appendChild(section);
  }

  if (hasUploads) {
    const section = document.createElement("div");
    section.className = "library-section";
    section.appendChild(sectionHeading("Uploads"));
    const items =
      uploadEntries.length > 0 ? uploadEntries : state.uploads;
    section.appendChild(buildList(items));
    list.appendChild(section);
  }

  ui.library.innerHTML = "";
  ui.library.appendChild(list);
}

function renderCurrentLibraryView() {
  const query = ui.search.value.trim();
  if (query) {
    filterLibrary(query);
  } else {
    renderLibrary([...state.manifest, ...state.uploads]);
  }
}

function sectionHeading(title) {
  const div = document.createElement("div");
  div.className = "section-title";
  div.textContent = title;
  return div;
}

function buildList(entries) {
  const ul = document.createElement("ul");
  if (!entries.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No files.";
    ul.appendChild(empty);
    return ul;
  }

  for (const entry of entries) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.entryId = entry.id;
    button.innerHTML = `<strong>${escapeHtml(entry.title)}</strong><br /><span>${escapeHtml(entry.folder || "Root")}</span>`;

    if (state.selectedEntry?.id === entry.id) {
      button.classList.add("active");
    }

    button.addEventListener("click", () => {
      selectEntry(entry);
    });

    li.appendChild(button);
    ul.appendChild(li);
  }
  return ul;
}

function buildEntry(source, pathOrFile) {
  if (source === "library") {
    const parts = pathOrFile.split("/");
    const title = parts.pop() ?? pathOrFile;
    const folder = parts.join(" ▸ ");
    return {
      id: `library:${pathOrFile}`,
      source,
      path: pathOrFile,
      title,
      folder,
      searchText: `${pathOrFile}`.toLowerCase(),
    };
  }

  const file = pathOrFile;
  return {
    id: `upload:${file.name}:${file.lastModified}`,
    source,
    file,
    title: file.name,
    folder: "Uploads",
    searchText: file.name.toLowerCase(),
  };
}

function onFileUpload(event) {
  const files = Array.from(event.target.files ?? []);
  if (!files.length) {
    return;
  }
  const newUploads = files.map((file) => buildEntry("upload", file));
  state.uploads.push(...newUploads);
  event.target.value = "";
  renderCurrentLibraryView();
}

async function selectEntry(entry) {
  if (state.player.isPlaying) {
    state.player.stop();
  }

  state.selectedEntry = entry;
  updateSelectedFile(`Loading "${entry.title}"…`);
  updatePlaybackControls();

  try {
    const { midi, events, metadata } = await loadEntryData(entry);
    state.parsedMidi = { midi, events, metadata };
    state.player.load(events, metadata.durationSeconds);
    updateSelectedFile(describeSelection(entry, metadata));
    ui.playbackStatus.textContent = "Ready to play.";
    updatePlaybackControls();
  } catch (error) {
    console.error(error);
    ui.playbackStatus.textContent =
      "Failed to parse MIDI file. See console for details.";
    updateSelectedFile("No MIDI file selected.");
    state.parsedMidi = null;
    state.selectedEntry = null;
    updatePlaybackControls();
  }

  renderCurrentLibraryView(); // Refresh highlight
}

async function loadEntryData(entry) {
  if (entry.source === "library") {
    const encodedPath = entry.path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const response = await fetch(`assets/midi/${encodedPath}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch MIDI at ${entry.path}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return parseMidiBuffer(arrayBuffer, entry);
  } else if (entry.source === "upload") {
    const arrayBuffer = await entry.file.arrayBuffer();
    return parseMidiBuffer(arrayBuffer, entry);
  }
  throw new Error(`Unknown entry source: ${entry.source}`);
}

function parseMidiBuffer(buffer, entry) {
  const midi = new Midi(buffer);
  const events = buildEventSchedule(midi);
  const metadata = {
    durationSeconds: midi.duration,
    bpm: midi.header.tempos.length
      ? Math.round(midi.header.tempos[0].bpm)
      : midi.header.tempos?.[0]?.bpm ?? 120,
    timeSignatures: midi.header.timeSignatures.map(
      (signature) => `${signature[0]}/${signature[1]}`
    ),
    tracks: midi.tracks.length,
    instrumentNames: midi.tracks
      .map((track) => track.instrument?.name)
      .filter(Boolean),
  };
  return { midi, events, metadata };
}

function buildEventSchedule(midi) {
  const events = [];

  midi.tracks.forEach((track, trackIndex) => {
    const channel = sanitizeChannel(track.channel ?? track.instrument?.channel);
    if (channel == null) {
      // Fallback to track index but clamp to 0-15
      track.channel = trackIndex % 16;
    }
    const resolvedChannel = sanitizeChannel(
      track.channel ?? trackIndex % 16 ?? 0
    );

    if (Number.isInteger(track.instrument?.number) && !track.instrument.percussion) {
      events.push({
        time: 0,
        message: new Uint8Array([
          0xc0 | resolvedChannel,
          track.instrument.number & 0x7f,
        ]),
        type: "programChange",
        channel: resolvedChannel,
      });
    }

    if (track.controlChanges) {
      Object.entries(track.controlChanges).forEach(([cc, ccEvents]) => {
        ccEvents.forEach((ccEvent) => {
          const value = normaliseMidiValue(ccEvent.value);
          events.push({
            time: ccEvent.time,
            message: new Uint8Array([
              0xb0 | resolvedChannel,
              Number(cc) & 0x7f,
              value,
            ]),
            type: "controlChange",
            channel: resolvedChannel,
          });
        });
      });
    }

    if (Array.isArray(track.pitchBends)) {
      track.pitchBends.forEach((pb) => {
        const value14 = normalisePitchBend(pb.value);
        events.push({
          time: pb.time,
          message: new Uint8Array([
            0xe0 | resolvedChannel,
            value14 & 0x7f,
            (value14 >> 7) & 0x7f,
          ]),
          type: "pitchBend",
          channel: resolvedChannel,
        });
      });
    }

    track.notes.forEach((note) => {
      const velocity = normaliseVelocity(note.velocity);
      const noteOn = new Uint8Array([
        0x90 | resolvedChannel,
        note.midi & 0x7f,
        velocity,
      ]);
      events.push({
        time: note.time,
        message: noteOn,
        type: "noteOn",
        channel: resolvedChannel,
        note: note.midi & 0x7f,
      });

      const offVelocity = normaliseReleaseVelocity(note.noteOffVelocity);
      const noteOff = new Uint8Array([
        0x80 | resolvedChannel,
        note.midi & 0x7f,
        offVelocity,
      ]);
      events.push({
        time: note.time + note.duration,
        message: noteOff,
        type: "noteOff",
        channel: resolvedChannel,
        note: note.midi & 0x7f,
      });
    });
  });

  events.sort((a, b) => a.time - b.time);
  return events;
}

function sanitizeChannel(channel) {
  if (channel == null || Number.isNaN(channel)) {
    return null;
  }
  const value = Number(channel);
  if (value >= 0 && value <= 15) {
    return value;
  }
  if (value >= 1 && value <= 16) {
    return value - 1;
  }
  return null;
}

function normaliseMidiValue(value) {
  if (value == null) {
    return 0;
  }
  if (value > 1.01) {
    return clamp(Math.round(value), 0, 127);
  }
  return clamp(Math.round(value * 127), 0, 127);
}

function normaliseVelocity(value) {
  if (value == null) {
    return 100;
  }
  if (value > 1.01) {
    return clamp(Math.round(value), 1, 127);
  }
  return clamp(Math.round(Math.max(0.3, value) * 127), 1, 127);
}

function normaliseReleaseVelocity(value) {
  if (value == null) {
    return 0;
  }
  if (value > 1.01) {
    return clamp(Math.round(value), 0, 127);
  }
  return clamp(Math.round(value * 127), 0, 127);
}

function normalisePitchBend(value) {
  const v = clamp(value ?? 0, -1, 1);
  const scaled = Math.round((v + 1) * 8191.5);
  return clamp(scaled, 0, 16383);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function describeSelection(entry, metadata) {
  const duration = formatDuration(metadata.durationSeconds);
  const tracks = metadata.tracks;
  const instruments = metadata.instrumentNames.length
    ? ` • Instruments: ${metadata.instrumentNames.join(", ")}`
    : "";
  return `${entry.title} — ${duration} • ${tracks} track(s)${instruments}`;
}

function updateSelectedFile(text) {
  ui.selectedFile.textContent = text;
}

function updatePlaybackControls() {
  const hasDevice =
    (ui.connectionType.value === "midi" && state.midiOutput) ||
    (ui.connectionType.value === "ble" && state.bleCharacteristic);
  const hasMidi = !!state.parsedMidi;
  ui.playBtn.disabled = !(hasDevice && hasMidi) || state.player.isPlaying;
  ui.stopBtn.disabled = !state.player.isPlaying;
}

function sendMessage(message) {
  if (ui.connectionType.value === "midi" && state.midiOutput) {
    state.midiOutput.send(message);
  } else if (ui.connectionType.value === "ble" && state.bleCharacteristic) {
    const packet = new Uint8Array(message.length + 1);
    packet[0] = 0x80;
    packet.set(message, 1);
    const base = state.bleWriteChain ?? Promise.resolve();
    state.bleWriteChain = base
      .catch((error) => {
        console.warn("Resetting BLE write queue after error", error);
      })
      .then(() => state.bleCharacteristic.writeValueWithoutResponse(packet));
    state.bleWriteChain.catch((error) => {
      console.error("BLE write failed", error);
    });
  } else {
    throw new Error("No MIDI destination available.");
  }
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) {
    return "Unknown duration";
  }
  const total = Math.round(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

init().catch((error) => {
  console.error("Failed to initialise app", error);
  ui.playbackStatus.textContent =
    "Could not start the app. Check console for details.";
});
