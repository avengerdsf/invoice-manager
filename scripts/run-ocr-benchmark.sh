#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
conda_bin="${CONDA_EXE:-}"

if [[ -z "$conda_bin" ]]; then
  conda_bin="$(command -v conda || true)"
fi
if [[ -z "$conda_bin" && -x /home/chen/miniforge3/condabin/conda ]]; then
  conda_bin=/home/chen/miniforge3/condabin/conda
fi
if [[ -z "$conda_bin" ]]; then
  echo "未找到 Conda，请先安装并创建 invoice-ocr 环境。" >&2
  exit 1
fi

conda_base="$($conda_bin info --base)"
python_bin="$conda_base/envs/invoice-ocr/bin/python"
if [[ ! -x "$python_bin" ]]; then
  echo "未找到 invoice-ocr 环境，请先执行：conda create -n invoice-ocr python=3.10 pip -y" >&2
  exit 1
fi

export PYTHONNOUSERSITE=1
export PADDLE_PDX_CACHE_HOME="$project_dir/debug/ocr-cache"
export PADDLE_PDX_MODEL_SOURCE=bos
export PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True

exec "$python_bin" "$project_dir/scripts/benchmark-paddleocr.py" "$@"
