#!/usr/bin/env python3
import argparse
import csv
import json
import os
import re
import sys
import time
import unicodedata
from decimal import Decimal, InvalidOperation
from pathlib import Path


FIELDS = (
    "invoice_number",
    "date",
    "amount",
    "total_amount",
    "tax_amount",
    "seller",
)
FIELD_NAMES = {
    "invoice_number": "发票号码",
    "date": "开票日期",
    "amount": "金额",
    "total_amount": "总额",
    "tax_amount": "税额",
    "seller": "销售方",
}
MONEY_FIELDS = {"amount", "total_amount", "tax_amount"}
MONEY_PATTERN = re.compile(r"^[¥￥]?(-?\d[\d,]*\.\d{1,2})$")


def compact(value):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(value or "")))


def money(value):
    match = MONEY_PATTERN.fullmatch(compact(value))
    return match.group(1).replace(",", "") if match else ""


def money_equal(left, right):
    try:
        return Decimal(left).quantize(Decimal("0.01")) == Decimal(right).quantize(
            Decimal("0.01")
        )
    except (InvalidOperation, ValueError):
        return False


def find_pattern(texts, pattern):
    for text in texts:
        match = pattern.search(compact(text))
        if match:
            return match
    return None


def extract_total_amount(texts):
    pattern = re.compile(r"\(小写\).*?[¥￥]?(-?\d[\d,]*\.\d{1,2})")
    for index, text in enumerate(texts):
        if "小写" not in compact(text):
            continue
        match = pattern.search(compact("".join(texts[index : index + 3])))
        if match:
            return match.group(1).replace(",", "")
    return ""


def box_center(box):
    return ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)


def extract_column_total(texts, boxes, header, cutoff_y):
    header_index = next(
        (index for index, text in enumerate(texts) if compact(text) == header), None
    )
    if header_index is None or header_index >= len(boxes):
        return ""

    header_x, header_y = box_center(boxes[header_index])
    image_width = max((box[2] for box in boxes), default=0)
    candidates = []
    for text, box in zip(texts, boxes):
        value = money(text)
        if not value:
            continue
        center_x, center_y = box_center(box)
        if center_y <= header_y + 5 or center_y >= cutoff_y:
            continue
        distance = abs(center_x - header_x)
        if distance > max(120, image_width * 0.12):
            continue
        candidates.append(("¥" in text or "￥" in text, center_y, -distance, value))

    return max(candidates)[3] if candidates else ""


def extract_fields(raw):
    result = raw.get("res", raw)
    texts = [str(value) for value in result.get("rec_texts", [])]
    boxes = result.get("rec_boxes", [])
    if len(boxes) != len(texts):
        boxes = [[0, index, 0, index] for index in range(len(texts))]

    invoice_match = find_pattern(
        texts, re.compile(r"发票号码[:：]?([0-9]{20})")
    )
    date_match = find_pattern(
        texts, re.compile(r"开票日期[:：]?(20\d{2})[年./-](\d{1,2})[月./-](\d{1,2})日?")
    )
    cutoff_y = min(
        (
            box_center(box)[1]
            for text, box in zip(texts, boxes)
            if "价税合计" in compact(text)
        ),
        default=float("inf"),
    )
    image_width = max((box[2] for box in boxes), default=0)
    seller_candidates = []
    for text, box in zip(texts, boxes):
        match = re.match(r"名称[:：](.+)", compact(text))
        if match and box_center(box)[0] > image_width / 2:
            seller_candidates.append((box_center(box)[0], match.group(1)))

    return {
        "invoice_number": invoice_match.group(1) if invoice_match else "",
        "date": (
            f"{date_match.group(1)}-{int(date_match.group(2)):02d}-{int(date_match.group(3)):02d}"
            if date_match
            else ""
        ),
        "amount": extract_column_total(texts, boxes, "金额", cutoff_y),
        "total_amount": extract_total_amount(texts),
        "tax_amount": extract_column_total(texts, boxes, "税额", cutoff_y),
        "seller": seller_candidates[-1][1] if seller_candidates else "",
    }


