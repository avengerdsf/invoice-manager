import './CategoryColorPicker.css'
import { PRESET_COLORS } from '../settings-validation'

interface CategoryColorPickerProps {
  value: string
  onChange: (color: string) => void
  disabled?: boolean
}

const COLOR_LABELS: Record<string, string> = {
  '#2563eb': '蓝色',
  '#0ea5e9': '天蓝',
  '#14b8a6': '青绿',
  '#22c55e': '绿色',
  '#84cc16': '黄绿',
  '#f59e0b': '琥珀',
  '#f97316': '橙色',
  '#ef4444': '红色',
  '#ec4899': '粉色',
  '#8b5cf6': '紫色',
  '#64748b': '灰蓝',
  '#334155': '深灰',
}

export function CategoryColorPicker({
  value,
  onChange,
  disabled = false,
}: CategoryColorPickerProps) {
  const colors = PRESET_COLORS.includes(value) ? PRESET_COLORS : [value, ...PRESET_COLORS]

  return (
    <div className="category-color-picker">
      <span className="color-select-preview" style={{ backgroundColor: value }} />
      <select
        className="color-select"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-label="类别颜色"
      >
        {colors.map((color) => (
          <option key={color} value={color}>
            {COLOR_LABELS[color] ?? color}
          </option>
        ))}
      </select>
    </div>
  )
}
