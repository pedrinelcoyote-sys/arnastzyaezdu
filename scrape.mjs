// ─────────────────────────────────────────────────────────────────────────────
// metin2alerts scraper — corre en GitHub Actions con navegador real (Playwright).
// Cloudflare lo resuelve el propio Chromium; el flujo challenge→items va en el
// MISMO origen (sin CORS, sin proxy, sin créditos). Filtra, notifica por Telegram
// y escribe snapshot.json (que lee la web items2.php) + notified.json (dedup).
//
// NO necesita ninguna API de pago. Solo el bot de Telegram (por variables de entorno).
// ─────────────────────────────────────────────────────────────────────────────
import { chromium } from 'playwright';
import fs from 'node:fs';

// ── Configuración de búsqueda (equivale a la de items2.php) ──────────────────
const CFG = {
  base:         'https://metin2alerts.com/store',
  serverId:     506,
  job:          0,
  type:         4,
  subtype:      2,           // 0=Brazaletes, 2=Collares
  locale:       'es',
  enchantAttr:  [151],       // attrtype 151 = Daño de ataque contra jefes
  enchantApply: [],
  targetValue:  5,           // valor exacto ('' = cualquiera)
  targetName:   '',          // parte del nombre ('' = cualquiera)
};

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';
const NOTIFIED_FILE      = 'notified.json';
const SNAPSHOT_FILE      = 'snapshot.json';

// ── stat_map: attrId → plantilla legible (para mostrar/notificar los bonus) ──
let STAT_MAP = {};
try { STAT_MAP = JSON.parse(fs.readFileSync('stat_map.json', 'utf8')); } catch { /* opcional */ }
function formatAttr(id, val) {
  const tpl = STAT_MAP[String(id)];
  if (tpl) return tpl.includes('%d') ? tpl.replace('%d', val) : `${tpl} ${val}`.trim();
  return `ID ${id}: ${val}`;
}

// ── Protobuf (mismo decodificador que la web) ────────────────────────────────
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

// ── Flujo dentro del navegador (mismo origen: sin CORS) ──────────────────────
// Devuelve { itemsB64, namesB64 } o lanza con el error.
async function fetchInPage(page, cfg) {
  return await page.evaluate(async (CFG) => {
    const enc = new TextEncoder();
    const b64u = bytes => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); };
    const b64 = buf => { const u = new Uint8Array(buf); let s = ''; for (const b of u) s += String.fromCharCode(b); return btoa(s); };

    // clave EC P-256
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const pub = { crv: 'P-256', ext: true, key_ops: ['verify'], kty: 'EC', x: jwk.x, y: jwk.y };

    // challenge
    const chRes = await fetch(CFG.base + '/api/challenge', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ fingerprint: null, publicKey: pub }),
    });
    if (!chRes.ok) throw new Error('challenge HTTP ' + chRes.status);
    const ch = await chRes.json();
    if (!ch.token) throw new Error('sin token');

    // firma
    const bodyHash = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(0))));
    const ts = String(Date.now());
    const sig = b64u(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, enc.encode(ts + '.' + bodyHash))));

    // items
    const url = CFG.base + `/api/items?serverId=${CFG.serverId}&job=${CFG.job}&type=${CFG.type}&subtype=${CFG.subtype}&locale=${CFG.locale}`;
    const itRes = await fetch(url, {
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
    if (!itRes.ok) throw new Error('items HTTP ' + itRes.status);
    const itemsB64 = b64(await itRes.arrayBuffer());

    // nombres (best-effort)
    let namesB64 = '';
    try {
      const nmRes = await fetch(CFG.base + '/data/item_names/' + CFG.locale + '.pbf', { credentials: 'include' });
      if (nmRes.ok) namesB64 = b64(await nmRes.arrayBuffer());
    } catch { /* opcional */ }

    return { itemsB64, namesB64 };
  }, cfg);
}

// ── Filtro (misma lógica que items2.php) ─────────────────────────────────────
function filterMatches(items, names) {
  const out = [];
  for (const it of items) {
    const name = names[it.vnum] || String(it.vnum);
    let found = false, value = 0;
    for (const a of it.attrs) if (CFG.enchantAttr.includes(a[0]) && (CFG.targetValue === '' || a[1] == CFG.targetValue)) { found = true; value = a[1]; break; }
    if (!found) for (const a of it.applies) if (CFG.enchantApply.includes(a[0]) && (CFG.targetValue === '' || a[1] == CFG.targetValue)) { found = true; value = a[1]; break; }
    if (!found) continue;
    if (CFG.targetName && !name.toLowerCase().includes(String(CFG.targetName).toLowerCase())) continue;
    out.push({ vnum: it.vnum, name_es: name, seller: it.seller, wonPrice: it.wonPrice, yangPrice: it.yangPrice, quantity: it.quantity, value, attrs: it.attrs, applies: it.applies });
  }
  return out;
}

