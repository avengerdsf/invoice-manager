import type { TableColumn, TableConfig } from '../shared/table-config'
import { getTableHeaderGroups, getVisibleTableColumns } from '../domain/table-config'

const columnClasses: Record<string, string> = {
  category: 'col-category', date: 'col-date', name: 'col-name', price: 'col-price', tax: 'col-tax', total: 'col-total',
  actualPayment: 'col-payment', actualPayer: 'col-payer', reimbursed: 'col-reimbursed',
  invoice: 'col-attachment', payment: 'col-attachment', other: 'col-attachment', note: 'col-note', actions: 'col-actions',
}

export function tableColumnClass(column: TableColumn): string | undefined { return column.builtin ? columnClasses[column.builtin] : undefined }

export function ConfiguredTableHeader({ config }: { config: TableConfig }) {
  const roots = getTableHeaderGroups(config)
  const leaves = getVisibleTableColumns(config)
  const grouped = roots.some((root) => root.children.length > 0)
  return <>
    <colgroup>{leaves.map((column) => <col key={column.id} className={tableColumnClass(column)} style={column.width || !column.builtin ? { width: column.width ?? 160 } : undefined} />)}</colgroup>
    <thead>
      <tr>{roots.map(({ column, children }) => <th key={column.id} rowSpan={children.length ? undefined : grouped ? 2 : 1} colSpan={children.length || undefined} className={column.id === 'attachments' ? 'attachment-column attachment-group-heading' : column.builtin === 'actions' ? 'action-subheading' : undefined}>{column.name}</th>)}</tr>
      {grouped && <tr>{roots.flatMap(({ children }) => children).map((column) => <th key={column.id} className={['invoice', 'payment', 'other'].includes(column.builtin ?? '') ? 'attachment-subheading' : undefined}>{column.name}</th>)}</tr>}
    </thead>
  </>
}
