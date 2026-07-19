import { createWriteStream, existsSync, realpathSync } from 'node:fs'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { calculateProjectSummary, expenseTotalCents } from '../src/domain/project'
import type { Attachment, ExportOptions, Project } from '../src/shared/models'

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

async function buildWorkbook(project: Project): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = '发票整理助手'
  const sheet = workbook.addWorksheet('报销明细表', {
    views: [{ state: 'frozen', ySplit: 2, topLeftCell: 'A3', activeCell: 'A3' }],
  })
  sheet.mergeCells('A1:J1')
  sheet.getCell('A1').value = '报销明细表'
  sheet.getCell('A1').font = { size: 16, bold: true }
  sheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' }
  ;['类别', '日期', '详细名称', '价格', '税费', '总价', '实际付款', '实际付款人', '备注', '已报销']
    .forEach((value, index) => {
      const cell = sheet.getCell(2, index + 1)
      cell.value = value
      applyHeaderStyle(cell, 'FFE2E8F0')
    })

  const categoryMap = new Map(project.categories.map((item) => [item.id, item.name]))
  project.expenses.forEach((expense, index) => {
    const row = sheet.getRow(index + 3)
    row.values = [
      categoryMap.get(expense.categoryId) ?? '未分类',
      expense.date,
      expense.name,
      expense.priceCents / 100,
      expense.taxCents / 100,
      expenseTotalCents(expense) / 100,
      expenseTotalCents(expense) / 100,
      expense.actualPayer,
      expense.note,
      expense.reimbursed ? '是' : '否',
    ]
    ;[4, 5, 6, 7].forEach((column) => {
      row.getCell(column).numFmt = '0.00'
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
  sheet.columns = [
    { width: 14 }, { width: 13 }, { width: 30 }, { width: 13 }, { width: 13 },
    { width: 13 }, { width: 15 }, { width: 16 }, { width: 30 }, { width: 12 },
  ]

  const summary = calculateProjectSummary(project)
  sheet.mergeCells('L1:P1')
  sheet.getCell('L1').value = '总价核算'
  sheet.getCell('L1').font = { size: 16, bold: true }
  sheet.getCell('L1').alignment = { horizontal: 'center' }
  ;['类别', '类别合计', '实际付款', '有发票金额', '无发票金额'].forEach((value, index) => {
    const cell = sheet.getCell(2, 12 + index)
    cell.value = value
    applyHeaderStyle(cell, 'FFDCE6F1')
  })
  summary.categories.forEach((category, index) => {
    const row = 3 + index
    sheet.getCell(row, 12).value = category.categoryName
    sheet.getCell(row, 13).value = category.totalCents / 100
    sheet.getCell(row, 13).numFmt = '0.00'
  })
  const totalRow = 3 + summary.categories.length
  sheet.getCell(totalRow, 12).value = '总计'
  sheet.getCell(totalRow, 13).value = summary.totalCents / 100
  sheet.getCell(totalRow, 14).value = summary.actualPaymentCents / 100
  sheet.getCell(totalRow, 15).value = summary.invoicedCents / 100
  sheet.getCell(totalRow, 16).value = summary.uninvoicedCents / 100
  for (let column = 13; column <= 16; column += 1) sheet.getCell(totalRow, column).numFmt = '0.00'
  sheet.columns[11].width = 14
  sheet.columns[12].width = 15
  sheet.columns[13].width = 15
  sheet.columns[14].width = 16
  sheet.columns[15].width = 16

  sheet.mergeCells('R1:S1')
  sheet.getCell('R1').value = '付款人核算'
  sheet.getCell('R1').font = { size: 16, bold: true }
  sheet.getCell('R1').alignment = { horizontal: 'center' }
  ;['实际付款人', '实际付款合计'].forEach((value, index) => {
    const cell = sheet.getCell(2, 18 + index)
    cell.value = value
    applyHeaderStyle(cell, 'FFE8E0F2')
  })
  summary.payers.forEach((payer, index) => {
    const row = 3 + index
    sheet.getCell(row, 18).value = payer.payerName
    sheet.getCell(row, 19).value = payer.actualPaymentCents / 100
    sheet.getCell(row, 19).numFmt = '0.00'
  })
  sheet.columns[17].width = 18
  sheet.columns[18].width = 18
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
  const appendKind = (kind: 'invoice' | 'payment', include: boolean): void => {
    if (!include) return
    const allocations = kind === 'invoice' ? project.invoiceAllocations : project.paymentAllocations
    const attachmentExpense = new Map(allocations.map((item) => [item.attachmentId, item.expenseId]))
    const attachments = project.attachments.filter((item) => item.kind === kind && attachmentExpense.has(item.id))
    attachments.forEach((attachment, index) => {
      const expense = expenseMap.get(attachmentExpense.get(attachment.id) ?? '')
      const sequence = String(index + 1).padStart(3, '0')
      const payerName = safeName(expense?.actualPayer.trim() || '未设置付款人')
      const exportedName = `${kind === 'invoice' ? '发票' : '支付截图'}/${sequence}_${safeName(expense?.name ?? '')}_${payerName}${attachmentExtension(attachment)}`
      archive.file(resolveAttachment(rootPath, attachment.storedPath), { name: exportedName })
    })
  }
  appendKind('invoice', true)
  appendKind('payment', options.includePayments)
  await archive.finalize()
  await completed
  await copyFile(temporaryPath, destinationPath)
  await rm(temporaryPath, { force: true })
}
