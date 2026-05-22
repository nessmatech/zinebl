// api/data.js — Vercel Serverless Function
// Route: /api/data?table=xxx[&id=uuid]
const { neon } = require('@neondatabase/serverless');

const ALLOWED = new Set(['clients','produits','factures','bons_livraison']);
const COLS = {
  clients:        ['nom','cabinet','ville','tel','email','adresse','solde'],
  produits:       ['ref','nom','categorie','designation','famille','prix','prixHT','prixTTC','stock','stockTheorique','stockReel','qteCdeClient','qteCdeFourn','unite'],
  factures:       ['numero','client_id','date','echeance','statut','lignes','livree'],
  bons_livraison: ['numero','facture_id','client_id','date','date_livraison','statut','lignes','acompte','notes','motif','tvaActive','prixDirect'],
};

function pickCols(table, body) {
  const out = {};
  for (const col of (COLS[table] || [])) {
    if (body[col] !== undefined)
      out[col] = (col === 'lignes' && typeof body[col] === 'object') ? JSON.stringify(body[col]) : body[col];
  }
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.NEON_DATABASE_URL)
    return res.status(500).json({ error: 'NEON_DATABASE_URL not set in Vercel environment variables' });

  const sql = neon(process.env.NEON_DATABASE_URL);
  const { table, id } = req.query;

  if (!table || !ALLOWED.has(table))
    return res.status(400).json({ error: 'Invalid table: ' + (table || 'missing') });

  try {
    // GET
    if (req.method === 'GET') {
      const rows = id
        ? await sql`SELECT * FROM ${sql(table)} WHERE id = ${id} LIMIT 1`
        : await sql`SELECT * FROM ${sql(table)} ORDER BY created_at ASC`;
      if (id && !rows.length) return res.status(404).json({ error: 'Not found' });
      return res.json({ data: id ? rows[0] : rows, error: null });
    }

    // POST
    if (req.method === 'POST') {
      const cols = pickCols(table, req.body || {});
      const keys = Object.keys(cols);
      if (!keys.length) return res.status(400).json({ error: 'No valid fields for table: ' + table });
      const vals   = Object.values(cols);
      const colSQL = keys.map(k => '"' + k + '"').join(',');
      const valSQL = keys.map((_, i) => '$' + (i+1)).join(',');
      const rows   = await sql('INSERT INTO "' + table + '" (' + colSQL + ') VALUES (' + valSQL + ') RETURNING *', vals);
      return res.status(201).json({ data: rows[0] || null, error: null });
    }

    // PATCH
    if (req.method === 'PATCH') {
      if (!id) return res.status(400).json({ error: 'id required' });
      const cols = pickCols(table, req.body || {});
      const keys = Object.keys(cols);
      if (!keys.length) return res.status(400).json({ error: 'No fields to update' });
      const vals   = Object.values(cols);
      const setSQL = keys.map((k,i) => '"' + k + '" = $' + (i+1)).join(', ');
      const rows   = await sql('UPDATE "' + table + '" SET ' + setSQL + ' WHERE id = $' + (keys.length+1) + ' RETURNING *', [...vals, id]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      return res.json({ data: rows[0], error: null });
    }

    // DELETE
    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'id required' });
      await sql`DELETE FROM ${sql(table)} WHERE id = ${id}`;
      return res.json({ data: null, error: null });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[data]', req.method, table, err.message);
    return res.status(500).json({ error: err.message });
  }
};
