import { REGIONS, CATEGORIES, CAT, downloadRegion, loadAllRegions, siteDetails, siteName, idbGet, idbPut, idbDelete } from './data.js';
import { FAMOUS_LINES } from './famous.js';
import { distance, bearing, gcPole, crossTrack, alongTrack, arcCoords, pointAlong, fmtKm, poissonTailNegLog10, R } from './geo.js';

const APP_VERSION = '0.1.0';
const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const STRICT = { relaxed: 4, balanced: 6, strict: 8 };
const CAT_COLOR = {
  circle: '#8b3fa8', stone: '#6a4fb8', mound: '#8a6a3a', rock: '#b5523b', rune: '#4058b0', arch: '#9c6b2f',
  church: '#2f6f8f', mosque: '#2a8f78', temple: '#c0577f', fort: '#5a5a5a', spring: '#2b8fc4', mountain: '#4f7a3a',
  grove: '#2f7d3a', cave: '#6d5a4a', ruin: '#8b8b7a', grave: '#77746b', battle: '#a33a2a', monument: '#8a8a5a',
};

// ---------------------------------------------------------------- state
const DEFAULTS = {
  tolKm: 1, lenKm: 50, strictness: 'balanced', minSites: 5,
  cats: CATEGORIES.filter(c => c.core).map(c => c.id),
  location: 'on',
  globe: true,
};
const S = {
  settings: load('settings', DEFAULTS),
  regions: [], sites: [], byId: new Map(), lines: [], lineById: new Map(),
  userPos: null, watchId: null,
  tab: 'lines', detail: null, // {kind:'site'|'line'|'famous', id}
  linesFilter: { country: 'all', near: 0, minSites: 5, sort: 'strength', limit: 60 },
  sitesFilter: { text: '', country: 'all', cats: new Set(), near: 0, limit: 80 },
  discover: { picking: null, a: null, b: null, extend: 'between', result: null },
  myLines: load('myLines', []),
  busy: { download: null, detect: null, offline: null },
  installPrompt: null,
};
S.settings = { ...DEFAULTS, ...S.settings };

function load(key, fallback) { try { const v = localStorage.getItem('lf:' + key); return v ? JSON.parse(v) : structuredClone(fallback); } catch { return structuredClone(fallback); } }
function save(key, v) { try { localStorage.setItem('lf:' + key, JSON.stringify(v)); } catch { /* private mode */ } }

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/å/g, 'a');
const regionName = code => REGIONS.find(r => r.code === code)?.name || code;

let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------------------------------------------------------------- map
const map = new maplibregl.Map({
  container: 'map', style: STYLE_URL, center: [40, 25], zoom: 1.4,
  attributionControl: { compact: true }, maxPitch: 70,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
map.addControl(new maplibregl.ScaleControl({ maxWidth: 90 }), 'bottom-left');

let mapReady = false;
map.on('style.load', () => {
  applyProjection();
  addLayers();
  mapReady = true;
  refreshMapData();
});

function applyProjection() {
  try { map.setProjection({ type: S.settings.globe ? 'globe' : 'mercator' }); } catch { /* older engines */ }
  $('#btnGlobe').setAttribute('aria-pressed', String(!!S.settings.globe));
}

const empty = () => ({ type: 'FeatureCollection', features: [] });
function addLayers() {
  for (const id of ['sites', 'lines', 'famous', 'famousStops', 'discover', 'me', 'selSite']) map.addSource(id, { type: 'geojson', data: empty() });
  const ley = getComputedStyle(document.documentElement).getPropertyValue('--ley').trim() || '#b8740f';
  map.addLayer({ id: 'famous-line', type: 'line', source: 'famous', paint: { 'line-color': ley, 'line-width': 2.2, 'line-dasharray': [2, 1.5], 'line-opacity': 0.85 } });
  map.addLayer({ id: 'lines-glow', type: 'line', source: 'lines', paint: { 'line-color': ley, 'line-opacity': 0.18, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 3, 10, 9] } });
  map.addLayer({
    id: 'lines', type: 'line', source: 'lines', layout: { 'line-cap': 'round' },
    paint: {
      'line-color': ['case', ['boolean', ['get', 'sel'], false], '#1e2a2a', ley],
      'line-width': ['interpolate', ['linear'], ['zoom'], 3, ['case', ['boolean', ['get', 'sel'], false], 3, 1.2], 10, ['case', ['boolean', ['get', 'sel'], false], 5, 2.6]],
      'line-opacity': ['interpolate', ['linear'], ['get', 'strength'], 4, 0.55, 10, 1],
    },
  });
  map.addLayer({ id: 'discover-line', type: 'line', source: 'discover', paint: { 'line-color': '#2c6b5a', 'line-width': 3, 'line-dasharray': [1.5, 1] } });
  map.addLayer({
    id: 'sites', type: 'circle', source: 'sites',
    paint: {
      'circle-color': ['match', ['get', 'cat'], ...Object.entries(CAT_COLOR).flat(), '#777'],
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, ['*', 0.5, ['get', 'w']], 9, ['+', 2, ['get', 'w']], 15, ['+', 5, ['*', 1.4, ['get', 'w']]]],
      'circle-stroke-color': '#ffffff', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, 0, 9, 1],
      'circle-opacity': ['case', ['boolean', ['get', 'on'], false], 1, 0.35],
    },
  });
  map.addLayer({
    id: 'site-labels', type: 'symbol', source: 'sites', minzoom: 11.5, filter: ['!=', ['get', 'name'], ''],
    layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true },
    paint: { 'text-color': '#1e2a2a', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 },
  });
  map.addLayer({ id: 'famous-stops', type: 'circle', source: 'famousStops', paint: { 'circle-color': ley, 'circle-radius': 5, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
  map.addLayer({ id: 'sel-site', type: 'circle', source: 'selSite', paint: { 'circle-radius': 14, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#1e2a2a', 'circle-stroke-width': 2.5 } });
  map.addLayer({ id: 'me-acc', type: 'circle', source: 'me', paint: { 'circle-radius': 18, 'circle-color': '#2b7fff', 'circle-opacity': 0.15 } });
  map.addLayer({ id: 'me', type: 'circle', source: 'me', paint: { 'circle-radius': 7, 'circle-color': '#2b7fff', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } });
}

function setData(id, data) { const src = mapReady && map.getSource(id); if (src) src.setData(data); }

function refreshMapData() {
  if (!mapReady) return;
  const on = new Set(S.settings.cats);
  setData('sites', {
    type: 'FeatureCollection',
    features: S.sites.map(s => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: { id: s.id, cat: s.cat, w: s.w, name: s.name, on: on.has(s.cat) } })),
  });
  drawLines();
  setData('famous', { type: 'FeatureCollection', features: FAMOUS_LINES.map(f => ({ type: 'Feature', properties: { id: f.id }, geometry: { type: 'LineString', coordinates: f.stops.map(s => [s[2], s[1]]) } })) });
  setData('famousStops', { type: 'FeatureCollection', features: FAMOUS_LINES.flatMap(f => f.stops.map((s, i) => ({ type: 'Feature', properties: { fid: f.id, i, name: s[0] }, geometry: { type: 'Point', coordinates: [s[2], s[1]] } }))) });
  drawDiscover();
  drawMe();
}

function lineCoords(l) {
  const pole = gcPole(l.a[0], l.a[1], l.b[0], l.b[1]);
  return arcCoords(pole, l.a[0], l.a[1], 0, l.lengthKm, 2);
}
function drawLines() {
  const selId = S.detail?.kind === 'line' ? S.detail.id : null;
  setData('lines', {
    type: 'FeatureCollection',
    features: S.lines.map(l => ({ type: 'Feature', properties: { id: l.id, strength: l.strength, sel: l.id === selId }, geometry: { type: 'MultiLineString', coordinates: lineCoords(l) } })),
  });
}
function drawMe() {
  setData('me', S.userPos ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [S.userPos.lon, S.userPos.lat] } }] } : empty());
}
function drawSelSite() {
  const s = S.detail?.kind === 'site' ? S.byId.get(S.detail.id) : null;
  setData('selSite', s ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } }] } : empty());
}

