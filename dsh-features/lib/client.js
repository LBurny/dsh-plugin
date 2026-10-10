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
 *                           `{ [key]: { title, summary, order, icon?, mount(host) } }`.
 *                           `icon` is a 16×16 stroke SVG path for the list row.
 *                           The hub mounts the opened feature by calling `mount`
 *                           with a plain div it owns; the reader's own drag order
 *                           lives in localStorage, not in here.
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
			"subtitle": "本仓插件的统一入口，一个页面查看与设置全部功能",
			"loading": "正在加载…",
			"refresh": "刷新",
			"back": "返回",
			"dragHint": "拖拽调整顺序",
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
			"back": "Back",
			"dragHint": "Drag to reorder",
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
	--dsh-subtle: var(--dsw-alias-interactive-bg-hover, #f3f4f6);
	--dsh-accent: #4d6bfe;
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
		--dsh-subtle: var(--dsw-alias-interactive-bg-hover, #2a2e34);
	}
}

#dsh-features-root,
#dsh-features-root .hub-head,
#dsh-features-root .hub-head *,
#dsh-features-root .hub-rows,
#dsh-features-root .hub-rows * {
	box-sizing: border-box;
}

/* ---------------------------------------------------------------- the head */

#dsh-features-root .hub-head {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 18px 22px 14px;
}

#dsh-features-root .hub-titles {
	flex: 1;
	min-width: 0;
}

#dsh-features-root .hub-line {
	display: flex;
	align-items: baseline;
	gap: 8px;
	min-width: 0;
}

#dsh-features-root .hub-titles h1 {
	font-size: 15px;
	font-weight: 600;
	line-height: 1.4;
	margin: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

#dsh-features-root .hub-head p {
	color: var(--dsh-muted);
	font-size: 12px;
	line-height: 1.6;
	margin: 3px 0 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

#dsh-features-root .hub-pkg {
	flex: none;
	color: var(--dsh-muted);
	font-size: 11px;
	border: 1px solid var(--dsh-border);
	border-radius: 5px;
	padding: 1px 6px;
}

/* Back and refresh are the same quiet square, so they line up on the grid. */
#dsh-features-root .hub-icon-btn {
	flex: none;
	display: flex;
	align-items: center;
	justify-content: center;
	width: 30px;
	height: 30px;
	padding: 0;
	border: 1px solid var(--dsh-border);
	border-radius: 8px;
	background: transparent;
	color: var(--dsh-muted);
	cursor: pointer;
}

#dsh-features-root .hub-icon-btn:hover {
	background: var(--dsh-hover);
	color: var(--dsh-fg);
}

/* ----------------------------------------------------------------- the list */

#dsh-features-root .hub-stage {
	flex: 1;
	min-width: 0;
	min-height: 0;
	overflow: auto;
}

#dsh-features-root .hub-stage[data-view="list"] {
	padding: 2px 22px 28px;
}

/* An embedded panel brings its own padding, so the detail view adds none. */
#dsh-features-root .hub-stage[data-view="feature"] {
	padding: 0;
}

#dsh-features-root .hub-rows {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

#dsh-features-root .hub-row {
	display: flex;
	align-items: center;
	gap: 12px;
	width: 100%;
	padding: 12px 14px;
	border: 1px solid var(--dsh-border);
	border-radius: 12px;
	background: transparent;
	color: inherit;
	font: inherit;
	text-align: left;
	cursor: pointer;
	user-select: none;
}

#dsh-features-root .hub-row:hover {
	background: var(--dsh-hover);
}

#dsh-features-root .hub-row[data-drop="true"] {
	border-color: var(--dsh-accent);
	box-shadow: 0 0 0 1px var(--dsh-accent);
}

#dsh-features-root .hub-tile {
	flex: none;
	display: flex;
	align-items: center;
	justify-content: center;
	width: 34px;
	height: 34px;
	border-radius: 9px;
	background: var(--dsh-subtle);
	color: var(--dsh-fg);
}

#dsh-features-root .hub-row .hub-text {
	flex: 1;
	min-width: 0;
	display: flex;
	flex-direction: column;
	gap: 3px;
}

#dsh-features-root .hub-row-name {
	font-weight: 600;
	line-height: 1.4;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

