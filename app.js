const els = {
  mapViewport: document.getElementById('mapViewport'),
  mapStage: document.getElementById('mapStage'),
  mapImage: document.getElementById('mapImage'),
  youDot: document.getElementById('youDot'),
  accuracyCircle: document.getElementById('accuracyCircle'),
  panelToggle: document.getElementById('panelToggle'),
  controlPanel: document.getElementById('controlPanel'),
  statusLine: document.getElementById('statusLine'),
  startGps: document.getElementById('startGps'),
  stopGps: document.getElementById('stopGps'),
  gpsStatus: document.getElementById('gpsStatus'),
  latOut: document.getElementById('latOut'),
  lngOut: document.getElementById('lngOut'),
  accOut: document.getElementById('accOut'),
  xyOut: document.getElementById('xyOut'),
  mapWarning: document.getElementById('mapWarning'),
  zoomIn: document.getElementById('zoomIn'),
  zoomOut: document.getElementById('zoomOut'),
  resetView: document.getElementById('resetView'),
  followMe: document.getElementById('followMe'),
  pointName: document.getElementById('pointName'),
  pointNotes: document.getElementById('pointNotes'),
  selectedPointOut: document.getElementById('selectedPointOut'),
  savePoint: document.getElementById('savePoint'),
  exportPoints: document.getElementById('exportPoints'),
  clearPoints: document.getElementById('clearPoints'),
  savedCountOut: document.getElementById('savedCountOut')
};

let config;
let gpsWatchId = null;
let lastPosition = null;
let selectedMapPoint = null;
let savedPoints = loadSavedPoints();
let follow = false;

const state = { x: 0, y: 0, scale: 0.22, minScale: 0.08, maxScale: 4, dragging: false, lastPointer: null };

init().catch(err => {
  console.error(err);
  els.statusLine.textContent = 'Failed to load app config.';
  els.gpsStatus.textContent = 'error';
});

async function init() {
  const res = await fetch('data/map-config.json', { cache: 'no-store' });
  config = await res.json();

  state.scale = config.ui?.defaultZoom ?? 0.22;
  state.minScale = config.ui?.minZoom ?? 0.08;
  state.maxScale = config.ui?.maxZoom ?? 4;

  els.mapImage.src = config.mapImage;
  els.mapImage.width = config.imageWidthPx;
  els.mapImage.height = config.imageHeightPx;
  els.mapStage.style.width = `${config.imageWidthPx}px`;
  els.mapStage.style.height = `${config.imageHeightPx}px`;
  els.statusLine.textContent = `${config.status} — field calibration pending`;
  updateSavedCount();

  els.mapImage.addEventListener('load', resetView);
  els.mapImage.addEventListener('error', () => {
    els.statusLine.textContent = 'Map image missing: upload assets/map/glen-helen-map-web.jpg';
  });

  bindUi();
  bindMapGestures();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').catch(() => {});
}

function bindUi() {
  els.panelToggle.addEventListener('click', () => els.controlPanel.classList.toggle('open'));
  els.startGps.addEventListener('click', startGps);
  els.stopGps.addEventListener('click', stopGps);
  els.zoomIn.addEventListener('click', () => zoomAroundViewportCenter(1.25));
  els.zoomOut.addEventListener('click', () => zoomAroundViewportCenter(0.8));
  els.resetView.addEventListener('click', resetView);
  els.followMe.addEventListener('click', () => {
    follow = !follow;
    els.followMe.textContent = follow ? 'Follow: On' : 'Follow: Off';
    if (follow && lastPosition) centerOnGpsPosition(lastPosition);
  });
  els.savePoint.addEventListener('click', saveCalibrationPoint);
  els.exportPoints.addEventListener('click', exportCalibrationPoints);
  els.clearPoints.addEventListener('click', () => {
    if (!confirm('Clear locally saved calibration points on this browser?')) return;
    savedPoints = [];
    localStorage.removeItem('glenHelenCalibrationPoints');
    updateSavedCount();
  });
}

function bindMapGestures() {
  els.mapViewport.addEventListener('pointerdown', e => {
    els.mapViewport.setPointerCapture(e.pointerId);
    state.dragging = true;
    state.lastPointer = { x: e.clientX, y: e.clientY };
  });
  els.mapViewport.addEventListener('pointermove', e => {
    if (!state.dragging || !state.lastPointer) return;
    const dx = e.clientX - state.lastPointer.x;
    const dy = e.clientY - state.lastPointer.y;
    state.x += dx;
    state.y += dy;
    state.lastPointer = { x: e.clientX, y: e.clientY };
    applyTransform();
  });
  els.mapViewport.addEventListener('pointerup', () => { state.dragging = false; state.lastPointer = null; });
  els.mapViewport.addEventListener('pointercancel', () => { state.dragging = false; state.lastPointer = null; });
  els.mapViewport.addEventListener('wheel', e => {
    e.preventDefault();
    zoomAtPoint(e.deltaY < 0 ? 1.12 : 0.88, e.clientX, e.clientY);
  }, { passive: false });
  els.mapViewport.addEventListener('click', e => {
    const point = screenToImage(e.clientX, e.clientY);
    selectedMapPoint = point;
    els.selectedPointOut.textContent = `${point.x.toFixed(1)}, ${point.y.toFixed(1)}`;
  });
}

function resetView() {
  const vw = els.mapViewport.clientWidth;
  const vh = els.mapViewport.clientHeight;
  const scaleX = vw / config.imageWidthPx;
  const scaleY = vh / config.imageHeightPx;
  state.scale = Math.min(Math.max(Math.min(scaleX, scaleY) * 0.94, state.minScale), state.maxScale);
  state.x = (vw - config.imageWidthPx * state.scale) / 2;
  state.y = (vh - config.imageHeightPx * state.scale) / 2;
  applyTransform();
}

