const imageInput = document.getElementById('imageInput')
const noteInput = document.getElementById('noteInput')
const saveButton = document.getElementById('saveButton')
const result = document.getElementById('result')

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

saveButton.addEventListener('click', async () => {
  const file = imageInput.files?.[0]
  if (!file) {
    result.textContent = 'No image selected.'
    return
  }

  saveButton.disabled = true
  result.textContent = 'Saving...'

  try {
    const imageBase64 = await readFileAsBase64(file)
    const response = await fetch('/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filename: file.name,
        mimeType: file.type,
        note: noteInput.value,
        imageBase64
      })
    })

    const data = await response.json()
    result.textContent = JSON.stringify(data, null, 2)
  } catch (error) {
    result.textContent = String(error)
  } finally {
    saveButton.disabled = false
  }
})
