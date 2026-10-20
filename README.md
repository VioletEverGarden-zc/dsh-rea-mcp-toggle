# dsh-rea-mcp-toggle

一个 DeepSeek Harness（DSH）bundle 插件：**在 Harness Web UI 里一键开关 REA MCP 服务器**，并把同一个开关交给模型（工具 `rea_mcp_toggle`）。选择按 profile 保存，重启后依然生效。

> 适用：DSH `0.2.1-alpha.2`（web profile）。零运行时依赖（只用 Node 内置模块 + dsh 宿主服务）。

---

## 1. 项目解决什么问题

REA（[Reverse Engineer Anything](https://github.com/morluto/rea)）通过 MCP 以 stdio 方式接入 DSH。它的工具集非常大：**开启时是 170 个 `mcp__rea__*` 工具**，这些工具的 schema 会随**每一次**请求一起发给模型。

实测同一实例、同一时刻，`Tool.listTools` 的返回体大小：

| REA 状态 | 工具数 | tools payload |
|---|---|---|
| 开启 | 251 | **722,353 字节** |
| 关闭 | 81 | **94,807 字节** |

差价 **627 KB** 全部是那 170 个工具的定义。它们**每次都进请求**，于是产生两种浪费：

1. **token 费用**：不管这一轮到底用不用逆向工具，都在为这 627 KB 付费（长会话里反复累积）；
2. **进程与内存**：REA 的 MCP 子进程常驻（单进程约 240 MB），只有关掉才会退出。

而 DSH 自带的「插件开关」（Plugin Manager 里把 `rea-mcp` 行禁用）**对这一行无效**——原因见第 6 节，这不是配置问题，是 patch 层的机制决定的。所以本项目提供了能真正生效、且能持久化的开关。

**典型场景**：平时关着，等真要分析二进制 / APK 时再打开；或者反过来，只在需要省 token 时临时关闭。

---

## 2. 主要功能

### 2.1 UI 开关（主入口）

会话标题栏（Session header）里的一个小按钮，与「费用明细」等控件并列：

- 显示 **`REA 开`** / **`REA 关`**，绿点表示当前状态；
- 点一下切换：**即时生效，不需要重启 Harness**；
- 切换失败时按钮直接变成 **`REA 失败`**（红框），鼠标悬停显示具体原因 —— 不会静默无效；
- 鼠标悬停还会显示当前工具数与配置行 id。

### 2.2 模型工具 `rea_mcp_toggle`

| action | 作用 |
|---|---|
| `status` | 读当前开关状态、工具数、是否已持久化、状态文件路径 |
| `set` | 切换（需 `enabled: true/false`）；**幂等**，重复同向不发写、不产生副作用 |
| `probe` | 诊断：Loader 行状态、REA 工具数、缝是否在位、服务可用性、Remote endpoint 解析情况 |
| `selftest` | 用 **Web UI 调用的同一条 Remote 网关路径**自检本插件（用来区分「UI 坏了」还是「Host 坏了」） |

UI 按钮与这个工具**共用同一套实现**（同一 service 的同一个方法），不存在两份逻辑。

### 2.3 状态持久化

选择保存在插件自己的状态文件里：

```
%DSH_PROFILE_DIR%\.rea-mcp-toggle.state.json     例如 {"enabled": false, "savedAt": "..."}
```

写入是原子的（临时文件 + rename）。重启后由家目录层的一行 `!!js` 缝读取该文件，**开机即按选择生效**（关闭状态下开机根本不会拉起 REA）。

### 2.4 工具可见性真正变化

关闭时 170 个 `mcp__rea__*` 工具从**模型可调用工具列表**中消失（不只是「不执行」）；开启时全部回来。

### 2.5 进程生命周期

- 开启：拉起 REA 的 stdio 子进程（**每次切换恰好 1 个**）；
- 关闭：dispose 该行，回收子进程、注销工具；
- 关闭后**不会自己复活**（曾有一个「关闭后子进程又起来」的缺陷，已修并可复现验证）。

---

## 3. 安装方法

### 3.1 前置条件

- 已安装 DSH，且 REA 已作为 MCP server 注册在**家目录层** `%DSH_HOME%\cordis.patch.yml`，形如：

  ```yaml
  - insert:
      - id: rea-mcp
        name: '@deepseek-ai/dsh-mcp-client'
        config:
          serverName: rea
          transport: stdio
          command: '<HARNESS_ROOT>\node\bin\node.exe'
          args: ['<NPM_GLOBAL>\node_modules\rea-agents\scripts\rea.mjs', 'mcp']
          env: { REA_MCP_INPUT_SCHEMA_PROFILE: compact }
          toolCallTimeoutMs: 900000
          failOnStartupError: false        # 硬约束：REA 坏了也不能让 harness 起不来
  ```

- 该行 id 必须是 **`rea-mcp`**（本插件按这个 id 定位；其它 id 会被明确拒绝，不会误伤）。

### 3.2 安装本 bundle

本插件以**路径链接**方式安装，因此包目录内需要有指向 DSH 安装的 `node_modules` 链接（Node 从包的**真实目录**解析 bare import；本插件运行时只 import `node:fs`，但编译/探针脚本需要）：

```powershell
cd plugins\dsh-rea-mcp-toggle
node scripts/link-deps.mjs
# 通常不需要参数：脚本会自己找 harness（见下），失败时才需要显式给根目录
# node scripts/link-deps.mjs "<HARNESS_ROOT>"
```

**脚本如何找到 harness**（按顺序，每个候选都会被 marker 校验，**错的目录不会静默胜出**）：

| 顺序 | 来源 | 说明 |
|---|---|---|
| 1 | 命令行参数 | `node scripts/link-deps.mjs "<root>"` |
| 2 | `<repo>/.harness-root` | 一行写根目录；模板见 `.harness-root.example`；已被 git 忽略。标准位置都描述不了的布局用这个 |
| 3 | `DSH_HARNESS_ROOT` | 环境变量 |
| 4 | 平台标准安装位置 | Windows：`%LOCALAPPDATA%\Programs`、`%ProgramFiles%`、`%ProgramFiles(x86)%`、`%LOCALAPPDATA%` 下的 `dsh-desktop` / `DeepSeek Harness` / `deepseek-harness`，并在其 `resources/harness` 与 `harness` 处探测；macOS：`/Applications`、`~/Applications`；Linux：`/opt`、`/usr/local/lib`、`/usr/lib` |
| 5 | 正在运行的 Harness | 由进程的 `node.exe` 路径反推安装根，因此装在非标准目录也能找到 |

判定「是 harness 根」的条件：同时存在 `node_modules/@deepseek-ai/{cordis,dsh,dsh-tools}` 与 `node_modules/js-yaml`。本仓库自身**被显式排除**（它的 `node_modules` 是链接，否则会自我链接）。

然后在会话里让模型执行（需要 danger-full-access 或当次审批）：

```
plugin_manager → install_bundle → <本目录绝对路径>
```

**安装后必须重启一次 dsh-desktop。** Host 半边的模块是进程启动时导入的；不重启时插件行会处于 `failed to import` 或停在旧版本。

### 3.3 安装家目录层的「开关缝」（必须，一次）

这是**唯一**需要手改家目录层的地方。在你已有的 `rea-mcp` 行里加一个行级 `disabled`（不要放进 `config` 里面）：

```yaml
      - id: rea-mcp
        name: '@deepseek-ai/dsh-mcp-client'
        config:
          # ...原有内容保持不动...
        # ── 开关缝：由 dsh-rea-mcp-toggle 插件读取 ──
        disabled: !!js >-
          Boolean(ctx.get('profileContext')?.dir) && (() => { try { return process.getBuiltinModule('node:fs').readFileSync(process.getBuiltinModule('node:path').join(ctx.get('profileContext').dir, '.rea-mcp-toggle.state.json'), 'utf8') && JSON.parse(process.getBuiltinModule('node:fs').readFileSync(process.getBuiltinModule('node:path').join(ctx.get('profileContext').dir, '.rea-mcp-toggle.state.json'), 'utf8')).enabled === false } catch { return false } })()
```

**改前先备份**：`Copy-Item .dsh\cordis.patch.yml .dsh\cordis.patch.yml.bak-<时间戳>`

这段表达式是**安全降级**的：状态文件不存在 / JSON 损坏 / `profileContext` 不可用（例如离线 `dsh --dump-config`）时一律返回 `false`＝保持启用，**不会让 harness 起不来**。

### 3.4 安装后自检

```powershell
node scripts/acceptance.mjs        # 校验缝与状态文件在同一口径上
```

再在会话里执行 `rea_mcp_toggle {action:"selftest"}` —— 它走的就是 Web UI 的 Remote 网关路径。

### 3.5 升级 REA 之后：开关「静默变哑」（`rea setup` 会覆盖开关缝）

`rea setup --client dsh`（安装 / 升级 REA 时常用）会**整份重写** `%DSH_HOME%\cordis.patch.yml`。重写后：

- `rea-mcp` 行还在，`config` 也更新到新版本（新 env、新超时）；
- 但你手写的那段行级 `disabled: !!js` **被丢掉了**。

症状不是报错，而是静默失效：UI 按钮照常切换、状态文件照常写入，`rea-mcp` 行却不再读它。判定方法：

```
rea_mcp_toggle {action:"probe"}
# 缝被覆盖时：seam=false，rea-mcp 行 effectiveDisabled=false，reaTools=170 常态驻留
# 正常时（关闭态）：seam=true，effectiveDisabled=true，reaTools=0
```

**修法一（手动）**：把 3.3 的 YAML 片段重新贴回 `rea-mcp` 行（先备份）。

**修法二（推荐，幂等）**：用仓库里的补缝脚本，它只做「检查 + 追加」，绝不重写文件：

```powershell
node scripts/ensure_seam.mjs                      # 读 $env:DSH_HOME
node scripts/ensure_seam.mjs --home "<DSH_HOME>"  # 或显式指定
```

行为与退出码：

| 情况 | 动作 | exit |
|---|---|---|
| 缝已在位 | 静默（不污染会话上下文） | 0 |
| 有 `id: rea-mcp` 行、缝缺失 | 先备份 `.bak-<时间戳>`，再**追加** | 0 |
| 找不到 `id: rea-mcp` 行 | 什么都不碰 | 3 |
| patch 文件 / `DSH_HOME` 缺失 | 报错 | 2 |

因为它静默且幂等，可以挂到会话启动钩子（`hooks.json`），让「跑完 setup」自动回填：

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command",
          "command": "node \"<本仓库路径>\\scripts\\ensure_seam.mjs\"" } ] }
    ]
  }
}
```

更省事的做法是把 `rea setup` 包一层，跑完顺手补缝：

```powershell
function rea-setup {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)
    & node "<npm 全局>/node_modules/rea-agents/scripts/rea.mjs" setup --client dsh @Rest
    if ($LASTEXITCODE -eq 0) { node "<本仓库路径>/scripts/ensure_seam.mjs" }
}
```

**补完必须重启一次 DSH 会话**：`disabled` 只在行装载时求值，重写后的行需要重新加载；只补文件不重启，当前会话里仍是旧行为。

> 本插件与 REA 版本无耦合（它只读状态文件），升级 REA **不需要**改插件代码。唯一要留意的是这条缝。

---

## 4. 使用方法

### 4.1 日常：点按钮

标题栏的 **`REA 开` / `REA 关`** 按钮，点一下即可。不需要重启。

### 4.2 让模型帮你切

```
把 REA 关掉，我在省钱          → 模型调用 rea_mcp_toggle {action:"set", enabled:false}
REA 现在开着吗？               → 模型调用 rea_mcp_toggle {action:"status"}
UI 按钮点了没反应，帮我看看     → 模型调用 rea_mcp_toggle {action:"selftest"}
```

### 4.3 关闭 / 禁用的几种情况

- **临时关**：点按钮。状态文件写 `enabled:false`，当前进程立即生效（工具消失、子进程回收）。
- **永久不再启用**：把手改的那段 `disabled: !!js` 缝从家目录层删掉（保留其余内容），该行即恢复为无条件启用。
- **升级 REA 后失效**：`rea setup --client dsh` 会把开关缝一起重写掉，补回方法见 3.5。
- **彻底卸载**：见第 8 节。

---

## 5. 输入输出示例

以下均为**真实运行结果**（本机实测，`compact` schema profile）。

### 5.1 查询状态

输入：

```json
{ "action": "status" }
```

输出（REA 关闭时）：

```text
REA MCP (rea-mcp) is OFF: the mcp__rea__* tools are not callable; the choice is saved.
entry=rea-mcp module=@deepseek-ai/dsh-mcp-client
enabled=false persisted=false tools=0 seam=true
stateFile=<PROFILE_DIR>\.rea-mcp-toggle.state.json
```

输出（REA 开启时）：

```text
REA MCP (rea-mcp) is ON: 170 tool(s); the choice is saved.
entry=rea-mcp module=@deepseek-ai/dsh-mcp-client
enabled=true persisted=true tools=170 seam=false
stateFile=<PROFILE_DIR>\.rea-mcp-toggle.state.json
```

> `seam=false` 是正常的：即时开启会清掉该行**进程内**的 `disabled` 键（`probe` 里显示 `rawDisabled=null`），开机时缝会重新求值（那时是 `seam=true`）。

### 5.2 关闭 REA

输入：

```json
{ "action": "set", "enabled": false }
```

输出：

```text
REA MCP (rea-mcp) is OFF: the mcp__rea__* tools are not callable; the choice is saved.
entry=rea-mcp module=@deepseek-ai/dsh-mcp-client
enabled=false persisted=false tools=0 seam=false
```

同时 `%DSH_PROFILE_DIR%\.rea-mcp-toggle.state.json` 变为：

```json
{ "enabled": false, "savedAt": "2026-10-13T17:59:27.803Z" }
```

### 5.3 开启 REA

输入：

```json
{ "action": "set", "enabled": true }
```

输出（子进程握手完成后）：

```text
REA MCP (rea-mcp) is ON: 170 tool(s); the choice is saved.
enabled=true persisted=true tools=170 seam=false
```

### 5.4 幂等：重复同向不发写

连续两次 `{ "action": "set", "enabled": false }`，第二次不会重写状态文件
（实测文件 `LastWriteTime` 与内容完全不变），也不会新增 patch 行。

### 5.5 诊断

输入：

```json
{ "action": "probe" }
```

输出（节选）：

```text
seam=false reaTools=0 stateFile=...\.rea-mcp-toggle.state.json
stateFileExists=true stateFileValue=false services={"loader":true,"tools":true,"typert":true,"pluginManager":true,"typertGateway":true}
row id=rea-mcp-toggle composite=include:rea-mcp-toggle module=dsh-rea-mcp-toggle rawDisabled=false effectiveDisabled=false fiberState=2 parentTree=include
row id=rea-mcp composite=include:rea-mcp module=@deepseek-ai/dsh-mcp-client rawDisabled=true effectiveDisabled=true fiberState=4 parentTree=include
```

读数要点：`effectiveDisabled=true` 且 `fiberState=4`（disposed）＝该行确实已停；
`reaTools=0` ＝ 模型侧看不到 REA 工具。

### 5.6 UI 自检（判断是 UI 坏还是 Host 坏）

输入：

```json
{ "action": "selftest" }
```

输出：

```text
gateway reaMcp/getState ok -> {...}
gateway reaMcp/setEnabled ok -> {...}
restoredTo=false
```

`selftest` 会先记住你的选择，结束后**原样恢复**（诊断不改变开关）。

### 5.7 安装后的效果对照

| 观察点 | 关闭 | 开启 |
|---|---|---|
| `Tool.listTools` 里 `mcp__rea__*` | 0 个 | 170 个 |
| `listTools` payload | ≈ 94.8 KB | ≈ 722.4 KB |
| 该实例的 REA 子进程 | 0 个 | 1 个 |
| 开销最大的部分 | — | 170 个工具 schema 进每次请求 |

---

## 6. 为什么不能用 profile 层的 `disabled`（关键设计决定）

DSH 的 patch 分层是：**bundle 层 → profile 层（`%DSH_PROFILE_DIR%\cordis.patch.yml`）→ 家目录层（`%DSH_HOME%\cordis.patch.yml`）→ `--patch` 覆盖**，后者覆盖前者。

`rea-mcp` 行是**家目录层**用 `insert` 声明的，而家目录层**最后**应用，`insert` 推入的是**新的行对象**。后果（用 Harness 自身的 `readProfilePatches` / `composeEntries` 复现，见 `scripts/probe-layer-order.mjs`）：

- profile 层写 `{ id: rea-mcp, disabled: true }` → 组合结果里 `rea-mcp` **从不带** `disabled`；
- 运行时 `Entry.disabled` 恒为 `false`；
- 连官方 `plugin_manager` 对该行也只能返回 `application: "overridden"`。

所以本插件的做法是：**状态放自己的文件**，家目录层只承担一个「缝」（`!!js` 表达式）。表达式在**读取** `disabled` 时才求值，因此不会被家目录层自己的 `insert` 盖掉。

---

## 7. 项目结构、已知限制与开发笔记

### 7.1 结构

```text
dsh-rea-mcp-toggle/
├─ package.json          # bundle 清单（dsh.bundle.patch / dsh.client）
├─ cordis.patch.yml      # 只插入本插件自己的行；不碰 rea-mcp 行
├─ index.js              # Host 半边：唯一实现（Remote reaMcp + 工具 rea_mcp_toggle）
├─ state.js              # 状态文件的唯一读写者（原子写）
├─ client.js             # 浏览器半边：标题栏开关按钮
├─ locale/{zh,en}.json   # 插件在插件列表里的显示名与描述
├─ icon.svg              # 图标
├─ .gitignore            # 排除 node_modules 链接、状态文件、机器本地的 .harness-root
├─ .harness-root.example # 「harness 装在哪」的模板（真实文件 .harness-root 由使用者创建）
└─ scripts/              # 安装辅助与验证脚本（不属于运行时，不随包发布）
   ├─ lib/harness-paths.mjs   # 定位 harness / profile：多级兜底，不硬编码任何本机路径
   └─ ensure_seam.mjs         # 幂等补缝：rea setup 覆盖开关缝后自动回填（见 3.5）
