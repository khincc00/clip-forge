const form = document.querySelector('form')
const providerSelect = document.querySelector('#provider')
const keyInput = document.querySelector('#apiKey')
const modelInput = document.querySelector('#model')
const modelOptions = document.querySelector('#modelOptions')
const keyState = document.querySelector('#keyState')
const clearButton = document.querySelector('#clear')
const status = document.querySelector('#status')

let state = null

function currentProvider() {
  return state.providers.find((provider) => provider.id === providerSelect.value)
}

// Menampilkan key dan model untuk penyedia yang sedang dipilih di form.
function renderProvider() {
  const provider = currentProvider()
  keyInput.placeholder = `${provider.prefix}…`
  modelInput.value = state.models[provider.id] || provider.defaultModel
  modelOptions.innerHTML = provider.models.map((model) => `<option value="${model}"></option>`).join('')
  const hasKey = state.hasKey[provider.id]
  keyState.textContent = hasKey
    ? 'Key tersimpan dan terenkripsi. Kosongkan kolom jika hanya ingin mengganti model.'
    : 'Belum ada API key untuk penyedia ini.'
  clearButton.hidden = !hasKey
}

function render(result) {
  state = result
  providerSelect.innerHTML = state.providers.map((provider) => `<option value="${provider.id}">${provider.label}</option>`).join('')
  providerSelect.value = state.provider
  renderProvider()
}

function show(message, isError = false) {
  status.textContent = message
  status.className = isError ? 'error' : 'ok'
}

providerSelect.addEventListener('change', renderProvider)

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  try {
    const result = await window.clipforgeSettings.save({
      provider: providerSelect.value,
      apiKey: keyInput.value,
      model: modelInput.value,
    })
    keyInput.value = ''
    render(result)
    show('Pengaturan disimpan.')
  } catch (error) {
    show(error.message, true)
  }
})

clearButton.addEventListener('click', async () => {
  if (!confirm('Hapus API key yang tersimpan untuk penyedia ini?')) return
  try {
    const result = await window.clipforgeSettings.save({
      provider: providerSelect.value,
      model: modelInput.value,
      clearKey: true,
    })
    render(result)
    show('API key dihapus. Penyedia ini tidak dipakai sampai key baru disimpan.')
  } catch (error) {
    show(error.message, true)
  }
})

window.clipforgeSettings.get().then(render).catch((error) => show(error.message, true))
