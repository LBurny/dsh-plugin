# dsh-remote 面板三段归组 Implementation Plan

> **For agentic workers:** Implement this plan in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 dsh-remote 面板从平铺长列改成"状态 / 隧道程序 / 链接"三段归组，消灭孤儿按钮（保存代理、关闭/重置链接）和不匀的竖向节奏。

**Architecture:** 只动 `dsh-remote/lib/client.js`（DOM 重排）和 `dsh-remote/lib/client.css`（包专属尾巴追加约 70 行）。共享样式块一个字节不动，其余五个包不受影响。无新依赖、无新文案（删掉一个不再用的 `qr` 键）、无接口变化。

**Tech Stack:** 手写 JS（无构建）、纯 DOM、Node 22 测试套件、tools/visual/shot.mjs 截图核对。

## Global Constraints

- `tests/hub-contract.test.mjs` 把六个面板 `client.css` 开头到 `.toast-title {` 的`}` 为止钉成字节一致：**所有新样式只能追加在该规则之后的包尾巴里**。
- `client.js` 非注释行不得出现 em dash（`—`）；文案零新增所以风险为零，注释也保持无 em dash 的仓库风格。
- 任何类名不得以 `hub-` 开头（hub 页面样式的前缀，面板禁用）。
- 以下字面量必须原样保留（hub-contract 用 `includes` 钉死）:
  - `inHub ? undefined : el("button", { "data-dsh-refresh": ""`
  - `function buildChrome(host = document.body, inline = false)`
  - `mount: mountInline`、`order: 30,`、`if (showLauncher()) buildLauncher();`
  - `el("div", { class: "row-name", text: name, title: name })` 和 row-sub 同款（在未使用的 `row()` helper 里，helper 保留）
- 缩进用 tab，与文件现状一致。
- 站立指令：全部改完后 `node tools/hotreload/hotreload.mjs sync` + `status`，面板改动不热更，须再 `restart`。
- 测试开启远程只用 LAN 模式；结束后 disable + reset-token；隧道是用户的决定，不作测试夹具。

---

### Task 1: 结构性断言（RED)

**Files:**
- Modify: `tests/panel-embed.test.mjs`（在 dsh-remote 安装检查块之后、`/* ---- dsh-zoom: a level save that fails is caught */` 之前插入）

**Interfaces:**
- Consumes: 文件内已有的 `bootPanel`、`descendants`、`check`、`linkedPayload`。
- Produces: 五条断言，钉死新结构的四条 DOM 事实 + 刷新按钮位置。

- [ ] **Step 1: 追加断言块**

```js
/* --------------------- dsh-remote: the sections stay grouped */

// The layout rule that keeps the page scannable: every action sits with the
// thing it acts on. The state card owns its own buttons, an input owns its
// save button, and the QR sits beside the link it encodes; nothing floats
// between sections.
const grouped = await bootPanel("dsh-remote", { payload: linkedPayload, timers: [] });
const stateRow = descendants(grouped.host).find((node) => node.className === "row");
check(
	stateRow !== undefined
		&& descendants(stateRow).some((node) => node.className === "row-actions"
			&& descendants(node).some((child) => child.tag === "button")),
	"dsh-remote: the state card carries its own buttons",
	""
);
check(
	descendants(grouped.host).every((node) => node.className !== "actions"),
	"dsh-remote: no loose action row floats between sections",
	""
);
const proxyInput = descendants(grouped.host).find((node) => node.tag === "input" && node.attrs?.placeholder === "http://127.0.0.1:7890");
check(
	proxyInput?.parent?.className === "input-row"
		&& proxyInput.parent.children.some((child) => child.tag === "button"),
	"dsh-remote: the proxy's save button sits in the input's own row",
	proxyInput?.parent?.className ?? "(no proxy input)"
);
const qrImage = descendants(grouped.host).find((node) => node.tag === "img");
check(
	qrImage?.parent?.className === "share"
		&& qrImage.parent.children.some((child) => child.className === "share-main"),
	"dsh-remote: the QR sits beside the link it encodes",
	qrImage?.parent?.className ?? "(no QR)"
);
const floatedRemote = await bootPanel("dsh-remote", { hub: false, mount: false, payload: linkedPayload, timers: [] });
const headRefresh = descendants(floatedRemote.dom.body).find((node) => node.hasAttribute("data-dsh-refresh"));
check(
	headRefresh?.parent?.className === "head",
	"dsh-remote: the standalone refresh lives in the panel head",
	headRefresh?.parent?.className ?? "(no refresh)"
);
```

