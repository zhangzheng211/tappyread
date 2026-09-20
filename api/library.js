import { authenticate, getPool } from './_mysql.js';
import COS from 'cos-nodejs-sdk-v5';

const COS_BUCKET = process.env.COS_BUCKET || 'tappyreadjpeg-1325106148';

const COS_REGION = process.env.COS_REGION || 'ap-guangzhou';

const COS_JSON_DIR = (process.env.COS_JSON_DIR || 'json').replace(/\/+$/, '');

const COS_BASE_URL = `https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com/`;

const cosConfigured = Boolean(
  process.env.COS_SECRET_ID && process.env.COS_SECRET_KEY
);

// const cosClient = cosConfigured
//   ? new COS({
//       SecretId: process.env.COS_SECRET_ID,
//       SecretKey: process.env.COS_SECRET_KEY,

//       // Vercel 跨区域访问广州 COS 时，设置较短超时。
//       // 超时后快速失败，不让整个 /api/library 请求长时间阻塞。
//       Timeout: 4000
//     })
//   : null;
const cosClient = cosConfigured
  ? new COS({
      SecretId: process.env.COS_SECRET_ID,
      SecretKey: process.env.COS_SECRET_KEY,

      // 强制使用标准 COS 域名
      Domain: `${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com`,

      // Vercel跨区域访问增加超时时间
      Timeout: 10000
    })
  : null;
// //临时日志
//  console.log('COS CONFIG:', {
//   bucket: COS_BUCKET,
//   region: COS_REGION,
//   domain: `${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com`
// }); 

function sendJson(res, status, body) {
  res
    .status(status)
    .setHeader('Content-Type', 'application/json; charset=utf-8')
    .end(JSON.stringify(body));
}

function sanitizeUsername(name) {
  return String(name || '')
    .trim()
    .replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 40) || 'guest';
}

function getCanonicalLibraryFilename(username) {
  const safeUsername = sanitizeUsername(username).replace(/_+$/g, '');
  return `${safeUsername || 'guest'}.json`;
}

function getLibraryKeyCandidates(username) {
  const raw = String(username || '').trim();

  const variants = new Set();

  if (raw) {
    variants.add(raw);

    variants.add(
      raw
        .replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_')
        .replace(/_+/g, '_')
    );
  }

  const safeUsername = sanitizeUsername(username).replace(/_+$/g, '');

  if (safeUsername) {
    variants.add(safeUsername);
  }

  const directNames = Array.from(variants)
    .filter(Boolean)
    .map(
      item =>
        `${sanitizeUsername(item).replace(/_+$/g, '') || 'guest'}.json`
    );

  const legacyNames = [];

  for (const variant of variants) {
    const base =
      sanitizeUsername(variant).replace(/_+$/g, '') || 'guest';

    legacyNames.push(`${base}_绘本目录.json`);
  }

  return Array.from(
    new Set(
      [
        ...directNames,
        ...legacyNames,
        ...directNames.map(name => `${COS_JSON_DIR}/${name}`),
        ...legacyNames.map(name => `${COS_JSON_DIR}/${name}`)
      ]
        .filter(Boolean)
        .map(name =>
          `${COS_JSON_DIR}/${name}`.replace(/\/+/g, '/')
        )
    )
  );
}

function getLegacyLibraryKeysForUsername(username, keys = []) {
  const baseNames = new Set();

  const raw = String(username || '').trim();

  const sanitized =
    sanitizeUsername(username).replace(/_+$/g, '') || 'guest';

  baseNames.add(sanitized);

  if (raw) {
    baseNames.add(
      raw
        .replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/_+$/g, '') || 'guest'
    );
  }

  return (Array.isArray(keys) ? keys : []).filter(key => {
    const fileName = (key.split('/').pop() || '').replace(
      /\.json$/i,
      ''
    );

    return Array.from(baseNames).some(base => {
      const normalized = (base || 'guest').replace(/_+$/g, '');

      return (
        fileName === normalized ||
        fileName.startsWith(`${normalized}_绘本目录`)
      );
    });
  });
}

function listCosKeys(prefix) {
  return new Promise((resolve, reject) => {
    if (!cosClient) return resolve([]);

    cosClient.getBucket(
      {
        Bucket: COS_BUCKET,
        Region: COS_REGION,
        Prefix: prefix,
        MaxKeys: 1000
      },
      (err, data) => {
        if (err) {
          if (
            err.code === 'NoSuchBucket' ||
            err.code === 'NoSuchKey' ||
            err.statusCode === 404
          ) {
            return resolve([]);
          }

          return reject(err);
        }

        const contents = Array.isArray(data?.Contents)
          ? data.Contents
          : [];

        resolve(
          contents
            .map(item => item.Key)
            .filter(Boolean)
        );
      }
    );
  });
}

