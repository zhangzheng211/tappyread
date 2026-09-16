import crypto from 'node:crypto';

import { authenticate } from './_mysql.js';

/* =====================================================================
   腾讯云语音合成（TTS）代理接口
   ---------------------------------------------------------------------
   - 前端永远不接触 SecretId / SecretKey，密钥只保存在 Vercel 环境变量中
   - 默认英语男声（WeJack, VoiceType=1050），可通过环境变量覆盖
   - 可选：命中/写入腾讯云 COS 音频缓存，减少重复合成、加快重复播放

   性能说明（对应"部署到 Vercel 后首次朗读较慢"问题）：
   1. Serverless 冷启动：本文件包含的依赖越多，冷启动越慢，因此 COS SDK
      改为按需动态 import，未开启缓存或缓存未命中时完全不加载该模块。
   2. 数据库鉴权：authenticate() 需要建立/复用到 MySQL(TiDB) 的连接，
      冷启动时的首次连接（尤其数据库与 Vercel 部署区域跨地域时）可能耗时
      较长；前端已配合新增"预热"请求（{warmup:true}），会在页面打开时提前
      触发一次鉴权+容器初始化，让真正点读时不必等待冷启动。
   3. COS 缓存查询增加了 600ms 超时保护，避免缓存查询变慢时拖累整体响应。
   可通过环境变量 TTS_DEBUG_TIMING=1 在服务端日志中输出各阶段耗时，便于
   进一步排查具体是哪个环节慢。
   ===================================================================== */

const TTS_HOST = 'tts.tencentcloudapi.com';
const TTS_SERVICE = 'tts';
const TTS_VERSION = '2019-08-23';
const TTS_ACTION = 'TextToVoice';
const TTS_REGION = process.env.TENCENT_TTS_REGION || 'ap-guangzhou';
// 默认 1050 = WeJack，腾讯云标准音色英语男声，账号无需额外开通即可使用。
// 如已开通精品/大模型音色，可在环境变量中改为 101050(WeJack 精品) 或 501008(WeJames 大模型) 等。
const TTS_VOICE_TYPE = Number(process.env.TENCENT_TTS_VOICE_TYPE || 1050);
const TTS_MAX_CHARS = 500; // 腾讯云英文单次请求最大约 500 个字母，前端已按句切分，这里再兜底一次

// COS 音频缓存（可选）：复用现有 COS 配置，未配置则自动跳过缓存，不影响主流程
const COS_BUCKET = process.env.COS_BUCKET || 'tappyreadjpeg-1325106148';
const COS_REGION = process.env.COS_REGION || 'ap-guangzhou';
const TTS_CACHE_DIR = (process.env.TENCENT_TTS_CACHE_DIR || 'audio').replace(/\/+$/, '');
const TTS_CACHE_ENABLED = Boolean(process.env.COS_SECRET_ID && process.env.COS_SECRET_KEY) && process.env.TENCENT_TTS_CACHE !== '0';
const TTS_CACHE_LOOKUP_TIMEOUT_MS = 600; // 缓存查询超时保护，避免拖慢整体响应
const DEBUG_TIMING = process.env.TTS_DEBUG_TIMING === '1';

let cosClientPromise = null;
// 懒加载：只有真正需要读/写缓存时才会 import COS SDK，减少非缓存场景下的冷启动体积
function getCosClient() {
  if (!TTS_CACHE_ENABLED) return Promise.resolve(null);
  if (!cosClientPromise) {
    cosClientPromise = import('cos-nodejs-sdk-v5').then(({ default: COS }) => {
      return new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY, Timeout: 4000 });
    });
  }
  return cosClientPromise;
}

function withTimeout(promise, ms, fallbackValue) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallbackValue), ms))
  ]);
}

function sendJson(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify(body));
}

function sha256hex(message) {
  return crypto.createHash('sha256').update(message, 'utf8').digest('hex');
}
function hmac(key, msg) {
  return crypto.createHmac('sha256', key).update(msg, 'utf8').digest();
}

