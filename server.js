import express from "express";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import pkg from "pg";
import dotenv from "dotenv";

dotenv.config();
const { Pool } = pkg;

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false }
});

app.use(express.static("public"));

/* ---------------------- DB bootstrap ---------------------- */
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      display_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_stats (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      clicks BIGINT NOT NULL DEFAULT 0
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stats (
      key TEXT PRIMARY KEY,
      value BIGINT NOT NULL
    );
  `);

  await pool.query(`
    INSERT INTO stats(key, value)
    VALUES ('total_clicks', 0)
    ON CONFLICT (key) DO NOTHING;
  `);
}

async function ensureUser(userId, name) {
  // Create user if missing
  await pool.query(
    `INSERT INTO users(id, display_name) VALUES ($1, NULL) ON CONFLICT DO NOTHING;`,
    [userId]
  );

  // If a name was provided, update it
  if (name && name.trim().length) {
    await pool.query(
      `UPDATE users SET display_name = LEFT($2, 40) WHERE id = $1;`,
      [userId, name.trim()]
    );
  }

  // Ensure user_stats row
  await pool.query(
    `INSERT INTO user_stats(user_id, clicks) VALUES ($1, 0) ON CONFLICT DO NOTHING;`,
    [userId]
  );
}

async function getTop(limit = 10) {
  const { rows } = await pool.query(`
    SELECT
      COALESCE(NULLIF(u.display_name, ''), 'Anon-' || SUBSTRING(u.id::text, 1, 8)) AS name,
      s.clicks
    FROM user_stats s
    JOIN users u ON u.id = s.user_id
    ORDER BY s.clicks DESC, u.created_at ASC
    LIMIT $1;
  `, [limit]);
  return rows;
}

async function getTotals(userId) {
  const totalRes = await pool.query(`SELECT value::bigint AS total FROM stats WHERE key = 'total_clicks';`);
  const total = totalRes.rows[0]?.total ?? 0n;

  const mineRes = await pool.query(`SELECT clicks::bigint AS clicks FROM user_stats WHERE user_id = $1;`, [userId]);
  const mine = mineRes.rows[0]?.clicks ?? 0n;

  const top = await getTop(10);
  return { total: Number(total), mine: Number(mine), top };
}

async function pressOnce(userId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const totalRes = await client.query(`
      UPDATE stats SET value = value + 1
      WHERE key = 'total_clicks'
      RETURNING value::bigint AS total;
    `);
    const total = Number(totalRes.rows[0].total);

    const mineRes = await client.query(`
      INSERT INTO user_stats(user_id, clicks) VALUES ($1, 1)
      ON CONFLICT (user_id)
      DO UPDATE SET clicks = user_stats.clicks + 1
      RETURNING clicks::bigint AS clicks;
    `, [userId]);
    const mine = Number(mineRes.rows[0].clicks);

    await client.query("COMMIT");
    return { total, mine };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/* ---------------------- Socket.IO ---------------------- */

// simple anti-spam: max 10 presses/sec per socket
const rateBuckets = new Map(); // socket.id -> { count, ts }

function allowPress(socketId) {
  const now = Date.now();
  const bucket = rateBuckets.get(socketId) || { count: 0, ts: now };
  if (now - bucket.ts >= 1000) {
    bucket.count = 0;
    bucket.ts = now;
  }
  bucket.count += 1;
  rateBuckets.set(socketId, bucket);
  return bucket.count <= 10;
}

io.on("connection", (socket) => {
  let userId = null;

  socket.on("hello", async ({ userId: uid, name }) => {
    try {
      userId = uid;
      await ensureUser(userId, name);
      const snapshot = await getTotals(userId);
      socket.emit("stats", snapshot);
    } catch (err) {
      console.error("hello error:", err);
      socket.emit("error_msg", "Failed to initialize user.");
    }
  });

  socket.on("set_name", async (name) => {
    if (!userId) return;
    try {
      await ensureUser(userId, name);
      const snapshot = await getTotals(userId);
      // update everybody since names affect leaderboard
      io.emit("stats", snapshot);
    } catch (err) {
      console.error("set_name error:", err);
      socket.emit("error_msg", "Failed to set name.");
    }
  });

  socket.on("press", async () => {
    if (!userId) return;
    if (!allowPress(socket.id)) {
      socket.emit("error_msg", "Too fast. Chill.");
      return;
    }
    try {
      const { total, mine } = await pressOnce(userId);
      // Fetch top 10 occasionally; small optimization: every press is fine for simplicity
      const top = await getTop(10);
      io.emit("stats", { total, mine: undefined, top }); // global
      socket.emit("you", { mine }); // personal
    } catch (err) {
      console.error("press error:", err);
      socket.emit("error_msg", "Something broke while pressing. Try again.");
    }
  });
});

/* ---------------------- Startup ---------------------- */
ensureSchema()
  .then(() => {
    httpServer.listen(PORT, () => {
      console.log(`Listening on :${PORT}`);
    });
  })
  .catch((e) => {
    console.error("Failed to init schema:", e);
    process.exit(1);
  });
