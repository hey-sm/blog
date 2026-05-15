# PDF 在线场景实现要点（关键代码版）

**约束**：PDF 来源只有远程 URL，无本地上传、无 IndexedDB 文档缓存。
**覆盖**：在线解析 / 高清渲染 / 批注 / 签章 / 大文件优化 / 白屏卡顿 OOM。
**依赖**：`pdfjs-dist` + `pdf-lib`（仅签章烧录用）+ `idb`（仅批注用）+ `zustand`。

---

## 0. 在线场景的特殊前提

只有远程 URL，意味着我们能把所有"重活"交给 HTTP Range Request：
- pdfjs 自己 chunk 化加载，**不需要**把整份 PDF 读进 JS 内存
- 大文件 OOM 风险大幅降低，但**强依赖服务器配置**
- 服务器侧必须满足三件事，否则全部退化：

```
Accept-Ranges: bytes              ← 必须
Transfer-Encoding ≠ chunked       ← 与 Range 冲突，不能开
Content-Encoding ≠ gzip/br        ← 压缩流没有稳定字节边界，不能开
```

API 中转场景（如 `/api/pdf/[id]`）最稳的做法是 **302 redirect 到底层 OSS / CDN URL**，让 CDN 直接面对客户端，绕开 Node 中转层（Node fetch + stream + Range 解析容易出错）。

服务端入库时统一用 `qpdf --linearize` 处理一遍，让 pdfjs 走 Linear Mode，首屏延迟最低。

---

## 1. Worker 单例（防白屏第一步）

```ts
// lib/pdf/worker.ts
import * as pdfjs from 'pdfjs-dist'

let initialized = false
export function ensureWorker() {
  if (initialized || typeof window === 'undefined') return
  pdfjs.GlobalWorkerOptions.workerPort = new Worker(
    new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url),
    { type: 'module' },
  )
  initialized = true
}
```

**为什么 `import.meta.url`**：让 Webpack/Turbopack 把 worker 文件自动产出到正确路径，免手动 copy 到 `public/`，版本升级不会忘换。

**为什么需要 SSR 守卫**：Next.js 的 SSR 阶段没有 `Worker`/`window`，必须延迟到客户端。

---

## 2. 在线解析（防 OOM 关键）

```ts
// lib/pdf/loader.ts
import * as pdfjs from 'pdfjs-dist'

export function loadPdfFromUrl(url: string) {
  return pdfjs.getDocument({
    url,
    rangeChunkSize: 65536,    // 64KB / chunk
    disableRange: false,      // 必开
    disableStream: false,     // 必开
    disableAutoFetch: true,   // 关掉"后台预取" — 否则 pdfjs 会偷偷下载整个文档
  }).promise
}
```

**核心一行：`disableAutoFetch: true`**
默认情况下 pdfjs 渲染完首页后会**在后台慢慢把剩余字节也下载下来**。对一本 500MB 的书来说，这等于浪费 495MB 流量、几分钟后内存还是爆。关掉后只在用户翻到目标页时按需 Range。

**坑**：用户拖动滚动条快速翻页时会触发大量 Range 请求，可加请求合并 / debounce。

---

## 3. 路由壳：防白屏

```tsx
// app/.../page.tsx
import dynamic from 'next/dynamic'

const PdfWorkspace = dynamic(() => import('@/components/pdf/PdfWorkspace'), {
  ssr: false,
  loading: () => <div className="h-screen animate-pulse bg-muted/40" />,
})

export default function Page() {
  return <PdfWorkspace />
}
```

**为什么 `ssr: false`**：pdfjs 调 `Worker`/`window`，被打进 server bundle 必报 `window is not defined`。

**为什么有 loading 占位**：dynamic chunk 加载有几百毫秒延迟，无 fallback 就是空白屏。

---

## 4. HD 渲染（解决文字糊）

```ts
// lib/pdf/render.ts
import type { PDFPageProxy, RenderTask } from 'pdfjs-dist'

export function renderHD(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  zoom: number,
): RenderTask {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)  // 上限 2，防 4K OOM
  const viewport = page.getViewport({ scale: zoom * dpr })

  canvas.width  = viewport.width
  canvas.height = viewport.height
  canvas.style.width  = viewport.width  / dpr + 'px'
  canvas.style.height = viewport.height / dpr + 'px'

  return page.render({ canvasContext: canvas.getContext('2d')!, viewport })
}
```

**为什么 dpr 封顶 2**：dpr=3 时单页像素数是普通屏 9 倍，1000 页 PDF 即使虚拟化也容易 OOM；视觉上 dpr=2 已无法肉眼分辨。

---

## 5. 单页组件（HD + 内存回收 + 文本层）

