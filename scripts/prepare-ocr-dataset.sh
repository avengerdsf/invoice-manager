#!/usr/bin/env bash
set -euo pipefail

source_directory="${1:-debug/发票}"
output_directory="${2:-debug/ocr-dataset}"

for command_name in pdftotext pdftoppm pdfinfo sha256sum; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "缺少命令：$command_name" >&2
    exit 1
  fi
done

if [[ ! -d "$source_directory" ]]; then
  echo "发票目录不存在：$source_directory" >&2
  exit 1
fi

mkdir -p "$output_directory/images" "$output_directory/text"
manifest_path="$output_directory/manifest.tsv"
labels_path="$output_directory/labels.tsv"
manifest_temporary_path="$manifest_path.tmp"
labels_temporary_path="$labels_path.tmp"

printf 'id\tsha256\tsource_pdf\timage\ttext\n' > "$manifest_temporary_path"
create_labels=false
if [[ ! -f "$labels_path" ]]; then
  create_labels=true
  printf 'id\tinvoice_number\tdate\tamount\ttotal_amount\ttax_amount\tseller\n' > "$labels_temporary_path"
fi

sample_index=0
while IFS= read -r -d '' pdf_path; do
  page_count="$(pdfinfo "$pdf_path" | awk '/^Pages:/ {print $2}')"
  if [[ "$page_count" != "1" ]]; then
    echo "当前脚本只接受单页 PDF：$pdf_path" >&2
    exit 1
  fi

  sample_index=$((sample_index + 1))
  sample_id="$(printf '%03d' "$sample_index")"
  image_path="$output_directory/images/$sample_id.png"
  text_path="$output_directory/text/$sample_id.txt"
  source_name="$(basename "$pdf_path")"
  sha256="$(sha256sum "$pdf_path" | awk '{print $1}')"

  pdftotext -layout "$pdf_path" "$text_path"
  pdftoppm -png -r 200 -singlefile "$pdf_path" "$output_directory/images/$sample_id" >/dev/null 2>&1
  printf '%s\t%s\t%s\t%s\t%s\n' "$sample_id" "$sha256" "$source_name" "images/$sample_id.png" "text/$sample_id.txt" >> "$manifest_temporary_path"
  if [[ "$create_labels" == true ]]; then
    printf '%s\t\t\t\t\t\t\n' "$sample_id" >> "$labels_temporary_path"
  fi
done < <(find "$source_directory" -maxdepth 1 -type f -iname '*.pdf' -print0 | sort -z)

if [[ "$sample_index" -eq 0 ]]; then
  echo "目录中没有 PDF：$source_directory" >&2
  exit 1
fi

mv "$manifest_temporary_path" "$manifest_path"
if [[ "$create_labels" == true ]]; then
  mv "$labels_temporary_path" "$labels_path"
fi
echo "已生成 $sample_index 个 OCR 样本：$output_directory"
