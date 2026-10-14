/* AI-assisted customer request editor. The server owns product matching, prices and final totals. */
;(() => {
  if (!UI.shell('requests')) return

  const el = (id) => document.getElementById(id)
  const uploadForm = el('requestUploadForm')
  const fileInput = el('requestFile')
  const dropzone = el('requestDropzone')
  const fileName = el('fileName')
  const analyzeButton = el('analyzeButton')
  const uploadMessage = el('uploadMessage')
  const aiStatus = el('aiStatus')
  const aiStatusTitle = el('aiStatusTitle')
  const aiStatusText = el('aiStatusText')
  const warningsBox = el('requestWarnings')
  const editor = el('requestEditor')
  const customerName = el('customerName')
  const sourceFilename = el('sourceFilename')
  const sourceHashShort = el('sourceHashShort')
  const rowsNode = el('requestItems')
  const globalDiscountNode = el('globalDiscount')
  const saveButton = el('saveRequest')
  const saveMessage = el('saveMessage')
  const catalogNode = el('catalogPrices')
  const historyNode = el('requestHistory')
  const admin = UI.isAdmin()

  const units = { g: 'г', kg: 'кг', ml: 'мл', l: 'л', pcs: 'шт' }
  const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 })
  const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 })
  let catalog = []
  let items = []
  let globalDiscount = 0
  let currentSourceFilename = ''
  let currentSourceHash = ''
  let aiUsed = false
  let duplicateSaved = false

  function message(node, text, isError) {
    UI.setMessage(node, text, Boolean(isError))
  }

  function rubles(kopecks) {
    return money.format((Number(kopecks) || 0) / 100)
  }

  function rawMoney(kopecks) {
    return (Number(kopecks || 0) / 100).toFixed(2)
  }

  function asMoneyInput(kopecks, configured) {
    return configured ? rawMoney(kopecks) : ''
  }

  function productByID(id) {
    return catalog.find((product) => String(product.id) === String(id)) || null
  }

  function quantityValue(value) {
    const parsed = Number(String(value ?? '').replace(',', '.'))
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }

  function discountValue(value) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : 0
  }

  function convertQuantity(quantity, from, to) {
    if (!from || !to || from === to) return quantity
    if (from === 'kg' && to === 'g') return quantity * 1000
    if (from === 'g' && to === 'kg') return quantity / 1000
    if (from === 'l' && to === 'ml') return quantity * 1000
    if (from === 'ml' && to === 'l') return quantity / 1000
    return null
  }

  function setProductCatalog(newCatalog) {
    catalog = Array.isArray(newCatalog) ? newCatalog : []
    renderPrices()
    if (items.length) renderRows()
  }

  async function loadCatalog() {
    try {
      setProductCatalog(await API.get('/products'))
    } catch (error) {
      catalogNode.innerHTML = '<tr><td colspan="4" class="request-error">Не удалось загрузить товары: ' + UI.escapeHtml(error.message) + '</td></tr>'
    }
  }

  function renderWarnings(warnings) {
    const values = Array.isArray(warnings) ? warnings.filter(Boolean) : []
    warningsBox.hidden = values.length === 0
    warningsBox.textContent = values.join(' ')
  }

  function updateAIStatus(title, text, warning) {
    aiStatus.hidden = false
    aiStatusTitle.textContent = title
    aiStatusText.textContent = text
    aiStatus.classList.toggle('is-warning', Boolean(warning))
  }

  function handlePickedFile(file) {
    if (!file) return
    fileName.textContent = file.name
    uploadMessage.textContent = ''
    uploadMessage.className = 'form-msg'
    dropzone.classList.remove('is-dragging')
  }

  fileInput.addEventListener('change', () => handlePickedFile(fileInput.files[0]))
  ;['dragenter', 'dragover'].forEach((eventName) => dropzone.addEventListener(eventName, (event) => {
    event.preventDefault()
    dropzone.classList.add('is-dragging')
  }))
  ;['dragleave', 'drop'].forEach((eventName) => dropzone.addEventListener(eventName, (event) => {
    event.preventDefault()
    dropzone.classList.remove('is-dragging')
  }))
  dropzone.addEventListener('drop', (event) => {
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0]
    if (!file) return
    try {
      const transfer = new DataTransfer()
      transfer.items.add(file)
      fileInput.files = transfer.files
      handlePickedFile(file)
    } catch {
      fileName.textContent = file.name + ' — выбери этот файл через диалог'
    }
  })

  uploadForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const file = fileInput.files[0]
    if (!file) {
      message(uploadMessage, 'Сначала выбери файл заявки.', true)
      return
    }
    if (file.size > 12 * 1024 * 1024) {
      message(uploadMessage, 'Файл больше 12 МБ.', true)
      return
    }
    analyzeButton.disabled = true
    analyzeButton.textContent = 'Анализируем…'
    message(uploadMessage, 'Извлекаем текст и сопоставляем товары с каталогом…', false)
    renderWarnings([])
    try {
      const result = await API.upload('/requests/parse', file)
      currentSourceFilename = result.sourceFilename || file.name
      currentSourceHash = result.sourceHash || ''
      aiUsed = Boolean(result.aiUsed)
      duplicateSaved = Boolean(result.duplicateSaved)
      customerName.value = result.customerName || ''
      sourceFilename.textContent = currentSourceFilename
      sourceHashShort.textContent = currentSourceHash ? 'SHA-256 · ' + currentSourceHash.slice(0, 16) + '…' : ''
      if (Array.isArray(result.catalog)) setProductCatalog(result.catalog)
      items = (Array.isArray(result.items) ? result.items : []).map((item) => ({
        originalName: item.originalName || item.productName || '',
        productName: item.productName || item.originalName || '',
        productId: item.productId || '',
        quantity: item.quantity || '',
        unit: item.unit || '',
        unitPriceKopecks: item.unitPriceKopecks || 0,
        priceConfigured: Boolean(item.priceConfigured),
        itemDiscountPercent: Number(item.itemDiscountPercent || 0),
        confidence: Number(item.confidence || 0),
      }))
      globalDiscount = 0
      globalDiscountNode.value = '0'
      editor.hidden = false
      renderRows()
      updateAIStatus(
        aiUsed ? 'Нейросеть обработала документ' : 'Включён упрощённый разбор',
        aiUsed
          ? 'Qwen выделила ' + items.length + ' поз. Проверь соответствие товарам и единицы измерения.'
          : 'Ollama недоступен или вернул ошибку. Таблица составлена эвристически; обязательно проверь распознавание.',
        !aiUsed
      )
      const warnings = [...(result.warnings || [])]
      if (duplicateSaved) warnings.unshift('Этот файл уже встречался в сохранённых заявках. Повторное сохранение будет заблокировано.')
      renderWarnings(warnings)
      message(uploadMessage, items.length ? 'Черновик готов к проверке.' : 'Файл прочитан. Добавь товарные позиции вручную.', false)
      updateTotals()
      editor.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } catch (error) {
      message(uploadMessage, error.message || 'Не удалось обработать файл.', true)
    } finally {
      analyzeButton.disabled = false
      analyzeButton.textContent = 'Распознать документ'
    }
  })

  function renderRows() {
    if (!items.length) {
      rowsNode.innerHTML = '<tr><td colspan="6" class="request-empty">Пока нет позиций. Нажми «Добавить позицию» и выбери товар из каталога.</td></tr>'
      updateTotals()
      return
    }
    rowsNode.innerHTML = items.map((item, index) => {
      const product = productByID(item.productId)
      const labelName = product ? product.name : (item.originalName || item.productName || 'Неизвестный товар')
      const optionList = ['<option value="">Выбери товар…</option>'].concat(catalog.map((option) =>
        '<option value="' + UI.escapeHtml(option.id) + '"' + (String(option.id) === String(item.productId) ? ' selected' : '') + '>' + UI.escapeHtml(option.name) + '</option>'
      )).join('')
      const priceText = product && product.priceConfigured
        ? '<span class="request-price" data-unit-price="' + index + '">' + rubles(product.basePriceKopecks) + '</span><span class="request-unit-price-note">за 1 ' + UI.escapeHtml(units[product.unit] || product.unit) + '</span>'
        : '<span class="request-not-set" data-unit-price="' + index + '">Цена не задана</span>'
      const sourceNote = item.originalName && product && item.originalName.toLowerCase() !== product.name.toLowerCase()
        ? '<span class="request-original-name">В документе: ' + UI.escapeHtml(item.originalName) + '</span>'
        : (!product && item.originalName ? '<span class="request-original-name">Из документа: ' + UI.escapeHtml(item.originalName) + '</span>' : '')
      const quantityUnit = product ? product.unit : (item.unit || '')
      return '<tr data-request-row="' + index + '">' +
        '<td class="request-product-cell"><select class="input" data-product-select="' + index + '" aria-label="Товар позиции ' + (index + 1) + '">' + optionList + '</select>' + sourceNote + '</td>' +
        '<td><input class="input" data-quantity="' + index + '" type="number" min="0.001" step="0.001" inputmode="decimal" value="' + UI.escapeHtml(item.quantity) + '" aria-label="Количество позиции ' + (index + 1) + '" /><span class="request-unit-price-note">' + UI.escapeHtml(units[quantityUnit] || quantityUnit || 'ед.') + '</span></td>' +
        '<td>' + priceText + '</td>' +
        '<td><div class="request-discount-input"><input class="input" data-item-discount="' + index + '" type="number" min="0" max="100" step="1" value="' + discountValue(item.itemDiscountPercent) + '" aria-label="Скидка позиции в процентах" /><span>%</span></div></td>' +
        '<td class="request-line-total" data-row-total="' + index + '">' + (product && product.priceConfigured ? rubles(0) : '—') + '</td>' +
        '<td><button type="button" class="request-remove" data-remove-item="' + index + '" aria-label="Удалить позицию">×</button></td>' +
        '</tr>'
    }).join('')
    updateTotals()
  }

  function updateTotals() {
    let subtotal = 0
    let total = 0
    let missingMapping = false
    let missingPrice = false
    let invalidQuantity = false

    items.forEach((item, index) => {
      const product = productByID(item.productId)
      const quantity = quantityValue(item.quantity)
      const lineDiscount = discountValue(item.itemDiscountPercent)
      const cell = rowsNode.querySelector('[data-row-total="' + index + '"]')
      if (!product) {
        missingMapping = true
        if (cell) cell.textContent = 'Выбери товар'
        return
      }
      if (!product.priceConfigured) {
        missingPrice = true
        if (cell) cell.textContent = 'Нет цены'
        return
      }
      if (!quantity) {
        invalidQuantity = true
        if (cell) cell.textContent = 'Укажи количество'
        return
      }
      const lineSubtotal = Math.round(Number(product.basePriceKopecks || 0) * quantity)
      const lineTotal = Math.round(lineSubtotal * (1 - lineDiscount / 100) * (1 - globalDiscount / 100))
      subtotal += lineSubtotal
      total += lineTotal
      if (cell) cell.textContent = rubles(lineTotal)
    })

    el('summarySubtotal').textContent = rubles(subtotal)
    el('summaryDiscount').textContent = '−' + rubles(Math.max(0, subtotal - total))
    el('summaryTotal').textContent = rubles(total)

    const canSave = admin && items.length > 0 && !missingMapping && !missingPrice && !invalidQuantity && !duplicateSaved
    saveButton.disabled = !canSave
    if (!admin) {
      message(saveMessage, 'Сохранять заявки и менять цены может только администратор.', true)
    } else if (duplicateSaved) {
      message(saveMessage, 'Этот исходный файл уже сохранён. Загрузи другой файл или создай заявку вручную.', true)
    } else if (missingMapping) {
      message(saveMessage, 'Выбери товар из каталога для каждой строки.', true)
    } else if (missingPrice) {
      message(saveMessage, 'У одного или нескольких товаров не задана цена в каталоге.', true)
    } else if (invalidQuantity) {
      message(saveMessage, 'Укажи положительное количество для каждой позиции.', true)
    } else {
      message(saveMessage, '', false)
    }
  }

  rowsNode.addEventListener('change', (event) => {
    const productSelect = event.target.closest('[data-product-select]')
    if (!productSelect) return
    const index = Number(productSelect.dataset.productSelect)
    const item = items[index]
    if (!item) return
    const oldUnit = item.unit
    const product = productByID(productSelect.value)
    if (!product) {
      item.productId = ''
      renderRows()
      return
    }
    const quantity = quantityValue(item.quantity)
    if (oldUnit) {
      const converted = convertQuantity(quantity, oldUnit, product.unit)
      if (converted !== null) item.quantity = converted
      else if (oldUnit !== product.unit) {
        renderWarnings(['У позиции «' + (item.originalName || item.productName) + '» единица из документа отличается от каталога. Проверь количество вручную.'])
      }
    }
    item.productId = String(product.id)
    item.productName = product.name
    item.unit = product.unit
    item.unitPriceKopecks = product.basePriceKopecks || 0
    item.priceConfigured = Boolean(product.priceConfigured)
    renderRows()
  })

  rowsNode.addEventListener('input', (event) => {
    const quantityInput = event.target.closest('[data-quantity]')
    const discountInput = event.target.closest('[data-item-discount]')
    if (quantityInput) {
      const index = Number(quantityInput.dataset.quantity)
      if (items[index]) items[index].quantity = quantityInput.value
    }
    if (discountInput) {
      const index = Number(discountInput.dataset.itemDiscount)
      if (items[index]) items[index].itemDiscountPercent = discountValue(discountInput.value)
    }
    if (quantityInput || discountInput) updateTotals()
  })

  rowsNode.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-item]')
    if (!remove) return
    items.splice(Number(remove.dataset.removeItem), 1)
    renderRows()
  })

  el('addRequestItem').addEventListener('click', () => {
    items.push({
      originalName: '', productName: '', productId: '', quantity: 1, unit: '',
      unitPriceKopecks: 0, priceConfigured: false, itemDiscountPercent: 0, confidence: 1
    })
    renderRows()
    const last = items.length - 1
    const select = rowsNode.querySelector('[data-product-select="' + last + '"]')
    if (select) select.focus()
  })

  globalDiscountNode.addEventListener('input', () => {
    globalDiscount = discountValue(globalDiscountNode.value)
    updateTotals()
  })

  saveButton.addEventListener('click', async () => {
    if (saveButton.disabled) return
    const payload = {
      customerName: customerName.value.trim(),
      sourceFilename: currentSourceFilename,
      sourceHash: currentSourceHash,
      globalDiscountPercent: globalDiscount,
      items: items.map((item) => ({
        productId: String(item.productId),
        quantity: quantityValue(item.quantity),
        itemDiscountPercent: discountValue(item.itemDiscountPercent),
      })),
    }
    saveButton.disabled = true
    saveButton.textContent = 'Сохраняем…'
    try {
      const saved = await API.post('/requests', payload)
      message(saveMessage, 'Заявка ' + saved.number + ' сохранена в БД. Итого: ' + rubles(saved.totalKopecks) + '.', false)
      items = []
      currentSourceFilename = ''
      currentSourceHash = ''
      globalDiscount = 0
      globalDiscountNode.value = '0'
      editor.hidden = true
      duplicateSaved = false
      renderWarnings([])
      message(uploadMessage, 'Заявка сохранена: ' + saved.number, false)
      await loadHistory()
    } catch (error) {
      message(saveMessage, error.message || 'Не удалось сохранить заявку.', true)
      updateTotals()
    } finally {
      saveButton.textContent = 'Сохранить заявку'
      updateTotals()
    }
  })

  async function saveCatalogPrice(productID) {
    const input = catalogNode.querySelector('[data-price-input="' + productID + '"]')
    if (!input) return
    const value = Number(String(input.value).replace(',', '.'))
    if (!Number.isFinite(value) || value < 0 || value > 10000000000) {
      input.setCustomValidity('Укажи цену от 0 до 10 000 000 000 ₽')
      input.reportValidity()
      input.setCustomValidity('')
      return
    }
    const button = catalogNode.querySelector('[data-save-price="' + productID + '"]')
    if (button) {
      button.disabled = true
      button.textContent = '…'
    }
    try {
      await API.post('/products/' + encodeURIComponent(productID) + '/price', { priceKopecks: Math.round(value * 100) })
      await loadCatalog()
      if (items.length) updateTotals()
    } catch (error) {
      if (button) {
        button.disabled = false
        button.textContent = 'Сохранить'
      }
      const row = catalogNode.querySelector('[data-price-row="' + productID + '"]')
      if (row) {
        let warning = row.querySelector('.price-error')
        if (!warning) {
          warning = document.createElement('span')
          warning.className = 'price-error request-error'
          row.querySelector('td:last-child').append(warning)
        }
        warning.textContent = error.message
      }
    }
  }

  function renderPrices() {
    if (!catalog.length) {
      catalogNode.innerHTML = '<tr><td colspan="4" class="request-muted">Каталог пока пуст. Добавь товары через раздел «Поставки».</td></tr>'
      return
    }
    catalogNode.innerHTML = catalog.map((product) => {
      const displayPrice = product.priceConfigured ? asMoneyInput(product.basePriceKopecks, true) : ''
      return '<tr data-price-row="' + UI.escapeHtml(product.id) + '">' +
        '<td>' + UI.escapeHtml(product.name) + (product.priceConfigured ? '' : '<span class="request-unit-price-note request-not-set">Цена не задана</span>') + '</td>' +
        '<td>' + UI.escapeHtml(units[product.unit] || product.unit) + '</td>' +
        '<td><div class="price-edit"><input class="input" data-price-input="' + UI.escapeHtml(product.id) + '" type="number" min="0" max="10000000000" step="0.01" value="' + displayPrice + '" placeholder="0,00" ' + (!admin ? 'disabled' : '') + ' aria-label="Цена для ' + UI.escapeHtml(product.name) + '" /><span>₽</span></div></td>' +
        '<td><button type="button" class="btn btn-line btn-sm" data-save-price="' + UI.escapeHtml(product.id) + '"' + (!admin ? ' disabled' : '') + '>Сохранить</button></td>' +
        '</tr>'
    }).join('')
  }

  catalogNode.addEventListener('click', (event) => {
    const button = event.target.closest('[data-save-price]')
    if (button) saveCatalogPrice(button.dataset.savePrice)
  })

  async function loadHistory() {
    try {
      const requests = await API.get('/requests')
      if (!Array.isArray(requests) || requests.length === 0) {
        historyNode.innerHTML = '<div class="request-empty">Сохранённых заявок пока нет. После нажатия «Сохранить заявку» они появятся здесь.</div>'
        return
      }
      historyNode.innerHTML = requests.map((request) => {
        const created = request.createdAt ? new Date(request.createdAt).toLocaleString('ru-RU') : '—'
        const lines = Array.isArray(request.items) ? request.items : []
        return '<details class="request-history-card"><summary>' +
          '<span class="request-history-number">' + UI.escapeHtml(request.number) + '</span>' +
          '<span class="request-history-customer">' + UI.escapeHtml(request.customerName) + '</span>' +
          '<span class="request-muted">' + UI.escapeHtml(created) + '</span>' +
          '<span class="request-status-label">Сохранена</span>' +
          '<strong class="request-history-total">' + rubles(request.totalKopecks) + '</strong>' +
          '</summary><div class="request-history-detail">' +
          '<div class="request-history-meta">Позиций: ' + lines.length + ' · Скидка: ' + rubles(request.discountKopecks) + (request.sourceFilename ? ' · Файл: ' + UI.escapeHtml(request.sourceFilename) : '') + '</div>' +
          '<div class="request-table-wrap"><table class="request-history-table"><thead><tr><th>Товар</th><th>Количество</th><th>Цена</th><th>Скидка</th><th>Сумма</th></tr></thead><tbody>' +
          lines.map((line) => '<tr><td>' + UI.escapeHtml(line.productName) + '</td><td>' + number.format(line.quantity) + ' ' + UI.escapeHtml(units[line.unit] || line.unit) + '</td><td>' + rubles(line.unitPriceKopecks) + '</td><td>' + Number(line.itemDiscountPercent || 0) + '%</td><td class="request-history-total">' + rubles(line.totalKopecks) + '</td></tr>').join('') +
          '</tbody></table></div></div></details>'
      }).join('')
    } catch (error) {
      historyNode.innerHTML = '<div class="request-empty request-error">Не удалось загрузить историю: ' + UI.escapeHtml(error.message) + '</div>'
    }
  }

  el('refreshRequests').addEventListener('click', loadHistory)

  async function init() {
    if (!admin) {
      updateAIStatus('Режим просмотра', 'Заявки и цены может изменять администратор.', true)
    }
    await Promise.all([loadCatalog(), loadHistory()])
  }

  init()
})();
