// bun 打包：src/index.mjs → dist/index.js（单文件 CJS，Entry 见根目录 plugin.json）
// 目录插件形式：make dev 注册后，Wox watch dist/，产物变化自动热重载（无需手动部署）
// --watch：用 fs.watch 监视 src/，变化后自动重建
import { copyFileSync, mkdirSync, watch } from "fs"

const options = {
  entrypoints: ["src/index.mjs"],
  outdir: "dist",
  format: "cjs", // Wox nodejs 插件入口是 CommonJS
  target: "node",
  // 编译时间仅 --watch（开发时）注入，用于确认热重载生效；正式构建不注入 → build 行不显示
  define: process.argv.includes("--watch")
    ? { __BUILD_TIME__: JSON.stringify(new Date().toLocaleString("sv-SE")) }
    : { __BUILD_TIME__: JSON.stringify("") },
}

let building = null

const build = async () => {
  try {
    await Bun.build(options)
    copyFileSync("plugin.json", "dist/plugin.json") // Wox 加载/热重载读 dist/plugin.json（官方模板同款结构）
    // Icon 是 relative:images/icon.svg，dist 即插件目录，图标须随构建拷入（SVG 全链路矢量渲染，商店 IconUrl 同源）
    mkdirSync("dist/images", { recursive: true })
    copyFileSync("images/icon.svg", "dist/images/icon.svg")
    console.log(`[${new Date().toLocaleTimeString()}] build → dist/index.js`)
  } catch (e) {
    // 保存瞬间的语法错误很常见：打印错误但绝不能让进程退出，否则 watch 就死了
    console.error(`[${new Date().toLocaleTimeString()}] build failed:\n${e.message ?? e}`)
  }
}

if (process.argv.includes("--watch")) {
  process.on("uncaughtException", (e) => console.error("[watch] uncaught:", e))
  process.on("unhandledRejection", (e) => console.error("[watch] unhandled:", e))

  await build()
  // 队列化：构建中到来的变更记为 dirty，结束后再补一次构建，不丢事件
  let dirty = false
  let timer = null

  const schedule = () => {
    if (building) {
      dirty = true
      return
    }
    building = build().finally(() => {
      building = null
      if (dirty) {
        dirty = false
        schedule()
      }
    })
  }

  // FSEvents 下 filename 可能为 null（尤其跨编辑器原子保存/目录事件），不能靠它过滤
  watch("src", { recursive: true }, () => {
    clearTimeout(timer) // 编辑器保存常触发多次事件，300ms 去抖
    timer = setTimeout(schedule, 300)
  })
  console.log("watching src/ → dist/index.js (Ctrl+C 退出)")
} else {
  await build()
}
