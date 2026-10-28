/** NWS weather in the browser (port of weather.py): forecast periods + active alerts, nearest observation,
 *  Open-Meteo as the backup forecast. Same response shapes as the desktop endpoints. */

import { getJson, qs } from './http.js?v=2.1.0';
import { cached, MIN, HOUR } from './store.js?v=2.1.0';
import { validateCoords, isInUs, haversineMi, compassPoint, round, METERS_PER_MILE } from './util.js?v=2.1.0';

const NWS_API_URL = 'https://api.weather.gov';
const NWS_HEADERS = { Accept: 'application/geo+json' };
const NWS_TIMEOUT = 10000;
const NWS_FORECAST_PERIODS = 8;
const WEATHER_FRESH_TTL = 3 * HOUR;
const WEATHER_WARN_TTL = 24 * HOUR;
const NWS_ALERTS_CACHE_TTL = 10 * MIN;
const NWS_ALERT_DESCRIPTION_MAX = 500;
const NWS_OBSERVATION_CACHE_TTL = 10 * MIN;
const NWS_OBSERVATION_CELL_DEG = 0.05;
const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const OPEN_METEO_FORECAST_DAYS = 4;
const DAYTIME_START_HOUR = 6;
const DAYTIME_END_HOUR = 18;
const KMH_PER_KNOT = 1.852;
const MPS_PER_KNOT = 0.514444;
const PA_PER_MILLIBAR = 100;
export const NWS_SOURCE = 'National Weather Service';
const OPEN_METEO_SOURCE = 'Open-Meteo (backup)';

const WMO_CODES = {
  0: 'Clear', 1: 'Mostly Clear', 2: 'Partly Cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing Fog',
  51: 'Light Drizzle', 53: 'Drizzle', 55: 'Heavy Drizzle', 56: 'Freezing Drizzle', 57: 'Heavy Freezing Drizzle',
  61: 'Light Rain', 63: 'Rain', 65: 'Heavy Rain', 66: 'Freezing Rain', 67: 'Heavy Freezing Rain',
  71: 'Light Snow', 73: 'Snow', 75: 'Heavy Snow', 77: 'Snow Grains', 80: 'Rain Showers', 81: 'Heavy Rain Showers',
  82: 'Violent Rain Showers', 85: 'Snow Showers', 86: 'Heavy Snow Showers', 95: 'Thunderstorms',
  96: 'Thunderstorms with Hail', 99: 'Severe Thunderstorms with Hail',
};

const nwsGet = (url) => getJson(url, { timeoutMs: NWS_TIMEOUT, headers: NWS_HEADERS });
export const pointKey = (prefix, lat, lon) => `${prefix}:${round(lat, 2)},${round(lon, 2)}`;
const r4 = (v) => round(v, 4);

/** GET an Open-Meteo endpoint for a point (timezone=auto). */
export function openMeteoGet(base, lat, lon, params) {
  return getJson(`${base}?${qs({ latitude: r4(lat), longitude: r4(lon), timezone: 'auto', ...params })}`, { timeoutMs: 10000 });
}

/* ── NWS forecast ── */
async function fetchForecast(lat, lon) {
  const points = await nwsGet(`${NWS_API_URL}/points/${r4(lat)},${r4(lon)}`);
  const props = points.properties || {};
  const rel = props.relativeLocation?.properties || {};
  const location = rel.city && rel.state ? `${rel.city}, ${rel.state}` : (rel.city || `${lat.toFixed(4)}, ${lon.toFixed(4)}`);
  const office = props.gridId || '';
  if (!props.forecast) throw new Error('No NWS forecast grid for this point');
  const forecast = await nwsGet(props.forecast);
  return {
    periods: (forecast.properties?.periods || []).slice(0, NWS_FORECAST_PERIODS), location, office,
    grid: `${office} (${props.gridX ?? ''},${props.gridY ?? ''})`, source: office ? `${NWS_SOURCE} — ${office} office` : NWS_SOURCE, backup: false,
  };
}

