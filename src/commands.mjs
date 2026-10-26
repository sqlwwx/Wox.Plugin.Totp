/**
 * 命令逻辑：totp 的各子命令（reset/confirm/add/list）与查询分发。
 * 只管"做什么"，界面形状由 ui.mjs / views.mjs 构造。
 * @module commands
 */

import { getApi } from "./context.mjs"
import { t, tErr } from "./i18n.mjs"
import { totp, parseUri, remainingSeconds, matchAccount } from "./totp.mjs"
import { readAccounts, updateAccounts, resetStorage, lock, isLocked, needsSetup, maybeExpire } from "./store.mjs"
import { ICON_EXEC, ICON_DEL, ICON_LOCK, result, single, act, display, detail, rowId, confirmKey, findByConfirmKey } from "./ui.mjs"
import { lockedResult, passwordAction, buildActions } from "./views.mjs"
import { globalState } from "./live.mjs"

/**
 * 按锁定状态同步 Wox 查询建议命令（RegisterQueryCommands 是全量替换）。
 * 锁定态不注册任何命令 → 查询框无子命令建议；解锁后注册 add/password/lock。
 * RegisterQueryCommands 在老版本 Wox 上可能不存在，失败静默（只影响建议，不影响功能）。
 * @param {Object} ctx - Wox 上下文
 * @returns {Promise<void>}
 */
export async function syncQueryCommands(ctx) {
  const unlocked = !isLocked() && !needsSetup()
  if (unlocked === globalState.commandsSyncedUnlocked) return // 状态没变不重复注册
  const api = getApi()
  if (typeof api.RegisterQueryCommands !== "function") return
  try {
    const commands = unlocked
      ? ["add", "password", "lock"].map((cmd) => ({ Command: cmd, Description: t(`subcmd_${cmd}`) }))
      : []
    await api.RegisterQueryCommands(ctx, commands)
    globalState.commandsSyncedUnlocked = unlocked
  } catch {}
}

/**
 * 重置子命令（忘记密码的兜底）：硬重置，删除加密文件回到未设置状态。
 * 锁定期可用（这正是它存在的意义——密码忘了时唯一出路）。
 * 重置时读不出数据（不知道密码），账户全部丢失且不可恢复，所以必须二次确认：
 * `totp reset` 显示警告行，回车跳 `totp reset confirm` 才真删。
 * @param {string[]} parts - 查询词分段，parts[1] 为 "confirm" 时执行真删
 * @returns {Promise<{Results: Array<Object>}>}
 */
export async function qReset(parts) {
  if (parts[1] !== "confirm") {
    return single(t("reset_warning"), t("reset_hint"), [
      act(t("reset_confirm_yes"), ICON_DEL, async (actCtx) => {
        await getApi().ChangeQuery(actCtx, { QueryType: "input", QueryText: "totp reset confirm" })
      }, { isDefault: true, id: "totp:reset:go", preventHide: true }),
      act(t("confirm_cancel"), ICON_EXEC, async (actCtx) => {
        await getApi().ChangeQuery(actCtx, { QueryType: "input", QueryText: "totp " })
      }, { id: "totp:reset:cancel", preventHide: true }),
    ])
  }
  await resetStorage()
  lock()
  return single(t("reset_done"), t("reset_done_hint"), [])
}

/**
 * 删除确认：`totp confirm <key>` 显示确认行，回车才真删。
 * @param {string} key - confirmKey() 生成的账户键（可被 base64url 解码）
 * @returns {Promise<{Results: Array<Object>}>}
 */
