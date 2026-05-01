const COUNTRY_SOURCES = [
  'data/countries.json',
  '/api/countries',
  'https://raw.githubusercontent.com/samayo/country-json/master/src/country-by-geo-coordinates.json',
  'https://raw.githubusercontent.com/eesur/country-codes-lat-long/master/country-codes-lat-long-alpha3.json',
];

const GEOJSON_SOURCES = [
  'data/countries.geojson',
  '/api/geojson',
  'https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson',
  'https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json',
];

const FALLBACK_COUNTRIES = [
  { name: 'United States', lat: 38, lon: -97 },
  { name: 'Canada', lat: 56.1304, lon: -106.3468 },
  { name: 'Mexico', lat: 23.6345, lon: -102.5528 },
  { name: 'Brazil', lat: -14.235, lon: -51.9253 },
  { name: 'Argentina', lat: -38.4161, lon: -63.6167 },
  { name: 'United Kingdom', lat: 55.3781, lon: -3.436 },
  { name: 'France', lat: 46.2276, lon: 2.2137 },
  { name: 'Germany', lat: 51.1657, lon: 10.4515 },
  { name: 'Spain', lat: 40.4637, lon: -3.7492 },
  { name: 'Italy', lat: 41.8719, lon: 12.5674 },
  { name: 'Russia', lat: 61, lon: 105 },
  { name: 'China', lat: 35.8617, lon: 104.1954 },
  { name: 'India', lat: 20.5937, lon: 78.9629 },
  { name: 'Japan', lat: 36.2048, lon: 138.2529 },
  { name: 'South Korea', lat: 35.9078, lon: 127.7669 },
  { name: 'Australia', lat: -25.2744, lon: 133.7751 },
  { name: 'New Zealand', lat: -40.9006, lon: 174.886 },
  { name: 'South Africa', lat: -30.5595, lon: 22.9375 },
  { name: 'Egypt', lat: 26.8206, lon: 30.8025 },
  { name: 'Turkey', lat: 38.9637, lon: 35.2433 },
];

const SOVEREIGN_SOURCE = 'data/sovereign-countries.json';

const DISTANCE_TOLERANCE_KM = 25;
const BORDER_TOLERANCE_KM = 0;
const DISTANCE_BUCKET_KM = 100;
const ORDER_TOLERANCE_KM = 0;
const TRIANGULATION_MIN_GUESSES = 2;
const DEFAULT_TRI_WEIGHT_2 = 0.4;
const DEFAULT_TRI_WEIGHT_3 = 0.5;
const DEFAULT_TRI_WEIGHT_4 = 0.6;
const DEFAULT_AVG_WORST_WEIGHT = 0.7;
const DEFAULT_FARTHEST_WEIGHT = 0.2;

const aliasCandidates = [
  ['usa', ['United States', 'United States of America']],
  ['us', ['United States', 'United States of America']],
  ['uk', ['United Kingdom', 'United Kingdom of Great Britain and Northern Ireland']],
  ['uae', ['United Arab Emirates']],
  ['south korea', ['South Korea', 'Korea, South', 'Korea (Republic of)']],
  ['north korea', ['North Korea', 'Korea, North', 'Korea (Democratic People\'s Republic of)']],
  ['russia', ['Russia', 'Russian Federation']],
  ['czechia', ['Czechia', 'Czech Republic']],
  ['ivory coast', ['Ivory Coast', 'Cote d\'Ivoire']],
  ['vietnam', ['Vietnam', 'Viet Nam']],
  ['laos', ['Laos', "Lao People\'s Democratic Republic"]],
  ['syria', ['Syria', 'Syrian Arab Republic']],
  ['tanzania', ['Tanzania', 'Tanzania, United Republic of']],
  ['bolivia', ['Bolivia', 'Bolivia (Plurinational State of)']],
  ['venezuela', ['Venezuela', 'Venezuela (Bolivarian Republic of)']],
  ['iran', ['Iran', 'Iran (Islamic Republic of)']],
];

const GEO_NAME_ALIASES = new Map([
  ['unitedstatesofamerica', 'United States'],
  ['republicofthecongo', 'Congo'],
  ['democraticrepublicofthecongo', 'The Democratic Republic of Congo'],
  ['republicofserbia', 'Serbia'],
  ['fiji', 'Fiji Islands'],
  ['swaziland', 'Eswatini'],
  ['macedonia', 'North Macedonia'],
  ['unitedrepublicoftanzania', 'Tanzania'],
]);

const state = {
  countries: [],
  countryLookup: new Map(),
  simplifiedLookup: new Map(),
  aliasLookup: new Map(),
  distanceCache: new Map(),
  distanceMatrix: null,
  guesses: [],
  bestDistance: null,
  guessHistory: [],
  nextGuessId: 1,
  orderConstraints: [],
  geojson: null,
  map: null,
  geoLayer: null,
  training: null,
  sovereignSet: null,
  rankWeights: null,
};

