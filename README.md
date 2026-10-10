# dsh-plugin

一个功能一个插件。[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的独立小插件集合：
装哪个用哪个，每个都能单独工作。全部由 [DSHDesktop](https://github.com/LBurny/deepseek-harness-desktop)
的便利层移植而来，不依赖桌面壳、不依赖 Tauri、不需要额外进程。

| 包 | 做什么 | 命令 |
| --- | ------ | ---- |
| `dsh-skills` | 技能启停 / 删除 / 导入，含本地 ZIP 导入 | `/skills` |
| `dsh-mcp` | MCP 服务增删改 / 启停 / 导入 | `/mcp` |
| `dsh-doctor` | 诊断：状态、环境、日志尾部 | `/doctor` |
| `dsh-zoom` | 页面缩放 + 快捷键重绑 | `/zoom` |
| `dsh-notify` | 任务提醒：弹窗 + 音效 + 系统通知 | `/notify` |
| `dsh-remote` | 手机远程访问：鉴权代理 + 二维码 + 隧道 + 移动端界面 + 项目浏览 | `/remote` |

## 安装

```bash
dsh plugin --profile web add github:LBurny/dsh-plugin#path:/packages/dsh-skills
# 钉 commit：github:LBurny/dsh-plugin#<sha>&path:/packages/dsh-skills
dsh plugin --profile web remove dsh-skills
```

`--profile web` 是 DSHDesktop 壳的 profile，官方桌面版用 `--profile desktop`。装完重启 dsh（插件没有 HMR）。
面板「+ 安装」接受同一套规格，一次一条。

**pnpm 拉不到 github.com？** 它用自带 TLS 栈、也不认系统代理，在中间人拦过的网络上会报
`TypeError: fetch failed`。给它一行 `$DSH_HOME/profiles/<profile>/.npmrc`：

```
https-proxy=http://127.0.0.1:7890
proxy=http://127.0.0.1:7890
```

也可以完全不联网：把包拷进 `$DSH_HOME/profiles/plugins/<包名>/`，面板里填绝对路径。

## 约定

- 六个包**互不 import**，各自复制所需的 layout/HTTP 辅助代码——任何一个缺席或落后都不影响别人。
- 唯一跨包约定在 DOM 层：右下角 `#dsh-launchers` 容器 + `--dsh-launcher-stack` 变量。
- 面板双语取自 `navigator.language`，配色跟随 `prefers-color-scheme`；**不**读 dsh 的 `locale`/`ui-theme`
  （那要求每个包解析 profile patch，正是要避免的耦合）。
- 相比单包的 `dsh-desktop-kit`，这里没有页面错误上报，也没有兜底 `/init`。

更细的约定与踩过的坑见 [AGENTS.md](AGENTS.md)。

## 测试

```bash
cd packages/<包名> && node test/<包名>.test.mjs
```

离线检查：47 / 20 / 23 / 23 / 38 / 73 项；`dsh-remote` 另有实时套件 `test/remote-live.mjs`（需沙箱实例）。

## License

MIT。`packages/dsh-notify/sounds/` 的音效来自 opencode（经 DSHDesktop）；
`packages/dsh-remote/assets/` 的移动端资产 vendored 自 DSHDesktop。
