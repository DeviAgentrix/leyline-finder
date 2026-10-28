// Ley line detection. Runs in a background thread so the app stays smooth.
//
// Method, in plain words:
// 1. Sites closer together than the tolerance are merged into one "place", so a
//    cluster of 30 mounds in one field counts once, not 30 times.
// 2. The land is cut into overlapping squares (one line length wide). In each square
//    we test every direction and offset (a Hough transform) and count how many places
//    fall inside a narrow band.
// 3. A band only becomes a ley line when it holds far more places than chance would
//    put there, given how many sites are in that square. This is what stops dense
//    areas from producing lines everywhere.
// 4. Overlapping finds are merged, and each line is checked again on the real globe.
import { distance, gcPole, crossTrack, alongTrack, poissonTailNegLog10 } from './geo.js';

const KM_LAT = 110.574;
const kmLon = lat => 111.32 * Math.cos(lat * Math.PI / 180);

if (typeof self !== 'undefined') self.onmessage = (e) => {
  const { type, sites, params, job } = e.data;
  if (type !== 'detect') return;
  try {
    const lines = detect(sites, params, (p) => self.postMessage({ type: 'progress', job, p }));
    self.postMessage({ type: 'done', job, lines });
  } catch (err) {
    self.postMessage({ type: 'error', job, message: String(err && err.message || err) });
  }
};

function makeHash(cellKm) {
  const dLat = cellKm / KM_LAT;
  const map = new Map();
  const key = (lat, lon) => {
    const i = Math.floor(lat / dLat);
    const bandLat = (i + 0.5) * dLat;
    const dLon = cellKm / Math.max(1e-6, kmLon(bandLat));
    const j = Math.floor(lon / dLon);
    return [i, j, dLon];
  };
  return {
    dLat,
    add(item) {
      const [i, j] = key(item.lat, item.lon);
      const k = i + ':' + j;
      let arr = map.get(k); if (!arr) map.set(k, arr = []);
      arr.push(item);
    },
    cells() { return map; },
    query(lat, lon, halfKm, out) {
      const i0 = Math.floor((lat - halfKm / KM_LAT) / dLat), i1 = Math.floor((lat + halfKm / KM_LAT) / dLat);
      for (let i = i0; i <= i1; i++) {
        const bandLat = (i + 0.5) * dLat;
        const dLon = cellKm / Math.max(1e-6, kmLon(bandLat));
        const hl = halfKm / Math.max(1e-6, kmLon(lat));
        const j0 = Math.floor((lon - hl) / dLon), j1 = Math.floor((lon + hl) / dLon);
        for (let j = j0; j <= j1; j++) {
          const arr = map.get(i + ':' + j); if (arr) for (const it of arr) out.push(it);
        }
      }
      return out;
    },
  };
}

// Merge sites within ~tolerance of each other into "places".
function clusterSites(sites, tol) {
  const cell = Math.max(0.2, tol * 2);
  const h = makeHash(cell);
  const nodes = [];
  const sorted = sites.slice().sort((a, b) => b.w - a.w);
  for (const s of sorted) {
    const near = h.query(s.lat, s.lon, cell, []);
    let best = null, bd = Infinity;
    for (const n of near) { const d = distance(n.lat, n.lon, s.lat, s.lon); if (d < bd) { bd = d; best = n; } }
    if (best && bd <= tol) {
      best.members.push(s.id);
      best.w = Math.min(best.w + s.w * 0.25, best.w0 * 2);
    } else {
      const n = { id: nodes.length, lat: s.lat, lon: s.lon, w: s.w, w0: s.w, members: [s.id] };
      nodes.push(n); h.add(n);
    }
  }
  return nodes;
}

// Length of the line x·cosθ + y·sinθ = ρ inside the square [-h,h]².
function chord(c, s, rho, h) {
  const pts = [];
  if (Math.abs(s) > 1e-9) { for (const x of [-h, h]) { const y = (rho - x * c) / s; if (y >= -h - 1e-9 && y <= h + 1e-9) pts.push([x, y]); } }
  if (Math.abs(c) > 1e-9) { for (const y of [-h, h]) { const x = (rho - y * s) / c; if (x >= -h - 1e-9 && x <= h + 1e-9) pts.push([x, y]); } }
  let best = 0;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) best = Math.max(best, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
  return best;
}

