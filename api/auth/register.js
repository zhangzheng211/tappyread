import crypto from 'node:crypto';
import mysql from 'mysql2/promise';

let pool;
function getPool() {
  if (!pool) pool = mysql.createPool({
    host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE || 'tappyread', connectionLimit: 5,
    charset: 'utf8mb4', ssl: { rejectUnauthorized: false }
  });
  return pool;
}
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function sendJson(res, status, body) { res.status(status).json(body); }

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: '请求方法不允许' });
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username || !password) return sendJson(res, 400, { error: '用户名和密码不能为空' });
    const [result] = await getPool().execute('INSERT INTO users (username, password) VALUES (?, ?)', [username, password]);
    const token = crypto.randomBytes(32).toString('hex');
    const days = Number(process.env.SESSION_DAYS || 7);
    await getPool().execute('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [hashToken(token), result.insertId, new Date(Date.now() + days * 86400000)]);
    res.setHeader('Set-Cookie', `tappyread_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}`);
    return sendJson(res, 201, { token, username });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return sendJson(res, 409, { error: '用户名已存在' });
    console.error('Vercel register error:', error);
    return sendJson(res, 500, { error: '注册服务暂时不可用，请检查云数据库配置' });
  }
}
