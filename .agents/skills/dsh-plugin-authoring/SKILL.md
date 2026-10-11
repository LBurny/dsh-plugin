---
name: dsh-plugin-authoring
description: 给 dsh（deepseek-harness）写插件，斜杠命令、工具、提示词注入、服务/MCP 扩展，以及把插件装进 profile。主目标是官方 DeepSeek Harness 桌面版（在 App 的插件页装，或用它自带的 CLI 垫片 dsh.cmd），同样适用于任何 dsh profile；DSHDesktop 桌面壳只是次要目标。用户说"加个 /xxx 命令""做个 dsh 插件""这功能能做成插件吗""随包预装一个插件""插件怎么装/卸/为什么不生效"，或要给某个插件行加配置时，都用本技能。Use when creating, packaging, installing, or debugging a dsh (deepseek-harness) plugin (a cordis plugin module, bundle, profile row, slash command, or client UI plugin) for the official DeepSeek Harness desktop app or any dsh profile.
---

# 给 dsh 写插件

本技能住在本仓的 `.agents/skills/` 下，与它描述的 8 个活样板同仓；环境事实（含本仓在磁盘上的路径：文档里旧称 `dsh-plugin`，目录实际叫 `DSHPlugin`）见仓根 `AGENTS.md`。

dsh 是跑在 Cordis 依赖注入框架上的组合式应用：**一切功能都是一行插件**（row）。行写在 patch 文件里，patch 由 bundle 携带，bundle 由 profile 的 `dsh.profile.bundles` 列表按顺序叠加。所以"做插件"= 造一个携带 patch 的 npm 包，让 Node 能解析到它，profile 才会加载那一行。

## 1. 先看清三个名字（最容易混的地方）

以壳侧的 `/init` 插件 `dsh-command-init` 为例，同一个东西有四个名字：

| 名字 | 值 | 出现在哪 |
| --- | --- | --- |
| npm 包名 | `dsh-command-init` | `package.json` 的 `name`、profile 的 `dependencies` |
| 模块导出的 `name` | `command-init` | `index.js` 的 `export const name` |
| patch 行 `id` | `command-init` | `cordis.patch.yml` 的 `id:` |
| 斜杠命令名 | `init` | `ctx.commands.register({name:"init"})` |

行 `id` 是别的层按 id 覆盖你这行的把手，包名才是 Node 解析的键，两者写错的表现分别是"行没生效"和"import 失败"。

## 2. 选交付形态（决定你改哪个目录）

