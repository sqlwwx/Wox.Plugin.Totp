// 集成测试：mock Wox API 驱动 index.mjs 的 init/query
// 覆盖：query 分发（list/add/confirm）、空状态、覆盖添加、删除确认流程、
//       updateActions 行为、存储损坏时的错误展示
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { plugin } from "../src/index.mjs"

const SECRET = "JBSWY3DPEHPK3PXP"
const URI = (extra = "") => `otpauth://totp/GitHub:me@x.com?secret=${SECRET}${extra}`

// ---------- mock API ----------
function makeApi(state) {
  const api = {
    logs: [],
    notifies: [],
    copies: [],
    changes: [],
    refreshes: 0,
    visible: true,
    GetTranslation: async (_ctx, key) => (key === "language_probe" ? "zh" : key),
    GetCacheFolder: async () => state.cacheDir,
    GetSetting: async (_ctx, key) => state.settings.get(key) || "",
    SetSetting: async (_ctx, option) => {
      state.settings.set(option.Key, option.Value)
      return { Success: true }
    },
    OnSettingChanged: async (_ctx, _cb) => {},
    HideApp: async () => { api.hidden = (api.hidden || 0) + 1 },
    Log: async (_ctx, level, msg) => api.logs.push(`${level}: ${msg}`),
    Notify: async (_ctx, msg) => api.notifies.push(msg),
    Copy: async (_ctx, p) => api.copies.push(p.text),
    ChangeQuery: async (_ctx, q) => api.changes.push(q.QueryText),
    RefreshQuery: async () => { api.refreshes++ },
    IsVisible: async () => api.visible,
    UpdateResult: async () => {
      api.updates = (api.updates || 0) + 1
      return true
    },
    OnUnload: async (_ctx, cb) => state.unloadCbs.push(cb),
    OnEnterPluginQuery: async (_ctx, cb) => state.enterCbs.push(cb),
    OnLeavePluginQuery: async (_ctx, cb) => state.leaveCbs.push(cb),
  }
  return api
}

// 每个 test 前重置模块状态：index.mjs 的 api/lastCtx 是模块级变量，
// 用 query registry 技巧无法隔离，所以直接依赖 init 覆盖 api，缓存目录隔离数据
let state, api, ctx
const query = async (search) => {
  const q = { Search: search, Type: "input" }
  return await plugin.query(ctx, q)
}

// Wox 注册 QueryCommands 后的形态：core 把命令解析进 Command，Search 只含参数
const queryCmd = async (command, search) => {
  const q = { Search: search, Command: command, TriggerKeyword: "totp", Type: "input" }
  return await plugin.query(ctx, q)
}

beforeEach(async () => {
  state = {
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "totp-it-")),
    settings: new Map(),
    unloadCbs: [],
    enterCbs: [],
    leaveCbs: [],
  }
  api = makeApi(state)
  ctx = {}
  // 直接输入走插件侧 typetext（不是 Wox API），测试替换实现避免真往桌面敲键盘
  const { setTypeTextImpl } = await import("../src/typetext.mjs")
  api.typed = []
  setTypeTextImpl(async (text) => api.typed.push(text))
  // PluginDirectory 指向仓库根：initI18n 从那里读 plugin.json 的 I18n 字典
  await plugin.init(ctx, { API: api, PluginDirectory: path.resolve(import.meta.dir, "..") })
  // store 是模块级单例（与 index.mjs 共享同一 import），init 已跑过 initStore，这里解锁
  const store = await import("../src/store.mjs")
  await store.unlock("test-pass-123")
})

afterEach(() => {
  // init 注册的 OnUnload 会清掉 liveTimer
  for (const cb of state.unloadCbs) await_clear(cb)
  fs.rmSync(state.cacheDir, { recursive: true, force: true })
})
async function await_clear(cb) { await cb(ctx) }

const defaultAction = (r) => r.Actions.find((a) => a.IsDefault)