function mapPadding() {
  const wide = window.innerWidth >= 900;
  return wide ? { top: 80, bottom: 40, left: 440, right: 70 } : { top: 110, bottom: Math.round(window.innerHeight * 0.4), left: 30, right: 70 };
}
function flyToSite(s) { map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 13), padding: mapPadding(), speed: 1.6 }); }
function fitPoints(pts) {
  if (!pts.length) return;
  const b = new maplibregl.LngLatBounds([pts[0][1], pts[0][0]], [pts[0][1], pts[0][0]]);
  for (const p of pts) b.extend([p[1], p[0]]);
  map.fitBounds(b, { padding: mapPadding(), maxZoom: 14, duration: 900 });
}

map.on('click', (e) => {
  const box = [[e.point.x - 10, e.point.y - 10], [e.point.x + 10, e.point.y + 10]];
  const layers = ['sites', 'famous-stops', 'lines', 'famous-line'].filter(l => map.getLayer(l));
  const feats = map.queryRenderedFeatures(box, { layers });
  const site = feats.find(f => f.layer.id === 'sites');
  if (S.discover.picking) {
    if (site) pickDiscover(site.properties.id); else toast('Tap one of the coloured site dots');
    return;
  }
  if (site) return openDetail({ kind: 'site', id: site.properties.id });
  const stop = feats.find(f => f.layer.id === 'famous-stops' || f.layer.id === 'famous-line');
  if (stop) return openDetail({ kind: 'famous', id: stop.properties.fid || stop.properties.id });
  const line = feats.find(f => f.layer.id === 'lines');
  if (line) return openDetail({ kind: 'line', id: line.properties.id });
});
for (const l of ['sites', 'lines', 'famous-stops', 'famous-line']) {
  map.on('mouseenter', l, () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', l, () => { map.getCanvas().style.cursor = ''; });
}

$('#btnGlobe').addEventListener('click', () => {
  S.settings.globe = !S.settings.globe; save('settings', S.settings); applyProjection();
  if (S.settings.globe && map.getZoom() > 5) map.easeTo({ zoom: 2.2, duration: 1200 });
});

// ---------------------------------------------------------------- location (only while the app is open)
function startLocation() {
  if (!('geolocation' in navigator) || S.watchId != null || S.settings.location !== 'on' || document.hidden) return;
  S.watchId = navigator.geolocation.watchPosition(
    (p) => { const first = !S.userPos; S.userPos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }; drawMe(); if (first) renderPanel(); },
    (err) => { if (err.code === 1) { S.settings.location = 'off'; save('settings', S.settings); toast('Location is blocked. You can allow it in your browser settings.'); stopLocation(); renderPanel(); } },
    { enableHighAccuracy: false, maximumAge: 30000, timeout: 20000 });
}
function stopLocation() { if (S.watchId != null) navigator.geolocation.clearWatch(S.watchId); S.watchId = null; }
document.addEventListener('visibilitychange', () => { if (document.hidden) stopLocation(); else startLocation(); });
window.addEventListener('pagehide', stopLocation);

$('#btnLocate').addEventListener('click', () => {
  if (S.settings.location !== 'on') { S.settings.location = 'on'; save('settings', S.settings); startLocation(); renderPanel(); }
  if (S.userPos) map.flyTo({ center: [S.userPos.lon, S.userPos.lat], zoom: Math.max(map.getZoom(), 10), padding: mapPadding() });
  else toast('Finding where you are…');
});

function distToLine(l, lat, lon) {
  const pole = gcPole(l.a[0], l.a[1], l.b[0], l.b[1]);
  const t = alongTrack(pole, l.a[0], l.a[1], lat, lon);
  if (t >= 0 && t <= l.lengthKm) return crossTrack(pole, lat, lon);
  return Math.min(distance(lat, lon, l.a[0], l.a[1]), distance(lat, lon, l.b[0], l.b[1]));
}

// ---------------------------------------------------------------- data + detection
function setRegions(records) {
  S.regions = records;
  S.sites = records.flatMap(r => r.sites);
  S.byId = new Map(S.sites.map(s => [s.id, s]));
  refreshMapData();
}

let worker, jobNo = 0;
function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./leys-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = onWorker;
  }
  return worker;
}
function detectionKey() {
  const s = S.settings;
  return 'lines:' + JSON.stringify([APP_VERSION, s.tolKm, s.lenKm, s.strictness, s.minSites, [...s.cats].sort(), S.regions.map(r => r.code + r.fetchedAt)]);
}
async function runDetection() {
  if (!S.sites.length) { S.lines = []; S.lineById.clear(); drawLines(); renderPanel(); return; }
  const key = detectionKey();
  const cached = await idbGet('details', key).catch(() => null);
  if (cached) { setLines(cached.lines); return; }
  const on = new Set(S.settings.cats);
  const input = S.sites.filter(s => on.has(s.cat)).map(s => ({ id: s.id, lat: s.lat, lon: s.lon, w: s.w }));
  const job = ++jobNo;
  S.busy.detect = { job, key, p: 0 };
  renderPanel();
  getWorker().postMessage({
    type: 'detect', job,
    sites: input,
    params: { tolKm: S.settings.tolKm, lenKm: S.settings.lenKm, minSites: S.settings.minSites, threshold: STRICT[S.settings.strictness] ?? 6 },
  });
}
function onWorker(e) {
  const m = e.data;
  if (!S.busy.detect || m.job !== S.busy.detect.job) return;
  if (m.type === 'progress') {
    S.busy.detect.p = m.p;
    const bar = $('#detectBar'); if (bar) bar.style.width = Math.round(m.p * 100) + '%';
  } else if (m.type === 'done') {
    const key = S.busy.detect.key; S.busy.detect = null;
    idbPut('details', { id: key, lines: m.lines }).catch(() => {});
    setLines(m.lines);
  } else if (m.type === 'error') {
    S.busy.detect = null; toast('Could not calculate the lines: ' + m.message); renderPanel();
  }
}
function stars(strength) { return strength >= 12 ? 5 : strength >= 10 ? 4 : strength >= 8 ? 3 : strength >= 6 ? 2 : 1; }
function starText(n) { return '★'.repeat(n) + '☆'.repeat(5 - n); }

