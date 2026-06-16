# 🗺️ Aste Immobiliari · Tribunale di Arezzo

Dashboard con **mappa interattiva** per cercare e confrontare gli immobili e i
terreni all'asta del Tribunale di Arezzo. Riorganizza i dati del portale
ufficiale (che non ha una mappa) in una vista filtrabile con prezzi, date e
posizione geografica.

## Come funziona

Il portale del Tribunale (`tribunale.arezzo.giustizia.it`, piattaforma
*astalegale.net*) espone la ricerca via
`GET /it/Aste/SearchImmobili?Page=N&ResultPerPage=48`, restituendo HTML.
Lo strumento:

1. **Scarica** tutte le pagine dei risultati.
2. **Estrae** da ogni annuncio: indirizzo, comune, prezzo base, data dell'asta,
   tipologia, procedura, foto e link alla scheda completa. Apre poi ogni scheda
   di dettaglio per recuperare anche **offerta minima**, **termine presentazione
   offerte**, **modalità di gara** e i **documenti scaricabili** (perizia,
   avviso di vendita, ordinanza, planimetrie, dati catastali).
3. **Geocodifica** gli indirizzi con OpenStreetMap/Nominatim (con cache locale,
   così i run successivi sono veloci) per ottenere le coordinate.
4. Salva tutto in `data/aste.json`.

La **dashboard** (`web/`) carica quel JSON e mostra mappa + lista con filtri per
prezzo, categoria, comune, data, "solo terreni" e ricerca libera.

## Uso

```bash
npm run scrape    # scarica i dati e geocodifica -> data/aste.json
npm run serve     # avvia la dashboard su http://localhost:5173
# oppure entrambi:
npm start
```

Per includere anche le aste passate:

```bash
ASTE_PASSATE=1 npm run scrape
```

## Note

- Il primo `scrape` impiega qualche minuto (Nominatim consente ~1 richiesta/sec).
  I successivi sono rapidi grazie a `data/geocache.json`.
- I marker sono colorati per fascia di prezzo (vedi legenda in mappa).
- Gli annunci con posizione solo a livello di comune sono segnati con `📍 approx`.
- Dati e foto restano di proprietà del Tribunale di Arezzo / Ministero della
  Giustizia: questo strumento è solo un visualizzatore per uso personale.
  Verifica sempre i dettagli sulla **scheda ufficiale** prima di partecipare.
```