```tsx
// components/pdf/PdfPage.tsx
'use client'
import { memo, useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask, PageViewport } from 'pdfjs-dist'
import { renderHD } from '@/lib/pdf/render'

export const PdfPage = memo(function PdfPage(props: {
  pdf: PDFDocumentProxy
  pageNumber: number
  zoom: number
}) {
  const { pdf, pageNumber, zoom } = props
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const [vp, setVp] = useState<PageViewport | null>(null)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    let cancelled = false
    let task: RenderTask | null = null
    let pageProxy: PDFPageProxy | null = null

    ;(async () => {
      try {
        const page = await pdf.getPage(pageNumber)
        if (cancelled) { page.cleanup(); return }
        pageProxy = page

        const screenVp = page.getViewport({ scale: zoom })
        setVp(screenVp)

        task = renderHD(page, canvasRef.current!, zoom)
        await task.promise

        const textContent = await page.getTextContent()
        if (cancelled) return
        textLayerRef.current!.innerHTML = ''
        await pdfjs.renderTextLayer({
          textContentSource: textContent,
          container: textLayerRef.current!,
          viewport: screenVp,
        }).promise
      } catch (e) {
        if (!cancelled && (e as Error).name !== 'RenderingCancelledException') {
          setError(e as Error)
        }
      }
    })()

    return () => {
      cancelled = true
      task?.cancel()                                  // 1. 终止后台渲染
      pageProxy?.cleanup()                            // 2. 释放 pdfjs 内部缓存
      const c = canvasRef.current
      if (c) { c.width = 0; c.height = 0 }            // 3. 强制回收 canvas 像素（关键）
      if (textLayerRef.current) textLayerRef.current.innerHTML = ''
    }
  }, [pdf, pageNumber, zoom])

  if (error) return <button onClick={() => setError(null)}>渲染失败，点击重试</button>

  return (
    <div className="relative" style={{ width: vp?.width, height: vp?.height }}>
      <canvas ref={canvasRef} className="absolute inset-0" />
      <div ref={textLayerRef} className="textLayer absolute inset-0" />
      {vp && <AnnotationLayer pageNumber={pageNumber} viewport={vp} />}
    </div>
  )
})
```

**回收三件套缺一不可**：
- `task.cancel()` — 漏了：已卸载的 canvas 仍被 worker 写入，报错 + 内存泄漏
- `page.cleanup()` — 漏了：翻完 PDF 后 heap 不下降
- `canvas.width = 0` — 漏了：仅 `removeChild` 不释放 GPU 显存

文本层 CSS（不放就没法选文字）：

```css
.textLayer { position: absolute; inset: 0; overflow: hidden; opacity: .25; line-height: 1; user-select: text; }
.textLayer > span { position: absolute; white-space: pre; transform-origin: 0% 0%; color: transparent; }
.textLayer ::selection { background: rgba(0, 100, 255, .3); }
```

---

## 6. 虚拟滚动（解决卡顿）

```tsx
// components/pdf/PdfViewer.tsx
'use client'
import { useEffect, useMemo, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { PdfPage } from './PdfPage'

export function PdfViewer({ pdf, zoom }: { pdf: PDFDocumentProxy; zoom: number }) {
  const [meta, setMeta] = useState<{ n: number; w: number; h: number }[]>([])
  const [visible, setVisible] = useState<Set<number>>(new Set())

  // 启动只读元信息（每页 width/height）
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const arr = await Promise.all(
        Array.from({ length: pdf.numPages }, async (_, i) => {
          const p = await pdf.getPage(i + 1)
          const v = p.getViewport({ scale: 1 })
          p.cleanup()
          return { n: i + 1, w: v.width, h: v.height }
        }),
      )
      if (!cancelled) setMeta(arr)
    })()
    return () => { cancelled = true }
  }, [pdf])

  // IntersectionObserver
  useEffect(() => {
    if (!meta.length) return
    const io = new IntersectionObserver(
      entries => {
        setVisible(prev => {
          const next = new Set(prev)
          for (const e of entries) {
            const n = Number((e.target as HTMLElement).dataset.page)
            e.isIntersecting ? next.add(n) : next.delete(n)
          }
          return next
        })
      },
      { rootMargin: '200px 0px' },  // 提前 200px 触发，减少滚动黑屏
    )
    document.querySelectorAll('[data-page]').forEach(el => io.observe(el))
    return () => io.disconnect()
  }, [meta])

  // 缓冲窗口：可视区 ±1 渲染，>±3 卸载（中间作为滑动缓冲）
  const renderSet = useMemo(() => {
    const s = new Set<number>()
    for (const v of visible) {
      for (let i = -3; i <= 3; i++) s.add(v + i)
    }
    return s
  }, [visible])

  return (
    <div className="overflow-auto">
      {meta.map(m => (
        <div key={m.n} data-page={m.n} style={{ height: m.h * zoom, width: m.w * zoom }}>
          {renderSet.has(m.n) && <PdfPage pdf={pdf} pageNumber={m.n} zoom={zoom} />}
        </div>
      ))}
    </div>
  )
}
```

