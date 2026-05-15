const STORAGE_KEY = 'glenHelenCalibrationPoints';
const GPS_FRESH_MS = 10000;
const TARGET_ACCURACY_METERS = 15;
const CAUTION_ACCURACY_METERS = 30;

const els = {
  mapViewport: document.getElementById('mapViewport'),
  mapStage: document.getElementById('mapStage'),
  mapImage: document.getElementById('mapImage'),
  youDot: document.getElementById('youDot'),
  accuracyCircle: document.getElementById('accuracyCircle'),
  selectedPointMarker: document.getElementById('selectedPointMarker'),
  panelToggle: document.getElementById('panelToggle'),
  controlPanel: document.getElementById('controlPanel'),
  statusLine: document.getElementById('statusLine'),
  offlineStatus: document.getElementById('offlineStatus'),
  startGps: document.getElementById('startGps'),
  stopGps: document.getElementById('stopGps'),
  gpsStatus: document.getElementById('gpsStatus'),
  latOut: document.getElementById('latOut'),
  lngOut: document.getElementById('lngOut'),
  accOut: document.getElementById('accOut'),
  gpsQualityOut: document.getElementById('gpsQualityOut'),
  gpsAgeOut: document.getElementById('gpsAgeOut'),
  xyOut: document.getElementById('xyOut'),
  mapWarning: document.getElementById('mapWarning'),
  zoomIn: document.getElementById('zoomIn'),
  zoomOut: document.getElementById('zoomOut'),
  resetView: document.getElementById('resetView'),
  followMe: document.getElementById('followMe'),
  zoomOutLabel: document.getElementById('zoomOutLabel'),
  recenterMap: document.getElementById('recenterMap'),
  pointName: document.getElementById('pointName'),
  pointNotes: document.getElementById('pointNotes'),
  selectedPointOut: document.getElementById('selectedPointOut'),
  savePoint: document.getElementById('savePoint'),
  exportPoints: document.getElementById('exportPoints'),
  copyPoints: document.getElementById('copyPoints'),
  clearPoints: document.getElementById('clearPoints'),
  savedCountOut: document.getElementById('savedCountOut'),
  lastSavedOut: document.getElementById('lastSavedOut'),
  wakeLock: document.getElementById('wakeLock'),
  fieldChecklistToggle: document.getElementById('fieldChecklistToggle'),
  fieldChecklist: document.getElementById('fieldChecklist')
};

let config;
let gpsWatchId = null;
let lastPosition = null;
let selectedMapPoint = null;
let savedPoints = loadSavedPoints();
let follow = false;
let wakeLockSentinel = null;
let gpsAgeTimer = null;

const state = {
  x: 0,
  y: 0,
  scale: 0.22,
  minScale: 0.08,
  maxScale: 4,
  pointers: new Map(),
  lastSinglePointer: null,
  tapCandidate: null,
  lastPinchDistance: null,
  suppressClickUntil: 0
};

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
  updateGpsAge();
  updateOfflineStatus();
  updateSaveButtonState();

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
  els.recenterMap.addEventListener('click', centerOnMapBounds);
  els.followMe.addEventListener('click', () => {
    follow = !follow;
    els.followMe.textContent = follow ? 'Follow: On' : 'Follow: Off';
    els.followMe.classList.toggle('active', follow);
    if (follow && lastPosition) centerOnGpsPosition(lastPosition);
  });
  els.savePoint.addEventListener('click', saveCalibrationPoint);
  els.exportPoints.addEventListener('click', exportCalibrationPoints);
  els.copyPoints.addEventListener('click', copyCalibrationPoints);
  els.clearPoints.addEventListener('click', () => {
    if (!confirm('Clear locally saved calibration points on this browser?')) return;
    savedPoints = [];
    localStorage.removeItem(STORAGE_KEY);
    updateSavedCount();
  });
  els.wakeLock.addEventListener('click', toggleWakeLock);
  els.fieldChecklistToggle.addEventListener('click', () => {
    const hidden = els.fieldChecklist.hidden;
    els.fieldChecklist.hidden = !hidden;
    els.fieldChecklistToggle.textContent = hidden ? 'Hide checklist' : 'Show checklist';
  });
  window.addEventListener('online', updateOfflineStatus);
  window.addEventListener('offline', updateOfflineStatus);
  document.addEventListener('visibilitychange', handleVisibilityChange);
}