export async function qConfirm(key) {
  const accounts = readAccounts()
  const i = key ? findByConfirmKey(accounts, key) : -1
  if (i < 0) {
    return single(t("confirm_gone"), t("view_codes"), [])
  }
  const a = accounts[i]
  const backToList = async (actCtx) => {
    await getApi().ChangeQuery(actCtx, { QueryType: "input", QueryText: "totp " })
  }
  return single(
    t("confirm_delete", display(a)),
    t("confirm_hint"),
    [
      act(t("confirm_yes"), ICON_DEL, async (actCtx) => {
        await updateAccounts((accs) => {
          const j = findByConfirmKey(accs, key)
          if (j >= 0) accs.splice(j, 1)
        })
        await getApi().Notify(actCtx, t("deleted", display(a)))
        await backToList(actCtx)
      }, { isDefault: true, preventHide: true }),
      act(t("confirm_cancel"), ICON_EXEC, backToList, { preventHide: true }),
    ]
  )
}

/**
 * 添加账户：`totp add <otpauth://totp/...>`，名字/issuer/参数都从 URI 解析。
 * secret 先验证合法性再入库，避免存进坏数据；同一 issuer+name 视为同一条目（覆盖）。
 * @param {string[]} parts - 查询词分段，parts[1] 为 otpauth URI
 * @returns {Promise<{Results: Array<Object>}>}
 */
export async function qAdd(parts) {
  // 无 URI（刚被引导填入 "totp add " 还没粘贴）：显示等待粘贴的引导行，不算错误
  if (!parts[1]) {
    return single(t("add_prompt"), t("err_uri_example"), [])
  }
  let entry
  try {
    entry = parseUri(parts[1])
  } catch (e) {
    return single(t("err_invalid_uri", tErr(e)), t("err_uri_example"), [])
  }
  try {
    totp(entry.secret, 0, entry.period, entry.digits, entry.algo)
  } catch (e) {
    return single(t("err_invalid_secret", tErr(e)), t("err_secret_hint"), [])
  }
  await updateAccounts((accounts) => {
    const i = accounts.findIndex((a) => a.name === entry.name && (a.issuer || "") === entry.issuer)
    if (i >= 0) accounts[i] = entry
    else accounts.push(entry)
  })
  // 添加成功直接显示该账户的验证码行（qList 全量渲染后过滤出这一条，倒计时/复制动作都在）
  const list = await qList("")
  return {
    Results: list.Results.filter((r) => r.Id === rowId(entry)),
  }
}

/**
 * 列出账户：按添加序渲染账号行（含验证码/剩余秒数/动作）。
 * @param {string} search - 搜索词；空串显示全部，否则按 issuer/name/alias 匹配
 * @returns {Promise<{Results: Array<Object>}>}
 */
export async function qList(search) {
  const accounts = readAccounts()
  if (accounts.length === 0) {
    return single(t("empty_title"), t("empty_subtitle"), [
      act(t("action_add"), ICON_EXEC, async (actCtx) => {
        await getApi().ChangeQuery(actCtx, { QueryType: "input", QueryText: "totp add " })
      }, { isDefault: true, id: "totp:empty:add", preventHide: true }),
    ])
  }

  const kw = search.toLowerCase()
  const matched = accounts.filter((a) => !kw || matchAccount(a, kw))
  if (matched.length === 0) {
    return single(t("no_match"), t("no_match_detail", accounts.length, search), [])
  }

  const results = matched.map((a, i) => {
    let code
    try {
      code = totp(a.secret, 0, a.period, a.digits, a.algo)
    } catch (e) {
      return result(a.name, t("err_invalid_secret", tErr(e)), [])
    }
    const remain = remainingSeconds(a.period)
    globalState.lastRendered.set(rowId(a), { code, remain })
    const sub = [detail(a), t("remain_enter", remain)].filter(Boolean).join(" · ")
    return {
      Id: rowId(a),
      // 账号行 1000 起、按添加序递减：保证账号整体排在功能行之前、账号间保持添加顺序
      ...result(`${display(a)}  ${code}`, sub, buildActions(a, code), [{ Type: "text", Text: `${remain}s` }], undefined, 1000 - i),
    }
  })
  return { Results: results }
}

