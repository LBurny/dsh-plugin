# dsh-features

[English](README.md) | 中文

本仓功能插件的统一入口：侧栏一项「功能管理」，在「插件」与「自动化任务」之间。它的页面把每个已安装的
功能插件就地挂载进同一个外壳、风格统一，不再有一堆浮动按钮压住 dsh 界面。

它自己不是功能，而是其余 `dsh-*` 包挂靠的基座：页面、侧栏图标与样式是一份浏览器 bundle
（`lib/client.js`），由 dsh 自己的客户端模块系统加载——这是加一个真正的导航项的**唯一**途径。
它不依赖任何其它插件，其它插件不装它也照常工作。

## 安装

```bash
dsh plugin --profile web add github:LBurny/dsh-plugin#path:/dsh-features
```

`--profile web` 是 DSHDesktop 壳，`--profile desktop` 是官方桌面版；插件面板里装则不用带参数。
装完重启 dsh（插件没有 HMR）。

## 它做什么

- **侧栏一项真导航。** `sidebar.panellist`，`order: 5`；官方两项是「插件」（`0`）与「自动化任务」
  （`10`），该槽位按 `order` 排序。
- **一页承载所有功能。** 每个已安装的功能插件一行，和 dsh 自己的「插件」页一样（图标、名称、说明、
  箭头）。**点进去**才是该功能的设置页，头部有返回控件。卡片可拖拽排序，顺序存在 `localStorage`
  （`dsh-features:nav-order`）。**整页只有一个刷新控件**，在页头：它重扫清单并重挂当前功能。
  窄屏（<620px，手机远程视图）收窄边距。
- **统一外观。** 样式表隐藏 `#dsh-launchers`，并复用各功能面板已经在用的 `--dsh-*` 调色板，
  所以同一个功能在内嵌与浮窗里长得一样。颜色优先取壳的主题令牌（`--dsw-alias-*`，跟随 dsh 的
  深浅色设置），取不到才退回硬编码值。
- **失败也有名字。** profile 声明了、但浏览器半边没加载成功的功能会标成「已安装，但面板没加载」，
  而不是悄无声息地消失。注意「声明了」才是关键：只把包放进 `<DSH_HOME>/profiles/plugins/<名字>/`
  不算安装，也不会出现。

## 两条约定

除这两条外一切独立：没有共享模块，不 import 任何兄弟包。

**1. 功能把自己发布给基座**——这是它能出现在列表里、以及基座怎么挂载它的方式：

```js
window.__dshFeatures = Object.assign(window.__dshFeatures ?? {}, {
  doctor: {
    title: "诊断",                      // 侧栏标签（功能自己已本地化）
    icon: "M2 8.5h3l1.5-4 2.5 7 ...",   // 可选：16×16 描边 SVG path
    order: 30,                          // 默认顺序（读者的拖拽顺序优先）
    mount(host) { /* 渲染进 host */ }     // 每次进入都调用；必须可重挂
  }
});
```

**2. 功能为清单声明同一份信息**（只是元数据，让基座能报出脚本加载失败的那个功能）：

```json
"dsh": { "ui": { "feature": {
  "key": "doctor", "order": 30,
  "title": { "zh": "诊断", "en": "Doctor" },
  "summary": { "zh": "运行状态与日志尾部", "en": "Status and log tail" }
} } }
```

功能启动时还会探一下 `GET /dsh-features/api/status`：基座应了，它就不在自己角落挂按钮（界面已经能从
基座页到达）；路由不在（没装基座，或 profile 里没有这个包）时，浮窗照原样建起来。所以卸载本包，
浮动按钮就回来了。

## 测试

```bash
cd "$DSH_HOME/profiles/plugins/dsh-features"
node tests/hub.test.mjs
```

该套件会真跑浏览器半边（vm + 极简 React），所以侧栏槽位、顺序、皮肤、列表、钻取、拖拽顺序与
挂载交接都不用浏览器就能断言。仓根还有一个跨包套件：`node tests/panel-embed.test.mjs`。

## License

MIT.
