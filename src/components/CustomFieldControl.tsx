import { useEffect, useRef, useState } from 'react'
import { Input } from '@fluentui/react-components'
import CustomSelect from './CustomSelect'
import type { CustomValue, TableColumn } from '../shared/table-config'
import type { ExpenseItem, Project } from '../shared/models'
import { evaluateFormula } from '../domain/table-config'
import { formatTableNumber } from './table-value-format'

function NumericField({ value, column, disabled, label, onChange }: { value: CustomValue | undefined; column: TableColumn; disabled: boolean; label: string; onChange(value: CustomValue): void }) {
  const display = () => value === null || value === undefined || value === '' ? '' : typeof value === 'number' ? formatTableNumber(value, column) : String(value)
  const [draft, setDraft] = useState(display)
  const [invalid, setInvalid] = useState(false)
  const editing = useRef(false)
  useEffect(() => { if (!editing.current) setDraft(display()) }, [value, column.format, column.precision, column.unit])
  const commit = () => {
    editing.current = false
    if (!draft.trim()) { onChange(null); setInvalid(false); return }
    const parsed = Number(draft)
    if (!Number.isFinite(parsed)) { setInvalid(true); return }
    onChange(parsed); setDraft(formatTableNumber(parsed, column)); setInvalid(false)
  }
  return <Input disabled={disabled} aria-label={label} aria-invalid={invalid} title={invalid ? '请输入有效数值' : label} inputMode="decimal" value={draft} onFocus={() => { editing.current = true; if (!invalid) setDraft(value === null || value === undefined ? '' : String(value)) }} onChange={(_event, data) => { setDraft(data.value); setInvalid(false) }} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} />
}

export function CustomFieldControl({ column, expense, project, readOnly, onChange }: { column: TableColumn; expense: ExpenseItem; project: Project; readOnly: boolean; onChange(value: CustomValue): void }) {
  const value = expense.customValues?.[column.id]
  if (column.kind === 'formula') {
    const result = evaluateFormula(column, expense, project)
    if (result.status !== 'ok' || result.value === undefined) return <span title={result.message}>{result.status === 'empty' ? '待填写' : result.message || '计算错误'}</span>
    return <span className="money-cell" title={column.name}>{formatTableNumber(result.value, column)}</span>
  }
  if (column.kind === 'select') {
    const options = column.options?.map((option) => ({ value: option.id, label: option.name })) ?? []
    if (column.multi) return <CustomSelect size="small" value="" onChange={() => undefined} multiple selectedValues={Array.isArray(value) ? value : []} onSelectionChange={onChange} options={options} disabled={readOnly} placeholder="请选择" ariaLabel={column.name} />
    return <CustomSelect size="small" value={typeof value === 'string' ? value : ''} onChange={(next) => onChange(next || null)} options={[{ value: '', label: '未设置' }, ...options]} disabled={readOnly} ariaLabel={column.name} />
  }
  if (column.inputType === 'number') return <NumericField label={column.name} column={column} value={value} disabled={readOnly} onChange={onChange} />
  return <Input aria-label={column.name} disabled={readOnly} value={typeof value === 'string' ? value : ''} onChange={(_event, data) => onChange(data.value)} />
}
