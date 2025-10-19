import { Midi } from "https://esm.sh/@tonejs/midi@2.0.28";

const BLE_MIDI_SERVICE = "03b80e5a-ede8-4b33-a751-6ce34ec4c700";
const BLE_MIDI_CHARACTERISTIC = "7772e5db-3868-4112-a1a9-f2669d106bf3";
const MANIFEST_URL = "assets/midi_manifest.json";
const STORAGE_KEYS = {
  ratings: "midiPlayer:ratings",
  favorites: "midiPlayer:favorites",
  playlists: "midiPlayer:playlists",
};
const MAX_RANDOM_PLAYLIST = 50;
const CREATE_PLAYLIST_LABEL = "Create from selected";

const ui = {
  connectionType: document.getElementById("connection-type"),
  midiOutputField: document.getElementById("midi-output-field"),
  midiOutputSelect: document.getElementById("midi-output-select"),
  connectBtn: document.getElementById("connect-btn"),
  connectionStatus: document.getElementById("connection-status"),
  search: document.getElementById("search"),
  refreshLibraryBtn: document.getElementById("refresh-library-btn"),
  fileInput: document.getElementById("file-input"),
  selectedFile: document.getElementById("selected-file"),
  playBtn: document.getElementById("play-btn"),
  stopBtn: document.getElementById("stop-btn"),
  playbackStatus: document.getElementById("playback-status"),
  libraryTree: document.getElementById("library-tree"),
  searchResults: document.getElementById("search-results"),
  uploadList: document.getElementById("upload-list"),
  expandLibraryBtn: document.getElementById("expand-library-btn"),
  collapseLibraryBtn: document.getElementById("collapse-library-btn"),
  favoritesList: document.getElementById("favorites-list"),
  playlistNameInput: document.getElementById("playlist-name-input"),
  createPlaylistBtn: document.getElementById("create-playlist-btn"),
  randomPlaylistBtn: document.getElementById("random-playlist-btn"),
  playlistList: document.getElementById("playlist-list"),
  playlistDetail: document.getElementById("playlist-detail"),
  ratingStars: document.getElementById("rating-stars"),
  clearRatingBtn: document.getElementById("clear-rating-btn"),
  favoriteBtn: document.getElementById("favorite-btn"),
};

const state = {
  manifest: [],
  filteredManifest: [],
  libraryTree: null,
  uploads: [],
  selectedEntry: null,
  parsedMidi: null,
  midiAccess: null,
  midiOutput: null,
  bleDevice: null,
  bleCharacteristic: null,
  bleWriteChain: Promise.resolve(),
  player: null,
  ratings: {},
  favorites: new Set(),
  playlists: [],
  playlistCounter: 0,
  entryIndex: new Map(),
  libraryExpanded: new Set(["root"]),
  searchQuery: "",
  selectedForPlaylist: new Set(),
  activePlaylistId: null,
};

function loadPersistedState() {
  try {
    const rawRatings = localStorage.getItem(STORAGE_KEYS.ratings);
    if (rawRatings) {
      const parsed = JSON.parse(rawRatings);
      if (parsed && typeof parsed === "object") {
        state.ratings = parsed;
      }
    }
  } catch (error) {
    console.warn("Failed to load ratings", error);
  }

  try {
    const rawFavorites = localStorage.getItem(STORAGE_KEYS.favorites);
    if (rawFavorites) {
      const parsed = JSON.parse(rawFavorites);
      if (Array.isArray(parsed)) {
        state.favorites = new Set(parsed);
      }
    }
  } catch (error) {
    console.warn("Failed to load favorites", error);
  }

  try {
    const rawPlaylists = localStorage.getItem(STORAGE_KEYS.playlists);
    if (rawPlaylists) {
      const parsed = JSON.parse(rawPlaylists);
      if (Array.isArray(parsed)) {
        state.playlists = parsed
          .filter(
            (playlist) =>
              playlist &&
              typeof playlist.id === "string" &&
              typeof playlist.name === "string" &&
              Array.isArray(playlist.entries)
          )
          .map((playlist) => ({
            id: playlist.id,
            name: playlist.name,
            entries: playlist.entries.map(String),
            createdAt: playlist.createdAt ?? Date.now(),
          }));
      }
    }
    const maxId = state.playlists
      .map((playlist) => {
        const match = playlist.id.match(/pl-(\d+)/);
        return match ? Number(match[1]) : 0;
      })
      .reduce((max, value) => Math.max(max, value), 0);
    state.playlistCounter = maxId;
  } catch (error) {
    console.warn("Failed to load playlists", error);
  }
}

