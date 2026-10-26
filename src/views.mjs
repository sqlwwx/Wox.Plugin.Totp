/**
 * 视图：结果行与表单 action 的具体构造（锁定态、解锁/改密表单、账号行 actions）。
 * 这里只管"长什么样"，数据读写走 store，翻译走 i18n。
 * @module views
 */

import { t, tErr } from "./i18n.mjs"
import { getApi } from "./context.mjs"
import { writeFile, readFile } from "fs/promises"
import os from "os"
import { unlock, changePassword, updateAccounts, needsSetup, exportVault, importVault } from "./store.mjs"
import { typeText } from "./typetext.mjs"
import { totp } from "./totp.mjs"
import { ICON_EXEC, ICON_DEL, ICON_COPY, result, single, act, display, detail, rowId, confirmKey } from "./ui.mjs"

/**
 * needsSetup 的防御包装：store 未初始化 cacheDir 时会抛错，视图层不该因此崩溃。
 * @returns {boolean}
 */
function needsSetupSafe() {
  try {
    return needsSetup()
  } catch {
    return false
  }
}

// ---------- 锁定/主密码 ----------
// 密码认证：主密码加密存储配置，派生密钥只存内存，3 天未验证自动清除

/**
 * 锁定态结果列表（两行）：
 * ①锁定行——默认回车 = unlock 表单；
 * ②重置行——忘记密码兜底，回车跳 reset 警告页（不直接清数据）。
 * @param {boolean} [errLine] - 是否处于"密码错误重试"状态
 * @returns {{Results: Array<Object>}}
 */
export function lockedResult(errLine) {
  const sub = errLine ? t("locked_retry") : needsSetupSafe() ? t("locked_setup_hint") : t("locked_hint")
  return {
    Results: [
      result(t("locked_title"), sub, [unlockAction()], undefined, undefined, 910),
      result(t("reset_entry"), t("reset_hint"), [
        act(t("reset_entry"), ICON_DEL, async (actCtx) => {
          await getApi().ChangeQuery(actCtx, { QueryType: "input", QueryText: "totp reset" })
        }, { isDefault: true, id: "totp:locked:reset", preventHide: true }),
      ], null, "totp:locked:reset-row", 600),
    ],
  }
}

/**
 * unlock 入口行：回车弹出表单。
 * Wox 插件表单无 password 类型（枚举只有 textbox 等，写 "password" 会报
 * unknown setting type），密码以 textbox 明文输入是现有约束下的取舍。
 * @returns {Object} Type=form 的 action
 */
function unlockAction() {
  return {
    Id: "totp:unlock",
    Type: "form",
    Name: t("unlock_usage"),
    Icon: ICON_EXEC,
    IsDefault: true,
    PreventHideAfterAction: true,
    Form: [
      {
        Type: "password",
        Value: {
          Key: "password",
          Label: t("password_label"),
          DefaultValue: "",
          MaxLines: 1,
        },
        DisabledInPlatforms: [],
        IsPlatformSpecific: false,
      },
    ],
    OnSubmit: async (formCtx, actionContext) => {
      const pwd = (actionContext.Values.password || "").trim()
      try {
        await unlock(pwd)
        await getApi().Notify(formCtx, needsSetupSafe() ? t("password_set") : t("unlocked"))
        await getApi().RefreshQuery(formCtx, { PreserveSelectedIndex: true })
      } catch (e) {
        await getApi().Notify(formCtx, `TOTP: ${tErr(e)}`)
      }
    },
  }
}

/**
 * 修改主密码入口行（需已解锁态）：表单输入新密码，提交后全量重加密。
 * @returns {Object} Type=form 的 action
 */
export function passwordAction() {
  return {
    Id: "totp:password",
    Type: "form",
    Name: t("password_usage"),
    Icon: ICON_EXEC,
    IsDefault: true,
    PreventHideAfterAction: true,
    Form: [
      {
        Type: "textbox",
        Value: {
          Key: "new_password",
          Label: t("new_password_label"),
          DefaultValue: "",
          MaxLines: 1,
        },
        DisabledInPlatforms: [],
        IsPlatformSpecific: false,
      },
    ],
    OnSubmit: async (formCtx, actionContext) => {
      const pwd = (actionContext.Values.new_password || "").trim()
      try {
        await changePassword(pwd)
        await getApi().Notify(formCtx, t("password_changed"))
        await getApi().RefreshQuery(formCtx, { PreserveSelectedIndex: true })
      } catch (e) {
        await getApi().Notify(formCtx, `TOTP: ${tErr(e)}`)
      }
    },
  }
}

/**
 * 导出备份：整库密文（主密码 AES-256-GCM 加密）写成文件到 ~/Downloads。
 * 密文文件可存任意位置/上云，只有主密码能解；仅解锁态展示（needsSetup 已在上游拦截）。
 * @returns {Object} action
 */
export function exportVaultAction() {
  return act(t("export_row"), ICON_COPY, async (actCtx) => {
    const data = exportVault()
    if (!data) return
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
    const path = `${os.homedir()}/Downloads/totp-backup-${ts}.wotpe`
    await writeFile(path, data)
    await getApi().Notify(actCtx, t("exported", path))
  }, { isDefault: true, id: "totp:row:export", preventHide: true })
}

/**
 * 导入备份：表单输入备份的主密码，解密合并进当前库。
 * 备份主密码可与当前库主密码不同。
 * path 非空时直接用（扫描列表选中，路径在闭包里）；为空时表单带路径输入框（手动兜底）。
 * @param {string|null} path - 备份 .wotpe 文件绝对路径
 * @returns {Object} Type=form 的 action
 */
