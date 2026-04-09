const https = require('https');
const { readFile, writeFile, mkdir } = require('fs/promises');
const path = require('path');

const COUNTRY_SOURCES = [
  'http://localhost:5173/api/countries',
  'https://raw.githubusercontent.com/samayo/country-json/master/src/country-by-geo-coordinates.json',
  'https://raw.githubusercontent.com/eesur/country-codes-lat-long/master/country-codes-lat-long-alpha3.json',
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

const DEFAULT_TOLERANCE_KM = 25;
const DEFAULT_BORDER_TOLERANCE_KM = 0;
const DEFAULT_BUCKET_KM = 100;
const DEFAULT_MAX_STEPS = 12;
const DEFAULT_GEO_SAMPLE = 60;
const DEFAULT_GEO_STEP_KM = 25;
const TRIANGULATION_MIN_GUESSES = 2;
const DEFAULT_TRI_WEIGHT_2 = 0.4;
const DEFAULT_TRI_WEIGHT_3 = 0.5;
const DEFAULT_TRI_WEIGHT_4 = 0.6;
const DEFAULT_AVG_WORST_WEIGHT = 0.7;
const DEFAULT_FARTHEST_WEIGHT = 0.2;
const DEFAULT_AVG_WORST_MIN = 0.55;
const DEFAULT_AVG_WORST_MAX = 0.95;
const DEFAULT_AVG_WORST_STEP = 0.01;
const EARTH_RADIUS_KM = 6371;
const LOCAL_CACHE_PATH = path.join(__dirname, 'data', 'countries.json');
const SOVEREIGN_PATH = path.join(__dirname, 'data', 'sovereign-countries.json');
const TRAINING_PATH = path.join(__dirname, 'data', 'training.json');
const DISTANCES_PATH = path.join(__dirname, 'data', 'distances.json');

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
  return { name: String(name).trim(), lat, lon };
}

