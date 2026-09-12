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
      connectTimeout: 5000,
      enableKeepAlive: true,
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

/* =====================================================================
   登录日志（loginlog）：记录注册 / 登录行为，字段包括用户名、操作时间、
   在线时长、IP 归属地（省市）。与 server/server.js 中的实现保持一致，
   供 Vercel 版 api/auth/register.js、api/auth/login.js、api/auth/logout.js
   共用，避免三处各写一份。
   ===================================================================== */
let loginLogTableReady = false;
export async function ensureLoginLogTable() {
  if (loginLogTableReady) return;
  await getPool().execute(`
    CREATE TABLE IF NOT EXISTS loginlog (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(64) NOT NULL COMMENT '用户名',
      action VARCHAR(20) NOT NULL COMMENT '行为类型：register 注册 / login 登录',
      action_time DATETIME NOT NULL COMMENT '操作时间',
      duration_seconds INT UNSIGNED NULL COMMENT '本次登录在线时长（秒），退出登录时回填',
      ip VARCHAR(64) NULL COMMENT '客户端 IP',
      ip_region VARCHAR(100) NULL COMMENT 'IP 归属地（省市）',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_username (username),
      KEY idx_action_time (action_time)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  loginLogTableReady = true;
}

/** 取客户端真实 IP（优先取反向代理传入的 X-Forwarded-For 第一个地址） */
export function getClientIp(req) {
  const xff = req.headers?.['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || req.connection?.remoteAddress || '';
}

/** IP → 省市归属地。使用 ip-api.com 免费查询接口，2 秒超时，查询失败不影响主流程 */
export async function lookupIpRegion(ip) {
  if (!ip) return null;
  const bare = ip.replace(/^::ffff:/, '');
  if (bare === '127.0.0.1' || bare === '::1' || bare.startsWith('192.168.') || bare.startsWith('10.') || bare.startsWith('172.')) {
    return '本地/内网';
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const resp = await fetch(`http://ip-api.com/json/${encodeURIComponent(bare)}?lang=zh-CN&fields=status,regionName,city`, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.status !== 'success') return null;
    return [data.regionName, data.city].filter(Boolean).join(' ') || null;
  } catch (error) {
    return null;
  }
}

/** 写入一条登录日志（注册/登录），失败只打日志、不影响注册或登录本身 */
export async function writeLoginLog(username, action, req) {
  try {
    await ensureLoginLogTable();
    const ip = getClientIp(req);
    const ipRegion = await lookupIpRegion(ip);
    await getPool().execute(
      'INSERT INTO loginlog (username, action, action_time, ip, ip_region) VALUES (?, ?, NOW(), ?, ?)',
      [username, action, ip || null, ipRegion || null]
    );
  } catch (error) {
    console.warn('写入登录日志失败（不影响注册/登录）:', error.message);
  }
}

/** 退出登录时，把这次会话的在线时长回填到最近一条未回填的日志记录里 */
export async function fillLoginLogDuration(username) {
  try {
    await ensureLoginLogTable();
    await getPool().execute(
      `UPDATE loginlog
       SET duration_seconds = TIMESTAMPDIFF(SECOND, action_time, NOW())
       WHERE username = ? AND duration_seconds IS NULL
       ORDER BY action_time DESC LIMIT 1`,
      [username]
    );
  } catch (error) {
    console.warn('回填登录日志在线时长失败（不影响退出登录）:', error.message);
  }
}
