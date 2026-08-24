# dsh-zcode-sync

**English**: A DeepSeek Harness (DSH) plugin that syncs your [ZCode](https://zcode.ai) custom model providers into DSH — in-process via the settings & credentials services, with `llm-pi-ai`'s own validation as the gatekeeper. Idempotent, zero hardcoded paths, works on any machine. See [English summary](#english-summary) below.

把 [ZCode](https://zcode.ai) 的自定义模型提供商配置自动同步到 DeepSeek Harness（DSH）的插件。
由本机一次性迁移脚本 `sync-zcode-to-dsh.cjs` 改造而来，**进程内运行、零硬编码机器路径、可迁移到任何电脑的 DSH**。

## English summary

If you use both ZCode and DeepSeek Harness, this plugin keeps every custom model provider you configured in ZCode (`~/.zcode/v2/config.json`) available inside DSH's model picker — API keys included. It merges (never deletes) into the `llm-pi-ai` namespace through DSH's own settings service, so invalid configs are rejected by `llm-pi-ai`'s validator instead of corrupting files. Runs once shortly after startup, optionally on an interval, and re-runs when its settings change. Configure via the `zcode-sync` section in Settings. Install: see below; logs land in `~/.dsh/zsync-plugin.log`.

## 它做什么

- 读取 ZCode 的 `~/.zcode/v2/config.json`（自定义 provider + 模型 + API Key）；
- 把每个 provider **合并**进 DSH 的 `llm-pi-ai` 设置命名空间（web 模型选择器即可直接选用）；
- 把 API Key 写入 DSH 凭据库（`.credentials.yaml`，经凭据服务完成）。

与旧脚本直接改 YAML 文件不同，本插件在 DSH 进程内走 settings/credentials 服务：

- `llm-pi-ai` 自带的校验（重复模型 ID、非法推理档位等）会在写入时拒绝坏配置，
  而不是写坏文件导致整个命名空间注册失败；
- 写入是 merge 语义：只动涉及的 provider 键；DSH 手工维护的字段
  （compat、额外模型、协议覆盖等）不会被删除或覆盖（`api`/`baseURL` 仅缺失时补）。

## 同步规则（继承自原脚本）

| ZCode | DSH |
|---|---|
| provider id（UUID） | 内置映射表 → 路由键；未命中按名称 slug 化（幂等），也可用设置里的 `extraProviderMap` 补充 |
| `options.apiKey` | 凭据服务的 `<ROUTE>_API_KEY` 引用 |
| kind `openai-compatible`/`openai` | `openai-completions` |
| kind `anthropic` | `anthropic-messages` |
| `models[].limit.context/output` | `contextWindow` / `maxTokens` |
| reasoning variants `off/none` | `reasoningEfforts: {off: null}`（不发推理参数） |
| reasoning variants `enabled` | `reasoningEfforts: {high: "high"}` |
| 其余 variant 原样透传（如 `xhigh`/`max`/`low`） | 同名键 |

注意：**新增模型不写 `reasoningEfforts`**（省略时继承 pi-ai catalog 默认推理能力；
显式 off-only 会被 llm-pi-ai 拒绝）。已有模型仅更新 contextWindow/maxTokens/reasoningEfforts，
不动 DSH 手工加的 name/input。ZCode 侧删除的模型不会从 DSH 删除（只增改不删）。

## 触发时机

1. DSH 启动后延迟跑一次（默认 8s，等 llm-pi-ai 就绪）；
2. 可选周期同步（设置 `syncIntervalMinutes`，0 = 关闭）；
3. 插件配置变更时立即重跑（web 设置页改动即生效）。

幂等：目标状态与现状一致则零写入。

## 安装到一台新电脑的 DSH

前提：目标机已安装并至少成功启动过 DSH（`llm-pi-ai` 通道可用，即模型页能配 provider），
且 ZCode 已登录并有自定义模型配置。

```bash
# 方式一：用 tarball（推荐，把 dsh-zcode-sync-1.0.0.tgz 拷过去）
node <dsh>/lib/bin.js plugin --profile web add C:/path/to/dsh-zcode-sync-1.0.0.tgz

# 方式二：用解压后的目录
node <dsh>/lib/bin.js plugin --profile web add file:C:/path/to/dsh-zcode-sync-local
```

其中 `<dsh>` 是 DSH 的 bin 入口，常见位置：

- npx 安装：`C:/Users/<你>/AppData/Local/npm-cache/_npx/<hash>/node_modules/@deepseek-ai/dsh/lib/bin.js`
- 或 profile 链接：`~/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js`

装完**重启 DSH**（bundle 变更不支持热加载）。启动后看日志/验证：
`POST http://127.0.0.1:3080/api/settings.describe` 应出现 `zcode-sync` 命名空间，
且 `llm-pi-ai.providers` 里出现 ZCode 的全部自定义 provider。

> ⚠️ 不要用 `link:` 目录方式安装：link 包留在原位、脱离 DSH 的 node_modules
> 依赖链，peer 依赖（@deepseek-ai/schemastery）会解析失败并导致整个插件树起不来。
> tarball / file: 目录会拷贝进 profile，没有这个问题。

## 配置项（settings 命名空间 `zcode-sync`）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `zcodeConfigPath` | `""` | ZCode config.json 路径；空 = `~/.zcode/v2/config.json`，支持 `~` 与相对路径 |
| `runOnStart` | `true` | 启动后跑一次 |
| `startDelayMs` | `8000` | 首次同步延迟 |
| `syncIntervalMinutes` | `0` | 周期同步分钟数，0 = 不周期 |
| `dryRun` | `false` | 只计算差异打日志，不写入 |
| `extraProviderMap` | `{}` | 追加的 ZCode provider id → DSH 路由键映射 |

排障日志：DSH 主目录下 `zsync-plugin.log`（DSH 会接管 stdout，插件日志独立落盘最可靠）。

## 开发

源码目录结构：

```
dsh-zcode-sync/
├── package.json        # dsh.bundle.patch 声明 + peerDependencies(schemastery/cordis)
├── cordis.patch.yml    # - insert: [{id: zcode-sync, name: dsh-zcode-sync}]
└── lib/index.js        # ESM 插件主体（name/inject/apply + syncOnce）
```

修改代码后重新部署到本机 DSH：

```bash
cd dsh-zcode-sync && npm pack
tar -xzf dsh-zcode-sync-1.0.0.tgz -C C:/Users/MR/dsh-zcode-sync-local --strip-components=1
rm -rf C:/Users/MR/.dsh/profiles/web/node_modules/dsh-zcode-sync
cp -r C:/Users/MR/dsh-zcode-sync-local C:/Users/MR/.dsh/profiles/web/node_modules/dsh-zcode-sync
# 重启 DSH 生效（file: 安装是拷贝快照，不会跟随源码变化）
```
