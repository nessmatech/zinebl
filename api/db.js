/**
 * api/db.js — DentalPro Universal API
 *
 * GET    /api/db?t=clients              → list all
 * POST   /api/db?t=clients              → insert one
 * POST   /api/db?t=clients&bulk=1       → bulk insert array
 * PATCH  /api/db?t=clients&id=xxx       → update one
 * DELETE /api/db?t=clients&id=xxx       → delete one
 * GET    /api/db?t=_ping               → connection test
 * GET    /api/db?t=_setup              → create all tables
 */
const { neon } = require("@neondatabase/serverless");

const TABLES = {
  clients:        ["nom","cabinet","ville","tel","email","adresse","solde"],
  produits:       ["ref","nom","categorie","designation","famille","prix","prixHT","prixTTC","stock","stockTheorique","stockReel","qteCdeClient","qteCdeFourn","unite"],
  factures:       ["numero","client_id","date","echeance","statut","lignes","livree"],
  bons_livraison: ["numero","facture_id","client_id","date","date_livraison","statut","lignes","acompte","notes","motif","tvaActive","prixDirect"],
};

function pick(table, body) {
  const out = {};
  for (const c of (TABLES[table] || [])) {
    if (body[c] !== undefined)
      out[c] = c === "lignes" && typeof body[c] === "object" ? JSON.stringify(body[c]) : body[c];
  }
  return out;
}

module.exports = async function (req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!process.env.NEON_DATABASE_URL)
    return res.status(500).json({ error: "NEON_DATABASE_URL not set in Vercel environment variables" });

  const sql = neon(process.env.NEON_DATABASE_URL);
  const { t, id, bulk } = req.query;

  // ── PING ────────────────────────────────────────────────────
  if (t === "_ping") {
    try {
      await sql`SELECT 1`;
      const rows = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`;
      return res.json({ ok: true, tables: rows.map(r => r.table_name) });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }

  // ── SETUP ───────────────────────────────────────────────────
  if (t === "_setup") {
    try {
      await sql`CREATE TABLE IF NOT EXISTS clients (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        nom TEXT NOT NULL, cabinet TEXT DEFAULT '', ville TEXT DEFAULT '',
        tel TEXT DEFAULT '', email TEXT DEFAULT '', adresse TEXT DEFAULT '',
        solde NUMERIC DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS produits (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ref TEXT DEFAULT '', nom TEXT NOT NULL, categorie TEXT DEFAULT '',
        designation TEXT DEFAULT '', famille TEXT DEFAULT '',
        prix NUMERIC DEFAULT 0, "prixHT" NUMERIC DEFAULT 0, "prixTTC" NUMERIC DEFAULT 0,
        stock INTEGER DEFAULT 0, "stockTheorique" INTEGER DEFAULT 0,
        "stockReel" INTEGER DEFAULT 0, "qteCdeClient" INTEGER DEFAULT 0,
        "qteCdeFourn" INTEGER DEFAULT 0, unite TEXT DEFAULT 'pièce',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS factures (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        numero TEXT DEFAULT '', client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
        date DATE, echeance DATE, statut TEXT DEFAULT 'en_attente',
        lignes JSONB DEFAULT '[]', livree BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS bons_livraison (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        numero TEXT DEFAULT '', facture_id UUID REFERENCES factures(id) ON DELETE SET NULL,
        client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
        date DATE, date_livraison DATE, statut TEXT DEFAULT 'en cours',
        lignes JSONB DEFAULT '[]', acompte NUMERIC DEFAULT 0,
        notes TEXT DEFAULT '', motif TEXT DEFAULT '',
        "tvaActive" BOOLEAN DEFAULT TRUE, "prixDirect" NUMERIC DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS idx_fac_cl ON factures(client_id)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_bl_cl ON bons_livraison(client_id)`;
      return res.json({ ok: true, message: "All tables created successfully" });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }

  // ── Validate table ───────────────────────────────────────────
  if (!t || !TABLES[t])
    return res.status(400).json({ error: "Invalid table: " + (t || "missing") });

  try {
    // GET
    if (req.method === "GET") {
      const rows = id
        ? await sql`SELECT * FROM ${sql(t)} WHERE id = ${id} LIMIT 1`
        : await sql`SELECT * FROM ${sql(t)} ORDER BY created_at ASC`;
      if (id && !rows.length) return res.status(404).json({ error: "Not found" });
      return res.json({ data: id ? rows[0] : rows, error: null });
    }

    // POST — single or bulk
    if (req.method === "POST") {
      const body = req.body;

      // ── BULK INSERT ──────────────────────────────────────────
      if (bulk === "1" && Array.isArray(body)) {
        if (!body.length) return res.json({ data: [], inserted: 0, error: null });

        // Build one multi-row INSERT
        const sampleCols = pick(t, body[0]);
        const keys = Object.keys(sampleCols);
        if (!keys.length) return res.status(400).json({ error: "No valid fields" });

        const colSQL = keys.map(k => `"${k}"`).join(", ");
        const allVals = [];
        const rowPlaceholders = body.map((row, ri) => {
          const cols = pick(t, row);
          const rowVals = keys.map(k => cols[k] !== undefined ? cols[k] : null);
          allVals.push(...rowVals);
          const ph = keys.map((_, ci) => `$${ri * keys.length + ci + 1}`).join(", ");
          return `(${ph})`;
        });

        const query = `INSERT INTO "${t}" (${colSQL}) VALUES ${rowPlaceholders.join(", ")} RETURNING *`;
        const rows = await sql(query, allVals);
        return res.status(201).json({ data: rows, inserted: rows.length, error: null });
      }

      // ── SINGLE INSERT ────────────────────────────────────────
      const cols = pick(t, body || {});
      const keys = Object.keys(cols);
      if (!keys.length) return res.status(400).json({ error: "No valid fields for " + t });
      const vals   = Object.values(cols);
      const colSQL = keys.map(k => `"${k}"`).join(", ");
      const valSQL = keys.map((_, i) => `$${i + 1}`).join(", ");
      const rows   = await sql(`INSERT INTO "${t}" (${colSQL}) VALUES (${valSQL}) RETURNING *`, vals);
      return res.status(201).json({ data: rows[0] || null, error: null });
    }

    // PATCH
    if (req.method === "PATCH") {
      if (!id) return res.status(400).json({ error: "id required" });
      const cols = pick(t, req.body || {});
      const keys = Object.keys(cols);
      if (!keys.length) return res.status(400).json({ error: "No valid fields" });
      const vals   = Object.values(cols);
      const setSQL = keys.map((k, i) => `"${k}" = $${i + 1}`).join(", ");
      const rows   = await sql(`UPDATE "${t}" SET ${setSQL} WHERE id = $${keys.length + 1} RETURNING *`, [...vals, id]);
      if (!rows.length) return res.status(404).json({ error: "Not found" });
      return res.json({ data: rows[0], error: null });
    }

    // DELETE
    if (req.method === "DELETE") {
      if (!id) return res.status(400).json({ error: "id required" });
      await sql`DELETE FROM ${sql(t)} WHERE id = ${id}`;
      return res.json({ data: null, error: null });
    }

    return res.status(405).json({ error: "Method not allowed" });

  } catch (e) {
    console.error("[db]", req.method, t, e.message);
    return res.status(500).json({ error: e.message });
  }
};