const elements = {
  status: document.getElementById('data-status'),
  statusText: document.getElementById('status-text'),
  countryInput: document.getElementById('country-input'),
  rankInput: document.getElementById('rank-input'),
  distanceInput: document.getElementById('distance-input'),
  addGuess: document.getElementById('add-guess'),
  undoGuess: document.getElementById('undo-guess'),
  resetGuess: document.getElementById('reset-guesses'),
  guessList: document.getElementById('guess-list'),
  candidateCount: document.getElementById('candidate-count'),
  nextGuessName: document.getElementById('next-guess-name'),
  nextGuessScore: document.getElementById('next-guess-score'),
  nextGuessScorePill: document.getElementById('next-guess-score-pill'),
  topSuggestions: document.getElementById('top-suggestions'),
  trainingSummary: document.getElementById('training-summary'),
  trainingList: document.getElementById('training-list'),
  remainingList: document.getElementById('remaining-list'),
  countryList: document.getElementById('country-list'),
  map: document.getElementById('map'),
};

function setStatus(message, tone = 'loading') {
  elements.statusText.textContent = message;
  elements.status.classList.remove('ok', 'error');
  if (tone === 'ok') elements.status.classList.add('ok');
  if (tone === 'error') elements.status.classList.add('error');
}

function simplifyName(value) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function normalizeCountry(item) {
  if (!item || typeof item !== 'object') return null;
  const name = item.country || item.name || item.Country || item.countryName || item.official_name;
  let latRaw = item.latitude ?? item.lat ?? item.latitude_deg ?? item.Latitude ?? item.latitud;
  let lonRaw = item.longitude ?? item.lon ?? item.long ?? item.lng ?? item.longitude_deg ?? item.Longitude ?? item.longitud;
  if (latRaw === undefined || lonRaw === undefined) {
    const north = parseFloat(item.north);
    const south = parseFloat(item.south);
    const east = parseFloat(item.east);
    const west = parseFloat(item.west);
    if ([north, south, east, west].every((value) => Number.isFinite(value))) {
      latRaw = (north + south) / 2;
      lonRaw = (east + west) / 2;
    }
  }
  const lat = parseFloat(latRaw);
  const lon = parseFloat(lonRaw);
  if (!name || Number.isNaN(lat) || Number.isNaN(lon)) return null;
  return {
    name: String(name).trim(),
    centroid: [lon, lat],
    feature: null,
    line: null,
    vertices: [],
  };
}

function getCountryName(feature) {
  const props = feature.properties || {};
  return props.ADMIN || props.name || props.NAME || props.Name || feature.id || null;
}

function normalizeFallback(list) {
  return list.map(normalizeCountry).filter(Boolean);
}

async function loadSovereignList() {
  try {
    const response = await fetch(SOVEREIGN_SOURCE, { cache: 'force-cache' });
    if (!response.ok) throw new Error('bad response');
    const payload = await response.json();
    if (Array.isArray(payload) && payload.length > 50) {
      state.sovereignSet = new Set(payload.map((name) => simplifyName(String(name))));
      return;
    }
  } catch (error) {
    // ignore missing list
  }
  state.sovereignSet = null;
}

function applySovereignFilter(list) {
  if (!state.sovereignSet) return list;
  return list.filter((country) => state.sovereignSet.has(simplifyName(country.name)));
}

function extractVertices(geometry) {
  const vertices = [];
  if (!geometry) return vertices;
  const pushRing = (ring) => {
    ring.forEach((coord) => {
      if (Array.isArray(coord) && coord.length >= 2) vertices.push(coord);
    });
  };

  if (geometry.type === 'Polygon') {
    geometry.coordinates.forEach(pushRing);
  } else if (geometry.type === 'MultiPolygon') {
    geometry.coordinates.forEach((polygon) => polygon.forEach(pushRing));
  }
  return vertices;
}

function sampleVertices(vertices, max = 1200) {
  if (vertices.length <= max) return vertices;
  const step = Math.ceil(vertices.length / max);
  return vertices.filter((_, index) => index % step === 0);
}

async function loadCountries() {
  setStatus('Loading countries...');
  for (const source of COUNTRY_SOURCES) {
    try {
      const response = await fetch(source, { cache: 'force-cache' });
      if (!response.ok) throw new Error('bad response');
      const payload = await response.json();
      const normalized = Array.isArray(payload) ? payload.map(normalizeCountry).filter(Boolean) : [];
      const filtered = applySovereignFilter(normalized);
      if (filtered.length > 50) {
        prepareCountries(filtered, `Loaded ${filtered.length} countries.`);
        await loadGeoData();
        return;
      }
    } catch (error) {
      // try next source
    }
  }

  const fallback = applySovereignFilter(normalizeFallback(FALLBACK_COUNTRIES));
  prepareCountries(fallback, `Offline fallback loaded (${fallback.length} countries).`, false);
  elements.map.innerHTML = '<div class="map-label">Map unavailable</div>';
  setStatus('Offline fallback loaded.', 'error');
  recompute();
}

async function loadGeoData() {
  if (!window.turf || !window.L) {
    elements.map.innerHTML = '<div class="map-label">Map unavailable</div>';
    setStatus('Map libraries missing.', 'error');
    return;
  }

  setStatus('Loading map data...');
  for (const source of GEOJSON_SOURCES) {
    try {
      const response = await fetch(source, { cache: 'force-cache' });
      if (!response.ok) throw new Error('bad response');
      const payload = await response.json();
      if (payload && payload.features && payload.features.length > 50) {
        prepareGeoData(payload);
        return;
      }
    } catch (error) {
      // try next source
    }
  }

  elements.map.innerHTML = '<div class="map-label">Map unavailable</div>';
  setStatus('Map unavailable. Using centroid distances.', 'error');
}

