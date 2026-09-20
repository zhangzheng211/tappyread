import { authenticate, getPool } from './_mysql.js';
import COS from 'cos-nodejs-sdk-v5';

const COS_BUCKET = process.env.COS_BUCKET || 'tappyreadjpeg-1325106148';

const COS_REGION = process.env.COS_REGION || 'ap-guangzhou';

const COS_JSON_DIR = (process.env.COS_JSON_DIR || 'json').replace(/\/+$/, '');

const COS_BASE_URL = `https://${COS_BUCKET}.cos.${COS_REGION}.tencentcos.cn/`;

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
      Domain: `${COS_BUCKET}.cos.${COS_REGION}.tencentcos.cn`,

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

  return new Promise(resolve => {
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

          console.warn('读取 COS 绘本目录异常:', err);

          return resolve(null);
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
          console.warn('解析 COS 绘本目录失败:', error);

          return resolve(null);
        }
      }
    );
  });
}

async function getLatestLibraryFromCos(username) {
  if (!cosConfigured || !username) return null;

  const safeUsername =
    sanitizeUsername(username).replace(/_+$/g, '') || 'guest';

  const directKey = `${COS_JSON_DIR}/${safeUsername}.json`;

  // 快速路径：
  // 绝大多数情况下，文件就在标准的
  // json/{username}.json。
  //
  // 直接 GET 一次即可，不需要先列 json/ 目录。
  const direct = await readCosJsonFile(directKey);

  if (direct) return direct;

  // 仅当标准文件不存在时，才兼容旧版文件名。
  // 注意：这个 fallback 可能触发 COS getBucket，
  // 但正常新用户和正常保存流程不会走这里。
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

    return await readCosJsonFile(preferred);
  } catch (error) {
    console.warn('获取最新用户绘本目录失败:', error);

    return null;
  }
}

async function getStartLibraryFromCos() {
  if (!cosConfigured) return null;

  const snapshot = await readCosJsonFile(
    `${COS_JSON_DIR}/start.json`
  );

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

  // 正常保存只做一次 PUT。
  await putCosTextObject(
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

      const snapshot =
        await getLatestLibraryFromCos(user.username);

      if (
        snapshot &&
        Array.isArray(snapshot.tree)
      ) {
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

      // 当前用户没有 json/{username}.json：
      // 直接读取 start.json 作为新用户初始目录。
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

      const result =
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

      if (!result) {
        return sendJson(res, 500, {
          error: '同步用户绘本目录到 COS 失败'
        });
      }

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