- [ ] **Step 2: 运行确认五条全红、其余全绿**

Run: `node tests/panel-embed.test.mjs`（仓库根目录）
Expected: 退出码 1；上面五条 FAIL（今天状态卡没有 row-actions、`.actions` 存在、代理输入框的 parent 是 `field`、img 的 parent 是 `field`、刷新的 parent 是 `actions`）；其余 check 全 ok。

---

### Task 2: `client.js` 重排（GREEN)

**Files:**
- Modify: `dsh-remote/lib/client.js`（`renderRemote` 整体重写、 `buildChrome` 头部加刷新、STRINGS 删 `qr` 键）

**Interfaces:**
- Consumes: 现有 `act`、`linkRow`、`T`、`el`、状态变量（`remote`、`cloudflared`、`cloudflaredSetup`、`cloudflaredPath`、`qrPath`、`qrAvailable`）。
- Produces: 新 DOM 结构——`.section`（状态/隧道程序/链接三段）、`.block`（隧道程序卡）、`.line`、`.sep`、`.input-row`、`.share`、`.share-main`；Task 1 的五条断言转绿。

- [ ] **Step 1: 删 STRINGS 里的 `qr` 键**

`client.js:65` 删除整行 `qr: ["QR code", "二维码"],`（"二维码"小标题取消，二维码紧邻链接不言自明；`qrUnavailable` 保留）。

- [ ] **Step 2: 重写 `renderRemote`（替换现 356-461 行整体）**

要点（完整逻辑如下，逐段对应现状，文案与 act 调用不变）:

1. `label`/`tunnel` 计算、`remoteHint` note、`mode` select 及其 change 监听——原样保留，`mode` 声明提前到状态卡之前（开启按钮的 `mode.value` 闭包要用）。
2. **状态段**：`el("div", { class: "section" }, 状态.row, 通道.field, ...tailnet notes)`。状态卡 `row-main` 内容不变；`row-actions` 为：开启时 `[重置链接(danger, title=T("resetLinkHint"))][关闭]`，关闭时 `[开启(primary, onclick 带 mode: mode.value)]`。tailnet 三条说明 note 逻辑原样，append 进 stateSection。原来的 `.actions` 按钮行整体删除。
3. **隧道程序段**：条件 `remote.mode === "tunnel" || typeof cloudflared === "string"` 才建段（与现状的显示集合一致）。结构：`section > label(T("binary")) + .block`。block 内第一个孩子按状态三选一：
   - 已找到（`typeof cloudflared === "string"`):`.line > .row-main(row-name 已找到 + row-sub 路径·来源·版本, title=cloudflared) + .row-actions(cloudflaredPath !== "" 时有 自动查找 按钮)`
   - 检查/下载中：`.note`（文案同现状）
   - 缺失：`.note installErrorText()` + `.input-row > [路径 input][保存路径][帮我安装 primary]`
   
   然后 `remote.mode === "tunnel"` 时 `block.append(el("hr", { class: "sep" }), ...proxyField())`（三种状态都带，与现状"隧道模式必显示代理"一致）。
   
   `proxyField()` 是 `renderRemote` 内的新嵌套函数，返回数组（调用处展开）:

   ```js
   /** The download proxy: the save button sits in the input's own row, and Enter saves. */
   function proxyField() {
   	const proxy = el("input", { type: "text", value: remote.cloudflaredProxy ?? "", placeholder: T("proxyPlaceholder") });
   	const save = () => void act({ action: "cloudflared-proxy", proxy: proxy.value });
   	proxy.addEventListener("keydown", (event) => { if (event.key === "Enter") save(); });
   	return [
   		el("label", { text: T("proxyLabel") }),
   		el("div", { class: "input-row" }, proxy, el("button", { text: T("proxySave"), onclick: save })),
   		el("div", { class: "note", text: T("proxyHint") })
   	];
   }
   ```

   注意：真实 DOM 的 `append` 不收数组（会字符串化），所以必须 `...` 展开。`installErrorText` 嵌套函数原样保留。