function bindMapGestures() {
  els.mapViewport.addEventListener('pointerdown', e => {
    e.preventDefault();
    els.mapViewport.setPointerCapture(e.pointerId);
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (state.pointers.size === 1) {
      state.lastSinglePointer = { x: e.clientX, y: e.clientY };
      state.tapCandidate = { x: e.clientX, y: e.clientY, startedAt: Date.now(), moved: false };
      state.lastPinchDistance = null;
    } else if (state.pointers.size === 2) {
      state.tapCandidate = null;
      state.lastSinglePointer = null;
      state.lastPinchDistance = getPointerDistance();
      state.suppressClickUntil = Date.now() + 500;
    }
  }, { passive: false });

  els.mapViewport.addEventListener('pointermove', e => {
    if (!state.pointers.has(e.pointerId)) return;
    e.preventDefault();
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (state.pointers.size >= 2) {
      handlePinchZoom();
      state.suppressClickUntil = Date.now() + 500;
      return;
    }

    if (!state.lastSinglePointer) return;
    const dx = e.clientX - state.lastSinglePointer.x;
    const dy = e.clientY - state.lastSinglePointer.y;

    if (state.tapCandidate && Math.hypot(e.clientX - state.tapCandidate.x, e.clientY - state.tapCandidate.y) > 8) {
      state.tapCandidate.moved = true;
    }

    state.x += dx;
    state.y += dy;
    state.lastSinglePointer = { x: e.clientX, y: e.clientY };
    applyTransform();
  }, { passive: false });

  els.mapViewport.addEventListener('pointerup', handlePointerEnd);
  els.mapViewport.addEventListener('pointercancel', handlePointerCancel);

  els.mapViewport.addEventListener('wheel', e => {
    e.preventDefault();
    zoomAtPoint(e.deltaY < 0 ? 1.12 : 0.88, e.clientX, e.clientY);
  }, { passive: false });

  els.mapViewport.addEventListener('click', e => {
    if (Date.now() < state.suppressClickUntil) e.preventDefault();
  }, true);
}

function handlePointerEnd(e) {
  const wasTap = state.tapCandidate && !state.tapCandidate.moved && Date.now() - state.tapCandidate.startedAt < 450 && state.pointers.size === 1;
  state.pointers.delete(e.pointerId);

  if (wasTap && Date.now() >= state.suppressClickUntil) selectMapPoint(e.clientX, e.clientY);

  if (state.pointers.size === 1) {
    const remaining = [...state.pointers.values()][0];
    state.lastSinglePointer = { x: remaining.x, y: remaining.y };
    state.lastPinchDistance = null;
    state.tapCandidate = null;
  } else if (state.pointers.size === 0) {
    state.lastSinglePointer = null;
    state.lastPinchDistance = null;
    state.tapCandidate = null;
  }
}

function handlePointerCancel(e) {
  state.pointers.delete(e.pointerId);
  state.lastSinglePointer = null;
  state.lastPinchDistance = null;
  state.tapCandidate = null;
  state.suppressClickUntil = Date.now() + 350;
}

function handlePinchZoom() {
  const distance = getPointerDistance();
  const center = getPointerCenter();
  if (!distance || !center) return;
  if (!state.lastPinchDistance) {
    state.lastPinchDistance = distance;
    return;
  }
  const factor = distance / state.lastPinchDistance;
  zoomAtPoint(factor, center.x, center.y);
  state.lastPinchDistance = distance;
}

function getPointerDistance() {
  const points = [...state.pointers.values()];
  if (points.length < 2) return null;
  return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
}

