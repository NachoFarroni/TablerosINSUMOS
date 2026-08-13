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
// Queda publicada en  https://<tu-app>.vercel.app/api/cotizaciones
//
// USO:  /api/cotizaciones?fecha=2026-08-11   (fecha = el día que se quiere)
// ════════════════════════════════════════════════════════════════════════════

const BNA_URL = 'https://www.bna.com.ar/Personas';
const CAC_URL = 'https://www.cac.bcr.com.ar/es/precios-de-pizarra';
const AD_URL  = 'https://api.argentinadatos.com/v1/cotizaciones/dolares/mayorista';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

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

// "1.490,5000" → 1490.5   |   "505.000,00" → 505000
function toNum(s) {
  if (s == null) return 0;
  let x = String(s).trim().replace(/\$|\s|&nbsp;/g, '');
  if (x.includes(',')) x = x.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(x);
  return isFinite(n) ? n : 0;
}
const stripTags = h => h.replace(/<[^>]*>/g, '|').replace(/&nbsp;/g, ' ');
const sinAcentos = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

// ── BNA: tabla de DIVISAS → fila "Dolar U.S.A" → última columna = Vendedor ──
function parseBNA(html) {
  // La página trae dos tablas: Billetes y Divisas. Nos quedamos con la de Divisas.
  const i = sinAcentos(html).indexOf('DIVISAS');
  const zona = i >= 0 ? html.slice(i) : html;
  const filas = zona.split(/<tr[^>]*>/i);
  for (const fila of filas) {
    const txt = stripTags(fila);
    if (!/DOLAR|DÓLAR/i.test(sinAcentos(txt))) continue;
    const nums = (txt.match(/\d{1,3}(?:\.\d{3})*,\d+|\d+,\d+/g) || []).map(toNum).filter(n => n > 100);
    if (nums.length >= 2) return { compra: nums[0], venta: nums[nums.length - 1] };
    if (nums.length === 1) return { compra: 0, venta: nums[0] };
  }
  return null;
}

// ── Cámara Arbitral de Cereales (BCR): pizarra en ARS/tn ──
function parseCAC(html) {
  const out = { soja: 0, maiz: 0, trigo: 0, fecha: '' };
  const filas = html.split(/<tr[^>]*>/i);
  for (const fila of filas) {
    const txt = sinAcentos(stripTags(fila));
    const nums = (txt.match(/\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d{4,}(?:,\d+)?/g) || [])
      .map(toNum).filter(n => n >= 1000);
    if (!nums.length) continue;
    if (/SOJA/.test(txt)  && !out.soja)  out.soja  = nums[0];
    if (/MAIZ/.test(txt)  && !out.maiz)  out.maiz  = nums[0];
    if (/TRIGO/.test(txt) && !out.trigo) out.trigo = nums[0];
  }
  const f = stripTags(html).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (f) out.fecha = `${f[3]}-${String(f[2]).padStart(2, '0')}-${String(f[1]).padStart(2, '0')}`;
  return (out.soja || out.maiz || out.trigo) ? out : null;
}

// ── Respaldo del dólar: histórico con CORS, retrocediendo hasta 7 días ──
async function dolarHistorico(fechaISO) {
  const [y, m, d] = fechaISO.split('-').map(Number);
  for (let k = 0; k < 7; k++) {
    const t = new Date(Date.UTC(y, m - 1, d - k));
    const u = `${AD_URL}/${t.getUTCFullYear()}/${String(t.getUTCMonth() + 1).padStart(2, '0')}/${String(t.getUTCDate()).padStart(2, '0')}`;
    try {
      const j = JSON.parse(await getText(u, 5000));
      if (j && j.venta) return { compra: j.compra || 0, venta: j.venta, fecha: j.fecha || null };
    } catch (e) { /* fin de semana o feriado: probamos el día anterior */ }
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  // 30 min de caché en el edge: no golpeamos al BNA en cada carga del tablero
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const hoy = new Date();
  const ayer = new Date(hoy.getTime() - 86400000);
  const fecha = (req.query && req.query.fecha) ||
    `${ayer.getUTCFullYear()}-${String(ayer.getUTCMonth() + 1).padStart(2, '0')}-${String(ayer.getUTCDate()).padStart(2, '0')}`;

  const errores = [];
  let dolar = { ok: false, valor: 0, fecha: null, fuente: null };
  let granos = { ok: false, soja: 0, maiz: 0, trigo: 0, fecha: null, fuente: null };

  // 1) Dólar: primero el BNA (fuente pedida), si falla el histórico mayorista
  try {
    const p = parseBNA(await getText(BNA_URL));
    if (!p || !p.venta) throw new Error('no se encontró la fila del dólar en la tabla de divisas');
    dolar = { ok: true, valor: p.venta, compra: p.compra, fecha: null, fuente: 'BNA — Divisa Vendedor' };
  } catch (e) {
    errores.push('BNA: ' + e.message);
    try {
      const h = await dolarHistorico(fecha);
      if (!h) throw new Error('sin cotización en los últimos 7 días');
      dolar = { ok: true, valor: h.venta, compra: h.compra, fecha: h.fecha, fuente: 'Mayorista (respaldo) — venta' };
    } catch (e2) { errores.push('Respaldo dólar: ' + e2.message); }
  }

  // 2) Granos: pizarra de la Cámara Arbitral de Cereales (BCR), en ARS/tn
  try {
    const p = parseCAC(await getText(CAC_URL));
    if (!p) throw new Error('no se encontraron los precios de pizarra');
    granos = { ok: true, soja: p.soja, maiz: p.maiz, trigo: p.trigo, fecha: p.fecha || null,
               fuente: 'Cámara Arbitral de Cereales (BCR) — pizarra' };
  } catch (e) { errores.push('CAC BCR: ' + e.message); }

  return res.status(200).json({
    ok: dolar.ok && granos.ok,
    fechaPedida: fecha,
    consultadoEn: new Date().toISOString(),
    dolar, granos, errores,
  });
};