4. **链接段**（`link !== undefined` 时）:`section > label(T("remoteLink")) + .share > [二维码 img 或 qrUnavailable note] + .share-main > [linkRow(link), linkKept note(仅 resumed), linkIsCredential note, hint note]`。img 的 src/alt/内联样式原样。不再单独给二维码一个 label。

- [ ] **Step 3: `buildChrome` 头部加刷新按钮**

```js
panel = el("div", { class: "panel", hidden: true },
	el("div", { class: "head" },
		el("div", { class: "title", text: T("title") }),
		// A standalone panel owns its refresh; embedded, the hub head has the only one.
		inHub ? undefined : el("button", { "data-dsh-refresh": "", text: T("refresh"), onclick: () => void render() }),
		el("button", { text: T("close"), onclick: toggle })),
	body);
```

`.head` 已是 flex + `.title { flex: 1 }`，两个按钮自然靠右，无需改 CSS。

- [ ] **Step 4: 运行测试转绿**

Run: `node tests/panel-embed.test.mjs && node tests/hub-contract.test.mjs && node tests/manifest.test.mjs && node tests/host-half.test.mjs && node tests/mobile-layer.test.mjs && (cd dsh-remote && node tests/cloudflared.test.mjs && node tests/proxy.test.mjs)`
Expected: 全部通过（panel-embed 退出码 0，hub-contract 最后一行 `N/N checks passed` 无 FAIL)。

---

### Task 3: `client.css` 包尾巴（视觉落地)

**Files:**
- Modify: `dsh-remote/lib/client.css`（在 `.toast-title` 规则之后追加）

**Interfaces:**
- Consumes: Task 2 产出的类名（`.section`、`.block`、`.line`、`.sep`、`.input-row`、`.share`、`.share-main`)。
- Produces: 段间距 18px 统一节奏；卡内 gap 10px；输入框+按钮同行；二维码并排窄屏换行。

- [ ] **Step 1: 追加尾巴**

```css
/* --------------------------------------------------------- section layout */

/* The content is up to three sections (state, tunnel binary, share) on one
   rhythm: the gap between sections is 18px and comes from the sections alone,
   because a section's last child carries no bottom margin. */
#dsh-remote-root .section {
	display: flex;
	flex-direction: column;
}

#dsh-remote-root .section + .section {
	margin-top: 18px;
}

#dsh-remote-root .section > :last-child {
	margin-bottom: 0;
}

/* A section heading, the same size and weight as a .field label. */
#dsh-remote-root .section > label {
	display: block;
	font-size: 13px;
	font-weight: 500;
	line-height: 1.5;
	color: var(--dsh-fg);
	margin: 0 0 6px;
}

/* A block is one card holding related things: the binary status line plus, in
   tunnel mode, the download proxy under a hairline divider. Children carry no
   margins; the flex gap owns the rhythm inside. */
#dsh-remote-root .block {
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding: 12px 14px;
	border: 1px solid var(--dsh-border);
	border-radius: var(--dsw-radius-md, 12px);
}

#dsh-remote-root .block > * {
	margin: 0;
}

#dsh-remote-root .block > label {
	display: block;
	font-size: 13px;
	font-weight: 500;
	line-height: 1.5;
	color: var(--dsh-fg);
}

/* One horizontal line inside a block: main text left, compact actions right. */
#dsh-remote-root .line {
	display: flex;
	align-items: center;
	gap: 14px;
}

#dsh-remote-root .sep {
	border: 0;
	border-top: 1px solid var(--dsh-border);
}

/* An input with its own action: the save button sits in the input's row. */
#dsh-remote-root .input-row {
	display: flex;
	align-items: center;
	gap: 8px;
}

#dsh-remote-root .input-row input {
	flex: 1;
	min-width: 0;
	width: auto;
}

#dsh-remote-root .input-row button {
	flex-shrink: 0;
}

/* The QR beside the link and its notes; on a narrow column the code wraps
   above the text. */
#dsh-remote-root .share {
	display: flex;
	align-items: flex-start;
	gap: 16px;
	flex-wrap: wrap;
}

#dsh-remote-root .share-main {
	flex: 1;
	min-width: 260px;
	display: flex;
	flex-direction: column;
}

#dsh-remote-root .share-main > :last-child {
	margin-bottom: 0;
}
```

