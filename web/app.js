// Dashboard aste Tribunale di Arezzo — mappa + lista filtrabile.
'use strict';

const AREZZO = [43.4633, 11.8796];
const euro = (n) => (n == null ? '—' : '€ ' + n.toLocaleString('it-IT'));
const fmtDate = (iso) => {
  if (!iso) return '—';
  const [d] = iso.split('T');
  const [y, m, g] = d.split('-');
  return `${g}/${m}/${y}`;
};

// "DD/MM/YYYY HH:MM" -> Date (scadenza presentazione offerte)
function parseTermine(s) {
  if (!s) return null;
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 23), +(m[5] || 59));
}
function daysLeft(s) {
  const d = parseTermine(s);
  if (!d) return null;
  return Math.ceil((d - new Date()) / 86400000);
}

// colore per fascia di prezzo
function priceColor(p) {
  if (p == null) return '#8b98a8';
  if (p < 50000) return '#2ecc71';
  if (p < 150000) return '#f1c40f';
  if (p < 400000) return '#e67e22';
  return '#e74c3c';
}

const state = { all: [], filtered: [], markers: new Map(), selected: null };

const map = L.map('map', { zoomControl: true }).setView(AREZZO, 10);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap',
}).addTo(map);
const cluster = L.markerClusterGroup({ maxClusterRadius: 45 });
map.addLayer(cluster);

const els = {
  meta: document.getElementById('meta'),
  count: document.getElementById('count'),
  list: document.getElementById('list'),
  q: document.getElementById('q'),
  categoria: document.getElementById('categoria'),
  comune: document.getElementById('comune'),
  prezzoMin: document.getElementById('prezzoMin'),
  prezzoMax: document.getElementById('prezzoMax'),
  dataMin: document.getElementById('dataMin'),
  dataMax: document.getElementById('dataMax'),
  soloTerreni: document.getElementById('soloTerreni'),
  soloGeo: document.getElementById('soloGeo'),
  soloAperte: document.getElementById('soloAperte'),
  ordina: document.getElementById('ordina'),
  reset: document.getElementById('reset'),
  toggleView: document.getElementById('toggleView'),
  exportCsv: document.getElementById('exportCsv'),
  legend: document.getElementById('legend'),
};