**为什么"先量尺寸再放占位"**：占位高度精确 = 滚动条不抖；高度错了用户拖动到末页会一直跳。

**为什么 ±1 渲染、±3 才卸载**：留 2 页缓冲，避免快速滚动反复 mount/unmount 导致雪崩。

---

## 7. 批注层（SVG，含 8 类工具）

```tsx
// components/pdf/annotations/AnnotationLayer.tsx
'use client'
export function AnnotationLayer(props: {
  pageNumber: number
  viewport: PageViewport       // 含 width / height（屏幕坐标系，未含 dpr）
}) {
  const { pageNumber, viewport } = props
  const tool = usePdfStore(s => s.tool)
  const annotations = useAnnotations(pageNumber)   // 从 IndexedDB 读，缓存到 Zustand
  const pdfWidth = viewport.viewBox[2]
  const pdfHeight = viewport.viewBox[3]

  return (
    <svg
      viewBox={`0 0 ${pdfWidth} ${pdfHeight}`}
      className="absolute inset-0 size-full"
      style={{ pointerEvents: tool === 'select' ? 'none' : 'auto' }}
    >
      {annotations.map(a => <AnnotationItem key={a.id} a={a} />)}
      {tool === 'pen'    && <PenTool   pageNumber={pageNumber} viewport={viewport} />}
      {tool === 'rect'   && <ShapeTool pageNumber={pageNumber} viewport={viewport} kind="rect" />}
      {tool === 'stamp'  && <StampTool pageNumber={pageNumber} viewport={viewport} />}
      {/* ... 其它工具 */}
    </svg>
  )
}
```

**为什么 viewBox 用 PDF 原始尺寸**：批注数据全部以 PDF 坐标存库，zoom 改变只动外层 CSS 不动数据 → 批注永远不漂移。

**8 类工具的差异都集中在数据收集 / 渲染分支**，框架共享。

### 7.1 数据结构（一份覆盖所有工具）

```ts
type Annotation = {
  id: string; documentId: string; pageNumber: number
  type: 'highlight' | 'underline' | 'strikethrough' | 'rect' | 'ellipse' | 'arrow' | 'pen' | 'note' | 'stamp'
  color: string
  strokeWidth?: number
  rects?:  { x: number; y: number; w: number; h: number }[]   // highlight/underline/strike
  shape?:  { x: number; y: number; w: number; h: number }     // rect/ellipse/arrow（两点包围盒）
  points?: { x: number; y: number }[]                         // pen
  note?:   { x: number; y: number; text: string }
  stamp?:  { x: number; y: number; w: number; h: number; rotation: number; assetId: string }
  createdAt: number; updatedAt: number
}
```

### 7.2 高亮/下划线/删除线（依赖 textLayer）

```ts
function commitTextDecoration(tool: 'highlight'|'underline'|'strike', viewport: PageViewport) {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const rects: Annotation['rects'] = []
  const range = sel.getRangeAt(0)
  for (const r of Array.from(range.getClientRects())) {
    // 屏幕 → PDF 坐标
    const [x1, y1] = viewport.convertToPdfPoint(r.left, r.top)
    const [x2, y2] = viewport.convertToPdfPoint(r.right, r.bottom)
    rects.push({ x: Math.min(x1,x2), y: Math.min(y1,y2), w: Math.abs(x2-x1), h: Math.abs(y2-y1) })
  }
  saveAnnotation({ type: tool, rects, /* ... */ })
  sel.removeAllRanges()
}
```

### 7.3 自由手绘（最易卡顿，节流是核心）

```tsx
function PenTool({ viewport, pageNumber }: Props) {
  const pointsRef = useRef<Point[]>([])
  const rafRef = useRef<number>()
  const [preview, setPreview] = useState('')

  function onPointerMove(e: React.PointerEvent) {
    const [x, y] = viewport.convertToPdfPoint(e.nativeEvent.offsetX, e.nativeEvent.offsetY)
    pointsRef.current.push({ x, y })
    if (rafRef.current) return                       // 已排队就跳过
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = undefined
      setPreview(toSmoothPath(pointsRef.current))    // 仅本地预览，不写库
    })
  }

  function onPointerUp() {
    const simplified = simplify(pointsRef.current, 1.5)   // RDP 简化点数
    saveAnnotation({ type: 'pen', points: simplified, pageNumber, /* ... */ })
    pointsRef.current = []; setPreview('')
  }

  return (
    <g onPointerDown={...} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      <rect width="100%" height="100%" fill="transparent" />
      {preview && <path d={preview} stroke="..." fill="none" />}
    </g>
  )
}
```

