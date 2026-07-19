/// <reference lib="webworker" />

import * as ort from 'onnxruntime-web/wasm'
import { extractInvoiceAmounts, type InvoiceAmounts, type OcrTextLine } from './amount'

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

interface TextBox {
  left: number
  top: number
  right: number
  bottom: number
}

interface OcrRuntime {
  detection: ort.InferenceSession
  recognition: ort.InferenceSession
  characters: string[]
}

interface AssetManifest {
  files: Record<string, string>
}

const DETECTION_MAX_SIDE = 1600
const DETECTION_THRESHOLD = 0.2
const BOX_THRESHOLD = 0.4
const MAX_RECOGNITION_BOXES = 160
let runtimePromise: Promise<OcrRuntime> | null = null
let releaseTimer: ReturnType<typeof setTimeout> | null = null
let taskQueue = Promise.resolve()

function assetUrl(assetBase: string, name: string): string {
  return new URL(name, assetBase).href
}

function hexDigest(buffer: ArrayBuffer): Promise<string> {
  return crypto.subtle.digest('SHA-256', buffer).then((digest) => (
    [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
  ))
}

function checksumBuffer(name: string, buffer: ArrayBuffer): ArrayBuffer {
  if (!name.endsWith('.txt') && !name.endsWith('.mjs')) return buffer
  const normalized = new TextDecoder().decode(buffer).replace(/\r\n?/g, '\n')
  return new TextEncoder().encode(normalized).buffer as ArrayBuffer
}

async function fetchAsset(assetBase: string, name: string, expectedHash: string): Promise<ArrayBuffer> {
  const response = await fetch(assetUrl(assetBase, name))
  if (!response.ok && response.status !== 0) throw new Error(`OCR 资源读取失败：${name}`)
  const buffer = await response.arrayBuffer()
  if (await hexDigest(checksumBuffer(name, buffer)) !== expectedHash) throw new Error(`OCR 资源校验失败：${name}`)
  return buffer
}

async function loadRuntime(assetBase: string): Promise<OcrRuntime> {
  const manifestResponse = await fetch(assetUrl(assetBase, 'checksums.json'))
  if (!manifestResponse.ok && manifestResponse.status !== 0) throw new Error('OCR 校验清单读取失败')
  const manifest = await manifestResponse.json() as AssetManifest
  for (const name of ['text-detection.onnx', 'text-recognition.onnx', 'character-dictionary.txt', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
    if (!manifest.files[name]) throw new Error(`OCR 校验清单缺少：${name}`)
  }

  const [detectionModel, recognitionModel, dictionaryBuffer] = await Promise.all([
    fetchAsset(assetBase, 'text-detection.onnx', manifest.files['text-detection.onnx']),
    fetchAsset(assetBase, 'text-recognition.onnx', manifest.files['text-recognition.onnx']),
    fetchAsset(assetBase, 'character-dictionary.txt', manifest.files['character-dictionary.txt']),
    fetchAsset(assetBase, 'ort-wasm-simd-threaded.mjs', manifest.files['ort-wasm-simd-threaded.mjs']),
    fetchAsset(assetBase, 'ort-wasm-simd-threaded.wasm', manifest.files['ort-wasm-simd-threaded.wasm']),
  ])

  ort.env.wasm.numThreads = self.crossOriginIsolated ? 2 : 1
  ort.env.wasm.proxy = false
  ort.env.wasm.wasmPaths = {
    mjs: assetUrl(assetBase, 'ort-wasm-simd-threaded.mjs'),
    wasm: assetUrl(assetBase, 'ort-wasm-simd-threaded.wasm'),
  }
  const options: ort.InferenceSession.SessionOptions = {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  }
  const [detection, recognition] = await Promise.all([
    ort.InferenceSession.create(detectionModel, options),
    ort.InferenceSession.create(recognitionModel, options),
  ])
  const dictionary = new TextDecoder().decode(dictionaryBuffer).trimEnd().split('\n')
  const characters = ['blank', ...dictionary, ' ']
  if (characters.length !== 6906) throw new Error('OCR 字典与识别模型不匹配')
  return { detection, recognition, characters }
}

function runtime(assetBase: string): Promise<OcrRuntime> {
  if (releaseTimer) clearTimeout(releaseTimer)
  releaseTimer = null
  runtimePromise ??= loadRuntime(assetBase)
  return runtimePromise
}

function scheduleRuntimeRelease(): void {
  if (releaseTimer) clearTimeout(releaseTimer)
  releaseTimer = setTimeout(() => {
    const currentRuntime = runtimePromise
    runtimePromise = null
    releaseTimer = null
    if (currentRuntime) {
      void currentRuntime.then((value) => Promise.all([
        value.detection.release(),
        value.recognition.release(),
      ])).catch(() => undefined)
    }
  }, 5 * 60 * 1000)
}

function bilinearChannel(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  sourceX: number,
  sourceY: number,
  channel: number,
): number {
  const left = Math.max(0, Math.min(width - 1, Math.floor(sourceX)))
  const top = Math.max(0, Math.min(height - 1, Math.floor(sourceY)))
  const right = Math.min(width - 1, left + 1)
  const bottom = Math.min(height - 1, top + 1)
  const horizontal = Math.max(0, Math.min(1, sourceX - left))
  const vertical = Math.max(0, Math.min(1, sourceY - top))
  const topValue = pixels[(top * width + left) * 4 + channel] * (1 - horizontal)
    + pixels[(top * width + right) * 4 + channel] * horizontal
  const bottomValue = pixels[(bottom * width + left) * 4 + channel] * (1 - horizontal)
    + pixels[(bottom * width + right) * 4 + channel] * horizontal
  return topValue * (1 - vertical) + bottomValue * vertical
}

function detectionTensor(pixels: Uint8ClampedArray, width: number, height: number): { tensor: ort.Tensor; width: number; height: number } {
  const ratio = Math.min(1, DETECTION_MAX_SIDE / Math.max(width, height))
  const resizedWidth = Math.max(32, Math.round((width * ratio) / 32) * 32)
  const resizedHeight = Math.max(32, Math.round((height * ratio) / 32) * 32)
  const planeSize = resizedWidth * resizedHeight
  const data = new Float32Array(planeSize * 3)
  const sourceChannels = [2, 1, 0]
  const mean = [0.485, 0.456, 0.406]
  const std = [0.229, 0.224, 0.225]

  for (let y = 0; y < resizedHeight; y += 1) {
    const sourceY = (y + 0.5) * height / resizedHeight - 0.5
    for (let x = 0; x < resizedWidth; x += 1) {
      const sourceX = (x + 0.5) * width / resizedWidth - 0.5
      const targetIndex = y * resizedWidth + x
      for (let channel = 0; channel < 3; channel += 1) {
        const value = bilinearChannel(pixels, width, height, sourceX, sourceY, sourceChannels[channel]) / 255
        data[channel * planeSize + targetIndex] = (value - mean[channel]) / std[channel]
      }
    }
  }
  return { tensor: new ort.Tensor('float32', data, [1, 3, resizedHeight, resizedWidth]), width: resizedWidth, height: resizedHeight }
}

function detectBoxes(probabilities: Float32Array, mapWidth: number, mapHeight: number, width: number, height: number): TextBox[] {
  const total = mapWidth * mapHeight
  const visited = new Uint8Array(total)
  const queue = new Int32Array(total)
  const boxes: TextBox[] = []

  for (let start = 0; start < total; start += 1) {
    if (visited[start] || probabilities[start] <= DETECTION_THRESHOLD) continue
    let head = 0
    let tail = 1
    queue[0] = start
    visited[start] = 1
    let minX = start % mapWidth
    let maxX = minX
    let minY = Math.floor(start / mapWidth)
    let maxY = minY
    let count = 0
    let score = 0

    while (head < tail) {
      const current = queue[head]
      head += 1
      const currentX = current % mapWidth
      const currentY = Math.floor(current / mapWidth)
      minX = Math.min(minX, currentX)
      maxX = Math.max(maxX, currentX)
      minY = Math.min(minY, currentY)
      maxY = Math.max(maxY, currentY)
      count += 1
      score += probabilities[current]

      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const nextY = currentY + offsetY
        if (nextY < 0 || nextY >= mapHeight) continue
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) continue
          const nextX = currentX + offsetX
          if (nextX < 0 || nextX >= mapWidth) continue
          const next = nextY * mapWidth + nextX
          if (visited[next] || probabilities[next] <= DETECTION_THRESHOLD) continue
          visited[next] = 1
          queue[tail] = next
          tail += 1
        }
      }
    }

    const componentWidth = maxX - minX + 1
    const componentHeight = maxY - minY + 1
    if (componentWidth < 3 || componentHeight < 3 || score / count < BOX_THRESHOLD) continue
    const expansion = count * 1.4 / Math.max(1, 2 * (componentWidth + componentHeight))
    const left = Math.max(0, Math.floor((minX - expansion) * width / mapWidth))
    const top = Math.max(0, Math.floor((minY - expansion) * height / mapHeight))
    const right = Math.min(width, Math.ceil((maxX + 1 + expansion) * width / mapWidth))
    const bottom = Math.min(height, Math.ceil((maxY + 1 + expansion) * height / mapHeight))
    if (right - left >= 5 && bottom - top >= 5) boxes.push({ left, top, right, bottom })
  }
  return boxes
}