| 插件给谁用 | 形态 | 落点 | 怎么继续 |
| --- | --- | --- | --- |
| 官方 DeepSeek Harness 桌面版用户，自己在 App 插件页装/卸/更新 | 外部插件包（**主目标**） | 本仓（技能与 8 个活样板同仓），或任意独立仓库、npm | 本文档 §3 到 §6 足够 |
| 随 DSHDesktop 安装包发货、首启自动装好（如 `/init`） | 树内播种插件（**壳侧形态**，只在动壳仓 `H:\My_Software\DSHDesktop` 时用；官方桌面版没有播种机制，走插件页或 `dsh.cmd plugin`） | `src-tauri/resources/preseed-plugins/<包名>/` | 读 [references/repo-delivery.md](references/repo-delivery.md) |
| **只要关掉/改配置某个官方行**，且只给这台机器 | 不写代码 | `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 追加 `- id: <行 id>` + `disabled: true`（**禁用条目没有 `name:` 键**）。行 id 在"插入它的那个 bundle"的 `cordis.patch.yml` 里，按包名 grep 整个运行时即可定位，别在 `dsh-base` 里瞎找 | 见 §6 层顺序 |
| 同上，但要给**所有安装**默认关 | 壳启动 ensure 模块（**壳侧**） | `src-tauri/src/<name>.rs`，形态照 `picker.rs`：幂等追加同一条目，且**用户已显式写过这一行就退让**（否则是在跟用户对打） | repo-delivery §3；并先读 §8 的"关行前查消费方" |
| 不改行，只改某个**官方插件**的行为（如 `mcpgate` 摘门禁） | 壳内补丁模块（**壳侧**） | `src-tauri/src/<name>.rs` | 读 references/repo-delivery.md §3，那是另一套纪律（marker + 签名门控） |

先问自己"这东西要不要随安装包成为默认体验"。官方桌面版没有树内播种这条线，插件一律做外部包，走 App 插件页或 `dsh.cmd plugin add`；只有 DSHDesktop 壳才问这个问题，要随包就照 repo-delivery.md 做树内播种，不要就做外部包，别往 `resources/` 里塞。

## 3. 三件套骨架

复制 [assets/plugin-template/](assets/plugin-template/) 里的三个文件，按 §1 的对应关系替换名字。最小可用形态就这么多：

```
my-plugin/
├── package.json       # 声明 dsh.bundle，指向 patch
├── cordis.patch.yml   # 这一层插进去的行
└── index.js           # 行引用的插件模块
```

模板里七个占位符全部要替换（改完搜 `__[A-Z_]+__` 确认没有残留，别只搜 `__`，
文档里提 `window.__DSH_BOOT__` 之类会假红）：

| 占位符 | 替换成 | 约束 |
| --- | --- | --- |
| `__PLUGIN_PACKAGE__` | npm 包名 | 如 `dsh-command-init`；patch 行的 `name` 用它；**树内播种（壳侧）时目录名必须与它逐字相同**（见 repo-delivery §2） |
| `__PLUGIN_NAME__` | 模块导出的 `name` | 只用于 loader 诊断。惯例是"短名"，即包名去掉 `dsh-` 前缀（`dsh-command-init` → `command-init`），与行 `id` 相同 |
| `__ROW_ID__` | patch 行 `id` | 别与官方行 id 撞（撞了就是覆盖别人） |
| `__COMMAND_NAME__` | 斜杠命令名 | 小写、不带斜杠：`/^[a-z][a-z0-9_-]*$/` |
| `__COMMAND_DESCRIPTION__` | 命令描述 | 非空，出现在命令面板 |
| `__NOTICE_SUMMARY__` | 折叠行摘要 | **用户真正读到的那一行**，非空、≤120 字符；可以与描述不同（`/init` 就不同）。渲染器原样显示不截断，这是约定不是校验 |
| `__INPUT_HINT__` | 输入提示 | 非空字符串；**不带参数的命令可以整块删掉 `input`**（`input` 整体可选） |

**活样板优先于模板**：优先照本仓里那 8 个正在跑的插件，它们就是给官方桌面版跑的：`dsh-doctor\`、`dsh-skills\`、`dsh-init\`、`dsh-mcp\`、`dsh-notify\`、`dsh-remote\`、`dsh-zoom\`，加上基座 `dsh-features\`。第二个样板是壳侧的 `dsh-command-init`（`F:\DSHDesktop\preseed-plugins\dsh-command-init\`，随 DSHDesktop 安装包发货）。模板只是通用起点，两者已知差异（模板没写 `exports`；模板恒带 `private: true` 与 `files`，而 `/init` 省略 `files`，本地 `link:` 安装用不上它，要发 npm 才需要）。拿不准时照活样板。


`package.json` 的关键就是 `dsh.bundle` 这一段：**没有它，`dsh plugin add` 只会把它当普通依赖装，不挂任何层**（上游会打印一行 warning）：

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml` 是顶层 YAML 数组，行按 `name`（包名）解析：

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

要配置就用 `config:`，要一行多模块就引用子路径（`name: dsh-hello-plugin/startup`）。行级启停键是 `disabled: true`；`config` 是**整值替换不是深合并**，覆盖别人的行时要把需要的键重述全。

### 3.1 可选：插件在管理页的名字与描述（双语）