export function detect(sites, params, progress = () => {}) {
  const tol = params.tolKm ?? 1;
  const L = params.lenKm ?? 50;
  const minPlaces = params.minSites ?? 5;
  const threshold = params.threshold ?? 7; // -log10(p)
  const h = L / 2;

  const nodes = clusterSites(sites, tol);
  const hash = makeHash(h);
  for (const n of nodes) hash.add(n);

  // Tile centres: corners of every occupied cell.
  const centres = new Map();
  for (const [k, arr] of hash.cells()) {
    const [i, j] = k.split(':').map(Number);
    const dLat = hash.dLat;
    const bandLat = (i + 0.5) * dLat;
    const dLon = h / Math.max(1e-6, kmLon(bandLat));
    for (const di of [0, 1]) for (const dj of [0, 1]) {
      const lat = (i + di) * dLat, lon = (j + dj) * dLon;
      centres.set(lat.toFixed(4) + ',' + lon.toFixed(4), [lat, lon]);
    }
    if (arr.length === 0) continue;
  }

  const dTheta = Math.atan(tol / L);
  const nAng = Math.ceil(Math.PI / dTheta);
  const cosT = new Float64Array(nAng), sinT = new Float64Array(nAng);
  for (let a = 0; a < nAng; a++) { cosT[a] = Math.cos(a * Math.PI / nAng); sinT[a] = Math.sin(a * Math.PI / nAng); }
  const rhoMax = h * Math.SQRT2;
  const nBins = Math.ceil(2 * rhoMax / tol) + 2;
  const counts = new Uint16Array(nBins);

  const candidates = [];
  const centreList = [...centres.values()];
  let done = 0;
  for (const [clat, clon] of centreList) {
    if (++done % 200 === 0) progress(done / centreList.length);
    const near = hash.query(clat, clon, h + 8 * tol, []);
    if (near.length < minPlaces) continue;
    const kx = kmLon(clat);
    const pts = [], wide = [];
    for (const n of near) {
      let dl = n.lon - clon; if (dl > 180) dl -= 360; if (dl < -180) dl += 360;
      const x = dl * kx, y = (n.lat - clat) * KM_LAT;
      const p = { n, x, y };
      wide.push(p);
      if (Math.abs(x) <= h && Math.abs(y) <= h) pts.push(p);
    }
    const N = pts.length;
    if (N < minPlaces) continue;

    for (let a = 0; a < nAng; a++) {
      counts.fill(0);
      const c = cosT[a], s = sinT[a];
      for (const p of pts) { const b = Math.floor((p.x * c + p.y * s + rhoMax) / tol); counts[b]++; }
      for (let b = 0; b < nBins - 1; b++) {
        const n = counts[b] + counts[b + 1];
        if (n < minPlaces) continue;
        if (counts[b + 1] + (b + 2 < nBins ? counts[b + 2] : 0) > n) continue; // let the next window take it
        const rho = (b + 1) * tol - rhoMax;
        const len = chord(c, s, rho, h);
        if (len < L * 0.3) continue;
        // Background: how crowded are the parallel bands on either side?
        // Using the busier side copes with coastlines, borders and dense towns.
        let sl = 0, sr = 0;
        for (let k = b - 12; k <= b - 3; k++) if (k >= 0) sl += counts[k];
        for (let k = b + 4; k <= b + 13; k++) if (k < nBins) sr += counts[k];
        const lambda = background(sl, sr);
        if (poissonTailNegLog10(n, lambda) < threshold - 3) continue;
        const cand = refine(pts, wide, c, s, rho, tol, h, N, L, minPlaces);
        if (cand && cand.s >= threshold) candidates.push(cand);
      }
    }
  }

  // Keep the strongest, drop near-duplicates.
  candidates.sort((a, b) => b.s - a.s || b.w - a.w);
  const accepted = [];
  for (const c of candidates) {
    const set = new Set(c.ids);
    let dup = false;
    for (const a of accepted) {
      let inter = 0; for (const id of a.ids) if (set.has(id)) inter++;
      if (inter / Math.min(a.ids.length, c.ids.length) >= 0.5) { dup = true; break; }
    }
    if (!dup) accepted.push(c);
    if (accepted.length >= (params.maxLines ?? 1500)) break;
  }

  // Final check on the real globe.
  const byId = new Map(nodes.map(n => [n.id, n]));
  const out = [];
  for (const c of accepted) {
    const pole = gcPole(c.a[0], c.a[1], c.b[0], c.b[1]);
    const len = distance(c.a[0], c.a[1], c.b[0], c.b[1]);
    const places = [];
    for (const id of c.ids) {
      const n = byId.get(id);
      if (crossTrack(pole, n.lat, n.lon) <= tol * 1.25) places.push(n);
    }
    if (places.length < minPlaces) continue;
    places.sort((p, q) => alongTrack(pole, c.a[0], c.a[1], p.lat, p.lon) - alongTrack(pole, c.a[0], c.a[1], q.lat, q.lon));
    out.push({
      a: c.a, b: c.b, lengthKm: len,
      places: places.length,
      siteIds: places.flatMap(p => p.members),
      placeAnchors: places.map(p => p.members[0]),
      strength: Math.round(c.s * 10) / 10,
      weight: places.reduce((t, p) => t + p.w, 0),
    });
  }
  progress(1);
  return out;
}