**两个关键**：
- `requestAnimationFrame` 合并 pointermove，避免 60+ 次/秒 重渲染
- mousemove 期间**绝不写库**，release 时一次写入

平滑算法（一次性放在 utils）：

```ts
// Catmull-Rom → SVG path
export function toSmoothPath(pts: Point[]): string {
  if (pts.length < 2) return ''
  if (pts.length === 2) return `M${pts[0].x} ${pts[0].y} L${pts[1].x} ${pts[1].y}`
  let d = `M${pts[0].x} ${pts[0].y}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i-1] ?? pts[i], p1 = pts[i], p2 = pts[i+1], p3 = pts[i+2] ?? pts[i+1]
    const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6
    d += ` C${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`
  }
  return d
}

// Ramer-Douglas-Peucker 简化（去冗余共线点）
export function simplify(pts: Point[], tol = 1.5): Point[] {
  if (pts.length < 3) return pts
  const sqTol = tol * tol
  const marked = new Array(pts.length).fill(false)
  marked[0] = marked[pts.length - 1] = true
  function step(s: number, e: number) {
    let max = 0, idx = 0
    for (let i = s + 1; i < e; i++) {
      const d = sqSegDist(pts[i], pts[s], pts[e])
      if (d > max) { idx = i; max = d }
    }
    if (max > sqTol) {
      marked[idx] = true
      if (idx - s > 1) step(s, idx)
      if (e - idx > 1) step(idx, e)
    }
  }
  step(0, pts.length - 1)
  return pts.filter((_, i) => marked[i])
}
function sqSegDist(p: Point, a: Point, b: Point) {
  let x = a.x, y = a.y, dx = b.x - x, dy = b.y - y
  if (dx || dy) {
    const t = ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy)
    if (t > 1) { x = b.x; y = b.y } else if (t > 0) { x += dx * t; y += dy * t }
  }
  dx = p.x - x; dy = p.y - y
  return dx * dx + dy * dy
}
```

### 7.4 批注持久化（IndexedDB）

```ts
// lib/db/annotations.ts
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

interface AnnoDB extends DBSchema {
  annotations: {
    key: string
    value: Annotation
    indexes: { 'by-doc-page': [string, number] }
  }
}

let dbP: Promise<IDBPDatabase<AnnoDB>> | null = null
function db() {
  if (!dbP) dbP = openDB<AnnoDB>('pdf-anno', 1, {
    upgrade(d) {
      const s = d.createObjectStore('annotations', { keyPath: 'id' })
      s.createIndex('by-doc-page', ['documentId', 'pageNumber'])
    },
  })
  return dbP
}

export const listAnnotations = async (docId: string, page: number) =>
  (await db()).getAllFromIndex('annotations', 'by-doc-page', [docId, page])
export const upsertAnnotation = async (a: Annotation) => (await db()).put('annotations', a)
export const deleteAnnotation = async (id: string) => (await db()).delete('annotations', id)
```

`documentId` 用 URL 的 hash 即可，跨会话稳定：

```ts
async function urlToDocId(url: string) {
  const buf = new TextEncoder().encode(url)
  const hash = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}
```

---

## 8. 签章

### 8.1 视觉印章 = 一种特殊批注

复用 §7 的批注层，新增 `type: 'stamp'`，渲染：

```tsx
function StampAnnotation({ a }: { a: Annotation }) {
  if (!a.stamp) return null
  const { x, y, w, h, rotation, assetId } = a.stamp
  const dataUrl = useStampAsset(assetId)            // 从 stamps store 取
  return (
    <image
      href={dataUrl}
      x={x} y={y} width={w} height={h}
      transform={`rotate(${rotation}, ${x + w/2}, ${y + h/2})`}
    />
  )
}
```

**为什么用 SVG `<image>` 不用 `<img>`**：跟随 SVG viewBox 缩放、复用现有 transform handles 和事件层、zoom 不漂移。

印章资产单独存（与批注 store 分开）：

```ts
// lib/db/stamps.ts
interface StampDB extends DBSchema {
  stamps: {
    key: string
    value: { id: string; name: string; dataUrl: string; createdAt: number }
  }
}
```

**为什么单独存**：印章是"用户资产库"跨文档复用，批注是"文档实例"。一个印章能在 N 个文档盖 N 次，模型上是 1 对 N。

手写签名工具：弹模态，canvas 里用 §7.3 的 `simplify + toSmoothPath` 收集笔迹，结束后 `canvas.toBlob()` 转 PNG dataUrl 入库。

### 8.2 烧录到 PDF（导出真盖章版本）

视觉印章只在前端渲染层，原 PDF 字节不变。要把"盖章版"发给别人就得真改字节，用 `pdf-lib`（与 pdfjs 分工：pdfjs 读，pdf-lib 写）。

**关键：pdf-lib 跑在 Web Worker，避免主线程卡几秒到十几秒**

```ts
// lib/pdf/burn.worker.ts
import { PDFDocument } from 'pdf-lib'

