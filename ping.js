// api/ping.js — DB diagnostic
const { neon } = require('@neondatabase/serverless');
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (!process.env.NEON_DATABASE_URL)
    return res.status(500).json({ ok:false, error:'NEON_DATABASE_URL not set' });
  try {
    const sql = neon(process.env.NEON_DATABASE_URL);
    await sql`SELECT 1`;
    const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`;
    const missing = ['clients','produits','factures','bons_livraison'].filter(t => !tables.find(r => r.table_name===t));
    return res.json({
      ok: true, db: 'connected',
      tables: tables.map(t=>t.table_name),
      missing,
      hint: missing.length ? 'Run /api/setup to create missing tables' : 'All good!'
    });
  } catch(err) {
    return res.status(500).json({ ok:false, error: err.message });
  }
};