- [ ] **Step 2: 确认共享块没被动到**

Run: `node tests/hub-contract.test.mjs`
Expected: 全绿（`sharedBlock` 只读到 `.toast-title` 的 `}`，尾巴不影响）。

---

### Task 4: 截图核对（三种形态)

**Files:**
- 无修改；用 `tools/visual/shot.mjs` 与浏览器核对。

- [ ] **Step 1: 夹具态（隧道模式 + 缺 binary + 有链接无 QR)**

```bash
node tools/sandbox/sandbox.mjs up        # 若没在跑；拿到 URL
node tools/visual/shot.mjs --url "$URL" --sizes 1080x900 390x844 --panel dsh-remote --theme dark
node tools/visual/shot.mjs --url "$URL" --sizes 1080x900 --panel dsh-remote --theme light
```

核对点：状态卡右侧有自己的按钮；缺 binary 卡内是 说明 → 路径输入行（输入框+保存路径+帮我安装同行）→ 分隔线 → 代理输入行；链接段 qrUnavailable 说明在左、链接卡在右；390px 下换行不溢出；亮色下对比正常。

- [ ] **Step 2: 沙盒活态（LAN 开启 + 有链接有 QR)**

```bash
TOKEN=$(node -e "console.log(require('./.sandbox/sandbox.state.json').token)")
node tools/sandbox/sandbox.mjs up --restart
curl -s -X POST -H "content-type: application/json" -d '{"action":"enable","mode":"lan"}' \
  "http://127.0.0.1:25499/dsh-remote/api/remote?token=$TOKEN"   # 不回显应答（含链接）
```

用 Playwright 打开沙盒 URL → 侧栏 功能管理 → 手机远程：桌面宽（1440）与 390x844 各截一张。核对：二维码左置、链接卡与三条说明在右列；390px 时二维码在上文字在下；状态卡按钮在卡内。

- [ ] **Step 3: 活套件 + 清理**

```bash
cd dsh-remote && node tests/remote-live.mjs <baseUrl> <proxyPort> <token>   # proxyPort 从 enable 应答解析，不打印
cd .. && for action in disable reset-token; do curl -s -X POST -H "content-type: application/json" \
  -d "{\"action\":\"$action\"}" "http://127.0.0.1:25499/dsh-remote/api/remote?token=$TOKEN"; done
```

Expected: remote-live 全过；端口已释放。若沙盒里 remote-live 前置条件不齐（如 qrcode），记录原因即可，本改动不碰代理层。

---

### Task 5: 送进安装好的应用并核对

- [ ] **Step 1: 镜像 + 重启**

```bash
node tools/hotreload/hotreload.mjs sync
node tools/hotreload/hotreload.mjs status    # 每个包都要 in sync
node tools/hotreload/hotreload.mjs restart   # 面板 client.js 不热更，必须重启
```

restart 后确认进程在（`tasklist | findstr DeepSeek`），单实例竞争输了就手动拉起。

- [ ] **Step 2: 应用内核对（用户截图同款状态：隧道模式 + 已找到 cloudflared + 有链接有 QR)**

Playwright 打开应用 → 功能管理 → 手机远程，截图核对：隧道程序卡内上半是"已找到"行、分隔线、代理输入行（保存代理贴输入框右侧）；链接段二维码左置。这张截图回传给用户。

---

## Self-Review

- **Spec coverage**: 保存代理内联 → Task 2 Step 2 第 3 点 + Task 1 断言 3；关闭/重置链接归位 → Task 2 第 2 点 + 断言 1；节奏统一 → Task 3 `.section` 规则；二维码并排 → Task 2 第 4 点 + 断言 4；刷新挪头部 → Task 2 Step 3 + 断言 5；回车保存 → proxyField。
- **Placeholder scan**: 无 TBD；所有代码块完整。
- **Type consistency**: 类名七个在两处文件间一致；`proxyField` 只在 Task 2 定义并使用。
- **Length**: 约 220 行，在预算内。
- **遗留风险**: 缺 binary 时 `[input][保存路径][帮我安装]` 三件套在 390px 可能偏挤 → Task 4 Step 1 的窄屏截图专门核对这个，真挤再把"帮我安装"挪到卡内下一行。