function matchCountryIndex(name) {
  if (!name) return null;
  const simplified = simplifyName(name);
  if (state.simplifiedLookup.has(simplified)) return state.simplifiedLookup.get(simplified);
  if (GEO_NAME_ALIASES.has(simplified)) {
    const aliasKey = simplifyName(GEO_NAME_ALIASES.get(simplified));
    if (state.simplifiedLookup.has(aliasKey)) return state.simplifiedLookup.get(aliasKey);
  }
  if (state.aliasLookup.has(simplified)) return state.aliasLookup.get(simplified);

  const matches = [];
  state.simplifiedLookup.forEach((idx, key) => {
    if (simplified.includes(key) || key.includes(simplified)) {
      matches.push(idx);
    }
  });
  if (matches.length === 1) return matches[0];
  return null;
}

function prepareGeoData(geojson) {
  const turf = window.turf;
  if (!turf || !state.countries.length) return;

  const features = [];

  (geojson.features || []).forEach((feature) => {
    if (!feature || !feature.geometry) return;
    if (!['Polygon', 'MultiPolygon'].includes(feature.geometry.type)) return;
    const name = getCountryName(feature);
    const idx = matchCountryIndex(name);
    if (idx === null) return;

    const cleanFeature = {
      type: 'Feature',
      geometry: feature.geometry,
      properties: { name: state.countries[idx].name },
    };

    const line = turf.polygonToLine(cleanFeature);
    let centroid = state.countries[idx].centroid;
    try {
      const centroidFeature = turf.centerOfMass(cleanFeature);
      if (centroidFeature && centroidFeature.geometry && Array.isArray(centroidFeature.geometry.coordinates)) {
        centroid = centroidFeature.geometry.coordinates;
      }
    } catch (error) {
      centroid = state.countries[idx].centroid;
    }

    const vertices = sampleVertices(extractVertices(feature.geometry));

    state.countries[idx].feature = cleanFeature;
    state.countries[idx].line = line;
    state.countries[idx].vertices = vertices;
    state.countries[idx].centroid = centroid;

    features.push({
      type: 'Feature',
      geometry: feature.geometry,
      properties: { name: state.countries[idx].name, _index: idx },
    });
  });

  if (!features.length) {
    elements.map.innerHTML = '<div class="map-label">Map unavailable</div>';
    setStatus('Map unavailable. Using centroid distances.', 'error');
    return;
  }

  state.geojson = { type: 'FeatureCollection', features };
  initMap();
  recompute();
  setStatus(`Map ready with ${features.length} countries.`, 'ok');
}

function prepareCountries(list, statusMessage, enableMap = true) {
  const deduped = [];
  const seen = new Set();
  list.forEach((country) => {
    const key = simplifyName(country.name);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(country);
    }
  });
  deduped.sort((a, b) => a.name.localeCompare(b.name));
  state.countries = deduped;
  state.countryLookup.clear();
  state.simplifiedLookup.clear();
  deduped.forEach((country, index) => {
    state.countryLookup.set(country.name.toLowerCase(), index);
    state.simplifiedLookup.set(simplifyName(country.name), index);
  });
  buildAliasLookup();
  buildDatalist();
  state.distanceCache.clear();
  state.distanceMatrix = null;
  setStatus(statusMessage, 'ok');
  if (!enableMap) return;
}

function buildAliasLookup() {
  state.aliasLookup.clear();
  aliasCandidates.forEach(([alias, targets]) => {
    for (const target of targets) {
      const idx = state.countryLookup.get(target.toLowerCase());
      if (idx !== undefined) {
        state.aliasLookup.set(alias, idx);
        break;
      }
    }
  });
}

function buildDatalist() {
  elements.countryList.innerHTML = '';
  state.countries.forEach((country) => {
    const option = document.createElement('option');
    option.value = country.name;
    elements.countryList.appendChild(option);
  });
}

function resolveCountryIndex(input) {
  if (!input) return null;
  const normalized = input.trim().toLowerCase();
  if (!normalized) return null;
  if (state.countryLookup.has(normalized)) return state.countryLookup.get(normalized);
  if (state.aliasLookup.has(normalized)) return state.aliasLookup.get(normalized);
  const simplified = simplifyName(normalized);
  if (state.simplifiedLookup.has(simplified)) return state.simplifiedLookup.get(simplified);

  const matches = state.countries.filter((country) => simplifyName(country.name).includes(simplified));
  if (matches.length === 1) return state.countries.indexOf(matches[0]);
  return null;
}

function resolveCountryIndexByName(name) {
  if (!name) return null;
  const simplified = simplifyName(name);
  if (state.simplifiedLookup.has(simplified)) return state.simplifiedLookup.get(simplified);
  return null;
}