def field_equal(field, actual, expected):
    if field in MONEY_FIELDS:
        return money_equal(actual, expected)
    return compact(actual) == compact(expected)


def load_labels(path, limit):
    with path.open(encoding="utf-8", newline="") as file:
        rows = list(csv.DictReader(file, delimiter="\t"))
    if limit is not None:
        rows = rows[:limit]
    for row in rows:
        missing = [field for field in FIELDS if not row.get(field)]
        if missing:
            raise ValueError(f"样本 {row.get('id', '?')} 缺少标注：{', '.join(missing)}")
    return rows


def write_report(path, metrics, predictions):
    lines = [
        f"# {metrics['display_name']} 基准结果",
        "",
        f"- 样本数：{metrics['sample_count']}",
        f"- 模型加载：{metrics['model_load_seconds']:.3f} 秒",
        f"- 平均单张：{metrics['average_seconds']:.3f} 秒",
        f"- 字段总体准确率：{metrics['overall_accuracy']:.2%}",
        f"- 全字段正确票据：{metrics['all_fields_correct']}/{metrics['sample_count']}",
        "",
        "| 字段 | 正确数 | 准确率 |",
        "| --- | ---: | ---: |",
    ]
    for field in FIELDS:
        value = metrics["fields"][field]
        lines.append(
            f"| {FIELD_NAMES[field]} | {value['correct']}/{value['total']} | {value['accuracy']:.2%} |"
        )
    lines.extend(["", "## 错误明细", ""])
    errors = []
    for row in predictions:
        for field in FIELDS:
            if not row[f"{field}_correct"]:
                errors.append(
                    f"- {row['id']} {FIELD_NAMES[field]}：识别 `{row[field]}`，标注 `{row[f'expected_{field}']}`"
                )
    lines.extend(errors or ["全部字段与标注一致。"])
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def model_size(cache_dir, model_names):
    return sum(
        path.stat().st_size
        for model_name in model_names
        for path in (cache_dir / "official_models" / f"{model_name}_onnx").glob("*.onnx")
    )