async function load() {
  try {
    const res = await fetch('data/aste.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('no data');
    const data = await res.json();
    state.all = data.items || [];
    els.meta.textContent = `Aggiornato il ${fmtDate(data.scrapedAt)} · ${data.count} immobili · ${data.geocoded} in mappa · fonte Tribunale di Arezzo`;
  } catch {
    els.meta.textContent = 'Dati non trovati. Esegui  npm run scrape  per generarli.';
    els.list.innerHTML = '<li class="empty">Nessun dato. Lancia <b>npm run scrape</b> e ricarica.</li>';
    return;
  }
  buildFilterOptions();
  buildLegend();
  bindEvents();
  apply();
}

function buildFilterOptions() {
  const cats = [...new Set(state.all.map((i) => i.categoria).filter(Boolean))].sort();
  const comuni = [...new Set(state.all.map((i) => i.comune).filter(Boolean))].sort();
  for (const c of cats) els.categoria.add(new Option(c, c));
  for (const c of comuni) els.comune.add(new Option(c, c));
}

function buildLegend() {
  els.legend.innerHTML = `
    <div class="row"><span class="dot" style="background:#2ecc71"></span> &lt; 50.000 €</div>
    <div class="row"><span class="dot" style="background:#f1c40f"></span> 50–150 mila €</div>
    <div class="row"><span class="dot" style="background:#e67e22"></span> 150–400 mila €</div>
    <div class="row"><span class="dot" style="background:#e74c3c"></span> &gt; 400.000 €</div>
    <div class="row"><span class="dot" style="background:#8b98a8"></span> prezzo n/d</div>`;
}

function bindEvents() {
  const inputs = [els.q, els.categoria, els.comune, els.prezzoMin, els.prezzoMax,
    els.dataMin, els.dataMax, els.soloTerreni, els.soloGeo, els.soloAperte, els.ordina];
  for (const el of inputs) el.addEventListener('input', apply);
  els.reset.addEventListener('click', () => {
    for (const el of inputs) {
      if (el.type === 'checkbox') el.checked = false;
      else el.value = el.tagName === 'SELECT' ? el.options[0].value : '';
    }
    apply();
  });
  els.exportCsv.addEventListener('click', exportCsv);
  els.toggleView.addEventListener('click', () => {
    document.body.classList.toggle('list-only');
    const listOnly = document.body.classList.contains('list-only');
    els.toggleView.textContent = listOnly ? 'Vista mappa' : 'Vista lista';
    if (!listOnly) setTimeout(() => map.invalidateSize(), 50);
  });
}

function apply() {
  const q = els.q.value.trim().toLowerCase();
  const cat = els.categoria.value;
  const com = els.comune.value;
  const pMin = parseFloat(els.prezzoMin.value);
  const pMax = parseFloat(els.prezzoMax.value);
  const dMin = els.dataMin.value;
  const dMax = els.dataMax.value;
  const terreni = els.soloTerreni.checked;
  const geo = els.soloGeo.checked;
  const aperte = els.soloAperte.checked;

  state.filtered = state.all.filter((i) => {
    if (cat && i.categoria !== cat) return false;
    if (com && i.comune !== com) return false;
    if (terreni && i.categoria !== 'Terreno') return false;
    if (geo && i.lat == null) return false;
    if (aperte) { const dl = daysLeft(i.terminePresentazione); if (dl == null || dl < 0) return false; }
    if (!isNaN(pMin) && (i.prezzoBase == null || i.prezzoBase < pMin)) return false;
    if (!isNaN(pMax) && (i.prezzoBase == null || i.prezzoBase > pMax)) return false;
    if (dMin && (!i.dataAsta || i.dataAsta.slice(0, 10) < dMin)) return false;
    if (dMax && (!i.dataAsta || i.dataAsta.slice(0, 10) > dMax)) return false;
    if (q) {
      const hay = `${i.locationRaw} ${i.tipologia} ${i.procedura} ${i.categoria}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const sort = els.ordina.value;
  state.filtered.sort((a, b) => {
    if (sort === 'prezzoAsc') return (a.prezzoBase ?? Infinity) - (b.prezzoBase ?? Infinity);
    if (sort === 'prezzoDesc') return (b.prezzoBase ?? -Infinity) - (a.prezzoBase ?? -Infinity);
    if (sort === 'scadenza') {
      const ta = parseTermine(a.terminePresentazione)?.getTime() ?? Infinity;
      const tb = parseTermine(b.terminePresentazione)?.getTime() ?? Infinity;
      return ta - tb;
    }
    return (a.dataAsta || '9999').localeCompare(b.dataAsta || '9999');
  });

  els.count.textContent = `${state.filtered.length} risultati`;
  renderList();
  renderMarkers();
}

function renderList() {
  if (!state.filtered.length) {
    els.list.innerHTML = '<li class="empty">Nessun immobile corrisponde ai filtri.</li>';
    return;
  }
  els.list.innerHTML = '';
  for (const i of state.filtered) {
    const li = document.createElement('li');
    li.className = 'card';
    li.dataset.id = i.id;
    li.innerHTML = `
      <img loading="lazy" src="${i.img}" alt="" onerror="this.style.visibility='hidden'" />
      <div class="body">
        <p class="title">${escapeHtml(i.comune || '—')}${i.indirizzo ? ' · ' + escapeHtml(i.indirizzo) : ''}</p>
        <p class="sub">${escapeHtml(i.categoria)} · asta ${fmtDate(i.dataAsta)}${deadlineBadge(i)}</p>
        <span class="price">${euro(i.prezzoBase)}</span>
        ${i.offertaMinima ? `<span class="minbid">offerta min. ${euro(i.offertaMinima)}</span>` : ''}
        <div class="tags">
          ${i.geoPrecision === 'comune' ? '<span class="tag">📍 approx</span>' : ''}
          ${i.perizia ? '<span class="tag tag-doc">📄 perizia</span>' : ''}
          <span class="tag">${escapeHtml(i.procedura || '')}</span>
        </div>
      </div>`;
    li.addEventListener('click', () => focusItem(i));
    els.list.appendChild(li);
  }
}

function renderMarkers() {
  cluster.clearLayers();
  state.markers.clear();
  for (const i of state.filtered) {
    if (i.lat == null) continue;
    const color = priceColor(i.prezzoBase);
    const icon = L.divIcon({
      className: '',
      html: `<div class="pin" style="background:${color}"></div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 26],
      popupAnchor: [0, -24],
    });
    const m = L.marker([i.lat, i.lng], { icon });
    m.bindPopup(popupHtml(i));
    cluster.addLayer(m);
    state.markers.set(i.id, m);
  }
}

