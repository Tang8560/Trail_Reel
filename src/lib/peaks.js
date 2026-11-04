import { haversine } from './gpx';

// Mountain names come from two open databases, asked in parallel: OpenStreetMap (via Overpass,
// best coverage of small peaks) and Wikidata (steadier servers, the big named mountains).
// Both allow browser requests and need no key. If neither answers, the map has no names.
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const WIKIDATA = 'https://query.wikidata.org/sparql';
const TIMEOUT_MS = 8000;
// How close a mapped peak must be to count as the summit the track reached. OpenStreetMap
// positions are precise, so distance decides. Wikidata often rounds coordinates (中央尖山 sits
// 1.3 km from its entry), so it may be farther off but must agree closely on elevation, or a
// neighbouring top (中央尖山東峰, 3,580 m, is nearer that rounded spot) would win.
const RULES = {
  osm: { radius: 400, ele: 150, elePenalty: 2 },
  wikidata: { radius: 2000, ele: 50, elePenalty: 5 },
};
const CACHE_KEY = 'trailreel.peaks.v3';
const NEAR_M = 2000; // other peaks within this distance of the trail are marked on the map
const BOX_MARGIN_M = 2200; // lookup box around the track: covers NEAR_M and the match radii
const SAME_PEAK_M = 150; // closer than this it's the same top (Kinabalu's peaks are ~300 m apart)
const MAX_PEAKS = 40;

// Mountains are labelled in Chinese and English. Traditional Chinese first (the hikes are in
// Taiwan), then other Chinese variants; databases only sometimes have each.
const ZH = ['zh-hant', 'zh-tw', 'zh-hk', 'zh', 'zh-hans', 'zh-cn'];
const EN = ['en', 'en-gb', 'en-us'];
const LANGS = [...ZH, ...EN];
const CJK = /[㐀-鿿豈-﫿]/;

function withTimeout(promise, ms, ctrl) {
  const timer = setTimeout(() => ctrl.abort(), ms);
  return promise.finally(() => clearTimeout(timer));
}

async function post(url, body, accept) {
  const ctrl = new AbortController();
  const res = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: accept },
      body,
      signal: ctrl.signal,
    }),
    TIMEOUT_MS,
    ctrl
  );
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

/**
 * Named peaks in a box from OpenStreetMap: [{ source, lat, lon, ele, names: {lang|'': name} }],
 * or null when no mirror answered.
 */
async function fromOverpass(box) {
  const body = 'data=' + encodeURIComponent(
    `[out:json][timeout:15];node["natural"~"^(peak|volcano)$"]["name"](${box.s},${box.w},${box.n},${box.e});out body;`
  );
  // The public servers are often busy; ask the mirrors at once and take the first reply.
  const json = await Promise.any(OVERPASS.map((url) => post(url, body, 'application/json'))).catch(() => null);
  if (!json) return null;
  const keep = new Set(['', ...LANGS]);
  return json.elements.map((e) => {
    const names = {};
    for (const [k, v] of Object.entries(e.tags)) {
      const lang = k === 'name' ? '' : k.startsWith('name:') ? k.slice(5).toLowerCase() : null;
      if (lang != null && keep.has(lang)) names[lang] = v;
    }
    return { source: 'osm', lat: e.lat, lon: e.lon, ele: parseFloat(e.tags.ele), names };
  });
}

// Wikidata item types that are tops: mountain, summit, hill, volcano, stratovolcano.
const WD_TYPES = ['Q8502', 'Q207326', 'Q54050', 'Q8072', 'Q169358'];

/** Mountains with an elevation in a box from Wikidata, same shape as fromOverpass. */
async function fromWikidata(box) {
  const wanted = LANGS.map((l) => `"${l}"`).join(',');
  const query = `SELECT ?item ?coord ?ele ?label WHERE {
    SERVICE wikibase:box { ?item wdt:P625 ?coord.
      bd:serviceParam wikibase:cornerSouthWest "Point(${box.w} ${box.s})"^^geo:wktLiteral;
                      wikibase:cornerNorthEast "Point(${box.e} ${box.n})"^^geo:wktLiteral. }
    VALUES ?type { ${WD_TYPES.map((t) => `wd:${t}`).join(' ')} }
    ?item wdt:P31 ?type; wdt:P2044 ?ele; rdfs:label ?label. FILTER(LANG(?label) IN (${wanted}))
  }`;
  const json = await post(WIKIDATA, 'query=' + encodeURIComponent(query), 'application/sparql-results+json').catch(() => null);
  const byItem = new Map();
  for (const b of json?.results.bindings ?? []) {
    const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(b.coord.value);
    if (!m) continue;
    // An item can list several elevations (surveys disagree); keep the first.
    const peak = byItem.get(b.item.value) || {
      source: 'wikidata',
      lon: +m[1],
      lat: +m[2],
      // Coordinates given to 0.01° or so can be a kilometre off: fine for recognising the
      // summit a track reached (the elevation must agree too), not for drawing on the map.
      coarse: !/\.\d{3}/.test(m[1]) && !/\.\d{3}/.test(m[2]),
      ele: parseFloat(b.ele.value),
      names: {},
    };
    peak.names[b.label['xml:lang'].toLowerCase()] = b.label.value;
    byItem.set(b.item.value, peak);
  }
  return [...byItem.values()];
}

/**
 * Chinese and English names from a peak's names: { zh, en }, either may be ''. The untagged
 * local name fills whichever language it is written in.
 */
