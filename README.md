# tappyread — 点读绘本阅读器（前端直传 COS 版）
基于 Node.js + Express + MySQL（TiDB Cloud）的绘本阅读应用，支持账号注册/登录、绘本目录云端同步（COS JSON）、图片/HTML 前端直传腾讯云 COS、HTML 绘本双击全屏点读。

## 一、本次优化：注册默认绘本超时 + Chrome 朗读异常

### 1. 新用户默认绘本改为“浏览器直读 COS”

注册接口现在只完成 MySQL 用户、Session 和后台日志写入，不再等待 `json/start.json` 下载和复制。新用户进入阅读器后：

1. 浏览器通过轻量 `/api/cos/config` 获取当前用户的 COS 对象键和 `json/start.json` 模板键；
2. 浏览器通过 `/api/cos/auth` 获取短期签名；
3. `json/{用户名}.json` 与 `json/start.json` 的 JSON 文件体直接在“浏览器 ↔ COS”之间传输，不经过 Vercel；
4. 用户目录不存在时才读取 `json/start.json`，首屏立即使用模板；随后异步写入自己的用户目录，不阻塞阅读器；
5. 已有用户网络异常时优先保留 IndexedDB 缓存，不会把现有绘本误判成空目录。

因此，截图中 `/api/auth/register` 因等待 COS 导致的约 8 秒请求链路被彻底移除。

### 2. Chrome 朗读稳定性

- 删除每 6 秒强制 `pause()/resume()` 的“续命”定时器，避免它反过来打断正常朗读；
- `cancel()` 后增加短暂间隔再 `speak()`；
- 单句朗读增加 4.5 秒启动看门狗，静默失败自动重试 1 次；
- 跨页连续朗读同样增加看门狗和重试，不会因某一句没有触发 `onend` 而永久卡死；
- 标签页重新恢复可见时只执行 `resume()`；
- HTML 点读页内置脚本同步采用同样策略。

### 3. 🆕 打卡 / 跟读录音功能

每一页阅读区图片（或 HTML 点读页）下方，与朗读文字条之间的虚线分割线正中间新增了一个打卡图标（🎙️ 未打卡 / ✅ 已打卡）。点击后弹出「打卡详情」弹窗：

- 顶部显示已打卡的用户名（多人录音时用“和”连接）与最近一次打卡时间；
- 「01 朗读录音」区域列出该页所有跟读录音，每条支持播放（带进度条与时长）、删除；
- 底部「＋」按钮开始新的一次录音：点击「▶️」开始录音，期间可任意次「暂停 / 继续」，只有点击「✅ 完成」才会真正结束并生成一条录音记录；也可点击「✕ 取消」放弃本次录音。

录音文件通过浏览器直传（与图片/HTML 同一套 `cos-js-sdk-v5` + `/api/cos/auth` 签名机制）保存到腾讯云 COS 的 `AudioRecords/{绘本名称}/u{用户ID}_...` 目录下，文件名规则为「绘本名称 + 当前页码 + 日期时间」；删除录音时复用 `/api/images/delete` 接口清理对应 COS 对象。打卡记录本身（用户名、时间、录音列表）保存在该页数据的 `checkin` 字段中，随绘本目录 JSON 一并同步到 COS，无需额外数据库表。删除绘本或删除单页时会自动清理该页所有录音文件，避免残留孤儿对象。


## 二、技术架构

```
浏览器 (tappyread.html / index.html / showfirst.html)
   │  认证/目录元数据：REST /api/*（Bearer token / Cookie，均为轻量请求）
   │  文件体：cos-js-sdk-v5 直传/直读 COS（签名来自 /api/cos/auth）
   ▼
Express 服务 (server/server.js) 或 Vercel 云函数 (api/*)
   ├── MySQL (TiDB Cloud)：users / sessions 表（账号与会话）
   └── 腾讯云 COS：
        ├── json/{用户名}.json        —— 绘本目录（前端直传/直读）
        ├── jpeg/u{userId}_*.{jpg…}  —— 图片绘本页（前端直传）
        └── html/u{userId}_*.html    —— 一键生成分析阶段的整文件（每本书 1 个，含点读脚本注入见渲染侧）
```

