/**
 * Raise the window that shows this harness, so that clicking a reminder actually brings the
 * application up.
 *
 * The page cannot do it. `window.focus()` is a no-op for a window the OS has not already
 * focused (a browser refuses a background page that privilege), and the desktop app exposes no
 * IPC for it: its preload carries shortcuts, boot, directory pickers, updates, theme and window
 * chrome, but nothing that raises the window, and its IPC channel names are private to the app
 * bundle. What this half has instead is ancestry: the dsh host runs as a child of the very
 * process that owns the window, measured on the app as `dsh-desktop-host` → the Electron
 * process whose `MainWindowHandle` is the application window. So the host walks up that chain
 * and asks Windows to activate the first ancestor that has a window.
 *
 * Windows refuses a foreground steal from a background process, so the activate is attempted
 * properly first (attach to the foreground thread, then `SetForegroundWindow`) and, if the rule
 * still says no, falls back to forcing the window topmost and back, which is a z-order change
 * rather than a foreground claim and needs no permission. Measured on the app: a minimized
 * window came back restored and in front.
 *
 * @module dsh-notify/lib/focus
 */
import { spawn } from "node:child_process";

/** How far up the parent chain to look for the window; the app's chain is one step deep. */
const ANCESTOR_DEPTH = 4;

/**
 * The command that raises the window, or `undefined` on a platform this does not implement.
 *
 * Pure on purpose: the whole platform decision is testable without raising anything, and the
 * caller can decide not to run it at all.
 * @param platform - `process.platform`.
 * @param pid - the process to start from, normally this process's parent.
 * @returns `{command, args}` to run, or `undefined`.
 */
export function focusCommand(platform, pid) {
	if (platform !== "win32" || typeof pid !== "number" || pid <= 0) return undefined;
	const members = [
		'[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
		'[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
		'[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);',
		'[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
		'[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);',
		'[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);',
		'[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int z, uint f);',
		'[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();'
	].join(" ");
	// Single quotes keep the C# verbatim, so the double quotes around the DLL names survive.
	const script = [
		"$ProgressPreference='SilentlyContinue'",
		`Add-Type -Namespace DshNotify -Name Win -MemberDefinition '${members}'`,
		"function Find-Win([int]$start) { $id = $start; for ($i = 0; $i -lt " + String(ANCESTOR_DEPTH) + " -and $id; $i++) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { return $p.MainWindowHandle }; $id = [int](Get-CimInstance Win32_Process -Filter \"ProcessId=$id\").ParentProcessId } }",
		`$h = Find-Win ${String(pid)}`,
		"if (-not $h) { exit 1 }",
		"[void][DshNotify.Win]::ShowWindow($h, 9)",
		"[void][DshNotify.Win]::BringWindowToTop($h)",
		"$fg = [DshNotify.Win]::GetForegroundWindow()",
		"$fgThread = [DshNotify.Win]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)",
		"$myThread = [DshNotify.Win]::GetCurrentThreadId()",
		"if ($fgThread -ne $myThread) { [void][DshNotify.Win]::AttachThreadInput($fgThread, $myThread, $true) }",
		"$ok = [DshNotify.Win]::SetForegroundWindow($h)",
		"if ($fgThread -ne $myThread) { [void][DshNotify.Win]::AttachThreadInput($fgThread, $myThread, $false) }",
		"if (-not $ok) { [void][DshNotify.Win]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0043); [void][DshNotify.Win]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0043) }",
		"exit 0"
	].join("; ");
	return { command: "powershell", args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script] };
}

/**
 * A focuser for this process, ready to be called by a route.
 * @param options - injection points; the defaults are the real process and `spawn`.
 * @returns an object whose `activate()` resolves true when the window was raised.
 */
export function createFocuser({ platform = process.platform, ppid = process.ppid, run = spawn } = {}) {
	return {
		/**
		 * Attempt to raise the window. Never rejects: a window that cannot be raised is a
		 * small thing to lose, and a throw here would reach a click handler.
		 * @returns true when the platform command ran and reported success.
		 */
		activate() {
			const command = focusCommand(platform, ppid);
			if (command === undefined) return Promise.resolve(false);
			return new Promise((resolve) => {
				try {
					const child = run(command.command, command.args, { windowsHide: true });
					child.on("error", () => resolve(false));
					child.on("exit", (code) => resolve(code === 0));
				} catch {
					resolve(false);
				}
			});
		}
	};
}