插件管理页/内置插件列表里官方插件都有标题和描述，来源是包内 `locale/` 目录（0.2.0 实测，如 `@deepseek-ai/dsh-experimental-auto-review/locale/`）：宿主 `readPluginMeta` 读 `locale/en.json` 同目录下**所有** `.json`（文件名 = 语言 id），取 `meta.title` / `meta.description` 组成语言映射下发，客户端按当前界面语言实时选取（切换即跟随）。没有 locale 目录时只剩包名。三件事缺一不可：

```jsonc
// package.json 的 exports 必须暴露 locale 与 package.json，
// 否则宿主按 ESM 解析失败、meta 整体 undefined（0.1.3 前的 /init 即此因）：
"exports": {
  ".": "./index.js",
  "./locale/*.json": "./locale/*.json",
  "./package.json": "./package.json"
}
```

```json
// locale/zh.json，与 locale/en.json 同构（英文文案）；目录里只放语言 json
{ "meta": { "title": "初始化命令", "description": "一句话描述，管理页卡片正文。" } }
```

`package.json` 的 `description` 字段只是 en 的回退（且要求 `./package.json` 可解析）；正式文案以 locale 文件为准。活样板：本仓 `dsh-doctor`、`dsh-skills` 的 `locale/`（壳侧的 `dsh-command-init` 也用了同一套）。

第四件同样缺一不可，而且只在装完之后才看得出来：**`files` 里要列 `locale`**。git / npm 分发会照 `files` 裁剪
（实测 2026-10-11：装出来的 `dsh-doctor` 副本有 `LICENSE`、`README.md`、`lib/`、`locale/`，没有 `tests/`
与 `README.zh.md`，说明 `files` 生效）。本地直接跑源码验证是发现不了这一条的：源码目录里 locale 在，装完
就没了，管理页退回包名。所以「本地看着对、装到 App 里名字变回包名」时先查 `files`，再查 `exports`。

## 4. 写插件模块（index.js）

Cordis 的插件契约就三个导出，`/init` 是这个形态的活样板（本仓 `dsh-init\lib\index.js`）：

```js
const name = "hello";
const inject = ["commands"];        // 需要哪些服务就列出来，Cordis 会等到位再调 apply
export { apply, inject, name };

function apply(ctx) {
  ctx.effect(function* () {          // 包一层是显式生命周期标签的写法，见下面第一条
    yield ctx.commands.register({ /* ... */ });
  }, "hello lifecycle");
}
```

- **必须 ESM**（`"type": "module"`）；只导出 `name` 没有 `apply` 的行是纯数据行。
- `ctx.commands.register()` / `ctx.tools.register()` **内部已经自带 effect 并返回 disposer**，
  裸调不会泄漏（官方工具插件多数就是裸调）。`/init` 外面包一层 `ctx.effect(..., "label")`
  是为了让生命周期在 loader 诊断里有名字，两种都行，选一种即可。
- `inject` 的服务名写错/不存在，那行永远不激活，而且不报错，这是"插件装了没反应"的第一个排查点。
- 需要延迟拿服务（对方也还在加载）用 `ctx.inject([...], (inner) => { ... })`。
- 配置校验用 `import z from "@deepseek-ai/schemastery"` 导出 `Config`；patch 行里的 `config:` 会先过它，**不合法 = 整行加载失败**，报错在 dsh 启动日志里。
- 要被 loader 等待的启动工作（就绪门禁相关）要写成显式 `async function apply`：Cordis 会把"带 prototype 的普通函数"当构造函数，返回的 Promise 不算启动工作。
- `peerDependencies` 一律写 `*`：dsh 的 0.1.x 是浮动区间，钉版本会在跟版时红。

## 5. 斜杠命令（最高频形态）

`ctx.commands.register()` 的定义要满足运行时校验：名字 `/^[a-z][a-z0-9_-]*$/`（不带斜杠）、
`description` 非空、`input.hint` 非空字符串、`attachments` 若给必须是布尔。重名注册会抛错。