// ---------- 查询列表 ----------
describe("query list", () => {
  test("空状态：引导行 + 默认 action 跳到 add", async () => {
    const res = await query("")
    expect(defaultAction(res.Results[0])).toBeDefined()
    await defaultAction(res.Results[0]).Action(ctx, {})
    expect(api.changes).toEqual(["totp add "])
  })

  test("列出账户，Title 含验证码，Tails 显示剩余秒数", async () => {
    await query(`add ${URI()}`) // 先添加一个
    const res = await query("")
    const row = res.Results.find((r) => r.Id?.startsWith("totp:"))
    expect(row).toBeDefined()
    expect(row.Title).toMatch(/GitHub · me@x\.com\s+\d{6}/)
    expect(row.Tails[0].Text).toMatch(/^\d+s$/)
  })

  test("关键字过滤（原文）", async () => {
    await query(`add otpauth://totp/微信工作号?secret=${SECRET}`)
    const hitText = await query("工作号")
    expect(hitText.Results.some((r) => r.Id?.startsWith("totp:"))).toBe(true)
    const miss = await query("no-such-keyword")
    expect(miss.Results).toHaveLength(1)
    expect(miss.Results[0].SubTitle).toContain("no-such-keyword")
  })
})

// ---------- add ----------
describe("query add", () => {
  test("合法 URI 添加成功，直接显示该账户验证码行", async () => {
    const res = await query(`add ${URI()}`)
    // 新交互：add 成功 = 只显示刚添加账户的验证码行（含倒计时/复制动作），不再显示"添加成功"行
    expect(res.Results).toHaveLength(1)
    expect(res.Results[0].Title).toContain("GitHub · me@x.com")
    expect(res.Results[0].Title).toMatch(/\d{6}/)
    expect(api.notifies).toHaveLength(0)
  })

  test("core 命令路由形态（Command=add + Search=URI）也走 qAdd", async () => {
    const res = await queryCmd("add", URI())
    expect(res.Results[0].Title).toContain("GitHub · me@x.com")
  })

  test("同 issuer+name 覆盖，不重复", async () => {
    await query(`add ${URI()}`)
    await query(`add ${URI()}`)
    const res = await query("")
    // 账号行 Id 形如 totp:{issuer}:{name}；功能行是 totp:row:*，用精确特征排除
    const rows = res.Results.filter((r) => r.Id?.startsWith("totp:") && !r.Id?.startsWith("totp:row"))
    expect(rows).toHaveLength(1)
  })

  test("缺 URI 显示用法提示", async () => {
    const res = await query("add")
    expect(res.Results[0].Title).toMatch(/otpauth|示例|Example/)
  })

  test("非法 URI 显示错误和示例", async () => {
    const res = await query("add not-a-uri")
    expect(res.Results[0].Title).toMatch(/无效|Invalid/)
    expect(res.Results[0].SubTitle).toMatch(/Example|示例/)
  })

  test("非法 secret 报错", async () => {
    const res = await query("add otpauth://totp/x?secret=ABC1")
    expect(res.Results[0].Title).toMatch(/secret 无效|Invalid secret/)
  })
})

// ---------- 删除确认流程 ----------
describe("delete confirm flow", () => {
  test("delete action 跳到 confirm，回车才真删", async () => {
    await query(`add ${URI()}`)
    const list = await query("")
    const row = list.Results.find((r) => r.Id?.startsWith("totp:"))
    const delAction = row.Actions.find((a) => a.Name.includes("删除") || a.Name.includes("Delete"))

    await delAction.Action(ctx, {})
    expect(api.changes[0]).toMatch(/^totp confirm /)
    expect(state.settings.get("vault")).toBeTruthy()
    // 账户还在
    const still = await query("")
    expect(still.Results.some((r) => r.Id?.startsWith("totp:"))).toBe(true)

    // 确认行默认 action 是"确认删除"
    const confirmText = api.changes[0]
    const confirmRes = await query(confirmText.replace(/^totp /, ""))
    expect(defaultAction(confirmRes.Results[0])).toBeDefined()
    expect(confirmRes.Results[0].Title).toMatch(/删除|Delete/)
    await defaultAction(confirmRes.Results[0]).Action(ctx, {})

    // 已删除，回列表为空状态（功能行不带验证码）
    expect(api.notifies.some((n) => n.includes("已删除") || n.includes("Deleted"))).toBe(true)
    const after = await query("")
    expect(after.Results.some((r) => r.Id?.startsWith("totp:") && !r.Id?.startsWith("totp:row"))).toBe(false)
  })

  test("confirm 取消 action 不删除", async () => {
    await query(`add ${URI()}`)
    const list = await query("")
    const row = list.Results.find((r) => r.Id?.startsWith("totp:"))
    const delAction = row.Actions.find((a) => a.Name.includes("删除") || a.Name.includes("Delete"))
    await delAction.Action(ctx, {})

    const confirmRes = await query(api.changes[0].replace(/^totp /, ""))
    const cancel = confirmRes.Results[0].Actions.find((a) => !a.IsDefault)
    await cancel.Action(ctx, {})
    expect(api.changes.at(-1)).toBe("totp ")
    const res = await query("")
    expect(res.Results.some((r) => r.Id?.startsWith("totp:"))).toBe(true)
  })

  test("confirm 键无效时显示提示行，不抛错", async () => {
    const res = await query("confirm !!!not-base64!!!")
    expect(res.Results).toHaveLength(1)
    expect(res.Results[0].Title).toMatch(/不存在|not found/i)
  })
})

