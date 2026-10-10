/**
 * dsh-features — browser half: the 功能管理 sidebar entry, its page, and the skin
 * the feature panels are rendered in.
 *
 * This file is NOT an ES module and Node never imports it. dsh's client module
 * system serves it to the browser as a classic script; the host finds it through
 * `dsh.client` plus `exports["./client"]` in package.json. Hence the
 * `__ModuleLoader__.load` wrapper every client bundle in the tree uses, and the
 * inlined dictionary (a browser bundle cannot read the package's `locale/*.json`
 * at runtime — the official bundles inline theirs for the same reason).
 *
 * Two DOM-level conventions couple this plugin to the feature packages. Both are
 * written down in the repository's AGENTS.md, because they are the whole
 * interface:
 *
 *   `window.__dshFeatures`  the registry a feature panel publishes itself to:
 *                           `{ [key]: { title, summary, order, mount(host) } }`.
 *                           The hub mounts the selected feature by calling
 *                           `mount` with a plain div it owns.
 *   `#dsh-launchers`        hidden while this plugin is installed: one page
 *                           listing every feature replaces the corner buttons.
 *
 * Nothing here reads dsh's internal CSS classes or module table — the sidebar
 * entry, the page and the skin use only the documented slot API and the
 * platform's own icon set.
 */