function persistRatings() {
  try {
    localStorage.setItem(STORAGE_KEYS.ratings, JSON.stringify(state.ratings));
  } catch (error) {
    console.warn("Failed to persist ratings", error);
  }
}

function persistFavorites() {
  try {
    localStorage.setItem(
      STORAGE_KEYS.favorites,
      JSON.stringify(Array.from(state.favorites))
    );
  } catch (error) {
    console.warn("Failed to persist favorites", error);
  }
}

function persistPlaylists() {
  try {
    const payload = state.playlists.map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      entries: playlist.entries,
      createdAt: playlist.createdAt,
    }));
    localStorage.setItem(STORAGE_KEYS.playlists, JSON.stringify(payload));
  } catch (error) {
    console.warn("Failed to persist playlists", error);
  }
}

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
  loadPersistedState();
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

  ui.expandLibraryBtn?.addEventListener("click", () => expandOrCollapseLibrary(true));
  ui.collapseLibraryBtn?.addEventListener("click", () => expandOrCollapseLibrary(false));

  if (ui.ratingStars) {
    ui.ratingButtons = Array.from(
      ui.ratingStars.querySelectorAll("button.star")
    );
    ui.ratingButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const rating = Number(button.dataset.rating);
        if (!state.selectedEntry) {
          return;
        }
        setRating(state.selectedEntry.id, rating);
      });
    });
  }

  ui.clearRatingBtn?.addEventListener("click", () => {
    if (!state.selectedEntry) {
      return;
    }
    setRating(state.selectedEntry.id, 0);
  });

  ui.favoriteBtn?.addEventListener("click", () => {
    if (!state.selectedEntry) {
      return;
    }
    toggleFavorite(state.selectedEntry.id);
  });

  ui.playlistNameInput?.addEventListener("input", updatePlaylistControls);
  ui.createPlaylistBtn?.addEventListener("click", (event) => {
    event.preventDefault();
    createPlaylistFromSelection();
  });
  ui.randomPlaylistBtn?.addEventListener("click", (event) => {
    event.preventDefault();
    createRandomPlaylist();
  });

  updatePlaylistControls();
  updateRatingUI();
  updateFavoriteButton();
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

  if (ui.libraryTree) {
    ui.libraryTree.innerHTML = '<div class="empty">Loading…</div>';
  }
  if (ui.searchResults) {
    ui.searchResults.innerHTML = '<div class="empty">Loading library…</div>';
  }
  try {
    const response = await fetch(`${MANIFEST_URL}?cacheBust=${Date.now()}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch manifest: ${response.status}`);
    }
    const data = (await response.json()) ?? [];
    unregisterEntriesWithPrefix("library:");
    state.manifest = data.map((path) => buildEntry("library", path));
    state.libraryTree = buildLibraryTree(state.manifest);
    state.libraryExpanded = new Set(["root"]);
    state.filteredManifest = [];
    renderCurrentLibraryView();
    if (state.searchQuery) {
      filterLibrary(state.searchQuery);
    }
    renderPlaylistList();
    renderPlaylistDetail();
  } catch (error) {
    console.error(error);
    ui.libraryTree.innerHTML =
      '<div class="empty">Unable to load library.</div>';
    ui.searchResults.innerHTML =
      '<div class="empty">Could not load MIDI library. Check console for details.</div>';
  }
}

