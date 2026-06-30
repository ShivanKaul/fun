const SF_BOUNDS = [[37.690, -122.530], [37.835, -122.350]];
const SF_MAX_BOUNDS = [[37.660, -122.560], [37.855, -122.320]];
const WALK_METERS_PER_MINUTE = 80;
const WALK_METERS_PER_SECOND = WALK_METERS_PER_MINUTE / 60;
const GRID_STEP_DEG = 0.0045;
const FIVE_MINUTE_EDGE_METERS = WALK_METERS_PER_MINUTE * 5;

const stationCount = document.getElementById('station-count');
const bikeCount = document.getElementById('bike-count');
const radiusLabel = document.getElementById('radius-label');
const heatCount = document.getElementById('heat-count');
const statusEl = document.getElementById('status');
const coverageMode = document.getElementById('coverage-mode');
const showHeat = document.getElementById('show-heat');
const showStations = document.getElementById('show-stations');
const heatCanvas = document.getElementById('heat-canvas');
const heatCtx = heatCanvas.getContext('2d');
const addressInput = document.getElementById('address');
const summaryEl = document.getElementById('selection-summary');

if (!window.L) {
  document.getElementById('map').innerHTML = '<div style="height:100%;display:grid;place-items:center;padding:2rem;text-align:center;color:#617081;">Map library failed to load. Refresh the page or check whether a content blocker is blocking Leaflet.</div>';
  throw new Error('Leaflet failed to load.');
}

const map = L.map('map', {
  preferCanvas: true,
  zoomControl: false,
  maxBounds: SF_MAX_BOUNDS,
  maxBoundsViscosity: 0.75
}).fitBounds(SF_BOUNDS);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

let stations = [];
let walkNetwork = null;
let stationLayer = L.layerGroup().addTo(map);
let selectionLayer = L.layerGroup().addTo(map);
let heatCells = [];
let travelTimes = null;
let redrawTimer = null;
let statusParts = [];

class PriorityQueue {
  constructor() {
    this.items = [];
  }

  push(node, priority, sourceIndex) {
    const item = { node, priority, sourceIndex };
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  pop() {
    if (!this.items.length) { return null; }
    const top = this.items[0];
    const end = this.items.pop();
    if (this.items.length) {
      this.items[0] = end;
      this.sinkDown(0);
    }
    return top;
  }

  bubbleUp(index) {
    const item = this.items[index];
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      const parent = this.items[parentIndex];
      if (item.priority >= parent.priority) { break; }
      this.items[parentIndex] = item;
      this.items[index] = parent;
      index = parentIndex;
    }
  }

  sinkDown(index) {
    const length = this.items.length;
    const item = this.items[index];
    while (true) {
      const leftIndex = (index * 2) + 1;
      const rightIndex = leftIndex + 1;
      let swapIndex = null;

      if (leftIndex < length && this.items[leftIndex].priority < item.priority) {
        swapIndex = leftIndex;
      }
      if (rightIndex < length) {
        const right = this.items[rightIndex];
        const compare = swapIndex === null ? item.priority : this.items[leftIndex].priority;
        if (right.priority < compare) { swapIndex = rightIndex; }
      }
      if (swapIndex === null) { break; }
      this.items[index] = this.items[swapIndex];
      this.items[swapIndex] = item;
      index = swapIndex;
    }
  }
}

function setStatus(parts) {
  statusParts = parts.filter(Boolean);
  statusEl.textContent = statusParts.join(' ');
}

function isOperational(station) {
  return station.is_operational !== false;
}

function hasBikesNow(station) {
  return isOperational(station) && Number(station.num_bikes_available || 0) > 0;
}

function activeStations() {
  if (coverageMode.value === 'bikes') {
    return stations.filter(hasBikesNow);
  }
  if (coverageMode.value === 'operational') {
    return stations.filter(isOperational);
  }
  return stations;
}