export function importVaultForm(path) {
  const fields = []
  if (!path) {
    fields.push({
      Type: "textbox",
      Value: {
        Key: "path",
        Label: t("import_file_label"),
        DefaultValue: "",
        MaxLines: 1,
      },
      DisabledInPlatforms: [],
      IsPlatformSpecific: false,
    })
  }
  fields.push({
    Type: "password",
    Value: {
      Key: "password",
      Label: t("import_pwd_label"),
      DefaultValue: "",
      MaxLines: 1,
    },
    DisabledInPlatforms: [],
    IsPlatformSpecific: false,
  })
  return {
    Id: path ? `totp:import:${path}` : "totp:import",
    Type: "form",
    Name: t("subcmd_import"),
    Icon: ICON_EXEC,
    IsDefault: true,
    PreventHideAfterAction: true,
    Form: fields,
    OnSubmit: async (formCtx, actionContext) => {
      try {
        const p = path || (actionContext.Values.path || "").trim()
        const raw = await readFile(p)
        const { added, replaced } = await importVault(raw, (actionContext.Values.password || "").trim())
        if (added + replaced === 0) {
          await getApi().Notify(formCtx, t("import_empty"))
          return
        }
        await getApi().Notify(formCtx, t("imported", added, replaced))
        await getApi().RefreshQuery(formCtx, { PreserveSelectedIndex: true })
      } catch (e) {
        await getApi().Notify(formCtx, `TOTP: ${tErr(e)}`)
      }
    },
  }
}

/**
 * 账号行的动作集合：复制当前码 / 复制下一周期码 / 设置别名（表单）/ 删除（二次确认）。
 * @param {{issuer?: string, name: string, alias?: string, secret: string, period?: number, digits?: number, algo?: string}} a - 账户
 * @param {string} code - 当前验证码
 * @returns {Array<Object>} action 数组
 */
export function buildActions(a, code) {
  const rid = rowId(a)
  const api = getApi()
  // 直接输入到活动窗口（不碰剪贴板）：先 HideApp 让焦点回到目标窗口，
  // 再由插件 shell 调平台原生工具注入（官方未公开 TypeText API，见 typetext.mjs）
  const typeCode = async (actCtx) => {
    await api.HideApp(actCtx)
    // 焦点沉降：HideApp 后目标窗口需要一点时间接收焦点
    await new Promise((r) => setTimeout(r, 150))
    try {
      await typeText(code)
    } catch (e) {
      // 失败兜底：复制到剪贴板并提示，保证验证码始终可用
      api.Log(actCtx, "Error", `typeText 失败: ${e.message}`)
      await api.Copy(actCtx, { type: "text", text: code })
      await api.Notify(actCtx, `TOTP: ${t("type_failed_copied", e.message)}`)
    }
  }
  return [
    // 回车默认直接输入到活动窗口（不碰剪贴板），复制保留为普通 action
    act(t("type_code", code), ICON_EXEC, typeCode, { isDefault: true, id: `${rid}:type` }),
    // preventHide：窗口在 action 返回后立即被 core 隐藏，Notify 转系统通知通道会静默（无通知权限时），
    // 只靠 Notify 反馈的 action 必须保持窗口可见才能看到应用内提示
    act(t("copy_code", code), ICON_COPY, async (actCtx) => {
      await api.Copy(actCtx, { type: "text", text: code })
      await api.Notify(actCtx, t("copied", display(a)))
    }, { id: `${rid}:copy`, preventHide: true }),
    act(t("copy_next"), ICON_EXEC, async (actCtx) => {
      const next = totp(a.secret, 1, a.period, a.digits, a.algo)
      await api.Copy(actCtx, { type: "text", text: next })
      await api.Notify(actCtx, t("copied_next", next))
    }, { id: `${rid}:copy_next`, preventHide: true }),
    {
      // 别名用表单收集：文本框 + 提交保存；留空提交即清除别名
      // Type 必须显式为 "form"；Id 必须稳定，见 ui.mjs act() 的 JSDoc
      Id: `${rid}:alias`,
      Type: "form",
      Name: t("set_alias"),
      Icon: ICON_EXEC,
      PreventHideAfterAction: true,
      Form: [
        {
          Type: "textbox",
          Value: {
            Key: "alias",
            Label: t("alias_label"),
            DefaultValue: a.alias || "",
            MaxLines: 1,
          },
          DisabledInPlatforms: [],
          IsPlatformSpecific: false,
        },
      ],
      OnSubmit: async (formCtx, actionContext) => {
        const alias = (actionContext.Values.alias || "").trim()
        await updateAccounts((accs) => {
          const j = accs.findIndex((x) => x.name === a.name && (x.issuer || "") === (a.issuer || ""))
          if (j >= 0) {
            if (alias) accs[j].alias = alias
            else delete accs[j].alias
          }
        })
        await getApi().Notify(formCtx, alias ? t("alias_saved", alias) : t("alias_cleared"))
        await getApi().RefreshQuery(formCtx, { PreserveSelectedIndex: true })
      },
    },
    act(t("delete_account"), ICON_DEL, async (actCtx) => {
      // 二次确认：跳到 confirm 子命令，回车确认行才真删
      await api.ChangeQuery(actCtx, {
        QueryType: "input",
        QueryText: `totp confirm ${confirmKey(a)}`,
      })
    }, { id: `${rid}:delete`, preventHide: true }),
  ]
}
