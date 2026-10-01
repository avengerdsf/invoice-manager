import { z } from 'zod'

export const TableOptionSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  color: z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/),
})
export type TableOption = z.infer<typeof TableOptionSchema>

export const FormulaTokenSchema = z.object({
  type: z.enum(['field', 'number', 'operator']),
  value: z.string(),
})
export type FormulaToken = z.infer<typeof FormulaTokenSchema>

export const CustomValueSchema = z.union([
  z.string(), z.number().finite(), z.array(z.string()), z.null(),
])
export type CustomValue = z.infer<typeof CustomValueSchema>

export const TableColumnSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['group', 'builtin', 'input', 'select', 'formula']),
  builtin: z.string().optional(),
  parentId: z.string().optional(),
  visible: z.boolean().optional(),
  width: z.number().finite().positive().optional(),
  inputType: z.enum(['text', 'number']).optional(),
  precision: z.number().int().min(0).max(12).optional(),
  unit: z.string().max(30).optional(),
  options: z.array(TableOptionSchema).optional(),
  multi: z.boolean().optional(),
  defaultValue: CustomValueSchema.optional(),
  formula: z.array(FormulaTokenSchema).optional(),
  format: z.enum(['number', 'currency', 'percent']).optional(),
})
export type TableColumn = z.infer<typeof TableColumnSchema>

export const TableConfigSchema = z.object({ columns: z.array(TableColumnSchema) })
export type TableConfig = z.infer<typeof TableConfigSchema>