function readCosJsonFile(key) {
  if (!key || !cosClient) {
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    cosClient.getObject(
      {
        Bucket: COS_BUCKET,
        Region: COS_REGION,
        Key: key
      },
      (err, data) => {
        if (err) {
          if (
            err.code === 'NoSuchKey' ||
            err.statusCode === 404
          ) {
            return resolve(null);
          }

          // 🆕 关键修复（问题一：禁止超时回退 start.json）：ETIMEDOUT / 网络异常
          // 等"这次没读到"绝不能当成"文件不存在"处理——之前这里统一 resolve(null)，
          // 上层代码没法区分"新用户没有文件"和"老用户的文件这次读取失败了"，
          // 于是老用户一遇到 COS 超时就会被误判成新用户，被 start.json 模板覆盖、
          // 还会自动保存回云端，把真实数据永久顶掉。现在改成 reject，让调用方
          // 必须显式处理"读取失败"这种情况（重试 / 走缓存 / 报错），不能再静默
          // 当成"不存在"。
          console.warn('读取 COS 绘本目录异常:', key, err && (err.code || err.message || err));

          return reject(err);
        }

        try {
          const body =
            data && data.Body
              ? Buffer.from(data.Body)
              : Buffer.alloc(0);

          const text = body.toString('utf8');

          return resolve(
            text ? JSON.parse(text) : null
          );
        } catch (error) {
          console.warn('解析 COS 绘本目录失败:', key, error);

          // JSON 解析失败同理：这是"这次读取有问题"（文件可能正在被并发写入、
          // 或者内容损坏），不是"文件不存在"，也要抛出而不是当成空目录。
          return reject(error);
        }
      }
    );
  });
}

// 🆕 问题三：/api/library 读取增加重试机制。COS 偶发的网络抖动/超时通常在
// 短暂等待后重试就能成功，不需要立刻判定为失败。只有重试次数用尽仍然失败，
// 才会把错误继续向上抛出（由调用方决定是走本地缓存兜底还是直接报错，见下方
// GET 处理逻辑），全程不会把"重试后仍失败"当成"文件不存在"。
async function readCosJsonFileWithRetry(key, retries = 2, delayMs = 500) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await readCosJsonFile(key);
    } catch (error) {
      lastError = error;

      if (attempt < retries) {
        console.warn(
          `读取 COS 绘本目录失败，${delayMs * (attempt + 1)}ms 后重试（第 ${attempt + 1}/${retries} 次重试）:`,
          key
        );

        await new Promise(resolve => setTimeout(resolve, delayMs * (attempt + 1)));
      }
    }
  }

  throw lastError;
}

// 🆕 问题二：COS 绘本目录的本地（进程内存）缓存。Vercel 的同一个 Serverless
// 容器在短时间内会被复用处理多个请求，这个内存缓存能在容器存活期间，把"最近
// 一次成功读取/保存到的用户目录"留一份底，用于 COS 读取失败时的兜底：宁可给
// 用户看一份"可能不是最新"的真实数据，也绝不能给一份"完全无关"的 start.json
// 默认模板。
// 注意：这只是单个容器内的尽力而为缓存，不跨容器共享、冷启动后也会清空——
// 它不能替代"COS 里的数据才是唯一真相"这个前提，只是为了降低偶发网络问题对
// 用户体验的影响。
const libraryMemoryCache = new Map(); // safeUsername -> { snapshot, cachedAt }
const LIBRARY_CACHE_MAX_ENTRIES = 500; // 简单的容量上限，避免单个容器长期运行、服务很多不同用户时无限占用内存
const LIBRARY_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 缓存超过 6 小时视为太旧，不再作为兜底使用（正常情况下容器早就被回收了，这里只是双重保险）

function cacheLibrarySnapshot(safeUsername, snapshot) {
  if (!safeUsername || !snapshot) return;

  if (
    libraryMemoryCache.size >= LIBRARY_CACHE_MAX_ENTRIES &&
    !libraryMemoryCache.has(safeUsername)
  ) {
    const oldestKey = libraryMemoryCache.keys().next().value;
    if (oldestKey !== undefined) libraryMemoryCache.delete(oldestKey);
  }

  libraryMemoryCache.set(safeUsername, { snapshot, cachedAt: Date.now() });
}

function getCachedLibrarySnapshot(safeUsername) {
  const entry = libraryMemoryCache.get(safeUsername);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > LIBRARY_CACHE_MAX_AGE_MS) {
    libraryMemoryCache.delete(safeUsername);
    return null;
  }
  return entry;
}