function getDistanceKm(indexA, indexB) {
  if (indexA === indexB) return 0;
  if (state.distanceMatrix) {
    const n = state.countries.length;
    return state.distanceMatrix[indexA * n + indexB];
  }
  const key = indexA < indexB ? `${indexA}|${indexB}` : `${indexB}|${indexA}`;
  if (state.distanceCache.has(key)) return state.distanceCache.get(key);

  const countryA = state.countries[indexA];
  const countryB = state.countries[indexB];

  let distance = 0;
  if (!countryA.feature || !countryB.feature) {
    if (countryA.centroid && countryB.centroid) {
      distance = haversineKm(countryA.centroid[1], countryA.centroid[0], countryB.centroid[1], countryB.centroid[0]);
    } else {
      distance = 0;
    }
  } else {
    const turf = window.turf;
    try {
      if (turf.booleanIntersects(countryA.feature, countryB.feature)) {
        distance = 0;
      } else {
        const minA = minDistanceToLine(countryA.vertices, countryB.line);
        const minB = minDistanceToLine(countryB.vertices, countryA.line);
        distance = Math.min(minA, minB);
      }
    } catch (error) {
      if (countryA.centroid && countryB.centroid) {
        distance = haversineKm(countryA.centroid[1], countryA.centroid[0], countryB.centroid[1], countryB.centroid[0]);
      } else {
        distance = 0;
      }
    }
  }

  state.distanceCache.set(key, distance);
  return distance;
}

