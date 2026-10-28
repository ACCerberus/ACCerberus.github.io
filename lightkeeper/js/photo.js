/** Pictures for the detail cards, no API keys: a photo taken near the place (Wikimedia Commons; the desktop
 *  app fetches and caches it through /api/poi/photo) and a satellite view of the exact spot (Esri World Imagery). */

import { DESKTOP, lite } from './netcheck.js?v=2.1.3-3';

const SKIP = /logo|icon|flag|map|diagram|chart|sign|plaque|seal|coat.of.arms/i;
const memo = new Map();

/** URL of a photo near the place, or null. */
export function photoUrl(lat, lon, name = '') {
  if (lite()) return Promise.resolve(null);
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (!memo.has(key)) memo.set(key, DESKTOP ? Promise.resolve(`/api/poi/photo?lat=${lat}&lon=${lon}&name=${encodeURIComponent(name)}`) : commons(lat, lon));
  return memo.get(key);
}

async function commons(lat, lon) {
  const q = new URLSearchParams({
    action: 'query', format: 'json', origin: '*', generator: 'geosearch', ggscoord: `${lat}|${lon}`, ggsradius: '400',
    ggslimit: '8', ggsnamespace: '6', prop: 'imageinfo', iiprop: 'url|mime|size', iiurlwidth: '720',
  });
  try {
    const data = await (await fetch(`https://commons.wikimedia.org/w/api.php?${q}`)).json();
    const pages = Object.values(data?.query?.pages || {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const hit = pages.find((p) => {
      const info = p.imageinfo?.[0];
      return info && /jpeg|png|webp/.test(info.mime || '') && !SKIP.test(p.title || '') && (info.width || 0) >= 400;
    });
    return hit?.imageinfo?.[0]?.thumburl || null;
  } catch { return null; }
}

/** A satellite picture centred on the point (tiles laid out around it, no map library needed). */
export function satView(lat, lon, zoom = 17) {
  const n = 2 ** zoom;
  const px = ((lon + 180) / 360) * n * 256;
  const r = (lat * Math.PI) / 180;
  const py = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n * 256;
  const tx0 = Math.floor(px / 256);
  const ty0 = Math.floor(py / 256);
  const box = document.createElement('div');
  box.className = 'd-sat';
  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${ty0 + dy}/${tx0 + dx}`;
      img.style.left = `calc(50% + ${Math.round((tx0 + dx) * 256 - px)}px)`;
      img.style.top = `calc(50% + ${Math.round((ty0 + dy) * 256 - py)}px)`;
      img.addEventListener('error', () => img.remove());
      box.append(img);
    }
  }
  return box;
}
