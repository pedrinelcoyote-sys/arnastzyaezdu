// ─────────────────────────────────────────────────────────────────────────────
// metin2alerts scraper — corre en GitHub Actions con navegador real (Playwright).
// Cloudflare lo resuelve el propio Chromium; el flujo challenge→items va en el
// MISMO origen (sin CORS, sin proxy, sin créditos). Filtra según SEARCH_CONFIGS,
// notifica por Telegram lo nuevo y escribe snapshot.json (lo lee la web items2.php)
// + notified.json (dedup).
//
// NO necesita ninguna API de pago. Solo el bot de Telegram (variables de entorno).
// ─────────────────────────────────────────────────────────────────────────────
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE      = 'https://metin2alerts.com/store';
const SERVER_ID = 506;
const JOB       = 0;
const LOCALE    = 'es';

// ── Búsquedas (portadas de items3.php). Desactiva cualquiera con enabled:false ──
//   required: cada regla se cumple si el item tiene un attr/apply que encaja:
//     {id, value}            → valor exacto
//     {id, min, max}         → rango
//     {id, min} | {id, max}  → cota
//   matchMode: 'all' (por defecto, todas las reglas) | 'any' (al menos una)
//   targetName: parte del nombre del item ('' = cualquiera)
const SEARCH_CONFIGS = [
  // COLLARES (type 4, subtype 2)
  { enabled: true,  type: 4, subtype: 2, name: 'Collar DCJ 5%',              targetName: 'Collar Lagr',            required: [{ id: 151, value: 5 }] },
  { enabled: false, type: 4, subtype: 2, name: 'Collar de Jade',             targetName: 'Collar de Jade', matchMode: 'any', required: [{ id: 151, min: 1, max: 5 }, { id: 214, min: 1, max: 5 }] },
  // CASCOS / CAPUCHAS (type 1, subtype 5)
  { enabled: false, job: 1, type: 3, subtype: 1, name: 'Capucha Dragón DM VT',       targetName: 'Capucha de dragón',      required: [{ id: 22, value: 20 }, { id: 38, value: 15 }] },
  { enabled: false, job: 1, type: 3, subtype: 1, name: 'Capucha Dragón - VA 8%',     targetName: 'Capucha de dragón',      required: [{ id: 7, min: 8, max: 8 }] },
  { enabled: false, job: 1, type: 3, subtype: 1, name: 'Capucha Dragón - ATQ 50',    targetName: 'Capucha de dragón',      required: [{ id: 53, value: 50 }] },
  // BRAZALETES (type 4, subtype 0)
  { enabled: false, type: 4, subtype: 0, name: 'Braza 35-50 P HP',           targetName: 'Brazalete Lagr. Cielo',  required: [{ id: 53, min: 35, max: 50 }, { id: 16, value: 10 }, { id: 23, value: 10 }] },
  { enabled: false, type: 4, subtype: 0, name: 'Braza P50',                  targetName: 'Brazalete Lagr. Cielo',  required: [{ id: 53, value: 50 }, { id: 16, value: 10 }] },
  { enabled: false, type: 4, subtype: 0, name: 'Braza 50',                   targetName: 'Brazalete Lagr. Cielo',  required: [{ id: 53, value: 50 }] },
  // ANILLOS / TALISMANES (type 4, subtype 3)
  { enabled: false, type: 4, subtype: 5, name: 'Talis 50',                   targetName: 'Talismán hielo',         required: [{ id: 53, value: 50 }] },
  // GUANTES ACCESORIOS (type 4, subtype 5)
  { enabled: false, type: 3, subtype: 3, name: 'Guantes 5-12',              targetName: 'Guantes de poder',       required: [{ id: 151, value: 5 }, { id: 6, value: 12 }] },
  // ARMAS (type 2 — subtype: 0=espada, 1=daga, 2=arco, 3=dos manos)
  //   OJO: las armas dependen del JOB (clase). Ninja (job 1) = dagas y arcos.
  { enabled: false, job: 1, type: 3, subtype: 0, name: 'Viento Negro 50',    targetName: 'Viento Negro',           required: [{ id: 53, value: 50 }] }, // armadura Ninja (type 3 sub 0, job 1)
  { enabled: false, job: 1, type: 2, subtype: 1, name: 'D.Zodíaco M40+ P5+', targetName: 'Daga de zodíaco',        required: [{ id: 72, min: 40 }, { id: 16, min: 5 }] },
  // PENDIENTES (type 4, subtype 1)
  { enabled: false, type: 4, subtype: 3, name: 'Pendient. de esmeralda',    targetName: 'esmeralda',              required: [{ id: 53, value: 50 }] }, // ← ajusta 'required' al bonus que buscas (ver nota)
];

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';
const NOTIFIED_FILE      = 'notified.json';
const SNAPSHOT_FILE      = 'snapshot.json';
const HEALTH_FILE        = 'health.json';   // estado para el vigilante (fallos seguidos)
const NAMES_CACHE        = 'names_cache.json'; // caché de nombres (se refrescan 1 vez/día)