function metersBetween(aLat, aLng, bLat, bLng) {
  const r = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLng = (bLng - aLng) * toRad;
  const lat1 = aLat * toRad;
  const lat2 = bLat * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

function secondsFromMeters(meters) {
  return meters / WALK_METERS_PER_SECOND;
}

function minutesFromSeconds(seconds) {
  return seconds / 60;
}

function nearestStationByAir(lat, lon) {
  let best = null;
  for (const station of activeStations()) {
    const distance = metersBetween(lat, lon, station.lat, station.lon);
    if (!best || distance < best.distance) {
      best = { station, distance };
    }
  }
  return best;
}

function gradeForMinutes(minutes) {
  if (minutes <= 2) {
    return { label: 'excellent', color: 'rgba(8, 119, 63, 0.34)', marker: '#08773f' };
  }
  if (minutes <= 5) {
    return { label: 'good', color: 'rgba(112, 165, 34, 0.32)', marker: '#70a522' };
  }
  if (minutes <= 8) {
    return { label: 'okay', color: 'rgba(215, 163, 22, 0.31)', marker: '#d7a316' };
  }
  if (minutes <= 12) {
    return { label: 'poor', color: 'rgba(212, 104, 13, 0.30)', marker: '#d4680d' };
  }
  return { label: 'bad', color: 'rgba(180, 35, 24, 0.30)', marker: '#b42318' };
}

function stationPopup(station) {
  const bikes = station.num_bikes_available;
  const docks = station.num_docks_available;
  const updated = station.last_reported ? new Date(station.last_reported * 1000).toLocaleString() : null;
  const lines = [`<b>${escapeHtml(station.name || 'Bay Wheels station')}</b>`];
  if (Number.isFinite(bikes)) { lines.push(`${bikes} bikes available`); }
  if (Number.isFinite(docks)) { lines.push(`${docks} docks available`); }
  lines.push(isOperational(station) ? 'Operational' : 'Not currently operational');
  if (updated) { lines.push(`Updated ${escapeHtml(updated)}`); }
  return lines.join('<br>');
}

function renderStations() {
  stationLayer.clearLayers();
  if (!showStations.checked) { return; }

  for (const station of activeStations()) {
    const bikes = Number(station.num_bikes_available || 0);
    const opacity = isOperational(station) ? 0.95 : 0.35;
    const markerRadius = coverageMode.value === 'bikes' ? Math.min(8, Math.max(4, 3 + Math.sqrt(bikes))) : 4.5;
    L.circleMarker([station.lat, station.lon], {
      radius: markerRadius,
      weight: 1.5,
      color: '#1745ba',
      fillColor: '#1f5eff',
      fillOpacity: opacity
    }).bindPopup(stationPopup(station)).addTo(stationLayer);
  }
}

function resizeHeatCanvas() {
  const size = map.getSize();
  const ratio = window.devicePixelRatio || 1;
  heatCanvas.style.width = `${size.x}px`;
  heatCanvas.style.height = `${size.y}px`;
  heatCanvas.width = Math.round(size.x * ratio);
  heatCanvas.height = Math.round(size.y * ratio);
  heatCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function normalizeNetwork(rawNetwork) {
  if (!rawNetwork || !Array.isArray(rawNetwork.nodes) || !Array.isArray(rawNetwork.edges)) {
    return null;
  }

  const nodes = rawNetwork.nodes
    .map(node => ({ lat: Number(node[0]), lon: Number(node[1]) }))
    .filter(node => Number.isFinite(node.lat) && Number.isFinite(node.lon));
  if (!nodes.length) { return null; }

  const adjacency = Array.from({ length: nodes.length }, () => []);
  for (const edge of rawNetwork.edges) {
    const from = Number(edge[0]);
    const to = Number(edge[1]);
    const seconds = Number(edge[2]);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= nodes.length || to >= nodes.length || !Number.isFinite(seconds)) {
      continue;
    }
    adjacency[from].push([to, seconds]);
    adjacency[to].push([from, seconds]);
  }

  return { nodes, adjacency, metadata: rawNetwork };
}

async function loadWalkNetwork() {
  try {
    const response = await fetch('walk-network.json', { cache: 'no-store' });
    if (!response.ok) { throw new Error(`${response.status} ${response.statusText}`); }
    const network = normalizeNetwork(await response.json());
    if (!network) { throw new Error('Invalid network data.'); }
    walkNetwork = network;
    const generatedAt = network.metadata.generated_at ? new Date(network.metadata.generated_at).toLocaleString() : 'unknown time';
    return `Loaded walking network with ${walkNetwork.nodes.length} nodes. Last generated: ${generatedAt}.`;
  } catch (error) {
    walkNetwork = null;
    return `Walking network unavailable; using straight-line fallback. ${error.message}`;
  }
}

function nearestNetworkNode(lat, lon) {
  if (!walkNetwork) { return null; }
  let best = null;
  for (let index = 0; index < walkNetwork.nodes.length; index += 1) {
    const node = walkNetwork.nodes[index];
    const distance = metersBetween(lat, lon, node.lat, node.lon);
    if (!best || distance < best.distance) {
      best = { index, distance };
    }
  }
  return best;
}

function computeTravelTimes() {
  if (!walkNetwork) {
    travelTimes = null;
    return;
  }

  const distances = new Float64Array(walkNetwork.nodes.length);
  const sources = new Int32Array(walkNetwork.nodes.length);
  distances.fill(Infinity);
  sources.fill(-1);
  const queue = new PriorityQueue();
  const currentStations = activeStations();

  currentStations.forEach((station, stationIndex) => {
    const snap = nearestNetworkNode(station.lat, station.lon);
    if (!snap) { return; }
    const accessSeconds = secondsFromMeters(snap.distance);
    if (accessSeconds < distances[snap.index]) {
      distances[snap.index] = accessSeconds;
      sources[snap.index] = stationIndex;
      queue.push(snap.index, accessSeconds, stationIndex);
    }
  });

  while (queue.items.length) {
    const item = queue.pop();
    if (item.priority !== distances[item.node]) { continue; }
    for (const [neighbor, seconds] of walkNetwork.adjacency[item.node]) {
      const next = item.priority + seconds;
      if (next < distances[neighbor]) {
        distances[neighbor] = next;
        sources[neighbor] = item.sourceIndex;
        queue.push(neighbor, next, item.sourceIndex);
      }
    }
  }

  travelTimes = { distances, sources, activeStations: currentStations };
}

function walkingResult(lat, lon) {
  if (!walkNetwork || !travelTimes) { return null; }
  const snap = nearestNetworkNode(lat, lon);
  if (!snap) { return null; }
  const networkSeconds = travelTimes.distances[snap.index];
  const sourceIndex = travelTimes.sources[snap.index];
  if (!Number.isFinite(networkSeconds) || sourceIndex < 0) { return null; }
  return {
    station: travelTimes.activeStations[sourceIndex],
    seconds: networkSeconds + secondsFromMeters(snap.distance),
    accessDistance: snap.distance
  };
}

function bestTravelResult(lat, lon) {
  const walking = walkingResult(lat, lon);
  if (walking) { return { ...walking, mode: 'walking-network' }; }

  const byAir = nearestStationByAir(lat, lon);
  if (!byAir) { return null; }
  return {
    station: byAir.station,
    seconds: secondsFromMeters(byAir.distance),
    accessDistance: 0,
    mode: 'straight-line',
    distance: byAir.distance
  };
}

function buildHeatCells() {
  const cells = [];
  if (!activeStations().length) { return cells; }

  for (let lat = SF_BOUNDS[0][0]; lat <= SF_BOUNDS[1][0]; lat += GRID_STEP_DEG) {
    for (let lon = SF_BOUNDS[0][1]; lon <= SF_BOUNDS[1][1]; lon += GRID_STEP_DEG) {
      const centerLat = lat + GRID_STEP_DEG / 2;
      const centerLon = lon + GRID_STEP_DEG / 2;
      const result = bestTravelResult(centerLat, centerLon);
      if (!result) { continue; }
      const minutes = minutesFromSeconds(result.seconds);
      cells.push({
        nw: [lat + GRID_STEP_DEG, lon],
        se: [lat, lon + GRID_STEP_DEG],
        minutes,
        grade: gradeForMinutes(minutes)
      });
    }
  }

  return cells;
}

function renderHeat() {
  resizeHeatCanvas();
  const size = map.getSize();
  heatCtx.clearRect(0, 0, size.x, size.y);
  radiusLabel.textContent = `${FIVE_MINUTE_EDGE_METERS}m`;

  if (!showHeat.checked) {
    heatCount.textContent = '0';
    return;
  }

  for (const cell of heatCells) {
    const nw = map.latLngToContainerPoint(cell.nw);
    const se = map.latLngToContainerPoint(cell.se);
    heatCtx.fillStyle = cell.grade.color;
    heatCtx.fillRect(nw.x, nw.y, se.x - nw.x, se.y - nw.y);
  }

  heatCount.textContent = String(heatCells.length);
}

function updateStats() {
  const currentStations = activeStations();
  const bikes = currentStations.reduce((sum, station) => sum + Number(station.num_bikes_available || 0), 0);
  stationCount.textContent = stations.length ? `${currentStations.length}/${stations.length}` : '—';
  bikeCount.textContent = stations.length ? String(bikes) : '—';
  radiusLabel.textContent = `${FIVE_MINUTE_EDGE_METERS}m`;
}

function rebuildHeatAndRedraw() {
  updateStats();
  renderStations();
  computeTravelTimes();
  heatCells = buildHeatCells();
  renderHeat();
  rerenderSelection();
}

function scheduleHeatRedraw() {
  if (redrawTimer) { cancelAnimationFrame(redrawTimer); }
  redrawTimer = requestAnimationFrame(renderHeat);
}

function parseCoordinates(value) {
  const trimmed = value.trim();
  const patterns = [
    /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
    /[?&]q=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
    /[?&]ll=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
    /(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/
  ];

  let decoded = trimmed;
  try { decoded = decodeURIComponent(trimmed); } catch (_) {}

  for (const pattern of patterns) {
    const match = decoded.match(pattern);
    if (!match) { continue; }
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return { lat, lon, label: trimmed };
    }
  }

  return null;
}

async function geocodeAddress(query) {
  const coordinate = parseCoordinates(query);
  if (coordinate) { return coordinate; }

  const params = new URLSearchParams({
    format: 'jsonv2',
    q: `${query}, San Francisco, CA`,
    limit: '1',
    viewbox: '-122.530,37.835,-122.350,37.690',
    bounded: '1'
  });
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, { cache: 'no-store' });
  if (!response.ok) { throw new Error(`${response.status} ${response.statusText}`); }
  const results = await response.json();
  if (!Array.isArray(results) || !results.length) {
    throw new Error('No matching San Francisco address found.');
  }
  return {
    lat: Number(results[0].lat),
    lon: Number(results[0].lon),
    label: results[0].display_name || query
  };
}