function filterLibrary(query) {
  const trimmed = query.trim();
  state.searchQuery = trimmed;
  if (!trimmed) {
    state.filteredManifest = [];
  } else {
    const lower = trimmed.toLowerCase();
    const pool = [...state.manifest, ...state.uploads];
    state.filteredManifest = pool.filter((entry) =>
      entry.searchText.includes(lower)
    );
  }
  renderSearchResults();
}

function renderCurrentLibraryView() {
  renderLibraryTree();
  renderUploadsList();
  renderSearchResults();
  renderFavoritesList();
  updatePlaylistControls();
}

function renderLibraryTree() {
  const container = ui.libraryTree;
  if (!container) {
    return;
  }
  if (!state.libraryTree || !state.libraryTree.children.length) {
    container.innerHTML = '<div class="empty">No MIDI files found.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  state.libraryTree.children.forEach((child) => {
    fragment.appendChild(createTreeBranch(child, 1));
  });
  container.innerHTML = "";
  container.appendChild(fragment);
}

function createTreeBranch(node, depth) {
  return node.type === "folder"
    ? createFolderBranch(node, depth)
    : createFileNode(node, depth);
}

function createFolderBranch(node, depth) {
  const wrapper = document.createElement("div");
  wrapper.className = "tree-branch";

  const treeNode = document.createElement("div");
  treeNode.className = "tree-node folder";
  treeNode.dataset.nodeId = node.id;
  treeNode.setAttribute("role", "treeitem");
  treeNode.setAttribute("aria-level", String(depth));

  const isExpanded = state.libraryExpanded.has(node.id);
  treeNode.setAttribute("aria-expanded", String(isExpanded));

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "tree-toggle";
  toggle.innerHTML = isExpanded ? "▾" : "▸";
  toggle.addEventListener("click", () => toggleFolder(node.id));
  treeNode.appendChild(toggle);

  const label = document.createElement("button");
  label.type = "button";
  label.className = "tree-label";
  label.textContent = node.name || "(Folder)";
  label.addEventListener("click", () => toggleFolder(node.id));
  treeNode.appendChild(label);

  wrapper.appendChild(treeNode);

  if (isExpanded && node.children.length) {
    const childrenContainer = document.createElement("div");
    childrenContainer.className = "tree-children";
    childrenContainer.setAttribute("role", "group");
    node.children.forEach((child) => {
      childrenContainer.appendChild(createTreeBranch(child, depth + 1));
    });
    wrapper.appendChild(childrenContainer);
  }

  return wrapper;
}

function createFileNode(node, depth) {
  const treeNode = document.createElement("div");
  treeNode.className = "tree-node file";
  treeNode.dataset.entryId = node.entryId;
  treeNode.setAttribute("role", "treeitem");
  treeNode.setAttribute("aria-level", String(depth));

  if (state.selectedEntry?.id === node.entryId) {
    treeNode.classList.add("active");
  }

  const checkboxLabel = document.createElement("label");
  checkboxLabel.className = "tree-checkbox";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.setAttribute("aria-label", "Select for playlist");
  checkbox.checked = state.selectedForPlaylist.has(node.entryId);
  checkbox.addEventListener("change", (event) =>
    onEntrySelectionChanged(node.entryId, event.target.checked)
  );
  checkboxLabel.appendChild(checkbox);
  treeNode.appendChild(checkboxLabel);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "tree-label";
  button.textContent = node.name;
  button.addEventListener("click", () => selectEntry(node.entry));
  treeNode.appendChild(button);

  const rating = getRating(node.entryId);
  if (rating > 0) {
    const badge = document.createElement("span");
    badge.className = "results-meta";
    badge.textContent = "★".repeat(rating);
    treeNode.appendChild(badge);
  }

  return treeNode;
}