// ---------- 别名 ----------
describe("alias", () => {
  test("别名显示与搜索", async () => {
    await query(`add ${URI()}`)
    // 通过表单 action 设置别名
    const list = await query("")
    const row = list.Results.find((r) => r.Id?.startsWith("totp:"))
    const aliasAction = row.Actions.find((a2) => a2.Form)
    expect(aliasAction).toBeDefined()
    await aliasAction.OnSubmit(ctx, { Values: { alias: "工作主号" } })
    expect(api.notifies.some((n) => n.includes("工作主号"))).toBe(true)

    // 列表 Title 显示别名，SubTitle 显示原名
    const after = await query("")
    const aliasedRow = after.Results.find((r) => r.Id?.startsWith("totp:"))
    expect(aliasedRow.Title).toMatch(/^工作主号\s+\d{6}$/)
    expect(aliasedRow.SubTitle).toContain("GitHub · me@x.com")

    // 别名原文/原名都能搜到
    for (const kw of ["工作主号", "git", "me@x"]) {
      const hit = await query(kw)
      expect(hit.Results.some((r) => r.Id?.startsWith("totp:"))).toBe(true)
    }
    // 无关关键字不命中
    const miss = await query("qq")
    expect(miss.Results.some((r) => r.Id?.startsWith("totp:"))).toBe(false)

    // 清除别名：空值提交
    await aliasAction.OnSubmit(ctx, { Values: { alias: "" } })
    const cleared = await query("")
    const clearedRow = cleared.Results.find((r) => r.Id?.startsWith("totp:"))
    expect(clearedRow.Title).toMatch(/GitHub · me@x\.com\s+\d{6}/)
    const raw = JSON.parse(decryptForTest())
    expect(raw.accounts[0].alias).toBeUndefined()
  })
})

// ---------- 复制 ----------
describe("copy actions", () => {
  test("copy action 复制当前码", async () => {
    await query(`add ${URI()}`)
    const res = await query("")
    const row = res.Results.find((r) => r.Id?.startsWith("totp:"))
    await row.Actions.find((a) => a.Id === row.Id + ":copy").Action(ctx, {})
    expect(api.copies).toHaveLength(1)
    expect(api.copies[0]).toMatch(/^\d{6}$/)
    expect(api.typed).toHaveLength(0)
  })

  test("copy_next 复制下一周期码", async () => {
    await query(`add ${URI()}`)
    const res = await query("")
    const row = res.Results.find((r) => r.Id?.startsWith("totp:"))
    await row.Actions.find((a) => a.Id === row.Id + ":copy_next").Action(ctx, {})
    expect(api.copies).toHaveLength(1)
    expect(api.copies[0]).toMatch(/^\d{6}$/)
  })
})