function recognitionTensor(pixels: Uint8ClampedArray, width: number, height: number, box: TextBox): ort.Tensor {
  const boxWidth = box.right - box.left
  const boxHeight = box.bottom - box.top
  const contentWidth = Math.max(1, Math.min(3200, Math.ceil(48 * boxWidth / boxHeight)))
  const tensorWidth = Math.max(320, contentWidth)
  const planeSize = 48 * tensorWidth
  const data = new Float32Array(planeSize * 3)
  const sourceChannels = [2, 1, 0]

  for (let y = 0; y < 48; y += 1) {
    const sourceY = box.top + (y + 0.5) * boxHeight / 48 - 0.5
    for (let x = 0; x < contentWidth; x += 1) {
      const sourceX = box.left + (x + 0.5) * boxWidth / contentWidth - 0.5
      const targetIndex = y * tensorWidth + x
      for (let channel = 0; channel < 3; channel += 1) {
        const value = bilinearChannel(pixels, width, height, sourceX, sourceY, sourceChannels[channel]) / 255
        data[channel * planeSize + targetIndex] = (value - 0.5) / 0.5
      }
    }
  }
  return new ort.Tensor('float32', data, [1, 3, 48, tensorWidth])
}

function decodeText(output: ort.Tensor, characters: string[]): { text: string; score: number } {
  const data = output.data as Float32Array
  const timeSteps = output.dims[1]
  const classCount = output.dims[2]
  let previous = -1
  let text = ''
  let score = 0
  let count = 0
  for (let step = 0; step < timeSteps; step += 1) {
    const offset = step * classCount
    let bestIndex = 0
    let bestScore = data[offset]
    for (let index = 1; index < classCount; index += 1) {
      if (data[offset + index] > bestScore) {
        bestIndex = index
        bestScore = data[offset + index]
      }
    }
    if (bestIndex !== 0 && bestIndex !== previous) {
      text += characters[bestIndex] ?? ''
      score += bestScore
      count += 1
    }
    previous = bestIndex
  }
  return { text, score: count ? score / count : 0 }
}

