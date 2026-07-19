import { z } from 'zod'

export const AttachmentKindSchema = z.enum(['invoice', 'payment'])
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>

export const CategorySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(40),
  color: z.string().min(1),
  order: z.number().int().nonnegative(),
})
export type Category = z.infer<typeof CategorySchema>

export const ExpenseItemSchema = z.object({
  id: z.string().min(1),
  categoryId: z.string().min(1),
  date: z.string(),
  name: z.string().max(120),
  priceCents: z.number().int().nonnegative(),
  taxCents: z.number().int().nonnegative(),
  actualPayer: z.string().max(80).default(''),
  note: z.string().max(500),
  reimbursed: z.boolean(),
})
export type ExpenseItem = z.infer<typeof ExpenseItemSchema>

export const AttachmentSchema = z.object({
  id: z.string().min(1),
  kind: AttachmentKindSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  originalName: z.string().min(1),
  storedPath: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
})
export type Attachment = z.infer<typeof AttachmentSchema>

export const AllocationSchema = z.object({
  id: z.string().min(1),
  expenseId: z.string().min(1),
  attachmentId: z.string().min(1),
  allocatedCents: z.number().int().nonnegative(),
})
export type Allocation = z.infer<typeof AllocationSchema>

export const ProjectSchema = z.object({
  schemaVersion: z.literal(1),
  appVersion: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  revision: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  categories: z.array(CategorySchema),
  expenses: z.array(ExpenseItemSchema),
  attachments: z.array(AttachmentSchema),
  invoiceAllocations: z.array(AllocationSchema),
  paymentAllocations: z.array(AllocationSchema),
})
export type Project = z.infer<typeof ProjectSchema>

export interface ProjectSession {
  project: Project
  rootPath: string
  readOnly: boolean
}

export const PayerNamesSchema = z.array(z.string().trim().min(1).max(80)).transform((names) => [...new Set(names)])

export const RecentProjectSchema = z.object({
  name: z.string().min(1).max(80),
  rootPath: z.string().min(1),
  lastOpenedAt: z.string().datetime(),
})
export type RecentProject = z.infer<typeof RecentProjectSchema>

export const AppSettingsSchema = z.object({
  payerNames: PayerNamesSchema.default([]),
  recentProjects: z.array(RecentProjectSchema).default([]),
  knownProjectPaths: z.array(z.string().min(1)).default([]),
  lastImportDirectories: z.object({
    invoice: z.string().min(1).optional(),
    payment: z.string().min(1).optional(),
  }).default({}),
  lastProjectParentDirectory: z.string().min(1).optional(),
  lastOpenProjectDirectory: z.string().min(1).optional(),
  lastExportDirectory: z.string().min(1).optional(),
})
export type AppSettings = z.infer<typeof AppSettingsSchema>

export const AppSettingsUpdateSchema = z.object({
  payerNames: PayerNamesSchema,
})
export type AppSettingsUpdate = z.infer<typeof AppSettingsUpdateSchema>

export interface ExportOptions {
  includePayments: boolean
}

export interface ExportResult {
  filePath: string
  project: Project
}

export interface OcrAttachmentSource {
  mimeType: string
  data: ArrayBuffer
}

export interface SaveProjectResult {
  project: Project
  rootPath: string
}

export interface ProjectFundsSummary {
  name: string
  rootPath: string
  expenseCount: number
  totalCents: number
  actualPaymentCents: number
  invoicedCents: number
  uninvoicedCents: number
  reimbursedCents: number
}

export interface AllProjectsFundsSummary {
  projects: ProjectFundsSummary[]
  payers: Array<{
    payerName: string
    totalCents: number
    reimbursedCents: number
    unreimbursedCents: number
  }>
  totalCents: number
  actualPaymentCents: number
  invoicedCents: number
  uninvoicedCents: number
  reimbursedCents: number
}

export type AttachmentPreviewSource = OcrAttachmentSource

export const IPC_CHANNELS = {
  getSettings: 'settings:get',
  saveSettings: 'settings:save',
  createProject: 'project:create',
  openProject: 'project:open',
  openRecentProject: 'project:open-recent',
  checkRecentProject: 'project:check-recent',
  removeRecentProject: 'project:remove-recent',
  saveProject: 'project:save',
  importAttachments: 'attachment:import',
  importDroppedAttachments: 'attachment:import-dropped',
  readAttachmentForOcr: 'attachment:read-for-ocr',
  readAttachmentPreview: 'attachment:read-preview',
  openAttachment: 'attachment:open',
  revealProject: 'project:reveal',
  exportProject: 'project:export',
  deleteCurrentProject: 'project:delete-current',
  getAllProjectsSummary: 'project:summary-all',
  moveCurrentProject: 'project:move-current',
} as const

export interface InvoiceManagerApi {
  getSettings(): Promise<AppSettings>
  saveSettings(settings: AppSettingsUpdate): Promise<AppSettings>
  createProject(name: string): Promise<ProjectSession | null>
  openProject(): Promise<ProjectSession | null>
  openRecentProject(rootPath: string): Promise<ProjectSession>
  checkRecentProject(rootPath: string): Promise<boolean>
  removeRecentProject(rootPath: string): Promise<AppSettings>
  saveProject(project: Project): Promise<SaveProjectResult>
  importAttachments(kind: AttachmentKind): Promise<Attachment[]>
  importDroppedAttachments(kind: AttachmentKind, files: File[]): Promise<Attachment[]>
  readAttachmentForOcr(attachmentId: string): Promise<OcrAttachmentSource>
  readAttachmentPreview(attachmentId: string): Promise<AttachmentPreviewSource>
  openAttachment(attachmentId: string): Promise<void>
  revealProject(): Promise<void>
  exportProject(project: Project, options: ExportOptions): Promise<ExportResult | null>
  deleteCurrentProject(): Promise<AppSettings>
  getAllProjectsSummary(currentProject?: Project): Promise<AllProjectsFundsSummary>
  moveCurrentProject(): Promise<{ session: ProjectSession; settings: AppSettings } | null>
}
