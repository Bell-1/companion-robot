# 网页陪伴机器人

仓库地址：<https://github.com/Bell-1/companion-robot>

浏览器里说话 → 阿里云 NLS 实时识别 → DeepSeek 生成回复 → NLS 语音合成播报。
支持回声抑制、说话打断和常开麦克风，Chrome 与 iOS Safari 可用。

## 技术栈

| 层        | 选型                                                            |
| --------- | --------------------------------------------------------------- |
| 工程      | pnpm workspace + Turborepo                                      |
| 前端      | React 19 + Vite 7 + zustand + AudioWorklet                      |
| 后端      | Fastify + WebSocket，deepagents（LangGraph）编排                |
| ASR / TTS | 阿里云智能语音交互 NLS（SpeechTranscriber / SpeechSynthesizer） |
| 大模型    | DeepSeek（OpenAI 兼容协议）                                     |

## 目录

```
apps/server/src
  index.ts            HTTP + WebSocket 入口（/health、/ws）
  env.ts              环境变量解析与校验
  agent/              deepagents 智能体与人设
  tools/              智能体工具：定位/天气/时间、联网搜索、记忆、沙箱文件、MCP
  asr/nls-asr.ts      NLS 实时语音识别封装
  tts/nls-tts.ts      NLS 语音合成封装（按句排队串行合成）
  nls/token.ts        AccessKey → NLS Token（缓存 24h）
  session/session.ts  会话状态机：回声过滤、打断、分句合成
  people/             人物外貌记忆：特征提取、学习、按会话落盘
  util/text.ts        回声判定、语气词过滤、流式分句
apps/web/src
  audio/engine.ts     麦克风采集（16k PCM）+ 播放队列 + 打断检测
  lib/client.ts       WebSocket 客户端（自动重连）
  App.tsx             界面与事件分发（含定位上报）
packages/shared       前后端共用协议
```

## 准备工作

1. 阿里云控制台开通 **智能语音交互**，创建项目，拿到 **Appkey**，并确认已开通「实时语音识别」和「语音合成」。
2. 创建 **AccessKey**（建议用只授权 NLS 的子账号）。
3. 申请 **DeepSeek API Key**。
4. 复制环境变量模板并填写：

```bash
cp .env.example .env
```

5. 下载本地声纹模型（约 28MB，不会进仓库）：

```bash
pnpm voiceprint:model
```

关键变量：

| 变量                                                | 说明                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `ALIYUN_ACCESS_KEY_ID` / `ALIYUN_ACCESS_KEY_SECRET` | 阿里云 AccessKey，用于换取 NLS Token                                                       |
| `NLS_APP_KEY`                                       | 智能语音交互项目里的 Appkey                                                                |
| `NLS_URL`                                           | 网关地址，需与项目地域一致，如 `wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1`          |
| `NLS_TTS_VOICE`                                     | NLS 音色名（如 `zhitian`、`aixia`），不是控制台中文名                                      |
| `DEEPSEEK_API_KEY`                                  | DeepSeek Key；看图需要 `DEEPSEEK_MODEL=deepseek-flash`                                     |
| `WEB_SEARCH_ENABLED` / `WEB_SEARCH_COUNT`           | 联网搜索开关与每次返回条数，默认开、5 条；走 DeepSeek Search API，共用同一个 Key           |
| `ASSISTANT_NAME`                                    | 助手名称，前端标题、人设和自我介绍都取这里                                                 |
| `EYE_ENABLED` / `EYE_INTERVAL_MS`                   | 摄像头「眼睛」开关与初始抓帧间隔，默认开、2000ms；之后由模型在回复里决定下次时间           |
| `EYE_MAX_AGE_MS`                                    | 画面超过这个时长就丢弃，默认 6000ms                                                        |
| `PROACTIVE_ENABLED`                                 | 是否允许主动开口，默认开                                                                   |
| `PROACTIVE_IDLE_MIN_MS` / `PROACTIVE_IDLE_MAX_MS`   | 安静多久后考虑主动说话，在区间内随机，默认 90~180 秒                                       |
| `PROACTIVE_MIN_GAP_MS`                              | 两次主动说话的最小间隔，默认 60 秒                                                         |
| `LEARN_ENABLED`                                     | 空闲观察与自我积累开关，默认开                                                             |
| `LEARN_MIN_INTERVAL_MS` / `LEARN_MAX_INTERVAL_MS`   | 空闲多久观察一次环境，默认 5~15 分钟                                                       |
| `VOICEPRINT_ENABLED`                                | 本地声纹识别开关，默认开；模型缺失时自动跳过                                               |
| `VOICEPRINT_MODEL_PATH`                             | 声纹模型路径，默认 `apps/server/models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx` |
| `VOICEPRINT_THRESHOLD`                              | 声纹余弦相似度阈值，默认 `0.6`，越高越保守；两人分数太接近时自动判为不认识                 |

