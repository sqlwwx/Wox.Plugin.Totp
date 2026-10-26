/**
 * 账户加密存储：Wox 插件 Setting（wox.db，IsLocal 不进云同步）。
 * 为什么不用 GetCacheFolder：插件升级 = 先卸载旧版，Wox core 会 RemoveAll 整个
 * 缓存目录（wox.core/plugin/store.go uninstallLocked → RemovePluginCacheDirectory），
 * 账号数据跟着陪葬；而升级路径 skipCleanSetting=true 保留插件 setting，
 * 只有用户手动卸载才清（语义正确）。
 * - AES-256-GCM 认证加密，密钥由主密码经 scrypt 派生（salt 存密文头，不存密码）
 * - 主密码/派生密钥只存内存（模块级变量）：进程重启丢失；3 天未验证自动清除
 * - 密文常驻内存（init 时经 initStore 从 setting 加载一次）：读路径纯内存同步，
 *   写路径经 SetSetting RPC 异步持久化（失败抛错，绝不静默丢数据）
 * @module store
 */
import crypto from "crypto"
import { err } from "./i18n.mjs"

const MAGIC = Buffer.from("WOTPE", "utf8") // 5 字节密文标识
const VERSION = 1
const SALT_LEN = 16
const IV_LEN = 12
const KEY_LEN = 32
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
export const AUTH_TTL_MS = 3 * 24 * 60 * 60 * 1000
const SETTING_KEY = "vault"

let storeApi = null
let storeCtx = null
let cloudSync = true // 插件设置 cloud_sync（默认 true）：false 时密文只存本地不上云同步
let encBlob = null // Buffer 密文（MAGIC+ver+salt+iv+tag+data）；null = 从未设置过主密码
let encKey = null // Buffer(32)，解锁后缓存，lock/过期/进程退出即消失
let encSalt = null
let lastAuthAt = 0

/**
 * 初始化：保存 api/ctx 并从插件 setting 加载密文（无记录 = needsSetup）。
 * @param {Object} api - Wox API
 * @param {Object} ctx - Wox 上下文
 * @returns {Promise<void>}
 */
export async function initStore(api, ctx) {
  storeApi = api
  storeCtx = ctx
  encBlob = null
  encKey = null
  encSalt = null
  lastAuthAt = 0
  // 云同步开关：设置缺省时用默认值 true（SettingDefinitions DefaultValue 一致）
  try {
    const v = await api.GetSetting(ctx, "cloud_sync")
    cloudSync = v === "" ? true : v === "true"
  } catch {
    cloudSync = true
  }
  try {
    const v = await api.GetSetting(ctx, SETTING_KEY)
    encBlob = v ? Buffer.from(v, "base64") : null
  } catch {
    encBlob = null
  }
}

/**
 * 插件设置 cloud_sync 变化：更新内存开关；开启同步时立即重写密文，
 * 否则已存在的密文不会进 oplog（云同步只推后续变更）。
 * @param {string} value - 新 setting 值（"true"/"false"）
 * @returns {Promise<void>}
 */
export async function onCloudSyncChanged(value) {
  cloudSync = value === "true"
  // 关同步不重写：本地数据不动，只是后续变更不再记 oplog；已有 oplog 用户可在 Wox 云同步设置里处理
  if (cloudSync && encBlob !== null) await persist()
}

/** 从未设置过主密码（setting 无密文） */
export function needsSetup() {
  return encBlob === null
}
/**
 * 是否处于已解锁会话（内存中有派生密钥）。
 * @returns {boolean}
 */
export function isUnlocked() {
  return !!encKey
}
/**
 * 是否处于锁定态：已设置过主密码且内存无密钥（未设置过不算锁定，算 needsSetup）。
 * @returns {boolean}
 */
export function isLocked() {
  return !needsSetup() && !isUnlocked()
}

function deriveKey(password, salt) {
  return crypto.scryptSync(String(password), salt, KEY_LEN, SCRYPT)
}

function encryptAccounts(key, salt, accounts) {
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
  const data = Buffer.concat([cipher.update(JSON.stringify({ accounts }), "utf8"), cipher.final()])
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv, cipher.getAuthTag(), data])
}

// 解析密文头，格式非法时抛错（setting 载体无文件可备份，只报损坏）
function parseEncBlob(raw) {
  const headerLen = MAGIC.length + 1 + SALT_LEN + IV_LEN + 16
  if (raw.length <= headerLen || !raw.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw err("err_corrupt", "invalid header")
  }
  const version = raw[MAGIC.length]
  if (version !== VERSION) {
    throw err("err_corrupt", `unsupported version ${version}`)
  }
  let off = MAGIC.length + 1
  const salt = raw.subarray(off, off + SALT_LEN); off += SALT_LEN
  const iv = raw.subarray(off, off + IV_LEN); off += IV_LEN
  const tag = raw.subarray(off, off + 16); off += 16
  return { salt, iv, tag, data: raw.subarray(off) }
}

/** 密文持久化到插件 setting（cloudSync=false 时 IsLocal 只存本地 wox.db，不进云同步） */
async function persist() {
  if (!storeApi) throw err("err_save_failed", "storage not initialized")
  const bytes = encBlob ? encBlob.length : 0
  const r = await storeApi.SetSetting(storeCtx, {
    Key: SETTING_KEY,
    Value: encBlob ? encBlob.toString("base64") : "",
    IsLocal: !cloudSync,
  })
  if (!r || !r.Success) throw err("err_save_failed", (r && r.ErrMsg) || "unknown error")
  try {
    await storeApi.Log(storeCtx, "Info", `vault persisted: ${bytes}B, cloudSync=${cloudSync}`)
  } catch {}
}