/** 生成 TC3-HMAC-SHA256 签名（腾讯云 API 3.0 通用签名方法） */
function buildAuthorization({ secretId, secretKey, payload, timestamp }) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const contentType = 'application/json; charset=utf-8';
  const canonicalHeaders = `content-type:${contentType}\nhost:${TTS_HOST}\nx-tc-action:${TTS_ACTION.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256hex(payload)].join('\n');

  const credentialScope = `${date}/${TTS_SERVICE}/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', timestamp, credentialScope, sha256hex(canonicalRequest)].join('\n');

  const secretDate = hmac('TC3' + secretKey, date);
  const secretService = hmac(secretDate, TTS_SERVICE);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = hmac(secretSigning, stringToSign).toString('hex');

  return `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

// 极简内存限速：同一用户 1 秒内最多 6 次请求，防止异常重复点击刷爆腾讯云账单
const rateBucket = new Map();
function tooFrequent(key, limit = 6, windowMs = 1000) {
  const now = Date.now();
  const arr = (rateBucket.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now);
  rateBucket.set(key, arr);
  return arr.length > limit;
}

function cacheKeyFor(text, voiceType, speed) {
  const hash = crypto.createHash('sha1').update(`${voiceType}|${speed.toFixed(2)}|${text}`).digest('hex');
  return `${TTS_CACHE_DIR}/${hash}.mp3`;
}

async function cosGetObject(Key) {
  const cosClient = await getCosClient();
  if (!cosClient) return null;
  const lookup = new Promise(resolve => {
    cosClient.getObject({ Bucket: COS_BUCKET, Region: COS_REGION, Key }, (err, data) => {
      if (err || !data?.Body) return resolve(null);
      resolve(Buffer.isBuffer(data.Body) ? data.Body : Buffer.from(data.Body));
    });
  });
  // 缓存查询设置超时兜底：查询变慢时直接当作未命中处理，改走腾讯云实时合成，
  // 避免"缓存本该更快"反而拖慢了整体响应时间
  return withTimeout(lookup, TTS_CACHE_LOOKUP_TIMEOUT_MS, null);
}

async function cosPutObject(Key, Body) {
  const cosClient = await getCosClient();
  if (!cosClient) return false;
  return new Promise(resolve => {
    cosClient.putObject({ Bucket: COS_BUCKET, Region: COS_REGION, Key, Body, ContentType: 'audio/mpeg' }, err => {
      resolve(!err);
    });
  });
}

/** 调用腾讯云 TextToVoice，返回 base64 音频字符串 */
async function synthesizeWithTencent({ secretId, secretKey, text, speed }) {
  const sessionId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const payload = JSON.stringify({
    Text: text,
    SessionId: sessionId,
    Volume: 0,
    Speed: Number(speed.toFixed(2)),
    ProjectId: 0,
    ModelType: 1,
    VoiceType: TTS_VOICE_TYPE,
    Codec: 'mp3',
    SampleRate: 16000
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const authorization = buildAuthorization({ secretId, secretKey, payload, timestamp });

  const tcResp = await fetch(`https://${TTS_HOST}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-TC-Action': TTS_ACTION,
      'X-TC-Version': TTS_VERSION,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Region': TTS_REGION,
      Authorization: authorization
    },
    body: payload
  });

  const data = await tcResp.json().catch(() => null);
  if (!data) throw new Error('腾讯云返回内容解析失败');
  if (data.Response?.Error) {
    const err = new Error(data.Response.Error.Message || '腾讯云语音合成失败');
    err.code = data.Response.Error.Code;
    throw err;
  }
  if (!data.Response?.Audio) throw new Error('腾讯云语音合成未返回音频数据');
  return data.Response.Audio;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: '请求方法不允许' });

  const secretId = process.env.TENCENT_TTS_SECRET_ID;
  const secretKey = process.env.TENCENT_TTS_SECRET_KEY;
  if (!secretId || !secretKey) {
    return sendJson(res, 503, {
      error: '腾讯云 TTS 未配置：请在 Vercel 项目的 Environment Variables 中填写 TENCENT_TTS_SECRET_ID 与 TENCENT_TTS_SECRET_KEY（以及可选的 TENCENT_TTS_APP_ID），然后重新部署（Redeploy）'
    });
  }

  const t0 = Date.now();
  try {
    const user = await authenticate(req);
    if (DEBUG_TIMING) console.log(`[tts] authenticate 耗时 ${Date.now() - t0}ms`);
    if (!user) return sendJson(res, 401, { error: '未登录或登录已过期' });

    // 预热请求：只走鉴权 + 建立数据库连接，不调用腾讯云，用于页面打开时提前
    // "叫醒"这个函数所在的容器，避免用户第一次点读时才承受冷启动耗时。
    if (req.body?.warmup) {
      return sendJson(res, 200, { warmed: true });
    }

    if (tooFrequent(`u${user.id}`)) {
      return sendJson(res, 429, { error: '请求过于频繁，请稍候再试' });
    }

    const text = String(req.body?.text ?? '').trim();
    if (!text) return sendJson(res, 400, { error: '缺少 text 参数' });
    if (text.length > TTS_MAX_CHARS) {
      return sendJson(res, 400, { error: `文本过长，单次朗读最多支持 ${TTS_MAX_CHARS} 个字符，请分段传入` });
    }

    // 前端语速沿用浏览器 speechSynthesis 的 rate（约 0.6~1.1，1.0 为正常语速），
    // 等比换算成腾讯云 Speed 参数（范围 [-2, 6]，每 0.2 倍速对应 1 档）
    const rateInput = Number(req.body?.rate);
    const rate = Number.isFinite(rateInput) && rateInput > 0 ? rateInput : 1;
    const speed = Math.max(-2, Math.min(6, (rate - 1) / 0.2));

    const cacheKey = cacheKeyFor(text, TTS_VOICE_TYPE, speed);
    if (TTS_CACHE_ENABLED) {
      const tCache = Date.now();
      const cached = await cosGetObject(cacheKey);
      if (DEBUG_TIMING) console.log(`[tts] COS 缓存查询耗时 ${Date.now() - tCache}ms，命中=${!!cached}`);
      if (cached) {
        if (DEBUG_TIMING) console.log(`[tts] 总耗时 ${Date.now() - t0}ms（缓存命中）`);
        return sendJson(res, 200, { audio: `data:audio/mp3;base64,${cached.toString('base64')}`, cached: true });
      }
    }

    const tTencent = Date.now();
    const audioBase64 = await synthesizeWithTencent({ secretId, secretKey, text, speed });
    if (DEBUG_TIMING) console.log(`[tts] 腾讯云合成耗时 ${Date.now() - tTencent}ms`);

    if (TTS_CACHE_ENABLED) {
      // 缓存写入不阻塞响应，失败也不影响本次播放
      cosPutObject(cacheKey, Buffer.from(audioBase64, 'base64')).catch(() => {});
    }

    if (DEBUG_TIMING) console.log(`[tts] 总耗时 ${Date.now() - t0}ms`);
    return sendJson(res, 200, { audio: `data:audio/mp3;base64,${audioBase64}` });
  } catch (error) {
    console.error('Vercel tts error:', error);
    return sendJson(res, 502, { error: error.message || '腾讯云语音合成服务暂时不可用' });
  }
}