## 启动

```bash
pnpm install
pnpm dev          # 前端 http://localhost:5173，后端 ws://localhost:8787
pnpm stop         # 停止本地所有 dev 进程（turbo / vite / tsx）
```

如果 `pnpm dev` 提示端口被占用，先跑 `pnpm stop`。

其他命令：

```bash
pnpm build        # 类型检查 + 前端产物构建
pnpm typecheck
pnpm test         # 文本逻辑单元测试（回声/语气词/分句）
pnpm format       # Prettier 格式化
```

健康检查：`curl http://127.0.0.1:8787/health`，`ok:true` 且 `missing:[]` 表示配置齐全。

## 生产部署

前端产物构建后，后端会自动托管 `apps/web/dist`，单端口即可访问（`http://host:8787`）：

```bash
pnpm build
pnpm --filter @companion/server start
```

Docker：

```bash
docker build -t companion-bot .
docker run --rm -p 8787:8787 --env-file .env companion-bot
```

声纹模型不在仓库里，先用 `pnpm voiceprint:model` 下到 `apps/server/models/` 再 build（会一起打进镜像），或运行时把该目录挂载到 `/app/apps/server/models`。模型缺失时声纹会自动关闭，其他功能不受影响。

注意：浏览器在非 localhost 环境要求 HTTPS 才能用麦克风，线上部署需要在容器或反向代理前加 HTTPS（如 Nginx / 云负载均衡），并把 `/ws` 升级为 `wss`。

## 局域网 / iPhone 真机联调

浏览器只在**安全上下文**（`https://` 或 `localhost`）里开放麦克风与 AudioWorklet。用 `http://192.168.x.x:5173` 打开会直接报错（`Cannot read properties of undefined (reading 'addModule')` 或「无法访问麦克风」），这不是代码问题。

**方式一：本地证书 + 局域网地址（推荐）**

```bash
pnpm cert     # 生成 certs/rootCA.crt 与覆盖 localhost、局域网 IP 的 dev.crt
pnpm dev      # 自动启用 https，地址变为 https://<局域网IP>:5173
```

还需要让设备信任 `certs/rootCA.crt`：

- macOS（Chrome 访问时）：
  ```bash
  security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db certs/rootCA.crt
  ```
- iPhone：用 AirDrop 发送 `certs/rootCA.crt`（或在 `certs/` 下执行 `python3 -m http.server 8000` 用手机打开下载），安装描述文件后到「设置 → 通用 → 关于本机 → 证书信任设置」开启完全信任。

换网络导致 IP 变化时，重跑一次 `pnpm cert` 即可。

**方式二：ngrok 隧道（证书天然可信，手机不用装证书）**

```bash
pnpm dev      # 终端 1
pnpm tunnel   # 终端 2，输出 https://xxx.ngrok-free.dev
```

手机打开该地址，首次出现 ngrok 提示页点「Visit Site」。