async function getLatestLibraryFromCos(username) {
  if (!cosConfigured || !username) return null;

  const safeUsername =
    sanitizeUsername(username).replace(/_+$/g, '') || 'guest';

  const directKey = `${COS_JSON_DIR}/${safeUsername}.json`;

  // 快速路径（带重试）：
  // 绝大多数情况下，文件就在标准的
  // json/{username}.json。
  //
  // 直接 GET 一次（失败自动重试）即可，不需要先列 json/ 目录。
  // 🆕 这里不再 catch 吞掉异常：readCosJsonFileWithRetry 重试用尽后仍然失败，
  // 会把错误继续向上抛出给 GET 处理逻辑，由它决定走内存缓存兜底还是报错，
  // 绝不能在这里静默当成"文件不存在"。
  const direct = await readCosJsonFileWithRetry(directKey);

  if (direct) return direct;

  // direct === null：说明标准文件"确认不存在"（不是读取失败），才尝试兼容
  // 旧版文件名。这个 fallback 本身允许失败时静默返回 null——它只是一个
  // "万一有旧文件"的尽力而为兜底，不是判断"用户是否存在数据"的权威依据
  // （权威判断已经在上面 directKey 的读取里做完了）。
  try {
    const keys = await listCosKeys(`${COS_JSON_DIR}/`);

    const legacyMatches = keys.filter(key => {
      const fileName = key.split('/').pop() || '';

      const baseName = fileName.replace(
        /\.json$/i,
        ''
      );

      return (
        baseName === safeUsername ||
        baseName.startsWith(`${safeUsername}_绘本目录`)
      );
    });

    const preferred = legacyMatches[0] || null;

    if (!preferred) return null;

    return await readCosJsonFileWithRetry(preferred).catch(error => {
      console.warn('读取旧版命名的用户绘本目录失败（忽略，按不存在处理）:', preferred, error);
      return null;
    });
  } catch (error) {
    console.warn('获取最新用户绘本目录失败（旧版文件名兜底查找阶段，忽略）:', error);

    return null;
  }
}

async function getStartLibraryFromCos() {
  if (!cosConfigured) return null;

  const snapshot = await readCosJsonFileWithRetry(
    `${COS_JSON_DIR}/start.json`
  ).catch(error => {
    console.warn('读取 start.json 模板失败（重试后仍失败，返回空目录）:', error);
    return null;
  });

  return snapshot && Array.isArray(snapshot.tree)
    ? snapshot
    : null;
}

function sendCosConfigError(res) {
  return sendJson(res, 503, {
    error:
      'COS 未配置：请在 Vercel 项目的 Environment Variables 中填写 COS_SECRET_ID 与 COS_SECRET_KEY，然后重新部署（Redeploy）'
  });
}