function renderSelection(point) {
  selectionLayer.clearLayers();
  const result = bestTravelResult(point.lat, point.lon);

  if (!result) {
    summaryEl.innerHTML = '<div class="summary-card">No active station data available for this mode.</div>';
    return;
  }

  const minutes = minutesFromSeconds(result.seconds);
  const grade = gradeForMinutes(minutes);
  const station = result.station;
  const fallbackCopy = result.mode === 'straight-line' ? ' Straight-line fallback.' : '';
  const popup = `<b>${escapeHtml(point.label)}</b><br>${minutes.toFixed(1)} min to ${escapeHtml(station.name)}${fallbackCopy}`;

  L.circleMarker([point.lat, point.lon], {
    radius: 8,
    weight: 2,
    color: grade.marker,
    fillColor: grade.marker,
    fillOpacity: 0.92
  }).bindPopup(popup).addTo(selectionLayer);

  summaryEl.innerHTML = `
    <div class="summary-card">
      <b>${escapeHtml(point.label)} <span class="badge ${grade.label}">${grade.label}</span></b>
      ${minutes.toFixed(1)} min to ${escapeHtml(station.name)}.${fallbackCopy}
    </div>
    <div class="summary-card">
      <b>Availability</b>
      ${Number(station.num_bikes_available || 0)} bikes available · ${Number(station.num_docks_available || 0)} docks available
    </div>
  `;
}