**先查名字有没有被占**，一条命令搞定（在一份可读的运行时上 grep；本机那份是壳开发树
`H:\My_Software\DSHDesktop\src-tauri\runtime\windows-x64\dsh\node_modules\@deepseek-ai`，
官方 App 自带的那份埋在 `F:\Code\dsh\resources\app.asar` 里，要解包才 grep 得到）：

```bash
grep -rn -A3 "commands.register({" \
  "H:/My_Software/DSHDesktop/src-tauri/runtime/windows-x64/dsh/node_modules/@deepseek-ai" \
  --include=*.js | grep -o 'name: *"[a-z][a-z0-9_-]*"' | sort -u
```

别拿 `grep -r review` 这种裸词判断，上游的**功能名**与命令名重叠（0.1.6-alpha.1 有个
"Auto review" 是权限门，不是斜杠命令），会给你吓人的假阳性。

命令本身只会向用户回一行文本；**要模型真干活，得把提示词作为一条消息投给 agent**：

```js
import { createUserMessage } from "@deepseek-ai/dsh-llm";

function execute(invocation) {
  const cwd = invocation.agent?.session?.header?.cwd;   // workspace 根在这儿
  invocation.agent.followup(createUserMessage({
    content: [{ type: "text", text: renderPrompt(cwd, invocation.rawInput.trim()) }],
    source: { kind: "plugin:<包名>", form: "notice", summary: "≤120 字符的折叠行摘要" }
  }));
  return { kind: "success", text: "Prompt submitted" };
}
```

四条经验：

1. **注入提示词要用生产者自有的 kind**，形如 `{kind:"plugin:<包名>", form:"notice", summary}`。会话格式 V4 退役了通用的 `kind:"plugin"` 包装，直接用它会被拒绝，而被拒的写入会让整个回合失败，结果是命令注册成功却什么都不做。转录里渲染成气泡还是折叠行由 `source.kind` 决定：`kind:"user"` 一定是完整用户气泡（长提示词会很难看），其它 kind 渲染成一行可展开的上下文注入，模型仍收到全文。
2. handler **可以是 async**（注册表会 `await` 它的返回值），所以"查一下再回"不用愁；但**别在 handler 里阻塞 event loop**（`spawnSync`、长同步计算会卡住整个 dsh 服务进程），也用不着在这里等长任务，回合该投给 agent 跑。
3. 附件旗标 0.1.5 起叫 `input.attachments`（rc 时代叫 `images`）。用不到就别声明，两边都能跑。
4. 命令名、`description`、摘要都会原样出现在 UI 里，**语言跟 `/init` 保持一致（英文）**；
   但**提示词本身按用户要的语言写**，它是给模型看的，不是 UI 文案（中文任务就写中文提示词）。

其余扩展点（工具、提示词、技能、子代理、Web 路由、会话投影、客户端 UI、跑外部命令）见
[references/plugin-contract.md](references/plugin-contract.md)，那里有每个扩展点的注册调用和运行时可抄的真实样例路径。


## 6. 装、验、卸（外部插件）

### 主目标：官方 DeepSeek Harness 桌面版

`F:\Code\dsh\DeepSeek Harness.exe`（Electron）自带一份 dsh `0.2.0-rc.2`，打在 `resources/app.asar` 里；
它的 `DSH_HOME` 是 `C:\Users\intel\.dsh`，目标 profile 是 `desktop`（同一个 home 下还有个 `web`）。
它自带命令行垫片 `F:\Code\dsh\resources\runtime\cli\bin\dsh.cmd`。这个 CLI 从 App 运行时解析
`@deepseek-ai/*`，**不需要** `profiles/node_modules` 符号链接农场。

注意 `desktop` profile 被 App 独占：`--dump-config` 与直接启动都会被拒，报
`profile "desktop" is managed exclusively by the Electron application`；但 **`plugin` 子命令允许**管它。
CLI 自己也会提示：动它之前**先完全退出 App**。