/* ── Open-Meteo backup ── */
function windText(speeds) {
  const valid = speeds.filter((s) => s != null).map((s) => Math.round(s));
  if (!valid.length) return '';
  const lo = Math.min(...valid); const hi = Math.max(...valid);
  return lo === hi ? `${lo} kt` : `${lo} to ${hi} kt`;
}
function period(name, start, daytime, temperature, winds, direction, code, precip) {
  const forecast = code != null ? (WMO_CODES[code] || '') : '';
  return {
    name, startTime: start, isDaytime: daytime, temperature: temperature != null ? Math.round(temperature) : null, temperatureUnit: 'F',
    windSpeed: windText(winds), windDirection: compassPoint(direction), shortForecast: forecast, detailedForecast: forecast, icon: '',
    probabilityOfPrecipitation: { unitCode: 'wmoUnit:percent', value: precip ?? null },
  };
}
function openMeteoPeriods(data) {
  const daily = data.daily || {}; const hourly = data.hourly || {};
  const days = daily.time || [];
  if (!days.length) throw new Error('Open-Meteo returned no daily forecast');
  const hours = hourly.time || []; const hWind = hourly.wind_speed_10m || []; const hDir = hourly.wind_direction_10m || [];
  const hourlySlice = (day, daytime) => {
    const idx = hours.map((t, i) => [t, i]).filter(([t]) => t.startsWith(day) && ((Number(t.slice(11, 13)) >= DAYTIME_START_HOUR && Number(t.slice(11, 13)) < DAYTIME_END_HOUR) === daytime)).map(([, i]) => i);
    const winds = idx.filter((i) => i < hWind.length).map((i) => hWind[i]);
    const dirs = idx.filter((i) => i < hDir.length && hDir[i] != null).map((i) => hDir[i]);
    return [winds, dirs.length ? dirs.reduce((a, b) => a + b, 0) / dirs.length : null];
  };
  const dv = (key, i) => (daily[key] || [])[i] ?? null;
  const periods = [];
  days.slice(0, OPEN_METEO_FORECAST_DAYS).forEach((day, i) => {
    const weekday = new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' });
    const code = dv('weather_code', i); const precip = dv('precipitation_probability_max', i); const dominant = dv('wind_direction_10m_dominant', i);
    for (const [daytime, name, tempKey, hour] of [[true, i === 0 ? 'Today' : weekday, 'temperature_2m_max', DAYTIME_START_HOUR], [false, i === 0 ? 'Tonight' : `${weekday} Night`, 'temperature_2m_min', DAYTIME_END_HOUR]]) {
      let [winds, direction] = hourlySlice(day, daytime);
      if (!winds.length) winds = [dv('wind_speed_10m_max', i)];
      periods.push(period(name, `${day}T${String(hour).padStart(2, '0')}:00:00`, daytime, dv(tempKey, i), winds, direction ?? dominant, code, precip));
    }
  });
  return periods.slice(0, NWS_FORECAST_PERIODS);
}
async function fetchOpenMeteo(lat, lon) {
  const data = await openMeteoGet(OPEN_METEO_FORECAST_URL, lat, lon, {
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,wind_direction_10m_dominant,weather_code',
    hourly: 'temperature_2m,wind_speed_10m,wind_direction_10m,precipitation_probability,weather_code',
    temperature_unit: 'fahrenheit', wind_speed_unit: 'kn', forecast_days: OPEN_METEO_FORECAST_DAYS,
  });
  return { periods: openMeteoPeriods(data), location: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, office: '', grid: data.timezone || '', source: OPEN_METEO_SOURCE, backup: true };
}

/* ── Forecast entry point ── */
const forecastError = (lat, lon, message) => ({ ok: false, error: message, periods: [], alerts: [], backup: false, location: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, source: NWS_SOURCE });
async function finish(data, age, fromCache, lat, lon) {
  return { ...data, ok: true, cached: fromCache, cached_age_min: Math.round(age / 60000), stale_warning: fromCache && age > WEATHER_WARN_TTL, alerts: await getAlerts(lat, lon) };
}

export async function getForecast(lat, lon) {
  if (!validateCoords(lat, lon)) return forecastError(lat, lon, 'Invalid coordinates');
  let reason = '';
  if (!isInUs(lat, lon)) reason = 'NWS forecasts only cover US territory';
  else {
    try {
      const { value, age, cached: fromCache } = await cached(pointKey('nws', lat, lon), WEATHER_FRESH_TTL, () => fetchForecast(lat, lon));
      return finish(value, age, fromCache, lat, lon);
    } catch (err) {
      reason = err?.status === 404 ? 'No NWS forecast grid here (offshore or outside coverage)' : (err?.status ? `NWS API error ${err.status}` : 'NWS forecast unavailable');
    }
  }
  try {
    const { value, age, cached: fromCache } = await cached(pointKey('open-meteo', lat, lon), WEATHER_FRESH_TTL, () => fetchOpenMeteo(lat, lon));
    return finish(value, age, fromCache, lat, lon);
  } catch (err) {
    console.warn('[lightkeeper] Open-Meteo backup unavailable:', err?.message);
    return forecastError(lat, lon, reason);
  }
}

