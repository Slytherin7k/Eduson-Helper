// ==UserScript==
// @name         Eduson Refund Master (Возврат-мастер)
// @namespace    eduson-refund-master
// @version      1.27.0
// @description  Помощник по возвратам: собирает данные из amoCRM (ФИО клиента — из карточки OmniDesk, при неполном имени добирает из админки Эдюсон); широкая панель в две колонки (анкета + данные амо + строка таблицы слева; после переговоров + ТГ + Асана справа); строка таблицы одной вставкой A→X; сообщения ТГ/РГ/Асаны по сценарию кейса.
// @author       Astanina Natalia
// @homepageURL  https://github.com/Slytherin7k/Eduson-Helper
// @updateURL    https://raw.githubusercontent.com/Slytherin7k/Eduson-Helper/main/refund-master.user.js
// @downloadURL  https://raw.githubusercontent.com/Slytherin7k/Eduson-Helper/main/refund-master.user.js
// @match        https://*.omnidesk.ru/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      eduson.amocrm.ru
// @connect      eduson.tv
// @connect      docs.google.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ================== НАСТРОЙКИ ================== */

  const AMO_SUBDOMAIN = 'eduson';

  const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1sjkq9hTg8MIjHt7KeRw2QIFryg1lSZ5o/edit#gid=332759802';
  const SHEET_ID = (SHEET_URL.match(/\/d\/([\w-]+)/) || [])[1] || '';
  const SHEET_GID = (SHEET_URL.match(/gid=(\d+)/) || [])[1] || '0';
  // Таблица возвратов — .xlsx в Google Sheets. Обычная выгрузка ?format=csv для неё
  // не работает (Google отдаёт CSV только для «родных» листов), а вот
  // визуализационный эндпоинт gviz/tq?tqx=out:csv для xlsx CSV ОТДАЁТ, если
  // запрос идёт как XHR. Читаем ТОЛЬКО чтобы посчитать, где заканчиваются данные.
  const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID +
    '/gviz/tq?tqx=out:csv&gid=' + SHEET_GID;
  const CALC_URL = 'https://docs.google.com/spreadsheets/d/11GNvwRy-fJwL2zg1KZbGouXzy5XXvJBlKXvtCHdgFfg/edit';
  const CUTOFF_DATE = new Date(2026, 6, 29); // 29.07.2026 — с этой даты сумму считают в калькуляторе

  // Столбцы основной таблицы: A Куратор|B ФИО|C Статус|D Дата заявки|E Дата доступа|F =D-E|
  // G Пройдено|H Кластер|I Продукт|J Форма оплаты|K Причина|L Сумма оплаты|M макс.возврат(формула)|
  // N Результат|O Согл.сумма|P МОП|Q формула|R-U пусто|V Комментарий|W AMO|X Omnidesk|Y Asana
  // Вставка: вся строка A→X одним Ctrl+V в A{row}. Русская локаль: «Пройдено» как «46%», суммы через запятую,
  // ссылки W/X как =HYPERLINK("..."). Сумма в конце (для Асаны/ТГ) = СОГЛАСОВАННАЯ (O), не «сумма оплаты».

  const CURATORS = [
    'Астанина Наталья', 'Белякова Валерия', 'Донцова Ольга', 'Емельянова Дина',
    'Косьянова Юлия', 'Перова Кристина', 'Пилипенко Нина', 'Романенко Вадим',
    'Руденко Диана', 'Фомина Дарья', 'Хациева Расита', 'Цурикова Юлия',
  ];
  const STATUSES = ['Общение', 'Остается', 'Делаем возврат', 'Деньги отправлены'];
  const RESULTS = ['Возврат', 'Остается'];
  const CLUSTERS = [
    'Аналитика', 'Финансы', 'IT', 'Менеджмент', 'Бухгалтерия', 'HR', 'МПП',
    'Ресейл', 'Детские курсы', 'Отраслевое управление', 'Маркетинг',
  ];
  const PAY_FORMS = [
    'Долями', 'Сбер рассрочка', 'Рассрочка Т-банк', 'Рассрочка Ванта', 'Фреш-кредит',
    'Яндекс Сплит', 'Страйп', 'Полная', 'Рассрочка (банк)', 'Рассрочка Ресурс Развития',
    'Рассрочка (внутренняя)',
  ];
  const REASONS = [
    'Не говорит причину', 'Личные причины', 'Нет денег', 'Не актуально', 'Ложные обещания МОПа',
    'Мобильное приложение', 'Не грузятся видео', 'Другие техн.проблемы', 'Устаревший контент',
    'Смена типа оплаты', 'Качество уроков', 'Не хватает доп. материалов', 'Качество поддержки',
    'Долгий ответ эксперта', 'Необъективные причины', 'Курс не готов', 'Несоответствие ожиданиям',
    'Гарантия трудоустройства', 'Оплатил дважды', 'Разница в цене',
  ];
  const PRODUCERS = {
    'Менеджмент': '@alexanderzyryanov', 'Финансы': '@zoya_vlady', 'Маркетинг': '@Ashamsha',
    'Бухгалтерия': '@hey_juliko', 'IT': '@Dmitriy_PR0', 'Аналитика': '@Dmitriy_PR0',
    'МПП': '@mikhail_svirin', 'HR': '@yatriks', 'Отраслевое управление': '@alisa_zatona',
    'Ресейл': '@Dmitriy_PR0 @n_ekimov', 'Детские курсы': '@dd_terentev',
  };

  const F_VID_OPLATY = 1285563;   // «Вид оплаты B2C»
  const F_OPERATOR = 1623777;     // «Оператор Рассрочки»

  /* ================================================ */

  const TAG = '[refundmaster]';

  /* ---------- запросы к amoCRM ---------- */

  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url: url, timeout: 15000,
        headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' },
        onload: function (res) {
          if (res.status === 200) {
            try { resolve(JSON.parse(res.responseText)); }
            catch (e) { reject(new Error('ответ амо не разбирается')); }
          } else if (res.status === 204) { resolve({}); }
          else if (res.status === 401 || res.status === 403) { reject(new Error('NOAUTH')); }
          else { reject(new Error('амо ответило кодом ' + res.status)); }
        },
        onerror: function () { reject(new Error('сеть или куки не пустили')); },
        ontimeout: function () { reject(new Error('долго нет ответа')); },
      });
    });
  }

  // GET, отдаёт текст (HTML) — для страниц админки Эдюсон.
  function gmFetchText(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url: url, timeout: 15000,
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        onload: function (res) {
          if (res.status === 200) resolve(res.responseText || '');
          else if (res.status === 401 || res.status === 403) reject(new Error('NOAUTH'));
          else reject(new Error('админка ответила кодом ' + res.status));
        },
        onerror: function () { reject(new Error('сеть или куки не пустили')); },
        ontimeout: function () { reject(new Error('долго нет ответа')); },
      });
    });
  }

  /* ---------- поиск свободной строки в гугл-таблице возвратов ---------- */
  //
  // Лист возвратов грязный: сверху ~сотни старых разрозненных строк, ВНИЗУ —
  // плотный блок актуальных заявок (куда Наталья дописывает новую строку),
  // иногда ещё 1–2 «улетевшие» строки далеко под блоком. Обычная выгрузка CSV
  // для .xlsx не работает и схлопывает пустые строки (теряются номера), поэтому
  // считаем через gviz-агрегат `count(A)` по диапазонам A{r}:A{конец}:
  // f(r) = сколько заполненных ячеек столбца A, начиная со строки r (не растёт с ростом r).
  // По сетке ищем участок, где f резко падает (там кончается плотный блок),
  // и двоичным поиском внутри участка находим последнюю заполненную строку.

  const SHEET_MAX_ROW = 100000;

  function sheetQuery(extra) {
    // gviz кэширует ответы по URL на несколько минут — добавляем метку, чтобы при
    // нажатии «найти» считать по свежей таблице (обновление страницы Sheets на это не влияет).
    return gmFetchText(SHEET_CSV_URL + '&' + extra + '&_cb=' + Date.now());
  }
  function looksLikeLoginPage(t) {
    return /<!doctype|<html|<head|accounts\.google\.com/i.test(String(t).slice(0, 400));
  }
  function parseCount(t) {
    if (/"status"\s*:\s*"error"/.test(t)) return 0; // invalid_range и т.п.
    const m = String(t).replace(/\s+/g, ' ').match(/"?(\d+)"?\s*$/);
    return m ? parseInt(m[1], 10) : 0;
  }
  // f(from): count(A) в строках from..SHEET_MAX_ROW. Ошибка/не-число → 0.
  function countAfrom(from) {
    return sheetQuery('tq=' + encodeURIComponent('select count(A)') + '&range=A' + from + ':A' + SHEET_MAX_ROW)
      .then(parseCount).catch(() => 0);
  }

  // Promise<{ next, lastData, total, strayBelow } | { error }>.
  function findNextFreeRow() {
    return sheetQuery('tq=' + encodeURIComponent('select count(A)')).then(probe => {
      if (looksLikeLoginPage(probe)) return { error: 'нужен вход в Google в этом браузере' };
      const total = parseCount(probe);
      if (!total) return { error: 'таблица пустая или недоступна' };

      const grid = [400, 1000, 1800, 2600, 3200, 3450, 3550, 3620, 3680, 3720, 3780, 3860, 3960];
      return Promise.all(grid.map(countAfrom)).then(fv => {
        grid.push(SHEET_MAX_ROW); fv.push(0);
        // последний участок сетки с резким падением f (>=5) — конец плотного блока
        let bi = -1;
        for (let i = 0; i < grid.length - 1; i++) if (fv[i] - fv[i + 1] >= 5) bi = i;
        if (bi === -1) for (let i = 0; i < grid.length - 1; i++) if (fv[i] - fv[i + 1] >= 1) bi = i;
        let lo, hi, fHi;
        if (bi === -1) { lo = 2; hi = grid[0]; fHi = fv[0]; }
        else { lo = grid[bi]; hi = grid[bi + 1]; fHi = fv[bi + 1]; }

        // двоичный поиск: наибольшая R в [lo, hi), где в строках R..hi-1 есть заполненная A
        const step = (a, b, best) => {
          if (a > b) return Promise.resolve(best);
          const m = (a + b) >> 1;
          return countAfrom(m).then(fm => (fm - fHi >= 1) ? step(m + 1, b, m) : step(a, m - 1, best));
        };
        return step(lo, hi - 1, lo - 1).then(lastRow => {
          if (lastRow < 2) return { error: 'не разобрала структуру таблицы' };
          // Плотный блок мог перерасти узел сетки (напр. 3680): дописанные ПОДРЯД строки
          // ниже узла двоичный поиск не видит (он ограничен hi-1). Прирастим блок его
          // непрерывным хвостом — строками сразу за lastRow, идущими без пропусков.
          return countAfrom(lastRow + 1).then(below => {
            const grow = (a, b, best) => {
              if (a > b || below <= 0) return Promise.resolve(best);
              const m = (a + b) >> 1;
              // строки lastRow+1..m все заполнены? заполнено в них = below - count(m+1..)
              return countAfrom(m + 1).then(fAfter =>
                (below - fAfter === m - lastRow) ? grow(m + 1, b, m) : grow(a, m - 1, best));
            };
            return grow(lastRow + 1, lastRow + below, lastRow).then(blockEnd =>
              countAfrom(blockEnd + 1).then(stray => ({
                next: blockEnd + 1, lastData: blockEnd, total: total, strayBelow: stray,
              })));
          });
        });
      });
    }).catch(e => ({
      error: (e && e.message === 'NOAUTH') ? 'Google не пустил — нужен вход'
        : (e && e.message) || 'сеть или куки не пустили',
    }));
  }

  function fmtTs(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + d.getFullYear();
  }
  function todayStr() {
    const d = new Date();
    return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + d.getFullYear();
  }
  function parseRu(s) {
    const m = String(s || '').trim().match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})$/);
    if (!m) return null;
    let y = +m[3]; if (y < 100) y += 2000;
    return new Date(y, +m[2] - 1, +m[1]);
  }
  function fieldValById(lead, id) {
    const f = ((lead.custom_fields_values || []).find(x => x.field_id === id));
    return f && f.values && f.values[0] != null ? String(f.values[0].value).trim() : '';
  }
  function fieldValues(f) {
    return (f.values || []).map(v => String(v.value).trim()).filter(v => v !== '');
  }

  // «Вид оплаты B2C» + «Оператор Рассрочки» -> значение из списка таблицы.
  // Ключевой сигнал — ОПЕРАТОР: «без рассрочки»/пусто = оплатили целиком → «Полная»
  // (даже если Вид оплаты = Газпромбанк / Точка банк / Халва — это просто банк оплаты).
  function mapPayForm(vid, op) {
    const V = (vid || '').toLowerCase().trim();
    const O = (op || '').toLowerCase().trim();
    if (!V && !O) return '';
    if (V.includes('долями')) return 'Долями';
    if (V.includes('страйп') || V.includes('stripe')) return 'Страйп';
    if (V.includes('сплит')) return 'Яндекс Сплит';
    const hasOp = O && !O.includes('без рассрочки');
    if (hasOp) {
      if (O.includes('тинь') || O.includes('т-банк') || O.includes('тбанк')) return 'Рассрочка Т-банк';
      if (O.includes('сбер')) return 'Сбер рассрочка';
      if (O.includes('фреш')) return 'Фреш-кредит';
      if (O.includes('ванта')) return 'Рассрочка Ванта';
      if (O.includes('яндекс')) return 'Яндекс Сплит';
      if (O.includes('ресурс')) return 'Рассрочка Ресурс Развития';
      if (O.includes('eduson') || O.includes('эдусон')) return 'Рассрочка (внутренняя)';
      return 'Рассрочка (банк)';
    }
    return 'Полная';
  }

  function readDealFields(lead, out) {
    (((lead || {}).custom_fields_values) || []).forEach(f => {
      const n = (f.field_name || '').toLowerCase().trim();
      const vals = fieldValues(f);
      if (!vals.length) return;
      if (!out.course && /продукт для шаблон/.test(n)) out.course = vals[0];
      else if (!out.course && /категор/.test(n) && !/старая/.test(n)) out.course = vals[0];
      if (!out.cluster && n === 'кластер') out.cluster = vals[0];
    });
    if (!out.cluster) {
      (((lead || {}).custom_fields_values) || []).forEach(f => {
        const n = (f.field_name || '').toLowerCase().trim();
        if (!out.cluster && /^кластер$/.test(n)) out.cluster = (fieldValues(f)[0] || '');
      });
    }
    if (!out.course) out.course = String((lead && lead.name) || '');
    out.payType = mapPayForm(fieldValById(lead, F_VID_OPLATY), fieldValById(lead, F_OPERATOR));
    out.amount = (lead && lead.price) ? String(lead.price) : '';
  }

  function grabAmoRefs() {
    const leads = new Set(), contacts = new Set();
    document.querySelectorAll('a[href*="amocrm.ru/leads/detail/"], a[href*="amocrm.ru/contacts/detail/"]').forEach(a => {
      let m = a.href.match(/leads\/detail\/(\d+)/); if (m) leads.add(m[1]);
      m = a.href.match(/contacts\/detail\/(\d+)/); if (m) contacts.add(m[1]);
    });
    const direct = document.querySelector('#field_-8380000');
    if (direct) { const m = (direct.value || '').match(/\b\d{6,10}\b/); if (m) { leads.add(m[0]); contacts.add(m[0]); } }
    const labs = document.querySelectorAll('label, h6, [class*="label"]');
    for (const lab of labs) {
      if (!/amocrm/i.test((lab.textContent || '').trim())) continue;
      let p = lab.parentElement;
      for (let i = 0; i < 5 && p; i++) {
        const m = (p.innerText || '').match(/\b\d{6,10}\b/);
        if (m) { leads.add(m[0]); contacts.add(m[0]); break; }
        p = p.parentElement;
      }
    }
    return { leads: [...leads], contacts: [...contacts] };
  }

  function grabSeedFromPage() {
    const text = document.body.innerText || '';
    const em = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (em && !em[0].toLowerCase().endsWith('@eduson.tv')) return em[0];
    const ph = text.match(/(?:\+7|8)[\s(.-]*\d{3}[\s).-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/);
    if (ph) return ph[0].replace(/\D/g, '');
    return '';
  }

  /* ---------- ФИО клиента: карточка OmniDesk и админка Эдюсон ---------- */

  // Значение поля из блока «ДАННЫЕ ПОЛЬЗОВАТЕЛЯ» сайдбара OmniDesk по data-field_id.
  // (1 = ПОЛНОЕ ИМЯ, 2 = EMAIL-АДРЕС, 16 = ТЕЛЕФОН, 7302 = АДМИНКА.)
  function omniCardField(fid) {
    const box = document.querySelector('.a17_additional_fields[data-field_id="' + fid + '"]');
    if (box) {
      const inp = box.querySelector('input, textarea');
      if (inp && (inp.value || '').trim()) return inp.value.trim();
      const h6 = box.querySelector('h6');
      let t = (box.innerText || '').trim();
      if (h6) t = t.replace(h6.textContent, '').trim();
      return t.split('\n')[0].trim();
    }
    const byId = document.querySelector('#field_' + fid);
    if (byId && (byId.value || byId.textContent || '').trim()) return (byId.value || byId.textContent).trim();
    return '';
  }

  function nameWords(s) {
    return String(s || '').trim().split(/\s+/).filter(w => w.length >= 2 && /[а-яёa-z]/i.test(w));
  }
  // «Похоже на ФИО»: 2–4 слова из букв (кириллица/латиница), дефис ок, без цифр/@/скобок.
  function looksLikeFio(s) {
    const t = String(s || '').trim();
    if (!t || /[0-9@()\/]/.test(t)) return false;
    const w = t.split(/\s+/);
    return w.length >= 2 && w.length <= 4 && w.every(x => /^[А-ЯЁа-яёA-Za-z][А-ЯЁа-яёA-Za-z-]*$/.test(x));
  }

  // ФИО клиента из карточки OmniDesk («ПОЛНОЕ ИМЯ»). Приоритет для поля анкеты.
  function grabNameFromOmniCard() {
    const n = omniCardField(1);
    return looksLikeFio(n) || nameWords(n).length ? n.trim() : '';
  }

  // Куратор = ответственный за обращение в OmniDesk (select #case_staff_id, формат «Имя Ф.»).
  // Сопоставляем со списком CURATORS («Фамилия Имя»): имя совпало + фамилия на ту же букву.
  function curatorFromResponsible() {
    const sel = document.querySelector('#case_staff_id, select[name="case_staff_id"]');
    let raw = '';
    if (sel && sel.options && sel.selectedIndex >= 0) raw = (sel.options[sel.selectedIndex].textContent || '').trim();
    if (!raw || /не назначен/i.test(raw)) return '';
    const low = s => String(s || '').toLowerCase().replace(/ё/g, 'е');
    // «Имя Ф.» либо «Имя Фамилия» либо «Фамилия Имя»
    const parts = raw.split(/\s+/).filter(Boolean);
    if (parts.length < 2) return '';
    const a = low(parts[0]), b = low(parts[1]).replace(/\.$/, '');
    const initMatch = (fam, given) => {
      // raw = «Имя Ф.»: given == parts0, fam[0] == parts1[0]
      if (b.length === 1 || (parts[1].endsWith('.') && b.length <= 2)) return given === a && fam[0] === b[0];
      // raw = полное: любой порядок
      return (given === a && fam === b) || (given === b && fam === a);
    };
    const hit = CURATORS.find(c => {
      const p = c.split(' '); // «Фамилия Имя»
      return p[1] && initMatch(low(p[0]), low(p[1]));
    });
    return hit || '';
  }

  // Полное ФИО из админки Эдюсон — если в карточке/амо только имя.
  // Берём ссылку(и) из поля АДМИНКА сайдбара:
  //  /admin/users/<id>       → <h1> страницы = «Фамилия Имя»
  //  /admin/super_users/<id> → таблица Sub Users, колонки First Name / Last Name → «Фамилия Имя»
  //                            (строку выбираем по совпадению email/телефона клиента, иначе первую полную)
  async function fetchAdminFio(seedEmail, seedPhone) {
    const raw = omniCardField(7302) || '';
    const userIds = (raw.match(/\/admin\/users\/(\d+)/g) || []).map(m => m.match(/(\d+)/)[1]);
    const superIds = (raw.match(/\/admin\/super_users\/(\d+)/g) || []).map(m => m.match(/(\d+)/)[1]);
    if (!userIds.length && !superIds.length) return '';
    const A = 'https://www.eduson.tv';
    const digits = s => String(s || '').replace(/\D/g, '').slice(-10);
    const wantPhone = digits(seedPhone), wantEmail = String(seedEmail || '').toLowerCase().trim();
    const norm = s => String(s || '').replace(/\s+/g, ' ').trim();

    for (const uid of userIds.slice(0, 3)) {
      try {
        const doc = new DOMParser().parseFromString(await gmFetchText(A + '/admin/users/' + uid + '?language=ru'), 'text/html');
        const h1 = norm((doc.querySelector('h1') || {}).textContent);
        if (looksLikeFio(h1)) return h1;
      } catch (e) { if (e.message === 'NOAUTH') return ''; }
    }

    for (const sid of superIds.slice(0, 2)) {
      try {
        const doc = new DOMParser().parseFromString(await gmFetchText(A + '/admin/super_users/' + sid + '?language=ru'), 'text/html');
        let tbl = null;
        doc.querySelectorAll('table').forEach(t => {
          const head = (t.querySelector('tr') || {}).textContent || '';
          if (/first name/i.test(head) && /last name/i.test(head)) tbl = t;
        });
        if (!tbl) continue;
        const heads = [...tbl.querySelectorAll('tr')[0].querySelectorAll('th,td')].map(x => x.textContent.trim().toLowerCase());
        const iF = heads.indexOf('first name'), iL = heads.indexOf('last name');
        const iE = heads.indexOf('email'), iP = heads.indexOf('phone');
        const rows = [...tbl.querySelectorAll('tr')].slice(1).map(tr =>
          [...tr.querySelectorAll('td')].map(td => td.textContent.trim()));
        const compose = r => {
          const first = norm(r[iF]), last = norm(r[iL]);
          return (last && first) ? last + ' ' + first : '';
        };
        let match = rows.find(r =>
          (wantEmail && iE >= 0 && (r[iE] || '').toLowerCase() === wantEmail) ||
          (wantPhone && iP >= 0 && digits(r[iP]) === wantPhone));
        const fio = (match && compose(match)) || (rows.map(compose).find(Boolean) || '');
        if (looksLikeFio(fio)) return fio;
      } catch (e) { if (e.message === 'NOAUTH') return ''; }
    }
    return '';
  }

  // Финальный выбор ФИО: карточка OmniDesk → (если не полное) амо → (если и там имя) админка.
  async function resolveClientName(omniName, amoName, seedEmail, seedPhone) {
    let best = (omniName || '').trim() || (amoName || '').trim();
    let src = (omniName || '').trim() ? 'из карточки OmniDesk' : (amoName ? 'из амо' : '');
    if (nameWords(best).length < 2) {
      if (nameWords(amoName).length >= 2) { best = amoName.trim(); src = 'из амо'; }
      else {
        try {
          const adm = await fetchAdminFio(seedEmail, seedPhone);
          if (nameWords(adm).length >= 2) { best = adm; src = 'из админки Эдюсон'; }
        } catch (e) { /* админка не критична */ }
      }
    }
    return { name: best || omniName || amoName || '', source: src };
  }

  // «Пройдено, %» курса — со страницы статистики студента на платформе курса
  // (та же, что куратор смотрит из инкогнито; открывается админ-логином Натальи).
  // Путь: поле АДМИНКА → /admin/users/<id> (для суперюзера — sub-user по совпадению курса/почты/тел.)
  //       → кабинет /ru/users/<id>/stats → ссылка «Курс: …» = учебный план
  //       /ru/users/<id>/assignments/<N> → точный процент в шапке (.academy-plan-header .progress-scale__value).
  async function fetchProgressPct(courseName, seedEmail, seedPhone) {
    const raw = omniCardField(7302) || '';
    const userIds = (raw.match(/\/admin\/users\/(\d+)/g) || []).map(m => m.match(/(\d+)/)[1]);
    const superIds = (raw.match(/\/admin\/super_users\/(\d+)/g) || []).map(m => m.match(/(\d+)/)[1]);
    if (!userIds.length && !superIds.length) return '';
    const A = 'https://www.eduson.tv';
    const digits = s => String(s || '').replace(/\D/g, '').slice(-10);
    const wantPhone = digits(seedPhone), wantEmail = String(seedEmail || '').toLowerCase().trim();
    const lc = s => String(s || '').toLowerCase().replace(/ё/g, 'е');
    const courseHit = (a, b) => {
      a = lc(a); b = lc(b);
      if (!a || !b) return false;
      return a.split(/[^a-zа-я0-9]+/).filter(w => w.length >= 4).some(w => b.indexOf(w) !== -1);
    };

    let ids = userIds.slice(0, 3);
    for (const sid of superIds.slice(0, 2)) {
      try {
        const doc = new DOMParser().parseFromString(await gmFetchText(A + '/admin/super_users/' + sid + '?language=ru'), 'text/html');
        let tbl = null;
        doc.querySelectorAll('table').forEach(t => {
          const head = (t.querySelector('tr') || {}).textContent || '';
          if (/first name/i.test(head) && /last name/i.test(head)) tbl = t;
        });
        if (!tbl) continue;
        const heads = [...tbl.querySelectorAll('tr')[0].querySelectorAll('th,td')].map(x => x.textContent.trim().toLowerCase());
        const iE = heads.indexOf('email'), iP = heads.indexOf('phone'), iC = heads.indexOf('company');
        const rows = [...tbl.querySelectorAll('tr')].slice(1);
        const cells = tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
        const uidOf = tr => { const a = tr.querySelector('a[href*="/admin/users/"]'); const m = a && a.getAttribute('href').match(/\/admin\/users\/(\d+)/); return m ? m[1] : ''; };
        let picked = (iC >= 0 && courseName) ? rows.find(tr => courseHit(courseName, cells(tr)[iC])) : null;
        if (!picked) picked = rows.find(tr => { const c = cells(tr); return (wantEmail && iE >= 0 && (c[iE] || '').toLowerCase() === wantEmail) || (wantPhone && iP >= 0 && digits(c[iP]) === wantPhone); });
        if (!picked) picked = rows[0];
        const u = picked && uidOf(picked);
        if (u && ids.indexOf(u) === -1) ids.unshift(u);
      } catch (e) { if (e.message === 'NOAUTH') return ''; }
    }

    const okUrl = u => u && /^https?:\/\/[^/]*eduson\.tv\//i.test(u);
    // Общий процент «Пройдено» — из шапки блока «План обучения» кабинета/плана.
    // Единственная .progress-scale на странице статистики = агрегат по всей программе.
    const readScale = root => {
      const v = root && root.querySelector('.progress-scale__value, .progress-scale');
      let m = v && (v.textContent || '').match(/(\d{1,3})\s*%/);
      if (!m) {
        const bar = root && root.querySelector('.progress-scale__bar');
        const w = bar && (bar.getAttribute('style') || '').match(/width:\s*(\d{1,3})/);
        if (w) m = [null, w[1]];
      }
      return m ? String(Math.min(100, Math.max(0, +m[1]))) : '';
    };
    for (const uid of ids.slice(0, 4)) {
      try {
        const adoc = new DOMParser().parseFromString(await gmFetchText(A + '/admin/users/' + uid + '?language=ru'), 'text/html');
        const sLink = adoc.querySelector('a[href*="/ru/users/"][href*="/stats"]');
        if (!okUrl(sLink && sLink.getAttribute('href'))) continue;
        const sdoc = new DOMParser().parseFromString(await gmFetchText(sLink.getAttribute('href')), 'text/html');

        // Ссылка на учебный план курса (.../assignments/<N>) — там точный процент.
        // Сначала ищем карточку по совпадению названия. Название из амо часто на другом
        // языке, чем на платформе («Product Manager в IT» ↔ «Менеджер продукта в ИТ»),
        // поэтому при нескольких курсах и без совпадения берём ФЛАГМАНСКИЙ курс плана —
        // самый крупный по числу уроков («… из N»). Мелкие курсы (Excel, Тайм-менеджмент,
        // «Как получить работу мечты») идут бонусом к любой программе.
        const cards = [...sdoc.querySelectorAll('.inline-course')];
        const multi = cards.length > 1;
        const weight = c => { const m = (c.textContent || '').match(/из\s+(\d+)/); return m ? +m[1] : 0; };
        let planUrl = '';
        if (cards.length) {
          let card = courseName ? cards.find(c => courseHit(courseName, c.textContent)) : null;
          if (!card && courseName && multi) card = cards.slice().sort((a, b) => weight(b) - weight(a))[0];
          if (!card && !(courseName && multi)) card = sdoc.querySelector('.inline-course--current') || cards[0];
          const a = card && card.querySelector('a[href*="/assignments/"]');
          planUrl = a && a.getAttribute('href');
        }
        if (!planUrl && !(courseName && multi)) {
          const a2 = sdoc.querySelector('a[href*="/assignments/"]');
          planUrl = a2 && a2.getAttribute('href');
        }
        // ссылка на плане может быть относительной — достраиваем от адреса кабинета
        if (planUrl && planUrl.charAt(0) === '/') {
          try { planUrl = new URL(planUrl, sLink.getAttribute('href')).href; } catch (e) {}
        }
        if (!okUrl(planUrl)) continue;

        const planHtml = await gmFetchText(planUrl);
        const pdoc = new DOMParser().parseFromString(planHtml, 'text/html');
        const valEl = pdoc.querySelector('.academy-plan-header .progress-scale__value, .academy-plan-header__progress-scale .progress-scale__value, .academy-plan-header__progress-scale');
        let m = valEl && (valEl.textContent || '').match(/(\d{1,3})\s*%/);
        if (!m) {
          const bar = pdoc.querySelector('.academy-plan-header .progress-scale__bar, .academy-plan-header__progress-scale .progress-scale__bar');
          const w = bar && (bar.getAttribute('style') || '').match(/width:\s*(\d{1,3})/);
          if (w) m = [null, w[1]];
        }
        if (!m) m = planHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').match(/(\d{1,3})\s*%\s+\d+\s+курс/i);
        if (m) return String(Math.min(100, Math.max(0, +m[1])));
        // на странице плана процент не нашёлся — берём общий со страницы статистики
        const ov = readScale(sdoc);
        if (ov !== '') return ov;
      } catch (e) { if (e.message === 'NOAUTH') return ''; }
    }
    return '';
  }

  function isWon(l) { return l && l.status_id === 142; }
  function contactNameOf(c) {
    return String((c && c.name) || '').trim() ||
      [c && c.first_name, c && c.last_name].filter(Boolean).join(' ').trim();
  }

  async function fetchUserName(base, uid) {
    if (!uid) return '';
    try { const u = await gmFetch(base + '/api/v4/users/' + uid); return (u && u.name) ? u.name : ''; }
    catch (e) { return ''; }
  }

  async function findSeller(base, leadId) {
    try {
      const j = await gmFetch(base + '/api/v4/leads/' + leadId + '/notes?filter[note_type]=common&order[id]=desc&limit=250');
      const notes = ((j._embedded || {}).notes) || [];
      for (const n of notes) {
        const t = (n.params && (n.params.text || n.params.message)) || '';
        const m = t.match(/Коллега\s+(.+?)\s+продал/i);
        if (m) return m[1].replace(/\s+/g, ' ').trim();
      }
    } catch (e) { if (e.message === 'NOAUTH') throw e; }
    return '';
  }

  // Одна сделка -> компактное описание купленного курса для панели.
  function dealSummary(lead) {
    const d = { id: String(lead.id), course: '', cluster: '', payType: '', amount: '', purchaseDate: '', closedAt: lead.closed_at || 0, price: +lead.price || 0 };
    readDealFields(lead, d);
    d.purchaseDate = fmtTs(lead.closed_at || 0);
    return d;
  }

  // ВСЕ выигранные сделки клиента с ненулевым бюджетом = купленные курсы.
  // Берём сделки из виджета карточки И все сделки контакта(ов) — в виджете часто не все.
  // Возвращает { deals:[...], lead:<полный объект сделки-по-умолчанию> }.
  async function gatherWonDeals(base, leadIds, contactIds) {
    const leadSet = new Set((leadIds || []).map(String));
    const contactSet = new Set((contactIds || []).map(String));
    const fetched = {};
    const expandContacts = async () => {
      for (const cid of [...contactSet].slice(0, 4)) {
        try {
          const c = await gmFetch(base + '/api/v4/contacts/' + cid + '?with=leads');
          (((c._embedded || {}).leads) || []).slice(0, 15).forEach(l => leadSet.add(String(l.id)));
        } catch (e) { if (e.message === 'NOAUTH') throw e; }
      }
    };
    const fetchLeads = async () => {
      for (const id of [...leadSet].slice(0, 25)) {
        if (fetched[id]) continue;
        try {
          const l = await gmFetch(base + '/api/v4/leads/' + id + '?with=contacts');
          fetched[id] = l || {};
          (((l && l._embedded || {}).contacts) || []).forEach(c => contactSet.add(String(c.id)));
        } catch (e) { if (e.message === 'NOAUTH') throw e; fetched[id] = {}; }
      }
    };
    await expandContacts();
    await fetchLeads();
    await expandContacts(); // у найденных сделок могли всплыть новые контакты
    await fetchLeads();
    const won = Object.keys(fetched).map(k => fetched[k]).filter(l => l && l.id && isWon(l));
    let pool = won.filter(l => +l.price > 0);
    if (!pool.length) pool = won; // все нулевые — берём как есть
    // по умолчанию: свежее по дате покупки, при равенстве — крупнее бюджет
    pool.sort((a, b) => (b.closed_at || 0) - (a.closed_at || 0) || (+b.price || 0) - (+a.price || 0));
    return { deals: pool.map(dealSummary), lead: pool[0] || null };
  }

  // МОП + «пройдено, %» для конкретной сделки/курса (нужно при смене курса в панели).
  async function fetchDealExtras(dealId, courseName, seedEmail, seedPhone) {
    const base = 'https://' + AMO_SUBDOMAIN + '.amocrm.ru';
    const out = { mop: '', mopFromNote: false, progress: '' };
    try {
      const seller = await findSeller(base, dealId);
      if (seller) { out.mop = seller; out.mopFromNote = true; }
      else {
        const l = await gmFetch(base + '/api/v4/leads/' + dealId);
        out.mop = await fetchUserName(base, l && l.responsible_user_id);
      }
    } catch (e) { /* МОП не критичен */ }
    try {
      const pct = await fetchProgressPct(courseName, seedEmail, seedPhone);
      if (pct !== '') out.progress = pct;
    } catch (e) { /* процент впишут руками */ }
    return out;
  }

  async function collectRefundData() {
    const base = 'https://' + AMO_SUBDOMAIN + '.amocrm.ru';
    const out = {
      amoId: '', name: '', nameSource: '', course: '', cluster: '', payType: '', mop: '', mopFromNote: false, producer: '',
      amount: '', purchaseDate: '', progress: '', amoLink: '', omniLink: location.href.split('#')[0], foundBy: '',
      deals: [], dealId: '',
    };
    const omniName = grabNameFromOmniCard();
    const seedEmail = omniCardField(2), seedPhone = omniCardField(16);
    let amoName = '';
    const refs = grabAmoRefs();
    let lead = null;
    if (refs.leads.length || refs.contacts.length) {
      out.foundBy = 'по виджету amoCRM в карточке';
      const g = await gatherWonDeals(base, refs.leads, refs.contacts);
      lead = g.lead; out.deals = g.deals;
    }
    if (!lead) {
      const seed = grabSeedFromPage();
      if (!seed) {
        out.foundBy = 'не нашла ни сделку в карточке, ни почту/телефон на странице';
        if (omniName) { out.name = omniName; out.nameSource = 'из карточки OmniDesk'; }
        return out;
      }
      out.foundBy = 'поиском по ' + seed;
      const res = await gmFetch(base + '/api/v4/contacts?query=' + encodeURIComponent(seed) + '&with=leads');
      const contact = (((res._embedded || {}).contacts) || [])[0];
      if (contact) {
        const g = await gatherWonDeals(base, [], [contact.id]);
        lead = g.lead; out.deals = g.deals;
      }
    }
    if (lead) {
      out.dealId = String(lead.id);
      out.amoId = String(lead.id);
      readDealFields(lead, out);
      out.purchaseDate = fmtTs(lead.closed_at || 0);
      out.amoLink = base + '/leads/detail/' + lead.id;
      const seller = await findSeller(base, lead.id);
      out.mop = seller || await fetchUserName(base, lead.responsible_user_id);
      out.mopFromNote = !!seller;
      out.producer = PRODUCERS[out.cluster] || '';
      const cs = ((lead._embedded || {}).contacts) || [];
      const cid = (cs.find(c => c.is_main) || cs[0] || {}).id;
      if (cid) {
        try { const c = await gmFetch(base + '/api/v4/contacts/' + cid); if (c && c.id) amoName = contactNameOf(c); }
        catch (e) { /* имя не критично */ }
      }
      if (!(+lead.price > 0)) out.foundBy += ' — ВНИМАНИЕ: у сделки нулевой бюджет, проверь сумму и форму оплаты';
      if ((out.deals || []).length > 1) {
        out.foundBy += ' — КУПЛЕНО ' + out.deals.length + ' КУРСОВ, выбери в панели, на какой возврат';
      }
    }
    // ФИО клиента: сначала карточка OmniDesk, потом амо, потом (если только имя) админка Эдюсон.
    try {
      const r = await resolveClientName(omniName, amoName, seedEmail || grabSeedFromPage(), seedPhone);
      out.name = r.name; out.nameSource = r.source;
    } catch (e) { out.name = omniName || amoName || ''; }
    // «Пройдено, %» — со страницы статистики студента (через админку Эдюсон).
    try {
      const pct = await fetchProgressPct(out.course, seedEmail || grabSeedFromPage(), seedPhone);
      if (pct !== '') out.progress = pct;
    } catch (e) { /* не критично — куратор впишет руками */ }
    return out;
  }

  /* ---------- панель ---------- */

  let panel = null;

  function el(tag, styles, text) {
    const e = document.createElement(tag);
    if (styles) e.style.cssText = styles;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // Гамма: голубой акцент + чёрный / серый / белый. Красный — только ошибки.
  // Кнопки и блоки — сильно закруглённые; шрифт — округлый (Nunito с фолбэком).
  const ACC = '#0284C7', ACC_DK = '#075985', ACC_LT = '#E0F2FE', ACC_BD = '#BAE6FD';
  const C_AUTO = '#9CA3AF', C_MAN = ACC;
  const FONT = "'Nunito','Varela Round','Segoe UI',system-ui,-apple-system,Roboto,Arial,sans-serif";
  const S = {
    box: 'position:fixed;z-index:2147483646;background:#fff;border-radius:16px;box-shadow:0 12px 36px rgba(15,23,42,.22);width:min(720px,96vw);max-width:96vw;max-height:94vh;min-width:300px;min-height:200px;display:flex;flex-direction:column;font-family:' + FONT + ';border:1px solid #E5E7EB;resize:both;overflow:hidden;',
    head: 'display:flex;justify-content:space-between;align-items:center;gap:6px;padding:9px 10px 9px 13px;background:' + ACC + ';color:#fff;border-radius:16px 16px 0 0;cursor:move;user-select:none;flex:0 0 auto;',
    title: 'font-size:12.5px;font-weight:800;white-space:nowrap;',
    hBtn: 'background:rgba(255,255,255,.20);border:none;color:#fff;border-radius:999px;padding:2px 9px;font-size:11px;line-height:1.4;cursor:pointer;font-family:inherit;font-weight:700;',
    body: 'padding:10px 14px 14px;overflow:auto;flex:1 1 auto;min-height:0;',
    grid: 'display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;margin-top:8px;',
    col: 'flex:1 1 300px;min-width:0;display:flex;flex-direction:column;',
    scen: 'font-size:11px;line-height:1.5;margin:0 0 7px;padding:9px 12px;border-radius:14px;background:' + ACC_LT + ';border:1px solid ' + ACC_BD + ';white-space:pre-wrap;color:' + ACC_DK + ';',
    block: 'background:#F8FAFC;border:1px solid #E5E7EB;border-radius:16px;padding:11px 13px;margin-top:10px;',
    blockHdr: 'font-size:11.5px;font-weight:800;color:' + ACC + ';letter-spacing:.2px;margin-bottom:7px;',
    grp: 'font-size:9.5px;font-weight:800;color:#6B7280;letter-spacing:.3px;text-transform:uppercase;margin:10px 0 2px;',
    legend: 'font-size:9.5px;margin:2px 0 4px;line-height:1.5;',
    amoCard: 'background:#F8FAFC;border:1px solid #E5E7EB;border-radius:16px;padding:10px 13px;margin-top:10px;',
    negBox: 'background:#F8FAFC;border:1px solid #E5E7EB;border-left:3px solid ' + ACC + ';border-radius:16px;padding:11px 13px;margin-top:10px;',
    fwrap: 'margin:7px 0 0;',
    lab: 'font-size:10.5px;color:#374151;font-weight:600;margin:0 0 3px;display:flex;justify-content:space-between;align-items:baseline;gap:6px;',
    tag: 'font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.3px;flex:0 0 auto;',
    input: 'width:100%;box-sizing:border-box;border:1px solid #D1D5DB;border-radius:12px;padding:6px 10px;font-size:12px;font-family:inherit;background:#fff;',
    btn: 'width:100%;box-sizing:border-box;background:' + ACC + ';color:#fff;border:none;border-radius:16px;padding:9px 12px;font-size:11.5px;font-weight:700;cursor:pointer;font-family:inherit;margin-top:7px;',
    btnAlt: 'width:100%;box-sizing:border-box;background:#fff;color:' + ACC + ';border:1.5px solid ' + ACC_BD + ';border-radius:16px;padding:9px 12px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;margin-top:7px;',
    big: 'width:100%;box-sizing:border-box;background:' + ACC + ';color:#fff;border:none;border-radius:18px;padding:11px;font-size:12px;font-weight:800;cursor:pointer;font-family:inherit;margin-top:7px;',
    small: 'width:100%;box-sizing:border-box;background:#F3F4F6;color:#4B5563;border:1px solid #E5E7EB;border-radius:12px;padding:7px 9px;font-size:10.5px;font-weight:700;cursor:pointer;font-family:inherit;margin-top:5px;',
    status: 'font-size:11px;margin-top:8px;line-height:1.5;white-space:pre-wrap;color:#374151;background:#F9FAFB;border:1px solid #EEF0F2;border-radius:14px;padding:8px 11px;',
    hint: 'font-size:9.5px;color:#9CA3AF;margin-top:7px;line-height:1.45;',
    warn: 'font-size:10px;color:#B45309;margin-top:3px;line-height:1.35;',
    err: 'font-size:11px;font-weight:700;color:#B91C1C;background:#FEF2F2;border:1.5px solid #FCA5A5;border-radius:14px;padding:9px 12px;margin-top:9px;line-height:1.4;',
    row: 'display:flex;gap:6px;',
  };

  function makeDraggable(box, handle) {
    let sx, sy, ox, oy, drag = false;
    handle.addEventListener('mousedown', e => {
      if (e.target.tagName === 'BUTTON') return;
      drag = true;
      const r = box.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!drag) return;
      let x = ox + (e.clientX - sx), y = oy + (e.clientY - sy);
      x = Math.max(4, Math.min(x, window.innerWidth - 70));
      y = Math.max(4, Math.min(y, window.innerHeight - 34));
      box.style.left = x + 'px'; box.style.top = y + 'px';
      box.style.right = 'auto'; box.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => {
      if (!drag) return;
      drag = false;
      GM_setValue('rm_pos2', JSON.stringify({ x: parseInt(box.style.left, 10), y: parseInt(box.style.top, 10) }));
    });
  }

  function buildPanel() {
    if (panel) { panel.remove(); panel = null; return; }

    // округлый шрифт Nunito (если не загрузится из-за CSP — просто фолбэк на Segoe UI)
    try {
      if (!document.getElementById('rm-font-link')) {
        const lf = document.createElement('link');
        lf.id = 'rm-font-link'; lf.rel = 'stylesheet';
        lf.href = 'https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&display=swap';
        (document.head || document.documentElement).appendChild(lf);
      }
    } catch (e) { /* не критично */ }

    // Сохранение вписанного по конкретному кейсу (чтобы не переписывать при повторном открытии).
    const caseId = (location.pathname.match(/(\d{2,4}-\d{5,})/) || [])[1] || 'x';
    const CASE_KEY = 'rm_case_' + caseId;
    let cs = {};
    try { cs = JSON.parse(GM_getValue(CASE_KEY) || '{}') || {}; } catch (e) { cs = {}; }
    const pick = (k, fallback) => (cs[k] !== undefined && cs[k] !== '') ? cs[k] : fallback;

    const T = {
      curator: pick('curator', curatorFromResponsible() || GM_getValue('rm_curator') || CURATORS[0]),
      name: '', status: pick('status', GM_getValue('rm_status') || STATUSES[0]),
      claimDate: pick('claimDate', todayStr()), accessDate: '',
      progress: pick('progress', ''), cluster: '', course: '', payType: '',
      reason: pick('reason', GM_getValue('rm_reason') || REASONS[0]),
      amount: '', result: pick('result', GM_getValue('rm_result') || RESULTS[1]),
      agreedSum: pick('agreedSum', ''), mop: '', mopFromNote: false,
      clientComment: pick('clientComment', ''),
      amoLink: '', omniLink: location.href.split('#')[0], purchaseDate: '',
      producer: '', rowNumber: pick('rowNumber', GM_getValue('rm_row') || ''),
      rgTag: pick('rgTag', GM_getValue('rm_rg') || ''),
      deals: [], dealId: pick('dealId', ''),
    };
    const inputs = {};
    const seedEmail = omniCardField(2) || grabSeedFromPage();
    const seedPhone = omniCardField(16);
    let saveT = 0;
    const saveCase = () => {
      clearTimeout(saveT);
      saveT = setTimeout(() => {
        const keep = {};
        ['curator', 'status', 'claimDate', 'progress', 'reason', 'clientComment', 'result', 'agreedSum', 'rowNumber', 'rgTag', 'dealId']
          .forEach(k => { keep[k] = T[k]; });
        try { GM_setValue(CASE_KEY, JSON.stringify(keep)); } catch (e) { /* ignore */ }
      }, 300);
    };

    panel = el('div', S.box);

    const head = el('div', S.head);
    head.appendChild(el('div', S.title, '🌀 Возврат-мастер'));
    const hBtns = el('div', 'display:flex;gap:4px;align-items:center;flex:0 0 auto;');
    const bRefresh = el('button', S.hBtn, '🔄 амо');
    bRefresh.title = 'Собрать данные из амо заново';
    const bInfo = el('button', S.hBtn, 'ℹ️');
    bInfo.title = 'Подробный отчёт по сбору данных из амо';
    const bCollapse = el('button', S.hBtn, '–');
    const bClose = el('button', S.hBtn, '✕');
    hBtns.appendChild(bRefresh); hBtns.appendChild(bInfo); hBtns.appendChild(bCollapse); hBtns.appendChild(bClose);
    head.appendChild(hBtns);
    panel.appendChild(head);

    const body = el('div', S.body);
    panel.appendChild(body);

    // scenarioBox и statusBox — на всю ширину, над двумя колонками
    const scenarioBox = el('div', S.scen, 'Определяю сценарий…');
    body.appendChild(scenarioBox);
    const statusBox = el('div', S.status, 'Собираю данные из амо…');
    body.appendChild(statusBox);
    // Полный отчёт по сбору из амо — прячется за кнопкой «ℹ️» в шапке.
    let lastAmoDetail = '';
    bInfo.onclick = () => {
      statusBox.textContent = lastAmoDetail || 'Отчёта пока нет — нажми «🔄 амо».';
      statusBox.style.color = lastAmoDetail ? '#374151' : '#B45309';
    };

    // Две колонки: слева — анкета + данные из амо + строка таблицы;
    // справа — «после переговоров», ТГ, Асана.
    const grid = el('div', S.grid);
    const colL = el('div', S.col);
    const colR = el('div', S.col);
    grid.appendChild(colL); grid.appendChild(colR);
    body.appendChild(grid);

    // блок-«карточка» с заголовком; accent=true → сиреневая полоска слева
    const mkBlock = (parent, titleText, accent) => {
      const b = el('div', S.block + (accent ? 'border-left:3px solid #7C3AED;' : ''));
      if (titleText) b.appendChild(el('div', S.blockHdr, titleText));
      parent.appendChild(b);
      return b;
    };

    const mkField = (parent, key, label, kind, opts) => {
      opts = opts || {};
      const wrap = el('div', S.fwrap);
      const lab = el('div', S.lab);
      lab.appendChild(el('span', 'flex:1 1 auto;', label));
      // тег «из амо» показываем только у предзаполненных полей; «впиши» убрали совсем
      if (kind === 'auto' && !opts.noTag) lab.appendChild(el('span', S.tag + 'color:' + C_AUTO + ';', 'из амо'));
      wrap.appendChild(lab);
      let field;
      if (opts.list) {
        field = el('select', S.input);
        const fill = (cur) => {
          field.innerHTML = '';
          const items = opts.list.slice();
          if (cur && items.indexOf(cur) === -1) items.unshift(cur);
          items.forEach(v => { const o = el('option', null, v); o.value = v; field.appendChild(o); });
          field.value = cur || '';
        };
        fill(T[key]);
        field._fill = fill;
        field.addEventListener('change', () => { T[key] = field.value; if (opts.save) GM_setValue(opts.save, field.value); saveCase(); if (opts.onChange) opts.onChange(); });
      } else {
        field = el(opts.area ? 'textarea' : 'input', S.input);
        if (opts.area) field.style.height = '46px';
        if (opts.ph) field.placeholder = opts.ph;
        field.value = T[key];
        field.addEventListener('input', () => { T[key] = field.value; saveCase(); if (opts.onChange) opts.onChange(); });
      }
      wrap.appendChild(field);
      parent.appendChild(wrap);
      inputs[key] = field;
      return field;
    };

    /* ---- вспомогалки буфера ---- */
    const clean = v => String(v || '').replace(/\t|\n/g, ' ').trim();
    const num = v => clean(v).replace(/\s/g, '').replace('.', ',');
    // Сумма возврата — ВСЕГДА конкретное число, не равное нулю. «По оферте» суммой не считается.
    // Пустое (или не число) поле при результате «Возврат» — ошибка (guardSum блокирует копирование).
    const agreedRaw = () => num(T.agreedSum);
    // Число суммы для проверок: NaN, если вписано не число.
    const agreedNum = () => { const n = parseFloat(agreedRaw().replace(',', '.')); return isFinite(n) ? n : NaN; };
    // Для таблицы (столбец O): «0» при «Остаётся», иначе число.
    const agreed = () => T.result === 'Остается' ? '0' : agreedRaw();
    // Для сообщений и Асаны: «15000 ₽» / «0».
    const agreedTxt = () => {
      if (T.result === 'Остается') return '0';
      const a = agreedRaw();
      return a ? a + ' ₽' : '';
    };
    const progCell = () => {
      const s = clean(T.progress).replace(/[^\d.,]/g, '').replace('.', ',');
      return s === '' ? '' : s + '%';
    };
    const link = u => { u = clean(u).replace(/"/g, ''); return u ? '=HYPERLINK("' + u + '")' : ''; };
    const fF = r => '=D' + r + '-E' + r;
    const fM = r => '=МАКС(0;L' + r + '*ЕСЛИ(F' + r + '<=3;1;ЕСЛИ(F' + r + '<=14;0,5;ЕСЛИ(F' + r + '<=30;0,3;ЕСЛИ(F' + r + '<=45;0,15;0))))-L' + r + '*G' + r + ')';
    const copy = (text, msg, warn) => {
      try { GM_setClipboard(text); statusBox.textContent = msg; statusBox.style.color = warn ? '#B45309' : '#15803D'; }
      catch (e) { statusBox.textContent = 'Не получилось скопировать 😕'; statusBox.style.color = '#DC2626'; }
    };
    // Маркеры для сообщений: B('...') — «впиши сам», Q('...') — цитата клиента.
    // Простой буфер: B -> ✍️【…】, Q -> просто текст.
    // HTML-буфер (при вставке в Telegram Desktop): B -> жирным, Q -> цитата (blockquote).
    const MB1 = '@@B@@', MB2 = '@@/B@@', MQ1 = '@@Q@@', MQ2 = '@@/Q@@';
    const B = s => MB1 + s + MB2;
    const Q = s => MQ1 + s + MQ2;
    const marked = s => String(s)
      .split(MB1).join(' ✍️【').split(MB2).join('】')
      .split(MQ1).join('').split(MQ2).join('');
    const markedHtml = s => {
      var x = String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      x = x.split(MB1).join('<b>✍️ ').split(MB2).join('</b>');
      x = x.split(MQ1).join('<blockquote>').split(MQ2).join('</blockquote>');
      return x.split('\n').join('<br>');
    };
    const copyMsg = (text, msg, warn) => {
      var plain = marked(text), html = markedHtml(text), ok = false;
      try {
        if (navigator.clipboard && window.ClipboardItem) {
          navigator.clipboard.write([new window.ClipboardItem({
            'text/plain': new Blob([plain], { type: 'text/plain' }),
            'text/html': new Blob([html], { type: 'text/html' })
          })]).catch(function () { try { GM_setClipboard(plain); } catch (e) {} });
          ok = true;
        }
      } catch (e) { /* нет rich-буфера */ }
      if (!ok) { try { GM_setClipboard(plain); ok = true; } catch (e) {} }
      statusBox.textContent = ok ? msg : 'Не получилось скопировать 😕';
      statusBox.style.color = ok ? (warn ? '#B45309' : '#15803D') : '#DC2626';
    };

    /* ---- сценарий: текст + видимость блоков ---- */
    let tableBlock = null, calcBlock = null, rgBlock = null, tgBlock = null, rowLinkBtn = null, negBox = null;
    let sumWrap = null, errBox = null;
    const dateWarn = el('div', S.warn);
    const show = (elm, v) => { if (elm) elm.style.display = v ? 'block' : 'none'; };
    // При результате «Возврат» сумма обязательна: конкретное число больше нуля.
    const sumMissing = () => T.result === 'Возврат' && !(agreedNum() > 0);
    const updateScenario = () => {
      const p = parseRu(T.accessDate), c = parseRu(T.claimDate);
      const known = !!p;
      const days = (p && c) ? Math.round((c - p) / 86400000) : null;
      const rg = days != null && days <= 3;
      const post = !!(p && p >= CUTOFF_DATE);
      const needSum = sumMissing();

      dateWarn.textContent = (p && c && c <= p) ? '⚠️ Дата заявки должна быть ПОЗЖЕ даты выдачи доступа.' : '';
      // поле «Согласованная сумма» видно только при результате «Возврат»
      if (sumWrap) sumWrap.style.display = (T.result === 'Возврат') ? 'block' : 'none';
      if (negBox) {
        negBox.style.borderLeftColor = needSum ? '#DC2626' : '#0284C7';
        negBox.style.background = needSum ? '#FEF2F2' : '#F8FAFC';
      }
      if (inputs.agreedSum) inputs.agreedSum.style.borderColor = needSum ? '#DC2626' : '#D1D5DB';
      if (errBox && !needSum) errBox.style.display = 'none';

      const L = ['📋 Что делать по этому кейсу:'];
      if (!known) {
        L.push('Впиши «Дата выдачи доступа» — покажу сценарий.');
      } else {
        if (rg) L.push('⏱ ' + days + ' дн. с покупки — ВОЗВРАТ ≤ 3 ДНЕЙ.\n→ Справа: «Сообщение РГ». Слева всё равно заполняем строку в таблице возвратов.');
        else if (days != null) L.push('⏱ ' + days + ' дн. с покупки — обычный процесс: слева строка в таблице возвратов.');
        else L.push('Впиши «Дата заявки», чтобы посчитать дни.');
        if (post) L.push('📅 Куплено после 29.07 → дополнительно калькулятор (слева, внизу).');
        else L.push('📅 Куплено до 29.07.');
      }
      scenarioBox.textContent = L.join('\n');

      show(rgBlock, rg);
      show(tableBlock, true);   // строка в таблице возвратов — нужна ВСЕГДА
      show(calcBlock, post);    // калькулятор — дополнительно, если куплено после 29.07
      show(tgBlock, true);
      show(rowLinkBtn, true);
    };
    const onDate = () => updateScenario();
    const syncAgreed = () => { if (T.result === 'Остается') { T.agreedSum = '0'; if (inputs.agreedSum) inputs.agreedSum.value = '0'; } };

    /* ---- карточка «из амо» (сводка) ---- */
    const amoSummary = el('div', 'margin-top:3px;');
    const renderAmoCard = () => {
      const l1 = clean(T.name) || '— имя не найдено, нажми 🔄 —';
      const l2 = [clean(T.course), clean(T.payType), clean(T.amount) ? clean(T.amount) + ' ₽' : ''].filter(Boolean).join('  ·  ');
      const l3 = [clean(T.cluster) && ('Кластер: ' + clean(T.cluster)), clean(T.accessDate) && ('Куплено: ' + clean(T.accessDate)), clean(T.mop) && ('МОП: ' + clean(T.mop))].filter(Boolean).join('  ·  ');
      amoSummary.innerHTML = '';
      amoSummary.appendChild(el('div', 'font-weight:700;font-size:12px;color:#1F2937;', l1));
      if (l2) amoSummary.appendChild(el('div', 'font-size:11px;color:#4B5563;margin-top:2px;', l2));
      if (l3) amoSummary.appendChild(el('div', 'font-size:10.5px;color:#6B7280;margin-top:2px;', l3));
    };

    /* ============ ЛЕВАЯ КОЛОНКА ============ */

    // 1) Анкета — что заполняешь
    const bForm = mkBlock(colL, 'Анкета — заполни');
    mkField(bForm, 'curator', 'Куратор', 'man', { list: CURATORS, save: 'rm_curator' });
    mkField(bForm, 'status', 'Статус', 'man', { list: STATUSES, save: 'rm_status' });
    mkField(bForm, 'claimDate', 'Дата заявки на возврат', 'man', { ph: 'дд.мм.гггг', onChange: onDate });
    bForm.appendChild(dateWarn);
    mkField(bForm, 'progress', 'Пройдено, % (подтянется из админки, можно поправить)', 'man', { ph: 'например 15 или 0' });
    mkField(bForm, 'reason', 'Причина возврата', 'man', { list: REASONS, save: 'rm_reason' });
    mkField(bForm, 'clientComment', 'Комментарий клиента (цитата)', 'man', { area: true, ph: 'Вставь текст клиента' });

    // 2) Данные из амо (сворачивается для правки)
    const amoCard = el('div', S.amoCard);
    const amoHdr = el('div', 'display:flex;justify-content:space-between;align-items:center;');
    amoHdr.appendChild(el('span', S.blockHdr + 'margin:0;', '📇 Данные из амо'));
    const bEdit = el('button', 'background:' + ACC_LT + ';border:none;color:' + ACC + ';border-radius:999px;padding:3px 10px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit;', '✏️ поправить');
    amoHdr.appendChild(bEdit);
    amoCard.appendChild(amoHdr);
    amoCard.appendChild(amoSummary);

    // Выбор курса — виден, только если клиент купил несколько курсов (несколько выигранных сделок)
    const dealPick = el('div', 'display:none;margin:8px 0 2px;padding:9px 11px;background:#FEF3C7;border:1px solid #FCD34D;border-radius:12px;');
    dealPick.appendChild(el('div', 'font-size:10.5px;font-weight:800;color:#92400E;margin-bottom:6px;line-height:1.35;',
      '🎓 У клиента несколько купленных курсов — выбери, на какой просят возврат:'));
    const dealSelect = el('select', S.input);
    dealSelect.style.cssText += 'font-weight:700;background:#fff;';
    dealPick.appendChild(dealSelect);
    amoCard.appendChild(dealPick);

    const amoFields = el('div', 'display:none;margin-top:4px;');
    bEdit.onclick = () => {
      const open = amoFields.style.display === 'none';
      amoFields.style.display = open ? 'block' : 'none';
      amoSummary.style.display = open ? 'none' : 'block';
      bEdit.textContent = open ? '▲ свернуть' : '✏️ поправить';
      if (!open) renderAmoCard();
    };
    amoCard.appendChild(amoFields);
    colL.appendChild(amoCard);

    const amoChg = () => renderAmoCard();
    mkField(amoFields, 'name', 'ФИО клиента', 'auto', { onChange: amoChg });
    mkField(amoFields, 'course', 'Продукт (курс)', 'auto', { onChange: amoChg });
    mkField(amoFields, 'payType', 'Форма оплаты', 'auto', { list: PAY_FORMS, onChange: amoChg });
    mkField(amoFields, 'amount', 'Сумма оплаты (Бюджет амо)', 'auto', { onChange: amoChg });
    mkField(amoFields, 'cluster', 'Кластер', 'auto', { list: CLUSTERS, onChange: () => {
      T.producer = PRODUCERS[T.cluster] || '';
      if (inputs.producer) inputs.producer.value = T.producer;
      renderAmoCard();
    } });
    mkField(amoFields, 'accessDate', 'Дата выдачи доступа (= покупка)', 'auto', { ph: 'дд.мм.гггг', onChange: () => { renderAmoCard(); onDate(); } });
    mkField(amoFields, 'mop', 'МОП — кто продал курс', 'auto', { onChange: amoChg });

    // Применить выбранный курс (сделку): поля из амо + при refetch — заново % и МОП.
    const applyDeal = (d, opts) => {
      opts = opts || {};
      const setF = (k, v) => { T[k] = v || ''; const f = inputs[k]; if (f && f._fill) f._fill(T[k]); else if (f) f.value = T[k]; };
      setF('course', d.course); setF('payType', d.payType); setF('amount', d.amount); setF('cluster', d.cluster);
      if (d.purchaseDate) { T.accessDate = d.purchaseDate; if (inputs.accessDate) inputs.accessDate.value = d.purchaseDate; }
      T.amoLink = 'https://' + AMO_SUBDOMAIN + '.amocrm.ru/leads/detail/' + d.id;
      T.producer = PRODUCERS[T.cluster] || '';
      if (inputs.producer) inputs.producer.value = T.producer;
      renderAmoCard(); updateScenario();
      if (!opts.refetch) return;
      T.progress = ''; if (inputs.progress) inputs.progress.value = '';
      T.mop = ''; T.mopFromNote = false; if (inputs.mop) inputs.mop.value = '';
      renderAmoCard();
      statusBox.textContent = 'Курс: ' + (d.course || '?') + ' — подтягиваю % и МОП…';
      statusBox.style.color = '#374151';
      fetchDealExtras(d.id, d.course, seedEmail, seedPhone).then(x => {
        if (x.progress !== '') { T.progress = x.progress; if (inputs.progress) inputs.progress.value = x.progress; }
        if (x.mop) { T.mop = x.mop; T.mopFromNote = x.mopFromNote; if (inputs.mop) inputs.mop.value = x.mop; }
        saveCase(); renderAmoCard();
        statusBox.textContent = '✓ Курс: ' + (d.course || '?') +
          (x.progress !== '' ? ' · пройдено ' + x.progress + '%' : ' · % не нашёлся — впиши руками') +
          (x.mop ? ' · МОП ' + x.mop : '');
        statusBox.style.color = x.progress !== '' ? '#15803D' : '#B45309';
      }).catch(() => {
        statusBox.textContent = '⚠️ Не подтянула % / МОП для нового курса — впиши руками.';
        statusBox.style.color = '#B45309';
      });
    };
    const renderDealPick = () => {
      const ds = T.deals || [];
      if (ds.length < 2) { dealPick.style.display = 'none'; return; }
      dealPick.style.display = 'block';
      dealSelect.innerHTML = '';
      ds.forEach(d => {
        const amt = String(d.amount || '').replace(/\D/g, '');
        const label = (d.course || 'курс?') + '  ·  ' + (amt ? (+amt).toLocaleString('ru-RU') + ' ₽' : '—') +
          (d.purchaseDate ? '  ·  ' + d.purchaseDate : '');
        const o = el('option', null, label); o.value = d.id; dealSelect.appendChild(o);
      });
      dealSelect.value = ds.some(d => d.id === T.dealId) ? T.dealId : ds[0].id;
    };
    dealSelect.addEventListener('change', () => {
      const d = (T.deals || []).find(x => x.id === dealSelect.value);
      if (!d) return;
      T.dealId = d.id; saveCase();
      applyDeal(d, { refetch: true });
    });

    // 3) Строка в таблице возвратов
    tableBlock = mkBlock(colL, 'Строка в таблице возвратов');
    const rowNumWrap = el('div', 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:' + ACC_LT + ';border:1px solid ' + ACC_BD + ';border-radius:12px;padding:8px 11px;');
    rowNumWrap.appendChild(el('span', 'font-size:11.5px;font-weight:700;color:' + ACC_DK + ';flex:1 1 auto;line-height:1.3;', '№ свободной строки внизу таблицы:'));
    const rowNumInput = el('input', S.input);
    rowNumInput.style.cssText += 'width:74px;flex:0 0 auto;font-size:15px;font-weight:800;text-align:center;border:1.5px solid #7DD3FC;color:' + ACC_DK + ';padding:6px;';
    rowNumInput.placeholder = '—';
    rowNumInput.value = T.rowNumber;
    rowNumWrap.appendChild(rowNumInput);
    const bFindRow = el('button', S.small, '🔍 найти');
    bFindRow.style.cssText += 'width:auto;flex:0 0 auto;margin-top:0;padding:7px 11px;white-space:nowrap;background:#fff;color:' + ACC + ';border:1.5px solid ' + ACC_BD + ';';
    bFindRow.title = 'Посмотреть в гугл-таблице возвратов, какая строка внизу свободна';
    rowNumWrap.appendChild(bFindRow);
    const rowNote = el('div', 'flex:1 1 100%;font-size:10px;font-weight:700;line-height:1.4;color:' + ACC_DK + ';', '');
    rowNote.style.display = 'none';
    rowNumWrap.appendChild(rowNote);
    tableBlock.appendChild(rowNumWrap);

    // Поиск свободной строки: заполняет поле и пишет короткую заметку рядом.
    let rowFinding = false;
    const findRowInto = (mode) => {
      if (rowFinding) return;
      rowFinding = true;
      const prevTxt = bFindRow.textContent;
      bFindRow.textContent = '…'; bFindRow.disabled = true;
      rowNote.style.display = 'block';
      rowNote.style.color = ACC_DK;
      rowNote.textContent = 'Смотрю таблицу возвратов…';
      findNextFreeRow().then(r => {
        if (r.next) {
          T.rowNumber = String(r.next);
          rowNumInput.value = T.rowNumber;
          try { GM_setValue('rm_row', T.rowNumber); } catch (e) { /* ignore */ }
          saveCase(); updateRowLabels();
          rowNote.style.color = r.strayBelow ? '#B45309' : '#15803D';
          rowNote.textContent = (r.strayBelow ? '⚠️ ' : '✓ ') +
            'Свободная строка — ' + r.next + ' (плотный блок заканчивается на ' + r.lastData + ').' +
            (r.strayBelow
              ? ' Но НИЖЕ блока есть ещё ' + r.strayBelow + ' заполнен. строк(и) — открой таблицу и глянь, не туда ли писать.'
              : ' Всё равно проверь глазами.');
        } else {
          rowNote.style.color = '#B45309';
          rowNote.textContent = '⚠️ Не смогла прочитать таблицу (' + r.error + '). Впиши № строки руками.';
        }
      }).catch(() => {
        rowNote.style.color = '#B45309';
        rowNote.textContent = '⚠️ Не смогла прочитать таблицу. Впиши № строки руками.';
      }).then(() => {
        rowFinding = false; bFindRow.disabled = false; bFindRow.textContent = prevTxt;
      });
    };
    bFindRow.onclick = () => findRowInto('click');

    const bAll = el('button', S.big);
    bAll.onclick = () => {
      if (!guardSum()) return;
      const r = parseInt(T.rowNumber, 10);
      if (!r) { statusBox.textContent = 'Впиши № строки (поле выше).'; statusBox.style.color = '#B45309'; return; }
      const line = [
        clean(T.curator), clean(T.name), clean(T.status), clean(T.claimDate), clean(T.accessDate),
        fF(r),
        progCell(), clean(T.cluster), clean(T.course), clean(T.payType), clean(T.reason), num(T.amount),
        fM(r),
        clean(T.result), agreed(), clean(T.mop),
        '', '', '', '', '',
        clean(T.clientComment), link(T.amoLink), link(T.omniLink),
      ].join('\t');
      copy(line, '✓ Строка A–X в буфере → ячейка A' + r + ', Ctrl+V. В первый раз сверь M с соседней строкой.');
    };
    tableBlock.appendChild(bAll);

    const moreToggle = el('button', 'background:none;border:none;color:' + ACC + ';font-size:10px;font-weight:700;cursor:pointer;padding:6px 0 0;font-family:inherit;text-decoration:underline;', 'по частям, если что-то поехало ▾');
    const moreBox = el('div', 'display:none;');
    moreToggle.onclick = () => {
      const v = moreBox.style.display === 'none';
      moreBox.style.display = v ? 'block' : 'none';
      moreToggle.textContent = 'по частям, если что-то поехало ' + (v ? '▴' : '▾');
    };
    tableBlock.appendChild(moreToggle);
    tableBlock.appendChild(moreBox);
    [
      ['A–L (F формулой, M пропусти)', () => {
        const r = parseInt(T.rowNumber, 10) || 0;
        return [clean(T.curator), clean(T.name), clean(T.status), clean(T.claimDate), clean(T.accessDate), r ? fF(r) : '',
          progCell(), clean(T.cluster), clean(T.course), clean(T.payType), clean(T.reason), num(T.amount)].join('\t');
      }, 'A'],
      ['N–X', () => [clean(T.result), agreed(), clean(T.mop), '', '', '', '', '',
        clean(T.clientComment), link(T.amoLink), link(T.omniLink)].join('\t'), 'N'],
      ['только A–E', () => [clean(T.curator), clean(T.name), clean(T.status), clean(T.claimDate), clean(T.accessDate)].join('\t'), 'A'],
      ['только G–L', () => [progCell(), clean(T.cluster), clean(T.course), clean(T.payType), clean(T.reason), num(T.amount)].join('\t'), 'G'],
      ['только N–P', () => [clean(T.result), agreed(), clean(T.mop)].join('\t'), 'N'],
      ['только V–X', () => [clean(T.clientComment), link(T.amoLink), link(T.omniLink)].join('\t'), 'V'],
    ].forEach(([lbl, fn, col]) => {
      const b = el('button', S.small, 'Копировать ' + lbl + ' → столбец ' + col);
      b.onclick = () => copy(fn(), lbl + ' в буфере ✓ вставь в столбец ' + col, true);
      moreBox.appendChild(b);
    });

    // 4) Ссылка на строку — для заметки в OmniDesk
    rowLinkBtn = el('button', S.btnAlt, '🔗 Ссылка на строку (в заметку OmniDesk)');
    rowLinkBtn.onclick = () => {
      const n = parseInt(String(T.rowNumber).trim(), 10);
      if (!n) { statusBox.textContent = 'Сначала впиши № строки в блоке «Строка в таблице возвратов».'; statusBox.style.color = '#B45309'; return; }
      copy(SHEET_URL + '&range=' + n + ':' + n, 'Ссылка на строку ' + n + ' в буфере ✓ Вставь в заметку OmniDesk');
    };
    colL.appendChild(rowLinkBtn);

    // 5) Калькулятор — только если куплено после 29.07
    calcBlock = mkBlock(colL, 'Калькулятор возврата (куплено после 29.07)');
    calcBlock.style.display = 'none';
    const bCalcOpen = el('button', S.btnAlt, '📗 Открыть калькулятор (своя вкладка)');
    bCalcOpen.onclick = () => { try { window.open(CALC_URL, '_blank'); } catch (e) { copy(CALC_URL, 'Ссылка на калькулятор в буфере ✓'); } };
    calcBlock.appendChild(bCalcOpen);
    const calcCol = comm => [num(T.amount), '', '', clean(T.accessDate), clean(T.claimDate), comm, ''].join('\n');
    const bCalcPre = el('button', S.big, '📋 Предварительный расчёт → «Оплаченная сумма» (C5)');
    bCalcPre.onclick = () => copy(calcCol('=C5*0,05'),
      '✓ Предв. расчёт в буфере → «Оплаченная сумма» 1-го блока, Ctrl+V.');
    const bCalcFin = el('button', S.big, '📋 Окончательный расчёт → «Оплаченная сумма» (C23)');
    bCalcFin.onclick = () => copy(calcCol(''),
      '✓ Оконч. расчёт в буфере → «Оплаченная сумма» 2-го блока, Ctrl+V.');
    calcBlock.appendChild(bCalcPre);
    calcBlock.appendChild(bCalcFin);
    calcBlock.appendChild(el('div', S.hint, 'Значения: сумма · [ак.ч.] · [дней] · дата доступа · дата обращения · комиссия · [CPL]. Вручную впиши: длительность курса (ак.ч./дней) и CPL; в оконч. расчёте — ещё комиссию по факту. «Итого» посчитается само.'));

    /* ============ ПРАВАЯ КОЛОНКА ============ */

    // 1) После переговоров: результат + (при «Возврате») согласованная сумма
    negBox = el('div', S.negBox);
    colR.appendChild(negBox);
    negBox.appendChild(el('div', S.blockHdr, '💬 После переговоров со студентом'));
    mkField(negBox, 'result', 'Результат', 'man', { list: RESULTS, save: 'rm_result', onChange: () => { syncAgreed(); updateScenario(); } });
    sumWrap = el('div', T.result === 'Возврат' ? '' : 'display:none;');
    sumWrap.appendChild(el('div', 'font-size:11px;font-weight:700;color:#374151;margin-top:8px;', 'Сумма возврата, ₽'));
    const sumInput = el('input', S.input);
    sumInput.style.cssText += 'font-size:17px;font-weight:800;text-align:center;color:#1F2937;border:1.5px solid #D1D5DB;margin-top:3px;padding:7px;';
    sumInput.placeholder = 'число ₽';
    sumInput.value = T.agreedSum;
    sumInput.addEventListener('input', () => { T.agreedSum = sumInput.value; saveCase(); updateScenario(); });
    inputs.agreedSum = sumInput;
    sumWrap.appendChild(sumInput);
    sumWrap.appendChild(el('div', 'font-size:9.5px;color:#6B7280;margin-top:4px;line-height:1.4;', 'Впиши конкретную сумму (число больше нуля). Пустым при «Возврате» оставлять нельзя.'));
    negBox.appendChild(sumWrap);

    errBox = el('div', S.err + 'display:none;');
    colR.appendChild(errBox);
    // При результате «Возврат» без конкретной суммы — не даём копировать сообщения продакту и карточку Асаны.
    const guardSum = () => {
      if (!sumMissing()) { if (errBox) errBox.style.display = 'none'; return true; }
      if (errBox) {
        errBox.textContent = '⚠️ Впиши «Сумму возврата» — конкретное число больше нуля. Без этого сообщение продакту и карточку Асаны скопировать нельзя.';
        errBox.style.display = 'block';
      }
      updateScenario();
      return false;
    };

    // 2) РГ — только при возврате ≤ 3 дней
    rgBlock = mkBlock(colR, 'Возврат ≤ 3 дней → передаём РГ', true);
    rgBlock.style.display = 'none';
    mkField(rgBlock, 'rgTag', 'Тег РГ в ТГ (из закрытой таблицы)', 'man', { ph: '@kondratev_av', save: 'rm_rg' });
    const bRG = el('button', S.big, '📨 Сообщение РГ');
    bRG.onclick = () => {
      const lines = [
        'Здравствуйте! Возврат в течение 3-х дней.',
        '1) ' + clean(T.amoLink),
        '2) ' + clean(T.course),
        '3) ' + (clean(T.rgTag) || B('тег РГ')),
        '4) Покупка ' + clean(T.purchaseDate || T.accessDate) + ', запрос возврата ' + clean(T.claimDate),
        '5) Причина: ',
        Q(clean(T.clientComment) || B('вставь текст клиента')),
        'Ответственный: ' + (clean(T.mop) || B('кто продал')),
        '',
        'Свяжитесь, пожалуйста. 🙏',
      ];
      copyMsg(lines.join('\n'), 'Сообщение для РГ в буфере ✓ Отправь в ТГ.');
    };
    rgBlock.appendChild(bRG);

    // 3) Сообщение продакту в Телеграм
    tgBlock = mkBlock(colR, '📨 Сообщение продакту в Телеграм', true);
    mkField(tgBlock, 'producer', 'Тег продакта в ТГ (по кластеру)', 'auto', { ph: '@hey_juliko' });
    const bTG = el('button', S.big, '📨 Скопировать сообщение для ТГ');
    bTG.onclick = () => {
      if (!guardSum()) return;
      const lines = [
        'Здравствуйте!',
        '1) ' + clean(T.amoLink),
        '2) ' + clean(T.course),
        '3) ' + clean(T.producer),
        '4) Покупка ' + clean(T.purchaseDate || T.accessDate) + ', запрос возврата ' + clean(T.claimDate),
        '5) ' + clean(T.progress) + '% прохождения',
        '6) Причина:',
        Q(clean(T.clientComment) || B('вставь текст клиента')),
        '7) ' + B('комментарий куратора — впиши'),
        '8) По оферте: ' + agreedTxt() + ' FYI',
      ];
      copyMsg(lines.join('\n'), 'Сообщение для ТГ в буфере ✓ Жирным — что дописать.');
    };
    tgBlock.appendChild(bTG);

    // 4) Карточка Асаны
    const payForTitle = () => {
      const pt = clean(T.payType);
      return /полн/i.test(pt) ? 'Полная (' + B('укажи банк') + ')' : pt;
    };
    const asanaTitle = () => payForTitle() + '/' + clean(T.name) + '/' + clean(T.course) + '/' + agreedTxt();
    const asanaBody = () => [
      'Куратор: ' + clean(T.curator),
      'Ссылка на амо: ' + clean(T.amoLink),
      'Сколько возвращаем: ' + agreed(),
      'Дата оплаты: ' + clean(T.purchaseDate || T.accessDate),
      'Дата обращения за возвратом: ' + clean(T.claimDate),
      'Согласование возврата (ссылка): ' + B('вставь ссылку на согласование в ТГ'),
    ].join('\n');
    const asanaBlock = mkBlock(colR, '🗂 Карточка Асаны', true);
    const rowA = el('div', S.row);
    const bAsanaT = el('button', S.btnAlt + 'flex:1;margin-top:0;', '📋 Заголовок');
    bAsanaT.onclick = () => { if (!guardSum()) return; copyMsg(asanaTitle(), 'Заголовок Асаны в буфере ✓ Жирным — что дописать.'); };
    const bAsanaB = el('button', S.btnAlt + 'flex:1;margin-top:0;', '📋 Описание');
    bAsanaB.onclick = () => { if (!guardSum()) return; copyMsg(asanaBody(), 'Описание карточки Асаны в буфере ✓ Жирным — что дописать (ссылка на согласование).'); };
    rowA.appendChild(bAsanaT); rowA.appendChild(bAsanaB);
    asanaBlock.appendChild(rowA);

    colR.appendChild(el('div', S.hint,
      'После согласования: карточка в Асане → Archived ❄ в админке → статус в таблице → ссылка на Асану в заметку → «Переоткрыть через…» в меню кейса.'));

    // № строки → подпись кнопки
    const updateRowLabels = () => { bAll.textContent = '📋 Копировать всю строку → вставить в A' + (T.rowNumber || '?'); };
    rowNumInput.addEventListener('input', () => {
      T.rowNumber = rowNumInput.value.replace(/\D/g, ''); rowNumInput.value = T.rowNumber;
      GM_setValue('rm_row', T.rowNumber); saveCase(); updateRowLabels();
    });
    updateRowLabels();
    // № строки ещё не вписан по этому кейсу → сразу подсказать свободную строку.
    if (!String(T.rowNumber).trim()) findRowInto('auto');

    // позиция / размер / свёрнутость. По умолчанию — прижата к правому краю
    // и широкая (раскрывается влево, «как книга»); ключи rm_pos2/rm_size2 —
    // старые узкие настройки сбрасываются один раз.
    let pos = null;
    try { pos = JSON.parse(GM_getValue('rm_pos2') || 'null'); } catch (e) { pos = null; }
    if (pos && isFinite(pos.x) && isFinite(pos.y)) {
      panel.style.left = Math.max(4, Math.min(pos.x, window.innerWidth - 70)) + 'px';
      panel.style.top = Math.max(4, Math.min(pos.y, window.innerHeight - 34)) + 'px';
    } else {
      panel.style.right = '16px'; panel.style.top = '46px';
    }
    try {
      const sz = JSON.parse(GM_getValue('rm_size2') || 'null');
      if (sz && sz.w >= 420) { panel.style.width = Math.min(sz.w, window.innerWidth - 20) + 'px'; }
      if (sz && sz.h >= 220) { panel.style.height = Math.min(sz.h, window.innerHeight - 20) + 'px'; }
    } catch (e) { /* размер по умолчанию */ }
    let collapsed = GM_getValue('rm_collapsed') === '1';
    let szT = 0;
    try {
      new ResizeObserver(() => {
        clearTimeout(szT);
        szT = setTimeout(() => {
          // в свёрнутом виде высота = auto (маленькая) — её не сохраняем, иначе окно откроется крошечным
          if (panel && !collapsed) GM_setValue('rm_size2', JSON.stringify({ w: panel.offsetWidth, h: panel.offsetHeight }));
        }, 400);
      }).observe(panel);
    } catch (e) { /* ResizeObserver недоступен — не страшно */ }
    // Свернуть (–): прячем тело и отпускаем высоту в auto, чтобы не оставалось пустое белое окно.
    // При разворачивании возвращаем прежнюю высоту и ручной ресайз.
    let savedH = '';
    const applyCollapsed = () => {
      if (collapsed) {
        if (panel.style.height && panel.style.height !== 'auto') savedH = panel.style.height;
        body.style.display = 'none';
        panel.style.height = 'auto';
        panel.style.minHeight = '0';
        panel.style.resize = 'none';
      } else {
        body.style.display = 'block';
        panel.style.minHeight = '200px';
        panel.style.resize = 'both';
        if (savedH) panel.style.height = savedH;
      }
      bCollapse.textContent = collapsed ? '▢' : '–';
    };
    applyCollapsed();
    bCollapse.onclick = () => { collapsed = !collapsed; GM_setValue('rm_collapsed', collapsed ? '1' : '0'); applyCollapsed(); };
    bClose.onclick = () => { if (panel) { panel.remove(); panel = null; } };

    document.documentElement.appendChild(panel);
    makeDraggable(panel, head);
    renderAmoCard();
    updateScenario();

    // автосбор из амо
    const refreshFromAmo = function () {
      statusBox.textContent = 'Собираю данные из амо…';
      statusBox.style.color = '#374151';
      collectRefundData().then(d => {
        T.amoLink = d.amoLink; T.omniLink = d.omniLink; T.purchaseDate = d.purchaseDate; T.mopFromNote = d.mopFromNote;
        const setF = (k, v) => { if (v) { T[k] = v; if (inputs[k] && inputs[k]._fill) inputs[k]._fill(v); else if (inputs[k]) inputs[k].value = v; } };
        setF('name', d.name); setF('course', d.course); setF('cluster', d.cluster);
        setF('payType', d.payType); setF('amount', d.amount); setF('mop', d.mop);
        if (d.purchaseDate) setF('accessDate', d.purchaseDate);
        // «Пройдено, %» — «0» тоже валидно (setF его бы пропустил как falsy)
        if (d.progress !== '') { T.progress = d.progress; if (inputs.progress) inputs.progress.value = d.progress; saveCase(); }
        T.producer = d.producer || PRODUCERS[T.cluster] || '';
        if (inputs.producer) inputs.producer.value = T.producer;

        // купленные курсы
        T.deals = d.deals || [];
        const savedDeal = T.deals.find(x => x.id === T.dealId);
        if (savedDeal && savedDeal.id !== d.dealId) {
          applyDeal(savedDeal, { refetch: true }); // куратор ранее выбрал другой курс — вернём его
        } else {
          T.dealId = d.dealId || (T.deals[0] && T.deals[0].id) || '';
        }
        renderDealPick();

        syncAgreed(); renderAmoCard(); updateScenario();

        const what = [];
        if (d.name) what.push('ФИО');
        if (d.course) what.push('курс');
        if (d.cluster) what.push('кластер');
        if (d.payType) what.push('оплата');
        if (d.amount) what.push('сумма');
        if (d.mop) what.push('МОП');
        if (d.purchaseDate) what.push('дата покупки');
        if (d.progress !== '') what.push('пройдено ' + d.progress + '%');
        const mopSure = d.mop && d.mopFromNote;
        // полный отчёт — в «ℹ️»
        lastAmoDetail =
          'Нашла ' + (d.foundBy || '') + (d.amoLink ? '\nСделка ' + d.amoId : '') + '\n' +
          (d.name ? 'ФИО «' + d.name + '»' + (d.nameSource ? ' — ' + d.nameSource : '') + '\n' : '') +
          ((T.deals || []).length > 1
            ? 'Купленные курсы (' + T.deals.length + '):\n' + T.deals.map(x =>
                '  ' + (x.id === T.dealId ? '● ' : '○ ') + (x.course || 'курс?') +
                (x.amount ? ' — ' + x.amount + ' ₽' : '') + (x.purchaseDate ? ' — ' + x.purchaseDate : '')).join('\n') +
              '\n(выбор — в жёлтой плашке «на какой возврат»)\n'
            : '') +
          'Подтянуто: ' + (what.length ? what.join(', ') : 'почти ничего — проверь руками') +
          (d.mop
            ? '\nМОП: ' + d.mop + (d.mopFromNote ? ' (из сообщения о продаже)' : ' (ОТВЕТСТВЕННЫЙ сделки — проверь!)')
            : '\nМОП не нашла — впиши руками, кто продал курс.') +
          (what.length < 6 ? '\nПусто? Открой карточку клиента в OmniDesk (виджет amoCRM) и нажми 🔄' : '');
        // в панели — только короткая строка
        const manyCourses = (T.deals || []).length > 1;
        const coursesNote = manyCourses ? ' · 🎓 курсов ' + T.deals.length + ' — ПРОВЕРЬ ВЫБОР' : '';
        if (!what.length) {
          statusBox.textContent = '⚠️ Из амо почти ничего — проверь карточку в OmniDesk, детали в «ℹ️»';
          statusBox.style.color = '#DC2626';
        } else if (what.length < 6 || !mopSure || manyCourses) {
          statusBox.textContent = '⚠️ Из амо' + (d.amoId ? ' (сделка ' + d.amoId + ')' : '') +
            (!mopSure ? ' · МОП проверь' : (!manyCourses ? ' · часть полей пуста' : '')) + coursesNote + ' — детали в «ℹ️»';
          statusBox.style.color = '#B45309';
        } else {
          statusBox.textContent = '✓ Данные из амо' + (d.amoId ? ' · сделка ' + d.amoId : '') + ' — детали в «ℹ️»';
          statusBox.style.color = '#15803D';
        }
      }).catch(e => {
        statusBox.textContent = e.message === 'NOAUTH'
          ? 'Амо не пустило 😕 Открой-обнови вкладку амо в этом браузере и нажми «🔄 амо».'
          : 'Ошибка амо: ' + e.message;
        statusBox.style.color = '#DC2626';
      });
    };
    bRefresh.onclick = refreshFromAmo;
    refreshFromAmo();
  }

  /* ---------- запуск ---------- */

  // Голубой круг 🌀 сверху экрана убран (v1.13) — Возврат-мастер открывается
  // из меню «ДОПОЛНИТЕЛЬНЫЕ ОПЦИИ». Чистим круг, если остался от старой версии.
  function removeLauncher() {
    const ex = document.getElementById('refund-master-btn');
    if (ex) ex.remove();
  }

  // Открыть Возврат-мастер. Закрываем висящий дропдаун, если он есть.
  function openFromEntry() {
    const cont = document.querySelector('.dropdown-menu-cont');
    if (cont && cont.style.display !== 'none') cont.style.display = 'none';
    buildPanel();
  }

  // Точка входа. Два варианта интерфейса омника:
  //  1) полный кейс — пункт «🌀 Возврат-мастер» первым в меню «ДОПОЛНИТЕЛЬНЫЕ ОПЦИИ» (футер левого сайдбара);
  //  2) чат «в бабле» — меню «ДОПОЛНИТЕЛЬНЫЕ ОПЦИИ» нет вообще, поэтому кладём кнопку-ссылку
  //     в нижнюю панель действий чата (рядом с «ПЕРЕНАПРАВИТЬ / ПЕРЕОТКРЫТЬ ЧЕРЕЗ»).
  function ensureMenuItem() {
    const list = document.querySelector('.chat_l_sidebar_footer .add-options ul.dropdown-list')
      || document.querySelector('.dropdown-trigger-cont.add-options ul.dropdown-list');

    if (list) {
      const stale = document.getElementById('rm-footer-btn');
      if (stale) stale.remove();
      if (document.getElementById('rm-menu-item')) return;
      const li = document.createElement('li');
      li.id = 'rm-menu-item';
      li.className = '';
      const a = document.createElement('a');
      a.className = 'dropdown-item';
      a.href = '#';
      a.textContent = '🌀 Возврат-мастер';
      a.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        const cont = list.closest('.dropdown-menu-cont');
        if (cont) cont.style.display = 'none';
        buildPanel();
      });
      li.appendChild(a);
      list.insertBefore(li, list.firstChild);
      return;
    }

    // режим «в бабле» — меню нет; кнопка в нижней панели действий чата
    const bar = document.querySelector('.footer-toolbar-inner');
    const sample = bar && (bar.querySelector('.chat_redirect') || bar.querySelector('span'));
    if (!bar || !sample) return;
    if (document.getElementById('rm-footer-btn')) return;
    const btn = document.createElement('span');
    btn.id = 'rm-footer-btn';
    btn.textContent = '🌀 ВОЗВРАТ-МАСТЕР';
    // как соседние ссылки панели: float:left, 12px/16px, отступ справа, курсор-рука
    btn.style.cssText = 'float:left;display:block;cursor:pointer;padding:10px 0 8px;margin:0 20px 0 0;' +
      'font:700 12px/16px Roboto,Helvetica,Arial,sans-serif;color:#0284C7;letter-spacing:.2px;';
    btn.addEventListener('mouseenter', function () { btn.style.color = '#075985'; });
    btn.addEventListener('mouseleave', function () { btn.style.color = '#0284C7'; });
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openFromEntry();
    });
    // после «float:left» ссылок (ПЕРЕНАПРАВИТЬ/ПЕРЕОТКРЫТЬ), до «float:right» ЗАВЕРШИТЬ ЧАТ
    const rightItem = bar.querySelector('.chat_close_and_archive');
    if (rightItem) bar.insertBefore(btn, rightItem);
    else bar.appendChild(btn);
  }

  if (location.hostname.endsWith('omnidesk.ru')) {
    console.log(TAG, 'запущен, версия ' + '1.27.0');
    removeLauncher();
    ensureMenuItem();
    setInterval(function () { removeLauncher(); ensureMenuItem(); }, 2000);
  }
})();
