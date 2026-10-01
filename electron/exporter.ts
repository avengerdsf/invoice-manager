import { createWriteStream, existsSync, realpathSync } from 'node:fs'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { calculateProjectSummary } from '../src/domain/project'
import {
  getProjectTableConfig, getTableCellValue, getTableHeaderGroups,
  getVisibleTableColumns, isNumericTableColumn,
} from '../src/domain/table-config'
import type { TableColumn } from '../src/shared/table-config'
import type { Attachment, AttachmentKind, ExportOptions, Project } from '../src/shared/models'

function safeName(value: string): string {
  const result = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 80)
  return result || '未命名物品'
}

function attachmentExtension(attachment: Attachment): string {
  const extension = path.extname(attachment.originalName).toLowerCase()
  if (['.pdf', '.jpg', '.jpeg', '.png', '.webp'].includes(extension)) return extension
  if (attachment.mimeType === 'application/pdf') return '.pdf'
  if (attachment.mimeType === 'image/png') return '.png'
  if (attachment.mimeType === 'image/webp') return '.webp'
  return '.jpg'
}

function resolveAttachment(rootPath: string, storedPath: string): string {
  if (path.isAbsolute(storedPath)) throw new Error('导出附件路径无效')
  const realRoot = realpathSync(rootPath)
  const resolved = realpathSync(path.resolve(realRoot, storedPath))
  const relative = path.relative(realRoot, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('导出附件路径越过项目目录')
  if (!existsSync(resolved)) throw new Error(`附件文件缺失：${storedPath}`)
  return resolved
}

function applyHeaderStyle(cell: ExcelJS.Cell, fill: string): void {
  cell.font = { bold: true, color: { argb: 'FF1F2937' } }
  cell.alignment = { horizontal: 'center', vertical: 'middle' }
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } }
  cell.border = {
    top: { style: 'thin', color: { argb: 'FF64748B' } },
    left: { style: 'thin', color: { argb: 'FF64748B' } },
    bottom: { style: 'thin', color: { argb: 'FF64748B' } },
    right: { style: 'thin', color: { argb: 'FF64748B' } },
  }
}

function attachmentCount(project: Project, expenseId: string, kind: AttachmentKind): number {
  const allocations = kind === 'invoice' ? project.invoiceAllocations : kind === 'payment'
    ? project.paymentAllocations : project.otherAllocations
  return new Set(allocations.filter((allocation) => allocation.expenseId === expenseId).map((allocation) => allocation.attachmentId)).size
}

function exportValue(column: TableColumn, expense: Project['expenses'][number], project: Project): string | number | boolean {
  const builtin = column.builtin ?? column.id
  if (builtin === 'invoice' || builtin === 'payment' || builtin === 'other') {
    return attachmentCount(project, expense.id, builtin)
  }
  const value = getTableCellValue(column, expense, project)
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.join('、')
  if (typeof value === 'number') return Number.isFinite(value) ? value : '数值错误'
  if (column.kind === 'input' && column.inputType === 'number' && typeof value === 'string') {
    if (!value.trim()) return ''
    const numericValue = Number(value)
    return Number.isFinite(numericValue) ? numericValue : '数值错误'
  }
  return value
}

function numberFormat(column: TableColumn): string {
  const precision = column.precision ?? 2
  const decimals = precision > 0 ? `.${'0'.repeat(Math.min(precision, 8))}` : ''
  const number = `#,##0${decimals}`
  if (column.format === 'percent') return `${number}%`
  if (column.format === 'currency') return `"¥"${number}`
  return number
}

function addSummarySheet(workbook: ExcelJS.Workbook, project: Project): void {
  const summary = calculateProjectSummary(project)
  const sheet = workbook.addWorksheet('核算汇总')
  sheet.mergeCells('A1:E1')
  sheet.getCell('A1').value = '总价核算'
  sheet.getCell('A1').font = { size: 16, bold: true }
  sheet.getCell('A1').alignment = { horizontal: 'center' }
  ;['类别', '类别合计', '实际付款', '有发票金额', '无发票金额'].forEach((value, index) => {
    const cell = sheet.getCell(2, index + 1)
    cell.value = value
    applyHeaderStyle(cell, 'FFDCE6F1')
  })
  summary.categories.forEach((category, index) => {
    const row = 3 + index
    sheet.getCell(row, 1).value = category.categoryName
    sheet.getCell(row, 2).value = category.totalCents / 100
    sheet.getCell(row, 2).numFmt = '0.00'
  })
  const totalRow = 3 + summary.categories.length
  sheet.getCell(totalRow, 1).value = '总计'
  sheet.getCell(totalRow, 2).value = summary.totalCents / 100
  sheet.getCell(totalRow, 3).value = summary.actualPaymentCents / 100
  sheet.getCell(totalRow, 4).value = summary.invoicedCents / 100
  sheet.getCell(totalRow, 5).value = summary.uninvoicedCents / 100
  for (let column = 2; column <= 5; column += 1) sheet.getCell(totalRow, column).numFmt = '0.00'

  sheet.mergeCells('G1:H1')
  sheet.getCell('G1').value = '付款人核算'
  sheet.getCell('G1').font = { size: 16, bold: true }
  sheet.getCell('G1').alignment = { horizontal: 'center' }
  ;['实际付款人', '实际付款合计'].forEach((value, index) => {
    const cell = sheet.getCell(2, 7 + index)
    cell.value = value
    applyHeaderStyle(cell, 'FFE8E0F2')
  })
  summary.payers.forEach((payer, index) => {
    const row = 3 + index
    sheet.getCell(row, 7).value = payer.payerName
    sheet.getCell(row, 8).value = payer.actualPaymentCents / 100
    sheet.getCell(row, 8).numFmt = '0.00'
  })
  ;[14, 15, 15, 16, 16, 3, 18, 18].forEach((width, index) => { sheet.getColumn(index + 1).width = width })
}

