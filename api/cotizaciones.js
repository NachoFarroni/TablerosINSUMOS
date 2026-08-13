// ════════════════════════════════════════════════════════════════════════════
// Tablero de Deuda — Función serverless de cotizaciones
//
// POR QUÉ EXISTE: el navegador no puede leer bna.com.ar ni cac.bcr.com.ar
// directamente — esos servidores no habilitan CORS. Esta función corre en el
// servidor de Vercel, donde CORS no aplica, lee las dos páginas y le devuelve
// el JSON al tablero.
//
// DÓNDE VA: en el repo, carpeta  api/cotizaciones.js
// Vercel la detecta sola. No hace falta build step, ni package.json, ni deps.
//
// USO:   /api/cotizaciones                → JSON para el tablero
//        /api/cotizaciones?debug=1        → extractos del HTML, para diagnosticar
// ════════════════════════════════════════════════════════════════════════════

const BNA_URL = 'https://www.bna.com.ar/Personas';
const CAC_URL = 'https://www.cac.bcr.com.ar/es/precios-de-pizarra';
const AD_URL  = 'https://api.argentinadatos.com/v1/cotizaciones/dolares/mayorista';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

// Rangos de plausibilidad. Sin esto, cualquier número suelto de la página
// (un contador de visitas, un CUIT) se cuela como si fuera un precio.
const TC_MIN = 100,    TC_MAX = 100000;        // ARS por dólar
const GR_MIN = 10000,  GR_MAX = 5000000;       // ARS por tonelada

async function getText(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/json' },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

// "1.491,5000" → 1491.5   |   "505.000,00" → 505000
function toNum(s) {
  if (s == null) return 0;
  let x = String(s).trim().replace(/\$|\s|&nbsp;/g, '');
  if (x.includes(',')) x = x.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(x)) x = x.replace(/\./g, '');   // "505.000" sin decimales
  const n = parseFloat(x);
  return isFinite(n) ? n : 0;
}
const stripTags = h => h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
                        .replace(/<[^>]*>/g, ' | ').replace(/&nbsp;/g, ' ');
const sinAcentos = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const NUMS = /\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+,\d+|\b\d{4,7}\b/g;

function numerosEnRango(txt, min, max) {
  return (txt.match(NUMS) || []).map(toNum).filter(n => n >= min && n <= max);
}
function posiciones(txt, palabra) {
  const out = []; let i = txt.indexOf(palabra);
  while (i >= 0 && out.length < 40) { out.push(i); i = txt.indexOf(palabra, i + 1); }
  return out;
}

