// Scraper per le aste immobiliari del Tribunale di Arezzo.
// Pagina la ricerca, estrae le card, geocodifica gli indirizzi (Nominatim/OSM
// con cache) e salva data/aste.json pronto per la dashboard.
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const OUT_FILE = join(DATA_DIR, 'aste.json');
const CACHE_FILE = join(DATA_DIR, 'geocache.json');

const BASE = 'https://www.tribunale.arezzo.giustizia.it/it/Aste/SearchImmobili';
const RESULT_PER_PAGE = 48;
const INCLUDE_PAST = process.env.ASTE_PASSATE === '1';
const MAX_PAGES = 20;
const UA = 'aste-arezzo-dashboard/1.0 (uso personale; ricerca aste giudiziarie)';

// ---------- utilità ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePrice(s) {
  if (!s) return null;
  // formato italiano: 72.800,00
  const n = s.replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, '');
  const v = parseFloat(n);
  return Number.isFinite(v) ? v : null;
}

function parseDateIt(d, t) {
  if (!d) return null;
  const [gg, mm, aaaa] = d.split('/');
  if (!aaaa) return null;
  return `${aaaa}-${mm}-${gg}` + (t ? `T${t}` : '');
}

// categoria coarse per i filtri, partendo dalla tipologia testuale
function classify(tipologia = '') {
  const t = tipologia.toLowerCase();
  if (/\bterren|agricol|seminativ|bosco|vigneto|uliveto|oliveto|pascolo/.test(t)) return 'Terreno';
  if (/box|garage|autorimessa|posto auto/.test(t)) return 'Box / Garage';
  if (/magazzin|capannon|laboratori|opifici|industrial/.test(t)) return 'Industriale / Magazzino';
  if (/negozi|commercial|ufficio|uffici|bottega/.test(t)) return 'Commerciale / Ufficio';
  if (/abitazion|appartament|villa|villino|casa|civile|residenz/.test(t)) return 'Abitazione';
  if (/fabbricat|immobil|unità/.test(t)) return 'Fabbricato';
  return 'Altro';
}

// ---------- parsing card ----------
function parseCards(html) {
  const blocks = html.split('<div class="asta">').slice(1);
  const byId = new Map();
  for (const block of blocks) {
    const idm = block.match(/DettaglioImmobile\/(B\d+)/);
    if (!idm) continue;
    const id = idm[1];
    if (byId.has(id)) continue;

    const locm = block.match(/class="detailAsta"[^>]*>\s*<i[^>]*><\/i>\s*([^<]+)</);
    const locationRaw = locm ? stripTags(locm[1]) : '';

    const text = stripTags(block);
    const dm = text.match(/Data dell'asta\s*([0-3]\d\/[01]\d\/\d{4})(?:\s*-\s*(\d{1,2}:\d{2}))?/);
    const pm = text.match(/Prezzo Base\s*€\s*([\d.,]+)/);
    const procm = text.match(/Dati della procedura asta\s*B\d+\s*(.+?)\s*Data dell'asta/);
    const tipm = text.match(/Tipologia\s*(.+?)\s*(?:Toscana\s*>|$)/);

    const tipologia = tipm ? tipm[1].trim() : '';
    const { regione, provincia, comune, indirizzo } = splitLocation(locationRaw);

    byId.set(id, {
      id,
      url: `https://www.tribunale.arezzo.giustizia.it/it/Aste/DettaglioImmobile/${id}`,
      img: `https://documents.astalegale.net/asta/0/${id}?w=536&h=360&zl=14`,
      locationRaw,
      regione,
      provincia,
      comune,
      indirizzo,
      procedura: procm ? procm[1].trim() : '',
      dataAsta: parseDateIt(dm?.[1], dm?.[2]),
      dataAstaLabel: dm ? dm[1] + (dm[2] ? ` ${dm[2]}` : '') : null,
      prezzoBase: parsePrice(pm?.[1]),
      tipologia,
      categoria: classify(tipologia),
    });
  }
  return [...byId.values()];
}

// ---------- dettaglio annuncio ----------
async function fetchDetail(item) {
  try {
    const res = await fetch(item.url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return;
    const html = await res.text();
    const text = stripTags(html);

    const om = text.match(/Offerta minima\s*€?\s*([\d.,]+)/i);
    item.offertaMinima = parsePrice(om?.[1]);

    const tm = text.match(/Termine presentazione offerte\s*([0-3]\d\/[01]\d\/\d{4})(?:\s*-\s*(\d{1,2}:\d{2}))?/i);
    item.terminePresentazione = tm ? tm[1] + (tm[2] ? ` ${tm[2]}` : '') : null;

    const gm = text.match(/Modalit[àa] gara\s*([A-Za-z ]+?)\s*(?:Beni|Dati|Lotto|$)/i);
    item.modalitaGara = gm ? gm[1].trim() : null;

    const docs = [];
    const re = /<a[^>]+href="(https:\/\/documents\.astalegale\.net\/file\/[^"]+)"[^>]*>(.*?)<\/a>/gs;
    let m;
    while ((m = re.exec(html))) {
      const url = m[1].replace(/&amp;/g, '&');
      const label = stripTags(m[2]).replace(/\s*\([^)]*\)\s*$/, '').trim();
      if (label && !docs.some((d) => d.url === url)) docs.push({ label, url });
    }
    item.documenti = docs;
    item.perizia = docs.find((d) => /perizia/i.test(d.label))?.url || null;
  } catch {
    /* dettaglio non disponibile: si prosegue con i dati di lista */
  }
}