window.__ModuleLoader__.load({
	id: "dsh-features",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let React = require("react");
		/**
		 * The shell's primitives are a platform seed module (always resolvable, not
		 * a dependency of this package), but an older shell may not export the icon
		 * wanted below. Degrade to the inline glyph rather than fail.
		 */
		let primitives;
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch {
			primitives = undefined;
		}

		/** Dictionary namespace owned by this plugin. */
		const NS = "features";
		/** The sidebar entry's `id` and the `main` slot's `key` — they must match. */
		const PANEL_ID = "features";
		/** Routes the host half serves (see index.js). */
		const API = "/dsh-features/api";
		/**
		 * Sidebar position. The official entries are 插件 (`order: 0`) and
		 * 自动化任务 (`order: 10`, dsh-client-ui-schedule); the sidebar sorts this
		 * slot by `order`, so 5 lands between the two.
		 */
		const ORDER = 5;
		/** Services this client plugin needs before `apply` runs. */
		const inject = ["slots", "locale"];

		/* ---------------------------------------------------------------- words */

		const zh = {
			"panel": "功能管理",
			"subtitle": "本仓插件的统一入口：一个页面查看与设置全部功能",
			"loading": "正在加载…",
			"refresh": "刷新",
			"empty": "没有检测到功能插件。",
			"emptyHint": "安装任意 dsh-* 功能插件后，它会自动出现在这里。",
			"unloaded": "已安装，但它的面板脚本没有加载（重启 dsh 后再试）。",
			"failed": "面板加载失败"
		};
		const en = {
			"panel": "Features",
			"subtitle": "One home for this repository's plugins: see and configure every feature here",
			"loading": "Loading…",
			"refresh": "Refresh",
			"empty": "No feature plugins found.",
			"emptyHint": "Install any dsh-* feature plugin and it appears here on its own.",
			"unloaded": "Installed, but its panel script did not load (restart dsh and retry).",
			"failed": "The panel failed to load"
		};

		/* ----------------------------------------------------------------- skin */

		const STYLE_ID = "dsh-features-skin";
		/**
		 * The one stylesheet this plugin owns. The token palette is the same one the
		 * feature panels define under their own roots, so a feature mounted here looks
		 * identical to its standalone panel — the hub adds the frame, not a second
		 * look. Every colour prefers the shell's own theme token (`--dsw-alias-*`,
		 * which follows dsh's light/dark setting rather than the OS) and falls back to
		 * the value the feature panels hardcode. Only `#dsh-launchers` is touched
		 * outside this plugin's root, and deliberately so.
		 */
		const SKIN = `
#dsh-launchers { display: none !important; }

#dsh-features-root {
	--dsh-bg: var(--dsw-alias-bg-base, #ffffff);
	--dsh-fg: var(--dsw-alias-label-primary, #1c1f23);
	--dsh-muted: var(--dsw-alias-label-caption, #6b7280);
	--dsh-border: var(--dsw-alias-border-l2, #e4e6eb);
	--dsh-hover: var(--dsw-alias-interactive-bg-hover, #f3f4f6);
	--dsh-accent: #4d6bfe;
	--dsh-danger: #d64545;
	display: flex;
	flex-direction: column;
	height: 100%;
	min-height: 0;
	font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
	color: var(--dsh-fg);
}

@media (prefers-color-scheme: dark) {
	#dsh-features-root {
		--dsh-bg: var(--dsw-alias-bg-base, #1e2126);
		--dsh-fg: var(--dsw-alias-label-primary, #e8eaed);
		--dsh-muted: var(--dsw-alias-label-caption, #9aa0a6);
		--dsh-border: var(--dsw-alias-border-l2, #34383e);
		--dsh-hover: var(--dsw-alias-interactive-bg-hover, #2a2e34);
	}
}

#dsh-features-root,
#dsh-features-root * {
	box-sizing: border-box;
}

#dsh-features-root .head {
	display: flex;
	align-items: flex-start;
	gap: 12px;
	padding: 18px 22px 12px;
}

#dsh-features-root .head .titles {
	flex: 1;
	min-width: 0;
}

#dsh-features-root .head h1 {
	font-size: 15px;
	font-weight: 600;
	margin: 0 0 4px;
}

#dsh-features-root .head p {
	color: var(--dsh-muted);
	font-size: 12px;
	margin: 0;
}

#dsh-features-root button {
	font: inherit;
	color: inherit;
	background: transparent;
	border: 1px solid var(--dsh-border);
	border-radius: 8px;
	padding: 5px 10px;
	cursor: pointer;
}

#dsh-features-root button:hover {
	background: var(--dsh-hover);
}

#dsh-features-root .rail {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	padding: 0 22px 12px;
	border-bottom: 1px solid var(--dsh-border);
}

#dsh-features-root .tab {
	border-radius: 999px;
	padding: 5px 12px;
	white-space: nowrap;
}

#dsh-features-root .tab[data-active="true"] {
	border-color: var(--dsh-accent);
	color: var(--dsh-accent);
	background: color-mix(in srgb, var(--dsh-accent) 10%, transparent);
}

#dsh-features-root .stage {
	flex: 1;
	min-height: 0;
	overflow: auto;
	padding: 16px 22px 24px;
}

#dsh-features-root .stage-head {
	display: flex;
	align-items: baseline;
	gap: 10px;
	flex-wrap: wrap;
	margin-bottom: 12px;
}

#dsh-features-root .stage-title {
	font-weight: 600;
}

#dsh-features-root .note {
	color: var(--dsh-muted);
	font-size: 12px;
	margin: 0;
}

#dsh-features-root .empty {
	border: 1px dashed var(--dsh-border);
	border-radius: 10px;
	padding: 16px;
	color: var(--dsh-muted);
	font-size: 12px;
}

#dsh-features-root .empty p {
	margin: 0 0 6px;
}

#dsh-features-root .empty p:last-child {
	margin-bottom: 0;
}
`;

		if (document.getElementById(STYLE_ID) === null) {
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = SKIN;
			document.head.append(style);
		}

		/* ----------------------------------------------------------- components */

		/** Pick the reader's language out of a `{zh, en}` pair of strings. */
		function pickText(value) {
			if (typeof value === "string") return value;
			if (value === null || typeof value !== "object") return undefined;
			const zhFirst = String(navigator.language ?? "").toLowerCase().startsWith("zh");
			return value[zhFirst ? "zh" : "en"] ?? value.en ?? value.zh;
		}

		/**
		 * Merge the two sources into what the page renders. The registry knows what
		 * it can mount and carries the feature's own already-localized title; the
		 * inventory knows what is installed. A key only in the inventory is an
		 * installed-but-unloaded feature, which the page says out loud.
		 * @param registry - `window.__dshFeatures`.
		 * @param inventory - the host half's entries.
		 * @returns merged, ordered feature descriptors.
		 */
		function mergeFeatures(registry, inventory) {
			const byKey = new Map();
			for (const item of inventory ?? []) {
				if (typeof item?.key !== "string") continue;
				byKey.set(item.key, {
					key: item.key,
					title: pickText(item.title),
					summary: pickText(item.summary),
					order: typeof item.order === "number" ? item.order : 100,
					package: item.package
				});
			}
			for (const [key, entry] of Object.entries(registry ?? {})) {
				const existing = byKey.get(key) ?? { key, order: 100 };
				byKey.set(key, {
					...existing,
					title: typeof entry?.title === "string" ? entry.title : existing.title,
					summary: typeof entry?.summary === "string" ? entry.summary : existing.summary,
					order: typeof entry?.order === "number" ? entry.order : existing.order,
					mount: typeof entry?.mount === "function" ? entry.mount : undefined
				});
			}
			return [...byKey.values()].sort((left, right) => left.order - right.order || left.key.localeCompare(right.key));
		}

		/**
		 * Read the feature list, from the host inventory plus the live registry.
		 * @returns `[snapshot, reload]`.
		 */
		function useFeatures() {
			const [snapshot, setSnapshot] = React.useState({ loading: true, features: [] });
			const [nonce, setNonce] = React.useState(0);
			React.useEffect(() => {
				let live = true;
				const scan = async () => {
					let inventory = [];
					try {
						const answer = await fetch(`${API}/features`, { credentials: "same-origin" }).then((response) => response.json());
						if (answer?.ok === true) inventory = answer.features;
					} catch {
						/* the page works from the registry alone */
					}
					if (live) setSnapshot({ loading: false, features: mergeFeatures(globalThis.__dshFeatures, inventory) });
				};
				void scan();
				// A feature's browser half lands after the shell boots; one late rescan
				// covers a page opened in the same second as the boot.
				const timer = setTimeout(scan, 1500);
				return () => {
					live = false;
					clearTimeout(timer);
				};
			}, [nonce]);
			return [snapshot, () => setNonce((value) => value + 1)];
		}

		/**
		 * The hub page: a tab per feature, the selected feature's own UI mounted
		 * below it. The feature owns every node under the mount point; this page
		 * only decides when to call it.
		 * @param props - composed slot props; `t` is the bound dictionary.
		 */
		function FeaturesPage({ t }) {
			const [snapshot, reload] = useFeatures();
			const [active, setActive] = React.useState(undefined);
			const host = React.useRef(null);
			const features = snapshot.features;
			const current = features.find((feature) => feature.key === active) ?? features[0];

			React.useEffect(() => {
				const node = host.current;
				if (node === null) return;
				node.replaceChildren();
				if (current === undefined) return;
				const note = (text) => {
					const message = document.createElement("p");
					message.className = "note";
					message.textContent = text;
					return message;
				};
				if (current.mount === undefined) {
					node.append(note(t("unloaded")));
					return;
				}
				try {
					current.mount(node);
				} catch (error) {
					node.replaceChildren(note(`${t("failed")}: ${String(error?.message ?? error)}`));
				}
			}, [current?.key, features, t]);

			const rail = features.map((feature) => React.createElement("button", {
				key: feature.key,
				type: "button",
				className: "tab",
				"data-active": String(feature === current),
				title: feature.package ?? feature.key,
				onClick: () => setActive(feature.key)
			}, feature.title ?? feature.key));

			return React.createElement("div", { id: "dsh-features-root" },
				React.createElement("div", { className: "head" },
					React.createElement("div", { className: "titles" },
						React.createElement("h1", null, t("panel")),
						React.createElement("p", null, t("subtitle"))),
					React.createElement("button", { type: "button", onClick: reload }, t("refresh"))),
				features.length === 0 ? null : React.createElement("div", { className: "rail" }, ...rail),
				React.createElement("div", { className: "stage" },
					features.length === 0
						? React.createElement("div", { className: "empty" },
							React.createElement("p", null, snapshot.loading ? t("loading") : t("empty")),
							snapshot.loading ? null : React.createElement("p", null, t("emptyHint")))
						: [
							React.createElement("div", { className: "stage-head", key: "head" },
								React.createElement("span", { className: "stage-title" }, current.title ?? current.key),
								current.summary === undefined ? null : React.createElement("span", { className: "note" }, current.summary),
								current.package === undefined ? null : React.createElement("span", { className: "note" }, current.package)),
							React.createElement("div", { key: "host", ref: host })
						]));
		}

		/**
		 * The sidebar glyph. The shell's own icon set keeps the entry looking like
		 * the official ones; the inline checklist is the fallback for a shell that
		 * does not ship that icon.
		 * @param props - slot props: `size` (and `active`, unused).
		 */
		function FeaturesIcon({ size }) {
			const glyph = primitives?.IconChecklistOutlineRegular;
			if (typeof glyph === "function") return React.createElement(glyph, { size });
			const pixels = size ?? 16;
			return React.createElement("svg", {
				width: pixels,
				height: pixels,
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true"
			}, React.createElement("path", {
				d: "M2.4 4.4l1 1 1.7-2M2.4 8.2l1 1 1.7-2M2.4 12l1 1 1.7-2M7.2 4.7h6.4M7.2 8.5h6.4M7.2 12.3h4",
				stroke: "currentColor",
				strokeWidth: 1.3,
				strokeLinecap: "round",
				strokeLinejoin: "round"
			}));
		}

		/* ---------------------------------------------------------------- wiring */

		/**
		 * Register the sidebar entry and the page it opens. The entry is the whole
		 * reason this package exists: one nav item between 插件 and 自动化任务.
		 * @param ctx - client root context (declares `slots` and `locale`).
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-features: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_ID,
				locale: NS,
				inject: () => ({ t })
			}, FeaturesPage));
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: ORDER,
				locale: NS,
				label: () => t("panel")
			}, FeaturesIcon));
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = "dsh-features";
		return module.exports;
	}
});