function applyTransform() { els.mapStage.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`; }
function zoomAroundViewportCenter(factor) { zoomAtPoint(factor, els.mapViewport.clientWidth / 2, els.mapViewport.clientHeight / 2); }
function zoomAtPoint(factor, sx, sy) {
  const before = screenToImage(sx, sy);
  state.scale = clamp(state.scale * factor, state.minScale, state.maxScale);
  state.x = sx - before.x * state.scale;
  state.y = sy - before.y * state.scale;
  applyTransform();
}
function screenToImage(sx, sy) { return { x: (sx - state.x) / state.scale, y: (sy - state.y) / state.scale }; }

function startGps() {
  if (!navigator.geolocation) { els.gpsStatus.textContent = 'geolocation unavailable'; return; }
  els.gpsStatus.textContent = 'requesting permission...';
  gpsWatchId = navigator.geolocation.watchPosition(onGps, onGpsError, { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
  els.startGps.disabled = true;
  els.stopGps.disabled = false;
}
function stopGps() {
  if (gpsWatchId !== null) navigator.geolocation.clearWatch(gpsWatchId);
  gpsWatchId = null;
  els.startGps.disabled = false;
  els.stopGps.disabled = true;
  els.gpsStatus.textContent = 'stopped';
}
function onGps(pos) {
  lastPosition = pos;
  const { latitude, longitude, accuracy } = pos.coords;
  const mapPoint = latLngToImagePoint(latitude, longitude);
  els.gpsStatus.textContent = 'tracking';
  els.latOut.textContent = latitude.toFixed(7);
  els.lngOut.textContent = longitude.toFixed(7);
  els.accOut.textContent = `${Math.round(accuracy)} m`;
  els.xyOut.textContent = `${mapPoint.x.toFixed(1)}, ${mapPoint.y.toFixed(1)}`;
  const inside = mapPoint.x >= 0 && mapPoint.x <= config.imageWidthPx && mapPoint.y >= 0 && mapPoint.y <= config.imageHeightPx;
  els.mapWarning.hidden = inside;
  placeGpsMarker(mapPoint, accuracy);
  if (follow) centerOnGpsPosition(pos);
}
function onGpsError(err) { els.gpsStatus.textContent = `GPS error: ${err.message}`; }

function latLngToImagePoint(lat, lng) {
  const g = config.georeferenceSource;
  const cx = config.imageWidthPx / 2;
  const cy = config.imageHeightPx / 2;
  const xUnrot = ((lng - g.west) / (g.east - g.west)) * config.imageWidthPx;
  const yUnrot = ((g.north - lat) / (g.north - g.south)) * config.imageHeightPx;
  const angle = degToRad((g.rotationDegrees || 0) * (config.transform?.rotationMultiplier ?? 1));
  const dx = xUnrot - cx;
  const dy = yUnrot - cy;
  return { x: cx + dx * Math.cos(angle) - dy * Math.sin(angle), y: cy + dx * Math.sin(angle) + dy * Math.cos(angle) };
}
function placeGpsMarker(point, accuracyMeters) {
  els.youDot.hidden = false;
  els.youDot.style.left = `${point.x}px`;
  els.youDot.style.top = `${point.y}px`;
  if (config.ui?.showAccuracyCircle) {
    const metersPerPixel = config.derived.approxWidthMeters / config.imageWidthPx;
    const radiusPx = Math.max(12, accuracyMeters / metersPerPixel);
    els.accuracyCircle.hidden = false;
    els.accuracyCircle.style.left = `${point.x}px`;
    els.accuracyCircle.style.top = `${point.y}px`;
    els.accuracyCircle.style.width = `${radiusPx * 2}px`;
    els.accuracyCircle.style.height = `${radiusPx * 2}px`;
    els.accuracyCircle.style.marginLeft = `${-radiusPx}px`;
    els.accuracyCircle.style.marginTop = `${-radiusPx}px`;
  }
}
function centerOnGpsPosition(pos) {
  const p = latLngToImagePoint(pos.coords.latitude, pos.coords.longitude);
  state.x = els.mapViewport.clientWidth / 2 - p.x * state.scale;
  state.y = els.mapViewport.clientHeight / 2 - p.y * state.scale;
  applyTransform();
}
function saveCalibrationPoint() {
  if (!selectedMapPoint) { alert('Tap the exact matching point on the map first.'); return; }
  if (!lastPosition) { alert('Start GPS and wait for a current reading first.'); return; }
  const point = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    name: els.pointName.value.trim() || 'Unnamed field point',
    notes: els.pointNotes.value.trim(),
    imageX: Number(selectedMapPoint.x.toFixed(3)),
    imageY: Number(selectedMapPoint.y.toFixed(3)),
    lat: lastPosition.coords.latitude,
    lng: lastPosition.coords.longitude,
    accuracyMeters: lastPosition.coords.accuracy,
    capturedAt: new Date().toISOString(),
    source: 'browser_geolocation_field_capture'
  };
  savedPoints.push(point);
  localStorage.setItem('glenHelenCalibrationPoints', JSON.stringify(savedPoints, null, 2));
  updateSavedCount();
}
function exportCalibrationPoints() {
  const payload = { status: 'field_collected_pending_review', generatedAt: new Date().toISOString(), points: savedPoints };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'calibration-points-field-export.json';
  a.click();
  URL.revokeObjectURL(a.href);
}
function loadSavedPoints() {
  try { return JSON.parse(localStorage.getItem('glenHelenCalibrationPoints') || '[]'); }
  catch { return []; }
}
function updateSavedCount() { els.savedCountOut.textContent = String(savedPoints.length); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function degToRad(deg) { return deg * Math.PI / 180; }