self.onmessage = async (e: MessageEvent<{ url: string; annotations: Annotation[] }>) => {
  const { url, annotations } = e.data

  // 拉一份完整字节（与 pdfjs 的 chunked 流独立；这里就是要全字节才能改）
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer())
  const doc = await PDFDocument.load(bytes)

  // 按页分组
  const byPage = new Map<number, Annotation[]>()
  for (const a of annotations) {
    const arr = byPage.get(a.pageNumber) ?? []
    arr.push(a); byPage.set(a.pageNumber, arr)
  }

  for (const [pageNum, list] of byPage) {
    const page = doc.getPage(pageNum - 1)
    const { width, height } = page.getSize()  // PDF 单位

    for (const a of list) {
      if (a.type === 'stamp' && a.stamp) {
        const png = await doc.embedPng(await fetch(a.stamp.assetUrl).then(r => r.arrayBuffer()))
        // PDF 坐标系原点左下，y 要翻
        page.drawImage(png, {
          x: a.stamp.x,
          y: height - a.stamp.y - a.stamp.h,
          width: a.stamp.w,
          height: a.stamp.h,
          rotate: { type: 'degrees', angle: -a.stamp.rotation },
        })
      }
      // ... 其它批注 type 类似
    }
  }

  const out = await doc.save()
  self.postMessage(out, [out.buffer])         // transferable，零拷贝回主线程
}
```

主线程调用：

```ts
const w = new Worker(new URL('./burn.worker.ts', import.meta.url), { type: 'module' })
w.postMessage({ url, annotations })
w.onmessage = (e: MessageEvent<Uint8Array>) => {
  const blob = new Blob([e.data], { type: 'application/pdf' })
  saveAs(blob, 'signed.pdf')
}
```

**几个关键点**：
- 烧录必须**全量下载**（不能用 Range 拼），因为 pdf-lib 要解析整个文档结构
- worker 化避免 100MB+ PDF 烧录时主线程卡死
- y 坐标要翻（PDF 原点左下 vs SVG 原点左上）
- `postMessage` 用 transferable 避免大字节流复制

### 8.3 PKCS#7 数字签名

不要自研，接 e签宝 / DocuSign 等服务商。自研需要：CA 证书 + USB Key 或后端 HSM + byte range hash + PKCS#7 签名值注入 + TSA 时间戳 + LTV 长期归档 + 跨阅读器兼容性测试，工作量是前两者总和的 5~10 倍，仅在合同 / 政务 / 金融场景才值得。

---

## 9. Zustand 状态（偏好持久化）

```ts
// lib/pdf-store.ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type Tool = 'select'|'highlight'|'underline'|'strike'|'rect'|'ellipse'|'arrow'|'pen'|'note'|'stamp'

