# Wox.Plugin.Totp

Wox 目录插件（非 single-file）：快速查询并复制 TOTP 验证码（Google Authenticator 兼容，RFC 6238）。基于 GPL-3.0 发布。

## 功能

- `totp` 触发，列出所有账户及当前验证码，回车复制
- 列表显示 `issuer · 账户名`，支持 SHA1/SHA256/SHA512、自定义 digits/period
- 剩余时间显示，支持复制下一周期验证码
- 关键字过滤账户：支持原文匹配（不区分大小写）
- 自定义别名：操作面板「设置别名」，列表显示别名、原名退到副标题；别名支持原文搜索，留空提交即清除
- 支持 `otpauth://totp/...` 链接添加，完整保留 URI 参数

## 命令

```
totp                        列出账户及验证码
totp <关键字>               过滤账户（issuer/账户名/别名，不区分大小写）
totp add <otpauth://totp/...>     通过 otpauth 链接添加（自动解析 issuer/账户名，同 issuer+name 覆盖）
totp unlock                 解锁 / 设置主密码（弹窗表单，密码掩码输入）
totp lock                   立即锁定（清除内存密钥）
totp password               修改主密码（弹窗输入，数据保留）
totp import [关键字]         导入备份（列出 Downloads/Desktop 下的 .wotpe，选中行回车输备份主密码；可带关键字过滤文件名）
totp reset                  危险：清空全部数据（忘记密码的兜底，跳 totp reset confirm 二次确认才真删）
```

- 删除不走子命令：列表结果的操作面板里有「删除此账户」，会跳到确认行，回车才真删。
- 锁定/未设置主密码时，除 `unlock`/`reset` 外的查询全部拦截为解锁表单；查询框的子命令建议（add/password/import/lock）解锁后才显示。
- 空输入列表尾部附功能行（按常用度）：锁定、添加账号、修改密码、导入备份、导出备份、重置。
- 备份即密文：导出把整库密文写成 `~/Downloads/totp-backup-<时间戳>.wotpe`（WOTPE 二进制格式，主密码 AES-256-GCM 加密，可存网盘/跨机迁移），导入从扫描列表选中文件 + 该备份的主密码解密合并——备份密码可与当前库主密码不同。

## 安装

在 Wox 查询框执行（需 Wox ≥ 2.4.2，Node.js ≥ 20）：

```
wpm dev.add /Users/wuweixing/lab/sqlwwx/wox-totp
```

`wpm dev.add` 注册根目录后，Wox 读取根目录 `plugin.json` 做元数据校验；构建时会把 `plugin.json` 拷入 `dist/`，启动/热重载实际读取的是 `dist/plugin.json`（Entry "index.js" 相对 dist/ 解析）。无 `dist/plugin.json` 时重载失败，所以注册后先 `make build`。

## 存储

密文存在 Wox 插件 setting（wox.db，key 为 `vault`）。AES-256-GCM 加密，顶层结构 `{ "accounts": [...] }`，每条目存完整 otpauth URI + 解析字段：

> 为什么不放 GetCacheFolder：插件升级 = Wox 先卸载旧版（RemoveAll 整个缓存目录），账号数据会陪葬；插件 setting 在升级路径（skipCleanSetting）保留，只有手动卸载才清。

### 备份与跨设备迁移

密文默认经 **Wox 云同步**多设备同步（插件设置里的「云同步加密库」开关，默认开启）。密文是 AES-256-GCM 加密的，同步只上传密文；但服务端密文可被离线无限期暴力破解，**主密码请用 12 位以上**。关掉开关则只存本地 wox.db（`IsLocal`）。

不依赖云同步的手动迁移：

```bash
# 备份：导出密文（base64，无主密码不可解密）
sqlite3 ~/.wox/wox-user/wox.db \
  "SELECT value FROM plugin_settings WHERE plugin_id='ef529aa0-1288-4a8c-b061-b98389491b4e' AND key='vault'" \
  > totp-vault-backup.txt

# 还原（新机器需先装插件，然后退出 Wox 执行）：
V=$(cat totp-vault-backup.txt)
sqlite3 ~/.wox/wox-user/wox.db \
  "INSERT OR REPLACE INTO plugin_settings (plugin_id, key, value, is_local) \
   VALUES ('ef529aa0-1288-4a8c-b061-b98389491b4e', 'vault', '$V', 1)"
```

还原后启动 Wox，`totp unlock` 输**原机器的主密码**即可（主密码跟密文绑定，一起迁移）。

```json
{ "name": "me@x.com", "issuer": "GitHub", "secret": "...", "digits": 6, "period": 30, "algo": "SHA1", "uri": "otpauth://totp/..." }
```

### 主密码

- 首次使用输入 `totp unlock` 回车，弹窗设置主密码（≥6 位）
- 密钥由主密码经 scrypt（N=16384）派生，**只存内存**；3 天未验证自动清除，下次查询要求重新输入
- ⚠️ **免输期 = 插件进程存活时间，上限 3 天**：解锁密钥不在磁盘做任何持久化，Wox 重启（含开机自启）、插件热重载都会清空内存、立即回到锁定态。3 天 TTL 仅在 Wox 长期不重启时生效；且 TTL 不随使用刷新——解锁成功后第 3 天必锁，即使期间一直在用。实际体感通常是「每次重启 Wox 后需重新输一次密码」，这是密钥不落盘的既定取舍
- `totp lock` 手动锁定，`totp password` 修改主密码（弹窗输入，掩码显示）
- 密文被篡改时 GCM 校验失败，unlock 拒绝并报「加密存储损坏」
- 写入经 `SetSetting` RPC 持久化到 wox.db，失败即抛错（不静默丢数据）

## 开发

ESM 源码（src/*.mjs），Bun.build 打包成单文件 CJS 到 `dist/index.js`。运行时行为依赖 Node 内置 crypto，无外部依赖。

```
make build       # src → dist/index.js（每次全量构建）
make dev         # watch 模式，改完自动构建 → Wox watch dist/ 自动热重载（2s 防抖）
make test        # 构建 + 单测（RFC 6238 向量、URI 解析）+ 集成（mock Wox API）
make clean       # 删 dist
```

结构：

```
plugin.json     # Wox 元数据 + 全部 en_US/zh_CN i18n 文案（运行时读的是 dist/ 下拷贝）
src/
  index.mjs     # init/query 生命周期装配，导出 plugin = { init, query }
  totp.mjs      # base32 / RFC 6238 / otpauth URI 解析与构造（纯函数无状态）
  store.mjs     # AES-256-GCM 加密存储 + 解锁会话（scrypt 派生，密钥只存内存）
  commands.mjs  # 子命令分发与查询路由（dispatchQuery）
  views.mjs     # 结果行与表单 action（锁定态/账号动作）
  ui.mjs        # Wox Result/Action 基础构造
  live.mjs      # 验证码每秒实时刷新（进面板才起 timer，离开即停）
  i18n.mjs      # 翻译运行时，读 plugin.json 内嵌字典
  context.mjs   # 模块级 api/ctx 存取
build.mjs       # Bun.build 打包脚本（src → dist/index.js 单文件 CJS）
test/           # bun test，与 src 模块一一对应（<module>.test.mjs）
dist/           # 产物（Wox watch 这个目录实现热重载）
```

注意：package.json 不要加 `"type": "module"` —— 会让 Wox 加载 dist .js 时按 ESM 解析报错。

## 二期计划

- 复制验证码并粘贴到当前活动应用（Copy + 模拟 Cmd+V）
- WebDAV 同步（多设备）
