// gate.mjs — Regulador de ritmo (throttle) auto-adaptativo.
//
// El cron dispara seguido (cada 10 min), pero NO cada disparo debe scrapear:
// hay que quedarse dentro del ancho de banda gratis de Webshare (~1 GB/mes POR CUENTA).
// Este gate calcula el intervalo mínimo según CUÁNTAS cuentas tengas configuradas
// en el secret WEBSHARE_TOKEN (tokens separados por comas) y decide EJECUTAR o SALTAR.
//
// => Tú solo añades el token de cada cuenta nueva y el ritmo se acelera solo.
// No consume ancho de banda cuando salta (ni siquiera arranca el navegador).

import fs from 'fs';

// ── Parámetros del presupuesto (fáciles de afinar) ──────────────────────────
const MB_PER_RUN         = 4;    // coste medido por ejecución (adblock + caché de nombres), con margen
const BUDGET_MB_ACCOUNT  = 950;  // presupuesto por cuenta/mes (headroom bajo el 1 GB real)
const MS_MONTH           = 30 * 24 * 3600 * 1000;

// ── Nº de cuentas = nº de tokens en WEBSHARE_TOKEN ──────────────────────────
const accounts = Math.max(
  (process.env.WEBSHARE_TOKEN || '').split(',').map(s => s.trim()).filter(Boolean).length,
  1  // sin tokens => trata como 1 (IP directa); evita saltar siempre
);

const runsPerMonth  = accounts * (BUDGET_MB_ACCOUNT / MB_PER_RUN);
const minIntervalMs = MS_MONTH / runsPerMonth;

let last = 0;
try { last = JSON.parse(fs.readFileSync('health.json', 'utf8')).lastScrapeTs || 0; } catch {}

const now  = Date.now();
const since = now - last;
const wait = minIntervalMs - since;
const go   = wait <= 0;

const mins = x => Math.round(x / 60000);
console.log(
  `cuentas=${accounts} · intervalo=${mins(minIntervalMs)} min · desde última=${last ? mins(since) + ' min' : 'nunca'} · ` +
  (go ? 'EJECUTAR ✅' : `SALTAR ⏭️ (faltan ${mins(wait)} min)`)
);

// GitHub Actions: expone el resultado como output del step para gatear los siguientes.
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `run=${go}\n`);
} else {
  process.exit(go ? 0 : 78);  // uso local: 0 = ejecutar, 78 = saltar
}