function readHealth() { try { return JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8')); } catch { return { fails: 0 }; } }
function writeHealth(h) { try { fs.writeFileSync(HEALTH_FILE, JSON.stringify(h)); } catch {} }
function saveNamesCache(names) { try { fs.writeFileSync(NAMES_CACHE, JSON.stringify({ ts: Date.now(), names })); } catch {} }

// Bloqueo estilo adblock: corta imágenes/fuentes/vídeo + dominios de anuncios/analytics.
// Es lo que hace un usuario normal con adblock → ahorra ancho de banda SIN parecer bot.
const AD_HOSTS = /doubleclick|googlesyndication|googletagmanager|google-analytics|adtrafficquality|googleadservices|fundingchoices|adservice|scorecardresearch|adsystem/i;
async function applyAdblock(page) {
  try {
    await page.route('**/*', route => {
      const req = route.request();
      const host = (() => { try { return new URL(req.url()).host; } catch { return ''; } })();
      if (['image', 'font', 'media'].includes(req.resourceType())) return route.abort();
      if (AD_HOSTS.test(host)) return route.abort();
      return route.continue();
    });
  } catch { /* si falla el route, seguimos sin bloqueo */ }
}

// ── stat_map: attrId → plantilla legible ─────────────────────────────────────
let STAT_MAP = {};
try { STAT_MAP = JSON.parse(fs.readFileSync('stat_map.json', 'utf8')); } catch { /* opcional */ }
function formatAttr(id, val) {
  const tpl = STAT_MAP[String(id)];
  if (tpl) {
    const out = tpl.includes('%d') ? tpl.replace('%d', val) : `${tpl} ${val}`.trim();
    return out.replace(/%%/g, '%');
  }
  return `ID ${id}: ${val}`;
}

// ── Protobuf ─────────────────────────────────────────────────────────────────
function readVarint(d, st) {
  let v = 0, mul = 1, b;
  do { b = d[st.p++]; v += (b & 0x7f) * mul; mul *= 128; } while ((b & 0x80) && st.p < d.length);
  return v;
}
function pbDecode(d) {
  const st = { p: 0 }, out = {};
  while (st.p < d.length) {
    const tag = readVarint(d, st), fn = tag >> 3, wt = tag & 7;
    if (wt === 0) out[fn] = readVarint(d, st);
    else if (wt === 2) { const l = readVarint(d, st); out[fn] = d.subarray(st.p, st.p + l); st.p += l; }
    else if (wt === 1) st.p += 8;
    else if (wt === 5) st.p += 4;
    else break;
  }
  return out;
}
const u8str = u8 => (u8 ? Buffer.from(u8).toString('utf8') : '');
function decodeItemList(raw) {
  const items = [], st = { p: 0 };
  while (st.p < raw.length) {
    const tag = readVarint(raw, st), fn = tag >> 3, wt = tag & 7;
    if (wt === 2) {
      const l = readVarint(raw, st), msg = raw.subarray(st.p, st.p + l); st.p += l;
      if (fn === 3) {
        const f = pbDecode(msg);
        const num = k => (typeof f[k] === 'number' ? f[k] : 0);
        const attrs = [];
        for (let i = 0; i <= 6; i++) { const a = num(12 + i * 2), v = num(13 + i * 2); if (a || v) attrs.push([a, v]); }
        const applies = [];
        for (let i = 0; i <= 3; i++) { const a = num(26 + i * 2), v = num(27 + i * 2); if (a || v) applies.push([a, v]); }
        items.push({
          vnum: num(1), quantity: num(2), yangPrice: num(3), wonPrice: num(4),
          seller: (f[5] instanceof Uint8Array) ? u8str(f[5]) : '', attrs, applies,
        });
      }
    } else if (wt === 0) readVarint(raw, st);
    else if (wt === 1) st.p += 8;
    else if (wt === 5) st.p += 4;
    else break;
  }
  return items;
}
function decodeNames(body) {
  const names = {}, st = { p: 0 };
  while (st.p < body.length) {
    const tag = readVarint(body, st), fn = tag >> 3, wt = tag & 7;
    if (wt === 2) {
      const l = readVarint(body, st), msg = body.subarray(st.p, st.p + l); st.p += l;
      if (fn === 1) {
        const ef = pbDecode(msg);
        const vnum = typeof ef[1] === 'number' ? ef[1] : 0;
        let name = '';
        if (ef[2] instanceof Uint8Array && ef[2].length) {
          const ne = pbDecode(ef[2]);
          if (ne[1] instanceof Uint8Array) name = u8str(ne[1]);
        }
        if (vnum > 0 && name) names[vnum] = name;
      }
    } else if (wt === 0) readVarint(body, st);
    else if (wt === 1) st.p += 8;
    else if (wt === 5) st.p += 4;
    else break;
  }
  return names;
}

// ── Flujo dentro del navegador: un challenge NUEVO por consulta ──────────────
// El token del challenge es de un solo uso, así que cada /api/items necesita su
// propio challenge+firma. Reutilizamos la misma clave EC (basta con re-firmar).
async function fetchInPage(page, base, pairs, fetchNames = true) {
  return await page.evaluate(async ({ base, pairs, fetchNames }) => {
    const enc = new TextEncoder();
    const b64u = bytes => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); };
    const b64 = buf => { const u = new Uint8Array(buf); let s = ''; for (const b of u) s += String.fromCharCode(b); return btoa(s); };

    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const pub = { crv: 'P-256', ext: true, key_ops: ['verify'], kty: 'EC', x: jwk.x, y: jwk.y };
    const bodyHash = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(0))));

    async function fetchItems(url) {
      // 1) challenge fresco
      const chRes = await fetch(base + '/api/challenge', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ fingerprint: null, publicKey: pub }),
      });
      if (!chRes.ok) return null;
      const ch = await chRes.json();
      if (!ch.token) return null;
      // 2) firma fresca
      const ts = String(Date.now());
      const sig = b64u(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, enc.encode(ts + '.' + bodyHash))));
      // 3) items
      const r = await fetch(url, {
        credentials: 'include',
        headers: {
          'Accept': 'application/octet-stream, */*',
          'X-Challenge-Token': ch.token,
          'X-Public-Key': JSON.stringify(pub),
          'X-Signature': sig,
          'X-Signature-Timestamp': ts,
          'X-Body-Hash': bodyHash,
          'X-Verify-Token': 'guest',
        },
      });
      return r.ok ? b64(await r.arrayBuffer()) : null;
    }

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const itemsByPair = {};
    for (const p of pairs) {
      const url = base + `/api/items?serverId=${p.serverId}&job=${p.job}&type=${p.type}&subtype=${p.subtype}&locale=${p.locale}`;
      let res = null;
      // El /api/items da 403 intermitente; reintentamos con challenge nuevo hasta 4 veces
      for (let attempt = 0; attempt < 4 && res === null; attempt++) {
        try { res = await fetchItems(url); } catch { res = null; }
        if (res === null) await sleep(500);
      }
      itemsByPair[p.key] = res;
    }

    let namesB64 = '';
    if (fetchNames) {
      try {
        const nmRes = await fetch(base + '/data/item_names/' + pairs[0].locale + '.pbf', { credentials: 'include' });
        if (nmRes.ok) namesB64 = b64(await nmRes.arrayBuffer());
      } catch { /* opcional */ }
    }

    return { itemsByPair, namesB64 };
  }, { base, pairs, fetchNames });
}

