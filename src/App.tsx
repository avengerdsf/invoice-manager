import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react'
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Spinner,
  Textarea,
} from '@fluentui/react-components'
import CustomSelect from './components/CustomSelect'
import appIconUrl from '../build/app-icon.png'
import { calculateProjectSummary, createExpense, expenseTotalCents, formatMoney } from './domain/project'
import { recognizeInvoiceAmounts } from './ocr/ocr-client'
import type { InvoiceAmounts } from './ocr/amount'
import type { Allocation, AllProjectsFundsSummary, AppSettings, Attachment, AttachmentKind, ExpenseItem, Project, ProjectSession } from './shared/models'

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function toCents(value: string): number {
  const amount = Number(value)
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type RemovalRequest =
  | { kind: 'expense'; expenseId: string }
  | { kind: 'attachment'; expenseId: string; attachmentKind: AttachmentKind; attachmentId: string }

type ViewMode = 'table' | 'card'
const ATTACHMENT_KINDS: AttachmentKind[] = ['invoice', 'payment', 'other']

interface OcrOverwriteRequest {
  current: InvoiceAmounts
  recognized: InvoiceAmounts
}

export default function App() {
  const [session, setSession] = useState<ProjectSession | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [includePayments, setIncludePayments] = useState(true)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [summaryTab, setSummaryTab] = useState<'current' | 'all'>('current')
  const [allProjectsSummary, setAllProjectsSummary] = useState<AllProjectsFundsSummary | null>(null)
  const [deleteProjectOpen, setDeleteProjectOpen] = useState(false)
  const [exportDialog, setExportDialog] = useState(false)
  const [attachmentDialog, setAttachmentDialog] = useState<{ expenseId: string; kind: AttachmentKind } | null>(null)
  const [attachmentDragActive, setAttachmentDragActive] = useState(false)
  const [editorAttachmentKind, setEditorAttachmentKind] = useState<AttachmentKind>('invoice')
  const [viewMode, setViewMode] = useState<ViewMode>(() => (
    window.localStorage.getItem('invoice-manager:view-mode') === 'card' ? 'card' : 'table'
  ))
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null)
  const [categoryFilter, setCategoryFilter] = useState('__all__')
  const [payerFilter, setPayerFilter] = useState('__all__')
  const [attachmentPreview, setAttachmentPreview] = useState<{ id: string; name: string; mimeType: string; url: string } | null>(null)
  const [removalRequest, setRemovalRequest] = useState<RemovalRequest | null>(null)
  const [ocrOverwriteRequest, setOcrOverwriteRequest] = useState<OcrOverwriteRequest | null>(null)
  const [message, setMessage] = useState('')
  const [appSettings, setAppSettings] = useState<AppSettings>({
    payerNames: [],
    recentProjects: [],
    knownProjectPaths: [],
    lastImportDirectories: {},
  })
  const [projectNameDialog, setProjectNameDialog] = useState<string | null>(null)
  const [missingRecentProject, setMissingRecentProject] = useState<{ name: string; rootPath: string } | null>(null)
  const [settingsDialog, setSettingsDialog] = useState<{
    payerNames: string[]
    newPayerName: string
    projectName: string
    categoryName: string
    newCategoryNames: string[]
    removedCategoryIds: string[]
  } | null>(null)
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false)
  const [settingsPage, setSettingsPage] = useState<'main' | 'payers' | 'categories'>('main')
  const changeVersion = useRef(0)
  const saving = useRef(false)
  const lastAttachmentDialog = useRef<{ expenseId: string; kind: AttachmentKind } | null>(null)
  const ocrOverwriteResolver = useRef<((overwrite: boolean) => void) | null>(null)

  const project = session?.project ?? null
  const readOnly = session?.readOnly ?? true
  if (attachmentDialog) lastAttachmentDialog.current = attachmentDialog
  const renderedAttachmentDialog = attachmentDialog ?? lastAttachmentDialog.current
  const summary = useMemo(() => (project ? calculateProjectSummary(project) : null), [project])
  const editingExpense = useMemo(() => (
    project && editingExpenseId ? project.expenses.find((expense) => expense.id === editingExpenseId) ?? null : null
  ), [project, editingExpenseId])
  const visibleExpenses = useMemo(() => {
    if (!project) return []
    return project.expenses.filter((expense) => (
      (categoryFilter === '__all__' || expense.categoryId === categoryFilter)
      && (payerFilter === '__all__'
        || (payerFilter === '__unset__' ? !expense.actualPayer.trim() : expense.actualPayer === payerFilter))
    ))
  }, [project, categoryFilter, payerFilter])

  useEffect(() => {
    setCategoryFilter('__all__')
    setPayerFilter('__all__')
    setEditingExpenseId(null)
  }, [project?.id])

  useEffect(() => {
    window.localStorage.setItem('invoice-manager:view-mode', viewMode)
  }, [viewMode])

  useEffect(() => {
    void window.invoiceManager.getSettings()
      .then(setAppSettings)
      .catch((error) => setMessage(`读取应用设置失败：${errorMessage(error)}`))
  }, [])

  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(''), 3500)
    return () => window.clearTimeout(timer)
  }, [message])

  useEffect(() => {
    return () => {
      if (attachmentPreview?.url) URL.revokeObjectURL(attachmentPreview.url)
    }
  }, [attachmentPreview])

  const updateProject = (updater: (draft: Project) => void) => {
    if (!session || session.readOnly) return
    const next = structuredClone(session.project)
    updater(next)
    changeVersion.current += 1
    setSession({ ...session, project: next })
    setDirty(true)
    setAllProjectsSummary(null)
  }

  const save = async () => {
    if (!session || session.readOnly || saving.current || !dirty) return
    const version = changeVersion.current
    const snapshot = session.project
    saving.current = true
    try {
      const result = await window.invoiceManager.saveProject(snapshot)
      const saved = result.project
      if (result.rootPath !== session.rootPath) {
        setAppSettings(await window.invoiceManager.getSettings())
      }
      setSession((current) => {
        if (!current || current.project.id !== saved.id) return current
        if (changeVersion.current === version) return { ...current, rootPath: result.rootPath, project: saved }
        return { ...current, rootPath: result.rootPath, project: { ...current.project, revision: saved.revision, updatedAt: saved.updatedAt } }
      })
      if (changeVersion.current === version) setDirty(false)
    } catch (error) {
      setMessage(`保存失败：${errorMessage(error)}`)
    } finally {
      saving.current = false
    }
  }

  useEffect(() => {
    if (!dirty || !session || session.readOnly) return
    const timer = window.setTimeout(() => void save(), 1000)
    return () => window.clearTimeout(timer)
  }, [dirty, session])

  const openSession = async (action: () => Promise<ProjectSession | null>) => {
    setBusy(true)
    try {
      const opened = await action()
      if (!opened) return
      changeVersion.current = 0
      setDirty(false)
      setSession(opened)
      let settings = await window.invoiceManager.getSettings()
      const projectPayerNames = [...new Set(
        opened.project.expenses
          .map((expense) => expense.actualPayer.trim())
          .filter(Boolean),
      )]
      const missingPayerNames = projectPayerNames.filter((payerName) => !settings.payerNames.includes(payerName))
      if (missingPayerNames.length > 0) {
        settings = await window.invoiceManager.saveSettings({
          payerNames: [...settings.payerNames, ...missingPayerNames],
        })
      }
      setAppSettings(settings)
      setMessage(opened.readOnly ? '项目已被其他进程占用，当前只读打开' : '项目已打开')
    } catch (error) {
      setMessage(`打开失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const requestCreateProject = () => {
    setProjectNameDialog(`报销项目_${today().replace(/-/g, '')}`)
  }

  const addExpense = () => {
    if (!project) return
    const expenseId = window.crypto.randomUUID()
    updateProject((draft) => {
      const categoryId = draft.categories[0]?.id ?? 'uncategorized'
      draft.expenses.push(createExpense(expenseId, categoryId, today()))
    })
    if (viewMode === 'card') setEditingExpenseId(expenseId)
  }

  const requestOpenSettings = () => {
    setSettingsPage('main')
    setSettingsDialog({
      payerNames: [...appSettings.payerNames],
      newPayerName: '',
      projectName: project?.name ?? '',
      categoryName: '',
      newCategoryNames: [],
      removedCategoryIds: [],
    })
  }

  const addPayer = () => {
    if (!settingsDialog) return
    const payerName = settingsDialog.newPayerName.trim()
    if (!payerName || settingsDialog.payerNames.includes(payerName)) return
    setSettingsDialog({
      ...settingsDialog,
      payerNames: [...settingsDialog.payerNames, payerName],
      newPayerName: '',
    })
  }

  const removePayer = (payerName: string) => {
    if (!settingsDialog || project?.expenses.some((expense) => expense.actualPayer === payerName)) return
    setSettingsDialog({
      ...settingsDialog,
      payerNames: settingsDialog.payerNames.filter((name) => name !== payerName),
    })
  }

  const saveSettings = async () => {
    if (!settingsDialog) return
    setBusy(true)
    try {
      const newPayerName = settingsDialog.newPayerName.trim()
      const payerNames = newPayerName && !settingsDialog.payerNames.includes(newPayerName)
        ? [...settingsDialog.payerNames, newPayerName]
        : settingsDialog.payerNames
      const updatedSettings = await window.invoiceManager.saveSettings({
        payerNames,
      })
      const projectName = settingsDialog.projectName.trim()
      const categoryName = settingsDialog.categoryName.trim()
      const newCategoryNames = categoryName
        ? [...settingsDialog.newCategoryNames, categoryName]
        : settingsDialog.newCategoryNames
      if (project && (projectName !== project.name || settingsDialog.removedCategoryIds.length > 0 || newCategoryNames.length > 0)) {
        updateProject((draft) => {
          draft.name = projectName
          draft.categories = draft.categories.filter((category) => !settingsDialog.removedCategoryIds.includes(category.id))
          for (const newCategoryName of newCategoryNames) {
            if (draft.categories.some((category) => category.name === newCategoryName)) continue
            draft.categories.push({
              id: window.crypto.randomUUID(),
              name: newCategoryName,
              color: '#64748b',
              order: draft.categories.length,
            })
          }
        })
      }
      setAppSettings({
        ...updatedSettings,
        recentProjects: updatedSettings.recentProjects.map((recentProject) => (
          recentProject.rootPath === session?.rootPath && projectName
            ? { ...recentProject, name: projectName }
            : recentProject
        )),
      })
      setSettingsDialog(null)
      setCategoryDialogOpen(false)
      setMessage('设置已保存')
    } catch (error) {
      setMessage(`保存设置失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const submitNameDialog = () => {
    if (!projectNameDialog) return
    const name = projectNameDialog.trim()
    if (!name) return
    setProjectNameDialog(null)
    void openSession(() => window.invoiceManager.createProject(name))
  }

  const updateExpense = (expenseId: string, field: keyof ExpenseItem, value: string | number | boolean) => {
    updateProject((draft) => {
      const expense = draft.expenses.find((item) => item.id === expenseId)
      if (expense) Object.assign(expense, { [field]: value })
    })
  }

  const requestOcrOverwrite = (current: InvoiceAmounts, recognized: InvoiceAmounts): Promise<boolean> => (
    new Promise((resolve) => {
      ocrOverwriteResolver.current = resolve
      setOcrOverwriteRequest({ current, recognized })
    })
  )

  const resolveOcrOverwrite = (overwrite: boolean) => {
    setOcrOverwriteRequest(null)
    ocrOverwriteResolver.current?.(overwrite)
    ocrOverwriteResolver.current = null
  }

  const attachFiles = async (expenseId: string, kind: AttachmentKind, droppedFiles?: File[]) => {
    if (!project || session?.readOnly) return
    setBusy(true)
    try {
      const imported = droppedFiles
        ? await window.invoiceManager.importDroppedAttachments(kind, droppedFiles)
        : await window.invoiceManager.importAttachments(kind)
      if (!imported.length) return
      const existingAllocations = allocationsForKind(project, kind)
      const attachmentsToLink = imported.filter((attachment) => !existingAllocations.some(
        (allocation) => allocation.expenseId === expenseId && allocation.attachmentId === attachment.id,
      ))
      let recognizedAmounts: InvoiceAmounts | null = null
      let recognitionError = ''
      if (kind === 'invoice' && attachmentsToLink.length) {
        setMessage(`正在识别 ${attachmentsToLink.length} 张发票的金额、税额和价税合计…`)
        const results = await Promise.allSettled(
          attachmentsToLink.map((attachment) => recognizeInvoiceAmounts(attachment.id)),
        )
        const amounts = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
        if (amounts.length === attachmentsToLink.length) {
          recognizedAmounts = amounts.reduce<InvoiceAmounts>((total, amount) => ({
            amountCents: total.amountCents + amount.amountCents,
            taxCents: total.taxCents + amount.taxCents,
            totalCents: total.totalCents + amount.totalCents,
          }), { amountCents: 0, taxCents: 0, totalCents: 0 })
        } else {
          const failed = results.find((result) => result.status === 'rejected')
          recognitionError = failed?.status === 'rejected' ? errorMessage(failed.reason) : '金额识别失败'
        }
      }
      const currentExpense = project.expenses.find((item) => item.id === expenseId)
      const currentTotalCents = currentExpense ? expenseTotalCents(currentExpense) : -1
      let shouldFillAmount = kind === 'invoice' && recognizedAmounts !== null && currentTotalCents === 0
      if (kind === 'invoice' && recognizedAmounts !== null && currentExpense && currentTotalCents > 0) {
        shouldFillAmount = await requestOcrOverwrite({
          amountCents: currentExpense.priceCents,
          taxCents: currentExpense.taxCents,
          totalCents: currentTotalCents,
        }, recognizedAmounts)
      }
      updateProject((draft) => {
        mergeAttachments(draft, imported)
        const allocations = allocationsForKind(draft, kind)
        const expense = draft.expenses.find((item) => item.id === expenseId)
        if (expense && shouldFillAmount && recognizedAmounts !== null) {
          expense.priceCents = recognizedAmounts.amountCents
          expense.taxCents = recognizedAmounts.taxCents
        }
        for (const attachment of imported) {
          if (allocations.some((item) => item.expenseId === expenseId && item.attachmentId === attachment.id)) continue
          allocations.push({
            id: window.crypto.randomUUID(),
            expenseId,
            attachmentId: attachment.id,
            allocatedCents: expense ? expenseTotalCents(expense) : 0,
          })
        }
      })
      if (kind !== 'invoice') {
        setMessage(`已导入 ${imported.length} 个${attachmentLabel(kind)}`)
      } else if (recognizedAmounts !== null && shouldFillAmount) {
        setMessage(`已导入 ${imported.length} 张发票，金额 ¥${formatMoney(recognizedAmounts.amountCents)}，税额 ¥${formatMoney(recognizedAmounts.taxCents)}，价税合计 ¥${formatMoney(recognizedAmounts.totalCents)}`)
      } else if (recognizedAmounts !== null) {
        setMessage(`已识别价税合计 ¥${formatMoney(recognizedAmounts.totalCents)}，已保留现有金额`)
      } else {
        setMessage(`已导入 ${imported.length} 张发票；${recognitionError || '未识别到金额，请手动填写'}`)
      }
    } catch (error) {
      setMessage(`导入失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const openAttachment = async (attachmentId: string) => {
    try {
      await window.invoiceManager.openAttachment(attachmentId)
    } catch (error) {
      setMessage(`打开附件失败：${errorMessage(error)}`)
    }
  }

  const openRecentProject = async (recentProject: { name: string; rootPath: string }) => {
    setBusy(true)
    try {
      if (!await window.invoiceManager.checkRecentProject(recentProject.rootPath)) {
        setMissingRecentProject(recentProject)
        return
      }
    } catch (error) {
      setMessage(`检查项目失败：${errorMessage(error)}`)
      return
    } finally {
      setBusy(false)
    }
    await openSession(() => window.invoiceManager.openRecentProject(recentProject.rootPath))
  }

  const removeMissingRecentProject = async () => {
    if (!missingRecentProject) return
    setBusy(true)
    try {
      setAppSettings(await window.invoiceManager.removeRecentProject(missingRecentProject.rootPath))
      setMissingRecentProject(null)
      setMessage('已从最近项目中移除')
    } catch (error) {
      setMessage(`移除记录失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const showAllProjectsSummary = async () => {
    setBusy(true)
    try {
      setAllProjectsSummary(await window.invoiceManager.getAllProjectsSummary(project ?? undefined))
      setSummaryOpen(true)
    } catch (error) {
      setMessage(`读取全部项目汇总失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const deleteCurrentProject = async () => {
    setBusy(true)
    try {
      const settings = await window.invoiceManager.deleteCurrentProject()
      setSession(null)
      setDirty(false)
      setAppSettings(settings)
      setDeleteProjectOpen(false)
      setMessage('项目已移入回收站')
    } catch (error) {
      setMessage(`删除项目失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const moveCurrentProject = async () => {
    if (!session || session.readOnly) return
    setBusy(true)
    try {
      if (dirty) await save()
      const result = await window.invoiceManager.moveCurrentProject()
      if (!result) return
      setSession(result.session)
      setAppSettings(result.settings)
      setDirty(false)
      setSettingsDialog(null)
      setMessage(`项目已移动到：${result.session.rootPath}`)
    } catch (error) {
      setMessage(`移动项目失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const previewAttachment = async (attachment: Attachment) => {
    setBusy(true)
    try {
      const source = await window.invoiceManager.readAttachmentPreview(attachment.id)
      const url = URL.createObjectURL(new Blob([source.data], { type: source.mimeType }))
      setAttachmentPreview({ id: attachment.id, name: attachment.originalName, mimeType: source.mimeType, url })
    } catch (error) {
      setMessage(`预览附件失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const confirmRemoval = () => {
    if (!removalRequest) return
    if (removalRequest.kind === 'expense') {
      updateProject((draft) => {
        draft.expenses = draft.expenses.filter((item) => item.id !== removalRequest.expenseId)
        draft.invoiceAllocations = draft.invoiceAllocations.filter((item) => item.expenseId !== removalRequest.expenseId)
        draft.paymentAllocations = draft.paymentAllocations.filter((item) => item.expenseId !== removalRequest.expenseId)
        draft.otherAllocations = draft.otherAllocations.filter((item) => item.expenseId !== removalRequest.expenseId)
      })
      setRemovalRequest(null)
      setMessage('明细已删除')
      return
    }
    updateProject((draft) => {
      const allocations = allocationsForKind(draft, removalRequest.attachmentKind)
      const nextAllocations = allocations.filter(
        (allocation) => allocation.expenseId !== removalRequest.expenseId || allocation.attachmentId !== removalRequest.attachmentId,
      )
      if (removalRequest.attachmentKind === 'invoice') draft.invoiceAllocations = nextAllocations
      else if (removalRequest.attachmentKind === 'payment') draft.paymentAllocations = nextAllocations
      else draft.otherAllocations = nextAllocations
      const stillReferenced = [...draft.invoiceAllocations, ...draft.paymentAllocations, ...draft.otherAllocations]
        .some((allocation) => allocation.attachmentId === removalRequest.attachmentId)
      if (!stillReferenced) draft.attachments = draft.attachments.filter((attachment) => attachment.id !== removalRequest.attachmentId)
    })
    setRemovalRequest(null)
    setMessage('附件已从明细删除')
  }

  const exportZip = async () => {
    if (!project || session?.readOnly) return
    setBusy(true)
    try {
      if (dirty) await save()
      setExportDialog(false)
      const result = await window.invoiceManager.exportProject(project, { includePayments })
      if (!result) return
      setSession((current) => (current ? { ...current, project: result.project } : current))
      setDirty(false)
      setMessage(`导出完成：${result.filePath}`)
    } catch (error) {
      setMessage(`导出失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app-shell">
      {project && (
        <header className="topbar">
          <div className="toolbar">
            <Button onClick={requestCreateProject}>新建项目</Button>
            <CustomSelect
              className="project-select"
              value={session?.rootPath ?? ''}
              onChange={(value) => {
                if (value === '__local__') {
                  void openSession(() => window.invoiceManager.openProject())
                } else if (value) {
                  void openSession(() => window.invoiceManager.openRecentProject(value))
                }
              }}
              options={[
                { value: '__local__', label: '从本地打开…' },
                ...appSettings.recentProjects.map((recentProject) => ({
                  value: recentProject.rootPath,
                  label: recentProject.name,
                })),
              ]}
            />
            <Button onClick={() => void window.invoiceManager.revealProject()}>项目目录</Button>
            <Button onClick={requestOpenSettings}>设置</Button>
            <Button disabled={busy} onClick={() => setDeleteProjectOpen(true)}>删除项目</Button>
            {session?.readOnly && <Badge color="danger">只读</Badge>}
            {dirty && !session?.readOnly && <Badge color="warning">未保存</Badge>}
            <Button className="export-button" appearance="primary" disabled={session?.readOnly || busy} onClick={() => setExportDialog(true)}>导出 ZIP</Button>
          </div>
        </header>
      )}

      {(busy || message) && <div className={`app-message ${project ? 'below-topbar' : ''}`}>{busy && <Spinner size="tiny" />} {message}</div>}

      {!project ? (
        <main className="welcome">
          <div className="welcome-card">
            <div className="welcome-icon"><img src={appIconUrl} alt="" /></div>
            <h2>开始</h2>
            <p>建立或打开一个报销项目</p>
            <div className="welcome-actions">
              <Button appearance="primary" size="large" onClick={requestCreateProject}>新建项目</Button>
              <Button size="large" onClick={() => void openSession(() => window.invoiceManager.openProject())}>从本地打开…</Button>
            </div>
            <div className="recent-projects">
              <h3>最近项目</h3>
              <div className="recent-project-list">
                {appSettings.recentProjects.length ? appSettings.recentProjects.map((recentProject) => (
                  <Button
                    key={recentProject.rootPath}
                    className="recent-project-button"
                    appearance="subtle"
                    onClick={() => void openRecentProject(recentProject)}
                  >
                    <span className="recent-project-content">
                      <strong>{recentProject.name}</strong>
                      <span>{recentProject.rootPath}</span>
                    </span>
                  </Button>
                )) : <p>暂无最近项目</p>}
              </div>
            </div>
          </div>
        </main>
      ) : (
        <main className="workspace">
          <section className="table-panel">
            <div className="panel-heading">
              <div>
                <h2>报销明细</h2>
                <p>{visibleExpenses.length === project.expenses.length ? `${project.expenses.length} 条明细` : `显示 ${visibleExpenses.length} / ${project.expenses.length} 条明细`}</p>
              </div>
              <div className="panel-actions">
                <div className="view-switch" role="tablist" aria-label="明细视图">
                  <button type="button" role="tab" aria-selected={viewMode === 'table'} onClick={() => setViewMode('table')}>▦ 表格</button>
                  <button type="button" role="tab" aria-selected={viewMode === 'card'} onClick={() => setViewMode('card')}>▤ 卡片</button>
                </div>
                <Button className="summary-action-button" aria-haspopup="dialog" onClick={() => { setSummaryTab('current'); setSummaryOpen(true) }}>资金核算</Button>
                <Button appearance="primary" disabled={readOnly} onClick={addExpense}>添加明细</Button>
              </div>
            </div>
            {viewMode === 'card' && (
              <div className="card-filter-bar">
                <span>筛选</span>
                <CustomSelect
                  value={categoryFilter}
                  onChange={setCategoryFilter}
                  options={[{ value: '__all__', label: '类别：全部类别' }, ...project.categories.map((category) => ({ value: category.id, label: `类别：${category.name}` }))]}
                />
                <CustomSelect
                  value={payerFilter}
                  onChange={setPayerFilter}
                  options={[
                    { value: '__all__', label: '付款人：全部付款人' },
                    { value: '__unset__', label: '付款人：未设置付款人' },
                    ...[...new Set([...appSettings.payerNames, ...project.expenses.map((expense) => expense.actualPayer).filter(Boolean)])]
                      .map((payerName) => ({ value: payerName, label: `付款人：${payerName}` })),
                  ]}
                />
              </div>
            )}
            {viewMode === 'table' ? <div className="table-scroll">
              <table className="expense-table">
                <colgroup>
                  <col className="col-category" />
                  <col className="col-date" />
                  <col className="col-name" />
                  <col className="col-price" />
                  <col className="col-tax" />
                  <col className="col-total" />
                  <col className="col-payment" />
                  <col className="col-payer" />
                  <col className="col-reimbursed" />
                  <col className="col-attachment" />
                  <col className="col-attachment" />
                  <col className="col-attachment" />
                  <col className="col-note" />
                  <col className="col-actions" />
                </colgroup>
                <thead>
                  <tr>
                    <th rowSpan={2}>
                      <div className="table-header-filter">
                        <span>类别</span>
                        <CustomSelect
                          size="small"
                          value={categoryFilter}
                          onChange={setCategoryFilter}
                          options={[{ value: '__all__', label: '全部类别' }, ...project.categories.map((category) => ({ value: category.id, label: category.name }))]}
                        />
                      </div>
                    </th><th rowSpan={2}>日期</th><th rowSpan={2}>详细名称</th>
                    <th colSpan={3}>金额</th><th rowSpan={2}>实际付款</th><th rowSpan={2}>
                      <div className="table-header-filter">
                        <span>实际付款人</span>
                        <CustomSelect
                          size="small"
                          value={payerFilter}
                          onChange={setPayerFilter}
                          options={[
                            { value: '__all__', label: '全部付款人' },
                            { value: '__unset__', label: '未设置付款人' },
                            ...[...new Set([...appSettings.payerNames, ...project.expenses.map((expense) => expense.actualPayer).filter(Boolean)])]
                              .map((payerName) => ({ value: payerName, label: payerName })),
                          ]}
                        />
                      </div>
                    </th>
                    <th rowSpan={2}>已报销</th><th className="attachment-column attachment-group-heading" colSpan={3}>附件</th>
                    <th rowSpan={2}>备注</th><th rowSpan={2} className="action-subheading">操作</th>
                  </tr>
                  <tr><th>价格</th><th>税费</th><th>总价</th><th className="attachment-column attachment-subheading">发票</th><th className="attachment-subheading">支付截图</th><th className="attachment-subheading">其他附件</th></tr>
                </thead>
                <tbody>
                  {visibleExpenses.map((expense) => (
                    <ExpenseRow
                      key={expense.id}
                      expense={expense}
                      project={project}
                      payerNames={appSettings.payerNames}
                      readOnly={readOnly}
                      onUpdate={updateExpense}
                      onRemove={(expenseId) => setRemovalRequest({ kind: 'expense', expenseId })}
                      onManage={(kind) => setAttachmentDialog({ expenseId: expense.id, kind })}
                    />
                  ))}
                  {!visibleExpenses.length && (
                    <tr><td colSpan={14} className="empty-row">{project.expenses.length ? '没有符合筛选条件的明细' : '点击“添加明细”开始录入'}</td></tr>
                  )}
                </tbody>
              </table>
            </div> : (
              <div className="card-scroll" aria-label="报销明细卡片列表">
                {visibleExpenses.length ? (
                  <div className="expense-card-grid">
                    {visibleExpenses.map((expense) => (
                      <ExpenseCard
                        key={expense.id}
                        expense={expense}
                        project={project}
                        readOnly={readOnly}
                        onEdit={() => setEditingExpenseId(expense.id)}
                        onRemove={() => setRemovalRequest({ kind: 'expense', expenseId: expense.id })}
                        onManage={(kind) => setAttachmentDialog({ expenseId: expense.id, kind })}
                        onAttach={(kind, files) => void attachFiles(expense.id, kind, files)}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="card-empty-state">{project.expenses.length ? '没有符合筛选条件的明细' : '点击“添加明细”开始录入'}</div>
                )}
              </div>
            )}
          </section>

        </main>
      )}
      <Dialog
        open={missingRecentProject !== null}
        onOpenChange={(_event, data) => {
          if (!data.open) setMissingRecentProject(null)
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>项目不存在或已移动</DialogTitle>
            <DialogContent>
              找不到“{missingRecentProject?.name}”的项目文件。是否从最近项目中删除这条记录？
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setMissingRecentProject(null)}>保留记录</Button>
              <Button appearance="primary" onClick={() => void removeMissingRecentProject()}>删除记录</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={summaryOpen} onOpenChange={(_event, data) => setSummaryOpen(data.open)}>
        <DialogSurface className="summary-dialog" backdrop={{ className: 'summary-dialog-backdrop', appearance: 'dimmed' }}>
          <DialogBody>
            <DialogTitle>资金核算</DialogTitle>
            <DialogContent className="summary-dialog-content">
              <div className="summary-tabs" role="tablist">
                <button type="button" role="tab" aria-selected={summaryTab === 'current'} onClick={() => setSummaryTab('current')}>当前项目</button>
                <button type="button" role="tab" aria-selected={summaryTab === 'all'} onClick={() => { setSummaryTab('all'); void showAllProjectsSummary() }}>全部项目</button>
              </div>
              {summaryTab === 'current' && summary && (
                <>
                  <div className="summary-metrics">
                    <div className="metric primary-metric"><span>明细总价</span><strong>¥ {formatMoney(summary.totalCents)}</strong></div>
                    <div className="metric"><span>实际付款</span><strong>¥ {formatMoney(summary.actualPaymentCents)}</strong></div>
                    <div className="metric success"><span>有发票金额</span><strong>¥ {formatMoney(summary.invoicedCents)}</strong></div>
                    <div className="metric warning"><span>无发票金额</span><strong>¥ {formatMoney(summary.uninvoicedCents)}</strong></div>
                    <div className="metric"><span>已报销金额</span><strong>¥ {formatMoney(summary.reimbursedCents)}</strong></div>
                  </div>
                  <div className="summary-breakdowns">
                    <section>
                      <h3>类别合计</h3>
                      <div className="category-list">
                        {summary.categories.map((item) => (
                          <div key={item.categoryId}><span>{item.categoryName}</span><strong>{formatMoney(item.totalCents)}</strong></div>
                        ))}
                      </div>
                    </section>
                    <section>
                      <h3>付款人合计</h3>
                      <div className="category-list">
                        {summary.payers.map((item) => (
                          <div key={item.payerName}><span>{item.payerName}</span><strong>{formatMoney(item.actualPaymentCents)}</strong></div>
                        ))}
                        {!summary.payers.length && <div><span>暂无付款明细</span><strong>0.00</strong></div>}
                      </div>
                    </section>
                  </div>
                </>
              )}
              {summaryTab === 'all' && allProjectsSummary && <>
                <div className="summary-metrics">
                  <div className="metric primary-metric"><span>全部项目总额</span><strong>¥ {formatMoney(allProjectsSummary.totalCents)}</strong></div>
                  <div className="metric"><span>实际付款</span><strong>¥ {formatMoney(allProjectsSummary.actualPaymentCents)}</strong></div>
                  <div className="metric success"><span>有发票金额</span><strong>¥ {formatMoney(allProjectsSummary.invoicedCents)}</strong></div>
                  <div className="metric warning"><span>无发票金额</span><strong>¥ {formatMoney(allProjectsSummary.uninvoicedCents)}</strong></div>
                  <div className="metric"><span>已报销金额</span><strong>¥ {formatMoney(allProjectsSummary.reimbursedCents)}</strong></div>
                </div>
                <section className="all-projects-section">
                  <h3>付款人未报销资金</h3>
                  <div className="all-projects-list payer-summary-list">
                    {allProjectsSummary.payers.map((item) => <div key={item.payerName} className="all-project-row payer-summary-row">
                      <span><strong>{item.payerName}</strong></span><span>垫付总额<strong>¥ {formatMoney(item.totalCents)}</strong></span><span>已报销<strong>¥ {formatMoney(item.reimbursedCents)}</strong></span><span className="unreimbursed-value">尚未报销<strong>¥ {formatMoney(item.unreimbursedCents)}</strong></span>
                    </div>)}
                    {!allProjectsSummary.payers.length && <p>暂无付款人资金记录</p>}
                  </div>
                </section>
                <section className="all-projects-section"><h3>{allProjectsSummary.projects.length} 个项目</h3><div className="all-projects-list">
                  {allProjectsSummary.projects.map((item) => <div key={item.rootPath} className="all-project-row"><span><strong>{item.name}</strong><small>{item.expenseCount} 条明细</small></span><span>总额<strong>¥ {formatMoney(item.totalCents)}</strong></span><span>已报销<strong>¥ {formatMoney(item.reimbursedCents)}</strong></span></div>)}
                  {!allProjectsSummary.projects.length && <p>暂无可汇总项目</p>}
                </div></section>
              </>}
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={() => setSummaryOpen(false)}>关闭</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <Dialog open={editingExpense !== null} onOpenChange={(_event, data) => !data.open && setEditingExpenseId(null)}>
        <DialogSurface className="expense-editor-dialog" backdrop={{ className: 'expense-editor-backdrop', appearance: 'dimmed' }}>
          <DialogBody>
            <DialogTitle>
              <div className="expense-editor-title">
                <span>编辑报销明细</span>
                {project && editingExpense && <small>{categoryName(project, editingExpense.categoryId)} · {editingExpense.date} · 修改自动保存</small>}
              </div>
            </DialogTitle>
            <DialogContent className="expense-editor-content">
              {project && editingExpense && (
                <>
                  <div className="expense-editor-main">
                    <div className="expense-editor-form">
                      <Field label="详细名称">
                        <Input
                          autoFocus
                          disabled={readOnly}
                          maxLength={120}
                          value={editingExpense.name}
                          placeholder="物品名称"
                          onChange={(_event, data) => updateExpense(editingExpense.id, 'name', data.value)}
                        />
                      </Field>
                      <div className="expense-editor-row three">
                        <Field label="类别">
                          <CustomSelect
                            disabled={readOnly}
                            value={editingExpense.categoryId}
                            onChange={(value) => updateExpense(editingExpense.id, 'categoryId', value)}
                            options={project.categories.map((category) => ({ value: category.id, label: category.name }))}
                          />
                        </Field>
                        <Field label="日期">
                          <DateInput disabled={readOnly} value={editingExpense.date} onChange={(value) => updateExpense(editingExpense.id, 'date', value)} />
                        </Field>
                        <Field label="实际付款人">
                          <PayerSelect expense={editingExpense} payerNames={appSettings.payerNames} readOnly={readOnly} onUpdate={updateExpense} />
                        </Field>
                      </div>
                      <div className="expense-editor-row amount-status">
                        <Field label="价格">
                          <MoneyInput disabled={readOnly} valueCents={editingExpense.priceCents} onChange={(value) => updateExpense(editingExpense.id, 'priceCents', value)} />
                        </Field>
                        <Field label="税费">
                          <MoneyInput disabled={readOnly} valueCents={editingExpense.taxCents} onChange={(value) => updateExpense(editingExpense.id, 'taxCents', value)} />
                        </Field>
                        <div className="editor-status-field">
                          <span className="editor-status-label">报销状态</span>
                          <button
                            type="button"
                            className={`editor-reimbursed-toggle ${editingExpense.reimbursed ? 'checked' : ''}`}
                            aria-pressed={editingExpense.reimbursed}
                            disabled={readOnly}
                            onClick={() => updateExpense(editingExpense.id, 'reimbursed', !editingExpense.reimbursed)}
                          >
                            <span className="editor-check-box" aria-hidden="true">{editingExpense.reimbursed ? '✓' : ''}</span>
                            <span>{editingExpense.reimbursed ? '已报销' : '未报销'}</span>
                          </button>
                        </div>
                      </div>
                    </div>
                    <TotalPanel expense={editingExpense} />
                    <div className="expense-editor-note">
                      <label htmlFor={`expense-note-${editingExpense.id}`}>备注</label>
                      <Textarea
                        id={`expense-note-${editingExpense.id}`}
                        disabled={readOnly}
                        maxLength={500}
                        resize="vertical"
                        value={editingExpense.note}
                        onChange={(_event, data) => updateExpense(editingExpense.id, 'note', data.value)}
                      />
                    </div>
                  </div>
                  <div className="editor-evidence-heading">
                    <strong>凭证</strong>
                    <span>支持 PDF、JPG、PNG 和 WebP，可一次拖入多份</span>
                  </div>
                  <AttachmentManager
                    expense={editingExpense}
                    project={project}
                    activeKind={editorAttachmentKind}
                    readOnly={readOnly}
                    onSelectKind={setEditorAttachmentKind}
                    onManage={(kind) => setAttachmentDialog({ expenseId: editingExpense.id, kind })}
                    onAttach={(kind, files) => void attachFiles(editingExpense.id, kind, files)}
                    onPreview={previewAttachment}
                    onRemove={(kind, attachmentId) => setRemovalRequest({ kind: 'attachment', expenseId: editingExpense.id, attachmentKind: kind, attachmentId })}
                  />
                </>
              )}
            </DialogContent>
            <DialogActions>
              <span className="expense-editor-save-hint">修改将在 1 秒后自动保存</span>
              <Button appearance="primary" onClick={() => setEditingExpenseId(null)}>完成</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <Dialog
        open={projectNameDialog !== null}
        onOpenChange={(_event, data) => {
          if (!data.open) setProjectNameDialog(null)
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>新建报销项目</DialogTitle>
            <DialogContent>
              <Field label="项目名称">
                <Input
                  autoFocus
                  maxLength={80}
                  value={projectNameDialog ?? ''}
                  onChange={(_event, data) => setProjectNameDialog(data.value)}
                />
              </Field>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setProjectNameDialog(null)}>取消</Button>
              <Button
                appearance="primary"
                disabled={!projectNameDialog?.trim()}
                onClick={submitNameDialog}
              >
                确定
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <Dialog
        open={settingsDialog !== null}
        onOpenChange={(_event, data) => {
          if (!data.open) setSettingsDialog(null)
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle className="settings-dialog-title">
              {settingsPage !== 'main' && <button className="settings-back-button" type="button" aria-label="返回设置" onClick={() => setSettingsPage('main')}>‹</button>}
              {settingsPage === 'main' ? '设置' : settingsPage === 'payers' ? '全局付款人' : '管理项目类别'}
            </DialogTitle>
            <DialogContent>
              {settingsPage === 'payers' && <div className="settings-subpage">
              <Field
                label="添加全局付款人"
                validationState={settingsDialog?.payerNames.includes(settingsDialog.newPayerName.trim()) ? 'error' : 'none'}
                validationMessage={settingsDialog?.payerNames.includes(settingsDialog.newPayerName.trim()) ? '该付款人已存在' : undefined}
              >
                <div className="settings-input-row">
                  <Input
                    autoFocus
                    maxLength={80}
                    value={settingsDialog?.newPayerName ?? ''}
                    onChange={(_event, data) => setSettingsDialog((current) => current ? { ...current, newPayerName: data.value } : current)}
                  />
                  <Button
                    disabled={!settingsDialog?.newPayerName.trim() || settingsDialog.payerNames.includes(settingsDialog.newPayerName.trim())}
                    onClick={addPayer}
                  >
                    添加
                  </Button>
                </div>
              </Field>
              <div className="settings-list">
                {settingsDialog?.payerNames.map((payerName) => {
                  const usageCount = project?.expenses.filter((expense) => expense.actualPayer === payerName).length ?? 0
                  return (
                    <div key={payerName}>
                      <span>{payerName}{usageCount > 0 ? ` · 当前项目 ${usageCount} 条明细使用中` : ''}</span>
                      <Button size="small" disabled={usageCount > 0} onClick={() => removePayer(payerName)}>删除</Button>
                    </div>
                  )
                })}
                {!settingsDialog?.payerNames.length && <p>暂无付款人</p>}
              </div>
              </div>}
              {settingsPage === 'main' && project && (
                <div className="settings-section">
                  <Field
                    label="当前项目名称"
                    validationState={settingsDialog?.projectName.trim() ? 'none' : 'error'}
                    validationMessage={settingsDialog?.projectName.trim() ? undefined : '项目名称不能为空'}
                  >
                    <Input
                      disabled={readOnly}
                      maxLength={80}
                      value={settingsDialog?.projectName ?? ''}
                      onChange={(_event, data) => setSettingsDialog((current) => current ? { ...current, projectName: data.value } : current)}
                    />
                  </Field>
                  <button type="button" className="settings-nav-row" onClick={() => setSettingsPage('payers')}>
                    <span><strong>全局付款人</strong><small>{settingsDialog?.payerNames.length ?? 0} 人</small></span>
                    <span className="settings-chevron" aria-hidden="true">›</span>
                  </button>
                  <button type="button" className="settings-nav-row" disabled={readOnly} onClick={() => setSettingsPage('categories')}>
                    <span>
                      <strong>项目类别</strong>
                      <small>{project.categories.length - (settingsDialog?.removedCategoryIds.length ?? 0) + (settingsDialog?.newCategoryNames.length ?? 0)} 个类别</small>
                    </span>
                    <span className="settings-chevron" aria-hidden="true">›</span>
                  </button>
                </div>
              )}
              {settingsPage === 'main' && !project && <button type="button" className="settings-nav-row" onClick={() => setSettingsPage('payers')}><span><strong>全局付款人</strong><small>{settingsDialog?.payerNames.length ?? 0} 人</small></span><span className="settings-chevron">›</span></button>}
              {settingsPage === 'categories' && project && settingsDialog && <div className="settings-subpage category-manager-content">
                <Field
                  label="添加类别"
                  validationState={(project.categories.some((category) => category.name === settingsDialog.categoryName.trim() && !settingsDialog.removedCategoryIds.includes(category.id)) || settingsDialog.newCategoryNames.includes(settingsDialog.categoryName.trim())) ? 'error' : 'none'}
                  validationMessage={(project.categories.some((category) => category.name === settingsDialog.categoryName.trim() && !settingsDialog.removedCategoryIds.includes(category.id)) || settingsDialog.newCategoryNames.includes(settingsDialog.categoryName.trim())) ? '该类别已存在' : undefined}
                >
                  <div className="settings-input-row">
                    <Input autoFocus maxLength={40} value={settingsDialog.categoryName} onChange={(_event, data) => setSettingsDialog((current) => current ? { ...current, categoryName: data.value } : current)} />
                    <Button appearance="primary" disabled={!settingsDialog.categoryName.trim() || project.categories.some((category) => category.name === settingsDialog.categoryName.trim() && !settingsDialog.removedCategoryIds.includes(category.id)) || settingsDialog.newCategoryNames.includes(settingsDialog.categoryName.trim())} onClick={() => setSettingsDialog((current) => current ? { ...current, newCategoryNames: [...current.newCategoryNames, current.categoryName.trim()], categoryName: '' } : current)}>添加</Button>
                  </div>
                </Field>
                <div className="category-manager-list settings-list">
                  {settingsDialog.newCategoryNames.map((categoryName) => <div key={`new-${categoryName}`}><span><strong>{categoryName}</strong><small>新增，保存设置后生效</small></span><Button size="small" onClick={() => setSettingsDialog((current) => current ? { ...current, newCategoryNames: current.newCategoryNames.filter((name) => name !== categoryName) } : current)}>移除</Button></div>)}
                  {project.categories.filter((category) => !settingsDialog.removedCategoryIds.includes(category.id)).map((category) => {
                    const usageCount = project.expenses.filter((expense) => expense.categoryId === category.id).length
                    const remainingCount = project.categories.length - settingsDialog.removedCategoryIds.length
                    return <div key={category.id}><span><strong>{category.name}</strong>{usageCount > 0 ? <small>{usageCount} 条明细使用中</small> : <small>尚未使用</small>}</span><Button size="small" disabled={usageCount > 0 || remainingCount <= 1} onClick={() => setSettingsDialog((current) => current ? { ...current, removedCategoryIds: [...current.removedCategoryIds, category.id] } : current)}>删除</Button></div>
                  })}
                </div>
              </div>}
              {settingsPage === 'main' && project && (
                <button type="button" className="settings-nav-row settings-move-project" disabled={readOnly || busy} onClick={() => void moveCurrentProject()}>
                  <span><strong>移动项目</strong><small title={session?.rootPath}>{session?.rootPath}</small></span>
                  <span className="settings-chevron" aria-hidden="true">›</span>
                </button>
              )}
            </DialogContent>
            {settingsPage === 'main' && <DialogActions>
              <Button appearance="secondary" onClick={() => setSettingsDialog(null)}>取消</Button>
              <Button
                appearance="primary"
                disabled={
                  busy
                  || Boolean(project && !settingsDialog?.projectName.trim())
                  || Boolean(project?.categories.some((category) => category.name === settingsDialog?.categoryName.trim() && !settingsDialog.removedCategoryIds.includes(category.id)))
                }
                onClick={() => void saveSettings()}
              >
                保存
              </Button>
            </DialogActions>}
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <Dialog open={exportDialog} onOpenChange={(_event, data) => setExportDialog(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>导出压缩包</DialogTitle>
            <DialogContent>
              <Checkbox
                checked={includePayments}
                onChange={(_event, data) => setIncludePayments(Boolean(data.checked))}
                label="导出压缩包时包含支付截图"
              />
              <p className="dialog-hint">发票、支付截图和其他附件按“001_物品名称”重命名，原文件不会被修改。</p>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" disabled={busy} onClick={() => setExportDialog(false)}>取消</Button>
              <Button appearance="primary" disabled={busy} onClick={() => void exportZip()}>开始导出</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <Dialog open={attachmentDialog !== null} onOpenChange={(_event, data) => {
        if (!data.open) {
          setAttachmentDialog(null)
          setAttachmentDragActive(false)
        }
      }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{renderedAttachmentDialog ? `${attachmentLabel(renderedAttachmentDialog.kind)}管理` : ''}</DialogTitle>
            <DialogContent>
              {renderedAttachmentDialog && (
                <div
                  className={`attachment-drop-zone${attachmentDragActive ? ' drag-active' : ''}`}
                  role="button"
                  tabIndex={readOnly ? -1 : 0}
                  aria-disabled={readOnly}
                  aria-label={`点击选择或拖入${attachmentLabel(renderedAttachmentDialog.kind)}`}
                  onClick={() => {
                    if (!readOnly) void attachFiles(renderedAttachmentDialog.expenseId, renderedAttachmentDialog.kind)
                  }}
                  onKeyDown={(event) => {
                    if (!readOnly && (event.key === 'Enter' || event.key === ' ')) {
                      event.preventDefault()
                      void attachFiles(renderedAttachmentDialog.expenseId, renderedAttachmentDialog.kind)
                    }
                  }}
                  onDragEnter={(event) => { event.preventDefault(); setAttachmentDragActive(true) }}
                  onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAttachmentDragActive(false)
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    setAttachmentDragActive(false)
                    const files = Array.from(event.dataTransfer.files)
                    if (files.length) void attachFiles(renderedAttachmentDialog.expenseId, renderedAttachmentDialog.kind, files)
                  }}
                >
                  <strong>点击选择，或把{attachmentLabel(renderedAttachmentDialog.kind)}拖到这里</strong>
                  <span>支持 PDF、JPG、PNG 和 WebP，可一次选择或拖入多份</span>
                </div>
              )}
              <div className="settings-list">
                {renderedAttachmentDialog && project && (() => {
                  const allocations = allocationsForKind(project, renderedAttachmentDialog.kind)
                  const items = allocations
                    .filter((allocation) => allocation.expenseId === renderedAttachmentDialog.expenseId)
                    .map((allocation) => project.attachments.find((attachment) => attachment.id === allocation.attachmentId))
                    .filter((attachment): attachment is Attachment => Boolean(attachment))
                  return items.length ? items.map((attachment) => (
                    <div key={attachment.id}>
                      <button
                        type="button"
                        className="attachment-name-button"
                        title={`预览 ${attachment.originalName}`}
                        onClick={() => void previewAttachment(attachment)}
                      >
                        {attachment.originalName}
                      </button>
                      <div className="attachment-actions">
                        <Button size="small" onClick={() => void openAttachment(attachment.id)}>打开</Button>
                        <Button
                          size="small"
                          disabled={readOnly}
                          onClick={() => setRemovalRequest({
                            kind: 'attachment',
                            expenseId: renderedAttachmentDialog.expenseId,
                            attachmentKind: renderedAttachmentDialog.kind,
                            attachmentId: attachment.id,
                          })}
                        >
                          删除
                        </Button>
                      </div>
                    </div>
                  )) : <p>暂无附件</p>
                })()}
              </div>
            </DialogContent>
            <DialogActions>
              <Button
                className="attachment-add-button-hidden"
                disabled={readOnly || !renderedAttachmentDialog}
                onClick={() => renderedAttachmentDialog && void attachFiles(renderedAttachmentDialog.expenseId, renderedAttachmentDialog.kind)}
              >
                添加附件
              </Button>
              <Button appearance="primary" onClick={() => setAttachmentDialog(null)}>完成</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <Dialog open={false}>
        <DialogSurface className="category-manager-dialog">
          <DialogBody>
            <DialogTitle className="settings-dialog-title"><button className="settings-back-button" type="button" aria-label="返回设置" onClick={() => setCategoryDialogOpen(false)}>‹</button>管理项目类别</DialogTitle>
            <DialogContent className="category-manager-content">
              {project && settingsDialog && <>
                <Field
                  label="添加类别"
                  validationState={(project.categories.some((category) => category.name === settingsDialog.categoryName.trim() && !settingsDialog.removedCategoryIds.includes(category.id)) || settingsDialog.newCategoryNames.includes(settingsDialog.categoryName.trim())) ? 'error' : 'none'}
                  validationMessage={(project.categories.some((category) => category.name === settingsDialog.categoryName.trim() && !settingsDialog.removedCategoryIds.includes(category.id)) || settingsDialog.newCategoryNames.includes(settingsDialog.categoryName.trim())) ? '该类别已存在' : undefined}
                >
                  <div className="settings-input-row">
                    <Input
                      autoFocus
                      maxLength={40}
                      value={settingsDialog.categoryName}
                      onChange={(_event, data) => setSettingsDialog((current) => current ? { ...current, categoryName: data.value } : current)}
                    />
                    <Button
                      appearance="primary"
                      disabled={!settingsDialog.categoryName.trim() || project.categories.some((category) => category.name === settingsDialog.categoryName.trim() && !settingsDialog.removedCategoryIds.includes(category.id)) || settingsDialog.newCategoryNames.includes(settingsDialog.categoryName.trim())}
                      onClick={() => setSettingsDialog((current) => current ? { ...current, newCategoryNames: [...current.newCategoryNames, current.categoryName.trim()], categoryName: '' } : current)}
                    >添加</Button>
                  </div>
                </Field>
                <div className="category-manager-list settings-list">
                  {settingsDialog.newCategoryNames.map((categoryName) => <div key={`new-${categoryName}`}>
                    <span><strong>{categoryName}</strong><small>新增，保存设置后生效</small></span>
                    <Button size="small" onClick={() => setSettingsDialog((current) => current ? { ...current, newCategoryNames: current.newCategoryNames.filter((name) => name !== categoryName) } : current)}>移除</Button>
                  </div>)}
                  {project.categories.filter((category) => !settingsDialog.removedCategoryIds.includes(category.id)).map((category) => {
                    const usageCount = project.expenses.filter((expense) => expense.categoryId === category.id).length
                    const remainingCount = project.categories.length - settingsDialog.removedCategoryIds.length
                    return <div key={category.id}>
                      <span><strong>{category.name}</strong>{usageCount > 0 ? <small>{usageCount} 条明细使用中</small> : <small>尚未使用</small>}</span>
                      <Button size="small" disabled={usageCount > 0 || remainingCount <= 1} onClick={() => setSettingsDialog((current) => current ? { ...current, removedCategoryIds: [...current.removedCategoryIds, category.id] } : current)}>删除</Button>
                    </div>
                  })}
                </div>
              </>}
            </DialogContent>
            <DialogActions><Button appearance="primary" onClick={() => setCategoryDialogOpen(false)}>完成</Button></DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <Dialog open={false}>
        <DialogSurface className="summary-dialog">
          <DialogBody>
            <DialogTitle>全部项目资金汇总</DialogTitle>
            <DialogContent className="summary-dialog-content">
              {allProjectsSummary && <>
                <div className="summary-metrics">
                  <div className="metric primary-metric"><span>全部项目总额</span><strong>¥ {formatMoney(allProjectsSummary.totalCents)}</strong></div>
                  <div className="metric"><span>实际付款</span><strong>¥ {formatMoney(allProjectsSummary.actualPaymentCents)}</strong></div>
                  <div className="metric success"><span>有发票金额</span><strong>¥ {formatMoney(allProjectsSummary.invoicedCents)}</strong></div>
                  <div className="metric warning"><span>无发票金额</span><strong>¥ {formatMoney(allProjectsSummary.uninvoicedCents)}</strong></div>
                  <div className="metric"><span>已报销金额</span><strong>¥ {formatMoney(allProjectsSummary.reimbursedCents)}</strong></div>
                </div>
                <section className="all-projects-section">
                  <h3>付款人未报销资金</h3>
                  <div className="all-projects-list payer-summary-list">
                    {allProjectsSummary.payers.map((item) => <div key={item.payerName} className="all-project-row payer-summary-row">
                      <span><strong>{item.payerName}</strong></span>
                      <span>垫付总额<strong>¥ {formatMoney(item.totalCents)}</strong></span>
                      <span>已报销<strong>¥ {formatMoney(item.reimbursedCents)}</strong></span>
                      <span className="unreimbursed-value">尚未报销<strong>¥ {formatMoney(item.unreimbursedCents)}</strong></span>
                    </div>)}
                    {!allProjectsSummary.payers.length && <p>暂无付款人资金记录</p>}
                  </div>
                </section>
                <section className="all-projects-section">
                  <h3>{allProjectsSummary.projects.length} 个项目</h3>
                  <div className="all-projects-list">
                    {allProjectsSummary.projects.map((item) => <div key={item.rootPath} className="all-project-row">
                      <span><strong>{item.name}</strong><small>{item.expenseCount} 条明细</small></span>
                      <span>总额<strong>¥ {formatMoney(item.totalCents)}</strong></span>
                      <span>已报销<strong>¥ {formatMoney(item.reimbursedCents)}</strong></span>
                    </div>)}
                    {!allProjectsSummary.projects.length && <p>暂无可汇总项目</p>}
                  </div>
                </section>
              </>}
            </DialogContent>
            <DialogActions><Button appearance="primary" onClick={() => setAllProjectsSummary(null)}>关闭</Button></DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <Dialog open={deleteProjectOpen} onOpenChange={(_event, data) => setDeleteProjectOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>删除项目</DialogTitle>
            <DialogContent>确认删除“{project?.name}”？项目目录及其中的发票、支付截图和其他附件会移入 Windows 回收站，可从回收站恢复。</DialogContent>
            <DialogActions>
              <Button onClick={() => setDeleteProjectOpen(false)}>取消</Button>
              <Button appearance="primary" disabled={busy} onClick={() => void deleteCurrentProject()}>移入回收站</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <Dialog open={attachmentPreview !== null} onOpenChange={(_event, data) => !data.open && setAttachmentPreview(null)}>
        <DialogSurface className="attachment-preview-dialog">
          <DialogBody>
            <DialogTitle>{attachmentPreview?.name ?? '发票预览'}</DialogTitle>
            <DialogContent className="attachment-preview-content">
              {attachmentPreview && (
                attachmentPreview.mimeType === 'application/pdf'
                  ? <iframe className="attachment-preview-pdf" src={attachmentPreview.url} title={attachmentPreview.name} />
                  : <img className="attachment-preview-image" src={attachmentPreview.url} alt={attachmentPreview.name} />
              )}
            </DialogContent>
            <DialogActions>
              <Button onClick={() => attachmentPreview && void openAttachment(attachmentPreview.id)}>用系统程序打开</Button>
              <Button appearance="primary" onClick={() => setAttachmentPreview(null)}>关闭</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <Dialog open={removalRequest !== null} onOpenChange={(_event, data) => !data.open && setRemovalRequest(null)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{removalRequest?.kind === 'expense' ? '删除明细' : '删除附件'}</DialogTitle>
            <DialogContent>
              {removalRequest?.kind === 'expense'
                ? '确认删除该明细？附件文件会保留，避免影响其他明细。'
                : '确认从该明细删除此附件？附件仍被其他明细使用时会保留。'}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setRemovalRequest(null)}>取消</Button>
              <Button appearance="primary" onClick={confirmRemoval}>删除</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <Dialog open={ocrOverwriteRequest !== null} onOpenChange={(_event, data) => !data.open && resolveOcrOverwrite(false)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>覆盖现有金额？</DialogTitle>
            <DialogContent>
              当前金额 ¥{formatMoney(ocrOverwriteRequest?.current.amountCents ?? 0)}、税额 ¥{formatMoney(ocrOverwriteRequest?.current.taxCents ?? 0)}、价税合计 ¥{formatMoney(ocrOverwriteRequest?.current.totalCents ?? 0)}；识别结果为金额 ¥{formatMoney(ocrOverwriteRequest?.recognized.amountCents ?? 0)}、税额 ¥{formatMoney(ocrOverwriteRequest?.recognized.taxCents ?? 0)}、价税合计 ¥{formatMoney(ocrOverwriteRequest?.recognized.totalCents ?? 0)}。
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => resolveOcrOverwrite(false)}>保留现有金额</Button>
              <Button appearance="primary" onClick={() => resolveOcrOverwrite(true)}>覆盖</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  )
}

function mergeAttachments(project: Project, attachments: Attachment[]): void {
  for (const attachment of attachments) {
    const index = project.attachments.findIndex((item) => item.id === attachment.id)
    if (index >= 0) project.attachments[index] = attachment
    else project.attachments.push(attachment)
  }
}

interface MoneyInputProps {
  disabled: boolean
  valueCents: number
  onChange(valueCents: number): void
}

function MoneyInput({ disabled, valueCents, onChange }: MoneyInputProps) {
  const [editingValue, setEditingValue] = useState(() => formatMoney(valueCents))
  const editing = useRef(false)

  useEffect(() => {
    if (!editing.current) setEditingValue(formatMoney(valueCents))
  }, [valueCents])

  const commit = () => {
    editing.current = false
    const cents = toCents(editingValue)
    onChange(cents)
    setEditingValue(formatMoney(cents))
  }

  return (
    <Input
      disabled={disabled}
      inputMode="decimal"
      value={editingValue}
      onFocus={() => { editing.current = true }}
      onChange={(_event, data) => {
        if (!/^\d*(?:\.\d{0,2})?$/.test(data.value)) return
        setEditingValue(data.value)
        onChange(toCents(data.value))
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
    />
  )
}

function formatDateForInput(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.replaceAll('-', '/') : value
}

function normalizeDateInput(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return ''
  let year: number
  let month: number
  let day: number
  const digits = trimmed.replace(/\D/g, '')
  if (digits.length === 8) {
    year = Number(digits.slice(0, 4))
    month = Number(digits.slice(4, 6))
    day = Number(digits.slice(6, 8))
  } else {
    const match = trimmed.match(/^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})$/)
    if (!match) return null
    year = Number(match[1])
    month = Number(match[2])
    day = Number(match[3])
  }
  const candidate = new Date(year, month - 1, day)
  if (candidate.getFullYear() !== year || candidate.getMonth() !== month - 1 || candidate.getDate() !== day) return null
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function DateInput({ disabled, value, onChange }: { disabled: boolean; value: string; onChange(value: string): void }) {
  const [editingValue, setEditingValue] = useState(() => formatDateForInput(value))
  const editing = useRef(false)

  useEffect(() => {
    if (!editing.current) setEditingValue(formatDateForInput(value))
  }, [value])

  const commit = () => {
    editing.current = false
    const normalized = normalizeDateInput(editingValue)
    if (normalized === null) {
      setEditingValue(formatDateForInput(value))
      return
    }
    onChange(normalized)
    setEditingValue(formatDateForInput(normalized))
  }

  return <Input
    className="date-input"
    disabled={disabled}
    inputMode="numeric"
    maxLength={10}
    placeholder="YYYY/MM/DD"
    value={editingValue}
    onFocus={() => { editing.current = true }}
    onChange={(_event, data) => setEditingValue(data.value)}
    onBlur={commit}
    onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
  />
}

interface ExpenseRowProps {
  expense: ExpenseItem
  project: Project
  payerNames: string[]
  readOnly: boolean
  onUpdate(expenseId: string, field: keyof ExpenseItem, value: string | number | boolean): void
  onRemove(expenseId: string): void
  onManage(kind: AttachmentKind): void
}

function ExpenseRow({ expense, project, payerNames, readOnly, onUpdate, onRemove, onManage }: ExpenseRowProps) {
  const invoiceCount = allocationCount(project.invoiceAllocations, expense.id)
  const paymentCount = allocationCount(project.paymentAllocations, expense.id)
  const otherCount = allocationCount(project.otherAllocations, expense.id)
  return (
    <tr>
      <td><CustomSelect size="small" disabled={readOnly} value={expense.categoryId} onChange={(value) => onUpdate(expense.id, 'categoryId', value)} options={project.categories.map((category) => ({ value: category.id, label: category.name }))} /></td>
      <td><DateInput disabled={readOnly} value={expense.date} onChange={(value) => onUpdate(expense.id, 'date', value)} /></td>
      <td><Input disabled={readOnly} value={expense.name} placeholder="物品名称" onChange={(_event, data) => onUpdate(expense.id, 'name', data.value)} /></td>
      <td><MoneyInput disabled={readOnly} valueCents={expense.priceCents} onChange={(value) => onUpdate(expense.id, 'priceCents', value)} /></td>
      <td><MoneyInput disabled={readOnly} valueCents={expense.taxCents} onChange={(value) => onUpdate(expense.id, 'taxCents', value)} /></td>
      <td className="money-cell">{formatMoney(expenseTotalCents(expense))}</td>
      <td className="money-cell">{formatMoney(expenseTotalCents(expense))}</td>
      <td>
        <PayerSelect expense={expense} payerNames={payerNames} readOnly={readOnly} onUpdate={onUpdate} />
      </td>
      <td className="checkbox-cell"><Checkbox disabled={readOnly} checked={expense.reimbursed} onChange={(_event, data) => onUpdate(expense.id, 'reimbursed', Boolean(data.checked))} /></td>
      <td className="attachment-column attachment-cell-column"><AttachmentCell count={invoiceCount} kind="invoice" readOnly={readOnly} onManage={() => onManage('invoice')} /></td>
      <td className="attachment-cell-column"><AttachmentCell count={paymentCount} kind="payment" readOnly={readOnly} onManage={() => onManage('payment')} /></td>
      <td className="attachment-cell-column"><AttachmentCell count={otherCount} kind="other" readOnly={readOnly} onManage={() => onManage('other')} /></td>
      <td><Input disabled={readOnly} value={expense.note} onChange={(_event, data) => onUpdate(expense.id, 'note', data.value)} /></td>
      <td className="row-action-cell">
        <button className="row-delete" type="button" aria-label="删除明细" title="删除明细" disabled={readOnly} onClick={() => onRemove(expense.id)}>
          <svg aria-hidden="true" viewBox="0 0 16 16">
            <path d="M3.5 3.5l9 9m0-9-9 9" />
          </svg>
        </button>
      </td>
    </tr>
  )
}

interface ExpenseCardProps {
  expense: ExpenseItem
  project: Project
  readOnly: boolean
  onEdit(): void
  onRemove(): void
  onManage(kind: AttachmentKind): void
  onAttach(kind: AttachmentKind, files: File[]): void
}

function ExpenseCard({ expense, project, readOnly, onEdit, onRemove, onManage, onAttach }: ExpenseCardProps) {
  const invoiceCount = allocationCount(project.invoiceAllocations, expense.id)
  const paymentCount = allocationCount(project.paymentAllocations, expense.id)
  const otherCount = allocationCount(project.otherAllocations, expense.id)
  const category = project.categories.find((item) => item.id === expense.categoryId)

  return (
    <article className="expense-card">
      <div className="expense-card-top">
        <span className="expense-category-pill" style={{ '--category-color': category?.color ?? '#64748b' } as CSSProperties}>
          <span aria-hidden="true" />
          {category?.name ?? '未分类'}
        </span>
        <span className="expense-card-date">{expense.date || '未设置日期'}</span>
        <span className={`expense-reimbursed-badge ${expense.reimbursed ? 'done' : 'pending'}`}>{expense.reimbursed ? '已报销' : '未报销'}</span>
        <Button size="small" onClick={onEdit}>编辑</Button>
        <button type="button" className="expense-card-more" disabled={readOnly} aria-label="删除明细" title="删除明细" onClick={onRemove}>×</button>
      </div>
      <div className="expense-card-name">
        <span>详细名称</span>
        <strong>{expense.name.trim() || '未填写名称'}</strong>
      </div>
      <div className="expense-card-metrics">
        <AmountBlock className="card-price" label="价格" valueCents={expense.priceCents} />
        <AmountBlock className="card-tax" label="税费" valueCents={expense.taxCents} />
        <AmountBlock className="card-total" label="总价" valueCents={expenseTotalCents(expense)} strong />
        <TextBlock className="card-payer" label="实际付款人" value={expense.actualPayer.trim() || '未设置付款人'} />
        <TextBlock className="card-note" label="备注" value={expense.note.trim() || '无备注'} />
      </div>
      <div className="expense-card-evidence">
        <AttachmentSummaryItem
          kind="invoice"
          count={invoiceCount}
          readOnly={readOnly}
          onManage={() => onManage('invoice')}
          onAttach={(files) => onAttach('invoice', files)}
        />
        <AttachmentSummaryItem
          kind="payment"
          count={paymentCount}
          readOnly={readOnly}
          onManage={() => onManage('payment')}
          onAttach={(files) => onAttach('payment', files)}
        />
        <AttachmentSummaryItem
          kind="other"
          count={otherCount}
          readOnly={readOnly}
          onManage={() => onManage('other')}
          onAttach={(files) => onAttach('other', files)}
        />
      </div>
    </article>
  )
}

function AmountBlock({ className = '', label, valueCents, strong = false }: { className?: string; label: string; valueCents: number; strong?: boolean }) {
  return (
    <div className={`${strong ? 'amount-block strong' : 'amount-block'} ${className}`.trim()}>
      <span>{label}</span>
      <strong>¥ {formatMoney(valueCents)}</strong>
    </div>
  )
}

function TextBlock({ className = '', label, value }: { className?: string; label: string; value: string }) {
  return (
    <div className={`text-block ${className}`.trim()}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function AttachmentSummaryItem({ kind, count, readOnly, onManage, onAttach }: {
  kind: AttachmentKind
  count: number
  readOnly: boolean
  onManage(): void
  onAttach(files: File[]): void
}) {
  const [dragActive, setDragActive] = useState(false)

  return (
    <button
      type="button"
      className={`attachment-summary-item ${kind}${dragActive ? ' drag-active' : ''}`}
      disabled={readOnly && count === 0}
      onClick={onManage}
      onDragEnter={(event) => {
        if (readOnly) return
        event.preventDefault()
        setDragActive(true)
      }}
      onDragOver={(event) => {
        if (readOnly) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false)
      }}
      onDrop={(event) => {
        if (readOnly) return
        event.preventDefault()
        setDragActive(false)
        const files = Array.from(event.dataTransfer.files)
        if (files.length) onAttach(files)
      }}
    >
      <span>{attachmentLabel(kind)}</span>
      <strong>{count}</strong>
    </button>
  )
}

function PayerSelect({ expense, payerNames, readOnly, onUpdate }: {
  expense: ExpenseItem
  payerNames: string[]
  readOnly: boolean
  onUpdate(expenseId: string, field: keyof ExpenseItem, value: string | number | boolean): void
}) {
  return (
    <CustomSelect
      size="small"
      disabled={readOnly}
      value={expense.actualPayer}
      onChange={(value) => onUpdate(expense.id, 'actualPayer', value)}
      options={[
        { value: '', label: '未设置' },
        ...payerNames.map((payerName) => ({ value: payerName, label: payerName })),
        ...(expense.actualPayer && !payerNames.includes(expense.actualPayer)
          ? [{ value: expense.actualPayer, label: `${expense.actualPayer}（已停用）` }]
          : []),
      ]}
    />
  )
}

function TotalPanel({ expense }: { expense: ExpenseItem }) {
  const totalCents = expenseTotalCents(expense)

  return (
    <aside className="total-panel">
      <div className="total-panel-head">
        <span>总价</span>
        <em>自动计算</em>
      </div>
      <strong className="total-panel-value">¥ {formatMoney(totalCents)}</strong>
      <span className="total-panel-sub">价格 + 税费</span>
      <dl>
        <div><dt>价格</dt><dd>¥ {formatMoney(expense.priceCents)}</dd></div>
        <div><dt>税费</dt><dd>¥ {formatMoney(expense.taxCents)}</dd></div>
      </dl>
    </aside>
  )
}

interface AttachmentManagerProps {
  expense: ExpenseItem
  project: Project
  activeKind: AttachmentKind
  readOnly: boolean
  onSelectKind(kind: AttachmentKind): void
  onManage(kind: AttachmentKind): void
  onAttach(kind: AttachmentKind, files: File[]): void
  onPreview(attachment: Attachment): void
  onRemove(kind: AttachmentKind, attachmentId: string): void
}

function AttachmentManager({ expense, project, activeKind, readOnly, onSelectKind, onManage, onAttach, onPreview, onRemove }: AttachmentManagerProps) {
  const items = attachmentsForExpense(project, expense.id, activeKind)

  return (
    <section className="attachment-manager">
      <div className="attachment-kind-list" role="tablist" aria-label="附件类型">
        {ATTACHMENT_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            className={kind}
            role="tab"
            aria-selected={activeKind === kind}
            onClick={() => onSelectKind(kind)}
          >
            <span>
              <strong>{attachmentLabel(kind)}</strong>
              <small>{attachmentDescription(kind)}</small>
            </span>
            <em>{allocationCount(allocationsForKind(project, kind), expense.id)}</em>
          </button>
        ))}
      </div>
      <div className={`evidence-panel ${activeKind}`}>
        <DropTarget
          kind={activeKind}
          count={items.length}
          readOnly={readOnly}
          onManage={() => onManage(activeKind)}
          onAttach={(files) => onAttach(activeKind, files)}
        />
        <div className="evidence-file-list">
          {items.length ? items.map((attachment) => (
            <div key={attachment.id} className="evidence-file-row">
              <button type="button" title={`预览 ${attachment.originalName}`} onClick={() => onPreview(attachment)}>{attachment.originalName}</button>
              <span>{formatFileSize(attachment.size)}</span>
              <Button size="small" onClick={() => onPreview(attachment)}>预览</Button>
              <Button size="small" disabled={readOnly} onClick={() => onRemove(activeKind, attachment.id)}>删除</Button>
            </div>
          )) : <div className="evidence-empty">暂无{attachmentLabel(activeKind)}</div>}
        </div>
      </div>
    </section>
  )
}

function EvidencePanel({ expense, project, kind, readOnly, onManage, onAttach, onPreview, onRemove }: {
  expense: ExpenseItem
  project: Project
  kind: AttachmentKind
  readOnly: boolean
  onManage(): void
  onAttach(files: File[]): void
  onPreview(attachment: Attachment): void
  onRemove(attachmentId: string): void
}) {
  const items = attachmentsForExpense(project, expense.id, kind)

  return (
    <section className={`evidence-panel ${kind}`}>
      <DropTarget
        kind={kind}
        count={items.length}
        readOnly={readOnly}
        onManage={onManage}
        onAttach={onAttach}
      />
      <div className="evidence-file-list">
        {items.length ? items.map((attachment) => (
          <div key={attachment.id} className="evidence-file-row">
            <button type="button" title={`预览 ${attachment.originalName}`} onClick={() => onPreview(attachment)}>{attachment.originalName}</button>
            <span>{formatFileSize(attachment.size)}</span>
            <Button size="small" onClick={() => onPreview(attachment)}>预览</Button>
            <Button size="small" disabled={readOnly} onClick={() => onRemove(attachment.id)}>删除</Button>
          </div>
        )) : <div className="evidence-empty">暂无{attachmentLabel(kind)}</div>}
      </div>
    </section>
  )
}

function DropTarget({ kind, count, readOnly, compact = false, onManage, onAttach }: {
  kind: AttachmentKind
  count: number
  readOnly: boolean
  compact?: boolean
  onManage(): void
  onAttach(files: File[]): void
}) {
  const [dragActive, setDragActive] = useState(false)
  const label = attachmentLabel(kind)

  return (
    <button
      type="button"
      className={`drop-target ${kind}${compact ? ' compact' : ''}${dragActive ? ' drag-active' : ''}`}
      disabled={readOnly && count === 0}
      onClick={onManage}
      onDragEnter={(event) => {
        if (readOnly) return
        event.preventDefault()
        setDragActive(true)
      }}
      onDragOver={(event) => {
        if (readOnly) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false)
      }}
      onDrop={(event) => {
        if (readOnly) return
        event.preventDefault()
        setDragActive(false)
        const files = Array.from(event.dataTransfer.files)
        if (files.length) onAttach(files)
      }}
    >
      <span className="drop-target-icon">{attachmentIcon(kind)}</span>
      <span>
        <strong>{dragActive ? `松开，作为${label}导入` : `${label} ${count}`}</strong>
        <small>{readOnly ? '点击查看' : `拖入更多${label}，或点击管理`}</small>
      </span>
    </button>
  )
}

function allocationCount(allocations: Allocation[], expenseId: string): number {
  return allocations.filter((item) => item.expenseId === expenseId).length
}

function categoryName(project: Project, categoryId: string): string {
  return project.categories.find((category) => category.id === categoryId)?.name ?? '未分类'
}

function attachmentsForExpense(project: Project, expenseId: string, kind: AttachmentKind): Attachment[] {
  const allocations = allocationsForKind(project, kind)
  return allocations
    .filter((allocation) => allocation.expenseId === expenseId)
    .map((allocation) => project.attachments.find((attachment) => attachment.id === allocation.attachmentId))
    .filter((attachment): attachment is Attachment => Boolean(attachment))
}

function allocationsForKind(project: Project, kind: AttachmentKind): Allocation[] {
  if (kind === 'invoice') return project.invoiceAllocations
  if (kind === 'payment') return project.paymentAllocations
  return project.otherAllocations
}

function attachmentLabel(kind: AttachmentKind): string {
  if (kind === 'invoice') return '发票'
  if (kind === 'payment') return '支付截图'
  return '其他附件'
}

function attachmentDescription(kind: AttachmentKind): string {
  if (kind === 'invoice') return '导入后自动 OCR'
  if (kind === 'payment') return '直接关联当前明细'
  return '合同、说明、审批单'
}

function attachmentIcon(kind: AttachmentKind): string {
  if (kind === 'invoice') return '票'
  if (kind === 'payment') return '图'
  return '附'
}

function invoiceTotalForExpense(project: Project, expenseId: string): number {
  return project.invoiceAllocations
    .filter((allocation) => allocation.expenseId === expenseId)
    .reduce((total, allocation) => total + allocation.allocatedCents, 0)
}

function formatFileSize(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  if (size >= 1024) return `${Math.round(size / 1024)} KB`
  return `${size} B`
}

function AttachmentCell({ count, kind, readOnly, onManage }: { count: number; kind: AttachmentKind; readOnly: boolean; onManage(): void }) {
  return (
    <Button
      className={`attachment-entry ${kind}`}
      appearance="subtle"
      disabled={readOnly && count === 0}
      title={count > 0 ? `${readOnly ? '查看' : '管理'}${attachmentLabel(kind)}` : `添加${attachmentLabel(kind)}`}
      onClick={onManage}
    >
      <span className="attachment-entry-content">
        <span className="attachment-status-icon" aria-hidden="true">{count > 0 ? attachmentIcon(kind) : <svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" /></svg>}</span>
        <span>{count > 0 ? `${count} 份` : '添加'}</span>
      </span>
    </Button>
  )
}
