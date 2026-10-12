/* Заглушка бэкенда в браузере — только для разработки и показа без сервера.
 *
 * По умолчанию она выключена, и все данные приходят с настоящего сервера (см. api.js).
 * Включить: открыть любую страницу с ?mock=1. Выключить: ?mock=0.
 * В этом режиме данные лежат в localStorage этого браузера, а заглушка отвечает на те же
 * запросы и в том же формате, что должен отдавать сервер, — её можно читать как образец
 * логики: списание по срокам, стоп-лист, горячие предложения, прогноз, роли.
 */
;(() => {
  if (!API.mock) return

  const ApiError = API.ApiError
  const DB_KEY = 'stoplist.db.v1'
  const HOUR = 3600000
  const getToken = () => localStorage.getItem('stoplist.token')

  const emptyDb = () => ({
    users: [], sessions: {}, products: [], supplies: [], batches: [], dishes: [], orders: [],
    movements: [], alerts: [], stoppedSince: {}, stopKnown: {}, clock: null, rev: 0,
  })

  function loadDb() {
    let db
    try {
      db = Object.assign(emptyDb(), JSON.parse(localStorage.getItem(DB_KEY)))
    } catch {
      db = emptyDb()
    }
    // Аккаунты, созданные до появления ролей: первый становится администратором, остальные — зрителями.
    for (const user of db.users) if (!user.role) user.role = 'viewer'
    if (db.users.length && !db.users.some((user) => user.role === 'admin')) db.users[0].role = 'admin'
    clock = db.clock || null
    return db
  }

  const saveDb = (db) => localStorage.setItem(DB_KEY, JSON.stringify(db))

  const uid = () =>
    crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)

  const normalize = (value) => String(value ?? '').trim().toLowerCase().replaceAll('ё', 'е').replace(/\s+/g, ' ')

  // Пароль в открытом виде не хранится даже в заглушке. Настоящую защиту даёт только бэкенд.
  async function hashPassword(password, salt) {
    const text = salt + ':' + password
    if (crypto.subtle) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    }
    let hash = 5381
    for (const symbol of text) hash = ((hash << 5) + hash + symbol.charCodeAt(0)) | 0
    return 'x' + (hash >>> 0).toString(16)
  }

  // Статус партии считается по доле оставшегося срока хранения и по оставшимся часам.
  function batchStatus(batch, now) {
    const start = new Date(batch.receivedAt).getTime()
    const end = new Date(batch.expiresAt).getTime()
    const share = end > start ? (end - now) / (end - start) : 0
    // Порог по доле срока дополнен порогом в часах: иначе продукт со сроком в десять часов
    // считался бы «в норме» за четыре часа до конца.
    const hoursLeft = (end - now) / HOUR
    if (share <= 0) return 'expired'
    if (share < 0.1 || hoursLeft < 2) return 'critical'
    if (share < 0.3 || hoursLeft < 6) return 'warning'
    return 'ok'
  }

  const SEVERITY = { ok: 0, warning: 1, critical: 2, expired: 3 }

  const batchView = (batch, now) => Object.assign({}, batch, { status: batchStatus(batch, now) })

  function stockView(db) {
    const now = clockNow()
    return db.products
      .map((product) => {
        const own = db.batches.filter((batch) => batch.productId === product.id).map((batch) => batchView(batch, now))
        const active = own
          .filter((batch) => batch.status !== 'expired' && batch.qtyRemaining > 0)
          .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))
        const expired = own.filter((batch) => batch.status === 'expired')
        const status = active.concat(expired).reduce((worst, batch) => (SEVERITY[batch.status] > SEVERITY[worst] ? batch.status : worst), 'ok')
        return {
          productId: product.id,
          name: product.name,
          unit: product.unit,
          available: active.reduce((sum, batch) => sum + batch.qtyRemaining, 0),
          expired: expired.reduce((sum, batch) => sum + batch.qtyRemaining, 0),
          batchCount: own.length,
          nearestExpiresAt: active.length ? active[0].expiresAt : null,
          status,
        }
      })
      .filter((item) => item.batchCount > 0)
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  }

  function supplyView(db, supply) {
    return {
      id: supply.id,
      number: supply.number,
      createdAt: supply.createdAt,
      items: supply.items.map((item) => {
        const product = db.products.find((entry) => entry.id === item.productId)
        return {
          productId: item.productId,
          name: product ? product.name : '—',
          unit: product ? product.unit : 'pcs',
          quantity: item.quantity,
          expiresAt: item.expiresAt,
        }
      }),
    }
  }

  // Продукт без единой партии на складе не нужен — убираем его вместе с последней партией.
  // Исключение — продукты из состава блюд: без них блюдо потеряет ингредиент.
  function pruneProducts(db) {
    db.movements = db.movements.filter((item) => db.batches.some((batch) => batch.id === item.batchId))
    const inDishes = new Set(db.dishes.flatMap((dish) => dish.ingredients.map((ingredient) => ingredient.productId)))
    db.products = db.products.filter(
      (product) => inDishes.has(product.id) || db.batches.some((batch) => batch.productId === product.id),
    )
  }

  /* Меню, заказы и стоп-лист */

  // Единое определение доступного остатка: непросроченные партии с ненулевым остатком.
  // Им пользуются и стоп-лист, и проверка заказа, и списание — иначе они разойдутся.
  function usableBatches(db, productId, now) {
    return db.batches
      .filter((batch) => batch.productId === productId && batch.qtyRemaining > 0 && new Date(batch.expiresAt).getTime() > now)
      .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))
  }

  const usableQuantity = (db, productId, now) =>
    usableBatches(db, productId, now).reduce((sum, batch) => sum + batch.qtyRemaining, 0)

  // Блюдо в стопе, если хотя бы одного ингредиента не хватает на порцию.
  // Число порций ограничивает самый дефицитный ингредиент.
  function menuView(db) {
    const now = clockNow()
    const menu = db.dishes
      .map((dish) => {
        let portions = Infinity
        let limitedBy = null
        const ingredients = dish.ingredients.map((ingredient) => {
          const product = db.products.find((entry) => entry.id === ingredient.productId)
          const available = usableQuantity(db, ingredient.productId, now)
          const possible = Math.floor(available / ingredient.quantity)
          const view = {
            productId: ingredient.productId,
            name: product ? product.name : '—',
            unit: product ? product.unit : 'pcs',
            quantity: ingredient.quantity,
          }
          if (possible < portions) {
            portions = possible
            limitedBy = { productId: view.productId, productName: view.name, unit: view.unit, required: ingredient.quantity, available }
          }
          return view
        })
        const stopped = portions === 0
        if (stopped && !db.stoppedSince[dish.id]) db.stoppedSince[dish.id] = new Date(now).toISOString()
        if (!stopped) delete db.stoppedSince[dish.id]
        return {
          dishId: dish.id,
          name: dish.name,
          ingredients,
          availablePortions: portions,
          stopped,
          limitedBy,
          stopReason: stopped ? limitedBy : null,
          stoppedSince: stopped ? db.stoppedSince[dish.id] : null,
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
    return menu
  }

  function createDish(db, body) {
    const name = String((body && body.name) || '').trim()
    const ingredients = (body && body.ingredients) || []
    if (!name) throw new ApiError(400, 'Укажите название блюда')
    if (db.dishes.some((dish) => normalize(dish.name) === normalize(name))) throw new ApiError(409, 'Блюдо «' + name + '» уже есть в меню')
    if (!ingredients.length) throw new ApiError(400, 'Добавьте в состав хотя бы один продукт')

    const seen = new Set()
    const prepared = ingredients.map((ingredient) => {
      const product = db.products.find((entry) => entry.id === ingredient.productId)
      const quantity = Math.round(Number(ingredient.quantity))
      if (!product) throw new ApiError(400, 'Выберите продукт из списка')
      if (seen.has(product.id)) throw new ApiError(400, 'Продукт «' + product.name + '» указан в составе дважды')
      if (!(quantity > 0)) throw new ApiError(400, 'Количество продукта «' + product.name + '» должно быть больше нуля')
      seen.add(product.id)
      return { productId: product.id, quantity }
    })

    const dish = { id: uid(), name, ingredients: prepared }
    db.dishes.push(dish)
    return menuView(db).find((item) => item.dishId === dish.id)
  }

  function deleteDish(db, id) {
    const index = db.dishes.findIndex((dish) => dish.id === id)
    if (index === -1) throw new ApiError(404, 'Блюдо не найдено')
    db.dishes.splice(index, 1)
    delete db.stoppedSince[id]
    pruneProducts(db)
    return null
  }

  // Потребность считается по всему заказу сразу: два блюда с общим ингредиентом
  // по отдельности могут проходить, а вместе — нет.
  function orderDemand(db, body) {
    const items = ((body && body.items) || []).filter((item) => Number(item.portions) > 0)
    if (!items.length) throw new ApiError(400, 'Добавьте в заказ хотя бы одно блюдо')

    const now = clockNow()
    const lines = []
    const demand = new Map()
    for (const item of items) {
      const dish = db.dishes.find((entry) => entry.id === item.dishId)
      if (!dish) throw new ApiError(400, 'Блюда из заказа больше нет в меню')
      const portions = Math.round(Number(item.portions))
      lines.push({ dishId: dish.id, name: dish.name, portions })
      for (const ingredient of dish.ingredients) {
        const entry = demand.get(ingredient.productId) || { required: 0, dishes: [] }
        entry.required += ingredient.quantity * portions
        if (!entry.dishes.includes(dish.name)) entry.dishes.push(dish.name)
        demand.set(ingredient.productId, entry)
      }
    }

    const shortages = []
    for (const [productId, entry] of demand) {
      const available = usableQuantity(db, productId, now)
      if (available >= entry.required) continue
      const product = db.products.find((item) => item.id === productId)
      shortages.push({
        productId,
        productName: product ? product.name : '—',
        unit: product ? product.unit : 'pcs',
        required: entry.required,
        available,
        missing: entry.required - available,
        dishes: entry.dishes,
      })
    }
    return { now, lines, demand, shortages }
  }

  function createOrder(db, body) {
    const { now, lines, demand, shortages } = orderDemand(db, body)
    const order = { id: uid(), number: db.orders.length + 1, createdAt: new Date(now).toISOString(), items: lines }

    // Заказ либо проходит целиком, либо не списывает ничего. Отказ тоже сохраняется в истории.
    if (shortages.length) {
      db.orders.push(Object.assign(order, { status: 'rejected', shortages, writeoffs: [] }))
      db.rev = (db.rev || 0) + 1
      saveDb(db)
      throw new ApiError(409, 'Не хватает продуктов для заказа', { message: 'Не хватает продуктов для заказа', shortages })
    }

    // FEFO: сначала списываются партии с самым ранним сроком годности.
    const writeoffs = []
    for (const [productId, entry] of demand) {
      const product = db.products.find((item) => item.id === productId)
      let left = entry.required
      for (const batch of usableBatches(db, productId, now)) {
        if (left === 0) break
        const taken = Math.min(batch.qtyRemaining, left)
        batch.qtyRemaining -= taken
        left -= taken
        move(db, 'order', batch, taken, now, order.id)
        writeoffs.push({
          productId,
          productName: product ? product.name : '—',
          unit: product ? product.unit : 'pcs',
          batchId: batch.id,
          supplyNumber: batch.supplyNumber,
          expiresAt: batch.expiresAt,
          quantity: taken,
        })
      }
    }

    db.orders.push(Object.assign(order, { status: 'accepted', shortages: [], writeoffs }))
    return order
  }

  function createSupply(db, body) {
    const number = String((body && body.number) || '').trim()
    const items = (body && body.items) || []
    if (!number) throw new ApiError(400, 'Укажите номер поставки')
    if (!items.length) throw new ApiError(400, 'Добавьте в поставку хотя бы один продукт')
    if (db.supplies.some((supply) => normalize(supply.number) === normalize(number))) {
      throw new ApiError(409, 'Поставка с номером ' + number + ' уже есть')
    }

    // Сначала проверяем всю поставку, и только потом что-либо записываем.
    const prepared = items.map((item) => {
      const name = String(item.name || '').trim()
      const quantity = Math.round(Number(item.quantity))
      const shelfLifeHours = Number(item.shelfLifeHours)
      if (!name) throw new ApiError(400, 'У продукта не указано название')
      if (!(quantity > 0)) throw new ApiError(400, 'Количество продукта «' + name + '» должно быть больше нуля')
      if (!(shelfLifeHours > 0)) throw new ApiError(400, 'Срок хранения продукта «' + name + '» должен быть больше нуля')
      if (!['g', 'ml', 'pcs'].includes(item.unit)) throw new ApiError(400, 'У продукта «' + name + '» не выбрана единица')

      const existing = db.products.find((product) => normalize(product.name) === normalize(name))
      if (existing && existing.unit !== item.unit) {
        throw new ApiError(400, 'Продукт «' + existing.name + '» уже учитывается в другой единице')
      }
      return { name, unit: item.unit, quantity, shelfLifeHours, existing }
    })

    const now = clockNow()
    const createdAt = iso(now)
    const supply = { id: uid(), number, createdAt, items: [] }

    for (const item of prepared) {
      let product = item.existing || db.products.find((entry) => normalize(entry.name) === normalize(item.name))
      if (!product) {
        product = { id: uid(), name: item.name, unit: item.unit }
        db.products.push(product)
      }
      const expiresAt = iso(now + item.shelfLifeHours * HOUR)
      const batch = {
        id: uid(),
        productId: product.id,
        supplyId: supply.id,
        supplyNumber: number,
        qtyInitial: item.quantity,
        qtyRemaining: item.quantity,
        receivedAt: createdAt,
        expiresAt,
      }
      db.batches.push(batch)
      move(db, 'receipt', batch, item.quantity, now)
      supply.items.push({ productId: product.id, quantity: item.quantity, expiresAt })
    }

    db.supplies.push(supply)
    return supplyView(db, supply)
  }

  function deleteSupply(db, id) {
    const index = db.supplies.findIndex((supply) => supply.id === id)
    if (index === -1) throw new ApiError(404, 'Поставка не найдена')
    db.supplies.splice(index, 1)
    db.batches = db.batches.filter((batch) => batch.supplyId !== id)
    pruneProducts(db)
    return null
  }

  function deleteSupplyItem(db, id, productId) {
    const supply = db.supplies.find((entry) => entry.id === id)
    const index = supply ? supply.items.findIndex((item) => item.productId === productId) : -1
    if (index === -1) throw new ApiError(404, 'Позиция не найдена')
    supply.items.splice(index, 1)
    db.batches = db.batches.filter((batch) => !(batch.supplyId === id && batch.productId === productId))
    // Поставка без позиций удаляется целиком.
    if (supply.items.length === 0) db.supplies = db.supplies.filter((entry) => entry.id !== id)
    pruneProducts(db)
    return null
  }

  /* Время: в демо-режиме его можно ускорить, поэтому «сейчас» берётся только отсюда */

  let clock = null // { base, anchor, speed }: модельное время base соответствует реальному anchor
  const realNow = () => new Date().getTime()
  const clockNow = () => (clock ? clock.base + (realNow() - clock.anchor) * clock.speed : realNow())
  const iso = (ms) => new Date(ms).toISOString()

  function formatQty(value, unit) {
    const text = (number) => String(Math.round(number * 10) / 10).replace('.', ',')
    if (unit === 'pcs') return text(value) + ' шт'
    const names = unit === 'g' ? ['г', 'кг'] : ['мл', 'л']
    return value >= 1000 ? text(value / 1000) + ' ' + names[1] : text(value) + ' ' + names[0]
  }

  const productOf = (db, id) => db.products.find((product) => product.id === id) || { id, name: '—', unit: 'pcs' }

  /* Журнал движений и уведомления */

  // Журнал только дополняется: по нему считаются расход, списания и вся аналитика.
  function move(db, type, batch, quantity, now, orderId) {
    db.movements.push({ id: uid(), at: iso(now), type, productId: batch.productId, batchId: batch.id, supplyNumber: batch.supplyNumber, quantity, orderId: orderId || null })
  }

  function notify(db, level, text, now) {
    db.alerts.push({ id: uid(), at: iso(now), level, text })
    if (db.alerts.length > 200) db.alerts.splice(0, db.alerts.length - 200)
  }

  // Роль планировщика: вызывается на каждом запросе. Списывает просроченное,
  // отмечает смену статуса партий и изменения стоп-листа. Возвращает true, если данные изменились.
  function sweep(db) {
    const now = clockNow()
    let changed = false

    for (const batch of db.batches) {
      const status = batchStatus(batch, now)
      const product = productOf(db, batch.productId)
      if (batch.qtyRemaining > 0 && status === 'expired') {
        move(db, 'expired', batch, batch.qtyRemaining, now)
        notify(db, 'expired', `Списано по сроку: ${product.name}, ${formatQty(batch.qtyRemaining, product.unit)} из поставки ${batch.supplyNumber}`, now)
        batch.writtenOff = (batch.writtenOff || 0) + batch.qtyRemaining
        batch.qtyRemaining = 0
        changed = true
      } else if (batch.qtyRemaining > 0 && status !== (batch.lastStatus || 'ok') && status !== 'ok') {
        const left = Math.max(1, Math.round((new Date(batch.expiresAt).getTime() - now) / HOUR))
        notify(db, status, `${status === 'critical' ? 'Истекает' : 'Скоро истекает'}: ${product.name}, ${formatQty(batch.qtyRemaining, product.unit)} — осталось около ${left} ч`, now)
        changed = true
      }
      batch.lastStatus = status
    }

    for (const dish of menuView(db)) {
      const known = Boolean(db.stopKnown[dish.dishId])
      if (dish.stopped && !known) {
        db.stopKnown[dish.dishId] = true
        notify(db, 'stop', `В стоп-листе: ${dish.name} — не хватает продукта «${dish.stopReason.productName}»`, now)
        changed = true
      } else if (!dish.stopped && known) {
        delete db.stopKnown[dish.dishId]
        notify(db, 'ok', `Снова доступно: ${dish.name}`, now)
        changed = true
      }
    }
    for (const dishId of Object.keys(db.stopKnown)) if (!db.dishes.some((dish) => dish.id === dishId)) delete db.stopKnown[dishId]
    return changed
  }

  /* Расход и риск просрочки */

  const RATE_WINDOW_HOURS = 24

  // Средний расход продукта в час по заказам за последние сутки модельного времени.
  function consumptionRate(db, productId, now) {
    const own = db.movements.filter((item) => item.productId === productId)
    if (!own.length) return 0
    const first = Math.min(...own.map((item) => new Date(item.at).getTime()))
    const hours = Math.min(RATE_WINDOW_HOURS, Math.max(1, (now - first) / HOUR))
    const from = now - hours * HOUR
    const used = own
      .filter((item) => item.type === 'order' && new Date(item.at).getTime() >= from)
      .reduce((sum, item) => sum + item.quantity, 0)
    return used / hours
  }

  // Для каждой партии: срочность (0…1, растёт к концу срока) и объём под риском —
  // сколько останется к моменту истечения при текущем расходе с учётом более ранних партий.
  function batchRisks(db, now) {
    const risks = new Map()
    for (const product of db.products) {
      const rate = consumptionRate(db, product.id, now)
      let cumulativeQty = 0
      let cumulativeRisk = 0
      for (const batch of usableBatches(db, product.id, now)) {
        const leftHours = (new Date(batch.expiresAt).getTime() - now) / HOUR
        const shelfHours = (new Date(batch.expiresAt).getTime() - new Date(batch.receivedAt).getTime()) / HOUR
        // Окно внимания зависит от срока хранения: для зелени это часы, для крупы — дни.
        const windowHours = Math.min(72, Math.max(6, shelfHours * 0.35))
        cumulativeQty += batch.qtyRemaining
        const atRisk = Math.min(batch.qtyRemaining, Math.max(0, cumulativeQty - rate * leftHours - cumulativeRisk))
        cumulativeRisk += atRisk
        risks.set(batch.id, { batch, product, rate, leftHours, atRisk, urgency: Math.min(1, Math.max(0, 1 - leftHours / windowHours)) })
      }
    }
    return risks
  }

  /* Горячие предложения */

  // Блюдо рекомендуется, если помогает израсходовать продукт, который иначе не успеет уйти до конца срока.
  // Вклад ингредиента = срочность × покрытие × эксклюзивность:
  //   срочность      — чем ближе конец срока партии, тем выше;
  //   покрытие       — какую долю объёма под риском блюдо способно израсходовать;
  //   эксклюзивность — ниже, если продукт уходит и в другие доступные блюда.
  function hotOffers(db) {
    const now = clockNow()
    const menu = menuView(db).filter((dish) => !dish.stopped)
    const risks = [...batchRisks(db, now).values()].filter((risk) => risk.urgency > 0 && risk.atRisk > 0)
    const users = new Map()
    for (const dish of menu) for (const item of dish.ingredients) users.set(item.productId, (users.get(item.productId) || 0) + 1)

    const offers = []
    for (const dish of menu) {
      const reasons = []
      for (const ingredient of dish.ingredients) {
        // По продукту берём самую срочную партию под риском.
        const risk = risks.filter((entry) => entry.product.id === ingredient.productId).sort((a, b) => b.urgency - a.urgency)[0]
        if (!risk) continue
        const coverage = Math.min(1, (dish.availablePortions * ingredient.quantity) / risk.atRisk)
        const exclusivity = 1 / Math.sqrt(users.get(ingredient.productId) || 1)
        reasons.push({
          weight: risk.urgency * coverage * exclusivity,
          productId: ingredient.productId,
          productName: risk.product.name,
          unit: risk.product.unit,
          supplyNumber: risk.batch.supplyNumber,
          expiresAt: risk.batch.expiresAt,
          batchQuantity: risk.batch.qtyRemaining,
          atRisk: Math.round(risk.atRisk),
          perPortion: ingredient.quantity,
          portionsToClear: Math.min(dish.availablePortions, Math.ceil(risk.atRisk / ingredient.quantity)),
          otherDishes: (users.get(ingredient.productId) || 1) - 1,
        })
      }
      if (!reasons.length) continue
      reasons.sort((a, b) => b.weight - a.weight)
      const score = reasons[0].weight + 0.25 * reasons.slice(1).reduce((sum, reason) => sum + reason.weight, 0)
      if (score < 0.02) continue
      offers.push({
        dishId: dish.dishId,
        name: dish.name,
        score: Math.min(100, Math.round(score * 100)),
        availablePortions: dish.availablePortions,
        target: { portions: reasons[0].portionsToClear, until: reasons[0].expiresAt },
        reasons,
      })
    }
    return offers.sort((a, b) => b.score - a.score)
  }

  /* Прогноз и аналитика */

  // Через сколько часов остатка продукта перестанет хватать на need:
  // расход идёт с текущим темпом по ранним партиям, партии исчезают в момент истечения срока.
  function runOut(db, productId, need, rate, now) {
    const batches = usableBatches(db, productId, now).map((batch) => ({ qty: batch.qtyRemaining, at: (new Date(batch.expiresAt).getTime() - now) / HOUR }))
    let time = 0
    for (;;) {
      const usable = batches.reduce((sum, batch) => sum + batch.qty, 0)
      if (usable < need) return { hours: time, cause: time === 0 ? 'now' : 'expiry' }
      if (rate > 0) {
        const byConsumption = time + (usable - need) / rate
        if (byConsumption < batches[0].at) return { hours: byConsumption, cause: 'consumption' }
      }
      // До истечения ближайшей партии расход съедает самые ранние партии, затем она пропадает.
      let toConsume = rate * (batches[0].at - time)
      time = batches[0].at
      for (const batch of batches) {
        const taken = Math.min(batch.qty, toConsume)
        batch.qty -= taken
        toConsume -= taken
      }
      batches.shift()
    }
  }

  function analytics(db) {
    const now = clockNow()
    const rates = new Map(db.products.map((product) => [product.id, consumptionRate(db, product.id, now)]))

    const totals = new Map()
    for (const item of db.movements) {
      const entry = totals.get(item.productId) || { received: 0, expired: 0, used: 0 }
      if (item.type === 'receipt') entry.received += item.quantity
      if (item.type === 'expired') entry.expired += item.quantity
      if (item.type === 'order') entry.used += item.quantity
      totals.set(item.productId, entry)
    }
    const writeoffs = [...totals]
      .filter(([, entry]) => entry.expired > 0)
      .map(([productId, entry]) => {
        const product = productOf(db, productId)
        return { productId, name: product.name, unit: product.unit, quantity: entry.expired, received: entry.received, share: entry.received ? entry.expired / entry.received : 0 }
      })
      .sort((a, b) => b.share - a.share)

    const deficitMap = new Map()
    for (const order of db.orders) {
      for (const shortage of order.shortages || []) {
        const entry = deficitMap.get(shortage.productId) || { productId: shortage.productId, name: shortage.productName, unit: shortage.unit, rejections: 0, missing: 0 }
        entry.rejections += 1
        entry.missing += shortage.missing
        deficitMap.set(shortage.productId, entry)
      }
    }

    const forecast = menuView(db).map((dish) => {
      let best = null
      for (const ingredient of dish.ingredients) {
        const result = runOut(db, ingredient.productId, ingredient.quantity, rates.get(ingredient.productId) || 0, now)
        if (!best || result.hours < best.hours) best = Object.assign(result, { productName: ingredient.name })
      }
      return { dishId: dish.dishId, name: dish.name, stopped: dish.stopped, hours: best.hours, cause: best.cause, productName: best.productName, at: iso(now + best.hours * HOUR) }
    }).sort((a, b) => a.hours - b.hours)

    // Закупки: при известном расходе — чтобы запаса хватало на трое суток;
    // без истории продаж — чтобы хватало хотя бы на десять порций каждого блюда.
    const TARGET_HOURS = 72
    const purchases = []
    for (const product of db.products) {
      const rate = rates.get(product.id) || 0
      const usable = usableQuantity(db, product.id, now)
      if (rate > 0) {
        const left = runOut(db, product.id, 1, rate, now).hours
        if (left >= 48) continue
        purchases.push({ productId: product.id, name: product.name, unit: product.unit, usable, hoursLeft: left, perDay: rate * 24, quantity: Math.ceil(rate * (TARGET_HOURS - left)), basis: 'rate' })
      } else {
        const perPortion = db.dishes.flatMap((dish) => dish.ingredients).filter((item) => item.productId === product.id).reduce((sum, item) => sum + item.quantity, 0)
        if (!perPortion || usable >= perPortion * 5) continue
        purchases.push({ productId: product.id, name: product.name, unit: product.unit, usable, hoursLeft: null, perDay: 0, quantity: perPortion * 10 - usable, basis: 'recipes' })
      }
    }
    purchases.sort((a, b) => (a.hoursLeft ?? 1e9) - (b.hoursLeft ?? 1e9))

    return {
      orders: { accepted: db.orders.filter((order) => order.status === 'accepted').length, rejected: db.orders.filter((order) => order.status === 'rejected').length },
      writeoffs,
      writeoffEvents: db.movements.filter((item) => item.type === 'expired').length,
      deficits: [...deficitMap.values()].sort((a, b) => b.rejections - a.rejections),
      forecast,
      purchases,
    }
  }

  function expiryView(db) {
    const now = clockNow()
    return db.batches
      .filter((batch) => batch.qtyRemaining > 0 || batch.writtenOff > 0)
      .map((batch) => {
        const product = productOf(db, batch.productId)
        return Object.assign(batchView(batch, now), { name: product.name, unit: product.unit, writtenOff: batch.writtenOff || 0 })
      })
      .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))
  }

  /* Демо-режим: ускорение времени, пример данных, сброс */

  const DEMO_PRODUCTS = [
    ['Моцарелла', 'g', 4000, 30], ['Томаты', 'g', 6000, 60], ['Базилик', 'g', 300, 10], ['Сливки 33 %', 'ml', 3000, 18],
    ['Паста спагетти', 'g', 8000, 2000], ['Куриное филе', 'g', 5000, 40], ['Салат романо', 'g', 1500, 20], ['Пармезан', 'g', 1500, 400],
  ]
  const DEMO_DISHES = [
    ['Пицца «Маргарита»', [['Моцарелла', 150], ['Томаты', 120], ['Базилик', 10]]],
    ['Капрезе', [['Моцарелла', 120], ['Томаты', 150], ['Базилик', 8]]],
    ['Паста альфредо с курицей', [['Паста спагетти', 120], ['Сливки 33 %', 150], ['Куриное филе', 130], ['Пармезан', 20]]],
    ['Салат «Цезарь»', [['Салат романо', 120], ['Куриное филе', 100], ['Пармезан', 25]]],
    ['Томатный крем-суп', [['Томаты', 250], ['Сливки 33 %', 80], ['Базилик', 5]]],
  ]

  const freeNumber = (db, prefix) => {
    let index = db.supplies.length + 1
    while (db.supplies.some((supply) => supply.number === prefix + index)) index += 1
    return prefix + index
  }

  function demo(db, action, body) {
    if (action === 'clock') {
      const speed = Number(body && body.speed)
      if (![1, 60, 600, 3600].includes(speed)) throw new ApiError(400, 'Недопустимая скорость')
      db.clock = clock = { base: clockNow(), anchor: realNow(), speed }
    } else if (action === 'advance') {
      const hours = Number(body && body.hours)
      if (!(hours > 0 && hours <= 240)) throw new ApiError(400, 'Можно перемотать от 1 до 240 часов')
      db.clock = clock = { base: clockNow() + hours * HOUR, anchor: realNow(), speed: clock ? clock.speed : 1 }
    } else if (action === 'seed') {
      const known = (name) => db.products.find((product) => normalize(product.name) === normalize(name))
      const items = DEMO_PRODUCTS.filter(([name, unit]) => !known(name) || known(name).unit === unit).map(([name, unit, quantity, shelfLifeHours]) => ({ name, unit, quantity, shelfLifeHours }))
      if (items.length) createSupply(db, { number: freeNumber(db, 'ДЕМО-'), items })
      for (const [name, ingredients] of DEMO_DISHES) {
        if (db.dishes.some((dish) => normalize(dish.name) === normalize(name))) continue
        const mapped = ingredients.map(([product, quantity]) => ({ productId: (known(product) || {}).id, quantity }))
        if (mapped.every((item) => item.productId)) createDish(db, { name, ingredients: mapped })
      }
    } else if (action === 'restock') {
      // Автопополнение для симуляции: довозит продукты, которых осталось меньше всего.
      const now = clockNow()
      const low = db.products.map((product) => ({ product, usable: usableQuantity(db, product.id, now) })).sort((a, b) => a.usable - b.usable).slice(0, 3)
      const items = low.map(({ product }) => {
        const sample = DEMO_PRODUCTS.find(([name]) => normalize(name) === normalize(product.name))
        return { name: product.name, unit: product.unit, quantity: sample ? Math.round(sample[2] / 2) : 2000, shelfLifeHours: sample ? sample[3] : 48 }
      })
      if (items.length) createSupply(db, { number: freeNumber(db, 'АВТО-'), items })
    } else if (action === 'reset') {
      Object.assign(db, { products: [], supplies: [], batches: [], dishes: [], orders: [], movements: [], alerts: [], stoppedSince: {}, stopKnown: {}, clock: null })
      clock = null
    } else throw new ApiError(404, 'Неизвестное действие демо-режима')
    return demoState(db)
  }

  const demoState = () => ({ now: iso(clockNow()), speed: clock ? clock.speed : 1, shifted: Boolean(clock) })

  async function register(db, body) {
    const name = String((body && body.name) || '').trim()
    const email = normalize(body && body.email)
    const password = String((body && body.password) || '')
    if (!name) throw new ApiError(400, 'Укажите имя')
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError(400, 'Укажите корректную почту')
    if (password.length < 6) throw new ApiError(400, 'Пароль должен быть не короче 6 символов')
    if (db.users.some((user) => user.email === email)) throw new ApiError(409, 'Аккаунт с такой почтой уже есть')

    const salt = uid()
    // Первый зарегистрированный аккаунт становится администратором, остальные — зрителями,
    // пока администратор не выдаст им права.
    const role = db.users.length === 0 ? 'admin' : 'viewer'
    const user = { id: uid(), name, email, salt, role, passwordHash: await hashPassword(password, salt) }
    db.users.push(user)
    return openSession(db, user)
  }

  async function login(db, body) {
    const email = normalize(body && body.email)
    const user = db.users.find((entry) => entry.email === email)
    const matches = user && user.passwordHash === (await hashPassword(String((body && body.password) || ''), user.salt))
    // Одна и та же ошибка для неверной почты и неверного пароля — чтобы нельзя было перебирать адреса.
    if (!matches) throw new ApiError(401, 'Неверная почта или пароль')
    return openSession(db, user)
  }

  function openSession(db, user) {
    const token = uid()
    db.sessions[token] = user.id
    return { token, user: publicUser(user) }
  }

  const publicUser = (user) => ({ id: user.id, name: user.name, email: user.email, role: user.role })

  function setUserRole(db, actor, id, body) {
    const role = body && body.role
    const target = db.users.find((entry) => entry.id === id)
    if (!target) throw new ApiError(404, 'Пользователь не найден')
    if (role !== 'admin' && role !== 'viewer') throw new ApiError(400, 'Неизвестная роль')
    if (target.id === actor.id) throw new ApiError(400, 'Свою роль изменить нельзя')
    target.role = role
    return publicUser(target)
  }

  async function local(method, path, body) {
    const db = loadDb()
    const parts = path.split('?')[0].split('/').filter(Boolean).map(decodeURIComponent)
    const fixed = (part) => parts[0] === 'auth' || part === 'validate'
    const key = method + ' /' + parts.map((part, index) => (index % 2 === 1 && !fixed(part) ? ':id' : part)).join('/')

    let result
    let dirty = false
    let mutating = false
    if (key === 'POST /auth/register') result = await register(db, body)
    else if (key === 'POST /auth/login') result = await login(db, body)
    else {
      const user = db.users.find((entry) => entry.id === db.sessions[getToken()])
      if (!user) throw new ApiError(401, 'Войдите в аккаунт')

      // Права проверяются здесь, а не в интерфейсе: скрытая кнопка — не защита.
      const isAdmin = user.role === 'admin'
      const readOnly = method === 'GET' || key === 'POST /auth/logout' || key === 'POST /orders/validate'
      if (!readOnly && !isAdmin) throw new ApiError(403, 'Изменять данные может только администратор')
      // Перед обработкой запроса наводим порядок по времени: списываем просрочку, обновляем статусы.
      dirty = sweep(db)
      mutating = !readOnly
      if (parts[0] === 'users' && !isAdmin) throw new ApiError(403, 'Раздел доступен только администратору')

      if (key === 'GET /auth/me') result = publicUser(user)
      else if (key === 'GET /users') result = db.users.map(publicUser)
      else if (key === 'POST /users/:id/role') result = setUserRole(db, user, parts[1], body)
      else if (key === 'POST /auth/logout') result = (delete db.sessions[getToken()], null)
      else if (key === 'GET /stock') result = stockView(db)
      else if (key === 'GET /stock/:id/batches') {
        const now = clockNow()
        result = db.batches
          .filter((batch) => batch.productId === parts[1])
          .map((batch) => batchView(batch, now))
          .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))
      } else if (key === 'GET /products') result = db.products.slice().sort((a, b) => a.name.localeCompare(b.name, 'ru'))
      else if (key === 'GET /supplies') {
        result = db.supplies
          .slice()
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((supply) => supplyView(db, supply))
      } else if (key === 'POST /supplies') result = createSupply(db, body)
      else if (key === 'GET /menu') {
        const hot = new Map(hotOffers(db).map((offer) => [offer.dishId, offer.score]))
        result = menuView(db).map((dish) => Object.assign(dish, { hot: hot.has(dish.dishId), hotScore: hot.get(dish.dishId) || 0 }))
      } else if (key === 'GET /hot-offers') result = hotOffers(db)
      else if (key === 'GET /expiry') result = expiryView(db)
      else if (key === 'GET /alerts') result = db.alerts.slice(-60).reverse()
      else if (key === 'GET /analytics') result = analytics(db)
      else if (key === 'GET /pulse') result = { rev: db.rev, now: iso(clockNow()), speed: clock ? clock.speed : 1, alerts: db.alerts.slice(-5).reverse() }
      else if (key === 'GET /demo/:id') result = demoState()
      else if (key === 'POST /demo/:id') result = demo(db, parts[1], body)
      else if (key === 'GET /stoplist') result = menuView(db).filter((dish) => dish.stopped)
      else if (key === 'POST /dishes') result = createDish(db, body)
      else if (key === 'DELETE /dishes/:id') result = deleteDish(db, parts[1])
      else if (key === 'POST /orders/validate') {
        const check = orderDemand(db, body)
        result = { ok: check.shortages.length === 0, shortages: check.shortages }
      } else if (key === 'POST /orders') result = createOrder(db, body)
      else if (key === 'GET /orders') result = db.orders.slice().sort((a, b) => b.number - a.number)
      else if (key === 'DELETE /supplies/:id') result = deleteSupply(db, parts[1])
      else if (key === 'DELETE /supplies/:id/items/:id') result = deleteSupplyItem(db, parts[1], parts[3])
      else throw new ApiError(404, 'Неизвестный запрос: ' + method + ' ' + path)
    }

    // После изменений — ещё раз: заказ мог отправить блюдо в стоп-лист.
    if (mutating) dirty = sweep(db) || true
    // Номер ревизии растёт при каждом изменении данных: по нему экран понимает, что пора обновиться.
    if (dirty) db.rev = (db.rev || 0) + 1
    lastRev = db.rev || 0
    saveDb(db)
    return result
  }

  let lastRev = loadDb().rev || 0

  API.useBackend({ request: local, now: clockNow, rev: () => lastRev })

  // Заметная пометка, чтобы данные из браузера нельзя было принять за серверные.
  document.addEventListener('DOMContentLoaded', () => {
    const note = document.createElement('a')
    note.href = '?mock=0'
    note.className = 'mock-note label'
    // Стили заданы прямо здесь: пометка нужна и на страницах, которые не подключают styles.css.
    note.style.cssText =
      'position:fixed; left:50%; bottom:12px; transform:translateX(-50%); z-index:25; padding:7px 10px; border-radius:3px; white-space:nowrap;' +
      'background:#f2c24b; color:#0a0a0b; text-decoration:none; font:600 10.5px/1.2 system-ui, sans-serif; letter-spacing:0.09em; text-transform:uppercase'
    note.textContent = 'Заглушка: данные в браузере · выключить'
    document.body.append(note)
  })
})()