function getPointerCenter() {
  const points = [...state.pointers.values()];
  if (points.length < 2) return null;
  return { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
}

function selectMapPoint(clientX, clientY) {
  const point = screenToImage(clientX, clientY);
  selectedMapPoint = { x: clamp(point.x, 0, config.imageWidthPx), y: clamp(point.y, 0, config.imageHeightPx) };
  els.selectedPointOut.textContent = `${selectedMapPoint.x.toFixed(1)}, ${selectedMapPoint.y.toFixed(1)}`;
  placeSelectedPointMarker(selectedMapPoint);
  updateSaveButtonState();
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

function centerOnMapBounds() {
  const vw = els.mapViewport.clientWidth;
  const vh = els.mapViewport.clientHeight;
  state.x = (vw - config.imageWidthPx * state.scale) / 2;
  state.y = (vh - config.imageHeightPx * state.scale) / 2;
  applyTransform();
}

function applyTransform() {
  els.mapStage.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
  els.zoomOutLabel.textContent = `${Math.round(state.scale * 100)}%`;
}

function zoomAroundViewportCenter(factor) { zoomAtPoint(factor, els.mapViewport.clientWidth / 2, els.mapViewport.clientHeight / 2); }

function zoomAtPoint(factor, sx, sy) {
  const before = screenToImage(sx, sy);
  state.scale = clamp(state.scale * factor, state.minScale, state.maxScale);
  state.x = sx - before.x * state.scale;
  state.y = sy - before.y * state.scale;
  applyTransform();
}

function screenToImage(sx, sy) {
  const rect = els.mapViewport.getBoundingClientRect();
  return { x: (sx - rect.left - state.x) / state.scale, y: (sy - rect.top - state.y) / state.scale };
}

function startGps() {
  if (!navigator.geolocation) { els.gpsStatus.textContent = 'geolocation unavailable'; return; }
  els.gpsStatus.textContent = 'requesting permission...';
  gpsWatchId = navigator.geolocation.watchPosition(onGps, onGpsError, { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
  els.startGps.disabled = true;
  els.stopGps.disabled = false;
  if (!gpsAgeTimer) gpsAgeTimer = window.setInterval(updateGpsAge, 1000);
}

function stopGps() {
  if (gpsWatchId !== null) navigator.geolocation.clearWatch(gpsWatchId);
  gpsWatchId = null;
  els.startGps.disabled = false;
  els.stopGps.disabled = true;
  els.gpsStatus.textContent = 'stopped';
  if (gpsAgeTimer) {
    window.clearInterval(gpsAgeTimer);
    gpsAgeTimer = null;
  }
  updateSaveButtonState();
}

function onGps(pos) {
  lastPosition = pos;
  const { latitude, longitude, accuracy } = pos.coords;
  const mapPoint = latLngToImagePoint(latitude, longitude);
  els.gpsStatus.textContent = 'tracking';
  els.latOut.textContent = latitude.toFixed(7);
  els.lngOut.textContent = longitude.toFixed(7);
  els.accOut.textContent = `${Math.round(accuracy)} m`;
  els.gpsQualityOut.textContent = describeAccuracy(accuracy);
  els.xyOut.textContent = `${mapPoint.x.toFixed(1)}, ${mapPoint.y.toFixed(1)}`;
  const inside = mapPoint.x >= 0 && mapPoint.x <= config.imageWidthPx && mapPoint.y >= 0 && mapPoint.y <= config.imageHeightPx;
  els.mapWarning.hidden = inside;
  placeGpsMarker(mapPoint, accuracy);
  updateGpsAge();
  updateSaveButtonState();
  if (follow) centerOnGpsPosition(pos);
}

function onGpsError(err) { els.gpsStatus.textContent = `GPS error: ${err.message}`; updateSaveButtonState(); }

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

function placeSelectedPointMarker(point) {
  els.selectedPointMarker.hidden = false;
  els.selectedPointMarker.style.left = `${point.x}px`;
  els.selectedPointMarker.style.top = `${point.y}px`;
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
  const accuracy = Number(lastPosition.coords.accuracy || 9999);
  const ageMs = Date.now() - lastPosition.timestamp;
  if (ageMs > GPS_FRESH_MS && !confirm(`This GPS reading is ${Math.round(ageMs / 1000)} seconds old. Save it anyway?`)) return;
  if (accuracy > CAUTION_ACCURACY_METERS && !confirm(`GPS accuracy is ${Math.round(accuracy)} m. For calibration, wait for ${TARGET_ACCURACY_METERS} m or better when possible. Save anyway?`)) return;
  const point = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    name: els.pointName.value.trim() || `Field point ${savedPoints.length + 1}`,
    notes: els.pointNotes.value.trim(),
    imageX: Number(selectedMapPoint.x.toFixed(3)),
    imageY: Number(selectedMapPoint.y.toFixed(3)),
    lat: Number(lastPosition.coords.latitude.toFixed(8)),
    lng: Number(lastPosition.coords.longitude.toFixed(8)),
    accuracyMeters: Number(accuracy.toFixed(2)),
    gpsAgeSeconds: Number((ageMs / 1000).toFixed(1)),
    capturedAt: new Date().toISOString(),
    source: 'browser_geolocation_field_capture',
    calibrationUse: accuracy <= CAUTION_ACCURACY_METERS ? 'candidate' : 'low_confidence_review_before_use'
  };
  savedPoints.push(point);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(savedPoints, null, 2));
  selectedMapPoint = null;
  els.selectedPointMarker.hidden = true;
  els.selectedPointOut.textContent = '—';
  els.pointName.value = '';
  els.pointNotes.value = '';
  updateSavedCount(point);
  updateSaveButtonState();
}

function getCalibrationPayload() {
  return {
    status: 'field_collected_pending_review',
    generatedAt: new Date().toISOString(),
    mapImage: config.mapImage,
    imageWidthPx: config.imageWidthPx,
    imageHeightPx: config.imageHeightPx,
    targetAccuracyMeters: TARGET_ACCURACY_METERS,
    points: savedPoints
  };
}

function exportCalibrationPoints() {
  const payload = getCalibrationPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'calibration-points-field-export.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

async function copyCalibrationPoints() {
  const payload = JSON.stringify(getCalibrationPayload(), null, 2);
  try {
    await navigator.clipboard.writeText(payload);
    alert('Calibration JSON copied to clipboard.');
  } catch {
    exportCalibrationPoints();
  }
}

function loadSavedPoints() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function updateSavedCount(lastSavedPoint = null) {
  els.savedCountOut.textContent = String(savedPoints.length);
  els.lastSavedOut.textContent = lastSavedPoint ? `${lastSavedPoint.name} @ ±${Math.round(lastSavedPoint.accuracyMeters)} m` : (savedPoints.at(-1)?.name || '—');
}

function updateSaveButtonState() { els.savePoint.disabled = !selectedMapPoint || !lastPosition; }

function updateGpsAge() {
  if (!lastPosition) { els.gpsAgeOut.textContent = '—'; return; }
  const ageSeconds = Math.max(0, Math.round((Date.now() - lastPosition.timestamp) / 1000));
  els.gpsAgeOut.textContent = `${ageSeconds}s`;
}

function updateOfflineStatus() {
  els.offlineStatus.textContent = navigator.onLine ? 'Online' : 'Offline-ready';
  els.offlineStatus.classList.toggle('offline', !navigator.onLine);
}

async function toggleWakeLock() {
  if (!('wakeLock' in navigator)) { alert('Screen wake lock is not supported in this browser.'); return; }
  if (wakeLockSentinel) {
    await wakeLockSentinel.release();
    wakeLockSentinel = null;
    els.wakeLock.textContent = 'Keep screen awake';
    els.wakeLock.classList.remove('active');
    return;
  }
  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    els.wakeLock.textContent = 'Screen awake: On';
    els.wakeLock.classList.add('active');
    wakeLockSentinel.addEventListener('release', () => {
      wakeLockSentinel = null;
      els.wakeLock.textContent = 'Keep screen awake';
      els.wakeLock.classList.remove('active');
    });
  } catch (err) {
    alert(`Could not enable screen wake lock: ${err.message}`);
  }
}

async function handleVisibilityChange() {
  if (document.visibilityState === 'visible' && els.wakeLock.classList.contains('active') && !wakeLockSentinel) {
    try { wakeLockSentinel = await navigator.wakeLock.request('screen'); } catch {}
  }
}

function describeAccuracy(accuracy) {
  if (!Number.isFinite(accuracy)) return 'unknown';
  if (accuracy <= TARGET_ACCURACY_METERS) return 'good for capture';
  if (accuracy <= CAUTION_ACCURACY_METERS) return 'usable / verify';
  return 'poor — wait';
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function degToRad(deg) { return deg * Math.PI / 180; }
