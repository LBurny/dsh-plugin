# dsh-plugin

[英文](README.md) | 中文

[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的独立小插件集合：一个功能一个包，每个都能单独安装。从 [DSHDesktop](https://github.com/LBurny/deepseek-harness-desktop) 的便利层拆出，让同样的功能直接跑在 dsh 本体里：不要桌面壳，不要 Tauri，不要额外进程。

## 插件

| 包 | 做什么 | 命令 |
| --- | ------ | ---- |
| `dsh-features` | 功能管理基座：侧栏一项（在插件与自动化任务之间），把每个已装的功能插件列成一行卡片，样式同 dsh 自己的插件页，点进去是设置页，卡片可拖拽排序。装上它，浮动按钮消失 | 无 |
| `dsh-skills` | 技能管理：启停 / 删除 / 导入，含本地 ZIP 压缩包 | `/skills` |
| `dsh-mcp` | 管理当前 profile 补丁层里的 MCP 服务：增删改 / 启停 / 导入 | `/mcp` |
| `dsh-doctor` | 诊断：版本、端口、PID、profile、日志尾部 | `/doctor` |
| `dsh-zoom` | 页面缩放，快捷键可重绑 | `/zoom` |
| `dsh-notify` | 任务提醒：页面弹窗、随包音效、系统通知 | `/notify` |
| `dsh-remote` | 手机远程访问：带鉴权的反向代理、二维码链接、可选 Cloudflare 隧道、移动端界面改写、项目浏览 | `/remote` |

每个包都是标准 dsh 插件：声明了 `dsh.bundle.patch`，`dsh plugin add` 会自动挂上它那一层。包与包互不 import，装哪个、装几个都行。

`dsh-features` 不是功能，是其余包挂靠的基座，也是唯一带浏览器端的包（`dsh.client` → `lib/client.js`），因为真正的导航入口只能由 dsh 客户端插件加。装了它，功能面板搬进基座页面，浮动按钮消失；卸载它，按钮原样回来。

## 安装

每个包单独装，两条路用同一套规格：桌面版的插件页，或命令行 `dsh plugin add`。装完重启 dsh，插件没有 HMR。

### 在桌面版的插件管理里一条条装

官方桌面版自己管 `desktop` 这个 profile，命令行改不动它。打开插件页，点添加插件，粘一条规格安装，装完再粘下一条。输入框接受包名、Git 仓库地址或本地目录路径。

```text
github:LBurny/dsh-plugin#path:/dsh-features
github:LBurny/dsh-plugin#path:/dsh-skills
github:LBurny/dsh-plugin#path:/dsh-mcp
github:LBurny/dsh-plugin#path:/dsh-doctor
github:LBurny/dsh-plugin#path:/dsh-zoom
github:LBurny/dsh-plugin#path:/dsh-notify
github:LBurny/dsh-plugin#path:/dsh-remote
```

`#path:/<包名>` 是 pnpm 的仓库子目录写法，七个包同仓，所以每条都带。顺序无所谓，只装几个也行。把 `dsh-features` 也装上，各功能面板就搬进它那唯一的侧栏入口，不再各挂一个浮动按钮。钉 commit 的规格在这里不用转义，`&` 被吃掉是命令行的坑，不是这个页面的。

页面自己会提醒两件事。升级是先卸载再装新版，没有自动更新，修复靠重装规格拿到，想可复现就钉 commit。GitHub 拉不动时，用页面的安装源换源重试：默认、npm 官方源、中国大陆镜像源、自定义地址。

### 从命令行装

```bash
dsh plugin --profile web add github:LBurny/dsh-plugin#path:/dsh-skills
# 钉 commit：
dsh plugin --profile web add github:LBurny/dsh-plugin#<sha>&path:/dsh-skills
dsh plugin --profile web remove dsh-skills
```

`--profile web` 是 DSHDesktop 壳的 profile，桌面版的 profile 走上面的页面。

**Windows 上钉 commit。** `dsh plugin` 走应用自带的 `dsh.cmd` 垫片，cmd.exe 会吃掉 `#<sha>&path:/dsh…` 里的 `&`，pnpm 只拿到 `#<sha>` 就报参数非法。在应用页面里钉，规格直给 pnpm；或者直接装上面的分支规格。

**pnpm 拉不到 github.com 时。** 它用自己的 TLS 栈，不认系统代理，拦过 TLS 的网络会报 `TypeError: fetch failed`。在 `$DSH_HOME/profiles/<profile>/.npmrc` 里写 `https-proxy=http://127.0.0.1:7890` 和 `proxy=http://127.0.0.1:7890`；或者干脆离线装：把包拷进 `$DSH_HOME/profiles/plugins/<包名>/`，再 add 那个目录路径。

## 约定

- **从一开始就独立。** 任何包都不 import 别的包，各自复制所需的那点 layout/HTTP 辅助代码，某个包缺席、落后或未装都不影响别人。
- **跨包约定都在 DOM 层。** 各插件入口停靠进共用的 `#dsh-launchers` 角落容器，面板通过发布的 `--dsh-launcher-stack` 高度避开它。
- **基座约定。** 功能插件把 `{ title, order, mount(host) }` 发布到 `window.__dshFeatures`，并在 package.json 里声明 `dsh.ui.feature`；基座据此就地挂载，并隐藏 `#dsh-launchers`。双向都没有 import。
- **面板双语，配色跟随 dsh 主题。** 语言取自 `navigator.language`，刻意不读 dsh 的 `locale`，否则每个包都要解析 profile patch。配色优先用壳自己的 `--dsw-alias-*` 令牌，跟着 dsh 的明暗设置走，取不到时回落到硬编码值并按 `prefers-color-scheme` 切换。
- **相比单包的 `dsh-desktop-kit`：** 没有页面错误上报，也没有兜底 `/init`。

改代码前先看 [AGENTS.md](AGENTS.md) 里的约定与坑。

## 测试

```bash
cd <包名> && node tests/<包名>.test.mjs
node tests/hub-contract.test.mjs          # 仓级：基座约定，在仓根跑
node tests/panel-embed.test.mjs           # 仓级：装了基座时六个面板的行为
node tests/mobile-layer.test.mjs          # 仓级：手机增强层的 DOM 行为
```

离线检查分别为 88（dsh-features）/ 60 / 20 / 23 / 23 / 38 / 99 项，另有 279 项仓级契约检查、78 项跨包面板检查与 7 项手机增强层检查。`dsh-features` 的套件会真跑它的浏览器端（vm 加极简 React 打桩），侧栏槽位、顺序、列表、点进、拖拽排序与挂载交接不用浏览器也能断言。`panel-embed.test.mjs` 把六个功能面板的浏览器脚本放进 DOM 打桩里跑，证明装了基座时它们不挂浮动按钮，也不多出第二个刷新控件。`tools/visual/` 是截图工具，专看这些数字看不见的排版问题，见其 README。`dsh-remote` 另有实时套件（`tests/remote-live.mjs`），需要一个开着远程访问的沙箱实例。

## License

MIT。`dsh-notify/lib/sounds/` 的音效来自 opencode（经 DSHDesktop）；`dsh-remote/lib/assets/` 的移动端资产 vendored 自 DSHDesktop。