若页面能打开但点麦克风没反应，先确认地址是 `https://` 且没有「不安全」提示；iOS 也可在「设置 → Safari → 麦克风」检查该站点是否被禁用。

## 工作方式

- **半双工**：机器人播报期间，前端把上行音频替换为等长静音帧。既避免把扬声器声音再喂给 ASR，也让识别连接保持活跃。
- **回声兜底**：服务端再用文本相似度（包含关系 + 编辑距离 ≥ 0.8）过滤播放期间的误识别。
- **常开聆听**：麦克风开着时听到的话默认就是在跟助手说，不再需要唤醒词；`ASSISTANT_NAME` 只用于人设和称呼，不参与触发。
- **打断**：播放时本地 RMS 连续 3 帧超阈值即认为用户在说话，前端立即清空播放队列并通知服务端取消本轮。
- **分句合成**：首句满 10 字遇逗号即开始合成，后续句满 18 字；音频按句串行生成，保证顺序。
- **断句等待**：VAD 断句时静音 1 秒即判定说完（`NLS_ASR_MAX_SENTENCE_SILENCE_MS`），留出换气停顿，减少半句被截断丢词。
- **识别准确率**：默认关闭语义断句（`NLS_ASR_SEMANTIC_SENTENCE=false`）——它会把一句话拆成多段，后段常要 2 秒才出，还容易让前半句的回答被后半句取消；人名、专有词可在 NLS 控制台「自学习」建热词表，把 ID 填到 `NLS_ASR_VOCABULARY_ID`。
- **语气词过滤**：「嗯」「啊」「哦哦」「哈哈哈」这类没有实际内容的短句直接忽略，不触发模型和语音。
- **听到就回应**：麦克风一直开着，识别出的话默认就是在对助手说，直接回应，不再额外做「是不是在跟我说话」的判断，避免正常对话被误静默。只有播放时的扬声器回声和单独的语气词会被过滤。
- **主动陪伴**：安静 90~180 秒后会自己开口——聊当下的感受、发发小牢骚、提醒休息；摄像头画面明显变化时也会考虑评论一句。模型判断没内容时只输出 `[不回应]` 保持安静，两次主动说话至少间隔 60 秒，且用户刚出过声时不会插话。
- **空闲观察与成长**：安静时每 5~15 分钟静默看一眼环境，记录场景和变化；值得长期记住的稳定习惯（比如常喝咖啡、晚上工作）会写进长期记忆，后续对话里像相处久了自然知道一样用上。观察只写在 `data/world/<sessionId>.json`（最多 40 条），不产生语音、不进入对话历史。
- **提醒与待办**：说「十分钟后提醒我喝水」「明天八点叫我」「记一下要交报告」会真正落盘到 `data/reminders/<sessionId>.json`。到点后服务端直接用 TTS 播报（不走模型，几秒内必到），右侧面板显示未完成的提醒和待办；正在对话或播报时会延后几秒再提醒。没开麦时不播报，下次开始对话后会把逾期的补上。
- **情绪语调**：模型在回复开头带一个情绪标记（`[开心]`/`[生气]`/`[难过]`/`[关心]`/`[兴奋]`/`[委屈]`/`[中性]`），服务端剥掉标记后按情绪调整 NLS 合成的语速、音调和音量；标记不会显示也不会被读出来。
- **眼睛（摄像头）**：开始对话后自动打开摄像头，只存内存不落盘；界面上的「眼睛」按钮可随时关闭。用户每发一条消息，服务端都会让前端立刻抓一帧当时的画面，所以模型看到的和正在回的话是同一时刻，不会差几秒。抓帧节奏由模型控制：模型每轮通过 `set_look_interval` 工具（结构化参数，单位秒）指定下一次抓帧时间，服务端解析后安排采集，不再固定轮询；用户说「看仔细点」就调小，「别老看」就调大，界面提示会同步更新。用户说「看看这是什么」「上面写的什么」时，模型会调用 `look_closely` 细看当前画面，读文字、认物品或看表情。需要 HTTPS（`certs/` 已支持）并允许摄像头权限。
- **人物记忆**：不训练人脸模型，而是让多模态模型总结每个人稳定的外貌特征（发型、眼镜、胡子、常穿的衣服等）存成文字，每轮注入上下文，再由模型对照当前画面认人。声纹认出是谁后会自动顺手学一次长相；也可以说「记住我长什么样」手动调用 `remember_person`。认人要求声音和画面两边都对得上，特征不明显时宁可当陌生人，不猜名字。外貌只存文字描述，不保存人脸图片。

