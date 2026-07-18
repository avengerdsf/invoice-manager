import type { Category, ExpenseItem, Project } from '../shared/models'

export const DEFAULT_CATEGORIES: Category[] = [
  ['materials', '材料费', '#5b8ff9'],
  ['transport', '交通费', '#61d9a3'],
  ['accommodation', '住宿费', '#65789b'],
  ['meals', '餐饮费', '#f6bd16'],
  ['processing', '加工费', '#7262fd'],
  ['printing', '印刷费', '#78d3f8'],
  ['logistics', '物流费', '#9661bc'],
].map(([id, name, color], order) => ({ id, name, color, order }))

export function expenseTotalCents(expense: ExpenseItem): number {
  return expense.priceCents + expense.taxCents
}

export function createExpense(id: string, categoryId: string, date: string): ExpenseItem {
  return {
    id,
    categoryId,
    date,
    name: '',
    priceCents: 0,
    taxCents: 0,
    actualPayer: '',
    note: '',
    reimbursed: false,
  }
}

export interface CategorySummary {
  categoryId: string
  categoryName: string
  totalCents: number
}

export interface ProjectSummary {
  categories: CategorySummary[]
  payers: PayerSummary[]
  totalCents: number
  actualPaymentCents: number
  invoicedCents: number
  uninvoicedCents: number
  reimbursedCents: number
}

export interface PayerSummary {
  payerName: string
  actualPaymentCents: number
}

export function calculateProjectSummary(project: Project): ProjectSummary {
  const invoiceExpenseIds = new Set(project.invoiceAllocations.map((item) => item.expenseId))
  const categoryTotals = new Map(project.categories.map((category) => [category.id, 0]))
  const payerTotals = new Map<string, number>()
  let totalCents = 0
  let actualPaymentCents = 0
  let invoicedCents = 0
  let uninvoicedCents = 0
  let reimbursedCents = 0

  for (const expense of project.expenses) {
    const total = expenseTotalCents(expense)
    categoryTotals.set(expense.categoryId, (categoryTotals.get(expense.categoryId) ?? 0) + total)
    totalCents += total
    actualPaymentCents += total
    if (total > 0) {
      const payerName = expense.actualPayer.trim() || '未设置付款人'
      payerTotals.set(payerName, (payerTotals.get(payerName) ?? 0) + total)
    }
    if (invoiceExpenseIds.has(expense.id)) {
      invoicedCents += total
    } else {
      uninvoicedCents += total
    }
    if (expense.reimbursed) {
      reimbursedCents += total
    }
  }

  return {
    categories: project.categories
      .slice()
      .sort((left, right) => left.order - right.order)
      .map((category) => ({
        categoryId: category.id,
        categoryName: category.name,
        totalCents: categoryTotals.get(category.id) ?? 0,
      })),
    payers: [...payerTotals].map(([payerName, payerActualPaymentCents]) => ({
      payerName,
      actualPaymentCents: payerActualPaymentCents,
    })),
    totalCents,
    actualPaymentCents,
    invoicedCents,
    uninvoicedCents,
    reimbursedCents,
  }
}

export function formatMoney(cents: number): string {
  return (cents / 100).toFixed(2)
}