// ── Telegram ─────────────────────────────────────────────────────────────────
function md5ish(m) { // id estable sin dependencias (FNV-1a hex)
  let h = 0x811c9dc5; const s = `${m.vnum}_${m.seller}_${m.wonPrice}_${m.yangPrice}_${m.value}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24))) >>> 0; }
  return h.toString(16);
}
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function telegramText(m) {
  let t = '🔔 <b>NUEVO ITEM ENCONTRADO</b>\n\n';
  t += `📦 <b>Nombre:</b> ${esc(m.name_es)}\n`;
  t += `🔢 <b>VNUM:</b> ${esc(m.vnum)}\n`;
  t += `👤 <b>Vendedor:</b> ${esc(m.seller)}\n`;
  t += `💰 <b>Won:</b> ${Number(m.wonPrice).toLocaleString('es-ES')}\n`;
  t += `💎 <b>Yang:</b> ${Number(m.yangPrice).toLocaleString('es-ES')}\n`;
  t += `📊 <b>Cantidad:</b> ${esc(m.quantity)}\n`;
  t += '✨ <b>Bonus:</b>\n';
  const lines = [];
  for (const a of m.attrs)   { const hit = CFG.enchantAttr.includes(a[0])  && (CFG.targetValue==='' || a[1]==CFG.targetValue); lines.push('   ' + (hit?'⭐ ':'• ') + esc(formatAttr(a[0], a[1]))); }
  for (const a of m.applies) { const hit = CFG.enchantApply.includes(a[0]) && (CFG.targetValue==='' || a[1]==CFG.targetValue); lines.push('   ' + (hit?'⭐ ':'• ') + esc(formatAttr(a[0], a[1]))); }
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

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  // IMPORTANTE: la web tiene anti-bot propio (además de Cloudflare) que detecta:
  //   · navegadores HEADLESS  → por eso lanzamos HEADFUL (en GitHub, bajo xvfb-run)
  //   · GPU SwiftShader (señal de VM) → la falseamos vía addInitScript
  // Con esto el fingerprint parece un navegador real y /api/challenge devuelve 200.
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({ locale: 'es-ES', viewport: { width: 1280, height: 720 } });
  await context.addInitScript(() => {
    const spoof = { 37445: 'Intel Inc.', 37446: 'Intel(R) Iris(R) Xe Graphics' };
    for (const proto of [WebGLRenderingContext.prototype, window.WebGL2RenderingContext && WebGL2RenderingContext.prototype].filter(Boolean)) {
      const orig = proto.getParameter;
      proto.getParameter = function (p) { return spoof[p] ?? orig.call(this, p); };
    }
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  let items = [], names = {};
  try {
    // Abrir la tienda → Cloudflare se resuelve solo con el navegador real
    await page.goto(CFG.base + '/' + CFG.locale, { waitUntil: 'domcontentloaded', timeout: 90000 });
    // Dar tiempo a que Cloudflare pase (el reto tarda unos segundos)
    await page.waitForTimeout(8000);

    const { itemsB64, namesB64 } = await fetchInPage(page, CFG);
    items = decodeItemList(Buffer.from(itemsB64, 'base64'));
    if (namesB64) { try { names = decodeNames(Buffer.from(namesB64, 'base64')); } catch { names = {}; } }
  } finally {
    await browser.close();
  }

  if (!items.length) { console.error('❌ 0 items — posible bloqueo de Cloudflare en la IP del runner'); process.exit(1); }

  const matches = filterMatches(items, names);
  console.log(`✔ ${items.length} items en servidor · ${matches.length} coincidencias`);

  // snapshot para la web
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    total: items.length,
    query: { serverId: CFG.serverId, type: CFG.type, subtype: CFG.subtype, targetValue: CFG.targetValue },
    matches,
  }, null, 0));

  // notificar solo lo nuevo
  let notified = [];
  try { notified = JSON.parse(fs.readFileSync(NOTIFIED_FILE, 'utf8')); } catch { notified = []; }
  const notifiedSet = new Set(notified);
  let sent = 0;
  for (const m of matches) {
    const id = md5ish(m);
    if (notifiedSet.has(id)) continue;
    if (await sendTelegram(telegramText(m))) { notifiedSet.add(id); sent++; }
  }
  if (sent > 0) {
    const arr = [...notifiedSet].slice(-1000);
    fs.writeFileSync(NOTIFIED_FILE, JSON.stringify(arr, null, 0));
  }
  console.log(`📨 ${sent} notificación(es) nuevas a Telegram`);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
