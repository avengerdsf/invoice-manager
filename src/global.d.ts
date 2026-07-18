import type { InvoiceManagerApi } from './shared/models'

declare global {
  interface Window {
    invoiceManager: InvoiceManagerApi
  }
}

export {}