function popupHtml(i) {
  return `<div class="popup">
    <img src="${i.img}" alt="" onerror="this.style.display='none'"/>
    <h3>${escapeHtml(i.comune || '')}${i.indirizzo ? ' · ' + escapeHtml(i.indirizzo) : ''}</h3>
    <div class="p">${euro(i.prezzoBase)}</div>
    ${i.offertaMinima ? `<div class="small"><b>Offerta minima:</b> ${euro(i.offertaMinima)}</div>` : ''}
    <div class="small">${escapeHtml(i.categoria)} · asta ${fmtDate(i.dataAsta)}</div>
    ${i.terminePresentazione ? `<div class="small"><b>Offerte entro:</b> ${escapeHtml(i.terminePresentazione)}</div>` : ''}
    ${i.modalitaGara ? `<div class="small">Gara: ${escapeHtml(i.modalitaGara)}</div>` : ''}
    <div class="small">${escapeHtml((i.tipologia || '').slice(0, 120))}</div>
    ${i.perizia ? `<a href="${i.perizia}" target="_blank" rel="noopener">📄 Perizia (PDF)</a><br>` : ''}
    <a href="${i.url}" target="_blank" rel="noopener">Apri scheda completa →</a>
  </div>`;
}

function focusItem(i) {
  document.querySelectorAll('.card.active').forEach((e) => e.classList.remove('active'));
  const card = els.list.querySelector(`[data-id="${i.id}"]`);
  if (card) { card.classList.add('active'); card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  if (i.lat != null) {
    map.setView([i.lat, i.lng], 15, { animate: true });
    const m = state.markers.get(i.id);
    if (m) cluster.zoomToShowLayer(m, () => m.openPopup());
  }
}

function deadlineBadge(i) {
  const dl = daysLeft(i.terminePresentazione);
  if (dl == null) return '';
  if (dl < 0) return ' · <span class="dl dl-past">scaduta</span>';
  if (dl === 0) return ' · <span class="dl dl-soon">offerte oggi</span>';
  if (dl <= 14) return ` · <span class="dl dl-soon">offerte: ${dl}gg</span>`;
  return ` · <span class="dl">offerte: ${dl}gg</span>`;
}

function exportCsv() {
  const cols = [
    ['id', 'ID'], ['comune', 'Comune'], ['indirizzo', 'Indirizzo'],
    ['categoria', 'Categoria'], ['prezzoBase', 'Prezzo base'], ['offertaMinima', 'Offerta minima'],
    ['dataAstaLabel', 'Data asta'], ['terminePresentazione', 'Termine offerte'],
    ['modalitaGara', 'Modalita gara'], ['procedura', 'Procedura'],
    ['perizia', 'Perizia'], ['url', 'Scheda'], ['lat', 'Lat'], ['lng', 'Lng'],
  ];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = [cols.map((c) => c[1]).join(';')];
  for (const i of state.filtered) rows.push(cols.map((c) => esc(i[c[0]])).join(';'));
  const blob = new Blob(['﻿' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `aste-arezzo-${state.filtered.length}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

load();