/**
 * 解锁/初始化。首次调用即设置主密码；已有密文时验证密码（GCM tag 校验，错误即失败）。
 * @param {string|number} password - 主密码（至少 6 位）
 * @returns {Promise<void>}
 * @throws {Error} 密码过短 / 主密码错误 / 持久化失败
 */
export async function unlock(password) {
  const pwd = String(password || "")
  if (pwd.length < 6) throw err("err_pwd_short")
  if (encBlob === null) {
    const salt = crypto.randomBytes(SALT_LEN)
    encKey = deriveKey(pwd, salt)
    encSalt = salt
    encBlob = encryptAccounts(encKey, salt, [])
    await persist()
    lastAuthAt = Date.now()
    return
  }
  const parsed = parseEncBlob(encBlob)
  const key = deriveKey(pwd, parsed.salt)
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, parsed.iv)
    decipher.setAuthTag(parsed.tag)
    decipher.update(parsed.data)
    decipher.final() // tag 不匹配在这里抛错 = 密码错误
  } catch {
    throw err("err_wrong_password")
  }
  encKey = key
  encSalt = parsed.salt
  lastAuthAt = Date.now()
}

/** 立即锁定：清空内存密钥/salt/上次认证时间。 */
export function lock() {
  encKey = null
  encSalt = null
  lastAuthAt = 0
}

/** 3 天未验证则自动清除内存密钥。返回当前是否处于锁定态 */
export function maybeExpire() {
  if (encKey && Date.now() - lastAuthAt > AUTH_TTL_MS) lock()
  return isLocked()
}

/** 解锁状态下读账户（纯内存解密）；锁定抛错（query 层会在更早处拦截） */
export function readAccounts() {
  if (!encKey) throw err("err_locked")
  const parsed = parseEncBlob(encBlob)
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", encKey, parsed.iv)
    decipher.setAuthTag(parsed.tag)
    const plain = Buffer.concat([decipher.update(parsed.data), decipher.final()]).toString("utf8")
    return JSON.parse(plain).accounts || []
  } catch (e) {
    throw err("err_decrypt_failed", e.message)
  }
}

/**
 * 解锁状态下读-改-写账户（整体重加密，异步持久化到 setting）。
 * @param {(accounts: Array<Object>) => any} mutator - 原地修改账户数组的回调
 * @returns {Promise<any>} mutator 的返回值
 * @throws {Error} 锁定态抛「已锁定，无法写入」；持久化失败抛错
 *   （失败时内存密文已更新、落库失败：进程退出最多丢本次变更，不破坏已有数据）
 */
export async function updateAccounts(mutator) {
  if (!encKey) throw err("err_locked_write")
  const accounts = readAccounts()
  const ret = mutator(accounts)
  encBlob = encryptAccounts(encKey, encSalt, accounts)
  await persist()
  return ret
}

/**
 * 修改主密码：新 salt 重新派生并整体重加密（数据保留）。
 * @param {string|number} newPwd - 新主密码（至少 6 位）
 * @returns {Promise<void>}
 * @throws {Error} 密码过短 / 锁定态 / 持久化失败
 */
export async function changePassword(newPwd) {
  const pwd = String(newPwd || "")
  if (pwd.length < 6) throw err("err_pwd_short")
  if (!encKey) throw err("err_locked")
  const accounts = readAccounts()
  const salt = crypto.randomBytes(SALT_LEN)
  encKey = deriveKey(pwd, salt)
  encSalt = salt
  encBlob = encryptAccounts(encKey, salt, accounts)
  await persist()
  lastAuthAt = Date.now()
}

/** 导出备份：整库密文原始字节（即 WOTPE 二进制格式），未设置主密码返回 null */
export function exportVault() {
  return encBlob
}

/**
 * 导入备份：解密备份密文原始字节并合并进当前库（不依赖当前解锁状态，密码只用于解备份）。
 * 合并语义与 add 一致：issuer+name 相同覆盖，其余追加。
 * @param {Buffer} raw - 备份密文原始字节（即 exportVault 的输出）
 * @param {string|number} password - 备份的主密码（可与当前库主密码不同）
 * @returns {Promise<{added: number, replaced: number}>}
 * @throws {Error} 备份格式非法 / 主密码错误 / 持久化失败
 */
export async function importVault(raw, password) {
  const parsed = parseEncBlob(raw)
  const key = deriveKey(password, parsed.salt)
  let accounts
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, parsed.iv)
    decipher.setAuthTag(parsed.tag)
    // GCM 认证通过才到这行，明文可信；JSON.parse 失败也按密码错误处理（tag 已过 = 只可能密码错）
    accounts = JSON.parse(Buffer.concat([decipher.update(parsed.data), decipher.final()]).toString("utf8")).accounts || []
  } catch {
    throw err("err_wrong_password")
  }
  let added = 0
  let replaced = 0
  await updateAccounts((accs) => {
    for (const a of accounts) {
      const i = accs.findIndex((x) => x.name === a.name && (x.issuer || "") === (a.issuer || ""))
      if (i >= 0) { accs[i] = a; replaced++ } else { accs.push(a); added++ }
    }
  })
  return { added, replaced }
}

/** 硬重置：清空 setting 回到未设置状态（忘记密码的兜底，数据不可恢复） */
export async function resetStorage() {
  encBlob = null
  lock()
  await persist() // Value 为空串 = 清除密文记录
}

/** 仅供测试：伪造上次认证时间验证过期逻辑 */
export const _test = {
  setLastAuthAt(t) {
    lastAuthAt = t
  },
}
