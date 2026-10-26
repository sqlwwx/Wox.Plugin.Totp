// store 加密存储单测：AES-256-GCM + scrypt、主密码生命周期、setting 载体读写
import { describe, test, expect, beforeEach } from "bun:test"
import {
  initStore, readAccounts, updateAccounts, unlock, lock, resetStorage, onCloudSyncChanged,
  needsSetup, isUnlocked, isLocked, maybeExpire, changePassword, exportVault, importVault,
  AUTH_TTL_MS, _test,
} from "../src/store.mjs"

// mock Wox setting 存储：内存 KV，模拟 GetSetting/SetSetting RPC（含持久化语义：
// 重载 initStore 后仍能读到上次写的值——升级后数据仍在的核心保障）
let settings
let api

beforeEach(async () => {
  settings = new Map()
  api = {
    GetSetting: async (_ctx, key) => settings.get(key) || "",
    SetSetting: async (_ctx, option) => {
      settings.set(option.Key, option.Value)
      return { Success: true }
    },
  }
  await initStore(api, {})
})

describe("首次设置（needsSetup）", () => {
  test("setting 无密文 = 需要设置", () => {
    expect(needsSetup()).toBe(true)
    expect(isLocked()).toBe(false) // 未设置过不算锁定
  })

  test("unlock 设置主密码并持久化密文到 setting", async () => {
    await unlock("secret123")
    expect(isUnlocked()).toBe(true)
    const raw = Buffer.from(settings.get("vault"), "base64")
    expect(raw.subarray(0, 5).toString()).toBe("WOTPE")
    // 密文中不出现明文账户数据
    expect(raw.includes("GitHub")).toBe(false)
  })

  test("密码过短拒绝", async () => {
    await expect(unlock("12345")).rejects.toThrow("err_pwd_short")
  })
})

describe("锁定与解锁", () => {
  beforeEach(async () => unlock("secret123"))

  test("lock 后读取抛错，重新 unlock 恢复", async () => {
    lock()
    expect(isLocked()).toBe(true)
    expect(() => readAccounts()).toThrow("err_locked")
    await unlock("secret123")
    expect(readAccounts()).toHaveLength(0)
  })

  test("错误密码解锁失败且保持锁定", async () => {
    lock()
    await expect(unlock("wrong-password")).rejects.toThrow("err_wrong_password")
    expect(isLocked()).toBe(true)
    // 正确密码可再解锁
    await unlock("secret123")
    expect(isUnlocked()).toBe(true)
  })

  test("3 天未验证自动过期", () => {
    expect(maybeExpire()).toBe(false)
    _test.setLastAuthAt(Date.now() - AUTH_TTL_MS - 1000)
    expect(maybeExpire()).toBe(true)
    expect(isLocked()).toBe(true)
    expect(() => readAccounts()).toThrow()
  })

  test("写入需要解锁态，写后可读回", async () => {
    await updateAccounts((a) => a.push({ name: "x", issuer: "", secret: "S" }))
    lock()
    await unlock("secret123")
    expect(readAccounts()[0].name).toBe("x")
  })
})