function toggleFolder(folderId) {
  if (state.libraryExpanded.has(folderId)) {
    if (folderId !== "root") {
      state.libraryExpanded.delete(folderId);
    }
  } else {
    state.libraryExpanded.add(folderId);
  }
  renderLibraryTree();
}

function expandOrCollapseLibrary(expand) {
  if (!state.libraryTree) {
    return;
  }
  if (expand) {
    const ids = new Set();
    collectFolderIds(state.libraryTree, ids);
    state.libraryExpanded = ids;
  } else {
    state.libraryExpanded = new Set(["root"]);
  }
  renderLibraryTree();
}

function collectFolderIds(node, set) {
  if (node.type === "folder") {
    set.add(node.id);
    node.children.forEach((child) => collectFolderIds(child, set));
  }
}

function renderUploadsList() {
  const container = ui.uploadList;
  if (!container) {
    return;
  }
  if (!state.uploads.length) {
    container.innerHTML = '<div class="empty">No uploads yet.</div>';
    return;
  }

  const ul = document.createElement("ul");
  state.uploads.forEach((entry) => {
    ul.appendChild(
      createSelectableListItem(entry, { showFolder: false, selectable: true })
    );
  });
  container.innerHTML = "";
  container.appendChild(ul);
}

function renderSearchResults() {
  const container = ui.searchResults;
  if (!container) {
    return;
  }
  if (!state.libraryTree) {
    container.innerHTML = '<div class="empty">Loading library…</div>';
    return;
  }

  if (!state.searchQuery) {
    container.innerHTML =
      '<div class="empty">Enter a search term to filter songs.</div>';
    return;
  }

  if (!state.filteredManifest.length) {
    container.innerHTML = `<div class="empty">No songs matched “${escapeHtml(
      state.searchQuery
    )}”.</div>`;
    return;
  }

  const ul = document.createElement("ul");
  state.filteredManifest.forEach((entry) => {
    ul.appendChild(
      createSelectableListItem(entry, { showFolder: true, selectable: true })
    );
  });
  container.innerHTML = "";
  container.appendChild(ul);
}

function renderFavoritesList() {
  const container = ui.favoritesList;
  if (!container) {
    return;
  }
  const missing = [];
  const favorites = [];
  state.favorites.forEach((id) => {
    const entry = getEntryById(id);
    if (entry) {
      favorites.push(entry);
    } else {
      missing.push(id);
    }
  });

  if (missing.length) {
    missing.forEach((id) => state.favorites.delete(id));
    persistFavorites();
  }

  if (!favorites.length) {
    container.innerHTML = '<div class="empty">No favorites yet.</div>';
    return;
  }

  favorites.sort((a, b) => {
    const ratingDiff = getRating(b.id) - getRating(a.id);
    if (ratingDiff !== 0) {
      return ratingDiff;
    }
    return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  });

  const ul = document.createElement("ul");
  favorites.forEach((entry) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.innerHTML = `<strong>${escapeHtml(entry.title)}</strong><br /><span>${escapeHtml(
      entry.folder || ""
    )}</span>`;
    if (state.selectedEntry?.id === entry.id) {
      button.classList.add("active");
    }
    button.addEventListener("click", () => selectEntry(entry));
    li.appendChild(button);
    ul.appendChild(li);
  });
  container.innerHTML = "";
  container.appendChild(ul);
}

