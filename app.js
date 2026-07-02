const cameraButton = document.getElementById('cameraButton')
const themeButton = document.getElementById('themeButton')
const cameraPreview = document.getElementById('cameraPreview')
const captureCanvas = document.getElementById('captureCanvas')
const previewPlaceholder = document.getElementById('previewPlaceholder')
const logOutput = document.getElementById('logOutput')
const statusText = document.getElementById('statusText')

let cameraStream = null
let captureTimer = null
let captureCount = 0
let isUploading = false

function pad(value, length = 2) {
  return String(value).padStart(length, '0')
}

function nowLabel() {
  const now = new Date()
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

function addLog(message, data) {
  const details = data ? ` ${JSON.stringify(data)}` : ''
  logOutput.textContent = `[${nowLabel()}] ${message}${details}\n${logOutput.textContent}`
}

function setStatus(value) {
  statusText.textContent = value
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme
  localStorage.setItem('theme', theme)
}

function getInitialTheme() {
  const savedTheme = localStorage.getItem('theme')
  if (savedTheme) return savedTheme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function canvasToJpegBase64(canvas) {
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9)
  return dataUrl.split(',')[1] || ''
}

async function uploadImage({ filename, imageBase64 }) {
  const response = await fetch('/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      filename,
      mimeType: 'image/jpeg',
      imageBase64
    })
  })

  return response.json()
}

async function captureAndSave() {
  if (!cameraStream || isUploading) return

  const width = cameraPreview.videoWidth
  const height = cameraPreview.videoHeight
  if (!width || !height) {
    addLog('Waiting for camera frame.')
    return
  }

  isUploading = true
  captureCanvas.width = width
  captureCanvas.height = height
  captureCanvas.getContext('2d').drawImage(cameraPreview, 0, 0, width, height)

  const filename = `capture-${Date.now()}.jpg`
  const imageBase64 = canvasToJpegBase64(captureCanvas)

  try {
    const data = await uploadImage({ filename, imageBase64 })
    captureCount += 1
    setStatus(`${captureCount} saved`)
    addLog('Saved frame.', {
      filename: data.filename,
      bytes: data.bytes
    })
  } catch (error) {
    setStatus('Error')
    addLog('Save failed.', {
      error: error.message
    })
  } finally {
    isUploading = false
  }
}

function startCaptureLoop() {
  window.clearInterval(captureTimer)
  captureTimer = window.setInterval(captureAndSave, 1000)
}

cameraButton.addEventListener('click', async () => {
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false
    })
    cameraPreview.srcObject = cameraStream
    previewPlaceholder.hidden = true
    cameraButton.disabled = true
    cameraButton.textContent = 'Running'
    setStatus('Running')
    addLog('Camera started.')
    startCaptureLoop()
  } catch (error) {
    setStatus('Blocked')
    addLog('Camera failed.', {
      error: error.message
    })
  }
})

themeButton.addEventListener('click', () => {
  const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
  applyTheme(nextTheme)
})

applyTheme(getInitialTheme())
addLog('Ready.')