// ── Casar una regla requerida contra un attr/apply ───────────────────────────
function attrMatches(attrId, attrValue, req) {
  if (attrId !== req.id) return false;
  if (req.value !== undefined) return attrValue == req.value;
  if (req.min !== undefined && req.max !== undefined) return attrValue >= req.min && attrValue <= req.max;
  if (req.min !== undefined) return attrValue >= req.min;
  if (req.max !== undefined) return attrValue <= req.max;
  return false;
}

// Devuelve {ok, matched:[[id,val],...]} si el item cumple la búsqueda
function itemMatchesSearch(item, cfg) {
  const mode = cfg.matchMode || 'all';
  const pool = [...(item.attrs || []), ...(item.applies || [])];
  const matched = [];
  let allOk = true;
  for (const req of cfg.required) {
    const hit = pool.find(a => attrMatches(a[0], a[1], req));
    if (hit) matched.push([hit[0], hit[1]]);
    else allOk = false;
  }
  const ok = mode === 'any' ? matched.length > 0 : (allOk && matched.length === cfg.required.length);
  return { ok, matched };
}

// ── Telegram ─────────────────────────────────────────────────────────────────
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
  return h.toString(16);
}
function uidOf(m) { return fnv(`${m.search}_${m.vnum}_${m.seller}_${m.wonPrice}_${m.yangPrice}`); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function telegramText(m) {
  const hitSet = new Set((m.matched || []).map(a => a[0] + ':' + a[1]));
  let t = '🔔 <b>NUEVO ITEM ENCONTRADO</b>\n\n';
  t += `🔍 <b>Búsqueda:</b> ${esc(m.search)}\n`;
  t += `📦 <b>Nombre:</b> ${esc(m.name_es)}\n`;
  t += `🔢 <b>VNUM:</b> ${esc(m.vnum)}\n`;
  t += `👤 <b>Vendedor:</b> ${esc(m.seller)}\n`;
  t += `💰 <b>Won:</b> ${Number(m.wonPrice).toLocaleString('es-ES')}\n`;
  t += `💎 <b>Yang:</b> ${Number(m.yangPrice).toLocaleString('es-ES')}\n`;
  t += `📊 <b>Cantidad:</b> ${esc(m.quantity)}\n`;
  t += '✨ <b>Bonus:</b>\n';
  const lines = [];
  for (const a of [...(m.attrs || []), ...(m.applies || [])]) {
    const hit = hitSet.has(a[0] + ':' + a[1]);
    lines.push('   ' + (hit ? '⭐ ' : '• ') + esc(formatAttr(a[0], a[1])));
  }
  t += (lines.length ? lines.join('\n') : '   • Sin atributos') + '\n';
  return t;
}
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  return res.ok;
}

