import { z } from 'zod'
import { TableConfigSchema } from './table-config'

export const TableTemplateSchema = z.object({
  id: z.string().startsWith('template-').min(10),
  name: z.string().trim().min(1).max(80),
  config: TableConfigSchema,
}).strict()

export type TableTemplate = z.infer<typeof TableTemplateSchema>