/**
 * 查询主分发：解析子命令并路由到对应处理函数。
 * 顺序约定：密码相关子命令（不依赖数据解锁）最先；锁定期除 unlock/reset 外全部拦截；
 * confirm 为隐藏子命令（不进提示列表）。
 * @param {Object} ctx - Wox 上下文
 * @param {{Search: string}} query - Wox 查询对象
 * @returns {Promise<{Results: Array<Object>}>}
 */
export async function dispatchQuery(ctx, query) {
  const api = getApi()
  // 注册过 QueryCommands 后 core 会把命令解析进 query.Command（如 "totp add aaa" → Command="add", Search="aaa"），
  // 未注册时 Search 含命令前缀（"add ..."）→ 自己 split 出 cmd，两种形态都要兼容
  const search = (query.Search || "").trim()
  const cmd = (query.Command || "").trim() || search.split(/\s+/).filter(Boolean)[0] || ""
  const rest = query.Command ? search : search.split(/\s+/).filter(Boolean).slice(1).join(" ")
  const parts = [cmd, ...rest.split(/\s+/).filter(Boolean)]

  maybeExpire() // 3 天未验证自动清内存密钥
  await syncQueryCommands(ctx) // 状态变化时同步查询建议命令
  if (cmd === "unlock") return lockedResult() // 回车弹表单，密码掩码输入
  if (cmd === "reset") return await qReset(parts) // 忘记密码时的硬重置入口（锁定期也可用）
  if (cmd === "lock") {
    lock()
    return single(t("locked_title"), t("view_codes"), [])
  }
  if (cmd === "password") {
    return single(t("password_usage"), t("password_usage_hint"), [passwordAction()])
  }
  if (isLocked()) return lockedResult()
  if (needsSetup()) return lockedResult()

  if (cmd === "confirm") return await qConfirm(parts[1])
  if (cmd === "add") return await qAdd(parts)

  const accounts = readAccounts()
  const list = await qList(search)
  // 空输入时在账号后面依次追加功能行（按常用度）：锁定、添加账号、修改密码、重置
  // 有搜索词时不加功能行（避免干扰搜索结果）
  const funcRows = !cmd
    ? [
        result(t("subcmd_lock"), t("subcmd_lock_detail"), [
          act(t("subcmd_lock"), ICON_LOCK, async (actCtx) => {
            lock()
            await api.Notify(actCtx, t("locked_title"))
            await api.RefreshQuery(actCtx, { PreserveSelectedIndex: true })
          }, { isDefault: true, id: "totp:row:lock", preventHide: true }),
        ], null, "totp:row:lock-item", 900),
        result(t("action_add"), t("subcmd_add"), [
          act(t("action_add"), ICON_EXEC, async (actCtx) => {
            await api.ChangeQuery(actCtx, { QueryType: "input", QueryText: "totp add " })
          }, { isDefault: true, id: "totp:row:add", preventHide: true }),
        ], null, "totp:row:add-item", 800),
        result(t("subcmd_password"), t("subcmd_password_detail"), [
          passwordAction(),
        ], null, "totp:row:password-item", 700),
        result(t("subcmd_reset"), t("subcmd_reset_detail"), [
          act(t("subcmd_reset"), ICON_DEL, async (actCtx) => {
            await api.ChangeQuery(actCtx, { QueryType: "input", QueryText: "totp reset" })
          }, { isDefault: true, id: "totp:row:reset", preventHide: true }),
        ], null, "totp:row:reset-item", 600),
      ]
    : []
  // build 时间行仅开发构建（--watch 注入 __BUILD_TIME__）时显示，用于确认热重载生效
  // globalThis 而非裸标识符：测试直接 import 源码时没有 Bun define，裸标识符会抛 ReferenceError
  const buildRow = !cmd && globalThis.__BUILD_TIME__ ? [result(`build ${globalThis.__BUILD_TIME__}`, t("build_row_detail", accounts.length), [])] : []
  return { Results: [...list.Results, ...funcRows, ...buildRow] }
}
