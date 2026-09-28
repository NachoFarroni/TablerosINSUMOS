const { get } = require('@vercel/blob');

const LATEST_KEY = 'tablero-deuda/archivos-latest.json';

// GET /api/archivos/latest
// Lo consume la AUTO-CARGA del index.html. El Blob Store es privado, así que se lee
// con get() autenticado (token del store conectado al proyecto), nunca con una URL pública.
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    // useCache:false → siempre la última publicación, aunque se haya pisado hace segundos
    const result = await get(LATEST_KEY, { access: 'private', useCache: false });
    if (!result || !result.stream) {
      res.status(404).json({ error: 'Todavía no hay ningún tablero publicado.' });
      return;
    }
    const texto = await new Response(result.stream).text();
    res.status(200).json(JSON.parse(texto));
  } catch (e) {
    if (e && (e.name === 'BlobNotFoundError' || /not.?found/i.test(e.message || ''))) {
      res.status(404).json({ error: 'Todavía no hay ningún tablero publicado.' });
      return;
    }
    // Cualquier otro error (token, store, permisos) se informa tal cual para poder diagnosticarlo
    console.error('Error leyendo de Blob:', e);
    res.status(500).json({ error: 'No se pudo leer de Vercel Blob: ' + (e && e.message ? e.message : e) });
  }
};