## 智能体工具

智能体按会话创建，工具注册在 `apps/server/src/tools/index.ts`：

| 工具                                                                  | 说明                                                                    |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `get_current_time`                                                    | 当前日期时间，默认 `Asia/Shanghai`                                      |
| `get_weather`                                                         | 天气：优先用浏览器定位，其次模型传入的坐标，最后按城市名查询            |
| `web_search`                                                          | 联网搜索实时信息，走 DeepSeek Search API，直接返回结果摘要              |
| `remember` / `recall` / `list_memories` / `forget_memory`             | 长期记忆的增删查，按会话落盘到 `apps/server/data/memory/<id>.json`      |
| `os_write_file` / `os_read_file` / `os_list_files` / `os_delete_file` | 会话专属沙箱文件读写，根目录 `apps/server/data/sandbox/<id>/`           |
| `create_reminder` / `create_todo`                                     | 设定到点提醒（相对/绝对时间）或添加无时间待办                           |
| `list_reminders` / `complete_reminder` / `cancel_reminder`            | 查看、完成、取消提醒与待办                                              |
| `set_look_interval`                                                   | 模型自行调整摄像头观察频率（2~120 秒）                                  |
| `look_closely`                                                        | 细看当前画面：读文字、认物品、看表情动作                                |
| `remember_voice` / `list_voices` / `forget_voice`                     | 注册、查看、删除声纹；声纹落在 `apps/server/data/voiceprints/<id>.json` |
| `remember_person` / `list_people` / `forget_person`                   | 记住、查看、删除人物外貌；外貌落在 `apps/server/data/people/<id>.json`  |

**定位**：点开始后前端调用 `navigator.geolocation`，通过 `client.location` 事件把坐标上报给服务端；服务端每轮把定位和记忆摘要拼进模型上下文，并保存在进程内。浏览器拒绝授权时自动退化为按城市名查询天气。

**天气源**：和风天气（`QWEATHER_API_KEY` + `QWEATHER_API_HOST`）。新账号必须填控制台「设置 → 开发者信息」里的专属 API Host（形如 `abcdefg.re.qweatherapi.com`），否则请求会返回 `403 Invalid Host`。查询会同时取实时天气和 3 天预报，工具返回里包含今天温度范围以及明天、后天的天气与温度，可直接回答「明天要不要带伞」这类问题。查询失败会返回错误文案，模型只如实说查不到，不会编造。

**联网搜索**：直接调用 DeepSeek Search API（`POST {DEEPSEEK_BASE_URL}/tools/search`），和对话模型共用 `DEEPSEEK_API_KEY`，不需要额外的搜索服务或 Key。每轮只返回标题、摘要和链接，语音回答时会总结成一两句话，不念网址。

**沙箱**：所有文件路径都做归一化校验，拒绝绝对路径与 `..` 穿越；单文件上限 200KB。每个会话独立目录，换会话互不影响。

**记忆**：记忆分偏好、人物、约定、事件、事实五类，新增时自动归类，说法高度接近的只保留一条。每轮按当前话题的相关度挑选要注入的记忆，不够再补最近几条，不再固定塞最近 N 条；`recall` 也按相关度排序。单会话最多 200 条、单条 500 字，落在 `apps/server/data/memory/`，重启后仍在。换新会话（新 sessionId）时是一份新的记忆。

