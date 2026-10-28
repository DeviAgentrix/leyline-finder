// Sacred-site data: where it comes from, how it is sorted, and how it is kept offline.
// Sources: OpenStreetMap (via the Overpass API) for the sites themselves,
// Wikidata / Wikimedia Commons / Wikipedia for photos and short descriptions.

export const REGIONS = [
  { code: 'DK', name: 'Denmark', flag: 'DK', center: [10.4, 56.1], zoom: 6.2 },
  { code: 'AU', name: 'Australia', flag: 'AU', center: [134, -26], zoom: 3.2 },
];

// core: used for finding ley lines by default (Alfred Watkins' kind of markers).
export const CATEGORIES = [
  { id: 'circle', label: 'Stone circles', core: true, w: 4 },
  { id: 'stone', label: 'Standing stones & dolmens', core: true, w: 3 },
  { id: 'mound', label: 'Burial mounds & barrows', core: true, w: 2 },
  { id: 'rock', label: 'Rock art', core: true, w: 3 },
  { id: 'rune', label: 'Runestones & Viking sites', core: true, w: 3 },
  { id: 'arch', label: 'Archaeological sites', core: true, w: 2 },
  { id: 'church', label: 'Old churches & cathedrals', core: true, w: 2 },
  { id: 'mosque', label: 'Mosques', core: true, w: 2 },
  { id: 'temple', label: 'Temples & shrines', core: true, w: 2 },
  { id: 'fort', label: 'Castles & hill forts', core: true, w: 2 },
  { id: 'spring', label: 'Sacred springs & wells', core: true, w: 3 },
  { id: 'mountain', label: 'Sacred mountains & rocks', core: true, w: 2 },
  { id: 'grove', label: 'Sacred groves', core: true, w: 3 },
  { id: 'cave', label: 'Caves', core: true, w: 2 },
  { id: 'ruin', label: 'Ruins', core: false, w: 1 },
  { id: 'grave', label: 'Old graveyards', core: false, w: 1 },
  { id: 'battle', label: 'Battlefields', core: false, w: 1 },
  { id: 'monument', label: 'Monuments', core: false, w: 1 },
];
export const CAT = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

const KEEP = ['name', 'name:en', 'historic', 'megalith_type', 'site_type', 'archaeological_site', 'tomb', 'amenity',
  'religion', 'denomination', 'natural', 'wikidata', 'wikipedia', 'image', 'wikimedia_commons', 'heritage',
  'start_date', 'castle_type', 'landuse', 'memorial', 'place_of_worship', 'description', 'ele', 'inscription'];

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

function query(iso) {
  return `[out:json][timeout:300][maxsize:536870912];
area["ISO3166-1"="${iso}"][admin_level=2]->.a;
(
  nwr["historic"~"^(archaeological_site|megalith|tomb|tumulus|castle|fort|ruins|battlefield|monument|rune_stone|church|chapel|monastery|cathedral|wayside_shrine|shrine|city_gate|stone_circle|rock_art|holy_well)$"](area.a);
  nwr["megalith_type"](area.a);
  nwr["historic"="memorial"]["memorial"~"rune"](area.a);
  nwr["amenity"="place_of_worship"]["heritage"](area.a);
  nwr["amenity"="place_of_worship"]["historic"](area.a);
  nwr["amenity"="place_of_worship"]["wikidata"](area.a);
  nwr["place_of_worship"="holy_well"](area.a);
  nwr["landuse"="cemetery"]["historic"](area.a);
  nwr["amenity"="grave_yard"]["historic"](area.a);
  nwr["natural"~"^(spring|hot_spring)$"]["wikidata"](area.a);
  nwr["natural"~"^(spring|hot_spring)$"]["religion"](area.a);
  nwr["natural"="spring"]["name"~"[Hh]ellig|[Hh]oly|[Ss]acred|[Hh]elligkilde"](area.a);
  nwr["natural"~"^(peak|volcano|rock|bare_rock|stone|cave_entrance)$"]["wikidata"](area.a);
  nwr["natural"]["religion"](area.a);
  nwr["landuse"="forest"]["religion"](area.a);
);
out center tags qt;`;
}

export function classify(t) {
  const h = t.historic || '', site = t.site_type || t.archaeological_site || '', tomb = t.tomb || '';
  const nat = t.natural || '', mem = t.memorial || '';
  if (t.megalith_type === 'stone_circle' || h === 'stone_circle') return 'circle';
  if (h === 'rune_stone' || /rune/.test(mem)) return 'rune';
  if (h === 'megalith' || t.megalith_type || tomb === 'dolmen' || site === 'megalith') return 'stone';
  if (h === 'tumulus' || /tumulus|barrow|passage_grave|mound/.test(site + ' ' + tomb) || h === 'tomb') return 'mound';
  if (/petroglyph|rock_painting|rock_art|rock_engraving/.test(site) || h === 'rock_art') return 'rock';
  if (h === 'archaeological_site') {
    if (/fortification|hillfort|fort/.test(site)) return 'fort';
    if (/viking/i.test((t.name || '') + ' ' + (t.description || ''))) return 'rune';
    return 'arch';
  }
  if (h === 'holy_well' || t.place_of_worship === 'holy_well') return 'spring';
  if (t.amenity === 'place_of_worship' || /^(church|chapel|monastery|cathedral)$/.test(h)) {
    if (t.religion === 'muslim') return 'mosque';
    if (!t.religion || t.religion === 'christian' || /^(church|chapel|monastery|cathedral)$/.test(h)) return 'church';
    return 'temple';
  }
  if (h === 'wayside_shrine' || h === 'shrine') return 'temple';
  if (/^(castle|fort|city_gate)$/.test(h)) return 'fort';
  if (nat === 'spring' || nat === 'hot_spring') return 'spring';
  if (/^(peak|volcano|rock|bare_rock|stone)$/.test(nat)) return 'mountain';
  if (nat === 'cave_entrance') return 'cave';
  if (nat === 'wood' || t.landuse === 'forest') return 'grove';
  if (h === 'ruins') return 'ruin';
  if (t.landuse === 'cemetery' || t.amenity === 'grave_yard') return 'grave';
  if (h === 'battlefield') return 'battle';
  if (h === 'monument' || h === 'memorial') return 'monument';
  if (t.religion) return 'temple';
  return null;
}