/* ── Alerts ── */
function normalizeAlert(feature) {
  const p = feature.properties || {};
  return {
    id: p.id || '', event: p.event || '', severity: p.severity || '', certainty: p.certainty || '', urgency: p.urgency || '', headline: p.headline || '',
    description: String(p.description || '').slice(0, NWS_ALERT_DESCRIPTION_MAX), instruction: p.instruction || '', onset: p.onset || '', expires: p.expires || '',
    sender: p.senderName || '', area: p.areaDesc || '',
  };
}
export async function getAlerts(lat, lon) {
  if (!validateCoords(lat, lon) || !isInUs(lat, lon)) return [];
  try {
    const { value } = await cached(pointKey('nws-alerts', lat, lon), NWS_ALERTS_CACHE_TTL, async () => {
      const data = await nwsGet(`${NWS_API_URL}/alerts/active?point=${r4(lat)},${r4(lon)}&status=actual&message_type=alert`);
      return (data.features || []).map(normalizeAlert);
    });
    return value || [];
  } catch { return []; }
}

/* ── Latest observation (hover card) ── */
const TO_KNOTS = { 'km_h-1': (v) => v / KMH_PER_KNOT, 'm_s-1': (v) => v / MPS_PER_KNOT, kn: (v) => v };
const TO_F = { degC: (v) => (v * 9) / 5 + 32, degF: (v) => v };
const TO_MILES = { m: (v) => v / METERS_PER_MILE, mi: (v) => v };
const TO_MB = { Pa: (v) => v / PA_PER_MILLIBAR, hPa: (v) => v, mbar: (v) => v };
function quantity(props, key, converters, digits = 1) {
  const q = props[key] || {};
  if (q.value == null) return null;
  const unit = String(q.unitCode || '').split(':').pop();
  const convert = converters[unit];
  return convert ? round(convert(Number(q.value)), digits) : null;
}
async function fetchObservation(lat, lon) {
  const stations = (await nwsGet(`${NWS_API_URL}/points/${r4(lat)},${r4(lon)}/stations`)).features || [];
  if (!stations.length) throw new Error('No NWS observation stations near this point');
  const props = stations[0].properties || {};
  const id = props.stationIdentifier || '';
  const [sLon, sLat] = stations[0].geometry?.coordinates || [null, null];
  const obs = (await nwsGet(`${NWS_API_URL}/stations/${id}/observations/latest`)).properties || {};
  const windDir = obs.windDirection?.value;
  return {
    station: { id, name: props.name || id, lat: sLat, lon: sLon, distance_mi: sLat != null && sLon != null ? round(haversineMi(lat, lon, sLat, sLon), 1) : null },
    observed_at: obs.timestamp || '', temp_f: quantity(obs, 'temperature', TO_F), wind_kt: quantity(obs, 'windSpeed', TO_KNOTS),
    wind_dir: windDir != null ? compassPoint(windDir) : null, gust_kt: quantity(obs, 'windGust', TO_KNOTS), conditions: obs.textDescription || null,
    visibility_mi: quantity(obs, 'visibility', TO_MILES), pressure_mb: quantity(obs, 'barometricPressure', TO_MB),
  };
}
export async function nearestObservation(lat, lon) {
  if (!validateCoords(lat, lon)) return { ok: false, error: 'Invalid coordinates' };
  if (!isInUs(lat, lon)) return { ok: false, error: 'NWS observations only cover US territory' };
  const cell = NWS_OBSERVATION_CELL_DEG;
  const key = `nws-obs:${(Math.round(lat / cell) * cell).toFixed(2)},${(Math.round(lon / cell) * cell).toFixed(2)}`;
  try {
    const { value, cached: fromCache } = await cached(key, NWS_OBSERVATION_CACHE_TTL, () => fetchObservation(lat, lon));
    return { ...value, ok: true, cached: fromCache };
  } catch { return { ok: false, error: 'NWS observation unavailable' }; }
}
