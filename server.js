const http = require('http');
const path = require('path');
const { stat, readFile, writeFile } = require('fs/promises');
const fs = require('fs');
const https = require('https');

const PORT = Number(process.env.PORT) || 5173;
const ROOT_DIR = __dirname;
const DATA_CACHE_PATH = path.join(ROOT_DIR, 'data', 'countries.json');
const GEO_CACHE_PATH = path.join(ROOT_DIR, 'data', 'countries.geojson');
const SOVEREIGN_PATH = path.join(ROOT_DIR, 'data', 'sovereign-countries.json');
const TRAINING_PATH = path.join(ROOT_DIR, 'data', 'training.json');
const DISTANCES_PATH = path.join(ROOT_DIR, 'data', 'distances.json');

const DATA_SOURCES = [
  'https://raw.githubusercontent.com/samayo/country-json/master/src/country-by-geo-coordinates.json',
  'https://cdn.jsdelivr.net/gh/samayo/country-json/src/country-by-geo-coordinates.json',
  'https://unpkg.com/country-json@2.3.0/src/country-by-geo-coordinates.json',
  'https://raw.githubusercontent.com/eesur/country-codes-lat-long/master/country-codes-lat-long-alpha3.json',
  'https://cdn.jsdelivr.net/gh/eesur/country-codes-lat-long/country-codes-lat-long-alpha3.json',
];

const GEOJSON_SOURCES = [
  'https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson',
  'https://cdn.jsdelivr.net/gh/datasets/geo-countries/data/countries.geojson',
  'https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json',
  'https://cdn.jsdelivr.net/gh/johan/world.geo.json/countries.geo.json',
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

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const countryCache = {
  data: null,
  fetchedAt: 0,
};

const geoCache = {
  data: null,
  fetchedAt: 0,
};

const sovereignCache = {
  set: null,
  loadedAt: 0,
};

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

function simplifyName(value) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
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
  const now = Date.now();
  if (sovereignCache.set && now - sovereignCache.loadedAt < 24 * 60 * 60 * 1000) {
    return sovereignCache.set;
  }
  try {
    const raw = await readFile(SOVEREIGN_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 50) {
      sovereignCache.set = new Set(parsed.map((name) => simplifyName(String(name))));
      sovereignCache.loadedAt = now;
      return sovereignCache.set;
    }
  } catch (error) {
    // ignore missing file
  }
  sovereignCache.set = null;
  sovereignCache.loadedAt = now;
  return sovereignCache.set;
}

function filterSovereign(list, sovereignSet) {
  if (!sovereignSet) return list;
  return list.filter((country) => sovereignSet.has(simplifyName(country.name)));
}

function fetchJson(url) {
  if (typeof fetch === 'function') {
    return fetch(url, { cache: 'force-cache' }).then((response) => {
      if (!response.ok) throw new Error('bad response');
      return response.json();
    });
  }

  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error('bad response'));
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

async function fetchCountries() {
  const now = Date.now();
  if (countryCache.data && now - countryCache.fetchedAt < 24 * 60 * 60 * 1000) {
    return countryCache.data;
  }

  const sovereignSet = await loadSovereignSet();

  try {
    const cached = await readFile(DATA_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(cached);
    if (Array.isArray(parsed) && parsed.length > 50) {
      countryCache.data = filterSovereign(parsed, sovereignSet);
      countryCache.fetchedAt = now;
      return countryCache.data;
    }
  } catch (error) {
    // ignore cache read errors
  }

  for (const source of DATA_SOURCES) {
    try {
      const payload = await fetchJson(source);
      const normalized = Array.isArray(payload) ? payload.map(normalizeCountry).filter(Boolean) : [];
      if (normalized.length > 50) {
        countryCache.data = filterSovereign(dedupeCountries(normalized), sovereignSet);
        countryCache.fetchedAt = now;
        try {
          await writeFile(DATA_CACHE_PATH, JSON.stringify(countryCache.data, null, 2));
        } catch (error) {
          // ignore cache write errors
        }
        return countryCache.data;
      }
    } catch (error) {
      // try next source
    }
  }

  countryCache.data = filterSovereign(dedupeCountries(FALLBACK_COUNTRIES), sovereignSet);
  countryCache.fetchedAt = now;
  return countryCache.data;
}

async function fetchGeoJSON() {
  const now = Date.now();
  if (geoCache.data && now - geoCache.fetchedAt < 24 * 60 * 60 * 1000) {
    return geoCache.data;
  }

  try {
    const cached = await readFile(GEO_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(cached);
    if (parsed && Array.isArray(parsed.features) && parsed.features.length > 50) {
      geoCache.data = parsed;
      geoCache.fetchedAt = now;
      return geoCache.data;
    }
  } catch (error) {
    // ignore cache read errors
  }

  for (const source of GEOJSON_SOURCES) {
    try {
      const payload = await fetchJson(source);
      if (payload && payload.features && payload.features.length > 50) {
        geoCache.data = payload;
        geoCache.fetchedAt = now;
        try {
          await writeFile(GEO_CACHE_PATH, JSON.stringify(geoCache.data));
        } catch (error) {
          // ignore cache write errors
        }
        return geoCache.data;
      }
    } catch (error) {
      // try next source
    }
  }

  throw new Error('geojson unavailable');
}

function sendJson(res, statusCode, body) {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function sendText(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function safeResolvePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const relPath = decoded === '/' ? '/index.html' : decoded;
  const safePath = path.normalize(relPath).replace(/^\.+/, '');
  if (safePath.includes('..')) return null;
  return path.join(ROOT_DIR, safePath);
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    sendText(res, 400, 'Bad Request');
    return;
  }

  if (req.url.startsWith('/api/countries')) {
    try {
      const data = await fetchCountries();
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, 500, { error: 'Failed to load countries' });
    }
    return;
  }

  if (req.url.startsWith('/api/geojson')) {
    try {
      const data = await fetchGeoJSON();
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, 500, { error: 'Failed to load map data' });
    }
    return;
  }

  if (req.url.startsWith('/api/training')) {
    try {
      const raw = await readFile(TRAINING_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      sendJson(res, 200, parsed);
    } catch (error) {
      sendJson(res, 404, { error: 'Training data not found' });
    }
    return;
  }

  if (req.url.startsWith('/api/distances')) {
    try {
      const raw = await readFile(DISTANCES_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      sendJson(res, 200, parsed);
    } catch (error) {
      sendJson(res, 404, { error: 'Distance data not found' });
    }
    return;
  }

  const filePath = safeResolvePath(req.url);
  if (!filePath) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  try {
    const fileStats = await stat(filePath);
    if (fileStats.isDirectory()) {
      sendText(res, 403, 'Forbidden');
      return;
    }
    const ext = path.extname(filePath);
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    sendText(res, 404, 'Not Found');
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Globle Bot running at http://localhost:${PORT}`);
});