- 认证：登录后颁发 32 字节随机 token，sha256 哈希存 `sessions` 表；请求带 `Bearer token` 或 `tappyread_session` Cookie。
- 直传签名：`GET /api/cos/auth?method=PUT&key=jpeg/u5_xxx.jpg` → `{Authorization}`（600 秒有效，仅限本人对象键）。
- 删除：`POST /api/images/delete`（body: `{keys}`，仅允许删除当前用户前缀的对象）。

## 三、必做一次性配置：COS 存储桶 CORS（直传前提）
网页地址：https://console.cloud.tencent.com/cos/bucket?bucket=tappyreadjpeg-1325106148&region=ap-guangzhou&path=%252Fjson%252F
使用微信账号关联登录
浏览器直传是跨域请求，必须在 COS 控制台为桶 `tappyreadjpeg-1325106148` 配置 CORS 规则：

1. 打开 [COS 控制台](https://console.cloud.tencent.com/cos) → 存储桶 `tappyreadjpeg-1325106148` → **安全管理 / 跨域访问 CORS 设置** → 添加规则：
   - **来源 Origin**：`http://localhost:3000` 和你的 Vercel 域名（如 `https://xxx.vercel.app`），或图省事填 `*`
   - **操作 Methods**：`GET, PUT, POST, HEAD, DELETE`
   - **Allow-Headers**：`*`
   - **超时 Max-Age**：`600`
2. 保存即生效（无需重启）。

> 没配 CORS 时：页面仍可正常加载已有图片（防盗链不拦 `<img>`），但直传会失败并自动降级回后端中转（6MB+ 大文件仍会受限）。所以**请务必配置**。

## 四、数据库初始化
网页地址：https://tidbcloud.com/tidbs/10361392845639587237/sqleditor?orgId=1372813089209357031
使用github账号登录
在 TiDB Cloud（或其他 MySQL 8.0+）中建表：
`users`（id, username, password, created_at）：存储注册/登录的用户信息
`loginlog`id, username, action,action_time,duration_seconds,ip,ip_region,created_at）：存储注册/登录用户的登录日志，可用户分析网站使用情况
`user_libraries`：已弃用（绘本目录存于 COS JSON，不再依赖 `user_libraries` 表。）
`sessions`（token_hash, user_id, expires_at,created_at）：存储注册/登录用户的token信息   
以下是方便执行的sql脚本
   USE tappyread;
   SELECT * FROM `tappyread`.`users` LIMIT 100;
   SELECT * FROM `tappyread`.`loginlog` LIMIT 100;
   SELECT * FROM `tappyread`.`user_libraries` LIMIT 100;
   SELECT * FROM `tappyread`.`sessions` LIMIT 100;
   DELETE FROM users;
   DELETE FROM user_libraries;
   DELETE FROM loginlog;
   DELETE FROM sessions;

## 五、本地运行

1. 安装依赖：`npm install`
2. 复制 `.env.example` 为 `.env`，填写：

   | 变量 | 说明 |
   | --- | --- |
   | `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` | TiDB Cloud 连接信息 |
   | `COS_SECRET_ID` / `COS_SECRET_KEY` | **腾讯云 API 密钥**（控制台 → 访问管理 → API 密钥管理）。**必填**，否则直传与中转上传都不可用 |
   | `COS_BUCKET` / `COS_REGION` | 默认 `tappyreadjpeg-1325106148` / `ap-guangzhou` |
   | `COS_IMG_DIR` / `COS_HTML_DIR` / `COS_JSON_DIR` | 默认 `jpeg` / `html` / `json` |
   | `COS_AUDIO_DIR` | 默认 `AudioRecords`，打卡跟读录音统一存储目录 |
   | `COS_TEMPLATE_KEY` | 默认 `json/start.json`，新用户默认绘本模板 |

3. 按「二」配置 COS CORS。
   图片绘本存储地址：https://tappyreadjpeg-1325106148.cos.ap-guangzhou.myqcloud.com/jpeg/
   绘本目录存储地址：https://tappyreadjpeg-1325106148.cos.ap-guangzhou.myqcloud.com/json/
   html绘本存储地址：https://tappyreadjpeg-1325106148.cos.ap-guangzhou.myqcloud.com/html/
   注意：暂时隐藏了html绘本导入的“添加HTML绘本”按钮，该功能暂时不开放！

4. `npm start` → 访问 `http://localhost:3000` → 注册 → 登录。

> ⚠️ 密钥只放在后端 `.env`（或 Vercel 环境变量），**永远不会下发到前端**——前端拿到的是每次请求的实时签名，泄露面与后端中转方案完全一致。

## 六、部署到 Vercel
网页地址：https://vercel.com/zz-4651/tappyread/AkZmLMwGenQtY9uSiBZ8oMKNYTGz/logs?refreshedAt=1788832171236
使用github账号登录
1. 导入仓库，Framework Preset 选 **Other**。
2. Environment Variables 配置与 `.env` 相同的变量（`MYSQL_*`、`COS_*`、`TENCENT_TTS_*`、`SESSION_DAYS`）。
3. 部署后访问域名。文件上传/下载直连 COS，**不再受 Vercel 4.5MB 请求体限制**；函数只处理登录与签名等轻量请求。

## 七、使用流程

1. **注册/登录** → 注册接口立即返回；新用户进入阅读器后由浏览器直读 COS `json/start.json` 作为默认绘本，并异步初始化自己的 `json/{用户名}.json`，同时记录 loginlog。
2. **导入目录**：「📥 导入」选择备份 JSON；含 Base64 图片的备份自动补传 COS。
3. **批量导入绘本 / 新增绘本 / 添加页面**：确认导入后图片**直传** COS `jpeg/`，进度条显示进度。
4. **一键生成**：选择 HTML 文件 → 分析（整文件直传 COS `html/` 1 次，本地分页裁剪）→ 确认生成（裁剪页内联进目录，**不逐页上传**，与历史逻辑一致）。(暂时隐藏了html绘本导入的“添加HTML绘本”按钮，该功能暂时不开放！)
5. **刷新/换设备**：自动从 COS 重新加载你的目录（按用户隔离）。
6. **删除绘本**：COS 上的对应图片/HTML 同步删除。

## 八、V9 语音朗读优化（腾讯云 TTS，默认英语男声）

### 1. 背景与目标

浏览器原生 `speechSynthesis` 在国内网络环境下存在语音库不稳定、依赖 `Google UK English Male`（国内网络无法稳定访问）、不同系统/浏览器效果差异大、连续朗读后偶发失声等问题。V9 起新增腾讯云语音合成（TTS）作为**默认**朗读引擎，浏览器本地语音降级为**备用**引擎，具体见《V9 语音朗读优化改造需求说明.docx》。

### 2. 架构

```
用户点击文字/单词
      │
      ▼
tappyread.html  →  speakText(text) / speakOne(text) / speakSequence(items)
      │                 │
      │        ① 默认：POST /api/tts（服务端代理，密钥不下发前端）
      │                 │→ 腾讯云语音合成 TextToVoice（英语男声 WeJack）
      │                 │→ 返回 base64 MP3 → 浏览器 <audio> 播放
      │
      └── ② 腾讯云异常/超时/未配置 → 自动降级 → 浏览器 speechSynthesis（原有稳定性修复全部保留）
```

- `/api/tts`（Vercel 云函数）与 `server/server.js` 的 `POST /api/tts`（本地开发）逻辑一致，均要求登录（`authenticate`），密钥只从环境变量读取。
- 前端内置内存音频缓存（同一段文本+同一语速重复朗读直接复用，无需重新请求），并支持可选的腾讯云 COS 音频持久化缓存（见下）。
- 长文本会在浏览器端按句子边界自动切分为多段，分别合成后连续播放，规避腾讯云单次合成字数上限。
- 连续失败达到阈值后进入约 1 分钟的"冷却期"，冷却期内直接使用本地语音，避免反复等待超时影响体验；点击「🔄 重置语音」按钮会立即清除冷却、停止当前播放并重新初始化两套引擎。

### 3. 必需的环境变量

| 变量 | 说明 |
| --- | --- |
| `TENCENT_TTS_SECRET_ID` / `TENCENT_TTS_SECRET_KEY` | 腾讯云 API 密钥（控制台 → 访问管理 CAM → API 密钥管理）。**必填**，否则 `/api/tts` 返回 503 |
| `TENCENT_TTS_APP_ID` | 语音合成应用 AppId（控制台 → 语音合成 → 应用管理），当前基础合成接口不强制使用，预留给后续长文本异步合成等扩展 |

可选高级配置（不填使用默认值）：`TENCENT_TTS_REGION`（默认 `ap-guangzhou`）、`TENCENT_TTS_VOICE_TYPE`（默认 `1050`=WeJack 英文男声标准音色）、`TENCENT_TTS_VOLUME`（默认 `8`，范围 -10~10，数值越大越响）、`TENCENT_TTS_CACHE`（默认开启，填 `0` 关闭 COS 缓存）、`TENCENT_TTS_CACHE_DIR`（默认 `audio`）。

> 开通语音合成服务：[腾讯云控制台 → 语音合成 TTS](https://console.cloud.tencent.com/tts) → 新建应用即可获得 AppId；密钥与 COS 共用同一套「访问管理 CAM → API 密钥管理」，也可以单独为 TTS 创建一组子账号密钥并只授予 `QcloudTTSFullAccess` 权限，遵循最小权限原则。

### 4. 音色、音量与语速

- 默认音色：`VoiceType=1050`（WeJack，英文男声，标准音色，账号无需额外开通）。如已开通精品/大模型音色，可将 `TENCENT_TTS_VOICE_TYPE` 改为 `101050`（WeJack 精品）或 `501008`（WeJames 大模型，音质更自然清晰）等，完整音色表见腾讯云文档「语音合成 → 音色列表」。
- **音量**：`TENCENT_TTS_VOLUME`，范围 `-10 ~ 10`，`0` 为腾讯云的默认音量（实测偏小，是"声音有点小"反馈的直接原因）。已把默认值调高到 `8`，比原始默认音量明显更响；如果觉得还不够大声或者出现了轻微失真，可以在环境变量里继续微调（`9`、`10` 更响，但失真风险也更高；调小则更保守）。修改后需要重启本地服务（`npm start`）或在 Vercel 上 Redeploy 才会生效。
- 语速沿用页面原有的语速滑块（0.6～1.1，1.0 为正常速度），服务端按腾讯云 `Speed` 参数区间（[-2, 6]，每 0.2 倍速对应 1 档）等比换算，浏览器备用引擎与腾讯云音色的听感语速基本保持一致。

### 5. 音频缓存（可选，需要额外的 COS 权限）

同时配置了 `COS_SECRET_ID` / `COS_SECRET_KEY` 时，`/api/tts` 会在同一个 COS 桶下按 `audio/{文本+音色+语速哈希}.mp3` 缓存已合成的音频：命中缓存直接返回，未命中则调用腾讯云合成后异步写入缓存（不阻塞本次播放）。这能显著降低重复朗读（同一页反复点读）时的腾讯云调用次数、加快后续播放速度。不需要该能力时设置 `TENCENT_TTS_CACHE=0` 关闭。

### 6. 音色下拉框："腾讯云 TTS 英语男声"作为第一项、可自由切换

页面右上角原有的"音色"下拉框（`#voiceSelect`）第一项固定为 **腾讯云 TTS 英语男声（推荐）**，默认选中：

- 选中该项时，朗读走腾讯云 TTS（异常时仍会自动降级为浏览器语音，见上文）。
- 选中列表中其他任意浏览器语音（如 `Google UK English Male`）时，**完全按原来的方式朗读**，不会请求 `/api/tts`，也不受腾讯云冷却期影响——相当于把 TTS 功能整体关闭，回到改造前的行为。
- 用户的选择会记录在浏览器 `localStorage`（键名 `tappyread_voice_pref`），下次打开页面自动沿用。

### 7. 冷启动 / 首次朗读延迟优化

Vercel 上 `/api/tts` 是独立的 Serverless 函数，长时间无请求后容器会被回收，下一次调用需要重新冷启动、重新建立数据库连接，是"部署到 Vercel 后第一次朗读要等几秒"的主要原因（尤其当数据库与 Vercel 部署区域不在同一地理区域时，首次建连耗时更明显）。本次已加入以下优化：

- **预热请求**：页面加载后（及此后每 4 分钟，仅在页面可见时）会自动发送一次 `{warmup:true}` 的轻量请求到 `/api/tts`，只做登录校验和数据库连接，不调用腾讯云、不计入朗读次数，提前把容器"叫醒"，让用户真正点读时无需等待冷启动。
- **按需加载 COS SDK**：只有真正开启了音频缓存时才会加载 COS SDK，减少未使用缓存场景下的冷启动体积。
- **缓存查询超时保护**：COS 缓存查询设置 600ms 超时，查询变慢时直接当作未命中处理，避免"缓存本该更快"反而拖慢整体响应。
- **耗时排查**：将环境变量 `TTS_DEBUG_TIMING` 设为 `1` 后，Vercel 函数日志（Vercel 控制台 → 项目 → Logs）会打印鉴权、缓存查询、腾讯云合成、总耗时等各阶段耗时，便于进一步定位具体哪个环节慢。

> 预热请求无法完全消除冷启动（容器仍可能因 Vercel 资源调度被回收，尤其 Hobby 免费套餐的资源保留时间更短），但能覆盖绝大多数"打开页面后正常阅读"的场景。如果需要更强的保障（几乎不出现冷启动），可以考虑升级到 Vercel Pro 套餐并配置 Cron Job 定时（每几分钟）访问一个轻量接口保持容器常驻，或将数据库迁移到与 Vercel 部署区域更近的地域以缩短建连耗时。

### 8. 兼容性与安全

- 已验证兼容 Chrome / Edge，且不依赖 VPN、代理或本地安装语音包；腾讯云异常时自动无缝降级，不影响原有点读、单句朗读、整页朗读、自动翻页朗读、语速控制、语音选择、暂停/继续/停止等既有功能。
- `SecretId` / `SecretKey` 全程只存在于服务端环境变量中，前端与浏览器网络面板都无法看到；`/api/tts` 与其他业务接口一样要求登录态，并做了简单的按用户限流，避免异常调用导致腾讯云账单激增。
- 说明：为「一键生成绘本」导出的**独立 HTML 点读页**（脱离本应用、可单独打开的 HTML 文件）目前仍使用浏览器 `speechSynthesis`，未接入腾讯云 TTS——这类独立文件没有后端会话，若要接入需额外设计免登录/限量的公开代理接口，超出本次改造范围，如有需要可在后续版本中单独实现。

## 九、常见问题

- **直传失败/一直走降级？** 检查：① `.env` 或 Vercel 环境变量是否配了 `COS_SECRET_ID/KEY`；② COS 桶 CORS 是否按「二」配置（控制台报 CORS 错即此因）；③ 浏览器控制台网络面板看 `GET /api/cos/auth` 是否 200。
- **6MB+ 目录还是传不上？** 确认不是走了降级链路（控制台会有"回退后端中转"警告）；直传模式下 COS 简单上传上限 5GB，不存在 4~6MB 失败的场景。
- **老目录数据在哪？** 旧版命名的 `json/{用户名}_绘本目录.json` 会在下次保存时自动清理合并到标准位置。
- **图片不显示？** 老数据页面无 `cosKey` 时，重新导入备份（自动补传）即可。

## 十、使用AI制作能一键识别文字内容标准格式PDF的说明，将下面的文本连同“语学习类 PDF 文件”发给AI即可制作成功

- 你是一名文档排版工程师。附件是一个英语学习类 PDF 文件，请按下面的规范重新处理，
输出一个新的 PDF 文件（不要改动原文件，另存为新文件）。

【内容处理】
1. 只保留英文单词和英文句子，删除全部中文（含中文标题、中文翻译、中文注释、中文说明）。
2. 删除全部音标（含 /.../ 形式、音标标签行、"音标："前后内容）。
3. 删除残留的 Markdown 标记（#、*、-、**、--- 等）和 AI 生成痕迹的文字。
4. 修正 OCR 错误：l'm→I'm、lt's→It's、独立单词 i→I、What s→What's 等。
5. 全角标点转半角：？！，：；（）． 等。
6. 标点前后补空格：如 "Yes,I" → "Yes , I"；句号后紧跟大写字母时补空格。
7. 中文字句里夹杂的英文碎片（如"买 SIM 卡"里的 SIM）要丢弃；但独立的英文词汇条目（如 Bank、Subway、GPS、ATM）要保留。
8. 每行只放一个英文句子或词条，不要把多个句子挤在一行。
9. 保留原文的层级结构（如 Grade/Unit、Episode、Lesson 等）。

【页面设置】
- 纸张：宽 31.75 厘米 × 高 42.33 厘米（= 12.5 × 16.67 英寸）
- 页边距：上下左右均 0.6 英寸
- 页面背景色：浅黄色 FFF8DC（整册统一）
- 不要任何页面边框、页眉页脚线、页面方框

【文字规格】
- 字体：全部 Arial（含东亚字体也设为 Arial，不要用宋体/雅黑兜底）
- 文档主标题：48pt、加粗、颜色 #E07B39（暖橙色）
- 层级标题（Grade / Unit / Episode 等）：28pt、加粗、颜色 #E07B39
- 正文内容（单词和句子）：28pt、不加粗、颜色 #5B4636（暖棕色）
- 正文对齐：左对齐
- 行距：1.4 倍；段前 2pt、段后 10pt（保证每个句子之间有舒适间距）

【版式结构】
- 每个内容单元（一个 Unit / 一个 Episode）用一个「单列表格」承载，每行一个句子。
- 表格宽度占满正文区（100%），居中，固定布局。
- 单元格内边距：上下 40 dxa、左右 120 dxa。
- 表格样式用 Normal Table。

【边框（重点，必须严格遵守）】
- 界面上不允许出现任何横线或竖线：
  · 页面边框：不要（禁止 <w:pgBorders>）
  · 段落边框：不要（禁止 <w:pBdr>）
  · 表格边框：表格级边框全部设为 none（<w:tblBorders> 六个方向 val="none"）
  · 单元格边框：**禁止出现 <w:tcBorders> 元素**，必须整个删除，
    不能只把值设为 none —— 只设 none 仍会被点读机渲染成彩色边框线！
- 最终 document.xml 里应该只有表格级的 tblBorders（全部 none），
  且 tcBorders 数量必须为 0。

【交付】
- 输出 .docx 文件（例如 xxx_TappyRead点读版.docx），保存在原文件同目录。
- 输出前自检：无中文残留、无音标残留、tcBorders=0、pgBorders=0、pBdr=0、
  页面尺寸 31.75×42.33cm、背景 FFF8DC、字体 Arial、正文 28pt、标题 48pt。
```

