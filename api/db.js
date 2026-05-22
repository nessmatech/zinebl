/**
 * api/db.js — DentalPro API (Neon PostgreSQL)
 * Uses ONLY plain SQL strings — no $1 parameters, no tagged templates with identifiers
 * This is the most compatible approach for @neondatabase/serverless
 */
const { neon } = require("@neondatabase/serverless");

// Hardcoded allowed tables — whitelist for security
const ALLOWED = ["clients","produits","factures","bons_livraison"];

const COLS = {
  clients:        ["nom","cabinet","ville","tel","email","adresse","solde"],
  produits:       ["ref","nom","categorie","designation","famille","prix","prixHT","prixTTC","stock","stockTheorique","stockReel","qteCdeClient","qteCdeFourn","unite"],
  factures:       ["numero","client_id","date","echeance","statut","lignes","livree"],
  bons_livraison: ["numero","facture_id","client_id","date","date_livraison","statut","lignes","acompte","notes","motif","tvaActive","prixDirect"],
};

// Escape a value for safe SQL string interpolation
// Date column names — empty string should become NULL
const DATE_COLS = new Set(["date","echeance","date_livraison","created_at"]);

function sqlVal(v, colName) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return isNaN(v) ? "NULL" : String(v);
  const s = String(v);
  // Empty string for date columns = NULL
  if (s === "" && colName && DATE_COLS.has(colName)) return "NULL";
  if (s === "") return "NULL"; // any empty string = NULL (safer for Postgres)
  // String — escape single quotes by doubling them
  return "'" + s.replace(/'/g, "''") + "'";
}