function setLines(raw) {
  S.lines = raw.map((l, i) => {
    const sites = l.siteIds.map(id => S.byId.get(id)).filter(Boolean);
    const anchors = (l.placeAnchors || l.siteIds).map(id => S.byId.get(id)).filter(Boolean);
    const named = anchors.filter(s => s.name).sort((a, b) => b.w - a.w);
    const pick = [];
    for (const s of named) { if (!pick.some(p => p.name === s.name)) pick.push(s); if (pick.length === 2) break; }
    const pole = gcPole(l.a[0], l.a[1], l.b[0], l.b[1]);
    pick.sort((p, q) => alongTrack(pole, l.a[0], l.a[1], p.lat, p.lon) - alongTrack(pole, l.a[0], l.a[1], q.lat, q.lon));
    const name = pick.length === 2 ? `${pick[0].name} – ${pick[1].name}` : pick.length === 1 ? `${pick[0].name} line` : `Unnamed line ${i + 1}`;
    const cc = [...new Set(sites.map(s => s.cc))];
    return { ...l, id: 'L' + i, name, cc, sites, anchors, stars: stars(l.strength), search: norm(name + ' ' + sites.map(s => s.name).join(' ')) };
  });
  S.lineById = new Map(S.lines.map(l => [l.id, l]));
  drawLines();
  renderPanel();
}

async function downloadRegions(codes) {
  for (const code of codes) {
    const region = REGIONS.find(r => r.code === code);
    S.busy.download = { code, msg: `Starting ${region.name}…` }; renderPanel();
    try {
      const rec = await downloadRegion(region, (msg) => { S.busy.download = { code, msg }; renderPanel(); });
      const others = S.regions.filter(r => r.code !== code);
      setRegions([...others, rec]);
      toast(`${region.name}: ${rec.sites.length.toLocaleString()} sites saved for offline use`);
    } catch (err) {
      toast(`Couldn't download ${region.name}. ${navigator.onLine ? 'The map server is busy, try again in a minute.' : 'You are offline.'}`, 5000);
    }
  }
  S.busy.download = null;
  runDetection();
}

// ---------------------------------------------------------------- sheet + tabs
const sheet = $('#sheet');
$('#grabber').addEventListener('click', () => {
  const order = ['peek', 'half', 'full'];
  sheet.dataset.size = order[(order.indexOf(sheet.dataset.size) + 1) % order.length];
});
function sheetAtLeast(size) {
  const order = ['peek', 'half', 'full'];
  if (order.indexOf(sheet.dataset.size) < order.indexOf(size)) sheet.dataset.size = size;
}
for (const b of document.querySelectorAll('.tabs button')) {
  b.addEventListener('click', () => { S.tab = b.dataset.tab; S.detail = null; drawLines(); drawSelSite(); renderPanel(); $('#panel').scrollTop = 0; });
}
function openDetail(d) {
  S.detail = d; drawLines(); drawSelSite();
  if (d.kind === 'site') { const s = S.byId.get(d.id); if (s) flyToSite(s); }
  if (d.kind === 'line') { const l = S.lineById.get(d.id); if (l) fitPoints([l.a, l.b]); }
  if (d.kind === 'famous') { const f = FAMOUS_LINES.find(x => x.id === d.id); if (f) fitPoints(f.stops.map(s => [s[1], s[2]])); }
  sheetAtLeast('half');
  renderPanel(); $('#panel').scrollTop = 0;
}
function closeDetail() { S.detail = null; drawLines(); drawSelSite(); renderPanel(); }

function renderPanel() {
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === S.tab));
  const p = $('#panel');
  if (S.detail?.kind === 'site') return renderSiteDetail(p);
  if (S.detail?.kind === 'line') return renderLineDetail(p);
  if (S.detail?.kind === 'famous') return renderFamous(p);
  ({ lines: renderLines, sites: renderSites, discover: renderDiscover, data: renderData })[S.tab](p);
}

const ICON_LINE = '<svg viewBox="0 0 24 24" fill="none" stroke="var(--ley)" stroke-width="2" stroke-linecap="round"><path d="M3 18 L21 6"/><circle cx="7" cy="15.3" r="1.8" fill="var(--ley)"/><circle cx="12" cy="12" r="1.8" fill="var(--ley)"/><circle cx="17" cy="8.7" r="1.8" fill="var(--ley)"/></svg>';
const siteGlyph = cat => `<span class="glyph"><span class="dot" style="background:${CAT_COLOR[cat]};width:12px;height:12px"></span></span>`;

function statusBlock() {
  let html = '';
  if (S.busy.download) html += `<div class="note ley stack"><b>Downloading sacred sites</b><span class="small">${esc(S.busy.download.msg)}</span></div>`;
  if (S.busy.detect) html += `<div class="note stack"><span class="small">Looking for alignments among ${S.sites.length.toLocaleString()} sites…</span><div class="progress"><i id="detectBar" style="width:${Math.round(S.busy.detect.p * 100)}%"></i></div></div>`;
  return html;
}

function countryOptions(sel, extra = '') {
  return `<option value="all"${sel === 'all' ? ' selected' : ''}>All countries</option>${extra}` +
    REGIONS.map(r => `<option value="${r.code}"${sel === r.code ? ' selected' : ''}${S.regions.some(x => x.code === r.code) ? '' : ' disabled'}>${r.name}</option>`).join('');
}
const NEAR_OPTS = [[0, 'Anywhere'], [10, 'Within 10 km'], [25, 'Within 25 km'], [100, 'Within 100 km'], [500, 'Within 500 km']];
function nearSelect(id, val) {
  return `<select id="${id}">${NEAR_OPTS.map(([v, t]) => `<option value="${v}"${+val === v ? ' selected' : ''}${v && !S.userPos ? ' disabled' : ''}>${t}</option>`).join('')}</select>`;
}

