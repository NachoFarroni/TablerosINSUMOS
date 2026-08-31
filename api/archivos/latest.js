const { get } = require('@vercel/blob');

const LATEST_KEY = 'tablero-deuda/archivos-latest.json';

// GET /api/archivos/latest
// Lo consume el bloque de AUTO-CARGA agregado en index.html.
// Como el Blob Store es privado, se lee con get() (autenticado automáticamente
// por Vercel vía OIDC), no con un fetch directo a una URL pública.
module.exports = async (req, res) => {
  try {
    const result = await get(LATEST_KEY);
    if (!result || !result.stream) {
      res.status(404).json({ error: 'Todavía no hay ninguna corrida del ETL guardada.' });
      return;
    }

    const chunks = [];
    for await (const chunk of result.stream) {
      chunks.push(chunk);
    }
    const texto = Buffer.concat(chunks).toString('utf-8');
    res.status(200).json(JSON.parse(texto));
  } catch {
    res.status(404).json({ error: 'Todavía no hay ninguna corrida del ETL guardada.' });
  }
};