function weightFor(cat, t) {
  let w = CAT[cat].w;
  if (t.wikidata || t.wikipedia) w += 1;
  const y = parseInt((t.start_date || '').replace(/^~|^C/, ''), 10);
  if (cat === 'church' && y && y < 1600) w += 1;
  return w;
}

const UNNAMED = {
  circle: 'Stone circle', stone: 'Standing stone', mound: 'Burial mound', rock: 'Rock art site', rune: 'Runestone',
  arch: 'Archaeological site', church: 'Church', mosque: 'Mosque', temple: 'Shrine', fort: 'Fortification',
  spring: 'Spring', mountain: 'Peak', grove: 'Sacred grove', cave: 'Cave', ruin: 'Ruin', grave: 'Graveyard',
  battle: 'Battlefield', monument: 'Monument',
};

export function siteName(s) { return s.name || `${UNNAMED[s.cat]} (unnamed)`; }

export async function downloadRegion(region, onStatus = () => {}) {
  let lastErr;
  for (const url of ENDPOINTS) {
    try {
      onStatus(`Asking OpenStreetMap for every sacred site in ${region.name}… this can take a minute or two.`);
      const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query(region.code) }) });
      if (!res.ok) throw new Error(`The map server answered ${res.status}`);
      onStatus(`Sorting the sites in ${region.name}…`);
      const json = await res.json();
      const sites = [];
      const seen = new Set();
      for (const el of json.elements || []) {
        const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
        if (lat == null || lon == null || !el.tags) continue;
        const cat = classify(el.tags);
        if (!cat) continue;
        const id = el.type[0] + el.id;
        if (seen.has(id)) continue; seen.add(id);
        const t = {};
        for (const k of KEEP) if (el.tags[k]) t[k] = el.tags[k];
        sites.push({ id, lat: +lat.toFixed(6), lon: +lon.toFixed(6), cat, w: weightFor(cat, el.tags), name: el.tags['name:en'] || el.tags.name || '', t, cc: region.code });
      }
      const record = { code: region.code, name: region.name, fetchedAt: Date.now(), sites };
      await idbPut('regions', record);
      return record;
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('Could not reach the map servers');
}

// ---------- photos and descriptions ----------
function commonsUrl(file, width = 800) {
  const f = file.replace(/^File:/i, '').replace(/ /g, '_');
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(f)}?width=${width}`;
}
function commonsPage(file) { return `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file.replace(/^File:/i, '').replace(/ /g, '_'))}`; }

export async function siteDetails(site) {
  const cached = await idbGet('details', site.id).catch(() => null);
  if (cached) return cached;
  const t = site.t || {};
  const d = { id: site.id, image: null, imagePage: null, summary: null, wikiUrl: null };
  let file = null;
  if (/^File:/i.test(t.wikimedia_commons || '')) file = t.wikimedia_commons;
  else if (/commons\.wikimedia\.org\/wiki\/File:/.test(t.image || '')) file = decodeURIComponent(t.image.split('/wiki/')[1]);
  let wiki = t.wikipedia || null;
  try {
    if (t.wikidata && /^Q\d+$/.test(t.wikidata)) {
      const r = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${t.wikidata}&props=claims|sitelinks&format=json&origin=*`);
      const j = await r.json();
      const ent = j.entities?.[t.wikidata];
      if (!file) { const v = ent?.claims?.P18?.[0]?.mainsnak?.datavalue?.value; if (v) file = 'File:' + v; }
      if (!wiki && ent?.sitelinks) {
        for (const lang of ['en', 'da']) { const sl = ent.sitelinks[lang + 'wiki']; if (sl) { wiki = `${lang}:${sl.title}`; break; } }
      }
    }
    if (wiki && wiki.includes(':')) {
      const [lang, ...rest] = wiki.split(':');
      const title = rest.join(':');
      const r = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`);
      if (r.ok) {
        const j = await r.json();
        d.summary = j.extract || null;
        d.wikiUrl = j.content_urls?.mobile?.page || j.content_urls?.desktop?.page || null;
        if (!file && j.originalimage?.source) { d.image = j.thumbnail?.source || j.originalimage.source; d.imagePage = d.wikiUrl; }
      }
    }
  } catch { /* offline: show what we have */ }
  if (file) { d.image = commonsUrl(file); d.imagePage = commonsPage(file); }
  idbPut('details', d).catch(() => {});
  return d;
}

// ---------- tiny IndexedDB wrapper ----------
let dbp;
function db() {
  if (!dbp) dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open('leyline-finder', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('regions', { keyPath: 'code' });
      d.createObjectStore('details', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode); const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r?.result); t.onerror = () => reject(t.error);
  });
}
export const idbPut = (store, v) => tx(store, 'readwrite', s => s.put(v));
export const idbGet = (store, k) => tx(store, 'readonly', s => s.get(k));
export const idbDelete = (store, k) => tx(store, 'readwrite', s => s.delete(k));
export async function loadAllRegions() {
  const out = [];
  for (const r of REGIONS) { try { const rec = await idbGet('regions', r.code); if (rec) out.push(rec); } catch { /* storage blocked */ } }
  return out;
}