export const usePdfStore = create<{
  zoom: number; tool: Tool; color: string; strokeWidth: number; activeStampId: string | null
  setZoom: (z: number) => void
  setTool: (t: Tool) => void
  setColor: (c: string) => void
  setStrokeWidth: (n: number) => void
  setActiveStamp: (id: string | null) => void
}>()(
  persist(
    (set) => ({
      zoom: 1.2, tool: 'select', color: '#facc15', strokeWidth: 2, activeStampId: null,
      setZoom: z => set({ zoom: Math.min(Math.max(z, 0.3), 4) }),
      setTool: t => set({ tool: t }),
      setColor: c => set({ color: c }),
      setStrokeWidth: n => set({ strokeWidth: Math.min(Math.max(n, 1), 12) }),
      setActiveStamp: id => set({ activeStampId: id }),
    }),
    { name: 'pdf-store' },     // 全 persist：偏好都该跨会话留存
  ),
)
```

---

## 10. 服务端 checklist

| 项 | 必须 | 备注 |
|---|---|---|
| `Accept-Ranges: bytes` | ✓ | 不响应就退化为全量下载 |
| 不开 `Transfer-Encoding: chunked` | ✓ | 与 Range 不兼容 |
| 不开 `Content-Encoding: gzip/br` | ✓ | 压缩流没有稳定字节边界 |
| `Content-Length` 正确 | ✓ | pdfjs 需要它定位文件末尾 |
| CORS：`Access-Control-Allow-Origin` + `Access-Control-Expose-Headers: Accept-Ranges, Content-Encoding, Content-Length` | ✓ | 跨域时缺一不可 |
| 入库时 `qpdf --linearize` | 推荐 | 启用 Fast Web View，首屏更快 |
| 走 CDN 而非 Node 中转 | 推荐 | API 中转用 302 redirect 让 CDN 直面客户端 |

---

## 11. 速查：白屏 / 卡顿 / OOM 出处与对策

| 症状 | 出处 | 对策位置 |
|---|---|---|
| 白屏几秒 | pdfjs bundle / worker 加载 | §3 路由壳 + Skeleton |
| SSR 报 `window is not defined` | pdfjs 在 server bundle | §3 `dynamic({ ssr: false })` |
| 翻页卡顿 | 全量渲染 canvas | §6 IntersectionObserver 虚拟化 |
| 翻完书内存不释放 | canvas / pdfjs 缓存 | §5 回收三件套（`cancel`/`cleanup`/`width=0`） |
| 后台流量持续上涨 | pdfjs 预取整份 PDF | §2 `disableAutoFetch: true` |
| 4K 屏 OOM | dpr=3 像素数翻倍 | §4 dpr 封顶 2 |
| 文字糊 | canvas 用了屏幕 px | §4 `canvas.width = viewport * dpr` |
| 手绘卡顿 | mousemove 高频写库 | §7.3 RAF 节流 + 仅 release 写库 |
| 批注 zoom 后漂移 | 存了屏幕坐标 | §7 viewBox 用 PDF 坐标系，存库永远是 PDF 坐标 |
| 烧录大 PDF 时页面卡死 | pdf-lib 在主线程 | §8.2 Web Worker |
| Range 不生效 / 全量下载 | 服务器配置 | §10 服务端 checklist |

---

## 12. 后端同步模式（生产推荐）

把批注 / 签章从"纯前端 IndexedDB"升级为"后端为权威源 + IDB 仅作缓存"。烧录也从浏览器 pdf-lib 改为后端 Job。

**为什么要换**

- **跨设备同步**：手机标记 → 桌面打开看得到
- **用户数据归属**：批注归属 user_id，便于审计、清理、数据出境合规
- **烧录大文件不再阻塞浏览器**：100MB+ PDF 烧录可能几十秒，搬到后端 + 异步 Job
- **协作 / 审计基础**：未来要做"评审分享给同事"、"记录谁在何时盖了什么章"必须有后端存证

### 12.1 数据流总览

```
┌──────────────────────────────────────┐
│  浏览器                              │
│  ┌────────────┐   ┌───────────────┐  │
│  │ Annotation │──>│ IDB 本地缓存  │  │
│  │   UI       │<──│ + Outbox 队列 │  │
│  └────────────┘   └────┬──────────┘  │
└────────────────────────┼─────────────┘
                         │ 写直达 + 背景推
                         ↓
┌──────────────────────────────────────┐
│  后端 API                            │
│  /annotations  /stamps  /burn        │
└─────────┬─────────────┬──────────────┘
          ↓             ↓
   ┌────────────┐  ┌────────────┐
   │ Postgres   │  │ Job Queue  │
   │ + S3/OSS   │  │ (烧录异步) │
   └────────────┘  └────────────┘
```

### 12.2 后端 schema

```sql
create table annotations (
  id            text primary key,
  user_id       text not null,
  document_id   text not null,
  page_number   int  not null,
  type          text not null,
  data          jsonb not null,      -- rects/shape/points/note/stamp 整体存这里
  color         text,
  stroke_width  int,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  deleted_at    timestamptz          -- 软删，给增量同步当"删除信号"
);
create index on annotations (user_id, document_id, page_number);
create index on annotations (user_id, document_id, updated_at);

create table stamps (
  id         text primary key,
  user_id    text not null,
  name       text not null,
  asset_url  text not null,          -- 印章图放对象存储，DB 只存 URL
  created_at timestamptz default now()
);

