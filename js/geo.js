// Geometry on a spherical Earth. All distances in km, angles in degrees.
export const R = 6371.0088;
const toRad = d => d * Math.PI / 180;
const toDeg = r => r * 180 / Math.PI;

export function distance(aLat, aLon, bLat, bLon) {
  const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearing(aLat, aLon, bLat, bLon) {
  const φ1 = toRad(aLat), φ2 = toRad(bLat), Δλ = toRad(bLon - aLon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function destination(lat, lon, brg, distKm) {
  const δ = distKm / R, θ = toRad(brg), φ1 = toRad(lat), λ1 = toRad(lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [toDeg(φ2), ((toDeg(λ2) + 540) % 360) - 180];
}

// Unit vector helpers for fast great-circle tests
export function vec(lat, lon) {
  const φ = toRad(lat), λ = toRad(lon);
  return [Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ)];
}
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

// The great circle through A and B, described by its pole (unit normal).
export function gcPole(aLat, aLon, bLat, bLon) { return norm(cross(vec(aLat, aLon), vec(bLat, bLon))); }

// Distance (km) from a point to the great circle with the given pole.
export function crossTrack(pole, lat, lon) { return Math.abs(Math.asin(Math.max(-1, Math.min(1, dot(pole, vec(lat, lon)))))) * R; }

// Position along the great circle measured from A (km, signed, -πR..πR).
export function alongTrack(pole, aLat, aLon, lat, lon) {
  const a = vec(aLat, aLon), p = vec(lat, lon);
  const t = cross(pole, a); // direction of travel at A
  return Math.atan2(dot(p, t), dot(p, a)) * R;
}

// Point on the great circle at signed distance d (km) from A.
export function pointAlong(pole, aLat, aLon, d) {
  const a = vec(aLat, aLon), t = cross(pole, a), δ = d / R;
  const v = [a[0] * Math.cos(δ) + t[0] * Math.sin(δ), a[1] * Math.cos(δ) + t[1] * Math.sin(δ), a[2] * Math.cos(δ) + t[2] * Math.sin(δ)];
  return [toDeg(Math.asin(Math.max(-1, Math.min(1, v[2])))), toDeg(Math.atan2(v[1], v[0]))];
}

// Densified [lon,lat] coordinates along the great circle from A between along-track d0..d1.
// Splits at the antimeridian so maps draw it cleanly.
export function arcCoords(pole, aLat, aLon, d0, d1, stepKm = 20) {
  const n = Math.max(2, Math.ceil(Math.abs(d1 - d0) / stepKm) + 1);
  const parts = [[]];
  let prev = null;
  for (let i = 0; i < n; i++) {
    const [lat, lon] = pointAlong(pole, aLat, aLon, d0 + (d1 - d0) * i / (n - 1));
    if (prev !== null && Math.abs(lon - prev) > 180) parts.push([]);
    parts[parts.length - 1].push([lon, lat]);
    prev = lon;
  }
  return parts.filter(p => p.length > 1);
}

export function fmtKm(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString()} km`;
}

// Upper tail of a Poisson distribution, P(X >= n), returned as -log10(p).
const LF = [0];
function logFact(k) { while (LF.length <= k) LF.push(LF[LF.length - 1] + Math.log(LF.length)); return LF[k]; }
export function poissonTailNegLog10(n, lambda) {
  if (n <= 0) return 0;
  if (lambda <= 0) return 30;
  // sum terms k = n .. n+200 in log space
  let maxL = -Infinity; const terms = [];
  for (let k = n; k < n + 200; k++) {
    const l = -lambda + k * Math.log(lambda) - logFact(k);
    terms.push(l); if (l > maxL) maxL = l;
    if (k > lambda && l < maxL - 40) break;
  }
  let s = 0; for (const l of terms) s += Math.exp(l - maxL);
  const lnP = maxL + Math.log(s);
  return Math.max(0, -lnP / Math.LN10);
}