// ---------- 直接输入（type action） ----------
describe("type action", () => {
  test("type 是默认动作：回车先 HideApp 再注入，不复制", async () => {
    await query(`add ${URI()}`)
    const res = await query("")
    const row = res.Results.find((r) => r.Id?.startsWith("totp:"))
    expect(defaultAction(row).Id).toBe(row.Id + ":type")
    await defaultAction(row).Action(ctx, {})
    expect(api.hidden).toBe(1)
    expect(api.typed[0]).toMatch(/^\d{6}$/)
    expect(api.copies).toHaveLength(0)
  })

  test("直接输入失败兜底：复制到剪贴板并提示", async () => {
    const { setTypeTextImpl } = await import("../src/typetext.mjs")
    setTypeTextImpl(async () => {
      throw new Error("not authorized to send Apple events")
    })
    await query(`add ${URI()}`)
    const res = await query("")
    const row = res.Results.find((r) => r.Id?.startsWith("totp:"))
    const typeAct = row.Actions.find((a) => a.Id === row.Id + ":type")
    await typeAct.Action(ctx, {})
    expect(api.copies).toHaveLength(1)
    expect(api.copies[0]).toMatch(/^\d{6}$/)
    expect(api.notifies.join("\n")).toMatch(/已复制|copied/)
  })
})

// ---------- 存储 ----------
// 测试辅助：让 store 自己读回（解密失败会抛错），再序列化返回
import * as storeMod from "../src/store.mjs"
function decryptForTest() {
  const accounts = storeMod.readAccounts()
  return JSON.stringify({ accounts })
}
describe("storage via query", () => {
  test("损坏的密文：unlock 时报错，不崩溃", async () => {
    await query(`add ${URI()}`)
    // 模拟 wox.db 密文记录损坏
    state.settings.set("vault", Buffer.from("{broken json!!").toString("base64"))
    await storeMod.initStore(api, ctx)
    storeMod.lock()
    // 锁定态正常显示（密文损坏在解锁时才暴露）
    const locked = await query("")
    expect(locked.Results.length).toBeGreaterThanOrEqual(1)
    // 解锁失败：Notify 报「加密存储损坏」
    const unlockRow = locked.Results[0].Actions.find((a) => a.Id === "totp:unlock")
    await unlockRow.OnSubmit(ctx, { Values: { password: "test-pass-123" } })
    expect(api.notifies.at(-1)).toMatch(/损坏|corrupt/)
    expect(storeMod.isLocked()).toBe(true)
  })

  test("添加账号后密文持久化到 setting（能读回）", async () => {
    await query(`add ${URI()}`)
    expect(state.settings.get("vault")).toBeTruthy()
    expect(storeMod.readAccounts()).toHaveLength(1)
  })
})

// ---------- 实时刷新 timer 生命周期 ----------
describe("live timer lifecycle", () => {
  test("init 后 timer 不启动，进入面板才启动，离开面板即停", async () => {
    await query(`add ${URI()}`) // 添加账户（不触发 enter 事件）

    // init 不再起常驻 timer：离开态下 tick 无 UpdateResult
    const { globalState } = await import("../src/live.mjs")
    globalState.lastRendered.clear()

    // 模拟进入面板：起 timer，1.5s 内应有秒级 UpdateResult
    for (const cb of state.enterCbs) await cb(ctx)
    await new Promise((r) => setTimeout(r, 1500))
    expect(api.updates).toBeGreaterThan(0)

    // 模拟离开面板：timer 停止，计数不再增长
    for (const cb of state.leaveCbs) await cb(ctx)
    const n = api.updates
    await new Promise((r) => setTimeout(r, 1500))
    expect(api.updates).toBe(n)
  })

  test("窗口隐藏（leave 不触发）：tick 查 IsVisible 为 false 后 timer 自灭", async () => {
    await query(`add ${URI()}`)
    for (const cb of state.enterCbs) await cb(ctx)
    await new Promise((r) => setTimeout(r, 1200))
    const before = api.updates

    // 隐藏窗口：Wox 不发 leave，但 IsVisible 变 false
    api.visible = false
    await new Promise((r) => setTimeout(r, 1200)) // 下一 tick 查到不可见，自灭
    const afterStop = api.updates
    await new Promise((r) => setTimeout(r, 1200))
    // 自灭后不再有 UpdateResult；隐藏期间最多多 1 次探测
    expect(api.updates - afterStop).toBe(0)

    // 重新显示：enter 事件拉起 timer，恢复更新
    api.visible = true
    for (const cb of state.enterCbs) await cb(ctx)
    await new Promise((r) => setTimeout(r, 1200))
    expect(api.updates).toBeGreaterThan(before)
  })
})