function splitLocation(raw) {
  // "Toscana > Arezzo > Terranuova Bracciolini - Via X n. 1"
  const parts = raw.split('>').map((s) => s.trim());
  const regione = parts[0] || '';
  const provincia = parts[1] || '';
  let comune = '';
  let indirizzo = '';
  const last = parts.slice(2).join(' > ');
  if (last.includes(' - ')) {
    const i = last.indexOf(' - ');
    comune = last.slice(0, i).trim();
    indirizzo = last.slice(i + 3).trim();
  } else {
    comune = last.trim();
  }
  return { regione, provincia, comune, indirizzo };
}

// ---------- fetch pagine ----------
async function fetchPage(page) {
  const u = new URL(BASE);
  u.searchParams.set('Page', String(page));
  u.searchParams.set('ResultPerPage', String(RESULT_PER_PAGE));
  u.searchParams.set('AstePassate', INCLUDE_PAST ? 'true' : 'false');
  const res = await fetch(u, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} su pagina ${page}`);
  return res.text();
}

async function scrapeAll() {
  const all = new Map();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const html = await fetchPage(page);
    const cards = parseCards(html);
    let added = 0;
    for (const c of cards) {
      if (!all.has(c.id)) {
        all.set(c.id, c);
        added++;
      }
    }
    console.log(`Pagina ${page}: ${cards.length} card, +${added} nuove (totale ${all.size})`);
    if (added === 0) break;
    await sleep(800);
  }
  return [...all.values()];
}

// ---------- geocoding (Nominatim) ----------
async function loadCache() {
  if (existsSync(CACHE_FILE)) {
    try {
      return JSON.parse(await readFile(CACHE_FILE, 'utf8'));
    } catch {
      /* cache corrotta -> riparto */
    }
  }
  return {};
}

async function nominatim(params) {
  const u = new URL('https://nominatim.openstreetmap.org/search');
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('limit', '1');
  u.searchParams.set('countrycodes', 'it');
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  const res = await fetch(u, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  const arr = await res.json();
  if (!Array.isArray(arr) || !arr.length) return null;
  return { lat: +arr[0].lat, lng: +arr[0].lon };
}

async function geocode(item, cache) {
  const key = item.locationRaw || `${item.comune}|${item.indirizzo}`;
  if (cache[key]) return cache[key];

  let hit = null;
  let precision = null;
  // pulizia indirizzo: rimuove "snc", CAP/sigla provincia/Italia ridondanti
  const street = (item.indirizzo || '')
    .replace(/\bsnc\b/i, '')
    .replace(/,?\s*\d{5}\s+[\w' ]+\s+[A-Z]{2},?\s*Italia?$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  // 1) ricerca free-form sull'indirizzo completo (più robusta per gli indirizzi italiani)
  if (street && item.comune) {
    const q = `${street}, ${item.comune}, ${item.provincia}, Italia`;
    hit = await nominatim({ q });
    if (hit) precision = 'indirizzo';
    await sleep(1100);
  }
  // 2) ricerca strutturata sulla via
  if (!hit && street && item.comune) {
    const onlyStreet = street.replace(/\bn\.?\s*\d+.*$/i, '').replace(/,.*$/, '').trim();
    hit = await nominatim({ street: onlyStreet, city: item.comune, county: item.provincia, country: 'Italia' });
    if (hit) precision = 'indirizzo';
    await sleep(1100);
  }
  // 3) fallback: centro del comune
  if (!hit && item.comune) {
    hit = await nominatim({ city: item.comune, county: item.provincia, country: 'Italia' });
    if (hit) precision = 'comune';
    await sleep(1100);
  }
  const result = hit ? { ...hit, precision } : { lat: null, lng: null, precision: null };
  cache[key] = result;
  return result;
}

// ---------- main ----------
async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  console.log('Recupero annunci dal Tribunale di Arezzo…');
  const items = await scrapeAll();

  console.log(`Trovati ${items.length} immobili. Recupero dettagli (offerta minima, perizia, documenti)…`);
  const BATCH = 6;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    await Promise.all(batch.map(fetchDetail));
    console.log(`  dettagli ${Math.min(i + BATCH, items.length)}/${items.length}`);
    await sleep(250);
  }

  console.log('Geocoding indirizzi…');

  const cache = await loadCache();
  let done = 0;
  for (const item of items) {
    const g = await geocode(item, cache);
    item.lat = g.lat;
    item.lng = g.lng;
    item.geoPrecision = g.precision;
    done++;
    if (done % 10 === 0 || done === items.length) {
      console.log(`  geocoded ${done}/${items.length}`);
      await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
    }
  }
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));

  const geoOk = items.filter((i) => i.lat != null).length;
  const payload = {
    scrapedAt: new Date().toISOString(),
    source: BASE,
    count: items.length,
    geocoded: geoOk,
    items: items.sort((a, b) => (a.dataAsta || '').localeCompare(b.dataAsta || '')),
  };
  await writeFile(OUT_FILE, JSON.stringify(payload, null, 2));
  console.log(`\n✅ Salvato ${OUT_FILE}`);
  console.log(`   ${items.length} immobili, ${geoOk} geolocalizzati.`);
}

main().catch((e) => {
  console.error('Errore:', e);
  process.exit(1);
});
