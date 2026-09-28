const { put } = require('@vercel/blob');

const LATEST_KEY = 'tablero-deuda/archivos-latest.json';

// POST /api/archivos/update
// Lo usan el botón "Publicar para compartir" del tablero y el HTTP Request final del workflow
// de n8n ("Enviar Archivos al Tablero (Vercel)").
// Body: { fecha, archivos: { cta_cte:{nombre,base64}, contratos:{...}, negocios?:{...}, clientes?:{...} }, params? }
// Negocios y Base de clientes son OPCIONALES. Si llega "cheques" (ej. desde el n8n) se guarda pero el tablero no lo usa.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  const secretEsperado = process.env.TABLERO_API_SECRET;
  if (!secretEsperado) {
    res.status(500).json({ error: 'TABLERO_API_SECRET no está configurado en el proyecto de Vercel.' });
    return;
  }
  if (req.headers['x-api-secret'] !== secretEsperado) {
    res.status(401).json({ error: 'Clave incorrecta' });
    return;
  }

  let data = req.body;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { data = null; }
  }
  if (!data || !data.archivos) {
    res.status(400).json({ error: "El body debe tener un campo 'archivos'" });
    return;
  }

  // Cheques ya no es obligatorio: el tablero los toma de la Cta Cte aplicada (RI pendientes).
  const requeridos = ['cta_cte', 'contratos'];
  const faltantes = requeridos.filter((k) => !data.archivos[k] || !data.archivos[k].base64);
  if (faltantes.length) {
    res.status(400).json({ error: `Faltan archivos: ${faltantes.join(', ')}` });
    return;
  }

  try {
    await put(LATEST_KEY, JSON.stringify({ ...data, publicadoEn: new Date().toISOString() }), {
      access: 'private',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60,
    });
    res.status(200).json({ ok: true, fecha: data.fecha });
  } catch (e) {
    console.error('Error guardando en Blob:', e);
    res.status(500).json({ error: 'No se pudo guardar en Vercel Blob: ' + (e && e.message ? e.message : e) });
  }
};
