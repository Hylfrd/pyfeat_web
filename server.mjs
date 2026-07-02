import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const uploadDir = root
const host = process.env.HOST || '127.0.0.1'
const port = Number(process.env.PORT || 8000)

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

function safeFilename(name) {
  const parsed = path.parse(String(name || 'image.jpg'))
  const stem = (parsed.name || 'image').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '') || 'image'
  const ext = (parsed.ext || '.jpg').toLowerCase().replace(/[^a-zA-Z0-9.]+/g, '') || '.jpg'
  return `${stem}${ext}`
}

function timestamp() {
  const now = new Date()
  const pad = (value, length = 2) => String(value).padStart(length, '0')
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    '-',
    pad(now.getMilliseconds(), 3)
  ].join('')
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('error', reject)
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`)
  const requestedPath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)
  const filePath = path.resolve(root, `.${requestedPath}`)

  if (!filePath.startsWith(root + path.sep) || !existsSync(filePath)) {
    res.writeHead(404)
    res.end('Not found')
    return
  }

  const ext = path.extname(filePath).toLowerCase()
  const body = await readFile(filePath)
  res.writeHead(200, {
    'Content-Type': mimeTypes[ext] || 'application/octet-stream',
    'Content-Length': body.length
  })
  res.end(body)
}

async function handleUpload(req, res) {
  try {
    const body = await readRequestBody(req)
    const payload = JSON.parse(body.toString('utf-8'))
    const imageBytes = Buffer.from(String(payload.imageBase64 || ''), 'base64')

    if (!imageBytes.length) {
      sendJson(res, 400, { ok: false, error: 'No image data.' })
      return
    }

    await mkdir(uploadDir, { recursive: true })

    const id = timestamp()
    const originalName = safeFilename(payload.filename)
    const savedName = `upload-${id}-${originalName}`
    const savedPath = path.join(uploadDir, savedName)
    await writeFile(savedPath, imageBytes)

    const note = String(payload.note || '')
    if (note) {
      await writeFile(path.join(uploadDir, `note-${id}.txt`), note, 'utf-8')
    }

    sendJson(res, 200, {
      ok: true,
      filename: savedName,
      bytes: imageBytes.length,
      noteSaved: Boolean(note),
      path: savedPath
    })
  } catch (error) {
    sendJson(res, 400, {
      ok: false,
      error: `Invalid upload: ${error.message}`
    })
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/upload') {
      await handleUpload(req, res)
      return
    }

    if (req.method === 'GET') {
      await serveStatic(req, res)
      return
    }

    res.writeHead(405)
    res.end('Method not allowed')
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error.message
    })
  }
})

await mkdir(uploadDir, { recursive: true })

server.listen(port, host, () => {
  console.log(`Serving http://${host}:${port}`)
  console.log(`Uploads: ${uploadDir}`)
})
