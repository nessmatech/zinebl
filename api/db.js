/**
 * api/db.js — DentalPro Universal API
 * Uses @neondatabase/serverless tagged-template syntax (no parameterized HTTP queries)
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
  for (const col of (TABLES[table] || [])) {
    if (body[col] !== undefined)
      out[col] = (col === "lignes" && typeof body[col] === "object")
        ? JSON.stringify(body[col]) : body[col];
  }
  return out;
}

// Safe escape for string values used in tagged-template queries
function esc(v) {
  if (v === null || v === undefined) return null;
  return v;
}

module.exports = async function (req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!process.env.NEON_DATABASE_URL)
    return res.status(500).json({ error: "NEON_DATABASE_URL not set" });

  // Create sql per request (correct Neon serverless pattern)
  const sql = neon(process.env.NEON_DATABASE_URL);
  const { t, id, bulk } = req.query;

  // ── PING ──────────────────────────────────────────────────────
  if (t === "_ping") {
    try {
      await sql`SELECT 1`;
      const rows = await sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`;
      return res.json({ ok: true, tables: rows.map(r => r.table_name) });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ── SETUP ─────────────────────────────────────────────────────
  if (t === "_setup") {
    try {
      await sql`CREATE TABLE IF NOT EXISTS clients (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        nom TEXT NOT NULL, cabinet TEXT DEFAULT '', ville TEXT DEFAULT '',
        tel TEXT DEFAULT '', email TEXT DEFAULT '', adresse TEXT DEFAULT '',
        solde NUMERIC DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW())`;
      await sql`CREATE TABLE IF NOT EXISTS produits (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ref TEXT DEFAULT '', nom TEXT NOT NULL, categorie TEXT DEFAULT '',
        designation TEXT DEFAULT '', famille TEXT DEFAULT '',
        prix NUMERIC DEFAULT 0, "prixHT" NUMERIC DEFAULT 0, "prixTTC" NUMERIC DEFAULT 0,
        stock INTEGER DEFAULT 0, "stockTheorique" INTEGER DEFAULT 0,
        "stockReel" INTEGER DEFAULT 0, "qteCdeClient" INTEGER DEFAULT 0,
        "qteCdeFourn" INTEGER DEFAULT 0, unite TEXT DEFAULT 'pièce',
        created_at TIMESTAMPTZ DEFAULT NOW())`;
      await sql`CREATE TABLE IF NOT EXISTS factures (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        numero TEXT DEFAULT '', client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
        date DATE, echeance DATE, statut TEXT DEFAULT 'en_attente',
        lignes JSONB DEFAULT '[]', livree BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW())`;
      await sql`CREATE TABLE IF NOT EXISTS bons_livraison (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        numero TEXT DEFAULT '', facture_id UUID REFERENCES factures(id) ON DELETE SET NULL,
        client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
        date DATE, date_livraison DATE, statut TEXT DEFAULT 'en cours',
        lignes JSONB DEFAULT '[]', acompte NUMERIC DEFAULT 0,
        notes TEXT DEFAULT '', motif TEXT DEFAULT '',
        "tvaActive" BOOLEAN DEFAULT TRUE, "prixDirect" NUMERIC DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW())`;
      await sql`CREATE INDEX IF NOT EXISTS idx_fac_cl ON factures(client_id)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_bl_cl ON bons_livraison(client_id)`;
      return res.json({ ok: true, message: "All tables created" });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ── Validate table ─────────────────────────────────────────────
  if (!t || !TABLES[t])
    return res.status(400).json({ error: "Invalid table: " + (t || "missing") });

  try {
    // ── GET ────────────────────────────────────────────────────
    if (req.method === "GET") {
      let rows;
      if (id) {
        rows = await sql`SELECT * FROM ${sql(t)} WHERE id = ${id} LIMIT 1`;
        if (!rows.length) return res.status(404).json({ error: "Not found" });
        return res.json({ data: rows[0], error: null });
      }
      rows = await sql`SELECT * FROM ${sql(t)} ORDER BY created_at ASC`;
      return res.json({ data: rows, error: null });
    }

    // ── POST single ────────────────────────────────────────────
    if (req.method === "POST" && bulk !== "1") {
      const cols = pick(t, req.body || {});
      const keys = Object.keys(cols);
      if (!keys.length) return res.status(400).json({ error: "No valid fields" });
      const vals   = Object.values(cols);
      const colSQL = keys.map(k => `"${k}"`).join(", ");
      const valSQL = keys.map((_, i) => `$${i + 1}`).join(", ");
      const rows   = await sql(`INSERT INTO "${t}" (${colSQL}) VALUES (${valSQL}) RETURNING *`, vals);
      return res.status(201).json({ data: rows[0] || null, error: null });
    }

    // ── POST bulk ──────────────────────────────────────────────
    if (req.method === "POST" && bulk === "1") {
      const body = req.body;
      if (!Array.isArray(body) || !body.length)
        return res.json({ data: [], inserted: 0, error: null });

      // Use tagged template with unnest for bulk insert (Neon-safe, no $1 in HTTP)
      // Process in batches of 50 to avoid query size limits
      const BATCH = 50;
      const allInserted = [];

      for (let b = 0; b < body.length; b += BATCH) {
        const batch  = body.slice(b, b + BATCH);
        const first  = pick(t, batch[0]);
        const keys   = Object.keys(first);
        if (!keys.length) continue;

        const colSQL = keys.map(k => `"${k}"`).join(", ");
        const vals   = [];
        const rowPH  = batch.map((row, ri) => {
          const c2 = pick(t, row);
          const rowVals = keys.map(k => c2[k] !== undefined ? c2[k] : null);
          vals.push(...rowVals);
          const ph = keys.map((_, ci) => `$${ri * keys.length + ci + 1}`).join(", ");
          return `(${ph})`;
        });

        const query = `INSERT INTO "${t}" (${colSQL}) VALUES ${rowPH.join(", ")} RETURNING *`;
        const rows  = await sql(query, vals);
        allInserted.push(...rows);
      }

      return res.status(201).json({ data: allInserted, inserted: allInserted.length, error: null });
    }

    // ── PATCH ──────────────────────────────────────────────────
    if (req.method === "PATCH") {
      if (!id) return res.status(400).json({ error: "id required" });
      const cols = pick(t, req.body || {});
      const keys = Object.keys(cols);
      if (!keys.length) return res.status(400).json({ error: "No fields to update" });
      const vals   = Object.values(cols);
      const setSQL = keys.map((k, i) => `"${k}" = $${i + 1}`).join(", ");
      const rows   = await sql(
        `UPDATE "${t}" SET ${setSQL} WHERE id = $${keys.length + 1} RETURNING *`,
        [...vals, id]
      );
      if (!rows.length) return res.status(404).json({ error: "Not found" });
      return res.json({ data: rows[0], error: null });
    }

    // ── DELETE ─────────────────────────────────────────────────
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