#dsh-features-root .hub-row-note {
	color: var(--dsh-muted);
	font-size: 12px;
	line-height: 1.6;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

#dsh-features-root .hub-go {
	flex: none;
	display: flex;
	align-items: center;
	color: var(--dsh-muted);
}

#dsh-features-root .hub-list-end {
	height: 16px;
	border-radius: 8px;
}

#dsh-features-root .hub-list-end[data-drop="true"] {
	box-shadow: inset 0 0 0 1px var(--dsh-accent);
}

#dsh-features-root .hub-empty {
	border: 1px dashed var(--dsh-border);
	border-radius: 12px;
	padding: 18px;
	color: var(--dsh-muted);
	font-size: 12px;
	line-height: 1.7;
}

#dsh-features-root .hub-empty p {
	margin: 0 0 6px;
}

#dsh-features-root .hub-empty p:last-child {
	margin-bottom: 0;
}

#dsh-features-root .hub-note {
	color: var(--dsh-muted);
	font-size: 12px;
	line-height: 1.7;
	margin: 0;
}

/* A feature mounted here never keeps a second refresh control. */
#dsh-features-root .hub-stage [data-dsh-refresh] {
	display: none !important;
}

/* Narrow screens (the phone remote view) tighten the gutters. */
@media (max-width: 620px) {
	#dsh-features-root .hub-head {
		padding: 14px 14px 10px;
	}

	#dsh-features-root .hub-stage[data-view="list"] {
		padding: 2px 14px 20px;
	}
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

		/* ------------------------------------------------------------ nav order */

		/**
		 * Where the reader's own feature order lives. dsh itself keeps UI preferences
		 * in browser storage (its client store persists per origin), so the hub does
		 * the same; the desktop shell keeps the dsh port stable across restarts,
		 * which is what makes the order survive them.
		 */
		const ORDER_KEY = "dsh-features:nav-order";

		/** The saved feature-key order; junk in storage degrades to no saved order. */
		function readNavOrder() {
			try {
				const parsed = JSON.parse(globalThis.localStorage?.getItem(ORDER_KEY) ?? "[]");
				return Array.isArray(parsed) ? parsed.filter((key) => typeof key === "string") : [];
			} catch {
				return [];
			}
		}

		/** Persist the order; denied storage (private mode) costs the sort, nothing else. */
		function writeNavOrder(keys) {
			try {
				globalThis.localStorage?.setItem(ORDER_KEY, JSON.stringify(keys));
			} catch {
				/* the page still sorts by the default order */
			}
		}

		/**
		 * Lay the merged features out: keys the reader dragged into place keep that
		 * order; anything new (installed after the last drag) appends by its default.
		 */
		function applyNavOrder(features, saved) {
			const position = new Map(saved.map((key, index) => [key, index]));
			return [...features].sort((left, right) => {
				const a = position.get(left.key) ?? saved.length;
				const b = position.get(right.key) ?? saved.length;
				return a - b || left.order - right.order || left.key.localeCompare(right.key);
			});
		}

		/* ----------------------------------------------------------------- glyphs */

		/** A feature without an `icon` gets this grid; glyphs are 16×16 stroke paths. */
		const FALLBACK_ICON = "M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z";

		/** Wrap one stroke path into the SVG the frame uses for every glyph. */
		function glyph(path, size, className) {
			return React.createElement("svg", {
				className,
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true"
			}, React.createElement("path", {
				d: path,
				stroke: "currentColor",
				strokeWidth: 1.2,
				strokeLinecap: "round",
				strokeLinejoin: "round"
			}));
		}

		/** The feature's own glyph, or the grid when it published none. */
		function featureGlyph(icon, size) {
			return glyph(typeof icon === "string" && icon !== "" ? icon : FALLBACK_ICON, size);
		}

		/** The chevron that says "this row opens a settings page". */
		function chevronGlyph() {
			return glyph("M6.2 3.6L10.6 8l-4.4 4.4", 14);
		}

		/** The arrow back to the list. */
		function backGlyph() {
			return glyph("M9.8 3.6L5.4 8l4.4 4.4", 15);
		}

		/** The one refresh control the page owns. */
		function refreshGlyph() {
			return glyph("M13 8a5 5 0 11-1.6-3.7M13 2.6V5.4h-2.8", 15);
		}

		/* ----------------------------------------------------------- the refresh */

		/**
		 * The two labels a page-refresh control is known by here. A leftover one is
		 * recognized by its text because a panel build older than the `inHub`
		 * cooperation cannot be recognized any other way.
		 */
		const REFRESH_LABELS = new Set(["刷新", "Refresh"]);

		/**
		 * Drop a duplicate refresh control from an embedded panel: anything the panel
		 * marked `data-dsh-refresh`, plus a bare button labelled 刷新/Refresh. The page
		 * head owns the only refresh, so an embedded panel must not add a second one;
		 * the marker lets a panel say so explicitly, the label catches the rest.
		 * @param node - the mount point, after the feature has rendered into it.
		 */
		function stripDuplicateRefresh(node) {
			if (typeof node.querySelectorAll !== "function") return;
			for (const control of node.querySelectorAll("button")) {
				if (control.hasAttribute("data-dsh-refresh") || REFRESH_LABELS.has((control.textContent ?? "").trim())) control.remove();
			}
		}

		/* ------------------------------------------------------------- the merge */

		/**
		 * Merge the two sources into what the page renders. The registry knows what
		 * it can mount and carries the feature's own already-localized title; the
		 * inventory knows what is installed. A key only in the inventory is an
		 * installed-but-unloaded feature, which the page says out loud.
		 * @param registry - `window.__dshFeatures`.
		 * @param inventory - the host half's entries.
		 * @returns merged features, in the default order.
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
					icon: typeof entry?.icon === "string" ? entry.icon : existing.icon,
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
		 * The hub page. A list of rows, one per feature plugin, laid out like dsh's
		 * own 插件 page: glyph, name, summary, chevron. Clicking a row opens that
		 * feature's settings — the head then shows a back control and the feature's
		 * name, and the feature's own UI is mounted below. The feature owns every node
		 * under the mount point; this page only decides when to call it.
		 *
		 * Exactly one refresh control exists at a time, in the head: it rescans the
		 * inventory and remounts the open feature, which re-fetches its own data on
		 * mount. Panels hide their own refresh while embedded, and
		 * {@link stripDuplicateRefresh} removes a leftover one from a panel build that
		 * predates that cooperation.
		 * @param props - composed slot props; `t` is the bound dictionary.
		 */
		function FeaturesPage({ t }) {
			const [snapshot, reload] = useFeatures();
			const [navOrder, setNavOrder] = React.useState(readNavOrder);
			const [active, setActive] = React.useState(undefined);
			const [dropKey, setDropKey] = React.useState(undefined);
			const dragKey = React.useRef(undefined);
			const host = React.useRef(null);
			const features = applyNavOrder(snapshot.features, navOrder);
			// `undefined` means the list. The open feature is looked up by key, so a
			// reorder can never point the page at a different one.
			const open = active === undefined ? undefined : features.find((feature) => feature.key === active);

			React.useEffect(() => {
				const node = host.current;
				if (node === null || open === undefined) return;
				node.replaceChildren();
				const note = (text) => {
					const message = document.createElement("p");
					message.className = "note";
					message.textContent = text;
					return message;
				};
				if (open.mount === undefined) {
					node.append(note(t("unloaded")));
					return;
				}
				try {
					open.mount(node);
				} catch (error) {
					node.replaceChildren(note(`${t("failed")}: ${String(error?.message ?? error)}`));
				}
				// Panels fill their body asynchronously, so sweep now and again on every
				// later change: a second refresh control must not survive on the page.
				stripDuplicateRefresh(node);
				if (typeof MutationObserver === "undefined") return;
				const observer = new MutationObserver(() => stripDuplicateRefresh(node));
				observer.observe(node, { childList: true, subtree: true });
				return () => observer.disconnect();
				// Reordering must not remount, so this depends on the merged snapshot (a
				// new array only after a rescan) rather than on the ordered array.
			}, [open?.key, snapshot.features, t]);

			/** Move the dragged key in front of the target (or last), and keep it. */
			const moveBefore = (fromKey, toKey) => {
				if (fromKey === undefined || fromKey === toKey) return;
				const keys = features.map((feature) => feature.key);
				const from = keys.indexOf(fromKey);
				if (from === -1) return;
				keys.splice(from, 1);
				const to = toKey === undefined ? keys.length : keys.indexOf(toKey);
				if (to === -1) return;
				keys.splice(to, 0, fromKey);
				writeNavOrder(keys);
				setNavOrder(keys);
			};

			/**
			 * HTML5 drag-and-drop on a row (or, with no key, on the end pad that accepts
			 * "move to last"). Touch clients get no drag, so the phone view keeps the
			 * default order.
			 */
			const dragHandlers = (key) => ({
				draggable: key === undefined ? undefined : true,
				onDragStart: (event) => {
					dragKey.current = key;
					event.dataTransfer?.setData?.("text/plain", key);
					if (event.dataTransfer !== undefined) event.dataTransfer.effectAllowed = "move";
				},
				onDragOver: (event) => {
					if (dragKey.current === undefined || dragKey.current === key) return;
					event.preventDefault?.();
					setDropKey(key ?? "end");
				},
				onDrop: (event) => {
					event.preventDefault?.();
					moveBefore(dragKey.current, key);
					dragKey.current = undefined;
					setDropKey(undefined);
				},
				onDragEnd: () => {
					dragKey.current = undefined;
					setDropKey(undefined);
				}
			});

			/** The list view: one card per feature, in the reader's order. */
			const list = () => React.createElement("div", { className: "hub-rows" },
				...features.map((feature) => React.createElement("button", {
					key: feature.key,
					type: "button",
					className: "hub-row",
					"data-drop": String(dropKey === feature.key),
					title: `${feature.package ?? feature.key} · ${t("dragHint")}`,
					onClick: () => setActive(feature.key),
					...dragHandlers(feature.key)
				},
					React.createElement("span", { className: "hub-tile" }, featureGlyph(feature.icon, 17)),
					React.createElement("span", { className: "hub-text" },
						React.createElement("span", { className: "hub-row-name" }, feature.title ?? feature.key),
						feature.summary === undefined ? null : React.createElement("span", { className: "hub-row-note" }, feature.summary)),
					React.createElement("span", { className: "hub-go" }, chevronGlyph()))),
				React.createElement("div", {
					className: "hub-list-end",
					"data-drop": String(dropKey === "end"),
					onDragOver: dragHandlers(undefined).onDragOver,
					onDrop: dragHandlers(undefined).onDrop
				}));

			const titles = open === undefined
				? React.createElement("div", { className: "hub-titles" },
					React.createElement("h1", null, t("panel")),
					React.createElement("p", null, t("subtitle")))
				: React.createElement("div", { className: "hub-titles" },
					React.createElement("div", { className: "hub-line" },
						React.createElement("h1", null, open.title ?? open.key),
						open.package === undefined ? null : React.createElement("span", { className: "hub-pkg" }, open.package)),
					React.createElement("p", null, open.summary ?? ""));

			return React.createElement("div", { id: "dsh-features-root" },
				React.createElement("div", { className: "hub-head" },
					open === undefined ? null : React.createElement("button", {
						className: "hub-icon-btn",
						type: "button",
						title: t("back"),
						"aria-label": t("back"),
						onClick: () => setActive(undefined)
					}, backGlyph()),
					titles,
					React.createElement("button", {
						className: "hub-icon-btn",
						type: "button",
						title: t("refresh"),
						"aria-label": t("refresh"),
						onClick: reload
					}, refreshGlyph())),
				React.createElement("div", { className: "hub-stage", "data-view": open === undefined ? "list" : "feature" },
					features.length === 0
						? React.createElement("div", { className: "hub-empty" },
							React.createElement("p", null, snapshot.loading ? t("loading") : t("empty")),
							snapshot.loading ? null : React.createElement("p", null, t("emptyHint")))
						: open === undefined
							? list()
							: React.createElement("div", { key: "host", ref: host })));
		}

		/**
		 * The sidebar glyph. The shell's own icon set keeps the entry looking like
		 * the official ones; the inline checklist is the fallback for a shell that
		 * does not ship that icon.
		 * @param props - slot props: `size` (and `active`, unused).
		 */
		function FeaturesIcon({ size }) {
			const icon = primitives?.IconChecklistOutlineRegular;
			if (typeof icon === "function") return React.createElement(icon, { size });
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