function sortBoxes(boxes: TextBox[]): TextBox[] {
  return boxes.sort((left, right) => {
    const leftCenter = (left.top + left.bottom) / 2
    const rightCenter = (right.top + right.bottom) / 2
    const rowTolerance = Math.min(left.bottom - left.top, right.bottom - right.top) * 0.6
    return Math.abs(leftCenter - rightCenter) <= rowTolerance ? left.left - right.left : left.top - right.top
  })
}

async function recognizeBoxes(
  runtimeValue: OcrRuntime,
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  boxes: TextBox[],
): Promise<OcrTextLine[]> {
  const lines: OcrTextLine[] = []
  const sorted = sortBoxes(boxes)
  const selected = sorted.length <= MAX_RECOGNITION_BOXES
    ? sorted
    : [...sorted.slice(0, MAX_RECOGNITION_BOXES / 2), ...sorted.slice(-MAX_RECOGNITION_BOXES / 2)]
  for (const box of selected) {
    const tensor = recognitionTensor(pixels, width, height, box)
    const result = await runtimeValue.recognition.run({ [runtimeValue.recognition.inputNames[0]]: tensor })
    const decoded = decodeText(result[runtimeValue.recognition.outputNames[0]], runtimeValue.characters)
    if (decoded.score >= 0.5 && decoded.text) lines.push({ text: decoded.text, ...box })
  }
  return lines
}

async function recognizeAmounts(request: WorkerRequest): Promise<InvoiceAmounts> {
  const runtimeValue = await runtime(request.assetBase)
  const pixels = new Uint8ClampedArray(request.pixels)
  if (pixels.length !== request.width * request.height * 4) throw new Error('发票图像数据无效')
  const prepared = detectionTensor(pixels, request.width, request.height)
  const result = await runtimeValue.detection.run({ [runtimeValue.detection.inputNames[0]]: prepared.tensor })
  const output = result[runtimeValue.detection.outputNames[0]]
  const mapHeight = output.dims[2]
  const mapWidth = output.dims[3]
  const boxes = detectBoxes(output.data as Float32Array, mapWidth, mapHeight, request.width, request.height)
  const lowerBoxes = boxes.filter((box) => box.top >= request.height * 0.45)
  const lowerLines = await recognizeBoxes(runtimeValue, pixels, request.width, request.height, lowerBoxes)
  const lowerAmounts = extractInvoiceAmounts(lowerLines)
  if (lowerAmounts !== null) return lowerAmounts

  const remainingBoxes = boxes.filter((box) => box.top < request.height * 0.45)
  const allLines = [...await recognizeBoxes(runtimeValue, pixels, request.width, request.height, remainingBoxes), ...lowerLines]
  const amounts = extractInvoiceAmounts(allLines)
  if (amounts === null) throw new Error('未完整识别金额、税额和价税合计，或三项金额不一致')
  return amounts
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  taskQueue = taskQueue.then(async () => {
    const response: WorkerResponse = { id: event.data.id }
    try {
      response.amounts = await recognizeAmounts(event.data)
    } catch (error) {
      response.error = error instanceof Error ? error.message : String(error)
      runtimePromise = null
    } finally {
      scheduleRuntimeRelease()
    }
    self.postMessage(response)
  })
}