// ── Webshare API: lista de proxies actualizada automáticamente ───────────────
// Con WEBSHARE_TOKEN, el script coge tus proxies frescos en cada ejecución (se adapta
// solo cuando Webshare los rota). El token es la API Key del dashboard (no la del proxy).
async function getWebshareProxies(token) {
  try {
    const r = await fetch('https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=100', {
      headers: { Authorization: `Token ${token}` },
    });
    if (!r.ok) { console.log('Webshare API HTTP ' + r.status); return []; }
    const j = await r.json();
    return (j.results || [])
      .filter(p => p.valid !== false)
      .map(p => ({ server: `http://${p.proxy_address}:${p.port}`, username: p.username, password: p.password }));
  } catch (e) { console.log('Webshare API error: ' + (e.message || e)); return []; }
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const active = SEARCH_CONFIGS.filter(c => c.enabled !== false);
  if (!active.length) { console.error('No hay búsquedas activas'); process.exit(1); }

  // Pares tipo:subtype únicos a consultar
  const pairMap = {};
  for (const c of active) {
    const job = c.job ?? JOB;
    const key = `${job}:${c.type}:${c.subtype}`;
    if (!pairMap[key]) pairMap[key] = { key, serverId: SERVER_ID, job, type: c.type, subtype: c.subtype, locale: LOCALE };
  }
  const pairs = Object.values(pairMap);

  // Proxies (secret PROXIES: uno por línea o coma, formato http://user:pass@host:port).
  // Imprescindibles: metin2alerts bloquea las IPs de datacenter de GitHub/Azure, no las de
  // otros proveedores (ej. Webshare). Con Playwright + 1 proxy fijo, la sesión (IP+cookies)
  // se mantiene en las dos peticiones (challenge + items).
  const parseProxy = u => {
    const m = u.trim().match(/^https?:\/\/(?:([^:@]+):([^@]+)@)?([^:/]+):(\d+)$/);
    return m ? { server: `http://${m[3]}:${m[4]}`, username: m[1] || undefined, password: m[2] || undefined } : null;
  };
  const shuffle = a => a.map(v => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
  const parseList = env => (process.env[env] || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean).map(parseProxy).filter(Boolean);

  // ── Pool de proxies por CAPAS (gratis primero, reserva de pago al final) ─────
  // GRATIS: WEBSHARE_TOKEN admite VARIOS tokens separados por coma (varias cuentas free →
  // se suma el ancho de banda; si una da 402 se salta a la siguiente). + secret PROXIES.
  let freeProxies = [];
  for (const tok of (process.env.WEBSHARE_TOKEN || '').split(',').map(s => s.trim()).filter(Boolean)) {
    freeProxies = freeProxies.concat(await getWebshareProxies(tok));
  }
  freeProxies = freeProxies.concat(parseList('PROXIES'));
  // RESERVA (de pago, ej. IPRoyal/Bright Data): SOLO se usa si todas las gratis fallan.
  const reserveProxies = parseList('PROXIES_RESERVE');
  const candidates = (freeProxies.length || reserveProxies.length)
    ? [...shuffle(freeProxies), ...reserveProxies]   // gratis barajadas → reserva al final
    : [null];                                        // sin proxies → intento directo
  const proxyTotal = freeProxies.length + reserveProxies.length;
  console.log(`proxies: ${freeProxies.length} gratis + ${reserveProxies.length} reserva`);

  // ── Nombres cacheados ~30 días (prácticamente estáticos) → ahorra ~850 KB/run ─
  let names = {}, fetchNames = true;
  try {
    const nc = JSON.parse(fs.readFileSync(NAMES_CACHE, 'utf8'));
    if (nc && nc.names && (Date.now() - (nc.ts || 0)) < 30 * 24 * 3600 * 1000) { names = nc.names; fetchNames = false; }
  } catch { /* sin caché → se descargan una vez */ }

  const spoofScript = () => {
    const s = { 37445: 'Intel Inc.', 37446: 'Intel(R) Iris(R) Xe Graphics' };
    for (const proto of [WebGLRenderingContext.prototype, window.WebGL2RenderingContext && WebGL2RenderingContext.prototype].filter(Boolean)) {
      const orig = proto.getParameter;
      proto.getParameter = function (p) { return s[p] ?? orig.call(this, p); };
    }
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  };

  let itemsByPair = {};
  const attempts = [];  // proxies probados y su resultado (para el aviso de Telegram)
  for (const proxy of candidates) {
    const label = proxy ? proxy.server : 'directo';
    let browser = null;
    try {
      browser = await chromium.launch({
        headless: false, proxy: proxy || undefined,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--disable-blink-features=AutomationControlled'],
      });
      const context = await browser.newContext({ locale: 'es-ES', viewport: { width: 1280, height: 720 } });
      await context.addInitScript(spoofScript);
      const page = await context.newPage();
      await applyAdblock(page);   // corta imágenes/ads/analytics → menos ancho de banda, sin parecer bot
      await page.goto(BASE + '/' + LOCALE, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForTimeout(8000);
      const res = await fetchInPage(page, BASE, pairs, fetchNames);
      const decoded = {}; let tot = 0;
      for (const [k, b64] of Object.entries(res.itemsByPair)) { decoded[k] = b64 ? decodeItemList(Buffer.from(b64, 'base64')) : []; tot += decoded[k].length; }
      if (tot > 0) {
        itemsByPair = decoded;
        if (fetchNames && res.namesB64) { try { names = decodeNames(Buffer.from(res.namesB64, 'base64')); saveNamesCache(names); } catch { } }
        attempts.push({ ip: label, r: `OK (${tot} items)` });
        console.log(`✓ proxy OK: ${label}`);
        await browser.close();
        break;
      }
      attempts.push({ ip: label, r: '0 items' });
      console.log(`· proxy sin items: ${label}`);
    } catch (e) {
      const em = (e.message || e).toString().slice(0, 70);
      attempts.push({ ip: label, r: 'error: ' + em });
      console.log(`· proxy falló (${label}): ${em}`);
    } finally {
      if (browser) { try { await browser.close(); } catch {} }
    }
  }

  const totalItems = Object.values(itemsByPair).reduce((s, arr) => s + arr.length, 0);

  // ── Vigilante: cuenta fallos seguidos (health.json) y avisa por Telegram ────
  const health = readHealth();
  const nowUTC = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const runTs = Date.now();   // marca de esta ejecución real → la usa gate.mjs para el throttle
  if (totalItems === 0) {
    console.error('❌ 0 items — todos los proxies fallaron o están bloqueados');
    health.fails = (health.fails || 0) + 1;
    health.lastFail = nowUTC;
    health.lastScrapeTs = runTs;
    // Avisa al 2º fallo seguido, y luego cada 24 (~6 h a 15 min) mientras siga caído (sin spam)
    if (health.fails === 2 || (health.fails > 2 && health.fails % 24 === 0)) {
      const lines = attempts.length ? attempts.map(a => `   • ${a.ip} → ${a.r}`).join('\n') : '   • (sin proxies configurados)';
      await sendTelegram(
        `🔴 <b>SCRAPER CAÍDO</b> · ${health.fails} fallos seguidos\n\n` +
        `🕒 <b>Hora:</b> ${nowUTC}\n` +
        `📊 <b>Proxies disponibles:</b> ${proxyTotal}\n` +
        `🌐 <b>Intentos (IP → resultado):</b>\n${lines}\n\n` +
        `ℹ️ 0 items en todas las categorías → probable bloqueo de las IPs de los proxies (o cambio en la web).`
      );
    }
    writeHealth(health);
    process.exit(1);
  }
  // Éxito: si venía de una caída ya avisada, manda "recuperado"
  if ((health.fails || 0) >= 2) {
    await sendTelegram(`🟢 <b>SCRAPER RECUPERADO</b>\n🕒 ${nowUTC}\nTras ${health.fails} fallos seguidos, vuelve a funcionar.`);
  }
  writeHealth({ fails: 0, lastOk: nowUTC, lastScrapeTs: runTs });

  // Filtrar cada búsqueda contra su par
  const matches = [];
  for (const cfg of active) {
    const items = itemsByPair[`${cfg.job ?? JOB}:${cfg.type}:${cfg.subtype}`] || [];
    for (const it of items) {
      const { ok, matched } = itemMatchesSearch(it, cfg);
      if (!ok) continue;
      const name = names[it.vnum] || String(it.vnum);
      if (cfg.targetName && !name.toLowerCase().includes(cfg.targetName.toLowerCase())) continue;
      matches.push({
        search: cfg.name, vnum: it.vnum, name_es: name, seller: it.seller,
        wonPrice: it.wonPrice, yangPrice: it.yangPrice, quantity: it.quantity,
        attrs: it.attrs, applies: it.applies, matched,
      });
    }
  }
  console.log(`✔ ${totalItems} items en ${pairs.length} categorías · ${matches.length} coincidencias (${active.length} búsquedas)`);

  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    total: totalItems,
    searches: active.map(c => c.name),
    matches,
  }, null, 0));

  // Notificar solo lo nuevo
  let notified = [];
  try { notified = JSON.parse(fs.readFileSync(NOTIFIED_FILE, 'utf8')); } catch { notified = []; }
  const set = new Set(notified);
  let sent = 0;
  for (const m of matches) {
    const id = uidOf(m);
    if (set.has(id)) continue;
    if (await sendTelegram(telegramText(m))) { set.add(id); sent++; }
  }
  if (sent > 0) fs.writeFileSync(NOTIFIED_FILE, JSON.stringify([...set].slice(-2000), null, 0));
  console.log(`📨 ${sent} notificación(es) nuevas a Telegram`);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
