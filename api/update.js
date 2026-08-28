const { put, head } = require('@vercel/blob');

const LATEST_KEY = 'tablero-deuda/archivos-latest.json';

// POST /api/archivos/update
// Lo llama el HTTP Request final del workflow de n8n ("Enviar Archivos al Tablero (Vercel)")
// o el botón "📤 Publicar para compartir" del propio tablero.
// Body esperado:
// {
//   fecha,                 // fecha del corte, ej "2026-08-28"
//   archivos: { cta_cte: {nombre, base64}, cheques: {...}, negocios: {...}, contratos: {...} },
//   params: {              // OPCIONAL pero recomendado: TC/pizarra usados al generar el tablero
//     fechaTablero,        // igual a "fecha", formato "YYYY-MM-DD"
//     tc,                  // TC BNA Dólar Divisa Vendedor del día hábil anterior
//     precios: { sojaUSD, maizUSD, trigoUSD }   // pizarra BCR del día, ya convertida a USD/tn
//   }
// }
// Si "params" no viene, el tablero igual arma la vista pero usando el último TC/pizarra
// que haya quedado cargado en el frontend.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  const secretEsperado = process.env.TABLERO_API_SECRET;
  const secretRecibido = req.headers['x-api-secret'];

  if (!secretEsperado) {
    res.status(500).json({ error: 'TABLERO_API_SECRET no está configurado en el proyecto de Vercel.' });
    return;
  }
  if (secretRecibido !== secretEsperado) {
    res.status(401).json({ error: 'No autorizado' });
    return;
  }

  const data = req.body;
  if (!data || !data.archivos) {
    res.status(400).json({ error: "El body debe tener un campo 'archivos'" });
    return;
  }

  const requeridos = ['cta_cte', 'cheques', 'negocios', 'contratos'];
  const faltantes = requeridos.filter((k) => !data.archivos[k] || !data.archivos[k].base64);
  if (faltantes.length) {
    res.status(400).json({ error: `Faltan archivos: ${faltantes.join(', ')}` });
    return;
  }

  await put(LATEST_KEY, JSON.stringify(data), {
    access: 'private',
    contentType: 'application/json',
    allowOverwrite: true,
  });

  res.status(200).json({ ok: true, fecha: data.fecha });
};