function rerenderSelection() {
  const marker = selectionLayer.getLayers()[0];
  if (!marker) { return; }
  const latLng = marker.getLatLng();
  renderSelection({ lat: latLng.lat, lon: latLng.lng, label: addressInput.value.trim() || 'Selected point' });
}

async function analyzeAddress() {
  const query = addressInput.value.trim();
  if (!query) { return; }

  summaryEl.innerHTML = '<div class="summary-card">Searching…</div>';
  try {
    const point = await geocodeAddress(query);
    renderSelection(point);
    map.panTo([point.lat, point.lon]);
  } catch (error) {
    summaryEl.innerHTML = `<div class="summary-card">Could not find that point: ${escapeHtml(error.message)}</div>`;
  }
}

async function loadStations() {
  try {
    const stationResponse = await fetch('stations.json', { cache: 'no-store' });
    if (!stationResponse.ok) { throw new Error(`${stationResponse.status} ${stationResponse.statusText}`); }
    const data = await stationResponse.json();
    stations = Array.isArray(data.stations) ? data.stations : [];
    stations = stations.filter(station => Number.isFinite(station.lat) && Number.isFinite(station.lon));
    if (!stations.length) { throw new Error('No station data found. The scheduled data update may not have run yet.'); }
    const generatedAt = data.generated_at ? new Date(data.generated_at).toLocaleString() : 'unknown time';
    const networkStatus = await loadWalkNetwork();
    setStatus([`Loaded ${stations.length} stations from local static data. Last generated: ${generatedAt}.`, networkStatus]);
    rebuildHeatAndRedraw();
  } catch (error) {
    setStatus([`Could not load local station data: ${error.message}`]);
    resizeHeatCanvas();
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
}

coverageMode.addEventListener('change', rebuildHeatAndRedraw);
showHeat.addEventListener('change', renderHeat);
showStations.addEventListener('change', renderStations);
document.getElementById('fit-sf').addEventListener('click', () => map.fitBounds(SF_BOUNDS));
document.getElementById('find-address').addEventListener('click', analyzeAddress);
document.getElementById('clear-selection').addEventListener('click', () => {
  addressInput.value = '';
  summaryEl.innerHTML = '';
  selectionLayer.clearLayers();
});
addressInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    analyzeAddress();
  }
});
map.on('click', event => {
  const point = {
    lat: event.latlng.lat,
    lon: event.latlng.lng,
    label: `${event.latlng.lat.toFixed(6)}, ${event.latlng.lng.toFixed(6)}`
  };
  addressInput.value = point.label;
  renderSelection(point);
});
map.on('move zoom resize', scheduleHeatRedraw);
window.addEventListener('resize', scheduleHeatRedraw);

loadStations();