// ── BNA ─────────────────────────────────────────────────────────────────────
// Ojo: la palabra "Divisas" aparece primero en la SOLAPA de navegación, antes
// de la tabla de billetes. Por eso acá se busca el ancla/id, no la palabra.
// Y como red de seguridad: entre todas las filas de dólar de la página, la
// divisa vendedor es siempre la MENOR (el billete carga más spread).
function parseBNA(html) {
  const filas = html.split(/<tr[^>]*>/i);
  const candidatas = [];
  for (const fila of filas) {
    const txt = sinAcentos(stripTags(fila));
    if (!/\bDOLAR\b|\bDOLAR U\.?S\.?A/.test(txt)) continue;
    if (/EURO|REAL|LIBRA|YEN|FRANCO|GUARANI/.test(txt)) continue;
    const nums = numerosEnRango(txt, TC_MIN, TC_MAX);
    if (nums.length) candidatas.push({ compra: nums.length >= 2 ? nums[0] : 0,
                                       venta: nums[nums.length - 1], pos: html.indexOf(fila) });
  }
  if (!candidatas.length) return null;

  // 1) Preferimos la fila que esté dentro del bloque de DIVISAS
  const anclas = [...html.matchAll(/(?:id|name)\s*=\s*["']?divisas/gi)].map(m => m.index);
  if (anclas.length) {
    const desde = anclas[anclas.length - 1];
    const dentro = candidatas.filter(c => c.pos >= desde);
    if (dentro.length) return { ...dentro[0], modo: 'bloque divisas' };
  }
  // 2) Si no se pudo ubicar el bloque, NO se adivina: quedarse con la venta más
  //    baja hacía que cualquier número suelto de la página ganara.
  if (candidatas.length === 1) return { ...candidatas[0], modo: 'única fila de dólar' };
  return null;
}

// ── Cámara Arbitral de Cereales (BCR) ───────────────────────────────────────
// No se asume ninguna estructura de tabla: se busca cada grano en el texto y
// se toma el primer número plausible que aparezca cerca.
// De todas las veces que aparece el grano en la página (menú, títulos, la fila
// de precios), nos quedamos con aquella donde el número plausible está MÁS CERCA
// del nombre. Así una mención en el menú no se roba el precio del grano de al lado.
function precioCercaDe(txt, palabras, adelante = 300, atras = 140) {
  const buscar = (atrasN) => {
    let mejor = null;
    for (const pal of palabras) {
      for (const i of posiciones(txt, pal)) {
        const ini = Math.max(0, i - atrasN);
        const seg = txt.slice(ini, i + adelante);
        const re = new RegExp(NUMS.source, 'g');
        let m;
        while ((m = re.exec(seg))) {
          const v = toNum(m[0]);
          if (v < GR_MIN || v > GR_MAX) continue;
          const d = Math.abs((ini + m.index) - i);
          if (!mejor || d < mejor.d) mejor = { d, v };
        }
      }
    }
    return mejor;
  };
  // El precio casi siempre va DESPUÉS del nombre del grano. Solo si no aparece
  // ninguno se mira hacia atrás (por si la página pone el precio a la izquierda).
  const m = buscar(0) || buscar(atras);
  return m ? m.v : 0;
}
function parseCAC(html) {
  const txt = sinAcentos(stripTags(html));
  const soja  = precioCercaDe(txt, ['SOJA']);
  const maiz  = precioCercaDe(txt, ['MAIZ']);
  const trigo = precioCercaDe(txt, ['TRIGO']);
  if (!soja && !maiz && !trigo) return null;
  // Tres granos distintos no pueden valer exactamente lo mismo: si pasa,
  // es que se leyó el mismo número suelto tres veces.
  if (soja && soja === maiz && maiz === trigo) {
    return { error: 'los tres granos dieron el mismo valor (' + soja + '): la lectura no es confiable' };
  }
  const f = stripTags(html).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return { soja, maiz, trigo,
           fecha: f ? `${f[3]}-${String(f[2]).padStart(2,'0')}-${String(f[1]).padStart(2,'0')}` : '' };
}

// ── Respaldo del dólar: histórico con CORS, retrocediendo hasta 7 días ──────
async function dolarHistorico(fechaISO) {
  const [y, m, d] = fechaISO.split('-').map(Number);
  for (let k = 0; k < 7; k++) {
    const t = new Date(Date.UTC(y, m - 1, d - k));
    const u = `${AD_URL}/${t.getUTCFullYear()}/${String(t.getUTCMonth()+1).padStart(2,'0')}/${String(t.getUTCDate()).padStart(2,'0')}`;
    try {
      const j = JSON.parse(await getText(u, 5000));
      if (j && j.venta) return { compra: j.compra || 0, venta: j.venta, fecha: j.fecha || null };
    } catch (e) { /* fin de semana o feriado: probamos el día anterior */ }
  }
  return null;
}

// ── Extractos para diagnosticar cuando algo no cierra ───────────────────────
function extractos(html, palabras, ventana = 700, max = 3) {
  const txt = stripTags(html).replace(/\s+/g, ' ');
  const up = sinAcentos(txt), out = [];
  for (const pal of palabras) {
    for (const i of posiciones(up, pal).slice(0, max)) {
      out.push(txt.slice(Math.max(0, i - 120), i + ventana));
    }
  }
  return out.slice(0, 8);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const debug = !!(req.query && req.query.debug);
  res.setHeader('Cache-Control', debug ? 'no-store' : 's-maxage=1800, stale-while-revalidate=86400');

  const hoy = new Date(), ayer = new Date(hoy.getTime() - 86400000);
  const fecha = (req.query && req.query.fecha) ||
    `${ayer.getUTCFullYear()}-${String(ayer.getUTCMonth()+1).padStart(2,'0')}-${String(ayer.getUTCDate()).padStart(2,'0')}`;

  const errores = [];
  let dolar  = { ok: false, valor: 0, fecha: null, fuente: null };
  let granos = { ok: false, soja: 0, maiz: 0, trigo: 0, fecha: null, fuente: null };
  const dbg = {};

  // 1) Dólar.
  //    La API mayorista viene devolviendo exactamente el mismo valor que la Divisa
  //    Vendedor del BNA (1490,5 y 1491,50 en dos días distintos), y es un JSON estable.
  //    El scrapeo del HTML del BNA demostró ser frágil, así que queda como verificación:
  //    informa si difiere, pero no pisa el valor bueno.
  try {
    let ref = await dolarHistorico(fecha);
    if (!ref) {
      const j = JSON.parse(await getText('https://dolarapi.com/v1/dolares/mayorista', 5000));
      if (j && j.venta) ref = { compra: j.compra || 0, venta: j.venta, fecha: (j.fechaActualizacion||'').slice(0,10) || null };
    }
    if (!ref) throw new Error('sin cotización mayorista en los últimos 7 días');
    if (ref.venta < TC_MIN || ref.venta > TC_MAX) throw new Error('valor fuera de rango: ' + ref.venta);
    dolar = { ok: true, valor: ref.venta, compra: ref.compra, fecha: ref.fecha,
              fuente: 'Divisa Vendedor (mayorista)' };
  } catch (e) { errores.push('Dólar: ' + e.message); }

  // Verificación contra el HTML del BNA — solo informa, nunca reemplaza
  try {
    const html = await getText(BNA_URL, 6000);
    if (debug) dbg.bna = extractos(html, ['DOLAR']);
    const p = parseBNA(html);
    if (p && p.venta) {
      dolar.bnaLeido = p.venta; dolar.bnaModo = p.modo;
      if (!dolar.ok) {                                   // último recurso
        dolar = { ok: true, valor: p.venta, compra: p.compra, fecha: null,
                  fuente: 'BNA — Divisa Vendedor (scrapeo)', nota: p.modo };
      } else {
        const dif = Math.abs(p.venta - dolar.valor) / dolar.valor;
        if (dif > 0.05) errores.push('Aviso: el HTML del BNA dice ' + p.venta +
          ' y la cotización mayorista ' + dolar.valor + ' (difieren ' + Math.round(dif*100) + '%). Se usó la mayorista.');
      }
    }
  } catch (e) { if (debug) dbg.bnaError = e.message; }

  // 2) Granos: pizarra de la Cámara Arbitral de Cereales (BCR), en ARS/tn
  try {
    const html = await getText(CAC_URL);
    if (debug) dbg.cac = extractos(html, ['SOJA', 'MAIZ', 'TRIGO']);
    const p = parseCAC(html);
    if (!p) throw new Error('no se encontraron los precios de pizarra');
    if (p.error) throw new Error(p.error);
    granos = { ok: true, soja: p.soja, maiz: p.maiz, trigo: p.trigo, fecha: p.fecha || null,
               fuente: 'Cámara Arbitral de Cereales (BCR) — pizarra' };
    const faltan = ['soja','maiz','trigo'].filter(k => !p[k]);
    if (faltan.length) errores.push('CAC BCR: sin precio para ' + faltan.join(', '));
  } catch (e) { errores.push('CAC BCR: ' + e.message); }

  return res.status(200).json({
    ok: dolar.ok && granos.ok,
    fechaPedida: fecha,
    consultadoEn: new Date().toISOString(),
    dolar, granos, errores,
    ...(debug ? { debug: dbg } : {}),
  });
};
