# 发票整理助手

一款本地运行的发票、支付截图和报销明细管理工具，使用 Electron、React、TypeScript 和 Fluent UI 开发。

## 主要功能

- 创建、打开、移动和删除独立的 `.invoice-project` 项目。
- 管理类别、日期、明细名称、价格、税费、付款人、备注和报销状态。
- 发票与支付截图支持点击选择、拖拽导入、预览和路径记忆。
- 发票金额离线识别，项目自动保存并保留滚动备份。
- 按类别、付款人和报销状态核算当前项目及全部项目资金。
- 导出 Excel、发票和支付截图到 ZIP 压缩包。

## 开发环境

- Node.js 20 或更高版本
- npm 10 或更高版本

安装依赖并启动开发模式：

```bash
npm install
npm run dev
```

## 检查与测试

```bash
npm run typecheck
npm test
npm run build
```

## Windows 构建

建议在 64 位 Windows 10/11 上构建。首次构建先安装依赖：

```powershell
npm install
npm run dist:win
```

构建结果位于 `release/`：

- `发票整理助手 Setup <版本号>.exe`：x64 NSIS 安装包。
- `win-unpacked/发票整理助手.exe`：解包后的应用程序。

Windows 正式发布如需消除 SmartScreen 的未知发布者提示，需要配置代码签名证书。

### Windows 覆盖升级

发布新版本时先更新 `package.json` 中的 `version`，重新执行 `npm run dist:win`。用户可以直接运行新版安装包覆盖安装，不需要先卸载旧版本。安装器会在升级前临时备份 `<安装目录>/data`，安装完成后自动恢复，因此全局付款人、最近项目和路径记忆会保留。项目数据位于独立的 `.invoice-project` 目录，本身不会被安装器修改。

## Ubuntu 构建

建议使用 Ubuntu 22.04 或 24.04 x64。安装 Node.js、npm 及构建依赖：

```bash
sudo apt update
sudo apt install -y build-essential libarchive-tools rpm
npm install
npm run dist:linux
```

构建结果位于 `release/`：

- `*.AppImage`：无需安装，添加执行权限后直接运行。
- `*.deb`：适用于 Ubuntu/Debian 的安装包。

运行 AppImage：

```bash
chmod +x release/*.AppImage
./release/*.AppImage
```

安装 deb：

```bash
sudo apt install ./release/*.deb
```

如果 AppImage 提示缺少 FUSE，可安装：

```bash
sudo apt install libfuse2
```

Ubuntu 24.04 也可以不安装 FUSE，使用：

```bash
./release/*.AppImage --appimage-extract-and-run
```

## 应用数据位置

- Windows 打包版：`<安装目录>/data`，首次运行新版会迁移旧 Roaming 数据。
- Ubuntu：遵循 Electron/Linux 标准，通常位于 `~/.config/发票整理助手`。
- 报销项目文件保存在用户创建或选择的 `.invoice-project` 目录中。

## 构建说明

- Windows NSIS 安装包应优先在 Windows 上构建。
- AppImage 和 deb 应优先在 Ubuntu 上构建。
- 不建议跨平台直接构建另一平台的安装包；若必须这样做，需要额外配置 Wine 或容器环境。