**装（首选，走 App 界面）**：App 的**插件页 → 添加插件**，输入框接受包名、Git 仓库地址或本地目录路径，
例如：

```
github:LBurny/dsh-plugin#path:/dsh-skills
```

装完必须重启 dsh（没有 HMR）。

**装（命令行，或造沙箱）**：用自带的 `dsh.cmd`，几秒就能起一个干净沙箱，不用拷运行时：

```bash
export DSH_HOME='<临时目录>'                        # 全新 home
cd 'F:/Code/dsh/resources/runtime/cli/bin'
./dsh.cmd <profile> --from-default-profile web      # 从内置 web 模板生成 profile
./dsh.cmd plugin --profile <profile> add '<本仓路径>/dsh-skills'   # 也接受 npm / github 规格
./dsh.cmd <profile> --port <空闲端口> --no-open     # 真启动：打印 `dsh web: http://...` 即就绪行
```

- 新 home 首次打开会有 App 自己的"预览版说明"弹窗，先点继续才能敲 `/`。
- 就绪行只说明树起来了，**不代表你的行生效**：行级故障只打一行 `warning: N entries did not activate` 就继续启动，所以两件事都要看，见 §8。
- 要一个可反复折腾的长期沙箱，就用 `./dsh.cmd scratch --from-default-profile web` 造个自定义 profile。

几条硬事实：

- **先完全退出 App 再动 `desktop`**：App 独占该 profile，命令行 `plugin` 子命令也拒绝在 App 运行时改它。
- **官方版的插件页接受本地路径**：输入框接包名、Git 地址与本地目录路径，所以自研插件可以直接指过去，
  不必先手工拷进 home。
- **你的插件坏了，dsh 不会起不来，只会少那一行**（2026-10-10 实测，dsh `0.2.0-rc.1` 与 `rc.2` 各验一遍，
  四种坏法：行导入失败、模块求值抛异常、`apply` 抛异常、`dsh.profile.bundles` 里的 bundle 解析不到）。
  四种都只打一行 `dsh: warning: N entries did not activate` 加该行错误详情，然后**照常启动、照常服务**。
  所以"看到就绪行"**不等于**"你的插件生效了"：沙箱验证必须同时 grep 有没有 `did not activate`。
- **真正致命的只有官方那七个必需行 id**（`dsh-app-boot` 的 `requiredStartupEntryIds`）：
  `agent-loop webserver modules connection headless-runner acp sdk-jsonrpc-server`，另加 bootstrap
  include。只有它们不激活才会 `dsh: startup failed: N required plugins did not activate` 并非零退出。
  推论：**别把自己的行 id 取成这七个之一**，否则你的插件一坏就会连带让 dsh 起不来，对用户是灾难。
- **装完必须重启 dsh**：没有 HMR，插件页装/卸/更新同样要重启。
- **别手写 profile 清单**：`profiles/<profile>/package.json` 与 `cordis.patch.yml` 由上游对账，
  声明了 `dsh.bundle` 的依赖会被自动并进 `dsh.profile.bundles`，`remove` 时自动摘掉；你手写就会留下
  永远卸不掉的挂载点。用户自己的 `cordis.patch.yml` 只用来改行配置、禁用行、插本地行。
- 层顺序（后者按行覆盖前者）：bundle patch（按 `bundles` 列表顺序）→ profile 的 `cordis.patch.yml`
  → `$DSH_HOME/cordis.patch.yml` → `--patch` 覆盖。
- git 安装是"拿源码不是拿产物"：作者要带 `prepare` 构建脚本，用户要在 profile 的
  `pnpm-workspace.yaml` 里 `allowBuilds` 放行（等于同意在安装时执行它代码）。要免这一步就发 npm
  或 `pnpm pack` 的 tarball。

### 次要目标：DSHDesktop 桌面壳

壳是本机开发的 Windows 桌面版，`F:\DSHDesktop\dshdesktop.exe`，随包 dsh `0.2.0-rc.1`，
**home 是 `%LOCALAPPDATA%\DSHDesktop\dsh-home`（不是 `~/.dsh`）**，profile `web`。它没有官方 App
那样的插件页自由输入，预装插件也很少；它的 `profiles/node_modules` 是符号链接农场，插件源码必须放在
`$DSH_HOME/profiles/plugins/<包名>/`，否则 peer 依赖解析不到（实测原文）：

```
Cannot find package '@deepseek-ai/dsh-llm' imported from <你的插件目录>/index.js
```

手动跑命令时 `DSH_HOME` 不设就会装进另一个 home，壳里永远看不到：

```bash
export DSH_HOME='C:/Users/intel/AppData/Local/DSHDesktop/dsh-home'
RUNTIME=/f/DSHDesktop/runtime/windows-x64
"$RUNTIME/node.exe" "$RUNTIME/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" plugin --profile web add /abs/path/to/my-plugin
```

壳的树内播种、壳内补丁与拷贝运行时的沙箱干跑见 [references/repo-delivery.md](references/repo-delivery.md)。

## 7. 验证（三级，从便宜到贵）

**第一级，模块级自检，不用起 dsh**（[assets/plugin-selftest.mjs](assets/plugin-selftest.mjs)）：
用假 ctx 走一遍 `apply` 和 handler，抓"命令名不合法、忘导出 `apply`、注入源写成用户气泡、摘要超长、
handler 不返回结果"这类会让你那一行激活失败、功能静默缺失的低级错误（dsh 本身照常启动，见 §8）。前提是插件放在一个 peer 依赖解析得到的位置
（它自己 `import` 的 `@deepseek-ai/*` 必须在解析链上）：

```bash
"$RUNTIME/node.exe" .agents/skills/dsh-plugin-authoring/assets/plugin-selftest.mjs <插件目录>
# SELFTEST PASS / FAIL，退出码 0/1
```

**第二级，沙箱干跑**：官方桌面版按 §6 的 `dsh.cmd` 配方，临时 `DSH_HOME` 加 `--from-default-profile web`，
几秒起一个 home，`plugin add` 后在沙箱里真启动，**既看就绪行、也 grep 有没有 `did not activate`**（有就绪行不代表你的行生效，见 §8）。壳侧（要拷运行时）按
[references/repo-delivery.md](references/repo-delivery.md) §4。

**别每次重建沙箱**：生成 profile 与装包才是慢的那一步，而本地路径安装是 `link:`，改代码只要重启进程。
本仓 `tools/sandbox/` 就是干这个的：`node tools/sandbox/sandbox.mjs up`
建一次常驻沙箱（落在仓根 `.sandbox/`，已 gitignore），之后 `up --restart` 一条命令重载，
`url` 打印带令牌的地址，`down` 停掉。它给每条命令强制 `DSH_HOME`，并在装完后回读 profile 清单自检，
所以**不会**把包装进你自己的 `~/.dsh`（那是这套工具踩过的坑：`dsh plugin add` 少了 `DSH_HOME`
就会静默写进真实 home 并新建一个 profile）。

**第三级，装进真实环境**：官方桌面版走 App 插件页（§6 主目标），装 `desktop` 前先完全退出 App。
壳侧见 §6 次要目标与 repo-delivery §5。装进用户真实 home 之前一律先过前两级，真实 home 里的一次错装
要靠手工删 `node_modules` 收场。

### 7.1 改完代码就立刻看到（官方 App 的热重载）

App 装插件是 pnpm 从 git 拉的 tarball，落成
`<home>/profiles/<profile>/node_modules/dsh-*` 一份**真目录**，所以改你自己的工作树它看不见；
`tools/hotreload/` 那个工具就是补这一段的：`node tools/hotreload/hotreload.mjs up`
把工作树按内容镜像进这些副本（比字节差异，删除源里已无的文件），并常驻监听。`status` 看漂移，
`sync` 只镜像一次，`down` 停掉。要点（都是 2026-10-11 实测）：

- **客户端半边是真热**。`dsh-web-app` 挂了 `dsh-client-hmr`，每 500ms stat 每个 client bundle，重算 rev 并
  在 `/plugins/events` 上推 `rebuilt` 帧，浏览器就地换掉。改 `lib/client.js` 只要镜像到位即可，不用重启
  也不用刷页面，唯一代价是打开着的面板会掉（模块重新注册），重开一次。
- **宿主半边在 App 里热不了**。`dsh-base` 里 `dsh-hmr` 的 `root` 默认是空数组（模块根要显式 opt-in），而且
  没有 Node internals 就拒绝构造：`cordis-plugin-loader` 只在 `process.execArgv` 含 `--expose-internals` 时
  设 `loader.internal`。App 的启动器不带这个 flag，所以那一行本来只剩 profile 配置重载。工具会写 opt-in 块并
  用 `restart` 带 flag 重启 App，之后那行确实会打 `watching [...]`，**但模块写入仍然不触发重载**（写完轮询
  十秒，接口回的还是旧版本号）。同一份块在同一运行时下由 CLI 启动（沙箱）却是真重载，差别在启动器。所以工具
  对宿主改动是**重启 App**（约四秒，去抖），非 App 目标加 `--no-restart`。
- **块里的 `base` 必须是 file URL**：dsh 跑的是 `fileURLToPath(new URL(base, ctx.baseUrl))`，写 Windows 路径会
  变成 `h:` URL，那一行直接 `ERR_INVALID_URL_SCHEME` 死掉，症状只是启动日志里多一行 `did not activate`。

## 8. 坑清单（每条都踩过）

- **关行/改行之前先查谁在消费它**。禁用一行不是"少一个功能"这么便宜：被禁的行可能是某个资源的
  **唯一**认领者。实测例：`ui-sidebar-documentpreview` 是唯一声明 `patterns: ["dsh-resource://file/**"]`
  的类型，禁掉它之后，文件树里点文件、会话里点文件链接都会抛
  `sidebarRight: no registered tab type claims "..."`。所以先 grep 消费方（`ctx.xxx.open...`、
  类型的 `patterns`/`canOpen`），再把"关掉后什么不再工作"写进变更说明。
- **UI 行常常没有 `config` 开关**：纯客户端插件（host 半边 `apply()` 空转、不导出 `Config`）唯一的
  官方把手就是行级 `disabled`，想改它的默认值别指望 `config:`，那会被忽略。
- **bundle 层先于 profile 层**：想让"所有安装默认关"且**用户可覆盖**，就发在 bundle patch 里；
  想锁死就用壳启动 ensure（用户显式写过即退让）。顺序写反了会变成"用户改不动"或"改了就被冲掉"。
- **插件坏了，dsh 照常起，只是那一行不见了**（2026-10-10 实测两代 dsh、四种坏法：行导入失败、模块求值
  抛错、`apply` 抛错、`dsh.profile.bundles` 里 bundle 解析不到）。四种都只打一行
  `warning: N entries did not activate` 加该行详情。所以"dsh 起来了"不是验收判据，必须同时 grep 有没有
  `did not activate`。`plugin tree failed to load` 这个措辞确实存在，但它标的是挂载 patch 文档本身这一
  阶段失败，不是行级故障。真正致命的只有 `dsh-app-boot` 的 `requiredStartupEntryIds` 那七个官方行 id
  （`agent-loop webserver modules connection headless-runner acp sdk-jsonrpc-server`），所以永远别把自己的
  行 id 取成这七个。
- **行引用了包名但 Node 解析不到** → import 失败、该行不激活（一行 `warning: N entries did not activate`），dsh 照常启动。行 `name` 必须是**包名**（可带 `/子路径`），不是导出的 `name`。
- **忘了 `dsh.bundle`** → 装是装上了，层永远不挂，命令/工具永不出现，只有一行 warning。
- **`inject` 拼错服务名** → 静默不激活。排查顺序：`--dump-config` 有没有行 → dsh 启动日志有没有该行报错 → `inject` 对不对。
- **改了插件没生效** → 99% 是没重启 dsh；壳内嵌的 Web UI 也一样。
- **`kind:"user"` 渲染成大气泡** → 注入提示词的折叠行只认非 user 源。
- **客户端 UI 插件（`dsh.client` / `/plugins/<id>/client.js`）** 结构上支持（按包名扫描进 `window.__DSH_BOOT__`），但产物必须匹配 dsh 内部的客户端 bundle 格式，**没有公开的 out-of-tree 构建文档**。要改 UI 优先考虑服务端插件加壳的 `mobile.css/js` 注入；真要做客户端插件就去读壳开发树里的 `@deepseek-ai/dsh-client-modules/` 与任一同族包的 `exports["./client"]`。
- **上游文档比随包运行时旧**：本机 `H:\My_Software\DSH\deepseek-harness-master-rc.8\docs\user\develop\basic\`（`index.md` / `config.md` / `publish.md`，同目录有 `.zh.md`）是 `0.1.0-rc.8` 的文档，随包已经更靠前，已知漂移一处（附件旗标 `images` → `attachments`）。**冲突时以运行时真实代码为准**。没有官方脚手架，`create-*` 不存在，三件套自己抄。
- **改到壳依赖的上游事实**（入口、命令形、needle、行 id）→ 只改壳仓 `H:\My_Software\DSHDesktop` 的 `src-tauri/src/upstream.rs`，它是那侧的单一来源，`src-tauri/tests/upstream_contract.rs` 会逐项对真实运行时探测。

## 9. 交付前自检

- [ ] 三件套齐全，`package.json` 有 `dsh.bundle.patch` 且 patch 文件存在（树内播种有锚定测试盯着这条）
- [ ] 插件管理页的双语标题/描述齐了：`locale/{zh,en}.json` 带 `meta.title`/`meta.description`，
      `package.json` 的 `exports` 暴露 `./locale/*.json` 与 `./package.json`，`files` 里列 `locale`（§3.1）。
      本仓每个包都要有：缺任何一件，管理页就退回包名，仓根 `tests/hub-contract.test.mjs` 会拦下那个包
- [ ] patch 行的 `name` 与实际包名一致，行 `id` 不与官方行冲突；树内播种（壳侧）时目录名 = 包名
- [ ] 命令名没被占（§5 那条 grep），`inject` 列的服务名在运行时里真实存在
- [ ] `plugin-selftest.mjs` 通过（§7 第一级）
- [ ] 沙箱真启动有就绪行，且日志里没有 `did not activate`（§7 第二级）
- [ ] 树内插件（壳侧）：跑过 `cd src-tauri && cargo test`（`preseed.rs` 的锚定测试 + 上游契约），
      并在壳仓 `CHANGELOG.md` 的 `## [Unreleased]` 写了一行
- [ ] 行为性契约（比如必须用生产者自有的 source kind）落成锚定测试，别只写在文档里

## 10. 参考文件

- [references/plugin-contract.md](references/plugin-contract.md)：插件模块契约细节、全部扩展点及其真实样例、跑外部命令的两条路、客户端 UI 插件的声明形态、分发形态。
- [references/repo-delivery.md](references/repo-delivery.md)：壳侧的交付链（树内播种的 marker 语义、锚定测试、`tauri.conf` 映射、迁移顺序）、壳内补丁模块的纪律、沙箱干跑配方、播种证据三查。
- [assets/plugin-template/](assets/plugin-template/)：命令插件三件套骨架，复制后替换七个占位符。
- [assets/plugin-selftest.mjs](assets/plugin-selftest.mjs)：模块级自检脚本（§7 第一级）。
