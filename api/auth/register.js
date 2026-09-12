import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import { writeLoginLog } from '../_mysql.js';

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

/* =====================================================================
   新用户默认绘本目录不在注册接口里初始化。
   注册接口只负责 DB + Session，默认 start.json 由前端登录后直接从 COS
   读取并异步保存到 json/{username}.json，避免 Vercel Serverless 等待
   COS 跨区域网络请求而导致注册请求超时。
   ===================================================================== */

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: '请求方法不允许' });
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username || !password) return sendJson(res, 400, { error: '用户名和密码不能为空' });

    // 🔧 修复：注册前先显式校验用户名是否已存在，而不是仅仅依赖数据库唯一索引
    // 抛出的 ER_DUP_ENTRY 错误——如果 users 表当初建表时没有对 username 加
    // UNIQUE 约束，重复用户名会被直接插入成功，校验形同虚设。
    const [existing] = await getPool().execute('SELECT id FROM users WHERE username = ? LIMIT 1', [username]);
    if (existing.length) return sendJson(res, 409, { error: '用户名已存在，请修改后重试!' });

    const passwordHash = await bcrypt.hash(password, 12);
    const [result] = await getPool().execute('INSERT INTO users (username, password) VALUES (?, ?)', [username, passwordHash]);
    const token = crypto.randomBytes(32).toString('hex');
    const days = Number(process.env.SESSION_DAYS || 7);
    await getPool().execute('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [hashToken(token), result.insertId, new Date(Date.now() + days * 86400000)]);
    res.setHeader('Set-Cookie', `tappyread_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}`);

    // 注册成功立即返回：COS 默认绘本初始化改由前端直连 COS 完成；
    // 登录日志继续后台写入，绝不阻塞注册响应。
    writeLoginLog(username, 'register', req);

    return sendJson(res, 201, { token, username, userId: result.insertId });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return sendJson(res, 409, { error: '用户名已存在，请修改后重试!' });
    console.error('Vercel register error:', error);
    return sendJson(res, 500, { error: '注册服务暂时不可用，请检查云数据库配置' });
  }
}
