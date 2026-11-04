import { haversine } from './gpx';

// Summit names come from two open databases, asked in parallel: OpenStreetMap (via Overpass,
// best coverage of small peaks) and Wikidata (steadier servers, the big named mountains).
// Both allow browser requests and need no key. If neither answers, summits stay unnamed.
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
const CACHE_KEY = 'trailreel.peakNames.v1';

/** Preferred name languages from the device, e.g. ['zh-TW', 'zh', 'en']. */
function languages() {
  const out = [];
  for (const l of navigator.languages?.length ? navigator.languages : [navigator.language || 'en']) {
    const [base, region] = l.split('-');
    if (base === 'zh') out.push(/^(TW|HK|MO|Hant)$/i.test(region || '') ? 'zh-Hant' : 'zh-Hans');
    out.push(l, base);
  }
  return [...new Set(out.map((l) => l.toLowerCase()))];
}

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
 * Named peaks near the summits from OpenStreetMap: [{ lat, lon, ele, names: {lang|'': name} }],
 * or null when no mirror answered.
 */
async function fromOverpass(summits) {
  const r = RULES.osm.radius;
  const around = summits.map((s) => `node["natural"~"^(peak|volcano)$"]["name"](around:${r},${s.lat},${s.lon});`);
  const body = 'data=' + encodeURIComponent(`[out:json][timeout:15];(${around.join('')});out body;`);
  // The public servers are often busy; ask the mirrors at once and take the first reply.
  const json = await Promise.any(OVERPASS.map((url) => post(url, body, 'application/json'))).catch(() => null);
  if (!json) return null;
  return json.elements.map((e) => {
    const names = { '': e.tags.name };
    for (const [k, v] of Object.entries(e.tags)) {
      if (k.startsWith('name:')) names[k.slice(5).toLowerCase()] = v;
    }
    return { source: 'osm', lat: e.lat, lon: e.lon, ele: parseFloat(e.tags.ele), names };
  });
}

/** Places with an elevation near the summits from Wikidata, same shape as fromOverpass. */
async function fromWikidata(summits, langs) {
  const wanted = [...langs, 'en'].map((l) => `"${l}"`).join(',');
  // One query per summit: a UNION of geo searches makes the query service time out.
  const replies = await Promise.all(
    summits.map((s) => {
      const query = `SELECT ?item ?coord ?ele ?label WHERE {
        SERVICE wikibase:around { ?item wdt:P625 ?coord.
          bd:serviceParam wikibase:center "Point(${s.lon} ${s.lat})"^^geo:wktLiteral; wikibase:radius "${RULES.wikidata.radius / 1000}". }
        ?item wdt:P2044 ?ele; rdfs:label ?label. FILTER(LANG(?label) IN (${wanted}))
      }`;
      return post(WIKIDATA, 'query=' + encodeURIComponent(query), 'application/sparql-results+json').catch(() => null);
    })
  );
  const byItem = new Map();
  for (const b of replies.flatMap((json) => json?.results.bindings ?? [])) {
    const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(b.coord.value);
    if (!m) continue;
    // An item can list several elevations (surveys disagree); keep the first.
    const peak = byItem.get(b.item.value) || { source: 'wikidata', lon: +m[1], lat: +m[2], ele: parseFloat(b.ele.value), names: {} };
    peak.names[b.label['xml:lang'].toLowerCase()] = b.label.value;
    byItem.set(b.item.value, peak);
  }
  return [...byItem.values()];
}

/** How well a name matches the device languages: 0 is best, then the local or English name. */
function nameRank(names, langs) {
  const i = langs.findIndex((l) => names[l]);
  if (i >= 0) return { rank: i, name: names[langs[i]] };
  const name = names[''] || names.en || Object.values(names)[0] || '';
  return { rank: langs.length + (names[''] ? 0 : 1), name };
}

/**
 * The best name for a summit. The nearest acceptable peak of each source is the summit;
 * both usually describe the same mountain, so use whichever has its name in the better
 * language (OpenStreetMap often only has 京那巴鲁山 in Simplified, Wikidata has 京那巴魯山).
 */
function matchName(summit, candidates, langs) {
  const best = {};
  for (const c of candidates) {
    const rule = RULES[c.source];
    const d = haversine(summit, c);
    const dEle = Number.isFinite(c.ele) ? Math.abs(c.ele - summit.ele) : null;
    if (d > rule.radius || dEle > rule.ele || (c.source === 'wikidata' && dEle == null)) continue;
    const cost = d + (dEle ?? 0) * rule.elePenalty;
    if (!best[c.source] || cost < best[c.source].cost) best[c.source] = { cost, c };
  }
  let pick = null;
  for (const source of ['osm', 'wikidata']) {
    if (!best[source]) continue;
    const n = nameRank(best[source].c.names, langs);
    if (n.name && (!pick || n.rank < pick.rank)) pick = n;
  }
  return pick?.name || '';
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

const cacheKey = (s, langs) => `${s.lat.toFixed(3)},${s.lon.toFixed(3)}|${langs[0] || ''}`;

/**
 * Fill in names for summits the GPX didn't name, from the nearest mapped peak. Returns new
 * summit objects; summits with no match (or when offline) keep an empty name.
 */
export async function nameSummits(summits) {
  const langs = languages();
  const cache = readCache();
  const todo = summits.filter((s) => !s.name && !(cacheKey(s, langs) in cache));
  if (todo.length) {
    const [osm, wd] = await Promise.all([fromOverpass(todo), fromWikidata(todo, langs)]);
    const candidates = [...(osm || []), ...wd];
    for (const s of todo) {
      const best = matchName(s, candidates, langs);
      // "No name" is only final once OpenStreetMap (the fuller source) has replied;
      // otherwise look again next time.
      if (best || osm) cache[cacheKey(s, langs)] = best || '';
    }
    writeCache(cache);
  }
  return summits.map((s) => (s.name ? s : { ...s, name: cache[cacheKey(s, langs)] || '' }));
}
