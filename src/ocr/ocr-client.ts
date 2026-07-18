import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { extractInvoiceAmounts, type InvoiceAmounts, type OcrTextLine } from './amount'

const MAX_SIDE = 2000
const MAX_PIXELS = 20_000_000

interface WorkerRequest {
  id: string
  assetBase: string
  width: number
  height: number
  pixels: ArrayBuffer
}

interface WorkerResponse {
  id: string
  amounts?: InvoiceAmounts
  error?: string
}

const pending = new Map<string, { resolve(value: InvoiceAmounts): void; reject(error: Error): void }>()
let worker: Worker | null = null

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./ocr-worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const request = pending.get(event.data.id)
    if (!request) return
    pending.delete(event.data.id)
    if (event.data.error) request.reject(new Error(event.data.error))
    else if (event.data.amounts === undefined) request.reject(new Error('OCR 未返回完整金额'))
    else request.resolve(event.data.amounts)
  }
  worker.onerror = (event) => {
    const error = new Error(event.message || 'OCR Worker 运行失败')
    for (const request of pending.values()) request.reject(error)
    pending.clear()
    worker?.terminate()
    worker = null
  }
  return worker
}

function canvasImageData(width: number, height: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('无法创建发票图像画布')
  return { canvas, context }
}

function limitedDimensions(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

async function renderImage(bytes: Uint8Array, mimeType: string): Promise<ImageData> {
  const imageBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const bitmap = await createImageBitmap(new Blob([imageBuffer], { type: mimeType }))
  try {
    const size = limitedDimensions(bitmap.width, bitmap.height)
    const { canvas, context } = canvasImageData(size.width, size.height)
    context.drawImage(bitmap, 0, 0, size.width, size.height)
    return context.getImageData(0, 0, canvas.width, canvas.height)
  } finally {
    bitmap.close()
  }
}

async function readPdf(bytes: Uint8Array): Promise<{ amounts: InvoiceAmounts | null; image: ImageData | null }> {
  const documentTask = getDocument({ data: bytes })
  const pdf = await documentTask.promise
  try {
    const page = await pdf.getPage(1)
    const textContent = await page.getTextContent()
    const baseViewport = page.getViewport({ scale: 1 })
    const lines = textContent.items.flatMap<OcrTextLine>((item) => {
      if (!('str' in item)) return []
      const [left, baseline] = baseViewport.convertToViewportPoint(item.transform[4], item.transform[5])
      const height = Math.max(item.height, Math.abs(item.transform[3]), 1)
      return [{
        text: item.str,
        left,
        top: baseline - height,
        right: left + item.width,
        bottom: baseline,
      }]
    })
    const amounts = extractInvoiceAmounts(lines)
    if (amounts !== null) return { amounts, image: null }

    const scale = Math.min(
      2,
      MAX_SIDE / Math.max(baseViewport.width, baseViewport.height),
      Math.sqrt(MAX_PIXELS / (baseViewport.width * baseViewport.height)),
    )
    const viewport = page.getViewport({ scale })
    const { canvas, context } = canvasImageData(Math.ceil(viewport.width), Math.ceil(viewport.height))
    await page.render({ canvas, canvasContext: context, viewport }).promise
    return { amounts: null, image: context.getImageData(0, 0, canvas.width, canvas.height) }
  } finally {
    await documentTask.destroy()
  }
}

function recognizePixels(image: ImageData): Promise<InvoiceAmounts> {
  const id = window.crypto.randomUUID()
  const pixels = image.data.buffer.slice(
    image.data.byteOffset,
    image.data.byteOffset + image.data.byteLength,
  ) as ArrayBuffer
  const request: WorkerRequest = {
    id,
    assetBase: new URL('ocr/', window.location.href).href,
    width: image.width,
    height: image.height,
    pixels,
  }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    getWorker().postMessage(request, [pixels])
  })
}

export async function recognizeInvoiceAmounts(attachmentId: string): Promise<InvoiceAmounts> {
  const source = await window.invoiceManager.readAttachmentForOcr(attachmentId)
  const bytes = new Uint8Array(source.data)
  if (source.mimeType === 'application/pdf') {
    const result = await readPdf(bytes)
    if (result.amounts !== null) return result.amounts
    if (!result.image) throw new Error('PDF 首页无法渲染')
    return recognizePixels(result.image)
  }
  return recognizePixels(await renderImage(bytes, source.mimeType))
}
