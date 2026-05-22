// api/index.js — Single entry point for ALL API calls
// Handles: /api/data, /api/ping, /api/setup
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

  const path = req.url.split('?')[0]; // e.g. /api/data or /api/ping

  // ── PING ──────────────────────────────────────────────────────
  if (path === '/api/ping' || path === '/api/index' && req.query.action === 'ping') {
    if (!process.env.NEON_DATABASE_URL)
      return res.json({ ok:false, error:'NEON_DATABASE_URL not set' });
    try {
      const sql = neon(process.env.NEON_DATABASE_URL);
      await sql`SELECT 1`;
      const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`;
      return res.json({ ok:true, db:'connected', tables: tables.map(t=>t.table_name) });
    } catch(e) { return res.status(500).json({ ok:false, error:e.message }); }
  }

  // ── SETUP ─────────────────────────────────────────────────────
  if (path === '/api/setup' || (path === '/api/index' && req.query.action === 'setup')) {
    if (!process.env.NEON_DATABASE_URL)
      return res.status(500).json({ error:'NEON_DATABASE_URL not set' });
    try {
      const sql = neon(process.env.NEON_DATABASE_URL);
      await sql`CREATE TABLE IF NOT EXISTS clients (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nom TEXT NOT NULL, cabinet TEXT DEFAULT '', ville TEXT DEFAULT '', tel TEXT DEFAULT '', email TEXT DEFAULT '', adresse TEXT DEFAULT '', solde NUMERIC DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW())`;
      await sql`CREATE TABLE IF NOT EXISTS produits (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), ref TEXT DEFAULT '', nom TEXT NOT NULL, categorie TEXT DEFAULT '', designation TEXT DEFAULT '', famille TEXT DEFAULT '', prix NUMERIC DEFAULT 0, "prixHT" NUMERIC DEFAULT 0, "prixTTC" NUMERIC DEFAULT 0, stock INTEGER DEFAULT 0, "stockTheorique" INTEGER DEFAULT 0, "stockReel" INTEGER DEFAULT 0, "qteCdeClient" INTEGER DEFAULT 0, "qteCdeFourn" INTEGER DEFAULT 0, unite TEXT DEFAULT 'pièce', created_at TIMESTAMPTZ DEFAULT NOW())`;
      await sql`CREATE TABLE IF NOT EXISTS factures (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), numero TEXT DEFAULT '', client_id UUID REFERENCES clients(id) ON DELETE CASCADE, date DATE, echeance DATE, statut TEXT DEFAULT 'en_attente', lignes JSONB DEFAULT '[]', livree BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW())`;
      await sql`CREATE TABLE IF NOT EXISTS bons_livraison (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), numero TEXT DEFAULT '', facture_id UUID REFERENCES factures(id) ON DELETE SET NULL, client_id UUID REFERENCES clients(id) ON DELETE CASCADE, date DATE, date_livraison DATE, statut TEXT DEFAULT 'en cours', lignes JSONB DEFAULT '[]', acompte NUMERIC DEFAULT 0, notes TEXT DEFAULT '', motif TEXT DEFAULT '', "tvaActive" BOOLEAN DEFAULT TRUE, "prixDirect" NUMERIC DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW())`;
      await sql`CREATE INDEX IF NOT EXISTS idx_fac_cl ON factures(client_id)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_bl_cl  ON bons_livraison(client_id)`;
      return res.json({ ok:true, message:'Tables ready', tables:['clients','produits','factures','bons_livraison'] });
    } catch(e) { return res.status(500).json({ error:e.message }); }
  }

  // ── DATA CRUD ─────────────────────────────────────────────────
  if (!process.env.NEON_DATABASE_URL)
    return res.status(500).json({ error:'NEON_DATABASE_URL not set' });

  const sql = neon(process.env.NEON_DATABASE_URL);
  const { table, id } = req.query;

  if (!table || !ALLOWED.has(table))
    return res.status(400).json({ error:'Invalid table: ' + (table||'missing') });

  try {
    if (req.method === 'GET') {
      const rows = id
        ? await sql`SELECT * FROM ${sql(table)} WHERE id = ${id} LIMIT 1`
        : await sql`SELECT * FROM ${sql(table)} ORDER BY created_at ASC`;
      if (id && !rows.length) return res.status(404).json({ error:'Not found' });
      return res.json({ data: id ? rows[0] : rows, error:null });
    }
    if (req.method === 'POST') {
      const cols = pickCols(table, req.body||{});
      const keys = Object.keys(cols);
      if (!keys.length) return res.status(400).json({ error:'No valid fields for '+table });
      const vals = Object.values(cols);
      const rows = await sql(
        'INSERT INTO "'+table+'" ('+keys.map(k=>'"'+k+'"').join(',')+') VALUES ('+keys.map((_,i)=>'$'+(i+1)).join(',')+') RETURNING *',
        vals
      );
      return res.status(201).json({ data:rows[0]||null, error:null });
    }
    if (req.method === 'PATCH') {
      if (!id) return res.status(400).json({ error:'id required' });
      const cols = pickCols(table, req.body||{});
      const keys = Object.keys(cols);
      if (!keys.length) return res.status(400).json({ error:'No fields to update' });
      const vals = Object.values(cols);
      const rows = await sql(
        'UPDATE "'+table+'" SET '+keys.map((k,i)=>'"'+k+'" = $'+(i+1)).join(', ')+' WHERE id = $'+(keys.length+1)+' RETURNING *',
        [...vals, id]
      );
      if (!rows.length) return res.status(404).json({ error:'Not found' });
      return res.json({ data:rows[0], error:null });
    }
    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error:'id required' });
      await sql`DELETE FROM ${sql(table)} WHERE id = ${id}`;
      return res.json({ data:null, error:null });
    }
    return res.status(405).json({ error:'Method not allowed' });
  } catch(err) {
    console.error('[api/index]', req.method, table, err.message);
    return res.status(500).json({ error:err.message });
  }
};
