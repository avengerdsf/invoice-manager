# 发票整理助手

本地桌面端发票、支付截图、报销明细核算和 ZIP 导出工具，使用 Electron、React、TypeScript 和 Fluent UI 开发。

## 初版功能

- 新建或打开独立的 `.invoice-project` 本地项目。
- 编辑类别、日期、物品名称、价格、税费、实际付款人、备注和已报销状态，实际付款自动等于价格与税费之和。
- 全局维护实际付款人名单，按付款人汇总实际付款。
- 在最近项目候选中直接打开项目，或从本地目录选择项目。
- 一条明细关联多张发票或支付截图，允许无发票和无支付截图。
- PDF、JPG、PNG、WebP 文件内容检测和 SHA-256 去重。
- 添加发票后离线识别金额、税额和价税合计；空白明细自动填写，已有金额时先询问是否覆盖。
- 1 秒防抖自动保存、20 份 JSON 滚动备份和项目写入锁。
- 按类别、实际付款、有发票金额、无发票金额和已报销金额汇总。
- 导出 `报销明细表.xlsx` 和可选附件到 ZIP，完成后可直接打开导出目录。
- 导出附件使用 `001_物品名称.原扩展名` 命名。
- Renderer 沙箱、上下文隔离和白名单 IPC。

## 开发

```bash
npm install
npm run dev
```

## 验证

```bash
npm run typecheck
npm test
npm run build
```

## Windows 构建

```bash
npm run dist:win
```

Ubuntu 构建 Windows NSIS 时需要 Wine 或 `electronuserland/builder:wine` 环境；Windows 正式发布还需要代码签名证书。

## 当前边界

- OCR 当前识别发票金额、税额和价税合计；发票号码、日期、销售方和真伪查验尚未接入界面。
- 附件当前调用系统默认程序打开，应用内 PDF/图片预览尚未实现。
- 当前表格支持直接编辑，批量编辑、排序、筛选、撤销和拖拽导入尚未实现。
- Windows NSIS 安装包尚未在真实 Windows 10/11 机器完成安装、升级和卸载验收。

完整需求见 [需求与依赖分析](doc/requirements-and-dependencies.md)。
