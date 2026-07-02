const cameraButton = document.getElementById('cameraButton')
const captureButton = document.getElementById('captureButton')
const cameraPreview = document.getElementById('cameraPreview')
const captureCanvas = document.getElementById('captureCanvas')
const imageInput = document.getElementById('imageInput')
const noteInput = document.getElementById('noteInput')
const saveButton = document.getElementById('saveButton')
const result = document.getElementById('result')

let cameraStream = null
let capturedImage = null

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const value = String(reader.result || '')
      resolve(value.split(',')[1] || '')
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function canvasToJpegBase64(canvas) {
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9)
  return dataUrl.split(',')[1] || ''
}

async function uploadImage({ filename, mimeType, imageBase64 }) {
  const response = await fetch('/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      filename,
      mimeType,
      note: noteInput.value,
      imageBase64
    })
  })

  return response.json()
}

cameraButton.addEventListener('click', async () => {
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false
    })
    cameraPreview.srcObject = cameraStream
    captureButton.disabled = false
    result.textContent = 'Camera started.'
  } catch (error) {
    result.textContent = String(error)
  }
})

captureButton.addEventListener('click', () => {
  const context = captureCanvas.getContext('2d')
  captureCanvas.width = cameraPreview.videoWidth || 640
  captureCanvas.height = cameraPreview.videoHeight || 480
  context.drawImage(cameraPreview, 0, 0, captureCanvas.width, captureCanvas.height)

  capturedImage = {
    filename: `capture-${Date.now()}.jpg`,
    mimeType: 'image/jpeg',
    imageBase64: canvasToJpegBase64(captureCanvas)
  }
  imageInput.value = ''
  result.textContent = 'Captured.'
})

imageInput.addEventListener('change', () => {
  if (imageInput.files?.[0]) {
    capturedImage = null
    result.textContent = 'Image selected.'
  }
})

saveButton.addEventListener('click', async () => {
  const file = imageInput.files?.[0]
  if (!file && !capturedImage) {
    result.textContent = 'No image selected.'
    return
  }

  saveButton.disabled = true
  result.textContent = 'Saving...'

  try {
    const payload = capturedImage || {
        filename: file.name,
        mimeType: file.type,
        imageBase64: await readFileAsBase64(file)
      }
    const data = await uploadImage(payload)
    result.textContent = JSON.stringify(data, null, 2)
  } catch (error) {
    result.textContent = String(error)
  } finally {
    saveButton.disabled = false
  }
})