function withTimeout(promise, ms, errorMessage) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(errorMessage || `操作超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function putCosTextObject(
  key,
  text,
  contentType = 'application/json; charset=utf-8'
) {
  return new Promise((resolve, reject) => {
    if (!cosClient) {
      return reject(new Error('COS 未配置'));
    }

    cosClient.putObject(
      {
        Bucket: COS_BUCKET,
        Region: COS_REGION,
        Key: key,
        Body: Buffer.from(text, 'utf8'),
        ContentType: contentType
      },
      (err, data) =>
        err ? reject(err) : resolve(data)
    );
  });
}

// 🆕 问题：PUT /api/library（前端直传 COS 失败后的后端中转兜底）偶发触发
// Vercel 的 FUNCTION_INVOCATION_TIMEOUT（504，30 秒硬超时）。根因是
// cosClient 的 Timeout 配置对"连接阶段就卡住"（如 ETIMEDOUT）这类异常
// 不一定生效——SDK 层面的 putObject 调用可能一直不回调，光靠 cosClient
// 自己的 Timeout 选项无法保证。这里用 Promise.race 在应用层强制加一道
// 兜底超时（8 秒），配合一次重试，确保最坏情况下（8s + 0.5s 等待 + 8s ≈
// 16.5s）也远低于 Vercel 30 秒的硬限制，会先得到一个明确的错误响应，
// 而不是被 Vercel 直接杀死连接、前端只能看到语焉不详的 504。
async function putCosTextObjectWithRetry(
  key,
  text,
  contentType = 'application/json; charset=utf-8',
  retries = 1,
  timeoutMs = 8000
) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await withTimeout(
        putCosTextObject(key, text, contentType),
        timeoutMs,
        'COS 写入超时'
      );
    } catch (error) {
      lastError = error;

      console.warn(
        `写入 COS 绘本目录失败（第 ${attempt + 1}/${retries + 1} 次尝试）:`,
        key,
        error && (error.code || error.message || error)
      );

      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }

  throw lastError;
}

function deleteCosObjects(keys) {
  return new Promise((resolve, reject) => {
    if (!cosClient || !keys.length) {
      return resolve(null);
    }

    cosClient.deleteMultipleObject(
      {
        Bucket: COS_BUCKET,
        Region: COS_REGION,
        Objects: keys.map(Key => ({ Key }))
      },
      (err, data) =>
        err ? reject(err) : resolve(data)
    );
  });
}

/**
 * 把当前用户的绘本目录写入：
 *
 *   json/{username}.json
 *
 * 重要：
 * 保存成功后不再执行 getBucket/listCosKeys。
 *
 * 以前这里保存完文件以后还会：
 *
 *   PUT json/{username}.json
 *        ↓
 *   GET json/
 *        ↓
 *   查找旧文件
 *        ↓
 *   DELETE 旧文件
 *
 * 这会导致 Vercel -> 广州 COS 的 GET 请求出现 ETIMEDOUT。
 *
 * 现在规范化保存后，只保留 canonical 文件，
 * 不在正常保存路径执行旧文件清理。
 */
async function syncLibraryToCos(username, snapshot) {
  if (!cosConfigured || !username) return null;

  const safeUsername =
    sanitizeUsername(username).replace(/_+$/g, '') || 'guest';

  const canonicalKey =
    `${COS_JSON_DIR}/${safeUsername}.json`;

  const payload = {
    username,
    updatedAt: new Date().toISOString(),
    tree: Array.isArray(snapshot?.tree)
      ? snapshot.tree
      : [],
    collapsed: Array.isArray(snapshot?.collapsed)
      ? snapshot.collapsed
      : [],
    selectedFolderId:
      snapshot?.selectedFolderId || null,
    currentStoryId:
      snapshot?.currentStoryId || null
  };

  // 正常保存只做一次 PUT（内部已带超时保护 + 1 次重试，见 putCosTextObjectWithRetry）。
  await putCosTextObjectWithRetry(
    canonicalKey,
    JSON.stringify(payload, null, 2),
    'application/json; charset=utf-8'
  );

  return {
    key: canonicalKey,
    url: COS_BASE_URL + canonicalKey
  };
}

export default async function handler(req, res) {
  try {
    const user = await authenticate(req);

    if (!user) {
      return sendJson(res, 401, {
        error: '未登录或登录已过期'
      });
    }

    if (req.method === 'GET') {
      if (!cosConfigured) {
        return sendJson(res, 200, {
          tree: [],
          collapsed: [],
          selectedFolderId: null,
          currentStoryId: null
        });
      }

      const safeUsername =
        sanitizeUsername(user.username).replace(/_+$/g, '') || 'guest';

      // 🆕 问题一（最严重，优先解决）：明确区分"这次读取失败了"（网络超时/
      // COS 异常等，reject）和"用户自己的目录文件确认不存在"（resolve null）。
      // 前者绝不能当成新用户处理，即使重试用尽仍然失败，也只会走内存缓存
      // 兜底或报错，不会再静默换成 start.json 默认模板去覆盖用户的真实数据。
      let snapshot = null;
      let readError = null;
      try {
        snapshot = await getLatestLibraryFromCos(user.username);
      } catch (error) {
        readError = error;
      }

      if (
        snapshot &&
        Array.isArray(snapshot.tree)
      ) {
        // 读取成功：顺手更新内存缓存，供下次读取失败时兜底使用。
        cacheLibrarySnapshot(safeUsername, snapshot);

        return sendJson(res, 200, {
          tree: snapshot.tree,

          collapsed: Array.isArray(snapshot.collapsed)
            ? snapshot.collapsed
            : [],

          selectedFolderId:
            snapshot.selectedFolderId || null,

          currentStoryId:
            snapshot.currentStoryId || null
        });
      }

      if (readError) {
        console.error(
          '读取用户绘本目录失败（多次重试后仍失败，不会当成新用户处理，尝试内存缓存兜底）:',
          user.username,
          readError && (readError.code || readError.message || readError)
        );

        // 问题二：优先用本地（进程内存）缓存里最近一次成功读取/保存的真实数据
        // 兜底，宁可给一份可能不是最新的真实数据，也绝不给 start.json 模板。
        const cached = getCachedLibrarySnapshot(safeUsername);
        if (cached) {
          return sendJson(res, 200, {
            tree: Array.isArray(cached.snapshot.tree) ? cached.snapshot.tree : [],
            collapsed: Array.isArray(cached.snapshot.collapsed) ? cached.snapshot.collapsed : [],
            selectedFolderId: cached.snapshot.selectedFolderId || null,
            currentStoryId: cached.snapshot.currentStoryId || null,
            stale: true,
            cachedAt: cached.cachedAt
          });
        }

        // 既没有读取成功，也没有可用的兜底缓存：如实报错，交给前端自己的
        // 本地缓存（IndexedDB）/重试逻辑处理，绝不能在这里默默换成
        // start.json——这正是本次要修复的问题。
        return sendJson(res, 503, {
          error: '绘本目录暂时无法读取，请稍后重试'
        });
      }

      // 走到这里说明 snapshot === null 且没有抛出异常：
      // 已经明确确认 json/{username}.json（及旧版命名文件）都不存在，
      // 这才是真正的新用户，可以安全地读取 start.json 作为初始目录。
      const startSnapshot =
        await getStartLibraryFromCos().catch(
          () => null
        );

      if (startSnapshot) {
        return sendJson(res, 200, {
          tree: startSnapshot.tree,

          collapsed: Array.isArray(
            startSnapshot.collapsed
          )
            ? startSnapshot.collapsed
            : [],

          selectedFolderId:
            startSnapshot.selectedFolderId || null,

          currentStoryId:
            startSnapshot.currentStoryId || null
        });
      }

      return sendJson(res, 200, {
        tree: [],
        collapsed: [],
        selectedFolderId: null,
        currentStoryId: null
      });
    }

    if (req.method === 'POST') {
      /**
       * 前端直传 COS 完成后的轻量收尾。
       *
       * V6 这里会调用 listCosKeys(json/)，
       * 在 Vercel -> COS 环境下可能产生：
       *
       *   ETIMEDOUT
       *   GET https://...cos.../
       *
       * 现在不再执行目录扫描和旧文件删除。
       *
       * 直传成功以后直接返回成功即可。
       */
      return sendJson(res, 200, {
        ok: true,
        cleaned: 0,
        note: '已跳过旧版目录清理，避免 COS 跨区域 GET 超时'
      });
    }

    if (req.method === 'PUT') {
      if (!cosConfigured) {
        return sendCosConfigError(res);
      }

      const {
        tree,
        collapsed
      } = req.body || {};

      if (
        !Array.isArray(tree) ||
        !Array.isArray(collapsed)
      ) {
        return sendJson(res, 400, {
          error: '目录数据格式错误'
        });
      }

      let result;
      try {
        result =
          await syncLibraryToCos(
            user.username,
            {
              tree,
              collapsed,
              selectedFolderId:
                req.body.selectedFolderId || null,
              currentStoryId:
                req.body.currentStoryId || null
            }
          );
      } catch (error) {
        // 🆕 syncLibraryToCos 内部的 COS 写入已经带了应用层超时（8s）+ 1 次重试，
        // 最坏情况下也会在 ~17s 左右明确失败，不会一直挂到 Vercel 30 秒硬超时
        // 才被杀掉、前端只看到语焉不详的 504。这里给出明确的错误信息。
        console.error(
          '同步用户绘本目录到 COS 失败（写入端已重试仍失败）:',
          user.username,
          error && (error.code || error.message || error)
        );
        return sendJson(res, 502, {
          error: '同步用户绘本目录到 COS 失败，请稍后重试'
        });
      }

      if (!result) {
        return sendJson(res, 500, {
          error: '同步用户绘本目录到 COS 失败'
        });
      }

      // 🆕 写入成功后同步更新内存缓存，保证同一容器内接下来的读取请求即使
      // 遇到 COS 抖动，也能兜底拿到这次刚保存的最新数据，而不是更旧的缓存
      // 或者（在问题一修复之前的行为）被误判成新用户。
      const safeUsername =
        sanitizeUsername(user.username).replace(/_+$/g, '') || 'guest';
      cacheLibrarySnapshot(safeUsername, {
        tree,
        collapsed,
        selectedFolderId: req.body.selectedFolderId || null,
        currentStoryId: req.body.currentStoryId || null
      });

      return sendJson(res, 200, {
        ok: true,
        key: result.key,
        url: result.url
      });
    }

    return sendJson(res, 405, {
      error: '请求方法不允许'
    });
  } catch (error) {
    console.error(
      'Vercel library error:',
      error
    );

    return sendJson(res, 500, {
      error:
        '绘本目录服务暂时不可用，请检查云数据库配置'
    });
  }
}