/**
 * 实时刷新：每秒重算可见账号行的剩余秒数与验证码，UpdateResult 原地更新。
 * 周期翻转（code 变了）时连 Actions 一起更新，否则复制动作闭包里还是旧 code。
 * @module live
 */

import { getApi, currentCtx } from "./context.mjs"
import { t } from "./i18n.mjs"
import { totp, remainingSeconds } from "./totp.mjs"
import { readAccounts } from "./store.mjs"
import { rowId, display, detail } from "./ui.mjs"
import { buildActions } from "./views.mjs"

/**
 * 渲染快照：值变化才发 UpdateResult，避免每秒无谓重绘。
 * @type {{lastRendered: Map<string, {code: string, remain: number}>}}
 */
export const globalState = {
  lastRendered: new Map(),
  /** 上次同步到 Wox 的命令建议状态（true=已注册解锁命令） */
  commandsSyncedUnlocked: null,
}

/** 清空渲染快照（重置/删除账户后调用，避免残留旧行）。 */
export function clearRenderCache() {
  globalState.lastRendered.clear()
}

let liveTimer = null

/** 启动秒级刷新 timer（幂等：重复调用先停旧的）。 */
export function startLiveTimer() {
  // 热重载在同一 Node 进程里加载新模块实例，且不保证调用旧实例的 OnUnload。
  // 若各实例各自 setInterval，会出现多个 timer 交错 UpdateResult 同一行（标题在
  // 新旧文案间来回跳）。timer 句柄挂 globalThis 做进程级单例：启动前先杀旧的。
  if (globalThis.__TOTP_LIVE_TIMER__) clearInterval(globalThis.__TOTP_LIVE_TIMER__)
  if (liveTimer) clearInterval(liveTimer)
  liveTimer = setInterval(() => {
    tickLive().catch((e) => console.error("tickLive:", e.message))
  }, 1000)
  globalThis.__TOTP_LIVE_TIMER__ = liveTimer
}

/** 停止刷新 timer（OnUnload 时调用）。 */
export function stopLiveTimer() {
  if (globalThis.__TOTP_LIVE_TIMER__) {
    clearInterval(globalThis.__TOTP_LIVE_TIMER__)
    globalThis.__TOTP_LIVE_TIMER__ = null
  }
  if (liveTimer) {
    clearInterval(liveTimer)
    liveTimer = null
  }
}

/**
 * 单次刷新：对每个账户与上次快照比较，值有变化才 UpdateResult。
 * timer 由 OnEnterPluginQuery/OnLeavePluginQuery 事件驱动，但 Wox 在窗口隐藏/最小化时
 * 不触发 leave，所以 tick 里查一次 IsVisible：不可见则顺手停掉 timer 自灭，
 * 之后零 RPC，直到下次 enter 事件重新拉起。存储损坏时静默跳过，避免每秒刷屏。
 * @returns {Promise<void>}
 */
async function tickLive() {
  const api = getApi()
  const lastCtx = currentCtx()
  if (!lastCtx || !api) return
  try {
    if (!(await api.IsVisible(lastCtx))) {
      stopLiveTimer() // 窗口已隐藏：自灭 timer，避免隐藏期间继续空转
      return
    }
  } catch {
    return
  }
  let accounts
  try {
    accounts = readAccounts()
  } catch (e) {
    // 存储损坏时别每秒刷屏，query 时已展示错误
    api.Log(lastCtx, "Warning", `tickLive readAccounts: ${e.message}`)
    return
  }
  for (const a of accounts) {
    let code
    try {
      code = totp(a.secret, 0, a.period, a.digits, a.algo)
    } catch {
      continue // 无效 secret 行保持原样（query 时已显示错误）
    }
    const remain = remainingSeconds(a.period)
    const prev = globalState.lastRendered.get(rowId(a))
    if (prev && prev.code === code && prev.remain === remain) continue
    const sub = [detail(a), t("remain_enter", remain)].filter(Boolean).join(" · ")
    const update = {
      Id: rowId(a),
      Title: `${display(a)}  ${code}`,
      SubTitle: sub,
      Tails: [{ Type: "text", Text: `${remain}s` }],
    }
    if (!prev || prev.code !== code) {
      update.Actions = buildActions(a, code)
    }
    globalState.lastRendered.set(rowId(a), { code, remain })
    try {
      await api.UpdateResult(lastCtx, update)
    } catch (e) {
      api.Log(lastCtx, "Warning", `UpdateResult ${rowId(a)}: ${e.message}`)
    }
  }
}