create table burn_jobs (
  id          text primary key,
  user_id     text not null,
  document_id text not null,
  status      text not null,         -- pending / running / done / failed
  result_url  text,                  -- 完成后的 signed URL
  error       text,
  created_at  timestamptz default now(),
  finished_at timestamptz
);
```

**为什么 `data` 用 jsonb 而不是拆字段**：8 种批注 type 字段差异大（rects / points / shape / note / stamp 互斥），拆字段会有大量 null；jsonb + 应用层校验更灵活，加新 type 不动 schema。

**为什么需要 `deleted_at` 软删**：增量同步要让客户端知道"哪些被删了"，硬删会让其它设备永远拉不到删除信号。后端可设定期 vacuum，比如 30 天后真删。

### 12.3 REST 接口

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/pdf/{docId}/annotations?since={ts}` | 增量拉，返回 since 之后的所有变更（含已 deleted 的） |
| POST | `/api/pdf/{docId}/annotations` | 批量 upsert（body: `Annotation[]`），LWW 冲突 |
| DELETE | `/api/pdf/{docId}/annotations/{id}` | 软删 |
| GET | `/api/pdf/stamps` | 用户印章库 |
| POST | `/api/pdf/stamps` | 新印章（multipart：图 + 名字） |
| POST | `/api/pdf/{docId}/burn` | 触发烧录，body 可指定批注子集，返回 `{ jobId }` |
| GET | `/api/pdf/jobs/{jobId}` | 轮询 Job 状态，done 时返回 `result_url` |

`since` 用 unix timestamp 即可，不必上 ETag。客户端记 `lastSyncAt`，每次拉完更新。

### 12.4 客户端 Outbox（offline-first 写）

UI 写入立即生效，不等网络；失败入队重试。

```ts
// lib/sync/outbox.ts
type Op =
  | { kind: 'upsert'; entity: 'annotation'; payload: Annotation }
  | { kind: 'delete'; entity: 'annotation'; id: string }

const QUEUE_KEY = 'pdf-outbox'

export async function enqueue(op: Op) {
  const q: Op[] = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]')
  q.push(op); localStorage.setItem(QUEUE_KEY, JSON.stringify(q))
  void flush()
}

let flushing = false
export async function flush() {
  if (flushing || !navigator.onLine) return
  flushing = true
  try {
    let q: Op[] = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]')
    while (q.length) {
      const batch = q.slice(0, 50)
      const ok = await pushBatch(batch)             // POST /annotations
      if (!ok) break                                // 失败保留待下次
      q = q.slice(batch.length)
      localStorage.setItem(QUEUE_KEY, JSON.stringify(q))
    }
  } finally { flushing = false }
}

window.addEventListener('online', flush)
window.addEventListener('focus', flush)
```

业务侧：

```ts
async function saveAnnotation(a: Annotation) {
  await upsertAnnotation(a)                                              // 1. 立即写 IDB → UI 即时
  await enqueue({ kind: 'upsert', entity: 'annotation', payload: a })    // 2. 入 outbox
}
```

**为什么用 outbox 而不是直接 fetch**：直接 fetch 一旦失败就丢了；outbox 把"业务操作"和"网络可达性"解耦，断网时自动累积，恢复时自动 flush，UI 永远不卡。

### 12.5 增量拉取

```ts
async function syncPull(docId: string) {
  const since = Number(localStorage.getItem(`lastSync:${docId}`) ?? 0)
  const changes: Annotation[] = await fetch(
    `/api/pdf/${docId}/annotations?since=${since}`,
  ).then(r => r.json())

  for (const a of changes) {
    if (a.deletedAt) await deleteAnnotationLocal(a.id)
    else             await upsertAnnotationLocal(a)
  }
  localStorage.setItem(`lastSync:${docId}`, String(Date.now()))
}
```

**触发时机**：
- 文档打开时
- `visibilitychange` → visible
- `focus`
- 协作场景：服务端 SSE 推 `annotation-changed` → 触发拉取

**为什么不双向 diff / CRDT**：个人场景批注是离散的"加改删"事件，LWW + 软删足够。真要做多人实时协作再上 Yjs / Automerge。

### 12.6 冲突处理（LWW）

服务端 upsert 时比较 `updated_at`：

```sql
insert into annotations (id, user_id, document_id, page_number, type, data, updated_at, deleted_at)
values ($1, $2, $3, $4, $5, $6, $7, $8)
on conflict (id) do update set
  data       = excluded.data,
  updated_at = excluded.updated_at,
  deleted_at = excluded.deleted_at
where annotations.updated_at < excluded.updated_at;        -- 旧的不覆盖新的
```

### 12.7 后端烧录

```
客户端              API                Worker            Storage
  │                  │                   │                 │
  ├─ POST /burn ────>│                  │                 │
  │                  ├─ insert job ────>│                  │
  │<─ {jobId} ───────┤                   │                 │
  │                  │                   ├─ 加载原 PDF ───>│
  │                  │                   ├─ 加载批注       │
  │                  │                   ├─ pdf-lib 烧录   │
  │                  │                   ├─ 上传结果 ─────>│
  │                  │                   ├─ update job     │
  │                  │                   │  done + url     │
  ├─ GET /jobs/X ───>│                  │                 │
  │<─ {done, url} ───┤                   │                 │
  ├─ 浏览器下载 ─────────────────────────────────────────>│
```