function getCountryName(feature) {
  const props = feature.properties || {};
  return props.ADMIN || props.name || props.NAME || props.Name || feature.id || null;
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

function sampleVertices(vertices, max) {
  if (!max || max <= 0 || vertices.length <= max) return vertices;
  const step = Math.ceil(vertices.length / max);
  return vertices.filter((_, index) => index % step === 0);
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

function interpolateGreatCircle(lat1, lon1, lat2, lon2, fraction) {
  const lat1Rad = toRad(lat1);
  const lon1Rad = toRad(lon1);
  const lat2Rad = toRad(lat2);
  const lon2Rad = toRad(lon2);

  const x1 = Math.cos(lat1Rad) * Math.cos(lon1Rad);
  const y1 = Math.cos(lat1Rad) * Math.sin(lon1Rad);
  const z1 = Math.sin(lat1Rad);

  const x2 = Math.cos(lat2Rad) * Math.cos(lon2Rad);
  const y2 = Math.cos(lat2Rad) * Math.sin(lon2Rad);
  const z2 = Math.sin(lat2Rad);

  const dot = x1 * x2 + y1 * y2 + z1 * z2;
  const omega = Math.acos(Math.min(1, Math.max(-1, dot)));
  if (!Number.isFinite(omega) || omega === 0) {
    return [lon1, lat1];
  }
  const sinOmega = Math.sin(omega);
  const t1 = Math.sin((1 - fraction) * omega) / sinOmega;
  const t2 = Math.sin(fraction * omega) / sinOmega;

  const x = t1 * x1 + t2 * x2;
  const y = t1 * y1 + t2 * y2;
  const z = t1 * z1 + t2 * z2;

  const lat = Math.atan2(z, Math.sqrt(x * x + y * y));
  const lon = Math.atan2(y, x);
  return [toDeg(lon), toDeg(lat)];
}

function densifyRing(ring, stepKm) {
  const points = [];
  if (!Array.isArray(ring) || ring.length < 2) return points;
  const len = ring.length;
  for (let i = 0; i < len; i += 1) {
    const current = ring[i];
    const next = ring[(i + 1) % len];
    if (!Array.isArray(current) || !Array.isArray(next)) continue;
    if (current.length < 2 || next.length < 2) continue;
    points.push(current);
    const dist = haversineKm(current[1], current[0], next[1], next[0]);
    if (!Number.isFinite(dist) || dist <= stepKm) continue;
    const steps = Math.ceil(dist / stepKm);
    for (let s = 1; s < steps; s += 1) {
      const fraction = s / steps;
      points.push(interpolateGreatCircle(current[1], current[0], next[1], next[0], fraction));
    }
  }
  return points;
}

function densifyGeometry(geometry, stepKm) {
  const points = [];
  if (!geometry || !stepKm || stepKm <= 0) return points;
  if (geometry.type === 'Polygon') {
    geometry.coordinates.forEach((ring) => {
      points.push(...densifyRing(ring, stepKm));
    });
  } else if (geometry.type === 'MultiPolygon') {
    geometry.coordinates.forEach((polygon) => {
      polygon.forEach((ring) => {
        points.push(...densifyRing(ring, stepKm));
      });
    });
  }
  return points;
}

function dedupeCountries(list) {
  const seen = new Set();
  const output = [];
  list.forEach((country) => {
    const key = simplifyName(country.name);
    if (!seen.has(key)) {
      seen.add(key);
      output.push(country);
    }
  });
  output.sort((a, b) => a.name.localeCompare(b.name));
  return output;
}

async function loadSovereignSet() {
  try {
    const raw = await readFile(SOVEREIGN_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 50) {
      return new Set(parsed.map((name) => simplifyName(String(name))));
    }
  } catch (error) {
    // ignore missing file
  }
  return null;
}

function filterSovereign(list, sovereignSet) {
  if (!sovereignSet) return list;
  return list.filter((country) => sovereignSet.has(simplifyName(country.name)));
}

function fetchJson(url) {
  if (typeof fetch === 'function') {
    return fetch(url, { cache: 'no-store' }).then((response) => {
      if (!response.ok) throw new Error('bad response');
      return response.json();
    });
  }

  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`bad response: ${res.statusCode}`));
        return;
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

async function loadCountries() {
  const sovereignSet = await loadSovereignSet();
  try {
    const cached = await readFile(LOCAL_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(cached);
    if (Array.isArray(parsed) && parsed.length > 50) {
      const normalized = dedupeCountries(parsed.map(normalizeCountry).filter(Boolean));
      return {
        countries: filterSovereign(normalized, sovereignSet),
        source: LOCAL_CACHE_PATH,
      };
    }
  } catch (error) {
    // ignore cache read errors
  }

  for (const source of COUNTRY_SOURCES) {
    try {
      const payload = await fetchJson(source);
      const normalized = Array.isArray(payload) ? payload.map(normalizeCountry).filter(Boolean) : [];
      if (normalized.length > 50) {
        return { countries: filterSovereign(dedupeCountries(normalized), sovereignSet), source };
      }
    } catch (error) {
      // try next source
    }
  }
  return {
    countries: filterSovereign(dedupeCountries(FALLBACK_COUNTRIES.map(normalizeCountry).filter(Boolean)), sovereignSet),
    source: 'fallback',
  };
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

async function loadGeoJSON() {
  try {
    const geoPath = path.join(__dirname, 'data', 'countries.geojson');
    const raw = await readFile(geoPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.features) && parsed.features.length > 50) {
      return parsed;
    }
  } catch (error) {
    // ignore
  }
  return null;
}

function buildGeoPoints(geojson, countries) {
  if (!geojson) return null;
  const indexByName = new Map();
  countries.forEach((country, idx) => {
    indexByName.set(simplifyName(country.name), idx);
  });

  const pointsByIndex = new Array(countries.length).fill(null);
  let matched = 0;

  (geojson.features || []).forEach((feature) => {
    if (!feature || !feature.geometry) return;
    if (!['Polygon', 'MultiPolygon'].includes(feature.geometry.type)) return;
    const name = getCountryName(feature);
    if (!name) return;
    let key = simplifyName(name);
    if (!indexByName.has(key) && GEO_NAME_ALIASES.has(key)) {
      key = simplifyName(GEO_NAME_ALIASES.get(key));
    }
    const idx = indexByName.get(key);
    if (idx === undefined) return;

    const vertices = settings.geoStepKm > 0
      ? densifyGeometry(feature.geometry, settings.geoStepKm)
      : extractVertices(feature.geometry);
    const sampled = sampleVertices(vertices, settings.geoSample);
    if (!sampled.length) return;

    const points = sampled.map(([lon, lat]) => {
      const latRad = (lat * Math.PI) / 180;
      const lonRad = (lon * Math.PI) / 180;
      return { lat: latRad, lon: lonRad, cosLat: Math.cos(latRad) };
    });

    pointsByIndex[idx] = points;
    matched += 1;
  });

  return { pointsByIndex, matched };
}

function minPointDistance(pointsA, pointsB) {
  let min = Infinity;
  for (let i = 0; i < pointsA.length; i += 1) {
    const a = pointsA[i];
    for (let j = 0; j < pointsB.length; j += 1) {
      const b = pointsB[j];
      const dLat = b.lat - a.lat;
      const dLon = b.lon - a.lon;
      const sinHalfLat = Math.sin(dLat / 2);
      const sinHalfLon = Math.sin(dLon / 2);
      const h = sinHalfLat * sinHalfLat + a.cosLat * b.cosLat * sinHalfLon * sinHalfLon;
      const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
      const d = EARTH_RADIUS_KM * c;
      if (d < min) {
        min = d;
        if (min <= 0.5) return 0;
      }
    }
  }
  return min;
}

function buildDistanceMatrix(countries, geoPoints) {
  const n = countries.length;
  const matrix = new Float32Array(n * n);
  for (let i = 0; i < n; i += 1) {
    matrix[i * n + i] = 0;
    for (let j = i + 1; j < n; j += 1) {
      const a = countries[i];
      const b = countries[j];
      let d = 0;
      if (geoPoints && geoPoints.pointsByIndex[i] && geoPoints.pointsByIndex[j]) {
        d = minPointDistance(geoPoints.pointsByIndex[i], geoPoints.pointsByIndex[j]);
      } else {
        d = haversineKm(a.lat, a.lon, b.lat, b.lon);
      }
      matrix[i * n + j] = d;
      matrix[j * n + i] = d;
    }
  }
  return matrix;
}

function expectedRemainingStats(guessIndex, candidateIndices, bestDistance, distances, n) {
  const threshold = bestDistance - settings.toleranceKm;
  const counts = new Map();
  let notCloserCount = 0;

  candidateIndices.forEach((targetIndex) => {
    const d = distances[guessIndex * n + targetIndex];
    if (d < threshold) {
      const bucket = Math.round(d / settings.bucketKm) * settings.bucketKm;
      counts.set(bucket, (counts.get(bucket) || 0) + 1);
    } else {
      notCloserCount += 1;
    }
  });

  const total = candidateIndices.length;
  let expected = 0;
  let worst = notCloserCount;
  counts.forEach((count) => {
    expected += (count * count) / total;
    if (count > worst) worst = count;
  });
  expected += (notCloserCount * notCloserCount) / total;
  return { expected, worst };
}

function triangulationError(guessIndex, closestGuesses, distances, n) {
  if (!closestGuesses.length) return 0;
  let total = 0;
  closestGuesses.forEach((guess) => {
    const d = distances[guessIndex * n + guess.index];
    total += Math.abs(d - guess.distanceKm);
  });
  return total / closestGuesses.length;
}

function normalizeValues(values) {
  if (!values.length) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max - min < 1e-6) return values.map(() => 0);
  return values.map((value) => (value - min) / (max - min));
}

function getTriangulationWeights(count) {
  if (count < TRIANGULATION_MIN_GUESSES) return { expected: 1, triangulation: 0 };
  const triWeight = count === 2
    ? settings.triWeight2
    : count === 3
      ? settings.triWeight3
      : settings.triWeight4;
  const clamped = Math.min(1, Math.max(0, triWeight));
  return { expected: 1 - clamped, triangulation: clamped };
}

function rankSuggestions(candidateIndices, bestDistance, distances, n, guessedSet, guesses = []) {
  const scores = [];
  const closestGuesses = guesses.filter((guess) => Number.isFinite(guess.distanceKm));
  const useTriangulation = closestGuesses.length >= TRIANGULATION_MIN_GUESSES;
  const weights = getTriangulationWeights(closestGuesses.length);
  const avgWorstWeight = settings.avgWorstWeight;
  const farthestGuess = guesses.length > 1 ? guesses[guesses.length - 1] : null;
  const farthestWeight = farthestGuess ? DEFAULT_FARTHEST_WEIGHT : 0;
  candidateIndices.forEach((idx) => {
    if (guessedSet.has(idx)) return;
    const stats = expectedRemainingStats(idx, candidateIndices, bestDistance, distances, n);
    const expected = stats.expected;
    const worst = stats.worst;
    let avgDistance = 0;
    candidateIndices.forEach((targetIdx) => {
      avgDistance += distances[idx * n + targetIdx];
    });
    avgDistance /= candidateIndices.length;
    const triangulation = useTriangulation
      ? triangulationError(idx, closestGuesses, distances, n)
      : null;
    const farthestDistance = farthestGuess ? distances[idx * n + farthestGuess.index] : null;
    scores.push({
      index: idx,
      expected,
      worst,
      avgDistance,
      triangulation,
      farthestDistance,
      combined: null,
      baseScore: null,
    });
  });

  const expectedValues = scores.map((item) => item.expected);
  const worstValues = scores.map((item) => item.worst);
  const expectedNorm = normalizeValues(expectedValues);
  const worstNorm = normalizeValues(worstValues);
  const baseScores = expectedNorm.map((value, idx) => value * avgWorstWeight + worstNorm[idx] * (1 - avgWorstWeight));
  scores.forEach((item, idx) => {
    item.baseScore = baseScores[idx];
  });

  const useCombined = useTriangulation || farthestWeight > 0;
  if (useCombined) {
    const triangulationNorm = useTriangulation
      ? normalizeValues(scores.map((item) => item.triangulation))
      : [];
    const farthestPenalty = farthestGuess
      ? normalizeValues(scores.map((item) => item.farthestDistance)).map((value) => 1 - value)
      : [];
    const weightScale = 1 - farthestWeight;
    const expectedWeight = (useTriangulation ? weights.expected : 1) * weightScale;
    const triangulationWeight = (useTriangulation ? weights.triangulation : 0) * weightScale;
    scores.forEach((item, idx) => {
      let combined = baseScores[idx] * expectedWeight;
      if (useTriangulation) combined += triangulationNorm[idx] * triangulationWeight;
      if (farthestWeight > 0) combined += farthestPenalty[idx] * farthestWeight;
      item.combined = combined;
    });
  } else {
    scores.forEach((item, idx) => {
      item.combined = baseScores[idx];
    });
  }

  scores.sort((a, b) => {
    if (useCombined && a.combined !== b.combined) return a.combined - b.combined;
    if (a.expected !== b.expected) return a.expected - b.expected;
    if (a.worst !== b.worst) return a.worst - b.worst;
    if (useTriangulation && a.triangulation !== b.triangulation) return a.triangulation - b.triangulation;
    if (farthestGuess && a.farthestDistance !== b.farthestDistance) {
      return b.farthestDistance - a.farthestDistance;
    }
    return a.avgDistance - b.avgDistance;
  });
  return scores;
}

function filterCandidates(candidates, guesses, distances, n) {
  const constraints = [];
  for (let i = 0; i < guesses.length; i += 1) {
    for (let j = i + 1; j < guesses.length; j += 1) {
      constraints.push({ closer: guesses[i].index, farther: guesses[j].index });
    }
  }

  return candidates.filter((idx) => {
    for (const guess of guesses) {
      const d = distances[guess.index * n + idx];
      if (Number.isFinite(guess.distanceKm)) {
        const tolerance = guess.distanceKm === 0 ? settings.borderToleranceKm : settings.toleranceKm;
        if (Math.abs(d - guess.distanceKm) > tolerance) return false;
      }
    }
    for (const constraint of constraints) {
      const dCloser = distances[constraint.closer * n + idx];
      const dFarther = distances[constraint.farther * n + idx];
      if (dCloser >= dFarther) return false;
    }
    return true;
  });
}

function simulateTarget(targetIndex, countries, distances, startIndex = null) {
  const n = countries.length;
  const allIndices = Array.from({ length: n }, (_, i) => i);
  let candidates = allIndices.slice();
  const guessedSet = new Set();
  const guesses = [];
  let bestDistance = Infinity;

  const applyGuess = (idx) => {
    guessedSet.add(idx);
    const distance = distances[idx * n + targetIndex];
    const isClosest = distance < bestDistance;
    if (isClosest) bestDistance = distance;
    const guess = {
      index: idx,
      actualDistance: distance,
      distanceKm: Math.round(distance),
    };
    let insertAt = guesses.findIndex((item) => item.actualDistance > distance);
    if (insertAt === -1) insertAt = guesses.length;
    guesses.splice(insertAt, 0, guess);
    bestDistance = guesses[0].actualDistance;
    if (idx === targetIndex) return true;
    candidates = filterCandidates(allIndices, guesses, distances, n);
    return false;
  };

  if (startIndex !== null) {
    if (applyGuess(startIndex)) return 1;
  }

  for (let step = startIndex === null ? 0 : 1; step < settings.maxSteps; step += 1) {
    const ranked = rankSuggestions(candidates, bestDistance, distances, n, guessedSet, guesses);
    if (!ranked.length) break;
    const nextGuess = ranked[0].index;
    if (guessedSet.has(nextGuess)) break;
    if (applyGuess(nextGuess)) return guesses.length;
    if (!candidates.length) break;
  }

  return settings.maxSteps + 1;
}

function evaluateStartIndex(startIndex, countries, distances) {
  const n = countries.length;
  let total = 0;
  let worst = 0;
  for (let targetIdx = 0; targetIdx < n; targetIdx += 1) {
    const guesses = simulateTarget(targetIdx, countries, distances, startIndex);
    total += guesses;
    if (guesses > worst) worst = guesses;

    if (settings.earlyStop) {
      const remaining = n - targetIdx - 1;
      const bestPossible = (total + remaining * 1) / n;
      if (bestPossible >= settings.bestAvg) {
        return { avg: Infinity, worst: Infinity, aborted: true };
      }
    }
  }
  return { avg: total / n, worst, aborted: false };
}

function evaluatePolicy(countries, distances) {
  const n = countries.length;
  let total = 0;
  let worst = 0;
  for (let targetIdx = 0; targetIdx < n; targetIdx += 1) {
    const guesses = simulateTarget(targetIdx, countries, distances);
    total += guesses;
    if (guesses > worst) worst = guesses;
  }
  return { avg: total / n, worst };
}

function sweepAvgWorstWeights(countries, distances) {
  const results = [];
  for (
    let weight = settings.avgWorstMin;
    weight <= settings.avgWorstMax + 1e-9;
    weight += settings.avgWorstStep
  ) {
    const rounded = Math.round(weight * 1000) / 1000;
    settings.avgWorstWeight = rounded;
    const { avg, worst } = evaluatePolicy(countries, distances);
    const score = avg + worst;
    results.push({ weight: rounded, avg, worst, score });
    console.log(`Avg/Worst weight ${rounded.toFixed(3)} -> avg ${avg.toFixed(2)} worst ${worst} score ${score.toFixed(2)}`);
  }

  results.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    if (a.avg !== b.avg) return a.avg - b.avg;
    return a.worst - b.worst;
  });

  const best = results[0];
  return { best, results };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const getValue = (flag, fallback) => {
    const idx = args.indexOf(flag);
    if (idx !== -1 && args[idx + 1]) return args[idx + 1];
    return fallback;
  };
  return {
    exhaustive: args.includes('--exhaustive') || args.includes('--full'),
    maxSteps: Number(getValue('--max-steps', DEFAULT_MAX_STEPS)),
    toleranceKm: Number(getValue('--tolerance', DEFAULT_TOLERANCE_KM)),
    borderToleranceKm: Number(getValue('--border-tolerance', DEFAULT_BORDER_TOLERANCE_KM)),
    bucketKm: Number(getValue('--bucket', DEFAULT_BUCKET_KM)),
    geoSample: Number(getValue('--geo-sample', DEFAULT_GEO_SAMPLE)),
    geoStepKm: Number(getValue('--geo-step-km', DEFAULT_GEO_STEP_KM)),
    triWeight2: Number(getValue('--tri-weight-2', DEFAULT_TRI_WEIGHT_2)),
    triWeight3: Number(getValue('--tri-weight-3', DEFAULT_TRI_WEIGHT_3)),
    triWeight4: Number(getValue('--tri-weight-4', DEFAULT_TRI_WEIGHT_4)),
    avgWorstWeight: Number(getValue('--avg-worst-weight', DEFAULT_AVG_WORST_WEIGHT)),
    avgWorstSweep: args.includes('--avg-worst-sweep'),
    avgWorstMin: Number(getValue('--avg-worst-min', DEFAULT_AVG_WORST_MIN)),
    avgWorstMax: Number(getValue('--avg-worst-max', DEFAULT_AVG_WORST_MAX)),
    avgWorstStep: Number(getValue('--avg-worst-step', DEFAULT_AVG_WORST_STEP)),
    useGeo: args.includes('--accurate') || args.includes('--use-geo'),
    noEarlyStop: args.includes('--no-early-stop'),
    exportDistances: !args.includes('--no-export-distances'),
  };
}

