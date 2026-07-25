import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react'
import {
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
import type { Allocation, AllProjectsFundsSummary, AppSettings, Attachment, AttachmentKind, ExpenseItem, Project, ProjectSession, WebdavSyncProgress, WebdavSyncStatus } from './shared/models'
import type {
  GlobalSettingsDraft,
  ProjectSettingsDraft,
} from './settings/settings-types'
import { SettingsDialog } from './settings/SettingsDialog'
import { SegmentedBooleanControl } from './settings/components/SettingsSection'

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
type ToolbarMenu = 'add' | 'sync'
const ATTACHMENT_KINDS: AttachmentKind[] = ['invoice', 'payment', 'other']

interface OcrOverwriteRequest {
  current: InvoiceAmounts
  recognized: InvoiceAmounts
}

interface SyncDialogState {
  status: WebdavSyncStatus
  confirmAction: 'upload' | 'download' | null
}

export default function App() {
  const [session, setSession] = useState<ProjectSession | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [includePayments, setIncludePayments] = useState(true)
  const [includeOtherAttachments, setIncludeOtherAttachments] = useState(true)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [summaryTab, setSummaryTab] = useState<'current' | 'all'>('current')
  const [allProjectsSummary, setAllProjectsSummary] = useState<AllProjectsFundsSummary | null>(null)
  const [projectTabs, setProjectTabs] = useState<Array<{ name: string; rootPath: string; expenseCount: number; readOnly: boolean }>>([])
  const [openToolbarMenu, setOpenToolbarMenu] = useState<ToolbarMenu | null>(null)
  const [exportDialog, setExportDialog] = useState(false)
  const [attachmentDialog, setAttachmentDialog] = useState<{ expenseId: string; kind: AttachmentKind } | null>(null)
  const [attachmentDragActive, setAttachmentDragActive] = useState(false)
  const [editorAttachmentKind, setEditorAttachmentKind] = useState<AttachmentKind>('invoice')
  const [viewMode, setViewMode] = useState<ViewMode>('table')
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null)
  const [categoryFilter, setCategoryFilter] = useState('__all__')
  const [payerFilter, setPayerFilter] = useState('__all__')
  const [attachmentPreview, setAttachmentPreview] = useState<{ id: string; name: string; mimeType: string; url: string } | null>(null)
  const [removalRequest, setRemovalRequest] = useState<RemovalRequest | null>(null)
  const [ocrOverwriteRequest, setOcrOverwriteRequest] = useState<OcrOverwriteRequest | null>(null)
  const [syncDialog, setSyncDialog] = useState<SyncDialogState | null>(null)
  const [syncActionBusy, setSyncActionBusy] = useState(false)
  const [syncProgress, setSyncProgress] = useState<WebdavSyncProgress | null>(null)
  const [message, setMessage] = useState('')
  const [appSettings, setAppSettings] = useState<AppSettings>({
    payerNames: [],
    recentProjects: [],
    knownProjectPaths: [],
    lastOpenProjectPaths: [],
    lastImportDirectories: {},
    defaultViewMode: 'table',
    defaultIncludePayments: true,
    defaultIncludeOtherAttachments: true,
    showProjectHistoryOnStartup: true,
    autoOpenLastProject: false,
    showSuccessMessages: true,
    syncWebdav: {
      enabled: false,
      url: 'https://dav.jianguoyun.com/dav/',
      username: '',
      remoteDirectory: '/InvoiceManager/',
    },
  })
  const [projectNameDialog, setProjectNameDialog] = useState<string | null>(null)
  const [missingRecentProject, setMissingRecentProject] = useState<{ name: string; rootPath: string } | null>(null)
  const changeVersion = useRef(0)
  const startupProjectAttempted = useRef(false)
  const workspaceRestoreFinished = useRef(false)
  const [settingsCenterOpen, setSettingsCenterOpen] = useState(false)
  const [startEntered, setStartEntered] = useState(false)
  const saving = useRef(false)
  const projectAddButtonRef = useRef<HTMLButtonElement | null>(null)
  const projectTabsRef = useRef<HTMLDivElement | null>(null)
  const tablePanelRef = useRef<HTMLElement | null>(null)
  const floatingAddDrag = useRef<{
    pointerId: number
    startX: number
    startY: number
    offsetX: number
    offsetY: number
    panelRect: DOMRect
    moved: boolean
  } | null>(null)
  const suppressFloatingAddClick = useRef(false)
  const lastAttachmentDialog = useRef<{ expenseId: string; kind: AttachmentKind } | null>(null)
  const lastSyncDialog = useRef<SyncDialogState | null>(null)
  const ocrOverwriteResolver = useRef<((overwrite: boolean) => void) | null>(null)
  const [floatingAddPosition, setFloatingAddPosition] = useState<{ x: number; y: number } | null>(null)
  const [projectAddMenuPosition, setProjectAddMenuPosition] = useState<{ left: number; top: number } | null>(null)
  const [draggingTabPath, setDraggingTabPath] = useState<string | null>(null)
  const [tabScrollState, setTabScrollState] = useState({ canScrollLeft: false, canScrollRight: false })

  const project = session?.project ?? null
  const readOnly = session?.readOnly ?? true
  const showWorkspaceShell = Boolean(project || startEntered)
  const webdavSyncAvailable = Boolean(
    appSettings.syncWebdav.enabled
    && appSettings.syncWebdav.url
    && appSettings.syncWebdav.username
    && appSettings.syncWebdav.remoteDirectory
    && appSettings.syncWebdav.encryptedPassword,
  )
  if (attachmentDialog) lastAttachmentDialog.current = attachmentDialog
  if (syncDialog) lastSyncDialog.current = syncDialog
  const renderedAttachmentDialog = attachmentDialog ?? lastAttachmentDialog.current
  const renderedSyncDialog = syncDialog ?? lastSyncDialog.current
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
  const categoryFilterOptions = useMemo(() => (
    project
      ? [{ value: '__all__', label: '类别：全部' }, ...project.categories.map((category) => ({ value: category.id, label: `类别：${category.name}` }))]
      : [{ value: '__all__', label: '类别：全部' }]
  ), [project])
  const payerFilterOptions = useMemo(() => {
    if (!project) return [{ value: '__all__', label: '付款人：全部' }]
    const payerNames = [...new Set([...appSettings.payerNames, ...project.expenses.map((expense) => expense.actualPayer).filter(Boolean)])]
    return [
      { value: '__all__', label: '付款人：全部' },
      { value: '__unset__', label: '付款人：未设置' },
      ...payerNames.map((payerName) => ({ value: payerName, label: `付款人：${payerName}` })),
    ]
  }, [appSettings.payerNames, project])
  const currentPayerBreakdowns = useMemo(() => {
    if (!project) return []
    const totals = new Map<string, { totalCents: number; reimbursedCents: number; unreimbursedCents: number }>()
    for (const expense of project.expenses) {
      const payerName = expense.actualPayer.trim() || '未设置付款人'
      const totalCents = expenseTotalCents(expense)
      const item = totals.get(payerName) ?? { totalCents: 0, reimbursedCents: 0, unreimbursedCents: 0 }
      item.totalCents += totalCents
      if (expense.reimbursed) item.reimbursedCents += totalCents
      else item.unreimbursedCents += totalCents
      totals.set(payerName, item)
    }
    return [...totals.entries()]
      .map(([payerName, totals]) => ({ payerName, ...totals }))
      .sort((left, right) => right.unreimbursedCents - left.unreimbursedCents)
  }, [project])
  const floatingAddStyle: CSSProperties | undefined = floatingAddPosition
    ? { left: floatingAddPosition.x, top: floatingAddPosition.y, right: 'auto', bottom: 'auto' }
    : undefined
  const projectAddMenuStyle: CSSProperties | undefined = projectAddMenuPosition
    ? { left: projectAddMenuPosition.left, top: projectAddMenuPosition.top, right: 'auto' }
    : undefined
  const openProjectPathKey = projectTabs.map((tab) => tab.rootPath).join('\n')

  function showSuccessMessage(successMessage: string) {
    if (appSettings.showSuccessMessages) setMessage(successMessage)
  }

  useEffect(() => {
    setCategoryFilter('__all__')
    setPayerFilter('__all__')
    setEditingExpenseId(null)
    setFloatingAddPosition(null)
  }, [project?.id])

  const updateTabScrollState = () => {
    const tabs = projectTabsRef.current
    if (!tabs) {
      setTabScrollState({ canScrollLeft: false, canScrollRight: false })
      return
    }
    setTabScrollState({
      canScrollLeft: tabs.scrollLeft > 1,
      canScrollRight: tabs.scrollLeft + tabs.clientWidth < tabs.scrollWidth - 1,
    })
  }

  useEffect(() => {
    updateTabScrollState()
  }, [projectTabs.length])

  useEffect(() => {
    if (!session) return
    const nextTab = {
      name: session.project.name,
      rootPath: session.rootPath,
      expenseCount: session.project.expenses.length,
      readOnly: session.readOnly,
    }
    setProjectTabs((current) => {
      const existingIndex = current.findIndex((item) => item.rootPath === nextTab.rootPath)
      if (existingIndex < 0) return [...current, nextTab]
      return current.map((item, index) => (index === existingIndex ? nextTab : item))
    })
  }, [session])

  useEffect(() => {
    if (!window.invoiceManager) {
      setMessage('应用接口初始化失败，请重新启动应用')
      return
    }

    const initialize = async () => {
      try {
        const settings = await window.invoiceManager.getSettings()
        setAppSettings(settings)
        setViewMode(settings.defaultViewMode)
        setIncludePayments(settings.defaultIncludePayments)
        setIncludeOtherAttachments(settings.defaultIncludeOtherAttachments)
        if (!startupProjectAttempted.current && settings.autoOpenLastProject) {
          startupProjectAttempted.current = true
          await restoreLastWorkspace(settings)
        }
      } catch (error) {
        setMessage(`读取应用设置失败：${errorMessage(error)}`)
      } finally {
        workspaceRestoreFinished.current = true
      }
    }
    void initialize()
  }, [])

  useEffect(() => {
    if (!window.invoiceManager?.onWebdavSyncProgress) return
    return window.invoiceManager.onWebdavSyncProgress((progress) => {
      if (progress.action === 'status') return
      setSyncProgress(progress)
    })
  }, [])

  useEffect(() => {
    if (!workspaceRestoreFinished.current || !window.invoiceManager) return
    const paths = openProjectPathKey ? openProjectPathKey.split('\n') : []
    void window.invoiceManager.saveWorkspaceState(paths, session?.rootPath ?? null)
      .catch((error) => setMessage(`保存项目标签状态失败：${errorMessage(error)}`))
  }, [openProjectPathKey, session?.rootPath])

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

  const save = async (): Promise<boolean> => {
    if (!session || session.readOnly || saving.current || !dirty) return true
    const version = changeVersion.current
    const snapshot = session.project
    const previousRootPath = session.rootPath
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
      setProjectTabs((current) => current.map((item) => (
        item.rootPath === previousRootPath || item.rootPath === result.rootPath
          ? {
              name: saved.name,
              rootPath: result.rootPath,
              expenseCount: saved.expenses.length,
              readOnly: false,
            }
          : item
      )))
      if (changeVersion.current === version) setDirty(false)
      return true
    } catch (error) {
      setMessage(`保存失败：${errorMessage(error)}`)
      return false
    } finally {
      saving.current = false
    }
  }

  useEffect(() => {
    if (!dirty || !session || session.readOnly) return
    const timer = window.setTimeout(() => void save(), 1000)
    return () => window.clearTimeout(timer)
  }, [dirty, session])

  async function openSession(action: () => Promise<ProjectSession | null>) {
    setBusy(true)
    try {
      if (dirty && !(await save())) return
      const opened = await action()
      if (!opened) return
      changeVersion.current = 0
      setDirty(false)
      setSession(opened)
      setStartEntered(true)
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
          defaultViewMode: settings.defaultViewMode,
          defaultIncludePayments: settings.defaultIncludePayments,
          defaultIncludeOtherAttachments: settings.defaultIncludeOtherAttachments,
          showProjectHistoryOnStartup: settings.showProjectHistoryOnStartup,
          autoOpenLastProject: settings.autoOpenLastProject,
          showSuccessMessages: settings.showSuccessMessages,
          syncWebdav: {
            enabled: settings.syncWebdav.enabled,
            url: settings.syncWebdav.url,
            username: settings.syncWebdav.username,
            remoteDirectory: settings.syncWebdav.remoteDirectory,
          },
          lastProjectParentDirectory: settings.lastProjectParentDirectory ?? null,
          lastOpenProjectDirectory: settings.lastOpenProjectDirectory ?? null,
          lastExportDirectory: settings.lastExportDirectory ?? null,
          lastImportDirectories: {
            invoice: settings.lastImportDirectories.invoice ?? null,
            payment: settings.lastImportDirectories.payment ?? null,
            other: settings.lastImportDirectories.other ?? null,
          },
        })
      }
      setAppSettings(settings)
      if (opened.readOnly) setMessage('项目已被其他进程占用，当前只读打开')
      else showSuccessMessage('项目已打开')
    } catch (error) {
      setMessage(`打开失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  async function restoreLastWorkspace(settings: AppSettings) {
    const fallbackPath = settings.recentProjects[0]?.rootPath
    const savedPaths = settings.lastOpenProjectPaths.length > 0
      ? settings.lastOpenProjectPaths
      : fallbackPath ? [fallbackPath] : []
    if (savedPaths.length === 0) return

    const activePath = settings.lastActiveProjectPath && savedPaths.includes(settings.lastActiveProjectPath)
      ? settings.lastActiveProjectPath
      : savedPaths[savedPaths.length - 1]
    const restoreOrder = [...savedPaths.filter((path) => path !== activePath), activePath]
    const restoredSessions = new Map<string, ProjectSession>()

    for (const rootPath of restoreOrder) {
      try {
        const opened = await window.invoiceManager.openRecentProject(rootPath)
        restoredSessions.set(rootPath, opened)
      } catch {
        // Missing or invalid projects are skipped; the remaining tabs can still be restored.
      }
    }

    const restoredPaths = savedPaths.filter((path) => restoredSessions.has(path))
    const restoredActivePath = restoredSessions.has(activePath)
      ? activePath
      : [...restoreOrder].reverse().find((path) => restoredSessions.has(path))
    if (!restoredActivePath) return

    setProjectTabs(restoredPaths.map((rootPath) => {
      const opened = restoredSessions.get(rootPath)!
      return {
        name: opened.project.name,
        rootPath: opened.rootPath,
        expenseCount: opened.project.expenses.length,
        readOnly: opened.readOnly,
      }
    }))
    setSession(restoredSessions.get(restoredActivePath)!)
    setStartEntered(true)
    setAppSettings(await window.invoiceManager.getSettings())
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
    setOpenToolbarMenu(null)
    setProjectAddMenuPosition(null)
    setSettingsCenterOpen(true)
  }

  const handleSettingsCenterSave = async (
    globalDraft: GlobalSettingsDraft,
    projectDraft: ProjectSettingsDraft | null,
    globalDirty: boolean,
    projectDirty: boolean,
  ) => {
    if (projectDirty && projectDraft && session) {
      if (session.readOnly) {
        throw new Error('只读项目不能修改')
      }

      const previousRootPath = session.rootPath
      const nextProject = structuredClone(session.project)
      nextProject.name = projectDraft.name
      nextProject.categories = structuredClone(projectDraft.categories)

      const result = await window.invoiceManager.saveProject(nextProject)

      setSession((current) => (
        current
          ? {
              ...current,
              rootPath: result.rootPath,
              project: result.project,
            }
          : current
      ))
      setProjectTabs((current) => current.map((item) => (
        item.rootPath === previousRootPath || item.rootPath === result.rootPath
          ? {
              name: result.project.name,
              rootPath: result.rootPath,
              expenseCount: result.project.expenses.length,
              readOnly: false,
            }
          : item
      )))

      setDirty(false)
    }

    if (globalDirty) {
      const updatedSettings = await window.invoiceManager.saveSettings({
        payerNames: globalDraft.payerNames,
        defaultViewMode: globalDraft.defaultViewMode,
        defaultIncludePayments: globalDraft.defaultIncludePayments,
        defaultIncludeOtherAttachments: globalDraft.defaultIncludeOtherAttachments,
        showProjectHistoryOnStartup: globalDraft.showProjectHistoryOnStartup,
        autoOpenLastProject: globalDraft.autoOpenLastProject,
        showSuccessMessages: globalDraft.showSuccessMessages,
        syncWebdav: {
          enabled: globalDraft.syncWebdav.enabled,
          url: globalDraft.syncWebdav.url,
          username: globalDraft.syncWebdav.username,
          remoteDirectory: globalDraft.syncWebdav.remoteDirectory,
          password: globalDraft.syncWebdav.password || undefined,
          clearPassword: globalDraft.syncWebdav.clearPassword,
        },
        lastProjectParentDirectory: globalDraft.lastProjectParentDirectory,
        lastOpenProjectDirectory: globalDraft.lastOpenProjectDirectory,
        lastExportDirectory: globalDraft.lastExportDirectory,
        lastImportDirectories: globalDraft.lastImportDirectories,
      })

      setAppSettings(updatedSettings)
      setViewMode(updatedSettings.defaultViewMode)
      setIncludePayments(updatedSettings.defaultIncludePayments)
      setIncludeOtherAttachments(updatedSettings.defaultIncludeOtherAttachments)
    } else if (projectDirty) {
      setAppSettings(await window.invoiceManager.getSettings())
    }

    if (globalDraft.showSuccessMessages) {
      setMessage('设置已保存')
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
        showSuccessMessage(`已导入 ${imported.length} 个${attachmentLabel(kind)}`)
      } else if (recognizedAmounts !== null && shouldFillAmount) {
        showSuccessMessage(`已导入 ${imported.length} 张发票，金额 ¥${formatMoney(recognizedAmounts.amountCents)}，税额 ¥${formatMoney(recognizedAmounts.taxCents)}，价税合计 ¥${formatMoney(recognizedAmounts.totalCents)}`)
      } else if (recognizedAmounts !== null) {
        showSuccessMessage(`已识别价税合计 ¥${formatMoney(recognizedAmounts.totalCents)}，已保留现有金额`)
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
      showSuccessMessage('已从最近项目中移除')
    } catch (error) {
      setMessage(`移除记录失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const showAllProjectsSummary = async () => {
    setOpenToolbarMenu(null)
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
      showSuccessMessage('明细已删除')
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
    showSuccessMessage('附件已从明细删除')
  }

  const exportZip = async () => {
    if (!project || session?.readOnly) return
    setBusy(true)
    try {
      if (dirty && !(await save())) return
      setExportDialog(false)
      const result = await window.invoiceManager.exportProject(project, { includePayments, includeOtherAttachments })
      if (!result) return
      setSession((current) => (current ? { ...current, project: result.project } : current))
      setDirty(false)
      showSuccessMessage(`导出完成：${result.filePath}`)
    } catch (error) {
      setMessage(`导出失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const openExportDialog = () => {
    setIncludePayments(appSettings.defaultIncludePayments)
    setIncludeOtherAttachments(appSettings.defaultIncludeOtherAttachments)
    setExportDialog(true)
  }

  const importSyncPackage = async () => {
    setOpenToolbarMenu(null)
    setBusy(true)
    try {
      if (dirty && !(await save())) return
      const result = await window.invoiceManager.importSyncPackage()
      if (!result) return
      setSession(result.session)
      setStartEntered(true)
      setAppSettings(result.settings)
      setDirty(false)
      setAllProjectsSummary(null)
      showSuccessMessage(`已导入项目同步包：${result.summary.projectName}`)
    } catch (error) {
      setMessage(`导入同步包失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const exportSyncPackage = async () => {
    if (!project || session?.readOnly) return
    setOpenToolbarMenu(null)
    setBusy(true)
    try {
      if (dirty && !(await save())) return
      const result = await window.invoiceManager.exportSyncPackage(project)
      if (!result) return
      setSession((current) => (current ? { ...current, project: result.project } : current))
      setDirty(false)
      showSuccessMessage(`同步包已导出：${result.filePath}`)
    } catch (error) {
      setMessage(`导出同步包失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const syncWithWebdav = async () => {
    if (!project || session?.readOnly) return
    setOpenToolbarMenu(null)
    setBusy(true)
    try {
      if (dirty && !(await save())) return
      const result = await window.invoiceManager.getWebdavSyncStatus(project)
      setSyncDialog({ status: result.status, confirmAction: null })
    } catch (error) {
      setMessage(`坚果云同步失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const closeSyncDialog = () => {
    if (syncActionBusy) return
    setSyncDialog(null)
    setSyncProgress(null)
  }

  const cancelSyncDialog = () => {
    if (syncActionBusy) return
    setSyncDialog(null)
    setSyncProgress(null)
    setMessage('已取消同步')
  }

  const requestSyncAction = (action: 'upload' | 'download') => {
    if (!syncDialog) return
    const needsConfirm = action === 'upload'
      ? syncDialog.status.state === 'remote-newer' || syncDialog.status.conflict
      : syncDialog.status.state === 'local-newer' || syncDialog.status.conflict
    if (needsConfirm && syncDialog.confirmAction !== action) {
      setSyncDialog({ ...syncDialog, confirmAction: action })
      return
    }
    void runSyncAction(action, needsConfirm)
  }

  const runSyncAction = async (action: 'upload' | 'download', force: boolean) => {
    if (!project) return
    setSyncActionBusy(true)
    setSyncProgress({
      action,
      phase: 'start',
      current: 0,
      total: 1,
      message: action === 'upload' ? '正在准备上传' : '正在准备下载',
    })
    try {
      const result = action === 'upload'
        ? await window.invoiceManager.uploadCurrentProjectWebdav(project, force)
        : await window.invoiceManager.downloadCurrentProjectWebdav(project, force)
      if (result.session) {
        setSession(result.session)
        setDirty(false)
      }
      if (result.settings) setAppSettings(result.settings)
      setSyncDialog(null)
      setSyncProgress(null)
      showSuccessMessage(action === 'upload' ? '已上传当前项目到坚果云' : '已从坚果云下载当前项目')
    } catch (error) {
      setSyncProgress(null)
      setMessage(`坚果云同步失败：${errorMessage(error)}`)
    } finally {
      setSyncActionBusy(false)
    }
  }

  const closeProjectTab = async (rootPath: string) => {
    const isActive = session?.rootPath === rootPath
    const closedTabIndex = projectTabs.findIndex((item) => item.rootPath === rootPath)
    const remainingTabs = projectTabs.filter((item) => item.rootPath !== rootPath)
    if (!isActive) {
      setProjectTabs(remainingTabs)
      return
    }
    setBusy(true)
    try {
      if (dirty && !(await save())) return
      await window.invoiceManager.closeCurrentProject()
      const nextTab = remainingTabs[Math.min(closedTabIndex, remainingTabs.length - 1)]
      if (nextTab) {
        const opened = await window.invoiceManager.openRecentProject(nextTab.rootPath)
        setSession(opened)
      } else {
        setSession(null)
      }
      setProjectTabs(remainingTabs)
      setDirty(false)
      setAllProjectsSummary(null)
    } catch (error) {
      setMessage(`关闭项目失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const clampFloatingAddPosition = (clientX: number, clientY: number) => {
    const drag = floatingAddDrag.current
    if (!drag) return
    const buttonSize = 56
    const margin = 12
    const x = Math.min(
      Math.max(clientX - drag.panelRect.left - drag.offsetX, margin),
      drag.panelRect.width - buttonSize - margin,
    )
    const y = Math.min(
      Math.max(clientY - drag.panelRect.top - drag.offsetY, margin),
      drag.panelRect.height - buttonSize - margin,
    )
    setFloatingAddPosition({ x, y })
  }

  const placeProjectAddMenu = () => {
    const button = projectAddButtonRef.current
    if (!button) return
    const rect = button.getBoundingClientRect()
    const width = 300
    const margin = 8
    setProjectAddMenuPosition({
      left: Math.min(Math.max(rect.left, margin), window.innerWidth - width - margin),
      top: rect.bottom + 6,
    })
  }

  const toggleProjectAddMenu = () => {
    if (openToolbarMenu === 'add') {
      setOpenToolbarMenu(null)
      setProjectAddMenuPosition(null)
      return
    }
    placeProjectAddMenu()
    setOpenToolbarMenu('add')
  }

  const scrollProjectTabs = (direction: -1 | 1) => {
    const tabs = projectTabsRef.current
    if (!tabs) return
    tabs.scrollBy({ left: direction * Math.round(tabs.clientWidth * 0.7), behavior: 'smooth' })
  }

  const moveProjectTab = (sourceRootPath: string, targetRootPath: string) => {
    if (sourceRootPath === targetRootPath) return
    setProjectTabs((current) => {
      const sourceIndex = current.findIndex((item) => item.rootPath === sourceRootPath)
      const targetIndex = current.findIndex((item) => item.rootPath === targetRootPath)
      if (sourceIndex < 0 || targetIndex < 0) return current
      const next = [...current]
      const [sourceTab] = next.splice(sourceIndex, 1)
      next.splice(targetIndex, 0, sourceTab)
      return next
    })
  }

  return (
    <div className="app-shell">
      {showWorkspaceShell && (
        <header className="topbar">
          <div className="toolbar">
            <div className={`project-tabs-shell${tabScrollState.canScrollLeft ? ' can-scroll-left' : ''}${tabScrollState.canScrollRight ? ' can-scroll-right' : ''}`}>
              <button
                type="button"
                className="project-tabs-arrow left"
                aria-label="向左滚动项目标签"
                disabled={!tabScrollState.canScrollLeft}
                onClick={() => scrollProjectTabs(-1)}
              >
                <svg className="icon-arrow" aria-hidden="true" viewBox="0 0 1024 1024">
                  <path d="M744.3372563 1017.13692445c11.1289837 0 22.2701037-4.2477037 30.76551111-12.74311112 16.99081482-16.99081482 16.99081482-44.54020741 0-61.51888592L345.02883555 512.80099555 775.10276741 82.7392c16.99081482-16.97867852 16.99081482-44.54020741 0-61.51888592-16.99081482-16.99081482-44.52807111-16.99081482-61.51888593 0L252.74443852 482.04762075a43.51469037 43.51469037 0 0 0 0 61.53102222l460.83944296 460.81517036c8.48327111 8.49540741 19.62439111 12.74311111 30.75337482 12.74311112z" />
                </svg>
              </button>
              <div
                ref={projectTabsRef}
                className="project-tabs"
                role="tablist"
                aria-label="打开的项目"
                onWheel={(event) => {
                  const delta = event.deltaX || event.deltaY
                  if (!delta || event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return
                  event.currentTarget.scrollLeft += delta
                  event.preventDefault()
                }}
                onScroll={() => {
                  updateTabScrollState()
                  if (openToolbarMenu === 'add') placeProjectAddMenu()
                }}
              >
                {projectTabs.map((tab) => {
                  const active = tab.rootPath === session?.rootPath
                  const tabState = active && dirty && !readOnly ? 'unsaved' : tab.readOnly ? 'readonly' : 'saved'
                  return (
                    <div
                      key={tab.rootPath}
                      role="tab"
                      tabIndex={0}
                      aria-selected={active}
                      draggable
                      className={`project-tab ${tabState}${draggingTabPath === tab.rootPath ? ' dragging' : ''}`}
                      title={`${tab.name}\n${tab.rootPath}`}
                      onClick={() => {
                        if (!active) void openSession(() => window.invoiceManager.openRecentProject(tab.rootPath))
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        if (!active) void openSession(() => window.invoiceManager.openRecentProject(tab.rootPath))
                      }}
                      onDragStart={(event) => {
                        setDraggingTabPath(tab.rootPath)
                        event.dataTransfer.effectAllowed = 'move'
                        event.dataTransfer.setData('text/plain', tab.rootPath)
                      }}
                      onDragOver={(event) => {
                        event.preventDefault()
                        event.dataTransfer.dropEffect = 'move'
                      }}
                      onDrop={(event) => {
                        event.preventDefault()
                        const sourceRootPath = event.dataTransfer.getData('text/plain') || draggingTabPath
                        if (sourceRootPath) moveProjectTab(sourceRootPath, tab.rootPath)
                        setDraggingTabPath(null)
                      }}
                      onDragEnd={() => setDraggingTabPath(null)}
                    >
                      {tabState === 'readonly' ? (
                        <svg className="project-tab-lock" aria-hidden="true" viewBox="0 0 16 16"><path d="M4.5 7V5.5a3.5 3.5 0 017 0V7" /><rect x="3.5" y="7" width="9" height="6" rx="1" /></svg>
                      ) : <span className="project-tab-dot" aria-hidden="true" />}
                      <span className="project-tab-name">{tab.name}</span>
                      <span className="project-tab-meta">{active && dirty && !readOnly ? '未保存' : tab.readOnly ? '只读' : tab.expenseCount}</span>
                      <button
                        type="button"
                        className="project-tab-close"
                        aria-label={`关闭${tab.name}`}
                        title="关闭项目"
                        onClick={(event) => {
                          event.stopPropagation()
                          void closeProjectTab(tab.rootPath)
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter' && event.key !== ' ') return
                          event.preventDefault()
                          event.stopPropagation()
                          void closeProjectTab(tab.rootPath)
                        }}
                      >
                        <svg className="icon-close" aria-hidden="true" viewBox="0 0 1024 1024">
                          <path d="M886.784 746.496q29.696 30.72 43.52 56.32t-4.608 58.368q-4.096 6.144-11.264 14.848t-14.848 16.896-15.36 14.848-12.8 9.728q-25.6 15.36-60.416 8.192t-62.464-34.816l-43.008-43.008-57.344-57.344-67.584-67.584-73.728-73.728-131.072 131.072q-60.416 60.416-98.304 99.328-38.912 38.912-77.312 48.128t-68.096-17.408l-7.168-7.168-11.264-11.264-11.264-11.264q-6.144-6.144-7.168-8.192-11.264-14.336-13.312-29.184t2.56-29.184 13.824-27.648 20.48-24.576q9.216-8.192 32.768-30.72l55.296-57.344q33.792-32.768 75.264-73.728t86.528-86.016q-49.152-49.152-93.696-93.184t-79.872-78.848-57.856-56.832-27.648-27.136q-26.624-26.624-27.136-52.736t17.92-52.736q8.192-10.24 23.552-24.064t21.504-17.92q30.72-20.48 55.296-17.92t49.152 28.16l31.744 31.744q23.552 23.552 58.368 57.344t78.336 76.288 90.624 88.576q38.912-38.912 76.288-75.776t69.632-69.12 58.368-57.856 43.52-43.008q24.576-23.552 53.248-31.232t55.296 12.8q1.024 1.024 6.656 5.12t11.264 9.216 10.752 9.728 7.168 5.632q27.648 26.624 27.136 57.856t-27.136 57.856q-18.432 18.432-45.568 46.08t-60.416 60.416-70.144 69.632l-77.824 77.824q37.888 36.864 74.24 72.192t67.584 66.048 56.32 56.32 41.472 41.984z" />
                        </svg>
                      </button>
                    </div>
                  )
                })}
                <div className="project-tab-add-wrap">
                  <button
                    ref={projectAddButtonRef}
                    type="button"
                    className="project-tab-add"
                    title="添加项目"
                    aria-label="添加项目"
                    aria-haspopup="menu"
                    onClick={toggleProjectAddMenu}
                  >
                    <svg className="icon-plus" aria-hidden="true" viewBox="0 0 1024 1024">
                      <path d="M925.696 384q19.456 0 37.376 7.68t30.72 20.48 20.48 30.72 7.68 37.376q0 20.48-7.68 37.888t-20.48 30.208-30.72 20.48-37.376 7.68l-287.744 0 0 287.744q0 20.48-7.68 37.888t-20.48 30.208-30.72 20.48-37.376 7.68q-20.48 0-37.888-7.68t-30.208-20.48-20.48-30.208-7.68-37.888l0-287.744-287.744 0q-20.48 0-37.888-7.68t-30.208-20.48-20.48-30.208-7.68-37.888q0-19.456 7.68-37.376t20.48-30.72 30.208-20.48 37.888-7.68l287.744 0 0-287.744q0-19.456 7.68-37.376t20.48-30.72 30.208-20.48 37.888-7.68q39.936 0 68.096 28.16t28.16 68.096l0 287.744 287.744 0z" />
                    </svg>
                  </button>
                </div>
              </div>
              <button
                type="button"
                className="project-tabs-arrow right"
                aria-label="向右滚动项目标签"
                disabled={!tabScrollState.canScrollRight}
                onClick={() => scrollProjectTabs(1)}
              >
                <svg className="icon-arrow" aria-hidden="true" viewBox="0 0 1024 1024">
                  <path d="M746.666667 554.666667a42.666667 42.666667 0 0 1-30.08-12.586667l-469.333334-469.333333a42.666667 42.666667 0 0 1 0-60.16 42.666667 42.666667 0 0 1 60.16 0l469.333334 469.333333A42.666667 42.666667 0 0 1 746.666667 554.666667z" />
                  <path d="M277.333333 1024a42.666667 42.666667 0 0 1-30.08-72.746667l469.333334-469.333333a42.666667 42.666667 0 0 1 60.16 60.16l-469.333334 469.333333A42.666667 42.666667 0 0 1 277.333333 1024z" />
                </svg>
              </button>
              {openToolbarMenu === 'add' && (
                <div className="toolbar-menu project-add-menu" style={projectAddMenuStyle}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenToolbarMenu(null)
                      setProjectAddMenuPosition(null)
                      requestCreateProject()
                    }}
                  >
                    新建项目
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenToolbarMenu(null)
                      setProjectAddMenuPosition(null)
                      void openSession(() => window.invoiceManager.openProject())
                    }}
                  >
                    打开本地项目
                  </button>
                  <div className="toolbar-menu-divider" />
                  {appSettings.recentProjects.length ? appSettings.recentProjects.map((recentProject) => {
                    const isCurrentProject = recentProject.rootPath === session?.rootPath
                    const isOpenedProject = projectTabs.some((tab) => tab.rootPath === recentProject.rootPath)
                    return (
                      <button
                        key={recentProject.rootPath}
                        type="button"
                        disabled={isOpenedProject}
                        onClick={() => {
                          setOpenToolbarMenu(null)
                          setProjectAddMenuPosition(null)
                          void openRecentProject(recentProject)
                        }}
                      >
                        <span>{recentProject.name}</span>
                        <small>{isOpenedProject ? `${isCurrentProject ? '当前项目' : '已打开'} · ${recentProject.rootPath}` : recentProject.rootPath}</small>
                      </button>
                    )
                  }) : <p className="toolbar-menu-empty">暂无最近项目</p>}
                </div>
              )}
            </div>
            <button type="button" className="toolbar-icon-button" title="设置" aria-label="设置" onClick={requestOpenSettings}>
              <svg className="settings-icon" aria-hidden="true" viewBox="0 0 1084 1024">
                <path d="M1072.147851 406.226367c-6.331285-33.456782-26.762037-55.073399-52.047135-55.073399-0.323417 0-0.651455 0.003081-0.830105 0.009241l-4.655674 0c-73.124722 0-132.618162-59.491899-132.618162-132.618162 0-23.731152 11.447443-50.336101 11.546009-50.565574 13.104573-29.498767 3.023185-65.672257-23.427755-84.127081l-1.601687-1.127342-134.400039-74.661726-1.700252-0.745401c-8.753836-3.805547-18.334698-5.735272-28.479231-5.735272-20.789593 0-41.235746 8.344174-54.683758 22.306575-14.741683 15.216028-65.622973 58.649474-104.721083 58.649474-39.450789 0-90.633935-44.286652-105.438762-59.784516-13.518857-14.247316-34.128258-22.753199-55.127302-22.753199-9.945862 0-19.354234 1.861961-27.958682 5.531982l-1.746455 0.74078-139.141957 76.431283-1.643269 1.139662c-26.537186 18.437884-36.675557 54.579032-23.584845 84.062398 0.115506 0.264895 11.579891 26.725075 11.579891 50.634877 0 73.126262-59.491899 132.618162-132.618162 132.618162l-4.581749 0c-0.318797-0.00616-0.636055-0.01078-0.951772-0.01078-25.260456 0-45.672728 21.618157-52.002472 55.0811-0.462025 2.453354-11.313456 60.622322-11.313456 106.117939 0 45.494078 10.85143 103.659965 11.314996 106.119479 6.334365 33.458322 26.758957 55.076479 52.036353 55.076479 0.320337 0 0.651455-0.00616 0.842426-0.012321l4.655674 0c73.126262 0 132.618162 59.491899 132.618162 132.616622 0 23.760413-11.444363 50.333021-11.546009 50.565574-13.093793 29.474125-3.041666 65.646075 23.395414 84.151722l1.569346 1.093459 131.838879 73.726895 1.675611 0.7377c8.750757 3.84251 18.305437 5.790715 28.397607 5.790715 21.082208 0 41.676209-8.706094 55.0888-23.290689 18.724339-20.347588 69.527086-62.362616 107.04815-62.362616 40.625872 0 92.72537 47.100385 107.759669 63.583903 13.441852 14.831008 34.176001 23.689571 55.470741 23.695731l0.00616 0c9.895039 0 19.27877-1.883523 27.893999-5.598205l1.711034-0.73924 136.659342-75.531873 1.617088-1.128882c26.492523-18.456365 36.601633-54.600594 23.538642-84.016195-0.115506-0.267974-11.595291-27.082374-11.595291-50.67646 0-73.124722 59.49344-132.616622 132.618162-132.616622l4.517066-0.00154c0.300316 0.00616 0.599092 0.009241 0.899409 0.009241 25.331299-0.00154 45.785153-21.619697 52.107197-55.054918 0.112426-0.589852 11.325776-59.507301 11.325776-106.14104C1083.464388 466.640776 1072.609877 408.67356 1072.147851 406.226367zM377.486862 945.656142l-115.32764-64.487932c5.082277-13.052211 15.437801-43.51815 15.437801-75.017486 0-109.382917-84.176364-199.816642-192.587488-208.134635-2.647404-15.427021-8.873963-54.967133-8.873963-85.667166 0-30.65691 6.223479-70.232445 8.869343-85.671786 108.415744-8.311832 192.592108-98.745557 192.592108-208.134635 0-31.416171-10.300081-61.797405-15.371577-74.854236l122.721583-67.40331c0.003081 0 0.00462 0.00154 0.007701 0.00154 4.423121 4.518606 22.121764 22.080182 46.558275 39.493911 39.929754 28.46229 77.952885 42.894416 113.014434 42.894416 34.716571 0 72.437845-14.151831 112.115025-42.06431 24.282503-17.07953 41.896442-34.302288 46.308782-38.74543 0.009241-0.00154 0.018481-0.00462 0.026182-0.00616l118.301542 65.726159c-5.077657 13.055291-15.416239 43.499669-15.416239 74.958962 0 109.389077 84.174824 199.822802 192.590568 208.134635 2.645865 15.462442 8.872423 55.107281 8.872423 85.671786 0 30.687711-6.223479 70.241685-8.869343 85.673326C890.042174 606.334084 805.86427 696.767809 805.86427 806.158426c0 31.450053 10.317022 61.851309 15.393138 74.903519l-119.783103 66.198965c-5.168521-5.490399-22.603811-23.363073-46.740005-41.288109-40.701336-30.224145-79.662378-45.549521-115.800446-45.549521-35.79155 0-74.458435 15.038919-114.927219 44.694774C400.22004 922.554885 382.666163 940.255068 377.486862 945.656142zM731.271848 511.646647c0-105.803762-86.081448-191.88059-191.888289-191.88059-105.803762 0-191.88059 86.076827-191.88059 191.88059 0 105.803762 86.076827 191.882129 191.88059 191.882129C645.19194 703.528777 731.271848 617.450409 731.271848 511.646647zM539.383558 395.903184c63.825696 0 115.751164 51.922387 115.751164 115.743463 0 63.825696-51.925468 115.751164-115.751164 115.751164-63.821076 0-115.743463-51.925468-115.743463-115.751164C423.640095 447.824031 475.562482 395.903184 539.383558 395.903184z" />
              </svg>
            </button>
            <div className="toolbar-menu-wrap">
              <Button
                className="sync-button"
                disabled={busy}
                onClick={() => setOpenToolbarMenu(openToolbarMenu === 'sync' ? null : 'sync')}
              >
                同步
              </Button>
              {openToolbarMenu === 'sync' && (
                <div className="toolbar-menu">
                  <button type="button" onClick={() => void importSyncPackage()}>
                    从文件导入项目
                  </button>
                  <button type="button" disabled={!project || readOnly} onClick={() => void exportSyncPackage()}>
                    导出项目同步包
                  </button>
                  {webdavSyncAvailable && (
                    <button type="button" disabled={!project || readOnly} onClick={() => void syncWithWebdav()}>
                      与坚果云同步
                    </button>
                  )}
                </div>
              )}
            </div>
            <Button className="export-button" appearance="primary" disabled={!project || session?.readOnly || busy} onClick={openExportDialog}>导出</Button>
          </div>
        </header>
      )}

      {(busy || message) && <div className={`app-message ${showWorkspaceShell ? 'below-topbar' : ''}`}>{busy && <Spinner size="tiny" />} {message}</div>}

      {!project && !startEntered ? (
        <main className="welcome">
          <div className="welcome-card">
            <div className="welcome-icon"><img src={appIconUrl} alt="" /></div>
            <h2>欢迎回来</h2>
            <p>整理发票、支付截图和报销明细</p>
            <div className="welcome-actions">
              <Button appearance="primary" size="large" onClick={() => setStartEntered(true)}>进入</Button>
            </div>
            {appSettings.showProjectHistoryOnStartup && <div className="recent-projects">
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
            </div>}
          </div>
        </main>
      ) : !project ? (
        <main className="welcome">
          <div className="welcome-card">
            <div className="welcome-icon"><img src={appIconUrl} alt="" /></div>
            <h2>工作区</h2>
            <p>请选择一个项目继续</p>
          </div>
        </main>
      ) : (
        <main className="workspace">
          <section className="table-panel" ref={tablePanelRef}>
            <div className="panel-heading">
              <div>
                <h2>报销明细</h2>
                <p>{visibleExpenses.length === project.expenses.length ? `${project.expenses.length} 条明细` : `显示 ${visibleExpenses.length} / ${project.expenses.length} 条明细`}</p>
              </div>
              <div className="panel-heading-filters" aria-label="筛选">
                <CustomSelect
                  className="panel-heading-filter-select"
                  value={categoryFilter}
                  onChange={setCategoryFilter}
                  options={categoryFilterOptions}
                />
                <CustomSelect
                  className="panel-heading-filter-select payer"
                  value={payerFilter}
                  onChange={setPayerFilter}
                  options={payerFilterOptions}
                />
              </div>
              <div className="panel-actions">
                <div className="view-switch" role="tablist" aria-label="明细视图">
                  <button type="button" role="tab" aria-selected={viewMode === 'table'} onClick={() => setViewMode('table')}>▦ 表格</button>
                  <button type="button" role="tab" aria-selected={viewMode === 'card'} onClick={() => setViewMode('card')}>▤ 卡片</button>
                </div>
                <Button className="summary-action-button" aria-haspopup="dialog" onClick={() => { setSummaryTab('current'); setSummaryOpen(true) }}>资金核算</Button>
              </div>
            </div>
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
                    <th rowSpan={2}>类别</th><th rowSpan={2}>日期</th><th rowSpan={2}>详细名称</th>
                    <th colSpan={3}>金额</th><th rowSpan={2}>实际付款</th><th rowSpan={2}>实际付款人</th>
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
                    <tr><td colSpan={14} className="empty-row">{project.expenses.length ? '没有符合筛选条件的明细' : '点击右下角“+”开始录入'}</td></tr>
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
                  <div className="card-empty-state">{project.expenses.length ? '没有符合筛选条件的明细' : '点击右下角“+”开始录入'}</div>
                )}
              </div>
            )}
            <button
              type="button"
              className={`floating-add-button${floatingAddPosition ? ' dragged' : ''}`}
              style={floatingAddStyle}
              aria-label="添加明细"
              title="拖动调整位置，点击添加明细"
              disabled={readOnly}
              onClick={(event) => {
                if (suppressFloatingAddClick.current) {
                  event.preventDefault()
                  suppressFloatingAddClick.current = false
                  return
                }
                addExpense()
              }}
              onPointerDown={(event) => {
                if (readOnly || !tablePanelRef.current) return
                const panelRect = tablePanelRef.current.getBoundingClientRect()
                const buttonRect = event.currentTarget.getBoundingClientRect()
                floatingAddDrag.current = {
                  pointerId: event.pointerId,
                  startX: event.clientX,
                  startY: event.clientY,
                  offsetX: event.clientX - buttonRect.left,
                  offsetY: event.clientY - buttonRect.top,
                  panelRect,
                  moved: false,
                }
                event.currentTarget.setPointerCapture(event.pointerId)
              }}
              onPointerMove={(event) => {
                const drag = floatingAddDrag.current
                if (!drag || drag.pointerId !== event.pointerId) return
                if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return
                drag.moved = true
                suppressFloatingAddClick.current = true
                clampFloatingAddPosition(event.clientX, event.clientY)
              }}
              onPointerUp={(event) => {
                const drag = floatingAddDrag.current
                if (!drag || drag.pointerId !== event.pointerId) return
                floatingAddDrag.current = null
                event.currentTarget.releasePointerCapture(event.pointerId)
              }}
            >
              <svg className="icon-plus" aria-hidden="true" viewBox="0 0 1024 1024">
                <path d="M925.696 384q19.456 0 37.376 7.68t30.72 20.48 20.48 30.72 7.68 37.376q0 20.48-7.68 37.888t-20.48 30.208-30.72 20.48-37.376 7.68l-287.744 0 0 287.744q0 20.48-7.68 37.888t-20.48 30.208-30.72 20.48-37.376 7.68q-20.48 0-37.888-7.68t-30.208-20.48-20.48-30.208-7.68-37.888l0-287.744-287.744 0q-20.48 0-37.888-7.68t-30.208-20.48-20.48-30.208-7.68-37.888q0-19.456 7.68-37.376t20.48-30.72 30.208-20.48 37.888-7.68l287.744 0 0-287.744q0-19.456 7.68-37.376t20.48-30.72 30.208-20.48 37.888-7.68q39.936 0 68.096 28.16t28.16 68.096l0 287.744 287.744 0z" />
              </svg>
            </button>
          </section>

        </main>
      )}
      <Dialog
        open={missingRecentProject !== null}
        onOpenChange={(_event, data) => {
          if (!data.open) setMissingRecentProject(null)
        }}
      >
        <DialogSurface className="attachment-manager-dialog">
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
            <DialogTitle>
              <div className="summary-titlebar">
                <div>
                  <span className="summary-title-text">资金核算</span>
                  <span className="summary-context">
                    {summaryTab === 'current'
                      ? project
                        ? `${project.name} · ${project.expenses.length} 条明细`
                        : '当前项目'
                      : allProjectsSummary
                        ? `全部项目 · ${allProjectsSummary.projects.length} 个项目 · ${allProjectsSummary.projects.reduce((sum, item) => sum + item.expenseCount, 0)} 条明细`
                        : '全部项目'}
                  </span>
                </div>
                <div className="summary-tabs" role="tablist">
                  <button type="button" role="tab" aria-selected={summaryTab === 'current'} onClick={() => setSummaryTab('current')}>当前项目</button>
                  <button type="button" role="tab" aria-selected={summaryTab === 'all'} onClick={() => { setSummaryTab('all'); void showAllProjectsSummary() }}>全部项目</button>
                </div>
                <button type="button" className="dialog-close-button" aria-label="关闭" title="关闭" onClick={() => setSummaryOpen(false)}>
                  <svg aria-hidden="true" viewBox="0 0 1024 1024">
                    <path d="M886.784 746.496q29.696 30.72 43.52 56.32t-4.608 58.368q-4.096 6.144-11.264 14.848t-14.848 16.896-15.36 14.848-12.8 9.728q-25.6 15.36-60.416 8.192t-62.464-34.816l-43.008-43.008-57.344-57.344-67.584-67.584-73.728-73.728-131.072 131.072q-60.416 60.416-98.304 99.328-38.912 38.912-77.312 48.128t-68.096-17.408l-7.168-7.168-11.264-11.264-11.264-11.264q-6.144-6.144-7.168-8.192-11.264-14.336-13.312-29.184t2.56-29.184 13.824-27.648 20.48-24.576q9.216-8.192 32.768-30.72l55.296-57.344q33.792-32.768 75.264-73.728t86.528-86.016q-49.152-49.152-93.696-93.184t-79.872-78.848-57.856-56.832-27.648-27.136q-26.624-26.624-27.136-52.736t17.92-52.736q8.192-10.24 23.552-24.064t21.504-17.92q30.72-20.48 55.296-17.92t49.152 28.16l31.744 31.744q23.552 23.552 58.368 57.344t78.336 76.288 90.624 88.576q38.912-38.912 76.288-75.776t69.632-69.12 58.368-57.856 43.52-43.008q24.576-23.552 53.248-31.232t55.296 12.8q1.024 1.024 6.656 5.12t11.264 9.216 10.752 9.728 7.168 5.632q27.648 26.624 27.136 57.856t-27.136 57.856q-18.432 18.432-45.568 46.08t-60.416 60.416-70.144 69.632l-77.824 77.824q37.888 36.864 74.24 72.192t67.584 66.048 56.32 56.32 41.472 41.984z" />
                  </svg>
                </button>
              </div>
            </DialogTitle>
            <DialogContent className="summary-dialog-content">
              {summaryTab === 'current' && project && summary && (
                <>
                  <div className="summary-overview">
                    <div className="summary-total-block">
                      <span>当前项目总额</span>
                      <strong>¥ {formatMoney(summary.totalCents)}</strong>
                    </div>
                    <div className="summary-quick-metrics">
                      <div><span>实际付款</span><strong>¥ {formatMoney(summary.actualPaymentCents)}</strong></div>
                      <div><span>有发票金额</span><strong className="green-value">¥ {formatMoney(summary.invoicedCents)}</strong></div>
                      <div><span>无发票金额</span><strong className="orange-value">¥ {formatMoney(summary.uninvoicedCents)}</strong></div>
                      <div><span>已报销金额</span><strong>¥ {formatMoney(summary.reimbursedCents)}</strong></div>
                    </div>
                  </div>

                  <div className="summary-list-grid current">
                    <section className="summary-list-panel">
                      <header><h3>类别合计</h3><span>{summary.categories.length} 类</span></header>
                      <div className="summary-table-list two-column">
                        <div className="summary-table-head"><span>类别</span><span>金额</span></div>
                        {summary.categories.map((item) => (
                          <div key={item.categoryId} className="summary-table-row">
                            <span>{item.categoryName}</span>
                            <strong>¥ {formatMoney(item.totalCents)}</strong>
                          </div>
                        ))}
                        {!summary.categories.length && <p>暂无类别金额</p>}
                      </div>
                    </section>
                    <section className="summary-list-panel">
                      <header><h3>付款人合计</h3><span>按未报销排序</span></header>
                      <div className="summary-table-list payer-column">
                        <div className="summary-table-head"><span>付款人</span><span>垫付</span><span>未报销</span></div>
                        {currentPayerBreakdowns.map((item) => (
                          <div key={item.payerName} className="summary-table-row">
                            <span>{item.payerName}</span>
                            <strong>¥ {formatMoney(item.totalCents)}</strong>
                            <strong className={item.unreimbursedCents > 0 ? 'red-value' : ''}>¥ {formatMoney(item.unreimbursedCents)}</strong>
                          </div>
                        ))}
                        {!currentPayerBreakdowns.length && <p>暂无付款明细</p>}
                      </div>
                    </section>
                    <section className="summary-list-panel">
                      <header><h3>明细状态</h3><span>{project.expenses.length} 条</span></header>
                      <div className="summary-table-list expense-status-column">
                        <div className="summary-table-head"><span>明细</span><span>总额</span><span>状态</span></div>
                        {project.expenses.map((expense) => (
                          <div key={expense.id} className="summary-table-row">
                            <span><strong>{expense.name || '未命名明细'}</strong><small>{categoryName(project, expense.categoryId)} · {expense.actualPayer.trim() || '未设置付款人'}</small></span>
                            <strong>¥ {formatMoney(expenseTotalCents(expense))}</strong>
                            <em className={expense.reimbursed ? 'status-pill reimbursed' : 'status-pill pending'}>{expense.reimbursed ? '已报' : '未报'}</em>
                          </div>
                        ))}
                        {!project.expenses.length && <p>暂无报销明细</p>}
                      </div>
                    </section>
                  </div>
                </>
              )}
              {summaryTab === 'all' && allProjectsSummary && <>
                <div className="summary-overview">
                  <div className="summary-total-block">
                    <span>全部项目总额</span>
                    <strong>¥ {formatMoney(allProjectsSummary.totalCents)}</strong>
                  </div>
                  <div className="summary-quick-metrics">
                    <div><span>实际付款</span><strong>¥ {formatMoney(allProjectsSummary.actualPaymentCents)}</strong></div>
                    <div><span>有发票金额</span><strong className="green-value">¥ {formatMoney(allProjectsSummary.invoicedCents)}</strong></div>
                    <div><span>无发票金额</span><strong className="orange-value">¥ {formatMoney(allProjectsSummary.uninvoicedCents)}</strong></div>
                    <div><span>已报销金额</span><strong>¥ {formatMoney(allProjectsSummary.reimbursedCents)}</strong></div>
                  </div>
                </div>

                <div className="summary-list-grid all">
                  <section className="summary-list-panel">
                    <header><h3>类别合计</h3><span>{allProjectsSummary.categories.length} 类</span></header>
                    <div className="summary-table-list two-column">
                      <div className="summary-table-head"><span>类别</span><span>金额</span></div>
                      {allProjectsSummary.categories.map((item) => (
                        <div key={item.categoryName} className="summary-table-row">
                          <span>{item.categoryName}</span>
                          <strong>¥ {formatMoney(item.totalCents)}</strong>
                        </div>
                      ))}
                      {!allProjectsSummary.categories.length && <p>暂无类别金额</p>}
                    </div>
                  </section>
                  <section className="summary-list-panel">
                    <header><h3>付款人合计</h3><span>按未报销排序</span></header>
                    <div className="summary-table-list payer-column">
                      <div className="summary-table-head"><span>付款人</span><span>垫付</span><span>未报销</span></div>
                      {allProjectsSummary.payers.map((item) => (
                        <div key={item.payerName} className="summary-table-row">
                          <span>{item.payerName}</span>
                          <strong>¥ {formatMoney(item.totalCents)}</strong>
                          <strong className={item.unreimbursedCents > 0 ? 'red-value' : ''}>¥ {formatMoney(item.unreimbursedCents)}</strong>
                        </div>
                      ))}
                      {!allProjectsSummary.payers.length && <p>暂无付款人资金记录</p>}
                    </div>
                  </section>
                  <section className="summary-list-panel">
                    <header><h3>{allProjectsSummary.projects.length} 个项目合计</h3><span>滚动</span></header>
                    <div className="summary-table-list project-column">
                      <div className="summary-table-head"><span>项目</span><span>总额</span><span>已报销</span></div>
                      {allProjectsSummary.projects.map((item) => (
                        <div key={item.rootPath} className="summary-table-row">
                          <span><strong>{item.name}</strong><small>{item.expenseCount} 条明细</small></span>
                          <strong>¥ {formatMoney(item.totalCents)}</strong>
                          <strong>¥ {formatMoney(item.reimbursedCents)}</strong>
                        </div>
                      ))}
                      {!allProjectsSummary.projects.length && <p>暂无可汇总项目</p>}
                    </div>
                  </section>
                </div>
              </>}
            </DialogContent>
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
      <Dialog open={exportDialog} onOpenChange={(_event, data) => setExportDialog(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>导出压缩包</DialogTitle>
            <DialogContent>
              <div className="export-options">
                <div className="export-option-row">
                  <span>导出压缩包时包含支付截图</span>
                  <SegmentedBooleanControl checked={includePayments} onChange={setIncludePayments} />
                </div>
                <div className="export-option-row">
                  <span>导出压缩包时包含其他附件</span>
                  <SegmentedBooleanControl checked={includeOtherAttachments} onChange={setIncludeOtherAttachments} />
                </div>
              </div>
              <p className="dialog-hint">导出的附件按“001_物品名称”重命名，原文件不会被修改。</p>
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
      <Dialog open={attachmentPreview !== null} onOpenChange={(_event, data) => !data.open && setAttachmentPreview(null)}>
        <DialogSurface className="attachment-preview-dialog">
          <DialogBody>
            <DialogTitle>
              <div className="attachment-preview-titlebar">
                <span>{attachmentPreview?.name ?? '发票预览'}</span>
                <div className="attachment-preview-title-actions">
                  <Button onClick={() => attachmentPreview && void openAttachment(attachmentPreview.id)}>用系统程序打开</Button>
                  <button type="button" className="dialog-close-button" aria-label="关闭" title="关闭" onClick={() => setAttachmentPreview(null)}>
                    <svg aria-hidden="true" viewBox="0 0 1024 1024">
                      <path d="M886.784 746.496q29.696 30.72 43.52 56.32t-4.608 58.368q-4.096 6.144-11.264 14.848t-14.848 16.896-15.36 14.848-12.8 9.728q-25.6 15.36-60.416 8.192t-62.464-34.816l-43.008-43.008-57.344-57.344-67.584-67.584-73.728-73.728-131.072 131.072q-60.416 60.416-98.304 99.328-38.912 38.912-77.312 48.128t-68.096-17.408l-7.168-7.168-11.264-11.264-11.264-11.264q-6.144-6.144-7.168-8.192-11.264-14.336-13.312-29.184t2.56-29.184 13.824-27.648 20.48-24.576q9.216-8.192 32.768-30.72l55.296-57.344q33.792-32.768 75.264-73.728t86.528-86.016q-49.152-49.152-93.696-93.184t-79.872-78.848-57.856-56.832-27.648-27.136q-26.624-26.624-27.136-52.736t17.92-52.736q8.192-10.24 23.552-24.064t21.504-17.92q30.72-20.48 55.296-17.92t49.152 28.16l31.744 31.744q23.552 23.552 58.368 57.344t78.336 76.288 90.624 88.576q38.912-38.912 76.288-75.776t69.632-69.12 58.368-57.856 43.52-43.008q24.576-23.552 53.248-31.232t55.296 12.8q1.024 1.024 6.656 5.12t11.264 9.216 10.752 9.728 7.168 5.632q27.648 26.624 27.136 57.856t-27.136 57.856q-18.432 18.432-45.568 46.08t-60.416 60.416-70.144 69.632l-77.824 77.824q37.888 36.864 74.24 72.192t67.584 66.048 56.32 56.32 41.472 41.984z" />
                    </svg>
                  </button>
                </div>
              </div>
            </DialogTitle>
            <DialogContent className="attachment-preview-content">
              {attachmentPreview && (
                attachmentPreview.mimeType === 'application/pdf'
                  ? <iframe className="attachment-preview-pdf" src={attachmentPreview.url} title={attachmentPreview.name} />
                  : <img className="attachment-preview-image" src={attachmentPreview.url} alt={attachmentPreview.name} />
              )}
            </DialogContent>
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
      <Dialog open={syncDialog !== null} onOpenChange={(_event, data) => !data.open && closeSyncDialog()}>
        <DialogSurface className="sync-dialog">
          <DialogBody>
            <DialogTitle>
              <div className="sync-dialog-title">
                <span>与坚果云同步</span>
                <small>{project?.name}</small>
              </div>
            </DialogTitle>
            <DialogContent>
              {renderedSyncDialog && (
                <div className="sync-dialog-content">
                  <div className={`sync-state-banner ${renderedSyncDialog.status.state}`}>
                    <strong>{syncStateLabel(renderedSyncDialog.status)}</strong>
                    <span>{syncStateDescription(renderedSyncDialog.status)}</span>
                  </div>
                  <div className="sync-status-grid">
                    <SyncStatusItem label="本地 revision" value={String(renderedSyncDialog.status.localRevision)} />
                    <SyncStatusItem label="本地更新时间" value={formatSyncDate(renderedSyncDialog.status.localUpdatedAt)} />
                    <SyncStatusItem label="远端 revision" value={renderedSyncDialog.status.remoteExists ? String(renderedSyncDialog.status.remoteRevision) : '不存在'} />
                    <SyncStatusItem label="远端更新时间" value={renderedSyncDialog.status.remoteUpdatedAt ? formatSyncDate(renderedSyncDialog.status.remoteUpdatedAt) : '不存在'} />
                    <SyncStatusItem label="本地上传状态" value={localUploadStatusText(renderedSyncDialog.status)} tone={renderedSyncDialog.status.localHasUnuploadedChanges ? 'warning' : 'normal'} />
                    <SyncStatusItem label="远端下载状态" value={remoteDownloadStatusText(renderedSyncDialog.status)} tone={renderedSyncDialog.status.remoteHasUndownloadedChanges ? 'warning' : 'normal'} />
                  </div>
                  {syncActionBusy && syncProgress && (
                    <div className="sync-progress-panel" role="status" aria-live="polite">
                      <div className="sync-progress-head">
                        <span>{syncProgress.message}</span>
                        <strong>{syncProgressPercent(syncProgress)}%</strong>
                      </div>
                      <div className="sync-progress-track">
                        <span style={{ width: `${syncProgressPercent(syncProgress)}%` }} />
                      </div>
                    </div>
                  )}
                  {renderedSyncDialog.confirmAction && (
                    <div className="sync-confirm-panel">
                      <strong>{renderedSyncDialog.confirmAction === 'upload' ? '确认上传覆盖远端？' : '确认下载覆盖本地？'}</strong>
                      <span>
                        {renderedSyncDialog.confirmAction === 'upload'
                          ? '远端较新或存在冲突，继续上传会以当前项目替换远端正式版本。'
                          : '本地较新或存在冲突，继续下载会先自动备份，再用远端版本覆盖当前项目。'}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </DialogContent>
            <DialogActions>
              {renderedSyncDialog?.confirmAction ? (
                <>
                  <Button disabled={syncActionBusy} onClick={() => setSyncDialog({ ...renderedSyncDialog, confirmAction: null })}>返回</Button>
                  <Button appearance="primary" disabled={syncActionBusy} onClick={() => runSyncAction(renderedSyncDialog.confirmAction!, true)}>
                    {syncActionBusy ? '处理中...' : renderedSyncDialog.confirmAction === 'upload' ? '继续上传' : '继续下载'}
                  </Button>
                </>
              ) : renderedSyncDialog?.status.state === 'latest' ? (
                <Button appearance="primary" disabled={syncActionBusy} onClick={closeSyncDialog}>关闭</Button>
              ) : (
                <>
                  <Button disabled={syncActionBusy} onClick={cancelSyncDialog}>取消</Button>
                  {renderedSyncDialog?.status.remoteExists && (
                    <Button disabled={syncActionBusy} onClick={() => requestSyncAction('download')}>从坚果云下载到当前项目</Button>
                  )}
                  <Button appearance="primary" disabled={syncActionBusy} onClick={() => requestSyncAction('upload')}>
                    上传当前项目到坚果云
                  </Button>
                </>
              )}
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <SettingsDialog
        isOpen={settingsCenterOpen}
        onClose={() => setSettingsCenterOpen(false)}
        appSettings={appSettings}
        session={session}
        onSave={handleSettingsCenterSave}
        onSessionChange={(nextSession) => {
          setSession(nextSession)
          setDirty(false)
          setAllProjectsSummary(null)
        }}
        onAppSettingsChange={setAppSettings}
      />
    </div>
  )
}

function syncStateLabel(status: WebdavSyncStatus): string {
  if (status.state === 'remote-missing') return '远端不存在'
  if (status.state === 'latest') return '已是最新'
  if (status.state === 'local-newer') return '本地较新'
  if (status.state === 'remote-newer') return '远端较新'
  return '存在冲突'
}

function syncStateDescription(status: WebdavSyncStatus): string {
  if (status.state === 'remote-missing') return '坚果云上还没有这个项目，可以上传当前项目创建远端版本。'
  if (status.state === 'latest') return '本地和坚果云上的项目 revision 与校验和一致。'
  if (status.state === 'local-newer') return '本地 revision 更高，可以上传当前项目。'
  if (status.state === 'remote-newer') return '远端 revision 更高，可以下载远端项目。'
  return 'revision 相同但校验和不同，需要选择上传或下载，不会自动合并。'
}

function formatSyncDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function localUploadStatusText(status: WebdavSyncStatus): string {
  if (!status.remoteExists) return '待首次上传'
  if (status.localHasUnuploadedChanges) return status.conflict ? '需处理冲突' : '有本地新版本'
  return '已同步'
}

function remoteDownloadStatusText(status: WebdavSyncStatus): string {
  if (!status.remoteExists) return '无远端版本'
  if (status.remoteHasUndownloadedChanges) return status.conflict ? '需处理冲突' : '有远端新版本'
  return '已同步'
}

function syncProgressPercent(progress: WebdavSyncProgress): number {
  if (progress.total <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((progress.current / progress.total) * 100)))
}

function SyncStatusItem({ label, value, tone = 'normal' }: { label: string; value: string; tone?: 'normal' | 'warning' | 'danger' }) {
  return (
    <div className={`sync-status-item ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
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
