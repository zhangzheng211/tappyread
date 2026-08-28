import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import mysql from 'mysql2/promise';
import { fileURLToPath } from 'node:url';

const app = express();
const port = Number(process.env.PORT || 3000);
const sessionDays = Number(process.env.SESSION_DAYS || 7);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const poolConfig = {
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE || 'tappyread',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4'
};
const caPath = process.env.MYSQL_SSL_CA || '/etc/ssl/cert.pem';
if (fs.existsSync(caPath)) poolConfig.ssl = { ca: fs.readFileSync(caPath) };
const pool = mysql.createPool(poolConfig);

app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());
app.use(express.static(rootDir, { index: 'index.html' }));

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sendDatabaseError(res, error) {
  console.error(error);
  return res.status(500).json({ error: '数据库操作失败，请检查云数据库配置' });
}

async function authenticate(req, res, next) {
  try {
    const authorization = req.get('authorization') || '';
    const token = authorization.startsWith('Bearer ')
      ? authorization.slice(7)
      : req.cookies.tappyread_session;
    if (!token) return res.status(401).json({ error: '未登录' });
    const [rows] = await pool.execute(
      `SELECT u.id, u.username FROM sessions s
       INNER JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > NOW()`,
      [hashToken(token)]
    );
    if (!rows.length) return res.status(401).json({ error: '登录已过期，请重新登录' });
    req.user = rows[0];
    req.sessionToken = token;
    next();
  } catch (error) {
    sendDatabaseError(res, error);
  }
}

async function issueSession(userId, res) {
  const token = createToken();
  const expiresAt = new Date(Date.now() + sessionDays * 86400000);
  await pool.execute(
    'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
    [hashToken(token), userId, expiresAt]
  );
  res.cookie('tappyread_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: sessionDays * 86400000
  });
  return token;
}

app.post('/api/auth/login', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const [rows] = await pool.execute(
      'SELECT id, username FROM users WHERE username = ? AND password = ? LIMIT 1',
      [username, password]
    );
    if (!rows.length) return res.status(401).json({ error: '用户名或密码错误，请重试' });
    const token = await issueSession(rows[0].id, res);
    res.json({ token, username: rows[0].username });
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
    const [result] = await pool.execute(
      'INSERT INTO users (username, password) VALUES (?, ?)',
      [username, password]
    );
    const token = await issueSession(result.insertId, res);
    res.status(201).json({ token, username });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '用户名已存在' });
    sendDatabaseError(res, error);
  }
});

app.post('/api/auth/logout', authenticate, async (req, res) => {
  try {
    await pool.execute('DELETE FROM sessions WHERE token_hash = ?', [hashToken(req.sessionToken)]);
    res.clearCookie('tappyread_session');
    res.json({ ok: true });
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.get('/api/library', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT library_json, collapsed_json, selected_folder_id, current_story_id FROM user_libraries WHERE user_id = ?',
      [req.user.id]
    );
    if (!rows.length) return res.json({ tree: [], collapsed: [], selectedFolderId: null, currentStoryId: null });
    const row = rows[0];
    res.json({
      tree: typeof row.library_json === 'string' ? JSON.parse(row.library_json) : row.library_json,
      collapsed: typeof row.collapsed_json === 'string' ? JSON.parse(row.collapsed_json) : row.collapsed_json,
      selectedFolderId: row.selected_folder_id,
      currentStoryId: row.current_story_id
    });
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.put('/api/library', authenticate, async (req, res) => {
  try {
    const { tree, collapsed } = req.body;
    if (!Array.isArray(tree) || !Array.isArray(collapsed)) return res.status(400).json({ error: '目录数据格式错误' });
    await pool.execute(
      `INSERT INTO user_libraries (user_id, library_json, collapsed_json, selected_folder_id, current_story_id)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE library_json = VALUES(library_json), collapsed_json = VALUES(collapsed_json),
       selected_folder_id = VALUES(selected_folder_id), current_story_id = VALUES(current_story_id)`,
      [req.user.id, JSON.stringify(tree), JSON.stringify(collapsed), req.body.selectedFolderId || null, req.body.currentStoryId || null]
    );
    res.json({ ok: true });
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.listen(port, () => console.log(`TappyRead server listening on http://localhost:${port}`));