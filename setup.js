// api/setup.js — Create all tables (run once)
// GET /api/setup    (no secret needed — you can add SETUP_SECRET check if needed)
const { neon } = require('@neondatabase/serverless');
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (!process.env.NEON_DATABASE_URL)
    return res.status(500).json({ error:'NEON_DATABASE_URL not set' });
  const sql = neon(process.env.NEON_DATABASE_URL);
  try {
    await sql`CREATE TABLE IF NOT EXISTS clients (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nom TEXT NOT NULL, cabinet TEXT DEFAULT '', ville TEXT DEFAULT '', tel TEXT DEFAULT '', email TEXT DEFAULT '', adresse TEXT DEFAULT '', solde NUMERIC DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW())`;
    await sql`CREATE TABLE IF NOT EXISTS produits (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), ref TEXT DEFAULT '', nom TEXT NOT NULL, categorie TEXT DEFAULT '', designation TEXT DEFAULT '', famille TEXT DEFAULT '', prix NUMERIC DEFAULT 0, "prixHT" NUMERIC DEFAULT 0, "prixTTC" NUMERIC DEFAULT 0, stock INTEGER DEFAULT 0, "stockTheorique" INTEGER DEFAULT 0, "stockReel" INTEGER DEFAULT 0, "qteCdeClient" INTEGER DEFAULT 0, "qteCdeFourn" INTEGER DEFAULT 0, unite TEXT DEFAULT 'pièce', created_at TIMESTAMPTZ DEFAULT NOW())`;
    await sql`CREATE TABLE IF NOT EXISTS factures (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), numero TEXT DEFAULT '', client_id UUID REFERENCES clients(id) ON DELETE CASCADE, date DATE, echeance DATE, statut TEXT DEFAULT 'en_attente', lignes JSONB DEFAULT '[]', livree BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW())`;
    await sql`CREATE TABLE IF NOT EXISTS bons_livraison (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), numero TEXT DEFAULT '', facture_id UUID REFERENCES factures(id) ON DELETE SET NULL, client_id UUID REFERENCES clients(id) ON DELETE CASCADE, date DATE, date_livraison DATE, statut TEXT DEFAULT 'en cours', lignes JSONB DEFAULT '[]', acompte NUMERIC DEFAULT 0, notes TEXT DEFAULT '', motif TEXT DEFAULT '', "tvaActive" BOOLEAN DEFAULT TRUE, "prixDirect" NUMERIC DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW())`;
    await sql`CREATE INDEX IF NOT EXISTS idx_fac_cl ON factures(client_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_bl_cl  ON bons_livraison(client_id)`;
    return res.json({ ok:true, message:'All tables created', tables:['clients','produits','factures','bons_livraison'] });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
};