**Worker 关键代码（Node + pdf-lib）**：

```ts
// server/burn-worker.ts
import { PDFDocument } from 'pdf-lib'

export async function runBurnJob(job: BurnJob) {
  await db.updateJob(job.id, { status: 'running' })
  try {
    const pdfBytes = await fetchPdfBytes(job.documentId)         // 内网拉源 PDF，不走公网
    const list = await db.query(
      `select * from annotations
       where document_id = $1 and user_id = $2 and deleted_at is null`,
      [job.documentId, job.userId],
    )

    const doc = await PDFDocument.load(pdfBytes)
    const stampCache = new Map<string, any>()

    for (const a of list) {
      const page = doc.getPage(a.page_number - 1)
      const { height } = page.getSize()
      const d = a.data

      if (a.type === 'stamp') {
        let img = stampCache.get(d.assetId)
        if (!img) {
          img = await doc.embedPng(await fetchStampBytes(d.assetId))
          stampCache.set(d.assetId, img)
        }
        page.drawImage(img, {
          x: d.x,
          y: height - d.y - d.h,                                 // PDF 原点左下，y 翻
          width: d.w, height: d.h,
          rotate: { type: 'degrees', angle: -d.rotation },
        })
      }
      // ... 其它 type 类似
    }

    const out = await doc.save()
    const url = await uploadToOss(`burned/${job.id}.pdf`, out)   // 返 signed URL
    await db.updateJob(job.id, {
      status: 'done', result_url: url, finished_at: new Date(),
    })
  } catch (e) {
    await db.updateJob(job.id, {
      status: 'failed', error: String(e), finished_at: new Date(),
    })
  }
}
```

**客户端轮询**：

```ts
async function startBurn(docId: string) {
  const { jobId } = await fetch(`/api/pdf/${docId}/burn`, { method: 'POST' })
    .then(r => r.json())
  for (;;) {
    await new Promise(r => setTimeout(r, 1500))
    const job = await fetch(`/api/pdf/jobs/${jobId}`).then(r => r.json())
    if (job.status === 'done')   { location.href = job.result_url; return }
    if (job.status === 'failed') throw new Error(job.error)
  }
}
```

**几个关键决策**：

| 选择 | 推荐 | 为什么 |
|---|---|---|
| Job 队列 | BullMQ / Sidekiq / SQS | 重试、超时、并发限制、死信队列开箱即用，自己写状态机难维护 |
| 烧录库（Node） | `pdf-lib` | 与浏览器侧同库，业务代码可共享 |
| 烧录库（Java） | Apache PDFBox | JVM 性能强，企业生态成熟 |
| 烧录库（Python） | PyMuPDF (`fitz`) | 最快，C 实现，复杂图形支持好 |
| CLI 兜底 | `qpdf` / `pdftk` | 极简任务（合并 / 加水印）走 shell 比库还稳 |
| 进度通知 | 轮询 1.5s | 简单可靠；除非烧录普遍 > 30s 才考虑 SSE |
| 结果存储 | OSS + signed URL（5min 过期） | 不走 API 中转省带宽；过期 URL 防外泄 |
| 缓存命中 | key = `hash(docId + sorted(annoIds) + annoVersion)` | 同一份批注集再次烧录直接返历史 result_url |

### 12.8 鉴权与隔离

- 所有 API 要求登录 session / JWT
- `annotations` / `stamps` / `burn_jobs` 全部按 `user_id` 隔离，每个查询都带 `where user_id = $current`
- 协作 / 团队场景再加一层 `team_id` 和 ACL（本期不展开）
- 烧录 Worker 取 PDF 字节走内网，不暴露 PDF 源 URL 给前端

### 12.9 与单机版的对比（supersede）

| 单机版（§7.4 / §8.2） | 后端同步版（§12） |
|---|---|
| IndexedDB 是权威源 | 后端是权威源，IDB 退化为缓存 |
| 浏览器 pdf-lib + Web Worker 烧录 | 后端 Job 队列烧录 |
| 无登录 | 必须登录 |
| 数据仅本设备可见 | 跨设备同步 |
| 烧录时主线程压力大 | 浏览器零负担 |

**§7.4 / §8.2 不删，仍有用**：
- IDB 作为 outbox 的持久化媒介（断电重开 outbox 不丢）
- IDB 作为离线时的读缓存（地铁 / 飞机仍能查看 / 标记，online 时自动 flush）
- 演示 / 隐私模式（用户不想数据上云）可降级到纯本地

也就是说后端版**不是替换**，而是**叠加在本地版之上**：IDB 永远是用户的"第一现场"，后端是"权威账本"。