function refine(pts, wide, c, s, rho, tol, h, N, L, minPlaces) {
  // pick members in band, fit line by principal axis, repeat
  let mem = pts.filter(p => Math.abs(p.x * c + p.y * s - rho) <= tol);
  for (let iter = 0; iter < 2; iter++) {
    if (mem.length < minPlaces) return null;
    let mx = 0, my = 0; for (const p of mem) { mx += p.x; my += p.y; } mx /= mem.length; my /= mem.length;
    let sxx = 0, syy = 0, sxy = 0; for (const p of mem) { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy); // direction of the line
    c = -Math.sin(ang); s = Math.cos(ang); // normal
    rho = mx * c + my * s;
    mem = pts.filter(p => Math.abs(p.x * c + p.y * s - rho) <= tol);
  }
  if (mem.length < minPlaces) return null;
  const dx = s, dy = -c; // along-line unit vector
  let tmin = Infinity, tmax = -Infinity, pmin = null, pmax = null;
  for (const p of mem) { const t = p.x * dx + p.y * dy; if (t < tmin) { tmin = t; pmin = p; } if (t > tmax) { tmax = t; pmax = p; } }
  if (tmax - tmin < L * 0.3) return null;
  let sl = 0, sr = 0;
  for (const p of wide) {
    const t = p.x * dx + p.y * dy;
    if (t < tmin || t > tmax) continue;
    const d = p.x * c + p.y * s - rho;
    if (d > 2.5 * tol && d <= 12.5 * tol) sl++;
    else if (d < -2.5 * tol && d >= -12.5 * tol) sr++;
  }
  const lambda = background(sl, sr);
  const sc = poissonTailNegLog10(mem.length, lambda);
  return {
    s: sc,
    w: mem.reduce((t, p) => t + p.n.w, 0),
    ids: mem.map(p => p.n.id).sort((x, y) => x - y),
    a: [pmin.n.lat, pmin.n.lon],
    b: [pmax.n.lat, pmax.n.lon],
  };
}

// Expected number of places in a band 2 tolerances wide, from two side bands that are
// each 10 tolerances wide. Mostly the average of both sides; if one side is nearly
// empty (sea, a border) the busier side counts for more.
function background(sl, sr) {
  const perSide = Math.max((sl + sr) / 2, Math.max(sl, sr) * 0.75);
  return Math.max(0.3, perSide * 2 / 10);
}
