# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## [0.2.0](https://github.com/sqlwwx/wox-totp/compare/v0.1.0...v0.2.0) (2026-10-26)


### Features

* 支持备份导出/导入，.wotpe 主密码加密，导入扫描选择文件；Notify 类 action 加 preventHide 修复提示被吞 ([9322cca](https://github.com/sqlwwx/wox-totp/commit/9322cca737cfa9af5650040bf0c463707c875c55))

## [0.1.0](https://github.com/sqlwwx/wox-totp/compare/v0.0.6...v0.1.0) (2026-10-26)


### Features

* 回车直接输入验证码到活动窗口，不经过剪贴板（失败兜底复制） ([24655e5](https://github.com/sqlwwx/wox-totp/commit/24655e5dd16c14c66baf0bc7efe6424b1cec380d))

### [0.0.6](https://github.com/sqlwwx/wox-totp/compare/v0.0.5...v0.0.6) (2026-10-08)


### Features

* 密文云同步开关（默认开启，OnSettingChanged 切换时重写密文） ([f8389f4](https://github.com/sqlwwx/wox-totp/commit/f8389f41d6d56c542f9535684fe7b1252e3852ca))

### [0.0.5](https://github.com/sqlwwx/wox-totp/compare/v0.0.4...v0.0.5) (2026-10-08)


### Bug Fixes

* 密文改存插件 setting，升级不再清账号数据 ([c3ef05d](https://github.com/sqlwwx/wox-totp/commit/c3ef05d197cd176a236a66ba0adfa1438673f164))

### [0.0.4](https://github.com/sqlwwx/wox-totp/compare/v0.0.3...v0.0.4) (2026-09-30)

### [0.0.3](https://github.com/sqlwwx/wox-totp/compare/v0.0.2...v0.0.3) (2026-09-30)


### Bug Fixes

* .versionrc postbump 须嵌套在 scripts 键下（standard-version 源码 run-lifecycle-script 读 args.scripts） ([56ec3b2](https://github.com/sqlwwx/wox-totp/commit/56ec3b2e4683c576d3271d7ad3c2a76c65db57c0))

### 0.0.2 (2026-09-30)


### Features

* 查询建议命令按锁定状态动态注册，兼容 Wox 命令路由形态 ([d7f4e3b](https://github.com/sqlwwx/wox-totp/commit/d7f4e3b5c27a04d8ee74fb455cb9bb45f4a36720))
* 删除需二次确认（totp confirm 子命令）+ mock Wox API 集成测试 ([e49c992](https://github.com/sqlwwx/wox-totp/commit/e49c992ac6b0ee86fe55c0ed9c00ec35a7d73cfe))
* 剩余时间每秒实时更新（UpdateResult 原地刷新，翻转时同步 Actions） ([b4361b2](https://github.com/sqlwwx/wox-totp/commit/b4361b2fab7e333cb185b70f5027b2abeeea8a1b))
* 账户搜索支持拼音全拼/首字母/中英混合匹配 ([0663a3a](https://github.com/sqlwwx/wox-totp/commit/0663a3a7341aebdc880f4f1b1613515956823885))
* 支持 en_US/zh_CN 双语（I18n 字典 + GetTranslation 语言探测） ([3c30c2f](https://github.com/sqlwwx/wox-totp/commit/3c30c2f44d2484eca0cc611b8a78772c57f0b85e))
* 支持自定义别名及别名搜索 ([98c51b0](https://github.com/sqlwwx/wox-totp/commit/98c51b078710c5ca6388fc90efb95d4556322cb5))
* 重置入口 + 功能行菜单 + 排序修复 ([ec0d9c9](https://github.com/sqlwwx/wox-totp/commit/ec0d9c900d6e500f65e88311605f5c87b998b470))
* 主密码认证 + AES-256-GCM 加密存储 ([65ee290](https://github.com/sqlwwx/wox-totp/commit/65ee290f67162ec5b4104cb57620b1f60ef98195))
* add 成功直接显示该账户验证码行；修复 action 后 Wox 意外隐藏 ([38e42ba](https://github.com/sqlwwx/wox-totp/commit/38e42ba717c6664fec64ec997f7e9dceed171804))
* plugin.json 声明 Commands，兜底生成子命令建议 ([e10d840](https://github.com/sqlwwx/wox-totp/commit/e10d8402187b48f61fa92a6065cf855d51900130))
* TOTP 插件改为目录插件形式（wpm dev.add 注册，dist 热重载） ([84aca01](https://github.com/sqlwwx/wox-totp/commit/84aca012903032979a355a8f7e7ff85461ea7088))


### Bug Fixes

* 存储原子写+损坏备份，注册 OnUnload 清理 liveTimer ([ca09b00](https://github.com/sqlwwx/wox-totp/commit/ca09b004bf139bc1bcf7ceef37fb4e8433c3e8a4))
* 解锁密码输入框改为 password 类型，避免明文显示 ([6846089](https://github.com/sqlwwx/wox-totp/commit/6846089dae2ef6a0a870c2cb5c3ea242d8ab49c9))
* 刷新 timer 改事件驱动，面板隐藏/关闭时不再空转轮询 ([7016751](https://github.com/sqlwwx/wox-totp/commit/701675199ffde911bb9293ef0307b29c8f316144))
* 锁定态提示改为回车解锁表单，不再引导手敲 totp unlock ([9043d02](https://github.com/sqlwwx/wox-totp/commit/9043d029d8eeec131c938918c782fc6f1517ec88))
* 依赖源固定为官方 npm，修复 CI 安装 401 ([dd1838d](https://github.com/sqlwwx/wox-totp/commit/dd1838d92f55d6854e7bf2264e49e853a59bb37b))
* add 无 URI 时引导粘贴而非报 Invalid URI；ChangeQuery 类 action 加 PreventHideAfterAction 防回车隐藏；plugin.json 声明 TriggerQueryHints 子命令建议 ([9d08169](https://github.com/sqlwwx/wox-totp/commit/9d081697634c5b4078d505da4bb1ede8d08cac91))
* dev watch 构建失败不再退出进程，filename 为空不漏事件 ([8cb46f8](https://github.com/sqlwwx/wox-totp/commit/8cb46f8e6d0db763f226fac20244c63ad55c226d))
* form action 稳定 Id + timer 进程级单例 + 副标题秒数后置 ([d2f72cb](https://github.com/sqlwwx/wox-totp/commit/d2f72cb70bda8fef02aa7d5d46f2bfb899220df6))
* release 脚本工作区检查 execSync 返回 null 崩溃 ([d3799f2](https://github.com/sqlwwx/wox-totp/commit/d3799f26d0433648863a3dbf03d4619c443a1264))