function pick(table, body) {
  const out = {};
  for (const col of (COLS[table] || [])) {
    if (body[col] !== undefined)
      out[col] = (col === "lignes" && typeof body[col] === "object")
        ? JSON.stringify(body[col]) : body[col];
  }
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!process.env.NEON_DATABASE_URL)
    return res.status(500).json({ error: "NEON_DATABASE_URL not set in Vercel environment variables" });

  const sql = neon(process.env.NEON_DATABASE_URL);
  const { t, id, bulk } = req.query;

  // ── PING ──────────────────────────────────────────────────────
  if (t === "_ping") {
    try {
      const rows = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`;
      return res.json({ ok: true, tables: rows.map(r => r.table_name) });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ── SETUP ─────────────────────────────────────────────────────
  if (t === "_setup") {
    try {
      await sql`CREATE TABLE IF NOT EXISTS clients (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nom TEXT NOT NULL, cabinet TEXT DEFAULT '', ville TEXT DEFAULT '', tel TEXT DEFAULT '', email TEXT DEFAULT '', adresse TEXT DEFAULT '', solde NUMERIC DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW())`;
      await sql`CREATE TABLE IF NOT EXISTS produits (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), ref TEXT DEFAULT '', nom TEXT NOT NULL, categorie TEXT DEFAULT '', designation TEXT DEFAULT '', famille TEXT DEFAULT '', prix NUMERIC DEFAULT 0, "prixHT" NUMERIC DEFAULT 0, "prixTTC" NUMERIC DEFAULT 0, stock INTEGER DEFAULT 0, "stockTheorique" INTEGER DEFAULT 0, "stockReel" INTEGER DEFAULT 0, "qteCdeClient" INTEGER DEFAULT 0, "qteCdeFourn" INTEGER DEFAULT 0, unite TEXT DEFAULT 'pièce', created_at TIMESTAMPTZ DEFAULT NOW())`;
      await sql`CREATE TABLE IF NOT EXISTS factures (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), numero TEXT DEFAULT '', client_id UUID REFERENCES clients(id) ON DELETE CASCADE, date DATE, echeance DATE, statut TEXT DEFAULT 'en_attente', lignes JSONB DEFAULT '[]', livree BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW())`;
      await sql`CREATE TABLE IF NOT EXISTS bons_livraison (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), numero TEXT DEFAULT '', facture_id UUID REFERENCES factures(id) ON DELETE SET NULL, client_id UUID REFERENCES clients(id) ON DELETE CASCADE, date DATE, date_livraison DATE, statut TEXT DEFAULT 'en cours', lignes JSONB DEFAULT '[]', acompte NUMERIC DEFAULT 0, notes TEXT DEFAULT '', motif TEXT DEFAULT '', "tvaActive" BOOLEAN DEFAULT TRUE, "prixDirect" NUMERIC DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW())`;
      await sql`CREATE INDEX IF NOT EXISTS idx_fac_cl ON factures(client_id)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_bl_cl ON bons_livraison(client_id)`;
      return res.json({ ok: true, message: "All tables created" });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ── CLEAR TABLE (TRUNCATE) ────────────────────────────────────
  if (t === "_clear") {
    const table = req.query.table;
    if (!ALLOWED.includes(table))
      return res.status(400).json({ error: "Invalid table: " + table });
    try {
      // TRUNCATE with CASCADE to handle foreign keys
      await sql([`TRUNCATE TABLE "${table}" RESTART IDENTITY CASCADE`]);
      return res.json({ ok: true, message: "Table " + table + " cleared" });
    } catch (e) {
      // Fallback: DELETE if TRUNCATE fails
      try {
        await sql([`DELETE FROM "${table}"`]);
        return res.json({ ok: true, message: "Table " + table + " cleared (DELETE)" });
      } catch (e2) {
        return res.status(500).json({ error: e2.message });
      }
    }
  }

  // ── Validate table ─────────────────────────────────────────────
  if (!t || !ALLOWED.includes(t))
    return res.status(400).json({ error: "Invalid table: " + (t || "missing") });

  try {

    // ── GET ────────────────────────────────────────────────────
    if (req.method === "GET") {
      let query;
      if (id) {
        // Safe: id comes from query string, escape it
        query = `SELECT * FROM "${t}" WHERE id = ${sqlVal(id)} LIMIT 1`;
      } else {
        query = `SELECT * FROM "${t}" ORDER BY created_at ASC`;
      }
      const rows = await sql([query]); // pass as array = tagged template literal trick
      if (id) {
        if (!rows.length) return res.status(404).json({ error: "Not found" });
        return res.json({ data: rows[0], error: null });
      }
      return res.json({ data: rows, error: null });
    }

    // ── POST single ────────────────────────────────────────────
    if (req.method === "POST" && bulk !== "1") {
      const cols = pick(t, req.body || {});
      const keys = Object.keys(cols);
      if (!keys.length) return res.status(400).json({ error: "No valid fields for " + t });
      const colSQL = keys.map(k => `"${k}"`).join(", ");
      const valSQL = keys.map(k => sqlVal(cols[k])).join(", ");
      const query  = `INSERT INTO "${t}" (${colSQL}) VALUES (${valSQL}) RETURNING *`;
      const rows   = await sql([query]);
      return res.status(201).json({ data: rows[0] || null, error: null });
    }

    // ── POST bulk ──────────────────────────────────────────────
    if (req.method === "POST" && bulk === "1") {
      const body = req.body;
      if (!Array.isArray(body) || !body.length)
        return res.json({ data: [], inserted: 0, error: null });

      const BATCH = 100;
      const allInserted = [];

      for (let b = 0; b < body.length; b += BATCH) {
        const batch  = body.slice(b, b + BATCH);
        const first  = pick(t, batch[0]);
        const keys   = Object.keys(first);
        if (!keys.length) continue;

        const colSQL  = keys.map(k => `"${k}"`).join(", ");
        const rowsSQL = batch.map(row => {
          const c2 = pick(t, row);
          return "(" + keys.map(k => sqlVal(c2[k] !== undefined ? c2[k] : null, k)).join(", ") + ")";
        });

        const query = `INSERT INTO "${t}" (${colSQL}) VALUES ${rowsSQL.join(", ")} RETURNING *`;
        const rows  = await sql([query]);
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
      const setSQL = keys.map(k => `"${k}" = ${sqlVal(cols[k], k)}`).join(", ");
      const query  = `UPDATE "${t}" SET ${setSQL} WHERE id = ${sqlVal(id)} RETURNING *`;
      const rows   = await sql([query]);
      if (!rows.length) return res.status(404).json({ error: "Not found" });
      return res.json({ data: rows[0], error: null });
    }

    // ── DELETE ─────────────────────────────────────────────────
    if (req.method === "DELETE") {
      if (!id) return res.status(400).json({ error: "id required" });
      const query = `DELETE FROM "${t}" WHERE id = ${sqlVal(id)}`;
      await sql([query]);
      return res.json({ data: null, error: null });
    }

    return res.status(405).json({ error: "Method not allowed" });

  } catch (e) {
    console.error("[db]", req.method, t, e.message);
    return res.status(500).json({ error: e.message });
  }
};