def write_comparison(benchmark_dir):
    values = []
    for result_dir in ("pp-ocrv5-mobile", "pp-ocrv6-tiny", "pp-ocrv6-small"):
        metrics_path = benchmark_dir / result_dir / "metrics.json"
        if not metrics_path.exists():
            return
        value = json.loads(metrics_path.read_text(encoding="utf-8"))
        if "model_size_bytes" not in value or "display_name" not in value:
            return
        values.append(value)

    recommended = max(
        values,
        key=lambda value: (
            value["overall_accuracy"],
            -value["average_seconds"],
            -value["model_size_bytes"],
        ),
    )
    lines = [
        "# 轻量 OCR 候选对比",
        "",
        "| 模型 | 字段准确率 | 全字段正确票据 | 平均单张 | 模型加载 | ONNX 总大小 |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for value in values:
        lines.append(
            f"| {value['display_name']} | {value['overall_accuracy']:.2%} | "
            f"{value['all_fields_correct']}/{value['sample_count']} | "
            f"{value['average_seconds']:.3f} 秒 | {value['model_load_seconds']:.3f} 秒 | "
            f"{value['model_size_bytes'] / 1024 / 1024:.2f} MiB |"
        )
    lines.extend(
        [
            "",
            f"结论：当前 15 张电子发票样本优先采用 {recommended['display_name']}。",
        ]
    )
    (benchmark_dir / "comparison.md").write_text(
        "\n".join(lines) + "\n", encoding="utf-8"
    )


def main():
    parser = argparse.ArgumentParser(description="运行轻量发票 OCR 字段基准")
    parser.add_argument(
        "--variant",
        choices=("tiny", "small", "v5-mobile"),
        default="small",
        help="模型规格",
    )
    parser.add_argument("--limit", type=int, help="仅运行前 N 张样本")
    args = parser.parse_args()

    project_dir = Path(__file__).resolve().parent.parent
    dataset_dir = project_dir / "debug" / "ocr-dataset"
    if args.variant == "v5-mobile":
        display_name = "PP-OCRv5 mobile"
        output_name = "pp-ocrv5-mobile"
        detection_model = "PP-OCRv5_mobile_det"
        recognition_model = "PP-OCRv5_mobile_rec"
    else:
        display_name = f"PP-OCRv6 {args.variant}"
        output_name = f"pp-ocrv6-{args.variant}"
        detection_model = f"PP-OCRv6_{args.variant}_det"
        recognition_model = f"PP-OCRv6_{args.variant}_rec"

    output_dir = dataset_dir / "benchmark" / output_name
    raw_dir = output_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(project_dir / "debug" / "ocr-cache"))

    try:
        from paddleocr import PaddleOCR
    except ImportError as error:
        print("invoice-ocr 环境缺少 PaddleOCR，请先安装 paddleocr==3.7.0 和 onnxruntime。", file=sys.stderr)
        raise SystemExit(1) from error

    labels = load_labels(dataset_dir / "labels.tsv", args.limit)
    load_started = time.perf_counter()
    ocr = PaddleOCR(
        text_detection_model_name=detection_model,
        text_recognition_model_name=recognition_model,
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        device="cpu",
        engine="onnxruntime",
    )
    model_load_seconds = time.perf_counter() - load_started

    predictions = []
    for index, expected in enumerate(labels, start=1):
        sample_id = expected["id"]
        image_path = dataset_dir / "images" / f"{sample_id}.png"
        started = time.perf_counter()
        results = list(ocr.predict(str(image_path)))
        elapsed_seconds = time.perf_counter() - started
        if len(results) != 1:
            raise RuntimeError(f"样本 {sample_id} 返回 {len(results)} 个结果")
        raw = results[0].json
        (raw_dir / f"{sample_id}.json").write_text(
            json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        actual = extract_fields(raw)
        row = {"id": sample_id, **actual, "elapsed_seconds": elapsed_seconds}
        for field in FIELDS:
            row[f"expected_{field}"] = expected[field]
            row[f"{field}_correct"] = field_equal(field, actual[field], expected[field])
        predictions.append(row)
        correct_count = sum(row[f"{field}_correct"] for field in FIELDS)
        print(f"[{index:02d}/{len(labels):02d}] {sample_id}: {correct_count}/{len(FIELDS)}，{elapsed_seconds:.3f} 秒")

    total_fields = len(labels) * len(FIELDS)
    field_metrics = {}
    for field in FIELDS:
        correct = sum(row[f"{field}_correct"] for row in predictions)
        field_metrics[field] = {
            "correct": correct,
            "total": len(labels),
            "accuracy": correct / len(labels),
        }
    total_correct = sum(value["correct"] for value in field_metrics.values())
    cache_dir = Path(os.environ["PADDLE_PDX_CACHE_HOME"])
    metrics = {
        "display_name": display_name,
        "model": f"{detection_model} + {recognition_model}",
        "engine": "onnxruntime",
        "sample_count": len(labels),
        "model_load_seconds": model_load_seconds,
        "average_seconds": sum(row["elapsed_seconds"] for row in predictions) / len(labels),
        "overall_accuracy": total_correct / total_fields,
        "all_fields_correct": sum(
            all(row[f"{field}_correct"] for field in FIELDS) for row in predictions
        ),
        "model_size_bytes": model_size(
            cache_dir, (detection_model, recognition_model)
        ),
        "fields": field_metrics,
    }

    prediction_fields = ["id", *FIELDS, "elapsed_seconds"]
    prediction_fields.extend(f"expected_{field}" for field in FIELDS)
    prediction_fields.extend(f"{field}_correct" for field in FIELDS)
    with (output_dir / "predictions.tsv").open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=prediction_fields, delimiter="\t")
        writer.writeheader()
        writer.writerows(predictions)
    (output_dir / "metrics.json").write_text(
        json.dumps(metrics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    write_report(output_dir / "report.md", metrics, predictions)
    write_comparison(dataset_dir / "benchmark")
    print(f"结果：{output_dir / 'report.md'}")


if __name__ == "__main__":
    main()
