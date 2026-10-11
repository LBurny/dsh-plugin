# dsh-plugin

[English](README.md) | 中文

给 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）用的小插件合集：一个功能一个包，每个都能单独安装，包与包互不依赖。所有功能都跑在 dsh 本体里，不用装额外的壳，也不用多养一个进程。

## 有哪些插件

一共八个，想用哪个装哪个。

| 包 | 做什么 | 命令 |
| --- | ------ | ---- |
| `dsh-features` | 侧栏的功能入口，位置在插件与自动化任务之间。它把已装的功能插件列成一排卡片，样式照 dsh 自己的插件页，点开进设置页，可拖拽排序。装了它，各面板角落里的浮动按钮就收进这个页面 | 无 |
| `dsh-skills` | 技能管理：启停、删除、导入，支持本地 ZIP 压缩包 | `/skills` |
| `dsh-mcp` | 管理当前 profile 的 MCP 服务：增删改、启停、导入 | `/mcp` |
| `dsh-doctor` | 给插件排障：进程内读 harness 自己的日志记录，逐行显示每个插件的激活状态，附实际存在的日志文件 | `/doctor` |
| `dsh-zoom` | 页面缩放，快捷键可以自己改 | `/zoom` |
| `dsh-notify` | 任务提醒：页面弹窗、随包音效、系统通知 | `/notify` |
| `dsh-remote` | 在手机上用 dsh：带鉴权的反向代理加二维码链接，可走局域网、Tailscale 组网或 Cloudflare 隧道，附移动端界面改写和项目浏览 | `/remote` |
| `dsh-init` | 为当前工作区生成或更新 `AGENTS.md`，dsh 会把它注入这里的每一个会话 | `/init` |

其中两个的位置有点特殊。

`dsh-features` 不是功能，是其余功能挂靠的基座，也是唯一带浏览器客户端的包，因为真正的侧栏入口只能由 dsh 客户端插件加。装了它，功能面板搬进它的页面；卸载它，浮动按钮原样回来。

`dsh-init` 是命令，不是功能：没有面板，基座也不会列它。它的提示词按 harness 真实的指令文件规则写，结果以一条折叠的上下文行进入会话，不占用户消息。

每个包都是普通的 dsh 插件：声明了 `dsh.bundle.patch`，`dsh plugin add` 会自动挂载。包之间互不 import，所以随便挑几个装都能用。

## 安装

两条路，同一套规格：桌面版的 **插件** 页，或终端里的 `dsh plugin add`。装完重启 dsh，插件没有热更新。

### 在桌面版里装

打开 **插件** 页，点 **添加插件**，粘一条规格，安装，再粘下一条。输入框接受包名、git 地址或本地目录路径。

```text
github:LBurny/dsh-plugin#path:/dsh-features
github:LBurny/dsh-plugin#path:/dsh-skills
github:LBurny/dsh-plugin#path:/dsh-mcp
github:LBurny/dsh-plugin#path:/dsh-doctor
github:LBurny/dsh-plugin#path:/dsh-zoom
github:LBurny/dsh-plugin#path:/dsh-notify
github:LBurny/dsh-plugin#path:/dsh-remote
github:LBurny/dsh-plugin#path:/dsh-init
```

`#path:/<包名>` 是 pnpm 指仓库子目录的写法；八个包同在同一个仓，所以每条都带。安装顺序无所谓。

这个页面有两件事值得知道。升级就是先卸载再装一遍：没有自动更新，想装到可复现的版本就在规格里钉上 commit（`#<sha>&path:/<包名>`）。GitHub 拉不动时，用页面的 **安装源** 换源重试：默认、npm 官方、中国大陆镜像或自定义。

### 在命令行里装

```bash
dsh plugin add github:LBurny/dsh-plugin#path:/dsh-skills
# 钉 commit：
dsh plugin add github:LBurny/dsh-plugin#<sha>&path:/dsh-skills
dsh plugin remove dsh-skills
```

用桌面版的话注意：它的 profile 叫 `desktop`，应用运行时由应用独占。先退出桌面版，再给上面的命令加上 `--profile desktop`。一般还是走上面的插件页更省事。

**在 Windows 上钉 commit。** `dsh plugin` 走应用自带的 `dsh.cmd` 垫片，cmd.exe 会吃掉 `#<sha>&path:/…` 里的 `&`，pnpm 只收到 `#<sha>` 就拒绝安装。钉版本请走应用的插件页，规格原样到达 pnpm；或者直接装不钉版本的分支规格。

**pnpm 拉不到 github.com 时。** pnpm 用自己的 TLS 栈，不认系统代理，遇到拦 TLS 的网络会报 `TypeError: fetch failed`。在 `$DSH_HOME/profiles/<profile>/.npmrc` 里写上你的代理：

```ini
https-proxy=http://127.0.0.1:7890
proxy=http://127.0.0.1:7890
```

也可以离线装：把包目录拷进 `$DSH_HOME/profiles/plugins/<包名>/`，再 add 那个目录路径。

## 约定

几条规矩让这套插件能凑在一起又不互相牵连。

- **天生独立。** 任何包都不 import 别的包，各自复制需要的那点辅助代码，某个包没装或版本落后都不影响别人。
- **DOM 层的唯一约定。** 角落的启动按钮停靠进共用的 `#dsh-launchers` 容器，面板靠发布的 `--dsh-launcher-stack` 高度避开它。
- **基座契约。** 功能插件把 `{ title, order, mount(host) }` 发布到 `window.__dshFeatures`，并在 package.json 里声明 `dsh.ui.feature`；基座据此就地挂载面板，并隐藏 `#dsh-launchers`。两个方向都没有 import。
- **双语面板，配色跟随主题。** 语言取自 `navigator.language`；配色优先用 dsh 自己的 `--dsw-alias-*` 令牌，取不到就回落到硬编码值，按 `prefers-color-scheme` 切换。

要改代码？先看 [AGENTS.md](AGENTS.md)，坑都写在那里。

## 测试

都是纯 Node，没有构建步骤。每个包自带一套测试，仓根另有五套跨包测试检查包之间的约定：

```bash
cd <包名> && node tests/<包名>.test.mjs   # 单个包自己的套件
node tests/hub-contract.test.mjs          # 仓级：基座契约
node tests/panel-embed.test.mjs           # 仓级：每个面板在有基座和没基座时都能起
node tests/mobile-layer.test.mjs          # 仓级：手机层的 DOM 行为
node tests/manifest.test.mjs              # 仓级：目录名即包名，裸导入都有声明
node tests/host-half.test.mjs             # 仓级：每个宿主半边都能挂载，路由、资产、命令都对
```

每套测试自己打印总数，要求是全过。

想把整套装在一起跑，用沙箱：一条命令在 `.sandbox/`（已被 gitignore，且拒绝碰你真实的 `~/.dsh`）起一个真 dsh，把本仓八个包都装上：

```bash
node tools/sandbox/sandbox.mjs up            # 首次：建目录、安装、启动并打印 URL
node tools/sandbox/sandbox.mjs up --restart  # 改完代码：重启正在跑的实例
node tools/sandbox/sandbox.mjs url           # 打印 URL（含令牌）
node tools/sandbox/sandbox.mjs down          # 停止
```

详见 [tools/sandbox/README.md](tools/sandbox/README.md)。界面长什么样测试断言不了，`tools/visual/` 里有截图工具，见其 README。

## License

MIT。`dsh-notify/lib/sounds/` 下的提示音来自 opencode 项目，原样随包分发。
