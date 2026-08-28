import crypto from 'node:crypto';
import mysql from 'mysql2/promise';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: '请求方法不允许' });
  const authorization = req.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : req.headers.cookie?.match(/(?:^|;\s*)tappyread_session=([^;]+)/)?.[1];
  if (token) {
    const pool = mysql.createPool({ host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE || 'tappyread', connectionLimit: 2, ssl: { rejectUnauthorized: false } });
    await pool.execute('DELETE FROM sessions WHERE token_hash = ?', [crypto.createHash('sha256').update(token).digest('hex')]);
    await pool.end();
  }
  res.setHeader('Set-Cookie', 'tappyread_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
}