// ----- Lines tab
function filteredLines() {
  const f = S.linesFilter;
  let ls = S.lines.filter(l => l.places >= f.minSites && (f.country === 'all' || l.cc.includes(f.country)));
  if (f.near && S.userPos) ls = ls.filter(l => distToLine(l, S.userPos.lat, S.userPos.lon) <= f.near);
  const sorters = {
    strength: (a, b) => b.strength - a.strength,
    sites: (a, b) => b.places - a.places || b.strength - a.strength,
    length: (a, b) => b.lengthKm - a.lengthKm,
    near: (a, b) => S.userPos ? distToLine(a, S.userPos.lat, S.userPos.lon) - distToLine(b, S.userPos.lat, S.userPos.lon) : 0,
  };
  return ls.sort(sorters[f.sort] || sorters.strength);
}
function renderLines(p) {
  const f = S.linesFilter;
  if (!S.regions.length && !S.busy.download) {
    p.innerHTML = `
      <h2>Welcome, ley hunter</h2>
      <p class="muted">The app finds straight alignments between stone circles, burial mounds, old churches, sacred springs and other ancient places. Start by saving the sites for a country to your device. After that, everything works offline.</p>
      <div class="row"><button class="btn primary" data-dl="DK,AU">Download Denmark and Australia</button></div>
      <h3>Famous lines</h3>${famousList()}`;
    p.querySelector('[data-dl]').onclick = (e) => downloadRegions(e.target.dataset.dl.split(','));
    bindFamous(p);
    return;
  }
  const ls = filteredLines();
  p.innerHTML = `${statusBlock()}
    <div class="grid2">
      <div class="field"><label for="lf-country">Country</label><select id="lf-country">${countryOptions(f.country)}</select></div>
      <div class="field"><label for="lf-near">Distance from me</label>${nearSelect('lf-near', f.near)}</div>
      <div class="field"><label for="lf-min">At least <b id="lf-min-v">${f.minSites}</b> sites on the line</label><input id="lf-min" type="range" min="${S.settings.minSites}" max="20" value="${f.minSites}"></div>
      <div class="field"><label for="lf-sort">Sort by</label><select id="lf-sort">
        ${[['strength', 'Strongest alignment'], ['sites', 'Most sites'], ['length', 'Longest'], ['near', 'Nearest to me']].map(([v, t]) => `<option value="${v}"${f.sort === v ? ' selected' : ''}${v === 'near' && !S.userPos ? ' disabled' : ''}>${t}</option>`).join('')}
      </select></div>
    </div>
    <h3>${ls.length.toLocaleString()} ley line${ls.length === 1 ? '' : 's'} found</h3>
    <div class="list">${ls.slice(0, f.limit).map(l => `
      <button class="item" data-line="${l.id}">
        <span class="glyph ley">${ICON_LINE}</span>
        <span class="title">${esc(l.name)}</span>
        <span class="stars" aria-label="${l.stars} of 5">${starText(l.stars)}</span>
        <span class="sub">${l.places} sites · ${fmtKm(l.lengthKm)} · ${l.cc.map(regionName).join(', ')}${S.userPos ? ' · ' + fmtKm(distToLine(l, S.userPos.lat, S.userPos.lon)) + ' from you' : ''}</span>
      </button>`).join('')}</div>
    ${ls.length > f.limit ? `<button class="btn" id="lf-more">Show more</button>` : ''}
    ${!ls.length && !S.busy.detect ? `<p class="muted small">No lines match. Try fewer sites per line, a larger distance, or “Show more lines” under Offline &amp; settings.</p>` : ''}
    <h3>Famous lines</h3>${famousList()}`;
  const upd = () => { renderPanel(); };
  $('#lf-country').onchange = e => { f.country = e.target.value; f.limit = 60; upd(); };
  $('#lf-near').onchange = e => { f.near = +e.target.value; f.limit = 60; upd(); };
  $('#lf-sort').onchange = e => { f.sort = e.target.value; upd(); };
  $('#lf-min').oninput = e => { $('#lf-min-v').textContent = e.target.value; };
  $('#lf-min').onchange = e => { f.minSites = +e.target.value; f.limit = 60; upd(); };
  const more = $('#lf-more'); if (more) more.onclick = () => { f.limit += 60; upd(); };
  p.querySelectorAll('[data-line]').forEach(b => b.onclick = () => openDetail({ kind: 'line', id: b.dataset.line }));
  bindFamous(p);
}
function famousList() {
  return `<div class="list">${FAMOUS_LINES.map(fl => `
    <button class="item" data-famous="${fl.id}"><span class="glyph ley">${ICON_LINE}</span>
    <span class="title">${esc(fl.name)}</span><span class="meta">${fl.stops.length} places</span>
    <span class="sub">${esc(fl.country)} · traditional line</span></button>`).join('')}</div>`;
}
function bindFamous(p) { p.querySelectorAll('[data-famous]').forEach(b => b.onclick = () => openDetail({ kind: 'famous', id: b.dataset.famous })); }

// ----- Line detail
function renderLineDetail(p) {
  const l = S.lineById.get(S.detail.id);
  if (!l) return closeDetail();
  const pole = gcPole(l.a[0], l.a[1], l.b[0], l.b[1]);
  const ordered = l.sites.slice().sort((x, y) => alongTrack(pole, l.a[0], l.a[1], x.lat, x.lon) - alongTrack(pole, l.a[0], l.a[1], y.lat, y.lon));
  const mid = pointAlong(pole, l.a[0], l.a[1], l.lengthKm / 2);
  const brg = bearing(l.a[0], l.a[1], l.b[0], l.b[1]);
  const earth = `https://earth.google.com/web/@${mid[0].toFixed(5)},${mid[1].toFixed(5)},0a,${Math.round(l.lengthKm * 1600)}d,35y,${Math.round(brg)}h,0t,0r`;
  p.innerHTML = `
    <button class="back" id="back">‹ Back</button>
    <h2>${esc(l.name)}</h2>
    <div class="stars" style="font-size:16px">${starText(l.stars)} <span class="muted small">alignment strength</span></div>
    <div class="stat">
      <div><b>${l.places}</b><span>places on the line</span></div>
      <div><b>${fmtKm(l.lengthKm)}</b><span>long</span></div>
      <div><b>${Math.round(brg)}°</b><span>compass bearing</span></div>
    </div>
    <p class="small muted">${strengthExplain(l)}</p>
    <div class="row">
      <a class="btn ley" href="${earth}" target="_blank" rel="noopener">Google Earth</a>
      <button class="btn" id="kml">Save for Google Earth</button>
      <a class="btn" href="${directionsUrl(ordered)}" target="_blank" rel="noopener">Route in Google Maps</a>
    </div>
    <h3>Along the line</h3>
    <div class="list">${ordered.map(s => siteItem(s, `${fmtKm(crossTrack(pole, s.lat, s.lon))} off the line`)).join('')}</div>`;
  $('#back').onclick = closeDetail;
  $('#kml').onclick = () => saveKml(l.name, ordered, [lineCoords(l)]);
  bindSiteItems(p);
}
function strengthExplain(l) {
  return `${starText(l.stars).replace(/☆/g, '')} means these ${l.places} places line up within ${fmtKm(S.settings.tolKm)} of a straight line far more often than chance would give, compared with how crowded the land around it is. Roads, rivers and coastlines can also line places up, so treat every line as a lead to explore.`;
}
function directionsUrl(sites) {
  if (sites.length < 2) return '#';
  const a = sites[0], b = sites[sites.length - 1];
  const mids = sites.slice(1, -1);
  const step = Math.max(1, Math.ceil(mids.length / 8));
  const way = mids.filter((_, i) => i % step === 0).slice(0, 8).map(s => `${s.lat},${s.lon}`).join('|');
  return `https://www.google.com/maps/dir/?api=1&origin=${a.lat},${a.lon}&destination=${b.lat},${b.lon}${way ? '&waypoints=' + encodeURIComponent(way) : ''}`;
}

// ----- Famous line detail
function renderFamous(p) {
  const f = FAMOUS_LINES.find(x => x.id === S.detail.id);
  if (!f) return closeDetail();
  const a = f.stops[0], b = f.stops[f.stops.length - 1];
  const len = distance(a[1], a[2], b[1], b[2]);
  p.innerHTML = `
    <button class="back" id="back">‹ Back</button>
    <h2>${esc(f.name)}</h2>
    <p class="muted small">${esc(f.country)} · traditional line · ${fmtKm(len)} end to end</p>
    <p>${esc(f.note)}</p>
    <div class="row">
      <button class="btn" id="kml">Save for Google Earth</button>
    </div>
    <h3>Places on the line</h3>
    <div class="list">${f.stops.map(s => `
      <div class="item"><span class="glyph ley">${ICON_LINE}</span><span class="title">${esc(s[0])}</span><span class="meta mono">${s[1].toFixed(3)}, ${s[2].toFixed(3)}</span>
      <span class="sub"><a href="https://www.google.com/maps/search/?api=1&query=${s[1]},${s[2]}" target="_blank" rel="noopener">Google Maps</a> · <a href="https://earth.google.com/web/@${s[1]},${s[2]},300a,2500d,35y,0h,55t,0r" target="_blank" rel="noopener">Google Earth</a></span></div>`).join('')}</div>
    <p class="small muted" style="margin-top:12px">Positions are approximate and follow the route as tradition describes it.</p>`;
  $('#back').onclick = closeDetail;
  $('#kml').onclick = () => saveKml(f.name, f.stops.map(s => ({ name: s[0], lat: s[1], lon: s[2], cat: 'arch' })), [[f.stops.map(s => [s[2], s[1]])]]);
}

