const SF_BOUNDS = [[37.690, -122.530], [37.835, -122.350]];
const SF_MAX_BOUNDS = [[37.660, -122.560], [37.855, -122.320]];
const stationCount = document.getElementById('station-count');
const bikeCount = document.getElementById('bike-count');
const radiusInput = document.getElementById('radius');
const radiusLabel = document.getElementById('radius-label');
const statusEl = document.getElementById('status');
const coverageMode = document.getElementById('coverage-mode');
const showCoverage = document.getElementById('show-coverage');
const showStations = document.getElementById('show-stations');
const coverageCanvas = document.getElementById('coverage-canvas');
const coverageCtx = coverageCanvas.getContext('2d');

if (!window.L) {
  document.getElementById('map').innerHTML = '<div style="height:100%;display:grid;place-items:center;padding:2rem;text-align:center;color:#617081;">Map library failed to load. Refresh the page or check whether a content blocker is blocking Leaflet.</div>';
  throw new Error('Leaflet failed to load.');
}

const map = L.map('map', {
  preferCanvas: true,
  zoomControl: false,
  maxBounds: SF_MAX_BOUNDS,
  maxBoundsViscosity: 0.85,
  minZoom: 11
}).fitBounds(SF_BOUNDS);

L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  bounds: SF_MAX_BOUNDS,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

let stations = [];
let stationLayer = L.layerGroup().addTo(map);
let redrawTimer = null;

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

function stationIsVisible(station, paddedBounds = map.getBounds().pad(0.15)) {
  return paddedBounds.contains([station.lat, station.lon]);
}

function visibleStations() {
  const paddedBounds = map.getBounds().pad(0.15);
  return activeStations().filter(station => stationIsVisible(station, paddedBounds));
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

  for (const station of visibleStations()) {
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

function radiusInPixels(lat, lon, meters) {
  const lngDelta = meters / (111320 * Math.cos(lat * Math.PI / 180));
  const center = map.latLngToContainerPoint([lat, lon]);
  const edge = map.latLngToContainerPoint([lat, lon + lngDelta]);
  return Math.abs(edge.x - center.x);
}

function resizeCoverageCanvas() {
  const size = map.getSize();
  const ratio = window.devicePixelRatio || 1;
  coverageCanvas.style.width = `${size.x}px`;
  coverageCanvas.style.height = `${size.y}px`;
  coverageCanvas.width = Math.round(size.x * ratio);
  coverageCanvas.height = Math.round(size.y * ratio);
  coverageCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function renderCoverage() {
  resizeCoverageCanvas();
  const size = map.getSize();
  coverageCtx.clearRect(0, 0, size.x, size.y);
  const radius = Number(radiusInput.value) || 400;
  radiusLabel.textContent = `${radius}m`;
  if (!showCoverage.checked) { return; }

  coverageCtx.fillStyle = 'rgba(8, 119, 63, 0.28)';
  coverageCtx.strokeStyle = 'rgba(7, 93, 52, 0.42)';
  coverageCtx.lineWidth = 1;

  for (const station of visibleStations()) {
    const point = map.latLngToContainerPoint([station.lat, station.lon]);
    const pixelRadius = radiusInPixels(station.lat, station.lon, radius);
    coverageCtx.beginPath();
    coverageCtx.arc(point.x, point.y, pixelRadius, 0, Math.PI * 2);
    coverageCtx.fill();
    coverageCtx.stroke();
  }
}

function updateStats() {
  const currentStations = activeStations();
  const bikes = currentStations.reduce((sum, station) => sum + Number(station.num_bikes_available || 0), 0);
  stationCount.textContent = stations.length ? `${currentStations.length}/${stations.length}` : '—';
  bikeCount.textContent = stations.length ? String(bikes) : '—';
  radiusLabel.textContent = `${Number(radiusInput.value) || 400}m`;
}

function redraw() {
  updateStats();
  renderStations();
  renderCoverage();
}

function scheduleRedraw() {
  if (redrawTimer) { cancelAnimationFrame(redrawTimer); }
  redrawTimer = requestAnimationFrame(redraw);
}

async function loadStations() {
  try {
    const response = await fetch('stations.json', { cache: 'no-store' });
    if (!response.ok) { throw new Error(`${response.status} ${response.statusText}`); }
    const data = await response.json();
    stations = Array.isArray(data.stations) ? data.stations : [];
    stations = stations.filter(station => Number.isFinite(station.lat) && Number.isFinite(station.lon));
    if (!stations.length) { throw new Error('No station data found. The scheduled data update may not have run yet.'); }
    const generatedAt = data.generated_at ? new Date(data.generated_at).toLocaleString() : 'unknown time';
    statusEl.textContent = `Loaded ${stations.length} stations from local static data. Last generated: ${generatedAt}.`;
    redraw();
  } catch (error) {
    statusEl.textContent = `Could not load local station data: ${error.message}`;
    resizeCoverageCanvas();
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
}

document.getElementById('apply-radius').addEventListener('click', redraw);
coverageMode.addEventListener('change', redraw);
showCoverage.addEventListener('change', redraw);
showStations.addEventListener('change', redraw);
document.getElementById('fit-sf').addEventListener('click', () => map.fitBounds(SF_BOUNDS));
map.on('moveend zoomend resize', scheduleRedraw);
window.addEventListener('resize', scheduleRedraw);

loadStations();
