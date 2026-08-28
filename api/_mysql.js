import mysql from 'mysql2/promise';
import crypto from 'node:crypto';

let pool;

export function getPool() {
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

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function getToken(req) {
  const authorization = req.headers.authorization || '';
  if (authorization.startsWith('Bearer ')) return authorization.slice(7);
  const cookie = req.headers.cookie || '';
  return cookie.match(/(?:^|;\s*)tappyread_session=([^;]+)/)?.[1] || '';
}

export async function authenticate(req) {
  const token = getToken(req);
  if (!token) return null;
  const [rows] = await getPool().execute(
    `SELECT u.id, u.username FROM sessions s
     INNER JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > NOW()`,
    [hashToken(token)]
  );
  return rows[0] || null;
}
