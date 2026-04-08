const https = require('https');
const path = require('path');
const { mkdir, writeFile, readFile } = require('fs/promises');

const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const COUNTRIES_PATH = path.join(DATA_DIR, 'countries.json');
const GEOJSON_PATH = path.join(DATA_DIR, 'countries.geojson');
const SOVEREIGN_PATH = path.join(DATA_DIR, 'sovereign-countries.json');

const COUNTRY_SOURCES = [
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

function simplifyName(value) {
  return String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

async function loadSovereignSet() {
  try {
    const raw = await readFile(SOVEREIGN_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 50) {
      return new Set(parsed.map((name) => simplifyName(name)));
    }
  } catch (error) {
    // ignore missing file
  }
  return null;
}

function fetchJson(url) {
  if (typeof fetch === 'function') {
    return fetch(url).then((response) => {
      if (!response.ok) throw new Error(`bad response: ${response.status}`);
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

async function fetchWithFallback(sources, validator) {
  let lastError = null;
  for (const source of sources) {
    try {
      const payload = await fetchJson(source);
      if (!validator(payload)) throw new Error('validation failed');
      return payload;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('fetch failed');
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const countries = await fetchWithFallback(
    COUNTRY_SOURCES,
    (payload) => Array.isArray(payload) && payload.length > 50,
  );

  const sovereignSet = await loadSovereignSet();
  const filtered = sovereignSet
    ? countries.filter((item) => {
      const name = item.country || item.name || item.Country || item.countryName || item.official_name;
      if (!name) return false;
      return sovereignSet.has(simplifyName(name));
    })
    : countries;

  await writeFile(COUNTRIES_PATH, JSON.stringify(filtered, null, 2));
  console.log(`Saved countries to ${COUNTRIES_PATH}`);

  const geojson = await fetchWithFallback(
    GEOJSON_SOURCES,
    (payload) => payload && Array.isArray(payload.features) && payload.features.length > 50,
  );

  await writeFile(GEOJSON_PATH, JSON.stringify(geojson));
  console.log(`Saved geojson to ${GEOJSON_PATH}`);
}

main().catch((err) => {
  console.error('Fetch failed:', err.message);
  process.exit(1);
});
