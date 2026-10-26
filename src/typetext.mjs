/**
 * 插件侧"直接输入"实现：不依赖 Wox 的 TypeText API——官方已拒绝将该 API
 * 公开（PR Wox-launcher/Wox#4671，理由：公开 API 需承诺全平台可用性，而
 * 模拟按键在部分桌面环境不可靠）。插件进程跑在本机，直接 shell 调平台
 * 原生输入工具即可；验证码只含数字，无需处理特殊按键转义。
 * @module typetext
 */
import { execFile } from "node:child_process"
import { platform } from "node:os"
import { promisify } from "node:util"

const run = promisify(execFile)

/**
 * 执行注入命令并收集 stderr：execFile 的 rejection message 只含命令行，
 * osascript/powershell 的真实报错（权限、工具缺失）在 stderr，拼进去便于日志定位。
 * @param {string} cmd
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function runChecked(cmd, args) {
  try {
    await run(cmd, args)
  } catch (e) {
    throw new Error(`${cmd}: ${(e.stderr || e.message || "").toString().trim()}`)
  }
}

/**
 * macOS：JXA 调 CGEventPost 直接注入数字键。不走 System Events 的 keystroke——
 * 那需要额外的 Apple Events「自动化」授权（dev 签名 app 弹不出授权框，报 -1743），
 * CGEventPost 只依赖辅助功能权限（TCC 归属 Wox.app）。
 * 数字键码：kVK_ANSI_0..9 = 29,18,19,20,21,23,22,26,28,25
 * @param {string} text - 仅 0-9
 * @returns {Promise<void>}
 */
function typeMacOS(text) {
  // 键码表内嵌脚本，text 已由 typeText 校验为纯数字
  const script = `
    ObjC.import('CoreGraphics')
    ObjC.import('Foundation')
    const KEYCODES = {'0': 29, '1': 18, '2': 19, '3': 20, '4': 21, '5': 23, '6': 22, '7': 26, '8': 28, '9': 25}
    const src = $.CGEventSourceCreate($.kCGEventSourceStateCombinedSessionState)
    for (const ch of '${text}') {
      $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateKeyboardEvent(src, KEYCODES[ch], true))
      $.NSThread.sleepForTimeInterval(0.01)
      $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateKeyboardEvent(src, KEYCODES[ch], false))
      $.NSThread.sleepForTimeInterval(0.03)
    }
  `
  return runChecked("osascript", ["-l", "JavaScript", "-e", script])
}

/**
 * 平台原生注入实现（不校验内容，由 typeText 统一校验）：
 * - macOS：CGEventPost（见 typeMacOS）
 * - Windows：SendKeys，数字键无特殊含义，无需权限
 * - Linux：X11 用 xdotool；Wayland best-effort 用 wtype（GNOME Wayland
 *   无用户态注入工具，会走到报错提示）
 * @param {string} text - 仅 0-9 的文本
 * @returns {Promise<void>}
 */
async function typeTextNative(text) {
  const p = platform()
  if (p === "darwin") {
    await typeMacOS(text)
  } else if (p === "win32") {
    await runChecked("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${text}')`,
    ])
  } else {
    try {
      await runChecked("xdotool", ["type", "--clearmodifiers", text])
    } catch {
      // xdotool 不存在或非 X11 会话 → 尝试 Wayland（wl-roots 系）的 wtype
      await runChecked("wtype", [text])
    }
  }
}

// 测试注入点：测试替换为记录函数，避免测试真的往桌面敲键盘
let typeImpl = typeTextNative

/**
 * 替换注入实现（仅测试用）。
 * @param {(text: string) => Promise<void>} f
 * @returns {void}
 */
export function setTypeTextImpl(f) {
  typeImpl = f
}

/**
 * 把验证码注入当前焦点输入框。调用方需先 HideApp 让焦点落回目标窗口。
 * @param {string} text - 待输入文本；防御性校验只允许纯数字（本插件唯一用途）
 * @returns {Promise<void>} 失败时 reject，由调用方翻译并 Notify
 */
export function typeText(text) {
  if (!/^\d+$/.test(text)) {
    return Promise.reject(new Error(`typeText: unsupported text ${JSON.stringify(text)}`))
  }
  return typeImpl(text)
}