**声纹**：本地用 `sherpa-onnx-node` + CAM++ 中文模型提取 192 维说话人向量，不联网、不上传音频。说「记住我的声音，我叫小明」后会调用 `remember_voice`，把刚才那句的声音注册下来（同名可重复说几次补充样本）；之后每轮在后台并行识别说话人，认出时上下文会标注姓名，界面上显示名字标签。相似度低于阈值时按陌生人处理，不会猜名字。声纹按会话存在 `apps/server/data/voiceprints/`，模型文件需先执行 `pnpm voiceprint:model` 下载（约 28MB，不进仓库）。

**人物外貌记忆**：不用人脸模型，只让视觉模型把稳定外貌特征写成一句话（如「黑色短发，戴黑框眼镜，常穿灰色卫衣」），按名字和声纹对齐存在 `apps/server/data/people/`。声纹认出说话人后会自动异步学一次长相（每人只学一次，没画面就跳过）；用户说「记住我长什么样」时调用 `remember_person` 同步学习。每轮上下文只注入有外貌描述的人，模型结合声纹和当前画面判断「是谁在说话、在跟谁说话」，特征不明显时按陌生人处理。删除声纹不会连带删除人物外貌，可用 `forget_person` 单独清理。

## MCP 工具

把 MCP 服务写进仓库根目录 `mcp.json`（可从 `mcp.json.example` 复制），服务启动后自动加载，连不上的服务会被跳过而不影响对话：

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

远程服务用 `"type": "http"` + `"url"`，需要鉴权时加 `"headers"`。MCP 工具名会自动带上服务名前缀（如 `filesystem_read_file`），与内置工具不冲突。配置路径可用 `MCP_CONFIG_PATH` 覆盖。

## 延迟埋点

每轮结束服务端会打印一行耗时，便于定位瓶颈：

```
[latency] turn=xxxx 出句→首token=428ms 首token→首音频=725ms 出句→首音频=1153ms 整轮=2629ms
```

## 常见问题

- **TTS 报 `Engine return error code: 418`**：音色名不对。NLS 用的是英文音色名，可用 `aixia`、`aitong`、`aiqi`、`aijia`、`aina`、`sitong`、`sijia`、`siyue`、`xiaomei`、`zhitian`、`zhishuo`、`zhichu`、`zhide`。
- **ASR 一直 `asr_connect_failed`**：多为 `NLS_APP_KEY` 与 `NLS_URL` 地域不匹配，或 Token 获取失败（AccessKey 无权限）。
- **识别到了却没有回应**：如果文字短暂出现后消失，界面会提示原因——多为播放时的扬声器回声，或只是「嗯」「啊」这类语气词，服务端会直接忽略。
- **手机打不开麦克风**：确认地址是 `https://`，且证书已被信任。
- **本地命令连不上阿里云**：如果配置了 `HTTP(S)_PROXY` 但代理没启动，请先 `unset` 再跑。
- **天气总是查不到**：检查 `.env` 里的 `QWEATHER_API_KEY` 和 `QWEATHER_API_HOST`；新版和风天气必须用控制台分配的专属 API Host，老的 `devapi.qweather.com` 会返回 403。
- **定位没有生效**：iOS Safari 会弹权限询问，拒绝后只能按城市名查天气；重新授权可在「设置 → Safari → 位置」里改。

## 已知限制

- 麦克风常开，靠回声过滤和语气词过滤避免误触发；没有端侧关键词唤醒，也没有唤醒词。
- TTS 按句串行合成，第二句起会有一次新建连接的开销，实际被前一句的播放时间覆盖。
- 对话历史保存在进程内存（MemorySaver），重启即清空；长期记忆与沙箱文件已落盘。
- 定位只在会话内有效，断线重连后前端会重新上报一次。