function createSelectableListItem(entry, options = {}) {
  const { showFolder = true, selectable = true } = options;
  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "result-item";

  if (selectable) {
    const checkboxLabel = document.createElement("label");
    checkboxLabel.className = "tree-checkbox";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.setAttribute("aria-label", "Select for playlist");
    checkbox.checked = state.selectedForPlaylist.has(entry.id);
    checkbox.addEventListener("change", (event) =>
      onEntrySelectionChanged(entry.id, event.target.checked)
    );
    checkboxLabel.appendChild(checkbox);
    row.appendChild(checkboxLabel);
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "result-button";
  button.innerHTML = `<strong>${escapeHtml(entry.title)}</strong>${
    showFolder && entry.folder
      ? `<br /><span class="results-meta">${escapeHtml(entry.folder)}</span>`
      : ""
  }`;
  if (state.selectedEntry?.id === entry.id) {
    button.classList.add("active");
  }
  button.addEventListener("click", () => selectEntry(entry));
  row.appendChild(button);

  const rating = getRating(entry.id);
  if (rating > 0) {
    const badge = document.createElement("span");
    badge.className = "results-meta";
    badge.textContent = "★".repeat(rating);
    row.appendChild(badge);
  }

  li.appendChild(row);
  return li;
}

function onEntrySelectionChanged(entryId, selected) {
  if (selected) {
    state.selectedForPlaylist.add(entryId);
  } else {
    state.selectedForPlaylist.delete(entryId);
  }
  updatePlaylistControls();
  renderPlaylistDetail();
}

function clearSelectedForPlaylist() {
  state.selectedForPlaylist.clear();
  renderLibraryTree();
  renderUploadsList();
  renderSearchResults();
  updatePlaylistControls();
  renderPlaylistDetail();
}

function updatePlaylistControls() {
  const selectionCount = state.selectedForPlaylist.size;
  if (ui.createPlaylistBtn) {
    ui.createPlaylistBtn.disabled = selectionCount === 0;
    ui.createPlaylistBtn.textContent =
      selectionCount === 0
        ? CREATE_PLAYLIST_LABEL
        : `${CREATE_PLAYLIST_LABEL} (${selectionCount})`;
  }

  if (ui.randomPlaylistBtn) {
    const total = state.manifest.length + state.uploads.length;
    ui.randomPlaylistBtn.disabled = total === 0;
  }
}

function getRating(entryId) {
  return Number(state.ratings[entryId] ?? 0);
}

function setRating(entryId, rating) {
  const clamped = Math.max(0, Math.min(5, Math.round(rating)));
  if (clamped <= 0) {
    delete state.ratings[entryId];
  } else {
    state.ratings[entryId] = clamped;
  }
  persistRatings();
  updateRatingUI();
  renderLibraryTree();
  renderUploadsList();
  renderSearchResults();
  renderFavoritesList();
  renderPlaylistDetail();
}

function updateRatingUI() {
  if (!ui.ratingButtons) {
    return;
  }
  const entryId = state.selectedEntry?.id;
  const rating = entryId ? getRating(entryId) : 0;
  ui.ratingButtons.forEach((button) => {
    const value = Number(button.dataset.rating);
    button.disabled = !entryId;
    const active = Boolean(entryId) && value <= rating;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  if (ui.clearRatingBtn) {
    ui.clearRatingBtn.disabled = !entryId || rating === 0;
  }
}

function toggleFavorite(entryId) {
  if (state.favorites.has(entryId)) {
    state.favorites.delete(entryId);
  } else {
    state.favorites.add(entryId);
  }
  persistFavorites();
  updateFavoriteButton();
  renderFavoritesList();
}

function updateFavoriteButton() {
  if (!ui.favoriteBtn) {
    return;
  }
  const entryId = state.selectedEntry?.id;
  const isFavorite = entryId ? state.favorites.has(entryId) : false;
  ui.favoriteBtn.disabled = !entryId;
  ui.favoriteBtn.classList.toggle("active", isFavorite);
  ui.favoriteBtn.textContent = isFavorite ? "Remove favorite" : "Add to favorites";
}

function createPlaylistFromSelection() {
  const ids = Array.from(state.selectedForPlaylist).filter((id) =>
    Boolean(getEntryById(id))
  );
  if (!ids.length) {
    return;
  }
  const nameInput = ui.playlistNameInput?.value.trim();
  state.playlistCounter += 1;
  const playlist = {
    id: `pl-${state.playlistCounter}`,
    name: nameInput || `Playlist ${state.playlistCounter}`,
    entries: ids.slice(),
    createdAt: Date.now(),
  };
  state.playlists.push(playlist);
  persistPlaylists();
  if (ui.playlistNameInput) {
    ui.playlistNameInput.value = "";
  }
  clearSelectedForPlaylist();
  setActivePlaylist(playlist.id);
}

function createRandomPlaylist() {
  const pool = getAllEntries();
  if (!pool.length) {
    return;
  }
  const count = Math.min(MAX_RANDOM_PLAYLIST, pool.length);
  const randomEntries = pickRandomEntries(pool, count);
  state.playlistCounter += 1;
  const playlist = {
    id: `pl-${state.playlistCounter}`,
    name: `Random ${count}`,
    entries: randomEntries.map((entry) => entry.id),
    createdAt: Date.now(),
  };
  state.playlists.push(playlist);
  persistPlaylists();
  setActivePlaylist(playlist.id);
}

function renderPlaylistList() {
  const container = ui.playlistList;
  if (!container) {
    return;
  }

  if (!state.playlists.length) {
    state.activePlaylistId = null;
    container.innerHTML = '<div class="empty">No playlists yet.</div>';
    if (ui.playlistDetail) {
      ui.playlistDetail.innerHTML = "Select a playlist to view its songs.";
    }
    return;
  }

  if (
    !state.activePlaylistId ||
    !state.playlists.some((playlist) => playlist.id === state.activePlaylistId)
  ) {
    state.activePlaylistId = state.playlists[0].id;
  }

  const ul = document.createElement("ul");
  state.playlists.forEach((playlist) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${playlist.name} (${playlist.entries.length})`;
    if (playlist.id === state.activePlaylistId) {
      button.classList.add("active");
    }
    button.addEventListener("click", () => {
      if (state.activePlaylistId !== playlist.id) {
        state.activePlaylistId = playlist.id;
        renderPlaylistList();
        renderPlaylistDetail();
      }
    });
    li.appendChild(button);
    ul.appendChild(li);
  });
  container.innerHTML = "";
  container.appendChild(ul);
}

function setActivePlaylist(playlistId) {
  state.activePlaylistId = playlistId;
  renderPlaylistList();
  renderPlaylistDetail();
}

function renderPlaylistDetail() {
  const container = ui.playlistDetail;
  if (!container) {
    return;
  }
  const playlist = getPlaylistById(state.activePlaylistId);
  if (!playlist) {
    container.innerHTML = "Select a playlist to view its songs.";
    return;
  }

  const entries = playlist.entries
    .map((id) => getEntryById(id))
    .filter(Boolean);
  if (entries.length !== playlist.entries.length) {
    playlist.entries = entries.map((entry) => entry.id);
    persistPlaylists();
    renderPlaylistList();
  }

  const wrapper = document.createElement("div");

  const header = document.createElement("div");
  header.className = "playlist-detail-header";
  const title = document.createElement("h3");
  title.textContent = `${playlist.name} (${playlist.entries.length})`;
  header.appendChild(title);

  const actions = document.createElement("div");
  actions.className = "playlist-actions";

  const renameBtn = document.createElement("button");
  renameBtn.type = "button";
  renameBtn.className = "tiny secondary";
  renameBtn.textContent = "Rename";
  renameBtn.addEventListener("click", () => renamePlaylist(playlist.id));
  actions.appendChild(renameBtn);

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "tiny secondary";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", () => deletePlaylist(playlist.id));
  actions.appendChild(deleteBtn);

  const addCurrentBtn = document.createElement("button");
  addCurrentBtn.type = "button";
  addCurrentBtn.className = "tiny secondary";
  addCurrentBtn.textContent = "Add current";
  addCurrentBtn.disabled = !state.selectedEntry;
  addCurrentBtn.addEventListener("click", () => {
    if (state.selectedEntry) {
      addEntriesToPlaylist(playlist.id, [state.selectedEntry.id]);
    }
  });
  actions.appendChild(addCurrentBtn);

  const addSelectionBtn = document.createElement("button");
  addSelectionBtn.type = "button";
  addSelectionBtn.className = "tiny secondary";
  addSelectionBtn.textContent = "Add selected";
  addSelectionBtn.disabled = state.selectedForPlaylist.size === 0;
  addSelectionBtn.addEventListener("click", () => {
    if (!state.selectedForPlaylist.size) {
      return;
    }
    addEntriesToPlaylist(
      playlist.id,
      Array.from(state.selectedForPlaylist.values())
    );
    clearSelectedForPlaylist();
  });
  actions.appendChild(addSelectionBtn);

  header.appendChild(actions);
  wrapper.appendChild(header);

  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No songs in this playlist yet.";
    wrapper.appendChild(empty);
  } else {
    const ul = document.createElement("ul");
    entries.forEach((entry, index) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "playlist-entry";
      button.textContent = entry.title;
      if (state.selectedEntry?.id === entry.id) {
        button.classList.add("active");
      }
      button.addEventListener("click", () => selectEntry(entry));
      li.appendChild(button);

      const controls = document.createElement("div");
      controls.className = "playlist-actions";

      const upBtn = document.createElement("button");
      upBtn.type = "button";
      upBtn.className = "tiny secondary";
      upBtn.textContent = "↑";
      upBtn.disabled = index === 0;
      upBtn.addEventListener("click", () =>
        movePlaylistEntry(playlist.id, entry.id, -1)
      );
      controls.appendChild(upBtn);

      const downBtn = document.createElement("button");
      downBtn.type = "button";
      downBtn.className = "tiny secondary";
      downBtn.textContent = "↓";
      downBtn.disabled = index === entries.length - 1;
      downBtn.addEventListener("click", () =>
        movePlaylistEntry(playlist.id, entry.id, 1)
      );
      controls.appendChild(downBtn);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "tiny secondary";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", () =>
        removeFromPlaylist(playlist.id, entry.id)
      );
      controls.appendChild(removeBtn);

      li.appendChild(controls);
      ul.appendChild(li);
    });
    wrapper.appendChild(ul);
  }

  container.innerHTML = "";
  container.appendChild(wrapper);
}

function renamePlaylist(playlistId) {
  const playlist = getPlaylistById(playlistId);
  if (!playlist) {
    return;
  }
  const newName = window.prompt("Rename playlist", playlist.name);
  if (newName && newName.trim() && newName.trim() !== playlist.name) {
    playlist.name = newName.trim();
    persistPlaylists();
    renderPlaylistList();
    renderPlaylistDetail();
  }
}

function deletePlaylist(playlistId) {
  const index = state.playlists.findIndex((playlist) => playlist.id === playlistId);
  if (index === -1) {
    return;
  }
  const confirmed = window.confirm("Delete this playlist?");
  if (!confirmed) {
    return;
  }
  state.playlists.splice(index, 1);
  persistPlaylists();
  if (state.activePlaylistId === playlistId) {
    state.activePlaylistId = state.playlists[0]?.id ?? null;
  }
  renderPlaylistList();
  renderPlaylistDetail();
}

function addEntriesToPlaylist(playlistId, entryIds) {
  const playlist = getPlaylistById(playlistId);
  if (!playlist || !Array.isArray(entryIds)) {
    return;
  }
  const unique = new Set(playlist.entries);
  let added = false;
  entryIds.forEach((id) => {
    if (!getEntryById(id)) {
      return;
    }
    if (!unique.has(id)) {
      unique.add(id);
      playlist.entries.push(id);
      added = true;
    }
  });
  if (added) {
    persistPlaylists();
    renderPlaylistList();
    renderPlaylistDetail();
  }
}

function movePlaylistEntry(playlistId, entryId, delta) {
  const playlist = getPlaylistById(playlistId);
  if (!playlist) {
    return;
  }
  const index = playlist.entries.indexOf(entryId);
  if (index === -1) {
    return;
  }
  const target = index + delta;
  if (target < 0 || target >= playlist.entries.length) {
    return;
  }
  const [item] = playlist.entries.splice(index, 1);
  playlist.entries.splice(target, 0, item);
  persistPlaylists();
  renderPlaylistDetail();
}

function removeFromPlaylist(playlistId, entryId) {
  const playlist = getPlaylistById(playlistId);
  if (!playlist) {
    return;
  }
  const index = playlist.entries.indexOf(entryId);
  if (index === -1) {
    return;
  }
  playlist.entries.splice(index, 1);
  persistPlaylists();
  renderPlaylistList();
  renderPlaylistDetail();
}

function getPlaylistById(id) {
  if (!id) {
    return null;
  }
  return state.playlists.find((playlist) => playlist.id === id) ?? null;
}

function getAllEntries() {
  return [...state.manifest, ...state.uploads];
}

function pickRandomEntries(entries, count) {
  const pool = entries.slice();
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

function buildEntry(source, pathOrFile) {
  if (source === "library") {
    const parts = pathOrFile.split("/");
    const title = parts.pop() ?? pathOrFile;
    const folder = parts.join(" ▸ ");
    return registerEntry({
      id: `library:${pathOrFile}`,
      source,
      path: pathOrFile,
      title,
      folder,
      searchText: `${pathOrFile}`.toLowerCase(),
    });
  }

  const file = pathOrFile;
  return registerEntry({
    id: `upload:${file.name}:${file.lastModified}`,
    source,
    file,
    title: file.name,
    folder: "Uploads",
    searchText: file.name.toLowerCase(),
  });
}

function registerEntry(entry) {
  state.entryIndex.set(entry.id, entry);
  return entry;
}

function unregisterEntriesWithPrefix(prefix) {
  for (const id of Array.from(state.entryIndex.keys())) {
    if (id.startsWith(prefix)) {
      state.entryIndex.delete(id);
    }
  }
}

function getEntryById(id) {
  return state.entryIndex.get(id) ?? null;
}

function buildLibraryTree(entries) {
  const root = {
    id: "root",
    name: "Built-in Library",
    type: "folder",
    fullPath: "",
    children: [],
  };
  const folderMap = new Map([["", root]]);

  const ensureFolder = (fullPath, name) => {
    if (folderMap.has(fullPath)) {
      return folderMap.get(fullPath);
    }
    const node = {
      id: `dir:${fullPath}`,
      name,
      type: "folder",
      fullPath,
      children: [],
    };
    folderMap.set(fullPath, node);
    const parentPath = fullPath.includes("/")
      ? fullPath.slice(0, fullPath.lastIndexOf("/"))
      : "";
    const parent = folderMap.get(parentPath) ?? root;
    parent.children.push(node);
    return node;
  };

  entries.forEach((entry) => {
    const parts = entry.path.split("/");
    const folders = parts.slice(0, -1);
    let currentPath = "";
    folders.forEach((segment) => {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      ensureFolder(currentPath, segment);
    });
    const parentPath = folders.length ? currentPath : "";
    const parent = folderMap.get(parentPath) ?? root;
    parent.children.push({
      id: entry.id,
      name: entry.title,
      type: "file",
      entryId: entry.id,
      entry,
    });
  });

  for (const node of folderMap.values()) {
    node.children.sort((a, b) => {
      if (a.type === b.type) {
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      }
      return a.type === "folder" ? -1 : 1;
    });
  }

  return root;
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
  renderPlaylistDetail();
  updateRatingUI();
  updateFavoriteButton();
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