export async function buildWorkbook(project: Project): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = '发票整理助手'
  const config = getProjectTableConfig(project)
  const visibleColumns = getVisibleTableColumns(config).filter((column) => column.id !== 'actions' && column.builtin !== 'actions')
  const visibleIds = new Set(visibleColumns.map((column) => column.id))
  const headerGroups = getTableHeaderGroups(config)
    .map(({ column, children }) => ({ column, children: children.filter((child) => visibleIds.has(child.id)) }))
    .filter(({ column, children }) => column.kind === 'group' ? children.length > 0 : visibleIds.has(column.id))
  const sheet = workbook.addWorksheet('报销明细表', {
    views: [{ state: 'frozen', ySplit: 3, topLeftCell: 'A4', activeCell: 'A4' }],
  })
  if (visibleColumns.length > 1) sheet.mergeCells(1, 1, 1, visibleColumns.length)
  sheet.getCell('A1').value = '报销明细表'
  sheet.getCell('A1').font = { size: 16, bold: true }
  sheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' }

  let headerColumn = 1
  for (const group of headerGroups) {
    const cell = sheet.getCell(2, headerColumn)
    cell.value = group.column.name
    applyHeaderStyle(cell, 'FFE2E8F0')
    if (group.column.kind === 'group') {
      if (group.children.length > 1) sheet.mergeCells(2, headerColumn, 2, headerColumn + group.children.length - 1)
      for (const child of group.children) {
        const childCell = sheet.getCell(3, headerColumn)
        childCell.value = child.name
        applyHeaderStyle(childCell, 'FFE2E8F0')
        headerColumn += 1
      }
    } else {
      sheet.mergeCells(2, headerColumn, 3, headerColumn)
      headerColumn += 1
    }
  }

  project.expenses.forEach((expense, index) => {
    const row = sheet.getRow(index + 4)
    visibleColumns.forEach((column, columnIndex) => {
      const cell = row.getCell(columnIndex + 1)
      cell.value = exportValue(column, expense, project)
      if (typeof cell.value === 'number' && (isNumericTableColumn(column) || column.kind === 'formula')) {
        cell.numFmt = numberFormat(column)
      }
    })
    row.eachCell((cell) => {
      cell.alignment = { vertical: 'middle', wrapText: true }
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      }
    })
  })
  visibleColumns.forEach((column, index) => { sheet.getColumn(index + 1).width = Math.max(10, Math.min(60, Math.round((column.width ?? 112) / 7))) })
  addSummarySheet(workbook, project)
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

export async function exportProject(
  project: Project,
  rootPath: string,
  destinationPath: string,
  temporaryDirectory: string,
  options: ExportOptions,
): Promise<void> {
  const { ZipArchive } = await import('archiver')
  await mkdir(temporaryDirectory, { recursive: true })
  const temporaryPath = path.join(temporaryDirectory, `invoice-export-${project.id}-${Date.now()}.zip`)
  const output = createWriteStream(temporaryPath)
  const archive = new ZipArchive({ zlib: { level: 9 } })
  const completed = new Promise<void>((resolve, reject) => {
    output.on('close', () => resolve())
    output.on('error', reject)
    archive.on('error', reject)
  })
  archive.pipe(output)
  archive.append(await buildWorkbook(project), { name: '报销明细表.xlsx' })

  const expenseMap = new Map(project.expenses.map((item) => [item.id, item]))
  const appendKind = (kind: AttachmentKind, include: boolean): void => {
    if (!include) return
    const allocations = kind === 'invoice' ? project.invoiceAllocations : kind === 'payment' ? project.paymentAllocations : project.otherAllocations
    const attachmentExpense = new Map(allocations.map((item) => [item.attachmentId, item.expenseId]))
    const attachments = project.attachments.filter((item) => item.kind === kind && attachmentExpense.has(item.id))
    attachments.forEach((attachment, index) => {
      const expense = expenseMap.get(attachmentExpense.get(attachment.id) ?? '')
      const sequence = String(index + 1).padStart(3, '0')
      const payerName = safeName(expense?.actualPayer.trim() || '未设置付款人')
      const directoryName = kind === 'invoice' ? '发票' : kind === 'payment' ? '支付截图' : '其他附件'
      const exportedName = `${directoryName}/${sequence}_${safeName(expense?.name ?? '')}_${payerName}${attachmentExtension(attachment)}`
      archive.file(resolveAttachment(rootPath, attachment.storedPath), { name: exportedName })
    })
  }
  appendKind('invoice', true)
  appendKind('payment', options.includePayments)
  appendKind('other', options.includeOtherAttachments ?? true)
  await archive.finalize()
  await completed
  await copyFile(temporaryPath, destinationPath)
  await rm(temporaryPath, { force: true })
}
