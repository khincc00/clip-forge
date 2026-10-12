const form = document.querySelector('form')
const keyInput = document.querySelector('#apiKey')
const modelSelect = document.querySelector('#model')
const keyState = document.querySelector('#keyState')
const clearButton = document.querySelector('#clear')
const status = document.querySelector('#status')

function render({ hasKey, model }) {
  modelSelect.value = model
  keyState.textContent = hasKey
    ? 'Key tersimpan dan terenkripsi. Kosongkan kolom jika hanya ingin mengganti model.'
    : 'Belum ada API key.'
  clearButton.hidden = !hasKey
}

function show(message, isError = false) {
  status.textContent = message
  status.className = isError ? 'error' : 'ok'
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  try {
    const result = await window.clipforgeSettings.save({ apiKey: keyInput.value, model: modelSelect.value })
    keyInput.value = ''
    render(result)
    show('Pengaturan disimpan.')
  } catch (error) {
    show(error.message, true)
  }
})

clearButton.addEventListener('click', async () => {
  if (!confirm('Hapus API key yang tersimpan?')) return
  try {
    const result = await window.clipforgeSettings.save({ model: modelSelect.value, clearKey: true })
    render(result)
    show('API key dihapus. ClipForge kembali memakai penilaian lokal.')
  } catch (error) {
    show(error.message, true)
  }
})

window.clipforgeSettings.get().then(render).catch((error) => show(error.message, true))
