import express from "express";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import pkg from "pg";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import { OAuth2Client } from "google-auth-library";

dotenv.config();
const { Pool } = pkg;

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || "please-change-this-secret";
const JWT_EXPIRES = "7d";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));

/* ---------------------- DB bootstrap ---------------------- */
async function ensureSchema() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

  // Create tables (first run) with the full modern shape
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE,
      password_hash TEXT,
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

  // Migrate older installs that had users without email/password_hash/default id
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;`);
  await pool.query(`ALTER TABLE users ALTER COLUMN id SET DEFAULT gen_random_uuid();`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email);`);
}


/* ---------------------- helpers ---------------------- */
async function findUserByEmail(email) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE email = $1 LIMIT 1`, [email]);
  return rows[0];
}
async function findUserById(id) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1 LIMIT 1`, [id]);
  return rows[0];
}
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}
function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}
async function ensureUserStats(userId) {
  await pool.query(
    `INSERT INTO user_stats(user_id, clicks) VALUES ($1, 0) ON CONFLICT DO NOTHING;`,
    [userId]
  );
}

/* ---------------------- AUTH: email/password ---------------------- */
app.post("/api/signup", async (req, res) => {
  try {
    const { email, password, display_name } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email and password required." });

    const exists = await findUserByEmail(email.toLowerCase());
    if (exists) return res.status(400).json({ error: "Email already in use." });

    const hash = await bcrypt.hash(password, 12);
    const ins = await pool.query(
      `INSERT INTO users(email, password_hash, display_name)
       VALUES ($1, $2, LEFT($3,40))
       RETURNING id, email, display_name;`,
      [email.toLowerCase(), hash, display_name || null]
    );
    const user = ins.rows[0];
    await ensureUserStats(user.id);

    const token = signToken({ userId: user.id });
    res.cookie("token", token, { httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ ok: true, user });
  } catch (e) {
    console.error("signup error:", e);
    res.status(500).json({ error: "Signup failed." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email and password required." });

    const user = await findUserByEmail(email.toLowerCase());
    if (!user) return res.status(400).json({ error: "Invalid credentials." });

    const ok = await bcrypt.compare(password, user.password_hash || "");
    if (!ok) return res.status(400).json({ error: "Invalid credentials." });

    await ensureUserStats(user.id);
    const token = signToken({ userId: user.id });
    res.cookie("token", token, { httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ ok: true, user: { id: user.id, email: user.email, display_name: user.display_name } });
  } catch (e) {
    console.error("login error:", e);
    res.status(500).json({ error: "Login failed." });
  }
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

app.get("/api/me", async (req, res) => {
  try {
    const token = req.cookies?.token;
    if (!token) return res.json({ user: null });
    const decoded = verifyToken(token);
    if (!decoded?.userId) return res.json({ user: null });
    const user = await findUserById(decoded.userId);
    if (!user) return res.json({ user: null });
    res.json({ user: { id: user.id, email: user.email, display_name: user.display_name } });
  } catch (e) {
    console.error("me error:", e);
    res.json({ user: null });
  }
});

/* ---------------------- AUTH: Google OAuth (ID token) ---------------------- */
app.post("/api/oauth/google", async (req, res) => {
  try {
    const { id_token } = req.body || {};
    if (!id_token || !GOOGLE_CLIENT_ID) return res.status(400).json({ error: "OAuth not configured." });

    const ticket = await googleClient.verifyIdToken({
      idToken: id_token,
      audience: GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();
    const email = (payload?.email || "").toLowerCase();
    const name = payload?.name || null;

    if (!email) return res.status(400).json({ error: "No email in token." });

    let user = await findUserByEmail(email);
    if (!user) {
      const ins = await pool.query(
        `INSERT INTO users(email, password_hash, display_name)
         VALUES ($1, NULL, LEFT($2,40))
         RETURNING id, email, display_name;`,
        [email, name]
      );
      user = ins.rows[0];
    } else if (!user.display_name && name) {
      await pool.query(`UPDATE users SET display_name = LEFT($2,40) WHERE id = $1;`, [user.id, name]);
      user.display_name = name.slice(0, 40);
    }

    await ensureUserStats(user.id);
    const token = signToken({ userId: user.id });
    res.cookie("token", token, { httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ ok: true, user });
  } catch (e) {
    console.error("oauth error:", e);
    res.status(500).json({ error: "OAuth failed." });
  }
});

/* ---------------------- Clicker logic (unchanged DB shape) ---------------------- */
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
  const total = Number(totalRes.rows[0]?.total ?? 0n);
  let mine = 0;
  if (userId) {
    const mineRes = await pool.query(`SELECT clicks::bigint AS clicks FROM user_stats WHERE user_id = $1;`, [userId]);
    mine = Number(mineRes.rows[0]?.clicks ?? 0n);
  }
  const top = await getTop(10);
  return { total, mine, top };
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
const rateBuckets = new Map();
function allowPress(socketId) {
  const now = Date.now();
  const bucket = rateBuckets.get(socketId) || { count: 0, ts: now };
  if (now - bucket.ts >= 1000) { bucket.count = 0; bucket.ts = now; }
  bucket.count += 1;
  rateBuckets.set(socketId, bucket);
  return bucket.count <= 10;
}

io.on("connection", (socket) => {
  let authedUserId = null;

  // Read cookie at handshake; if token valid, we have a user. No auth means no presses.
  try {
    const cookieHeader = socket.request.headers.cookie;
    if (cookieHeader) {
      const cookies = Object.fromEntries(cookieHeader.split(";").map(s => {
        const [k, ...v] = s.split("=");
        return [k.trim(), decodeURIComponent(v.join("="))];
      }));
      const token = cookies.token;
      const decoded = token ? verifyToken(token) : null;
      if (decoded?.userId) authedUserId = decoded.userId;
    }
  } catch {}

  socket.on("hello", async () => {
    try {
      const snapshot = await getTotals(authedUserId);
      socket.emit("stats", snapshot);
      if (!authedUserId) socket.emit("error_msg", "Log in to press.");
    } catch (err) {
      console.error("hello error:", err);
      socket.emit("error_msg", "Failed to initialize.");
    }
  });

  socket.on("set_name", async (name) => {
    if (!authedUserId) return;
    try {
      await pool.query(`UPDATE users SET display_name = LEFT($2,40) WHERE id = $1;`, [authedUserId, String(name || "").trim()]);
      const snapshot = await getTotals(authedUserId);
      io.emit("stats", snapshot);
    } catch (err) {
      console.error("set_name error:", err);
      socket.emit("error_msg", "Failed to set name.");
    }
  });

  socket.on("press", async () => {
    if (!authedUserId) {
      socket.emit("error_msg", "Log in to press.");
      return;
    }
    if (!allowPress(socket.id)) {
      socket.emit("error_msg", "Too fast. Chill.");
      return;
    }
    try {
      const { total, mine } = await pressOnce(authedUserId);
      const top = await getTop(10);
      io.emit("stats", { total, mine: undefined, top });
      socket.emit("you", { mine });
    } catch (err) {
      console.error("press error:", err);
      socket.emit("error_msg", "Something broke while pressing. Try again.");
    }
  });
});

/* ---------------------- Startup ---------------------- */
ensureSchema()
  .then(() => httpServer.listen(PORT, () => console.log(`Listening on :${PORT}`)))
  .catch((e) => { console.error("Failed to init schema:", e); process.exit(1); });
