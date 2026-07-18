# OCR 首轮验证

执行：

```bash
npm run ocr:prepare
```

输出目录为 `debug/ocr-dataset/`：

- `images/`：由单页 PDF 以 200 DPI 渲染的 PNG。
- `text/`：PDF 文本层基线，用于辅助人工核对。
- `manifest.tsv`：样本编号、SHA-256、来源文件及图片/文本路径。
- `labels.tsv`：人工填写的票号、日期、金额（不含税）、总额（价税合计）、税额和销售方标准答案。

标注时必须对照 PDF 页面核对，不能直接把文本层当作无误答案；首轮完成 15 份标注后再接入候选 OCR，比较字段正确数和单张耗时。

脚本重复执行时会更新图片、文本和清单，但不会覆盖已经人工核对的 `labels.tsv`。

## PP-OCRv6 small 基准

Python 依赖放在独立的 `invoice-ocr` Conda 环境中：

```bash
conda create -n invoice-ocr python=3.10 pip -y
conda activate invoice-ocr
PYTHONNOUSERSITE=1 python -m pip install paddleocr==3.7.0 onnxruntime
```

运行全部 15 张样本：

```bash
npm run ocr:benchmark
```

只验证前一张时可执行 `npm run ocr:benchmark -- --limit 1`。模型缓存位于 `debug/ocr-cache/`，字段预测、原始 OCR JSON、准确率和耗时报告位于 `debug/ocr-dataset/benchmark/pp-ocrv6-small/`。

与 tiny 规格对比时执行：

```bash
npm run ocr:benchmark:tiny
```

tiny 的独立结果位于 `debug/ocr-dataset/benchmark/pp-ocrv6-tiny/`，不会覆盖 small 结果。

补测 PP-OCRv5 mobile 时执行：

```bash
npm run ocr:benchmark:v5-mobile
```

三种轻量候选的汇总结果位于 `debug/ocr-dataset/benchmark/comparison.md`。

## 集成结论

当前 15 张样本中三种候选的六项字段准确率均为 100%；PP-OCRv6 tiny 平均 0.455 秒、模型 5.95 MiB，优于 PP-OCRv6 small 的 1.182 秒与 29.60 MiB，以及 PP-OCRv5 mobile 的 1.351 秒与 20.37 MiB，因此应用只打包 tiny。

应用添加发票后先读取数字 PDF 文本层；没有完整金额时，在单一 Web Worker 中使用 ONNX Runtime WASM 运行 tiny 检测和识别模型，提取金额、税额和“价税合计（小写）”，并校验三项加法关系。空白明细自动填写，已有金额时弹窗询问是否覆盖；模型、WASM 和字典均位于 `public/ocr/` 并通过 SHA-256 清单校验。