function minDistanceToLine(vertices, line) {
  const turf = window.turf;
  if (!line || !vertices.length) return Infinity;
  let min = Infinity;
  vertices.forEach((coord) => {
    try {
      const point = turf.point(coord);
      const d = turf.pointToLineDistance(point, line, { units: 'kilometers' });
      if (d < min) min = d;
    } catch (error) {
      // ignore bad points
    }
  });
  return min;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function initMap() {
  if (!window.L || !state.geojson) {
    elements.map.innerHTML = '<div class="map-label">Map unavailable</div>';
    return;
  }
  elements.map.innerHTML = '';

  state.map = window.L.map(elements.map, {
    zoomControl: false,
    attributionControl: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
  });

  const boundsLayer = window.L.geoJSON(state.geojson);
  state.map.fitBounds(boundsLayer.getBounds(), { padding: [10, 10] });

  state.geoLayer = window.L.geoJSON(state.geojson, {
    style: () => ({
      fillColor: '#fff7ef',
      fillOpacity: 0.8,
      color: 'rgba(26, 31, 44, 0.5)',
      weight: 0.6,
    }),
  }).addTo(state.map);
}

function updateMap(candidates, bestIndex) {
  if (!state.geoLayer) return;
  const candidateSet = new Set(candidates);
  const guessedSet = new Set(state.guesses.map((guess) => guess.index));
  const closestSet = new Set(state.guesses.length ? [state.guesses[0].index] : []);
  const lastGuess = state.guesses.length ? state.guesses[state.guesses.length - 1].index : null;

  state.geoLayer.setStyle((feature) => {
    const idx = feature.properties._index;
    let fillColor = '#fff7ef';
    let fillOpacity = 0.82;
    if (closestSet.has(idx)) {
      fillColor = '#8e0b0b';
      fillOpacity = 0.92;
    } else if (guessedSet.has(idx)) {
      fillColor = '#f4a261';
      fillOpacity = 0.85;
    } else if (!candidateSet.has(idx)) {
      fillColor = '#e0e0e0';
      fillOpacity = 0.4;
    }

    let weight = idx === bestIndex ? 2.2 : 0.6;
    let color = idx === lastGuess ? '#1a1f2c' : 'rgba(26, 31, 44, 0.5)';
    if (closestSet.has(idx)) color = '#2b0a0a';

    return {
      fillColor,
      fillOpacity,
      color,
      weight,
    };
  });
}

async function loadDistances() {
  const sources = ['data/distances.json', '/api/distances'];
  for (const source of sources) {
    try {
      const response = await fetch(source, { cache: 'no-store' });
      if (!response.ok) throw new Error('no distances');
      const payload = await response.json();
      if (!payload || !Array.isArray(payload.countries) || !Array.isArray(payload.matrix)) {
        throw new Error('invalid distances');
      }
      const n = state.countries.length;
      if (payload.countries.length !== n || payload.matrix.length !== n * n) {
        throw new Error('distance mismatch');
      }
      for (let i = 0; i < n; i += 1) {
        if (simplifyName(payload.countries[i]) !== simplifyName(state.countries[i].name)) {
          throw new Error('distance order mismatch');
        }
      }
      state.distanceMatrix = Float32Array.from(payload.matrix);
      state.distanceCache.clear();
      return;
    } catch (error) {
      // try next source
    }
  }
  state.distanceMatrix = null;
}

async function loadTraining() {
  const sources = ['data/training.json', '/api/training'];
  for (const source of sources) {
    try {
      const response = await fetch(source, { cache: 'no-store' });
      if (!response.ok) throw new Error('no training');
      const payload = await response.json();
      state.training = payload;
      renderTraining();
      if (state.countries.length) {
        recompute();
      }
      return;
    } catch (error) {
      // try next source
    }
  }
  state.training = null;
  renderTraining();
}

function renderTraining() {
  const container = elements.trainingSummary;
  const list = elements.trainingList;
  if (!container || !list) return;
  list.innerHTML = '';

  if (!state.training) {
    container.innerHTML = '<span class="muted">Run training to see results here.</span>';
    return;
  }

  const training = state.training;
  const exhaustive = training.exhaustive && training.exhaustive.best;
  const best = exhaustive ? training.exhaustive.best : training.heuristic?.best;
  const settings = training.settings || {};

  if (!best) {
    container.innerHTML = '<span class="muted">Training data incomplete.</span>';
    return;
  }

  const metaParts = [];
  if (exhaustive) {
    metaParts.push(`Avg guesses: ${best.avgGuesses}`);
    if (best.worstGuesses !== undefined) {
      metaParts.push(`Worst: ${best.worstGuesses}`);
    }
  } else if (best.expectedRemaining !== undefined) {
    metaParts.push(`Expected remaining: ${best.expectedRemaining}`);
  }
  if (settings.useGeo) {
    metaParts.push(`Geo sample: ${settings.geoSample}`);
    if (settings.geoMatched) metaParts.push(`Matched: ${settings.geoMatched}`);
  }
  if (training.strategy?.weights?.avgWorstWeight !== undefined) {
    metaParts.push(`Avg/Worst weight: ${training.strategy.weights.avgWorstWeight}`);
  }
  metaParts.push(`Countries: ${training.countriesCount}`);

  container.innerHTML = `
    <div><strong>Best start:</strong> ${best.name}</div>
    <div>${metaParts.join(' | ')}</div>
  `;

  const topList = exhaustive ? training.exhaustive.top : training.heuristic?.top;
  if (!Array.isArray(topList) || !topList.length) {
    list.innerHTML = '<p class="muted">No training ranks available.</p>';
    return;
  }

  topList.slice(0, 10).forEach((item) => {
    const card = document.createElement('div');
    card.className = 'suggestion-card';
    const name = document.createElement('div');
    name.textContent = item.name;
    const score = document.createElement('div');
    score.className = 'score';
    score.textContent = exhaustive
      ? `Avg ${Number(item.avgGuesses).toFixed(2)} | Worst ${item.worstGuesses ?? '-'}`
      : `Exp. remaining ${Number(item.expectedRemaining).toFixed(2)}`;
    card.appendChild(name);
    card.appendChild(score);
    list.appendChild(card);
  });
}

function getTrainingStartList() {
  if (!state.training) return null;
  const top = state.training.exhaustive?.top || state.training.heuristic?.top;
  if (!Array.isArray(top)) return null;
  const indices = top
    .map((item) => resolveCountryIndexByName(item.name))
    .filter((idx) => idx !== null);
  return indices.length ? indices : null;
}

function addGuess() {
  const rawName = elements.countryInput.value;
  const countryIndex = resolveCountryIndex(rawName);
  if (countryIndex === null) {
    alert('Pick a valid country from the list.');
    return;
  }
  if (state.guesses.some((guess) => guess.index === countryIndex)) {
    alert('You already added that country.');
    return;
  }

  const rankRaw = elements.rankInput.value;
  let rank = rankRaw ? Math.round(Number(rankRaw)) : state.guesses.length + 1;
  if (!Number.isFinite(rank) || rank < 1) rank = 1;
  if (rank > state.guesses.length + 1) rank = state.guesses.length + 1;

  let distanceKm = null;
  if (elements.distanceInput.value !== '') {
    distanceKm = Math.round(Number(elements.distanceInput.value));
    if (!Number.isFinite(distanceKm) || distanceKm < 0) {
      alert('Enter a valid distance in km.');
      return;
    }
  }

  const guess = {
    id: state.nextGuessId,
    index: countryIndex,
    name: state.countries[countryIndex].name,
    distanceKm,
  };

  state.nextGuessId += 1;
  state.guessHistory.push(guess.id);
  state.guesses.splice(rank - 1, 0, guess);
  rebuildOrderConstraints();

  elements.countryInput.value = '';
  elements.distanceInput.value = '';
  elements.rankInput.value = '';
  renderGuesses();
  recompute();
}

function undoGuess() {
  const lastId = state.guessHistory.pop();
  if (!lastId) return;
  const index = state.guesses.findIndex((guess) => guess.id === lastId);
  if (index === -1) return;
  state.guesses.splice(index, 1);
  rebuildOrderConstraints();
  renderGuesses();
  recompute();
}

function resetGuesses() {
  state.guesses = [];
  state.bestDistance = null;
  state.guessHistory = [];
  state.nextGuessId = 1;
  rebuildOrderConstraints();
  renderGuesses();
  recompute();
}

function renderGuesses() {
  elements.guessList.innerHTML = '';
  if (!state.guesses.length) {
    elements.guessList.innerHTML = '<p class="muted">No guesses yet.</p>';
    return;
  }
  state.guesses.forEach((guess, idx) => {
    const item = document.createElement('div');
    item.className = 'guess-item';
    const meta = document.createElement('div');
    meta.className = 'guess-meta';
    const chip = document.createElement('div');
    chip.className = 'guess-chip';
    chip.style.background = idx === 0 ? '#8e0b0b' : '#f4a261';
    chip.style.color = idx === 0 ? '#fff' : '#0b0f1a';
    chip.textContent = `#${idx + 1}`;

    const info = document.createElement('div');
    info.className = 'guess-info';
    const name = document.createElement('div');
    name.textContent = guess.name;
    const distanceHint = document.createElement('div');
    distanceHint.className = 'muted';
    distanceHint.textContent = guess.distanceKm !== null
      ? `${guess.distanceKm} km`
      : 'No distance';

    info.appendChild(name);
    info.appendChild(distanceHint);
    meta.appendChild(chip);
    meta.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'guess-actions';
    const up = document.createElement('button');
    up.className = 'ghost small';
    up.textContent = '↑';
    up.disabled = idx === 0;
    up.addEventListener('click', () => moveGuess(idx, -1));
    const down = document.createElement('button');
    down.className = 'ghost small';
    down.textContent = '↓';
    down.disabled = idx === state.guesses.length - 1;
    down.addEventListener('click', () => moveGuess(idx, 1));
    actions.appendChild(up);
    actions.appendChild(down);

    item.appendChild(meta);
    item.appendChild(actions);
    elements.guessList.appendChild(item);
  });
}

function moveGuess(index, direction) {
  const target = index + direction;
  if (target < 0 || target >= state.guesses.length) return;
  const [guess] = state.guesses.splice(index, 1);
  state.guesses.splice(target, 0, guess);
  rebuildOrderConstraints();
  renderGuesses();
  recompute();
}

function rebuildOrderConstraints() {
  const constraints = [];
  for (let i = 0; i < state.guesses.length; i += 1) {
    for (let j = i + 1; j < state.guesses.length; j += 1) {
      constraints.push({ closer: state.guesses[i].index, farther: state.guesses[j].index });
    }
  }
  state.orderConstraints = constraints;
  const distances = state.guesses
    .map((guess) => guess.distanceKm)
    .filter((distance) => Number.isFinite(distance));
  state.bestDistance = distances.length ? Math.min(...distances) : null;
}

function filterCandidates() {
  const total = state.countries.length;
  const candidates = [];
  const distanceGuesses = state.guesses.filter((guess) => Number.isFinite(guess.distanceKm));
  for (let i = 0; i < total; i += 1) {
    let ok = true;
    for (const guess of distanceGuesses) {
      const d = getDistanceKm(guess.index, i);
      const tolerance = guess.distanceKm === 0 ? BORDER_TOLERANCE_KM : DISTANCE_TOLERANCE_KM;
      if (Math.abs(d - guess.distanceKm) > tolerance) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    for (const constraint of state.orderConstraints) {
      const dCloser = getDistanceKm(constraint.closer, i);
      const dFarther = getDistanceKm(constraint.farther, i);
      if (dCloser >= dFarther - ORDER_TOLERANCE_KM) {
        ok = false;
        break;
      }
    }
    if (ok) candidates.push(i);
  }
  return candidates;
}

function averageDistance(guessIndex, candidateIndices) {
  let total = 0;
  candidateIndices.forEach((targetIndex) => {
    total += getDistanceKm(guessIndex, targetIndex);
  });
  return total / candidateIndices.length;
}

function compareGuessState(a, b) {
  if (a.actualDistance !== b.actualDistance) return a.actualDistance - b.actualDistance;
  return a.index - b.index;
}

function serializeGuessState(guesses) {
  if (!guesses.length) return 'start';
  return guesses
    .map((guess) => `${guess.index}:${Number.isFinite(guess.distanceKm) ? guess.distanceKm : 'x'}`)
    .join('|');
}

function buildOutcomeState(existingGuesses, guessIndex, targetIndex) {
  const nextGuesses = existingGuesses.map((guess) => ({
    index: guess.index,
    distanceKm: guess.distanceKm,
    actualDistance: getDistanceKm(guess.index, targetIndex),
  }));
  const guessDistance = getDistanceKm(guessIndex, targetIndex);
  nextGuesses.push({
    index: guessIndex,
    distanceKm: Math.round(guessDistance),
    actualDistance: guessDistance,
  });
  nextGuesses.sort(compareGuessState);
  return {
    key: serializeGuessState(nextGuesses),
    distanceKm: Math.round(guessDistance),
  };
}

function exactSplitStats(candidateIndices, guesses, guessIndex) {
  const total = candidateIndices.length;
  const counts = new Map();
  let solvedCount = 0;

  candidateIndices.forEach((targetIndex) => {
    if (targetIndex === guessIndex) {
      solvedCount += 1;
      return;
    }
    const outcome = buildOutcomeState(guesses, guessIndex, targetIndex);
    counts.set(outcome.key, (counts.get(outcome.key) || 0) + 1);
  });

  let expected = 0;
  let worst = 0;
  counts.forEach((count) => {
    expected += (count * count) / total;
    if (count > worst) worst = count;
  });

  return { expected, worst, solvedCount };
}

function rankSuggestions(candidateIndices, guessPool = null) {
  const guessedSet = new Set(state.guesses.map((guess) => guess.index));
  const pool = (guessPool || candidateIndices).filter((idx) => !guessedSet.has(idx));
  if (!pool.length) return [];
  const avgWorstWeight = state.training?.strategy?.weights?.avgWorstWeight ?? DEFAULT_AVG_WORST_WEIGHT;
  const scores = pool.map((idx) => {
    const stats = exactSplitStats(candidateIndices, state.guesses, idx);
    const expected = stats.expected;
    const worst = stats.worst;
    const avgDistance = averageDistance(idx, candidateIndices);
    const score = expected * avgWorstWeight + worst * (1 - avgWorstWeight);
    return {
      index: idx,
      expected,
      worst,
      avgDistance,
      combined: score,
      solvedCount: stats.solvedCount,
    };
  });
  state.rankWeights = { avgWorst: avgWorstWeight };

  scores.sort((a, b) => {
    if (a.combined !== b.combined) return a.combined - b.combined;
    if (a.expected !== b.expected) return a.expected - b.expected;
    if (a.worst !== b.worst) return a.worst - b.worst;
    if (a.solvedCount !== b.solvedCount) return b.solvedCount - a.solvedCount;
    return a.avgDistance - b.avgDistance;
  });
  return scores;
}

function hasCombined(scores) {
  return scores.length && scores[0].combined !== null;
}

function hasTriangulation(scores) {
  return false;
}

function formatTriangulationLabel(item) {
  return '';
}

function formatCombinedLabel(item) {
  if (item.combined === null) return '';
  const weights = state.rankWeights;
  const weightLabel = weights
    ? `(avg ${Math.round((weights.avgWorst ?? DEFAULT_AVG_WORST_WEIGHT) * 100)}% / worst ${100 - Math.round((weights.avgWorst ?? DEFAULT_AVG_WORST_WEIGHT) * 100)}%)`
    : '';
  return `Combined score: ${item.combined.toFixed(3)} ${weightLabel}`.trim();
}

function recompute() {
  if (!state.countries.length) return;
  if (!state.guesses.length) {
    const candidates = state.countries.map((_, idx) => idx);
    const allGuesses = candidates;
    const trainedList = getTrainingStartList();
    const ranked = rankSuggestions(candidates, allGuesses);

    if (trainedList && trainedList.length) {
      const bestIdx = trainedList[0];
      const training = state.training;
      const bestLabel = training?.exhaustive?.best
        ? `Avg guesses: ${training.exhaustive.best.avgGuesses}`
        : `Expected remaining: ${training?.heuristic?.best?.expectedRemaining ?? '-'}`;

      elements.candidateCount.textContent = `Loaded ${state.countries.length} countries. Using trained starting list.`;
      elements.nextGuessName.textContent = state.countries[bestIdx].name;
      elements.nextGuessScore.textContent = bestLabel;
      elements.nextGuessScorePill.textContent = 'trained';

      elements.topSuggestions.innerHTML = '';
      trainedList.slice(0, 8).forEach((idx) => {
        const card = document.createElement('div');
        card.className = 'suggestion-card';
        const name = document.createElement('div');
        name.textContent = state.countries[idx].name;
        const score = document.createElement('div');
        score.className = 'score';
        score.textContent = 'trained start';
        card.appendChild(name);
        card.appendChild(score);
        elements.topSuggestions.appendChild(card);
      });

      elements.remainingList.innerHTML = '';
      const remainingNames = candidates.map((idx) => state.countries[idx].name).sort((a, b) => a.localeCompare(b));
      remainingNames.slice(0, 32).forEach((name) => {
        const chip = document.createElement('div');
        chip.className = 'candidate-chip';
        chip.textContent = name;
        elements.remainingList.appendChild(chip);
      });
      if (remainingNames.length > 32) {
        const chip = document.createElement('div');
        chip.className = 'candidate-chip';
        chip.textContent = `+${remainingNames.length - 32} more`;
        elements.remainingList.appendChild(chip);
      }

      updateMap(candidates, bestIdx);
      return;
    }

    elements.candidateCount.textContent = `Loaded ${state.countries.length} countries. Suggested starting guess below.`;

    if (!ranked.length) {
      elements.nextGuessName.textContent = '-';
      elements.nextGuessScore.textContent = '';
      elements.nextGuessScorePill.textContent = '-';
      elements.topSuggestions.innerHTML = '<p class="muted">No suggestions yet.</p>';
      elements.remainingList.innerHTML = '';
      updateMap(candidates, null);
      return;
    }

    const best = ranked[0];
    elements.nextGuessName.textContent = state.countries[best.index].name;
    elements.nextGuessScore.textContent = `${formatCombinedLabel(best)} | Expected ${best.expected.toFixed(2)} | Worst ${best.worst}`;
    elements.nextGuessScorePill.textContent = 'exact split';

    elements.topSuggestions.innerHTML = '';
    ranked.slice(0, 8).forEach((item) => {
      const card = document.createElement('div');
      card.className = 'suggestion-card';
      const name = document.createElement('div');
      name.textContent = state.countries[item.index].name;
      const score = document.createElement('div');
      score.className = 'score';
      score.textContent = `${formatCombinedLabel(item)} | Exp ${item.expected.toFixed(2)} | Worst ${item.worst}`;
      card.appendChild(name);
      card.appendChild(score);
      elements.topSuggestions.appendChild(card);
    });

    elements.remainingList.innerHTML = '';
    const remainingNames = candidates.map((idx) => state.countries[idx].name).sort((a, b) => a.localeCompare(b));
    remainingNames.slice(0, 32).forEach((name) => {
      const chip = document.createElement('div');
      chip.className = 'candidate-chip';
      chip.textContent = name;
      elements.remainingList.appendChild(chip);
    });
    if (remainingNames.length > 32) {
      const chip = document.createElement('div');
      chip.className = 'candidate-chip';
      chip.textContent = `+${remainingNames.length - 32} more`;
      elements.remainingList.appendChild(chip);
    }

    updateMap(candidates, best.index);
    return;
  }

  const candidates = filterCandidates();
  const allGuesses = state.countries.map((_, idx) => idx);
  elements.candidateCount.textContent = `${candidates.length} candidates remain after ${state.guesses.length} guesses.`;

  if (!candidates.length) {
    const fallbackCandidates = state.countries.map((_, idx) => idx);
    const rankedFallback = rankSuggestions(fallbackCandidates, allGuesses);
    elements.candidateCount.textContent = 'No candidates match your filters. Showing global suggestions.';

    if (rankedFallback.length) {
      const bestFallback = rankedFallback[0];
      elements.nextGuessName.textContent = state.countries[bestFallback.index].name;
      if (hasCombined(rankedFallback)) {
        elements.nextGuessScore.textContent = `${formatCombinedLabel(bestFallback)} | Expected ${bestFallback.expected.toFixed(2)} | Worst ${bestFallback.worst}`;
        elements.nextGuessScorePill.textContent = 'exact split';
      } else {
        elements.nextGuessScore.textContent = 'No exact matches. Try another guess or adjust the order.';
        elements.nextGuessScorePill.textContent = `${bestFallback.avgDistance.toFixed(0)} km avg`;
      }

      elements.topSuggestions.innerHTML = '';
      rankedFallback.slice(0, 8).forEach((item) => {
        const card = document.createElement('div');
        card.className = 'suggestion-card';
        const name = document.createElement('div');
        name.textContent = state.countries[item.index].name;
        const score = document.createElement('div');
        score.className = 'score';
        if (hasCombined(rankedFallback)) {
          score.textContent = `${formatCombinedLabel(item)} | Exp ${item.expected.toFixed(2)} | Worst ${item.worst}`;
        } else {
          score.textContent = `Exp. remaining ${item.expected.toFixed(1)} | Avg ${item.avgDistance.toFixed(0)} km`;
        }
        card.appendChild(name);
        card.appendChild(score);
        elements.topSuggestions.appendChild(card);
      });
    } else {
      elements.nextGuessName.textContent = 'No matches';
      elements.nextGuessScore.textContent = 'Double-check the rank order or distance.';
      elements.nextGuessScorePill.textContent = '0';
      elements.topSuggestions.innerHTML = '<p class="muted">No candidates match your filters.</p>';
    }

    elements.remainingList.innerHTML = '';
    updateMap(fallbackCandidates, rankedFallback.length ? rankedFallback[0].index : null);
    return;
  }

  const ranked = rankSuggestions(candidates, allGuesses);
  if (!ranked.length) {
    elements.nextGuessName.textContent = state.countries[candidates[0]].name;
    elements.nextGuessScore.textContent = 'Only guessed countries remain. Reset to continue.';
    elements.nextGuessScorePill.textContent = '-';
    updateMap(candidates, null);
    return;
  }

  const best = ranked[0];
  elements.nextGuessName.textContent = state.countries[best.index].name;
  if (hasCombined(ranked)) {
    elements.nextGuessScore.textContent = `${formatCombinedLabel(best)} | Expected ${best.expected.toFixed(2)} | Worst ${best.worst}`;
    elements.nextGuessScorePill.textContent = 'exact split';
  } else {
    elements.nextGuessScore.textContent = `Expected remaining: ${best.expected.toFixed(1)} countries`;
    elements.nextGuessScorePill.textContent = `${best.avgDistance.toFixed(0)} km avg`;
  }

  elements.topSuggestions.innerHTML = '';
  ranked.slice(0, 8).forEach((item) => {
    const card = document.createElement('div');
    card.className = 'suggestion-card';
    const name = document.createElement('div');
    name.textContent = state.countries[item.index].name;
    const score = document.createElement('div');
    score.className = 'score';
    if (hasCombined(ranked)) {
      score.textContent = `${formatCombinedLabel(item)} | Exp ${item.expected.toFixed(2)} | Worst ${item.worst}`;
    } else {
      score.textContent = `Exp. remaining ${item.expected.toFixed(1)} | Avg ${item.avgDistance.toFixed(0)} km`;
    }
    card.appendChild(name);
    card.appendChild(score);
    elements.topSuggestions.appendChild(card);
  });

  elements.remainingList.innerHTML = '';
  const remainingNames = candidates.map((idx) => state.countries[idx].name).sort((a, b) => a.localeCompare(b));
  remainingNames.slice(0, 32).forEach((name) => {
    const chip = document.createElement('div');
    chip.className = 'candidate-chip';
    chip.textContent = name;
    elements.remainingList.appendChild(chip);
  });

  if (remainingNames.length > 32) {
    const chip = document.createElement('div');
    chip.className = 'candidate-chip';
    chip.textContent = `+${remainingNames.length - 32} more`;
    elements.remainingList.appendChild(chip);
  }

  updateMap(candidates, best.index);
}

function attachEvents() {
  elements.addGuess.addEventListener('click', addGuess);
  elements.undoGuess.addEventListener('click', undoGuess);
  elements.resetGuess.addEventListener('click', resetGuesses);
  elements.countryInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addGuess();
    }
  });
}

async function init() {
  attachEvents();
  renderGuesses();
  await loadSovereignList();
  await loadCountries();
  await loadDistances();
  loadTraining();
}

init();