function bilingual(names) {
  const local = names[''] || '';
  const zh = ZH.map((l) => names[l]).find(Boolean) || (CJK.test(local) ? local : '');
  let en = EN.map((l) => names[l]).find(Boolean) || (local && !CJK.test(local) ? local : '');
  if (CJK.test(en)) en = ''; // some "English" labels are just the Chinese name copied over
  return { zh, en };
}

/** Rank of a Chinese name: Traditional before Simplified. */
const zhRank = (names) => {
  const i = ZH.findIndex((l) => names[l]);
  return i < 0 ? ZH.length : i;
};

/** Display names: the Chinese name first, English second (or the one name there is). */
function labelOf({ zh, en }) {
  return zh ? { name: zh, nameEn: en } : { name: en, nameEn: '' };
}

/**
 * Names for a summit. The nearest acceptable peak of each source is the summit; both
 * usually describe the same mountain, so take the Chinese name from whichever has the
 * better variant (OpenStreetMap often only has 京那巴鲁山 in Simplified) and the English one
 * from whichever has it.
 */
function matchNames(summit, candidates) {
  const best = {};
  for (const c of candidates) {
    const rule = RULES[c.source];
    const d = haversine(summit, c);
    const dEle = Number.isFinite(c.ele) ? Math.abs(c.ele - summit.ele) : null;
    if (d > rule.radius || dEle > rule.ele || (c.source === 'wikidata' && dEle == null)) continue;
    const cost = d + (dEle ?? 0) * rule.elePenalty;
    if (!best[c.source] || cost < best[c.source].cost) best[c.source] = { cost, c };
  }
  const found = ['osm', 'wikidata'].filter((src) => best[src]).map((src) => best[src].c.names);
  const zhFrom = [...found].sort((a, b) => zhRank(a) - zhRank(b));
  return {
    zh: zhFrom.map((n) => bilingual(n).zh).find(Boolean) || '',
    en: found.map((n) => bilingual(n).en).find(Boolean) || '',
  };
}

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // private mode / storage full: just look it up again next time
  }
}

/** Shortest distance (m) from a point to the trail. */
function distanceToTrail(p, trail) {
  let best = Infinity;
  for (const q of trail) best = Math.min(best, haversine(p, q));
  return best;
}

/** Both databases often list the same top; merge them, keeping OpenStreetMap's position. */
function mergePeaks(list) {
  const out = [];
  for (const c of list) {
    if (c.coarse || !Number.isFinite(c.ele)) continue;
    const names = Object.values(c.names);
    const same = out.find((o) => haversine(o, c) < SAME_PEAK_M || names.some((n) => Object.values(o.names).includes(n)));
    if (same) same.names = { ...c.names, ...same.names };
    else out.push({ ...c, names: { ...c.names } });
  }
  return out;
}

/**
 * Look up named mountains around the trail. Fills in names for the summits the GPX didn't
 * name (from the nearest matching mapped peak) and returns the other named peaks within
 * NEAR_M of the trail, highest first: { summits, peaks: [{ lat, lon, ele, name, nameEn }] }.
 * `name` is Chinese when there is a Chinese name, `nameEn` the English one beside it.
 * Offline (or with both databases down) summits keep their names and there are no peaks.
 */
export async function lookupPeaks(track) {
  const b = track.bounds;
  const mLat = BOX_MARGIN_M / 111320;
  const mLon = mLat / Math.max(0.1, Math.cos(((b.minLat + b.maxLat) / 2) * (Math.PI / 180)));
  const r = (v) => v.toFixed(4);
  const box = { s: r(b.minLat - mLat), w: r(b.minLon - mLon), n: r(b.maxLat + mLat), e: r(b.maxLon + mLon) };
  const key = `${box.s},${box.w},${box.n},${box.e}`;

  let found = readCache()[key];
  if (!found) {
    const [osm, wd] = await Promise.all([fromOverpass(box), fromWikidata(box)]);
    found = { osm: osm || [], wd };
    // Only keep the answer once OpenStreetMap (the fuller source) has replied; otherwise ask
    // again next time. Keep just this track, so storage doesn't grow with every hike.
    if (osm) writeCache({ [key]: found });
  }
  const candidates = [...found.osm, ...found.wd];

  const summits = track.summits.map((s) => {
    const found = matchNames(s, candidates);
    // A name from the GPX itself wins; the databases fill in the other language.
    if (s.name) found[CJK.test(s.name) ? 'zh' : 'en'] = s.name;
    return { ...s, ...labelOf(found) };
  });

  // The trail, thinned to a point about every 50 m, for the distance check.
  const step = Math.max(1, Math.round(track.points.length / Math.max(1, track.totalDist / 50)));
  const trail = track.points.filter((_, i) => i % step === 0);
  const peaks = mergePeaks(candidates)
    .map((c) => ({ lat: c.lat, lon: c.lon, ele: c.ele, ...labelOf(bilingual(c.names)) }))
    .filter((p) => p.name)
    // Leave out the tops the hike climbed: they already have a summit flag.
    .filter((p) => !summits.some((s) => (s.name && [p.name, p.nameEn].includes(s.name)) || haversine(s, p) < SAME_PEAK_M))
    .filter((p) => distanceToTrail(p, trail) <= NEAR_M)
    .sort((a, b) => b.ele - a.ele)
    .slice(0, MAX_PEAKS);
  return { summits, peaks };
}