```

运行时**零依赖**：Host 半边只 import Node 内置模块（`node:fs`、`node:path`、`node:url`）与自身文件；`scripts/` 里的脚本才需要 DSH 安装提供的包。

### 7.2 已知限制

1. **作用域是「实例」**：开关作用于承载它的那个 Harness 进程。若机器上残留了旧的 Harness 守护进程（桌面应用重启时偶尔不退出），那些实例不受影响 —— 用任务管理器确认 `node.exe` 中带 `dsh\lib\bin.js` 的条目数量，多于 1 个即需清理。
2. **`disabled` 行必须放在行级**，写成 `config` 的子字段会导致该行永不生效（`--dump-config` 可看出层级）。
3. **上游遗留（不在本项目内）**：`@deepseek-ai/dsh-mcp-client` 的 `dispose()` 先取子进程句柄快照再 await；若拆卸时正好有连接在飞，那次连接会在快照之后写入新句柄，其子进程**不会被关闭**（每关一次可能残留一个孤儿 REA 进程）。该行本身确实是停的（fiber 已 dispose、工具为 0），残留进程只占内存、不向模型暴露工具，Harness 退出时回收。
4. **`selftest` 需要一次重启后才可用**（Host 模块按进程加载）。
5. **`rea setup --client dsh` 会覆盖开关缝**：上游把 `cordis.patch.yml` 当生成物整份重写，手写的 `disabled: !!js` 随之消失，开关静默失效。用 `scripts/ensure_seam.mjs` 幂等回填，见 3.5。

### 7.3 三个踩过的坑（写给后来者）

- **工具 `parameters` 必须是「干净」的 JSON Schema**：`ctx.tools.register()` 收的是 raw JSON Schema，会被**原样**发给 provider。若把作者侧的 `required: true` 标记写进属性里（`defineTool()` 那种写法），provider 会直接报
  `Invalid schema for function 'rea_mcp_toggle': true is not of type 'array'`，**每一轮都在调用工具之前就失败**。正确写法是可选属性不加标记、必填项放进对象级的 `required: ["action"]` 数组。
  仓库里保留了门禁脚本 `scripts/check-tool-schema.mjs`：它从 `index.js` 抽出 `parameters` 字面量，用 Harness 自己的 `assertSupportedJsonSchema` + 8 个参数用例（接受/拒绝各半）校验，防止再次漂移。

- **不要继承 `TypertRemoteService`**。它的构造器用 `bindTypertRemote(this, this.name)` 绑定，而 Cordis 的 `Service.name` 是 **symbol** 而非服务键字符串，导致网关校验失败：`Receiver must be an instance of class ...`。正确做法是普通类 + 显式绑定：

  ```js
  this.typertRemote = Object.freeze({ service: this, serviceKey: 'reaMcp', namespace: 'reaMcp' })
  ```

- **Remote 调用返回的是 `{ ok, value }` 信封**，客户端必须 `if (!result || result.ok !== true) throw ...` 后取 `result.value`；只判断 `ok === false` 会把信封当成结果，表现为「按钮点了没反应」。

- **无参端点要用空对象调用**：`gateway.invoke()` 的入参不能省略 `args`，要传 `args: {}`。省略时参数校验会抛 `Cannot convert undefined or null to object`（浏览器侧的 Remote 调用方始终发 `{}`，所以只有 Host 自检脚本会踩到）。

### 7.4 验证脚本

先跑一次 `node scripts/link-deps.mjs '<HARNESS_ROOT>'`：这些脚本用 Harness 自己的实现来验证（组合算法、YAML 方言、JSON Schema 检查器），依赖包通过**本包自己的 `node_modules` 链接**解析，不硬编码任何本机路径。之后在 profile 启动的 shell 里（有 `DSH_PROFILE_DIR` / `DSH_HOME`）可以**不带参数**直接跑：

```powershell
node --check index.js; node --check client.js; node --check state.js   # 语法
node scripts/check-tool-schema.mjs   # 工具 schema 门禁（Harness 自己的检查器 + 8 个用例）
node scripts/probe-layer-order.mjs   # 分层覆盖机制：profile 层 disabled 为何无效
node scripts/probe-composition.mjs   # 组合结果中该行是否带 disabled
node scripts/probe-seam.mjs          # 缝表达式 × Harness 真实 YAML 方言与求值器
node scripts/probe-roundtrip.mjs     # 真实写/读 × 缝读取，含「损坏文件」降级分支
node scripts/acceptance.mjs          # 缝与状态文件口径一致性
node scripts/ensure_seam.mjs --home "<DSH_HOME>"   # 补缝（幂等；已在位则静默）
```

不在 profile shell 里时，用参数显式给路径：

```powershell
node scripts/acceptance.mjs '<PROFILE_DIR>' '<DSH_HOME>'
```

---

## 8. 卸载 / 回滚

1. `plugin_manager` → `remove_bundle` → `dsh-rea-mcp-toggle`；
2. 删除家目录层里的 `disabled: !!js >- ...` 缝（**保留该行其余内容**），REA 即恢复为无条件启用；
3. 可选：删除 `%DSH_PROFILE_DIR%\.rea-mcp-toggle.state.json`。

## 9. 许可

[MIT](LICENSE) © 2026 [VioletEverGarden-zc](https://github.com/VioletEverGarden-zc)

`LICENSE` 使用 MIT 标准文本，版权人为 **VioletEverGarden-zc**；`package.json` 的 `license` 字段同样是 `MIT`，三者口径一致。

## 10. 作者与仓库

- 作者：**VioletEverGarden-zc** — <https://github.com/VioletEverGarden-zc>
- 仓库：<https://github.com/VioletEverGarden-zc/dsh-rea-mcp-toggle>
- 上游项目：**REA**（Reverse Engineer Anything）— <https://github.com/morluto/rea>。本插件只提供「开关」，REA 本体及其 `mcp__rea__*` 工具集由上游项目提供与维护（MIT）。

> 仓库 URL 按包名 `dsh-rea-mcp-toggle` 填写。若你实际建仓时用了别的名字，请同步替换 `package.json` 里的 `repository` / `homepage` / `bugs` 三处与本节链接。

## 11. 致谢

感谢 [REA](https://github.com/morluto/rea)（Reverse Engineer Anything）的作者与贡献者。本插件只是替它加了一只开关，逆向能力全部来自上游；没有 REA，这个项目没有存在的理由。