const settings = {
  exhaustive: false,
  maxSteps: DEFAULT_MAX_STEPS,
  toleranceKm: DEFAULT_TOLERANCE_KM,
  borderToleranceKm: DEFAULT_BORDER_TOLERANCE_KM,
  bucketKm: DEFAULT_BUCKET_KM,
  geoSample: DEFAULT_GEO_SAMPLE,
  geoStepKm: DEFAULT_GEO_STEP_KM,
  triWeight2: DEFAULT_TRI_WEIGHT_2,
  triWeight3: DEFAULT_TRI_WEIGHT_3,
  triWeight4: DEFAULT_TRI_WEIGHT_4,
  avgWorstWeight: DEFAULT_AVG_WORST_WEIGHT,
  avgWorstSweep: false,
  avgWorstMin: DEFAULT_AVG_WORST_MIN,
  avgWorstMax: DEFAULT_AVG_WORST_MAX,
  avgWorstStep: DEFAULT_AVG_WORST_STEP,
  useGeo: false,
  noEarlyStop: false,
  exportDistances: true,
  earlyStop: true,
  bestAvg: Infinity,
};

async function main() {
  Object.assign(settings, parseArgs());
  if (settings.noEarlyStop) settings.earlyStop = false;
  const { countries, source } = await loadCountries();
  console.log(`Loaded ${countries.length} countries (${source}).`);
  if (countries.length < 50) {
    console.log('Only the fallback list is available. Run: node scripts/fetch-data.js');
  }
  if (!countries.length) {
    console.error('No countries available to train on.');
    process.exit(1);
  }
  let geoPoints = null;
  let geoMatched = 0;
  if (settings.useGeo) {
    const geojson = await loadGeoJSON();
    geoPoints = buildGeoPoints(geojson, countries);
    if (!geoPoints || geoPoints.matched < 50) {
      console.log('GeoJSON unavailable or insufficient matches. Falling back to centroids.');
      geoPoints = null;
    } else {
      geoMatched = geoPoints.matched;
      const stepLabel = settings.geoStepKm > 0 ? `${settings.geoStepKm} km step` : 'vertex-only';
      const sampleLabel = settings.geoSample > 0 ? settings.geoSample : 'all points';
      console.log(`Geo mode enabled. Matched ${geoPoints.matched} countries. Step: ${stepLabel}. Sample size: ${sampleLabel}`);
    }
  }
  const distances = buildDistanceMatrix(countries, geoPoints);
  const n = countries.length;
  const allIndices = Array.from({ length: n }, (_, i) => i);
  let avgWorstSweepResult = null;

  if (settings.avgWorstSweep) {
    console.log('Sweeping avg/worst weights...');
    avgWorstSweepResult = sweepAvgWorstWeights(countries, distances);
    settings.avgWorstWeight = avgWorstSweepResult.best.weight;
    console.log(
      `Selected avg/worst weight ${settings.avgWorstWeight.toFixed(3)} (avg ${avgWorstSweepResult.best.avg.toFixed(2)} worst ${avgWorstSweepResult.best.worst})`,
    );
  }

  const rankedStart = rankSuggestions(allIndices, Infinity, distances, n, new Set());
  if (!rankedStart.length) {
    console.error('Failed to compute any starting guess.');
    process.exit(1);
  }
  const bestStart = rankedStart[0];

  const heuristicTop = rankedStart.slice(0, 10).map((item) => ({
    name: countries[item.index].name,
    expectedRemaining: Number(item.expected.toFixed(2)),
    avgDistanceKm: Number(item.avgDistance.toFixed(0)),
  }));

  console.log(`Best starting guess (heuristic): ${countries[bestStart.index].name}`);
  console.log(`Expected remaining: ${bestStart.expected.toFixed(1)} | Avg distance: ${bestStart.avgDistance.toFixed(0)} km`);
  console.log('Top 10 starting guesses:');
  heuristicTop.forEach((item, idx) => {
    console.log(`${idx + 1}. ${item.name} (exp ${item.expectedRemaining.toFixed(1)})`);
  });

  let exhaustiveResult = null;
  if (settings.exhaustive) {
    console.log('Running exhaustive start sweep... (this can be slow)');
    let bestIndex = null;
    let bestAvg = Infinity;
    let bestWorst = Infinity;
    let bestScore = Infinity;
    const results = [];

    for (let startIdx = 0; startIdx < n; startIdx += 1) {
      settings.bestAvg = bestAvg;
      const { avg, worst, aborted } = evaluateStartIndex(startIdx, countries, distances);
      const score = avg * settings.avgWorstWeight + worst * (1 - settings.avgWorstWeight);
      if (!aborted) {
        results.push({ index: startIdx, avg, worst, score });
      }
      if (avg < bestAvg) bestAvg = avg;
      if (score < bestScore) {
        bestScore = score;
        bestAvg = avg;
        bestWorst = worst;
        bestIndex = startIdx;
      }
      if ((startIdx + 1) % 10 === 0 || startIdx === n - 1) {
        console.log(
          `Checked ${startIdx + 1}/${n} starts. Current best: ${bestIndex !== null ? countries[bestIndex].name : 'n/a'} (avg ${bestAvg.toFixed(2)} worst ${bestWorst})`,
        );
      }
    }

    results.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (a.avg !== b.avg) return a.avg - b.avg;
      return a.worst - b.worst;
    });
    if (bestIndex !== null) {
      exhaustiveResult = {
        best: {
          name: countries[bestIndex].name,
          avgGuesses: Number(bestAvg.toFixed(2)),
          worstGuesses: bestWorst,
          score: Number(bestScore.toFixed(2)),
        },
        top: results.slice(0, 10).map((item) => ({
          name: countries[item.index].name,
          avgGuesses: Number(item.avg.toFixed(2)),
          worstGuesses: item.worst,
          score: Number(item.score.toFixed(2)),
        })),
      };
      console.log(`Best starting guess (exhaustive): ${countries[bestIndex].name}`);
      console.log(`Average guesses (exhaustive): ${bestAvg.toFixed(2)} | Worst: ${bestWorst}`);
      console.log('Top 10 starts by weighted score:');
      results.slice(0, 10).forEach((item, idx) => {
        console.log(
          `${idx + 1}. ${countries[item.index].name} (avg ${item.avg.toFixed(2)} worst ${item.worst} score ${item.score.toFixed(2)})`,
        );
      });
    }
  } else {
    const avg = countries.reduce((acc, _, targetIdx) => {
      const guesses = simulateTarget(targetIdx, countries, distances);
      return acc + guesses;
    }, 0) / n;
    console.log(`Average guesses with greedy strategy: ${avg.toFixed(2)}`);
    console.log('Tip: run with --exhaustive to sweep every starting country.');
  }

  const trainingData = {
    generatedAt: new Date().toISOString(),
    countriesCount: n,
    source,
    settings: {
      exhaustive: settings.exhaustive,
      useGeo: settings.useGeo,
      geoSample: settings.geoSample,
      geoStepKm: settings.geoStepKm,
      toleranceKm: settings.toleranceKm,
      borderToleranceKm: settings.borderToleranceKm,
      bucketKm: settings.bucketKm,
      maxSteps: settings.maxSteps,
      earlyStop: settings.earlyStop,
      geoMatched,
      exportDistances: settings.exportDistances,
      avgWorstWeight: settings.avgWorstWeight,
      avgWorstSweep: settings.avgWorstSweep,
      avgWorstMin: settings.avgWorstMin,
      avgWorstMax: settings.avgWorstMax,
      avgWorstStep: settings.avgWorstStep,
      triWeight2: settings.triWeight2,
      triWeight3: settings.triWeight3,
      triWeight4: settings.triWeight4,
    },
    strategy: {
      triangulationMinGuesses: TRIANGULATION_MIN_GUESSES,
      weights: {
        triWeight2: settings.triWeight2,
        triWeight3: settings.triWeight3,
        triWeight4: settings.triWeight4,
        farthestWeight: DEFAULT_FARTHEST_WEIGHT,
        avgWorstWeight: settings.avgWorstWeight,
      },
    },
    heuristic: {
      best: {
        name: countries[bestStart.index].name,
        expectedRemaining: Number(bestStart.expected.toFixed(2)),
        avgDistanceKm: Number(bestStart.avgDistance.toFixed(0)),
      },
      top: heuristicTop,
    },
    exhaustive: exhaustiveResult,
  };

  await mkdir(path.dirname(TRAINING_PATH), { recursive: true });
  await writeFile(TRAINING_PATH, JSON.stringify(trainingData, null, 2));
  console.log(`Saved training data to ${TRAINING_PATH}`);

  if (settings.exportDistances) {
    const matrix = Array.from(distances, (value) => Number(value.toFixed(2)));
    const distancePayload = {
      generatedAt: trainingData.generatedAt,
      countries: countries.map((country) => country.name),
      units: 'km',
      matrix,
    };
    await writeFile(DISTANCES_PATH, JSON.stringify(distancePayload));
    console.log(`Saved distance matrix to ${DISTANCES_PATH}`);
  }
}

main().catch((err) => {
  console.error('Training failed:', err.message);
  process.exit(1);
});
