.PHONY: build dev test clean package patch minor major

build:
	bun build.mjs

dev:
	bun build.mjs --watch

test: build
	bun test test/

clean:
	rm -rf dist

# 打包 .wox（本质是 zip）：Wox 商店安装 = 下载后 Unzip 到插件目录，
# plugin.json 必须在 zip 根（无包裹目录），资产名固定供 releases/latest/download 引用
package: build
	cd dist && zip -r ../Wox.Plugin.Totp.wox plugin.json index.js images/icon.svg

# 发版：make patch / make minor / make major
# 改 plugin.json Version → 测试 → commit → tag → push（触发 .github/workflows/release.yml）
patch minor major:
	bun scripts/release.mjs $@
