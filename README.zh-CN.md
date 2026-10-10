# dsh-plugin

[英文](README.md) | 中文

[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的独立小插件集合——一个功能一个包，每个都能单独安装。它们从 [DSHDesktop](https://github.com/LBurny/deepseek-harness-desktop) 的便利层中拆出，让同样的功能直接跑在 dsh 本体里：不需要桌面壳、不需要 Tauri、不需要额外进程。

## 插件

| 包 | 做什么 | 命令 |
| --- | ------ | ---- |
| `dsh-features` | 功能管理：基座插件——侧栏一项（在「插件」与「自动化任务」之间），把每个已安装的功能插件列成一行卡片（和 dsh 自己的「插件」页一样），点进去才是设置页，卡片可拖拽排序；装上它，浮动按钮就没了 | — |
| `dsh-skills` | 技能管理：启停 / 删除 / 导入，含本地 ZIP 压缩包 | `/skills` |
| `dsh-mcp` | 管理当前 profile 补丁层里的 MCP 服务：增删改 / 启停 / 导入 | `/mcp` |
| `dsh-doctor` | 诊断：版本、端口、PID、profile、日志尾部 | `/doctor` |
| `dsh-zoom` | 页面缩放，快捷键可重绑 | `/zoom` |
| `dsh-notify` | 任务提醒：页面弹窗、随包音效、系统通知 | `/notify` |
| `dsh-remote` | 手机远程访问：带鉴权的反向代理、二维码链接、可选 Cloudflare 隧道、移动端界面改写、「项目」浏览 | `/remote` |

每个包都是标准 dsh 插件：声明了 `dsh.bundle.patch`，所以 `dsh plugin add` 会自动挂上它那一层。它们互不 import，装哪个、装几个都行。

`dsh-features` 不是功能，而是其余包挂靠的**基座**：也是唯一带浏览器端的包（`dsh.client` → `assets/client.js`），因为真正的导航入口只能由 dsh 的客户端插件加。装了它，功能面板搬进基座的页面、浮动按钮消失；卸载它，按钮原样回来。

## 安装

```bash
dsh plugin --profile web add github:LBurny/dsh-plugin#path:/packages/dsh-skills
# 钉 commit：
dsh plugin --profile web add github:LBurny/dsh-plugin#<sha>&path:/packages/dsh-skills
dsh plugin --profile web remove dsh-skills
```

`--profile web` 是 DSHDesktop 壳的 profile，官方桌面版用 `--profile desktop`。面板「+ 安装」接受同一套规格，一次一条。

**Windows 上钉 commit。** `dsh plugin` 走的是应用自带的 `dsh.cmd` 垫片，cmd.exe 会把 `#<sha>&path:/packages/…`
里的 `&` 吃掉，pnpm 只拿到 `#<sha>` 就报参数非法。要么在应用的面板里钉（规格直给 pnpm），要么就装上面的分支规格。

装完重启 dsh——插件没有 HMR。

**pnpm 拉不到 github.com 时。** 它用自己的 TLS 栈、也不认系统代理，在拦过 TLS 的网络上会报 `TypeError: fetch failed`。给它一行 `$DSH_HOME/profiles/<profile>/.npmrc`，内容为 `https-proxy=http://127.0.0.1:7890` 与 `proxy=http://127.0.0.1:7890`；或者完全不联网：把包拷到 `$DSH_HOME/profiles/plugins/<包名>/`，再在面板里填绝对路径。

## 约定

- **从一开始就独立。** 任何包都不 import 别的包，各自复制所需的那点 layout/HTTP 辅助代码——某个包缺席、落后版本或未安装，都不会影响别人。
- **跨包约定都在 DOM 层。** 各插件的入口停靠进共用的 `#dsh-launchers` 角落容器，面板通过发布的 `--dsh-launcher-stack` 高度避开它。
- **基座约定。** 功能插件把自己的 `{ title, order, mount(host) }` 发布到 `window.__dshFeatures`，并在 package.json 里声明 `dsh.ui.feature`；基座据此就地挂载它，并隐藏 `#dsh-launchers`。双向都没有 import。
- **面板双语、配色跟随 dsh 主题。** 语言取自 `navigator.language`——刻意**不**读 dsh 的 `locale`，那要求每个包都去解析 profile patch；配色优先用壳自己的 `--dsw-alias-*` 令牌（所以跟着 dsh 的明暗设置走），取不到时回落到硬编码值并按 `prefers-color-scheme` 切换。
- **相比单包的 `dsh-desktop-kit`：** 没有页面错误上报，也没有兜底 `/init`。

改代码前值得知道的约定与坑写在 [AGENTS.md](AGENTS.md)。

## 测试

```bash
cd packages/<包名> && node test/<包名>.test.mjs
node test/hub-contract.test.mjs          # 仓级：基座约定，在仓根跑
node test/panel-embed.test.mjs           # 仓级：六个面板在装了基座时的行为
```

离线检查分别为 75（dsh-features）/ 60 / 20 / 23 / 23 / 38 / 73 项，另有 192 项仓级契约检查与
63 项跨包面板检查。`dsh-features` 的套件会**真跑**它的浏览器端（vm + 极简 React 打桩），所以侧栏槽位、
顺序、列表、点进去、拖拽排序与挂载交接不用浏览器也能断言；`panel-embed.test.mjs` 把六个功能面板的
浏览器脚本都放进 DOM 打桩里跑，证明装了基座时它们既不会挂浮动按钮、也不会多出第二个刷新控件。
`dsh-remote` 另有实时套件（`test/remote-live.mjs`），需要一个开着远程访问的沙箱实例。

## License

MIT。`packages/dsh-notify/sounds/` 的音效来自 opencode（经 DSHDesktop）；`packages/dsh-remote/assets/` 的移动端资产 vendored 自 DSHDesktop。
