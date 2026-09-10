import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import COS from 'cos-nodejs-sdk-v5';
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
   新注册用户默认绘本目录：从 COS 模板 jpeg/start.json 拉取一份默认绘本，
   写入这个新用户自己的 json/{username}.json，保证新用户登录后自带该绘本。
   ===================================================================== */
const COS_BUCKET = process.env.COS_BUCKET || 'tappyreadjpeg-1325106148';
const COS_REGION = process.env.COS_REGION || 'ap-guangzhou';
const COS_IMG_DIR = (process.env.COS_IMG_DIR || 'jpeg').replace(/\/+$/, '');
const COS_JSON_DIR = (process.env.COS_JSON_DIR || 'json').replace(/\/+$/, '');
const cosConfigured = Boolean(process.env.COS_SECRET_ID && process.env.COS_SECRET_KEY);
const cosClient = cosConfigured
  ? new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY })
  : null;

function sanitizeUsername(name) {
  return String(name || '').trim()
    .replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 40) || 'guest';
}

// 🔧 修复：之前这里用不带身份认证的公网 fetch() 直接请求 json/start.json，
// 而 json/ 目录跟 jpeg/ 不一样，项目里所有读取它的地方（比如 api/library.js
// 读用户绘本库）全部走的是带密钥认证的 cosClient.getObject，说明这个目录大概率
// 从没开过公有读权限——公网直接 fetch 大概率会被 COS 返回 403 拒绝访问，
// resp.ok 为 false，函数直接返回 null，表现为"注册成功但没有默认绘本"。
// 现在改成跟读用户绘本库完全一样的方式：用带密钥认证的 COS SDK 直接读，
// 不再依赖 json/ 目录的公有读设置，从根上排除这一类权限问题。
function fetchStartTemplate() {
  return new Promise((resolve) => {
    if (!cosConfigured) return resolve(null);
    const key = `${COS_JSON_DIR}/start.json`;
    const timer = setTimeout(() => resolve(null), 8000);
    cosClient.getObject({ Bucket: COS_BUCKET, Region: COS_REGION, Key: key }, (err, data) => {
      clearTimeout(timer);
      if (err) {
        console.warn('获取默认绘本模板 start.json 失败（不影响注册）:', err.message);
        return resolve(null);
      }
      try {
        const parsed = JSON.parse(data.Body.toString('utf8'));
        if (!parsed || !Array.isArray(parsed.tree)) return resolve(null);
        resolve(parsed);
      } catch (parseErr) {
        console.warn('默认绘本模板 start.json 内容不是合法JSON（不影响注册）:', parseErr.message);
        resolve(null);
      }
    });
  });
}

function putCosTextObject(key, text) {
  return new Promise((resolve, reject) => {
    cosClient.putObject({
      Bucket: COS_BUCKET,
      Region: COS_REGION,
      Key: key,
      Body: Buffer.from(text, 'utf8'),
      ContentType: 'application/json; charset=utf-8'
    }, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

async function initDefaultLibraryForNewUser(username) {
  if (!cosConfigured) return;
  try {
    const template = await fetchStartTemplate();
    if (!template) return;
    const safeUsername = sanitizeUsername(username).replace(/_+$/g, '') || 'guest';
    const canonicalKey = `${COS_JSON_DIR}/${safeUsername}.json`;
    const payload = {
      username,
      updatedAt: new Date().toISOString(),
      tree: template.tree,
      collapsed: Array.isArray(template.collapsed) ? template.collapsed : [],
      selectedFolderId: template.selectedFolderId || null,
      currentStoryId: template.currentStoryId || null
    };
    await putCosTextObject(canonicalKey, JSON.stringify(payload, null, 2));
  } catch (error) {
    console.warn('初始化新用户默认绘本目录失败（不影响注册）:', error.message);
  }
}

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

    // 新用户初始化默认绘本目录 + 写注册日志：都不阻塞响应，失败也不影响注册本身
    await Promise.all([
      initDefaultLibraryForNewUser(username),
      writeLoginLog(username, 'register', req)
    ]);

    return sendJson(res, 201, { token, username, userId: result.insertId });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return sendJson(res, 409, { error: '用户名已存在，请修改后重试!' });
    console.error('Vercel register error:', error);
    return sendJson(res, 500, { error: '注册服务暂时不可用，请检查云数据库配置' });
  }
}
