const { Pool } = require('pg');

const pool = new Pool({
    // Ganti dengan URI Session Pooler dari Supabase (Project Settings -> Database -> Connection String -> Session pooler)
    connectionString: 'postgresql://postgres.welaqxdegjvdxukjtmru:Tajamaaftam21@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres',
    ssl: { rejectUnauthorized: false }
});

/**
 * Wrapper agar sintaks db.query('... ?', [params]) tetap kompatibel
 * sekaligus mengembalikan info affectedRows untuk UPDATE/DELETE di WhatsApp bot.
 */
async function query(sql, params = []) {
    let index = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++index}`);
    const res = await pool.query(pgSql, params);
    res.rows.affectedRows = res.rowCount;
    return [res.rows, res];
}

module.exports = { query, pool };