// ----- Sites tab
function filteredSites() {
  const f = S.sitesFilter, q = norm(f.text);
  let ss = S.sites;
  if (f.country !== 'all') ss = ss.filter(s => s.cc === f.country);
  if (f.cats.size) ss = ss.filter(s => f.cats.has(s.cat));
  if (q) ss = ss.filter(s => norm(s.name).includes(q));
  if (S.userPos) {
    const withD = ss.map(s => [s, distance(S.userPos.lat, S.userPos.lon, s.lat, s.lon)]);
    return withD.filter(([, d]) => !f.near || d <= f.near).sort((a, b) => a[1] - b[1]);
  }
  return ss.slice().sort((a, b) => b.w - a.w || (a.name ? 0 : 1) - (b.name ? 0 : 1)).map(s => [s, null]);
}
function renderSites(p) {
  const f = S.sitesFilter;
  if (!S.regions.length && !S.busy.download) { S.tab = 'lines'; return renderLines(p); }
  const counts = {}; for (const s of S.sites) if (f.country === 'all' || s.cc === f.country) counts[s.cat] = (counts[s.cat] || 0) + 1;
  const list = filteredSites();
  p.innerHTML = `${statusBlock()}
    <div class="field"><label for="sf-text">Name</label><input id="sf-text" type="search" placeholder="e.g. Jelling, Uluru, kirke" value="${esc(f.text)}"></div>
    <div class="grid2" style="margin-top:10px">
      <div class="field"><label for="sf-country">Country</label><select id="sf-country">${countryOptions(f.country)}</select></div>
      <div class="field"><label for="sf-near">Distance from me</label>${nearSelect('sf-near', f.near)}</div>
    </div>
    <h3>Type of site</h3>
    <div class="chips">${CATEGORIES.filter(c => counts[c.id]).map(c => `<button class="chip" data-cat="${c.id}" aria-pressed="${f.cats.has(c.id)}"><span class="dot" style="background:${CAT_COLOR[c.id]}"></span>${c.label} <span class="muted">${counts[c.id].toLocaleString()}</span></button>`).join('')}</div>
    <h3>${list.length.toLocaleString()} site${list.length === 1 ? '' : 's'}${S.userPos ? ', nearest first' : ''}</h3>
    <div class="list">${list.slice(0, f.limit).map(([s, d]) => siteItem(s, d != null ? fmtKm(d) + ' away' : null)).join('')}</div>
    ${list.length > f.limit ? `<button class="btn" id="sf-more">Show more</button>` : ''}`;
  let t;
  $('#sf-text').oninput = e => { clearTimeout(t); t = setTimeout(() => { f.text = e.target.value; f.limit = 80; renderPanel(); const i = $('#sf-text'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 250); };
  $('#sf-country').onchange = e => { f.country = e.target.value; f.limit = 80; renderPanel(); };
  $('#sf-near').onchange = e => { f.near = +e.target.value; f.limit = 80; renderPanel(); };
  p.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { const c = b.dataset.cat; f.cats.has(c) ? f.cats.delete(c) : f.cats.add(c); f.limit = 80; renderPanel(); });
  const more = $('#sf-more'); if (more) more.onclick = () => { f.limit += 80; renderPanel(); };
  bindSiteItems(p);
}
function siteItem(s, meta) {
  return `<button class="item" data-site="${esc(s.id)}">${siteGlyph(s.cat)}<span class="title">${esc(siteName(s))}</span>
    <span class="meta">${meta ? esc(meta) : ''}</span><span class="sub">${CAT[s.cat].label} · ${regionName(s.cc)}</span></button>`;
}
function bindSiteItems(p) { p.querySelectorAll('[data-site]').forEach(b => b.onclick = () => openDetail({ kind: 'site', id: b.dataset.site })); }

// ----- Site detail
function renderSiteDetail(p) {
  const s = S.byId.get(S.detail.id);
  if (!s) return closeDetail();
  const through = S.lines.filter(l => l.siteIds.includes(s.id));
  const dist = S.userPos ? distance(S.userPos.lat, S.userPos.lon, s.lat, s.lon) : null;
  p.innerHTML = `
    <button class="back" id="back">‹ Back</button>
    <h2>${esc(siteName(s))}</h2>
    <p class="muted small"><span class="dot" style="display:inline-block;background:${CAT_COLOR[s.cat]}"></span> ${CAT[s.cat].label} · ${regionName(s.cc)}${dist != null ? ' · ' + fmtKm(dist) + ' from you' : ''}</p>
    <div id="photo"></div>
    <div id="summary"></div>
    <div class="row" style="margin:10px 0">
      <a class="btn primary" href="https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lon}" target="_blank" rel="noopener">Google Maps</a>
      <a class="btn" href="https://earth.google.com/web/@${s.lat},${s.lon},300a,1200d,35y,0h,55t,0r" target="_blank" rel="noopener">Google Earth</a>
      ${s.name ? `<a class="btn" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.name)}" target="_blank" rel="noopener">Photos on Google</a>` : ''}
      <button class="btn" id="fromHere">Start a line here</button>
    </div>
    <p class="mono muted">${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}</p>
    ${s.t?.start_date ? `<p class="small">Dated: ${esc(s.t.start_date)}</p>` : ''}
    ${s.t?.description ? `<p class="small">${esc(s.t.description)}</p>` : ''}
    <h3>${through.length ? `On ${through.length} ley line${through.length > 1 ? 's' : ''}` : 'Ley lines'}</h3>
    ${through.length ? `<div class="list">${through.map(l => `<button class="item" data-line="${l.id}"><span class="glyph ley">${ICON_LINE}</span><span class="title">${esc(l.name)}</span><span class="stars">${starText(l.stars)}</span><span class="sub">${l.places} sites · ${fmtKm(l.lengthKm)}</span></button>`).join('')}</div>`
      : `<p class="muted small">No ley line passes through this site with the current settings. Try “Start a line here” to look for one yourself.</p>`}
    <p class="small muted" style="margin-top:14px">Data: <a href="https://www.openstreetmap.org/${{ n: 'node', w: 'way', r: 'relation' }[s.id[0]]}/${s.id.slice(1)}" target="_blank" rel="noopener">OpenStreetMap</a>${s.t?.wikidata ? ` · <a href="https://www.wikidata.org/wiki/${esc(s.t.wikidata)}" target="_blank" rel="noopener">Wikidata</a>` : ''}</p>`;
  $('#back').onclick = closeDetail;
  $('#fromHere').onclick = () => { S.tab = 'discover'; S.detail = null; S.discover = { ...S.discover, a: s.id, b: null, result: null, picking: 'b' }; renderPanel(); updateDiscoverBar(); drawDiscover(); };
  p.querySelectorAll('[data-line]').forEach(b => b.onclick = () => openDetail({ kind: 'line', id: b.dataset.line }));
  const id = s.id;
  siteDetails(s).then(d => {
    if (S.detail?.id !== id) return;
    if (d.image) $('#photo').innerHTML = `<img class="photo" src="${esc(d.image)}" alt="Photo of ${esc(siteName(s))}" loading="lazy" onerror="this.parentNode.innerHTML=''"><div class="credit">Photo: <a href="${esc(d.imagePage || '#')}" target="_blank" rel="noopener">Wikimedia Commons</a>, see page for author and licence</div>`;
    if (d.summary) $('#summary').innerHTML = `<p style="margin-top:10px">${esc(d.summary)}</p>${d.wikiUrl ? `<p class="small"><a href="${esc(d.wikiUrl)}" target="_blank" rel="noopener">Read more on Wikipedia</a></p>` : ''}`;
  });
}

// ----- Discover tab
function updateDiscoverBar() {
  const bar = $('#discoverBar');
  const d = S.discover;
  if (!d.picking) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.innerHTML = `<span>${d.picking === 'a' ? 'Tap the first site on the map' : 'Now tap the second site'}</span><button id="cancelPick">Cancel</button>`;
  $('#cancelPick').onclick = () => { S.discover.picking = null; updateDiscoverBar(); renderPanel(); };
  if (window.innerWidth < 900) sheet.dataset.size = 'peek';
}
function pickDiscover(id) {
  const d = S.discover;
  if (d.picking === 'a') { d.a = id; d.b = null; d.picking = 'b'; toast(`First: ${siteName(S.byId.get(id))}`); }
  else if (d.picking === 'b') {
    if (id === d.a) { toast('Pick a different site'); return; }
    d.b = id; d.picking = null; computeDiscover(); sheetAtLeast('half');
  }
  updateDiscoverBar(); drawDiscover(); renderPanel();
}
function computeDiscover() {
  const d = S.discover, A = S.byId.get(d.a), B = S.byId.get(d.b);
  if (!A || !B) { d.result = null; return; }
  const tol = S.settings.tolKm;
  const pole = gcPole(A.lat, A.lon, B.lat, B.lon);
  const dAB = distance(A.lat, A.lon, B.lat, B.lon);
  const [t0, t1] = d.extend === 'between' ? [0, dAB] : d.extend === 'extend' ? [-dAB, 2 * dAB] : [-Math.PI * R, Math.PI * R];
  const on = new Set(S.settings.cats);
  const hits = []; let side = 0;
  for (const s of S.sites) {
    if (!on.has(s.cat)) continue;
    const x = crossTrack(pole, s.lat, s.lon);
    if (x > tol * 12.5) continue;
    let t = alongTrack(pole, A.lat, A.lon, s.lat, s.lon);
    if (d.extend === 'world') { /* whole circle */ } else if (t < t0 || t > t1) continue;
    if (x <= tol) hits.push({ s, x, t }); else if (x > tol * 2.5) side++;
  }
  hits.sort((p, q) => p.t - q.t);
  const lambda = Math.max(0.3, side * 2 / 20); // side bands are 2 × 10 tolerances wide
  const extra = hits.filter(h => h.s.id !== A.id && h.s.id !== B.id).length;
  d.result = { pole, dAB, t0, t1, hits, expected: lambda, strength: poissonTailNegLog10(extra, lambda) };
}
function drawDiscover() {
  const d = S.discover, A = S.byId.get(d.a);
  if (!A || !d.result) { setData('discover', empty()); return; }
  const r = d.result;
  setData('discover', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: arcCoords(r.pole, A.lat, A.lon, r.t0, r.t1, d.extend === 'world' ? 25 : 1) } }] });
}
function renderDiscover(p) {
  const d = S.discover, A = S.byId.get(d.a), B = S.byId.get(d.b), r = d.result;
  let body = `<h2>Find your own line</h2>
    <p class="muted">Pick any two sites. The app draws the true straight line between them across the curved Earth, and shows every other sacred site within ${fmtKm(S.settings.tolKm)} of it.</p>
    <div class="row"><button class="btn primary" id="dStart">${A ? 'Pick two new sites' : 'Pick two sites on the map'}</button></div>`;
  if (A) body += `<h3>Your line</h3><div class="list">${siteItem(A, 'start')}${B ? siteItem(B, 'end') : ''}</div>`;
  if (r) {
    const extra = r.hits.filter(h => h.s.id !== A.id && h.s.id !== B.id).length;
    body += `
      <div class="field" style="margin-top:12px"><label for="dExt">How far to follow the line</label>
        <select id="dExt">
          <option value="between"${d.extend === 'between' ? ' selected' : ''}>Only between the two sites (${fmtKm(r.dAB)})</option>
          <option value="extend"${d.extend === 'extend' ? ' selected' : ''}>Extend past both ends</option>
          <option value="world"${d.extend === 'world' ? ' selected' : ''}>All the way around the Earth</option>
        </select></div>
      <div class="stat"><div><b>${extra}</b><span>other sites on the line</span></div><div><b>${r.expected.toFixed(1)}</b><span>expected by chance</span></div></div>
      <p class="small muted">${extra > r.expected * 2 && r.strength >= 3 ? 'That is clearly more than chance would give. This looks like a real alignment.' : 'That is about what chance alone would give here.'}</p>
      <div class="row">
        <button class="btn ley" id="dSave">Save this line</button>
        <button class="btn" id="dKml">Save for Google Earth</button>
      </div>
      <h3>Sites on the line</h3>
      <div class="list">${r.hits.map(h => siteItem(h.s, `${fmtKm(h.x)} off`)).join('')}</div>`;
  }
  if (S.myLines.length) {
    body += `<h3>My saved lines</h3><div class="list">${S.myLines.map((m, i) => `<div class="item"><span class="glyph ley">${ICON_LINE}</span><button class="title" style="border:0;background:none;text-align:left;padding:0" data-my="${i}">${esc(m.name)}</button><button class="btn danger" data-del="${i}" style="min-height:32px">Remove</button><span class="sub">${esc(m.extendLabel)}</span></div>`).join('')}</div>`;
  }
  p.innerHTML = body;
  $('#dStart').onclick = () => { S.discover = { ...d, a: null, b: null, result: null, picking: 'a' }; drawDiscover(); updateDiscoverBar(); renderPanel(); };
  const ext = $('#dExt'); if (ext) ext.onchange = e => { d.extend = e.target.value; computeDiscover(); drawDiscover(); renderPanel(); fitDiscover(); };
  const sv = $('#dSave'); if (sv) sv.onclick = () => {
    const name = `${siteName(A)} – ${siteName(B)}`;
    S.myLines.push({ name, a: A.id, b: B.id, extend: d.extend, extendLabel: { between: 'Between the two sites', extend: 'Extended', world: 'Around the Earth' }[d.extend] });
    save('myLines', S.myLines); toast('Saved to My saved lines'); renderPanel();
  };
  const kml = $('#dKml'); if (kml) kml.onclick = () => saveKml(`${siteName(A)} – ${siteName(B)}`, r.hits.map(h => h.s), [arcCoords(r.pole, A.lat, A.lon, r.t0, r.t1, d.extend === 'world' ? 25 : 1)]);
  p.querySelectorAll('[data-my]').forEach(b => b.onclick = () => { const m = S.myLines[+b.dataset.my]; S.discover = { picking: null, a: m.a, b: m.b, extend: m.extend, result: null }; computeDiscover(); drawDiscover(); renderPanel(); fitDiscover(); });
  p.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { S.myLines.splice(+b.dataset.del, 1); save('myLines', S.myLines); renderPanel(); });
  bindSiteItems(p);
}
function fitDiscover() {
  const d = S.discover, r = d.result, A = S.byId.get(d.a);
  if (!r || !A) return;
  if (d.extend === 'world') { map.easeTo({ zoom: 1.6, center: [A.lon, A.lat], duration: 1000 }); return; }
  fitPoints([pointAlong(r.pole, A.lat, A.lon, r.t0), pointAlong(r.pole, A.lat, A.lon, r.t1)]);
}

// ----- Offline & settings tab
function renderData(p) {
  const st = S.settings;
  const regionRows = REGIONS.map(r => {
    const rec = S.regions.find(x => x.code === r.code);
    const busy = S.busy.download?.code === r.code;
    return `<div class="region"><div class="head"><span class="name">${r.name}</span><span class="small muted">${rec ? rec.sites.length.toLocaleString() + ' sites' : 'Not downloaded'}</span></div>
      ${rec ? `<span class="small muted">Saved ${new Date(rec.fetchedAt).toLocaleDateString()}</span>` : ''}
      ${busy ? `<span class="small">${esc(S.busy.download.msg)}</span>` : ''}
      <div class="row"><button class="btn${rec ? '' : ' primary'}" data-dl="${r.code}" ${S.busy.download ? 'disabled' : ''}>${rec ? 'Update' : 'Download'}</button>${rec ? `<button class="btn danger" data-rm="${r.code}">Remove</button>` : ''}</div></div>`;
  }).join('');
  p.innerHTML = `
    <h2>Offline &amp; settings</h2>
    <h3>Countries on this device</h3>
    <div class="stack">${regionRows}</div>
    <p class="small muted" style="margin-top:8px">More countries will be added step by step until the whole planet is covered.</p>

    <h3>Map for offline use</h3>
    <p class="small">Maps you have looked at are kept automatically. To prepare for a trip, zoom the map to the area you need, then save it.</p>
    ${S.busy.offline ? `<div class="progress"><i id="offBar" style="width:${Math.round(S.busy.offline.p * 100)}%"></i></div><p class="small muted">${esc(S.busy.offline.msg)}</p>` : `<button class="btn" id="saveArea">Save the map area I'm looking at</button>`}

    <h3>Location</h3>
    <div class="field"><select id="setLoc">
      <option value="on"${st.location === 'on' ? ' selected' : ''}>On while the app is open</option>
      <option value="off"${st.location === 'off' ? ' selected' : ''}>Off</option>
    </select></div>
    <p class="small muted">Your location never leaves your device. It switches off as soon as you leave the app.</p>

    <h3>How lines are found</h3>
    <div class="grid2">
      <div class="field"><label for="setTol">Sites must be within</label><select id="setTol">
        ${[0.25, 0.5, 1, 2].map(v => `<option value="${v}"${st.tolKm === v ? ' selected' : ''}>${fmtKm(v)} of the line</option>`).join('')}</select></div>
      <div class="field"><label for="setLen">Look for lines up to</label><select id="setLen">
        ${[25, 50, 100].map(v => `<option value="${v}"${st.lenKm === v ? ' selected' : ''}>${v} km long</option>`).join('')}</select></div>
      <div class="field"><label for="setMin">Fewest sites on a line</label><select id="setMin">
        ${[4, 5, 6, 7, 8].map(v => `<option value="${v}"${st.minSites === v ? ' selected' : ''}>${v} sites</option>`).join('')}</select></div>
      <div class="field"><label for="setStrict">Which lines to show</label><select id="setStrict">
        <option value="relaxed"${st.strictness === 'relaxed' ? ' selected' : ''}>More lines (some by chance)</option>
        <option value="balanced"${st.strictness === 'balanced' ? ' selected' : ''}>Balanced</option>
        <option value="strict"${st.strictness === 'strict' ? ' selected' : ''}>Only the strongest</option></select></div>
    </div>
    <h3>Sites that count for lines</h3>
    <div class="chips">${CATEGORIES.map(c => `<button class="chip" data-setcat="${c.id}" aria-pressed="${st.cats.includes(c.id)}"><span class="dot" style="background:${CAT_COLOR[c.id]}"></span>${c.label}</button>`).join('')}</div>
    <p class="small muted" style="margin-top:8px">Graveyards, monuments, ruins and battlefields are very common, so they are off by default to keep chance lines down.</p>

    <h3>Install on your phone</h3>
    ${S.installPrompt ? `<button class="btn primary" id="install">Install the app</button>` :
      `<p class="small">iPhone and iPad: tap the Share button in Safari, then <b>Add to Home Screen</b>. Android: open the browser menu and tap <b>Install app</b> or <b>Add to Home screen</b>.</p>`}

    <h3>About</h3>
    <p class="small">Sites come from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors. Photos and descriptions come from Wikimedia Commons, Wikidata and Wikipedia. Map tiles by <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>. Some indigenous communities keep their sacred places private; this app only shows places that are already publicly mapped.</p>
    <p class="small muted">Version ${APP_VERSION}</p>`;
  p.querySelectorAll('[data-dl]').forEach(b => b.onclick = () => downloadRegions([b.dataset.dl]));
  p.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => {
    if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Tap again to remove'; return; }
    await idbDelete('regions', b.dataset.rm).catch(() => {});
    setRegions(S.regions.filter(r => r.code !== b.dataset.rm)); runDetection();
  });
  const sa = $('#saveArea'); if (sa) sa.onclick = saveVisibleArea;
  $('#setLoc').onchange = e => { st.location = e.target.value; save('settings', st); if (st.location === 'on') startLocation(); else { stopLocation(); S.userPos = null; drawMe(); } };
  const re = () => { save('settings', st); runDetection(); };
  $('#setTol').onchange = e => { st.tolKm = +e.target.value; re(); };
  $('#setLen').onchange = e => { st.lenKm = +e.target.value; re(); };
  $('#setMin').onchange = e => { st.minSites = +e.target.value; S.linesFilter.minSites = Math.max(S.linesFilter.minSites, st.minSites); re(); };
  $('#setStrict').onchange = e => { st.strictness = e.target.value; re(); };
  p.querySelectorAll('[data-setcat]').forEach(b => b.onclick = () => {
    const c = b.dataset.setcat; st.cats = st.cats.includes(c) ? st.cats.filter(x => x !== c) : [...st.cats, c];
    b.setAttribute('aria-pressed', String(st.cats.includes(c)));
    refreshMapData(); re();
  });
  const ins = $('#install'); if (ins) ins.onclick = async () => { S.installPrompt.prompt(); await S.installPrompt.userChoice.catch(() => {}); S.installPrompt = null; renderPanel(); };
}

// ---------------------------------------------------------------- offline map area
async function saveVisibleArea() {
  try {
    const style = map.getStyle();
    const src = Object.values(style.sources).find(s => s.type === 'vector' && s.url);
    const tj = await (await fetch(src.url)).json();
    const tmpl = tj.tiles[0], maxZ = Math.min(14, tj.maxzoom ?? 14);
    const b = map.getBounds();
    const z0 = Math.max(0, Math.floor(map.getZoom()) - 2);
    const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
    const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
    const tiles = [];
    for (let z = z0; z <= maxZ && tiles.length < 3000; z++) {
      const n = 2 ** z;
      const x0 = Math.max(0, lon2x(b.getWest(), z)), x1 = Math.min(n - 1, lon2x(b.getEast(), z));
      const y0 = Math.max(0, lat2y(Math.min(85, b.getNorth()), z)), y1 = Math.min(n - 1, lat2y(Math.max(-85, b.getSouth()), z));
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      if (tiles.length + count > 3000) break;
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push(tmpl.replace('{z}', z).replace('{x}', x).replace('{y}', y));
    }
    let done = 0;
    S.busy.offline = { p: 0, msg: `Saving ${tiles.length.toLocaleString()} map pieces…` }; renderPanel();
    const cache = await caches.open('lf-tiles');
    const queue = tiles.slice();
    await Promise.all([0, 1, 2, 3].map(async () => {
      while (queue.length) {
        const u = queue.shift();
        try { if (!(await cache.match(u))) { const r = await fetch(u); if (r.ok) await cache.put(u, r); } } catch { /* skip */ }
        done++; S.busy.offline.p = done / tiles.length;
        const bar = $('#offBar'); if (bar) bar.style.width = Math.round(S.busy.offline.p * 100) + '%';
      }
    }));
    S.busy.offline = null; toast('This map area is saved for offline use'); renderPanel();
  } catch {
    S.busy.offline = null; toast('Could not save the map area. Check your connection and try again.'); renderPanel();
  }
}

// ---------------------------------------------------------------- Google Earth file (KML)
function saveKml(name, sites, coordParts) {
  const x = s => esc(s);
  const lines = coordParts.flat().map(part => `<Placemark><name>${x(name)}</name><styleUrl>#ley</styleUrl><LineString><tessellate>1</tessellate><coordinates>${part.map(c => `${c[0]},${c[1]},0`).join(' ')}</coordinates></LineString></Placemark>`).join('');
  const pts = sites.map(s => `<Placemark><name>${x(s.name || siteName(s))}</name><description>${x(CAT[s.cat]?.label || '')}</description><Point><coordinates>${s.lon},${s.lat},0</coordinates></Point></Placemark>`).join('');
  const kml = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${x(name)}</name><Style id="ley"><LineStyle><color>ff1f8ad8</color><width>3</width></LineStyle></Style>${lines}${pts}</Document></kml>`;
  const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 60) + '.kml';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Saved. Open the file in Google Earth to see the line.');
}

// ---------------------------------------------------------------- search box
const qEl = $('#q'), resEl = $('#results');
let qTimer;
qEl.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(runSearch, 150); });
qEl.addEventListener('focus', runSearch);
document.addEventListener('click', e => { if (!e.target.closest('.search')) resEl.hidden = true; });
function runSearch() {
  const q = norm(qEl.value.trim());
  if (q.length < 2) { resEl.hidden = true; return; }
  const cats = CATEGORIES.filter(c => norm(c.label).includes(q));
  const countries = REGIONS.filter(r => norm(r.name).includes(q));
  const famous = FAMOUS_LINES.filter(f => norm(f.name + ' ' + f.stops.map(s => s[0]).join(' ')).includes(q));
  const lines = S.lines.filter(l => l.search.includes(q)).sort((a, b) => b.strength - a.strength).slice(0, 6);
  const sites = [];
  for (const s of S.sites) { if (s.name && norm(s.name).includes(q)) { sites.push(s); } }
  sites.sort((a, b) => (norm(a.name).startsWith(q) ? 0 : 1) - (norm(b.name).startsWith(q) ? 0 : 1) || b.w - a.w);
  let html = '';
  if (cats.length || countries.length) html += `<div class="group">Browse</div>` +
    cats.map(c => `<button class="item" data-browse-cat="${c.id}">${siteGlyph(c.id)}<span class="title">${c.label}</span><span class="meta"></span><span class="sub">Show all on the Sites tab</span></button>`).join('') +
    countries.map(r => `<button class="item" data-browse-cc="${r.code}"><span class="glyph"></span><span class="title">${r.name}</span><span class="meta"></span><span class="sub">Show lines in ${r.name}</span></button>`).join('');
  if (lines.length || famous.length) html += `<div class="group">Ley lines</div>` +
    famous.map(f => `<button class="item" data-famous="${f.id}"><span class="glyph ley">${ICON_LINE}</span><span class="title">${esc(f.name)}</span><span class="meta"></span><span class="sub">Traditional line</span></button>`).join('') +
    lines.map(l => `<button class="item" data-line="${l.id}"><span class="glyph ley">${ICON_LINE}</span><span class="title">${esc(l.name)}</span><span class="stars">${starText(l.stars)}</span><span class="sub">${l.places} sites · ${l.cc.map(regionName).join(', ')}</span></button>`).join('');
  if (sites.length) html += `<div class="group">Sites</div>` + sites.slice(0, 10).map(s => siteItem(s, null)).join('');
  if (!html) html = `<p class="small muted" style="padding:10px">Nothing found for “${esc(qEl.value)}”.</p>`;
  resEl.innerHTML = html; resEl.hidden = false;
  const done = () => { resEl.hidden = true; qEl.blur(); };
  resEl.querySelectorAll('[data-site]').forEach(b => b.onclick = () => { done(); openDetail({ kind: 'site', id: b.dataset.site }); });
  resEl.querySelectorAll('[data-line]').forEach(b => b.onclick = () => { done(); openDetail({ kind: 'line', id: b.dataset.line }); });
  resEl.querySelectorAll('[data-famous]').forEach(b => b.onclick = () => { done(); openDetail({ kind: 'famous', id: b.dataset.famous }); });
  resEl.querySelectorAll('[data-browse-cat]').forEach(b => b.onclick = () => { done(); S.tab = 'sites'; S.detail = null; S.sitesFilter.cats = new Set([b.dataset.browseCat]); sheetAtLeast('half'); renderPanel(); });
  resEl.querySelectorAll('[data-browse-cc]').forEach(b => b.onclick = () => {
    done(); const r = REGIONS.find(x => x.code === b.dataset.browseCc);
    S.tab = 'lines'; S.detail = null; S.linesFilter.country = r.code; renderPanel();
    map.flyTo({ center: r.center, zoom: r.zoom, padding: mapPadding() });
  });
}

// ---------------------------------------------------------------- install + offline shell
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.installPrompt = e; if (S.tab === 'data') renderPanel(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
window.addEventListener('online', () => toast('Back online'));
window.addEventListener('offline', () => toast('Offline. Saved sites and maps still work.'));

// ---------------------------------------------------------------- start
(async function start() {
  renderPanel();
  startLocation();
  const records = await loadAllRegions();
  if (records.length) { setRegions(records); runDetection(); }
  else if (navigator.onLine) downloadRegions(['DK', 'AU']);
  else renderPanel();
})();