describe("setting 载体持久化", () => {
  beforeEach(async () => unlock("secret123"))

  test("重载（模拟插件升级/重启）后数据仍在、密码仍有效", async () => {
    await updateAccounts((a) => a.push({ name: "keep", issuer: "", secret: "S" }))
    // 模拟热重载：重新 initStore，setting 数据不丢
    await initStore(api, {})
    expect(needsSetup()).toBe(false)
    await unlock("secret123")
    expect(readAccounts()[0].name).toBe("keep")
  })

  test("SetSetting 失败：写入抛错，数据不静默丢失", async () => {
    api.SetSetting = async () => ({ Success: false, ErrMsg: "db locked" })
    await expect(updateAccounts((a) => a.push({ name: "f", issuer: "", secret: "S" }))).rejects.toThrow("err_save_failed")
  })

  test("cloud_sync=false：persist 带 IsLocal=true 只存本地", async () => {
    settings.set("cloud_sync", "false")
    await initStore(api, {})
    const calls = []
    api.SetSetting = async (_c, o) => { calls.push(o); settings.set(o.Key, o.Value); return { Success: true } }
    await unlock("secret123")
    await updateAccounts((a) => a.push({ name: "n", issuer: "", secret: "S" }))
    expect(calls[0].IsLocal).toBe(true)
  })

  test("cloud_sync 开启时 onCloudSyncChanged 立即重写密文", async () => {
    settings.set("cloud_sync", "false")
    await initStore(api, {})
    await unlock("secret123")
    // 切到同步：立即重写
    const calls = []
    api.SetSetting = async (_c, o) => { calls.push(o); settings.set(o.Key, o.Value); return { Success: true } }
    await onCloudSyncChanged("true")
    expect(calls).toHaveLength(1)
    expect(calls[0].IsLocal).toBe(false)
    // 关同步：不重写（本地数据不动）
    calls.length = 0
    await onCloudSyncChanged("false")
    expect(calls).toHaveLength(0)
  })

  test("改密后新密码可解锁、旧密码失效", async () => {
    await updateAccounts((a) => a.push({ name: "y", issuer: "", secret: "S" }))
    await changePassword("newpass456")
    lock()
    await expect(unlock("secret123")).rejects.toThrow("err_wrong_password")
    await unlock("newpass456")
    expect(readAccounts()[0].name).toBe("y")
  })

  test("锁定态改密拒绝", async () => {
    lock()
    await expect(changePassword("newpass456")).rejects.toThrow("err_locked")
  })

  test("reset：清空 setting 回到未设置状态", async () => {
    await updateAccounts((a) => a.push({ name: "z", issuer: "", secret: "S" }))
    await resetStorage()
    expect(needsSetup()).toBe(true)
    // 重载后仍是未设置（setting 里已无密文）
    await initStore(api, {})
    expect(needsSetup()).toBe(true)
  })
})

describe("导入导出", () => {
  test("导出密文即整库备份：WOTPE 格式，原密码可解回，错误密码拒绝", async () => {
    await unlock("secret123")
    await updateAccounts((a) => a.push({ name: "imp", issuer: "GI", secret: "S" }))
    const raw = exportVault()
    expect(raw.subarray(0, 5).toString()).toBe("WOTPE")
    // 模拟换机/新库（不同主密码）导入
    await resetStorage()
    await unlock("other456")
    await expect(importVault(raw, "wrong-pwd")).rejects.toThrow("err_wrong_password")
    expect(readAccounts()).toHaveLength(0) // 导入失败不污染当前库
    const r = await importVault(raw, "secret123")
    expect(r).toEqual({ added: 1, replaced: 0 })
    expect(readAccounts()[0].name).toBe("imp")
  })

  test("重复导入：issuer+name 相同覆盖不重复（与 add 语义一致）", async () => {
    await unlock("secret123")
    await updateAccounts((a) => a.push({ name: "imp", issuer: "GI", secret: "S" }))
    const raw = exportVault()
    const r = await importVault(raw, "secret123")
    expect(r).toEqual({ added: 0, replaced: 1 })
    expect(readAccounts()).toHaveLength(1)
  })

  test("备份内容非法报 err_corrupt", async () => {
    await unlock("secret123")
    await expect(importVault(Buffer.from("garbage data"), "secret123")).rejects.toThrow("err_corrupt")
  })

  test("未设置主密码时导出返回 null", async () => {
    expect(exportVault()).toBeNull()
  })
})

describe("密文损坏", () => {
  test("密文被篡改：GCM tag 校验使 unlock 失败（认证加密整体校验）", async () => {
    await unlock("secret123")
    await updateAccounts((a) => a.push({ name: "z", issuer: "", secret: "S" }))
    lock()
    // 篡改 setting 里的密文（base64 解出后改尾字节再存回，模拟 wox.db 记录损坏）
    const raw = Buffer.from(settings.get("vault"), "base64")
    raw[raw.length - 1] ^= 0xff
    settings.set("vault", raw.toString("base64"))
    await initStore(api, {})
    await expect(unlock("secret123")).rejects.toThrow("err_wrong_password")
    expect(isLocked()).toBe(true)
  })

  test("密文头非法：unlock 报 err_corrupt", async () => {
    await unlock("secret123")
    lock()
    settings.set("vault", Buffer.from("garbage data").toString("base64"))
    await initStore(api, {})
    await expect(unlock("secret123")).rejects.toThrow("err_corrupt")
  })
})
