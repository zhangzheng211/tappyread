import crypto from 'node:crypto';
import mysql from 'mysql2/promise';

let pool;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST,
      port: Number(process.env.MYSQL_PORT || 3306),
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE || 'tappyread',
      waitForConnections: true,
      connectionLimit: 5,
      charset: 'utf8mb4',
      ssl: { rejectUnauthorized: false }
    });
  }
  return pool;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function sendJson(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: '请求方法不允许' });
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const [rows] = await getPool().execute(
      'SELECT id, username FROM users WHERE username = ? AND password = ? LIMIT 1',
      [username, password]
    );
    if (!rows.length) return sendJson(res, 401, { error: '用户名或密码错误，请重试' });

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + Number(process.env.SESSION_DAYS || 7) * 86400000);
    await getPool().execute(
      'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
      [hashToken(token), rows[0].id, expiresAt]
    );
    res.setHeader('Set-Cookie', `tappyread_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Number(process.env.SESSION_DAYS || 7) * 86400}`);
    sendJson(res, 200, { token, username: rows[0].username });
  } catch (error) {
    console.error('Vercel login error:', error);
    sendJson(res, 500, { error: '登录服务暂时不可用，请检查云数据库配置' });
  }
}