// ---------- 密码认证 ----------
describe("password auth via query", () => {
  test("锁定后列表被拦截，unlock 表单提交恢复", async () => {
    await query(`add ${URI()}`)
    storeMod.lock()

    // 锁定态：显示锁定行（含 unlock 表单 action），无验证码
    const locked = await query("")
    expect(locked.Results.some((r) => (r.Title || "").includes("锁定") || (r.Title || "").includes("Locked"))).toBe(true)
    expect(locked.Results.some((r) => /\d{6}/.test(r.Title || ""))).toBe(false)
    const unlockRow = locked.Results[0].Actions.find((a) => a.Id === "totp:unlock")
    expect(unlockRow).toBeDefined()
    expect(unlockRow.Type).toBe("form")
    expect(unlockRow.IsDefault).toBe(true)
    // 解锁输入框用 password 类型掩码显示（Wox 支持，见 6846089）
    expect(unlockRow.Form[0].Type).toBe("password")

    // 错误密码：Notify 报错且保持锁定
    await unlockRow.OnSubmit(ctx, { Values: { password: "wrong-password" } })
    expect(api.notifies[0]).toMatch(/主密码错误|password/i)
    expect((await query("")).Results.some((r) => /\d{6}/.test(r.Title || ""))).toBe(false)

    // 正确密码：解锁并恢复验证码列表
    await unlockRow.OnSubmit(ctx, { Values: { password: "test-pass-123" } })
    const list = await query("")
    expect(list.Results.some((r) => /\d{6}/.test(r.Title || ""))).toBe(true)
  })

  test("password 表单改密：新密码生效", async () => {
    await query(`add ${URI()}`)
    const res = await query("password")
    const row = res.Results[0].Actions.find((a) => a.Id === "totp:password")
    expect(row).toBeDefined()
    expect(row.Type).toBe("form")
    await row.OnSubmit(ctx, { Values: { new_password: "new-pass-456" } })
    storeMod.lock()
    // 旧密码失效：锁定态 query("") 的默认 action 是 unlock 表单
    const unlockAction = (await query("")).Results[0].Actions.find((a) => a.Id === "totp:unlock")
    expect(unlockAction).toBeDefined()
    await unlockAction.OnSubmit(ctx, { Values: { password: "test-pass-123" } })
    expect(api.notifies.at(-1)).toMatch(/主密码错误|password/i)
    // 新密码解锁
    await unlockAction.OnSubmit(ctx, { Values: { password: "new-pass-456" } })
    expect((await query("")).Results.some((r) => /\d{6}/.test(r.Title || ""))).toBe(true)
  })

  test("3 天过期：到期后锁定，重新 unlock 恢复", async () => {
    await query(`add ${URI()}`)
    storeMod._test.setLastAuthAt(Date.now() - storeMod.AUTH_TTL_MS - 1000)
    const expired = await query("")
    expect(expired.Results.some((r) => (r.Title || "").includes("锁定") || (r.Title || "").includes("Locked"))).toBe(true)
    expect(expired.Results.some((r) => /\d{6}/.test(r.Title || ""))).toBe(false)
  })

  test("reset：锁定期可用，二次确认后清空存储回到未设置状态", async () => {
    await query(`add ${URI()}`)
    storeMod.lock()

    // 锁定期 reset 可用：显示警告 + 确认入口
    const warn = await query("reset")
    expect(warn.Results[0].Title).toMatch(/重置|Reset/)
    const goAction = warn.Results[0].Actions.find((a) => a.Id === "totp:reset:go")
    expect(goAction.IsDefault).toBe(true)

    // 第一步确认只是跳到 reset confirm，还没删
    await goAction.Action(ctx, {})
    expect(api.changes[0]).toBe("totp reset confirm")
    expect(state.settings.get("vault")).toBeTruthy()

    // confirm 提交后：setting 清空、回到未设置状态
    const confirmRes = await query("reset confirm")
    expect(confirmRes.Results[0].Title).toMatch(/已重置|Reset done/)
    expect(state.settings.get("vault")).toBe("")
    expect(storeMod.needsSetup()).toBe(true)
  })
})
