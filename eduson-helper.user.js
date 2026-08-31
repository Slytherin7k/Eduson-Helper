// ==UserScript==
// @name         Eduson Helper — помощник куратора
// @namespace    eduson-helper
// @version      0.71.0
// @description  Помощник куратора в OmniDesk: магнит заполняет карточку клиента из amoCRM (ФИО, email, телефон, курс, поддержка, админка), кнопка-ключ — логин-линки, кнопка-чат — готовые пинги в Телеграм и поиск по справочнику тегов Эдюсон
// @author       Astanina Natalia
// @homepageURL  https://github.com/Slytherin7k/Eduson-Helper
// @updateURL    https://raw.githubusercontent.com/Slytherin7k/Eduson-Helper/main/eduson-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/Slytherin7k/Eduson-Helper/main/eduson-helper.user.js
// @match        https://eduson.amocrm.ru/*
// @match        https://*.omnidesk.ru/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      eduson.amocrm.ru
// @connect      amocrm.ru
// @connect      eduson.tv
// @connect      docs.google.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ================== НАСТРОЙКИ ================== */

  const AMO_SUBDOMAIN = 'eduson';

  const OMNI_FIELDS = {
    name:    '#field_1',
    email:   '#field_2',
    phone:   '#field_16',
    course:  '#field_4660',
    support: '#field_7301',
    admin:   '#field_7302',
    superuser: '#field_10307',
  };

  const LABELS = {
    name:    ['полное имя', 'фио', 'имя', 'name'],
    email:   ['email', 'e-mail', 'почта'],
    phone:   ['телефон', 'phone'],
    course:  ['курс', 'course'],
    support: ['поддержк', 'обслуживан'],
    admin:   ['админк', 'суперюзер', 'супер юзер', 'супер-юзер', 'admin'],
  };

  const RU = {
    name: 'ФИО', email: 'EMAIL', phone: 'ТЕЛЕФОН',
    course: 'КУРС', support: 'ДАТА ПОДДЕРЖКИ', admin: 'АДМИНКА',
  };

  const DEFAULT_SUPPORT_MONTHS = 12;

  // Всегда приводить имя к порядку «Фамилия Имя Отчество», как бы оно ни было записано в амо.
  // Заодно чинит РЕГИСТР, если имя пришло КАПСом или строчными.
  const NAME_FIO_ORDER = true;

  // Админка Эдюсона: искать ссылку на Super User и вписывать её в поле «АДМИНКА»
  const ADMIN_LOOKUP = true;
  const ADMIN_BASE   = 'https://www.eduson.tv';

  // Сопоставление названий курсов из amo → названия в OmniDesk
  // Формат: [регулярное_выражение_для_поиска_в_amo, название_в_омнидеске, месяцы_поддержки]
  // Если months === 0 — поддержки нет
  const COURSE_MAPPING = [
    // Excel
    [/excel.*тариф.*базовый/i, 'Excel Базовый (нет поддержки)', 0],
    [/excel.*базовый/i, 'Excel Базовый (нет поддержки)', 0],
    [/excel.*без поддержки/i, 'Excel Базовый (нет поддержки)', 0],
    [/excel.*про.*бухгалтер/i, 'Excel PRO (бухгалтер)', 3],
    [/excel.*pro.*бухгалтер/i, 'Excel PRO (бухгалтер)', 3],
    [/excel.*профессионал/i, 'Excel PRO (бухгалтер)', 3],
    [/excel.*тариф.*стандарт/i, 'Excel Стандарт', 12],
    [/excel.*стандарт/i, 'Excel Стандарт', 12],
    [/excel.*тариф.*премиум/i, 'Excel Премиум', 12],
    [/excel.*премиум/i, 'Excel Премиум', 12],
    [/excel.*тариф.*максимум/i, 'Excel Максимум', 12],
    [/excel.*максимум/i, 'Excel Максимум', 12],

    // Собственник
    [/собственник/i, 'Собственник', 24],

    // 1С
    [/1с.*базовый/i, '1С Базовый', 12],
    [/1с.*профессионал/i, '1С Профессионал', 12],
    [/1с.*эксперт/i, '1С Эксперт', 12],

    // Управление
    [/управление.*персонал/i, 'Управление персоналом', 12],
    [/управление.*проект/i, 'Управление проектами', 12],
    [/управление.*финанс/i, 'Управление финансами', 12],

    // Маркетинг
    [/маркетинг/i, 'Маркетинг', 12],
    [/smm/i, 'SMM', 12],
    [/таргет/i, 'Таргет', 12],

    // Дизайн
    [/дизайн/i, 'Дизайн', 12],
    [/figma/i, 'Figma', 12],
    [/photoshop/i, 'Photoshop', 12],

    // IT
    [/python/i, 'Python', 12],
    [/full[\s-]?stack|фул{1,2}[\s-]?ст[еэа]к/i, 'Fullstack на JavaScript', 12],
    [/javascript|js[\s-]?разработ/i, 'JavaScript-разработчик', 12],
    [/\bjava\b/i, 'Java', 12],
    [/sql/i, 'SQL', 12],

    // Аналитика / Data Science (в amo часто «Data scientist», в омнике — «Специалист Data Science»)
    [/(data.?scien|специалист data).*(pro|про)\b/i, 'Специалист Data Science. Тариф PRO', 12],
    [/data.?scien|специалист data|дата.?сай[еэ]нс/i, 'Специалист Data Science', 12],
  ];

  /* ================================================ */

  const VER = '0.71.0';
  const STORE_KEY = 'lastClient';
  const DEBUG_KEY = 'lastDebug';
  const IS_AMO  = location.hostname.endsWith('amocrm.ru');
  const IS_OMNI = location.hostname.endsWith('omnidesk.ru');
  const TAG = '[amohelper]';

  // Палитра — как у Возврат-мастера: голубой + чёрный/серый/белый, округлый шрифт.
  const HP_ACC = '#0284C7', HP_ACC_DK = '#075985', HP_ACC_LT = '#E0F2FE', HP_ACC_BD = '#BAE6FD';
  const HP_FONT = "'Nunito','Varela Round','Segoe UI',system-ui,-apple-system,Roboto,Arial,sans-serif";

  // Переменные для перетаскивания
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  // null → «поставить под кружком сверху по центру»; числа → куда перетащили
  let panelPosition = { x: null, y: null };

  // Загружаем сохранённую позицию (новый ключ — старую нижне-левую забываем)
  try {
    const saved = GM_getValue('helperPanelPos');
    if (saved) {
      panelPosition = JSON.parse(saved);
    }
  } catch (e) {}

  /* ---------- запросы к amoCRM ---------- */

  async function amoApi(path) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error('amoCRM API вернул ' + res.status);
    return res.json();
  }

  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        timeout: 15000,
        headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' },
        onload: function (res) {
          if (res.status === 200) {
            try { resolve(JSON.parse(res.responseText)); }
            catch (e) { reject(new Error('ответ амо не разбирается')); }
          } else if (res.status === 204) {
            resolve({});
          } else if (res.status === 401 || res.status === 403) {
            reject(new Error('NOAUTH'));
          } else {
            reject(new Error('амо ответило кодом ' + res.status));
          }
        },
        onerror: function () { reject(new Error('сеть или куки не пустили')); },
        ontimeout: function () { reject(new Error('долго нет ответа')); },
      });
    });
  }

  /* ---------- запросы к админке Эдюсона (только чтение HTML) ---------- */

  function gmFetchText(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        timeout: 20000,
        headers: { 'Accept': 'text/html' },
        onload: function (res) {
          const finalUrl = res.finalUrl || url;
          if (/\/(sign_in|login|users\/sign_in|auth)/i.test(finalUrl)) { reject(new Error('NOAUTH')); return; }
          if (res.status === 200) { resolve(res.responseText || ''); }
          else if (res.status === 401 || res.status === 403) { reject(new Error('NOAUTH')); }
          else if (res.status === 0) { reject(new Error('NOAUTH')); }
          else { reject(new Error('админка ответила кодом ' + res.status)); }
        },
        onerror: function () { reject(new Error('сеть или куки не пустили в админку')); },
        ontimeout: function () { reject(new Error('админка долго не отвечает')); },
      });
    });
  }

  function adminLooksLikeLogin(html) {
    return /type=["']password["']/i.test(html) && !/admin\/(super_users|users)\b/i.test(html);
  }

  function parseSuperUserIdsFromList(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const ids = [];
    doc.querySelectorAll('table tr').forEach(function (tr) {
      let id = null;
      const a = tr.querySelector('a[href*="/admin/super_users/"]');
      if (a) { const m = a.getAttribute('href').match(/super_users\/(\d+)/); if (m) id = m[1]; }
      if (!id) {
        const td = tr.querySelector('td');
        if (td && /^\d{5,}$/.test((td.textContent || '').trim())) id = (td.textContent || '').trim();
      }
      if (id && ids.indexOf(id) === -1) ids.push(id);
    });
    return ids;
  }

  function parseUserRowsFromList(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rows = [];
    doc.querySelectorAll('table tr').forEach(function (tr) {
      const a = tr.querySelector('a[href*="/admin/users/"]');
      if (!a) return;
      const m = a.getAttribute('href').match(/\/admin\/users\/(\d+)/);
      if (m && !rows.some(r => r.uid === m[1])) rows.push({ uid: m[1], text: (tr.textContent || '') });
    });
    return rows;
  }

  function parseSuperUserIdFromUserCard(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const p = Array.prototype.find.call(doc.querySelectorAll('p'),
      pp => /^\s*Super User\s*:/i.test(pp.textContent || ''));
    if (!p) return null;
    const a = p.querySelector('a[href*="/admin/super_users/"]');
    if (!a) return null;
    const m = a.getAttribute('href').match(/super_users\/(\d+)/);
    return m ? m[1] : null;
  }

  function parseSuperUserCourses(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const courses = [];
    doc.querySelectorAll('table tr').forEach(function (tr) {
      const a = tr.querySelector('a[href*="/admin/companies/"]');
      if (a) {
        const t = (a.textContent || '').trim();
        if (t && courses.indexOf(t) === -1) courses.push(t);
      }
    });
    return courses;
  }

  function superUserUrl(id) { return ADMIN_BASE + '/admin/super_users/' + id + '?language=ru'; }

  function userCardUrl(uid) { return ADMIN_BASE + '/admin/users/' + uid + '?language=ru'; }

  /* ---------- ФИО клиента из админки Эдюсон ---------- */

  // «Похоже на настоящее ФИО»: 2–4 слова, только буквы (кириллица/латиница), дефис ок, без цифр.
  function adminNameLooksReal(s) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    if (!t || /[0-9@()\/#]/.test(t)) return false;
    const w = t.split(' ');
    return w.length >= 2 && w.length <= 4 &&
      w.every(function (x) { return /^[А-ЯЁа-яёA-Za-z][А-ЯЁа-яёA-Za-z-]*$/.test(x); });
  }
  function adminNameWords(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().split(' ')
      .filter(function (w) { return w.length >= 2 && /[А-ЯЁа-яёA-Za-z]/.test(w); });
  }
  function hasPatronymic(s) {
    return /(?:ович|евич|овна|евна|ична|инична|оглы|кызы|улы|уулу)\b/i.test(String(s || ''));
  }
  // Карточка юзера /admin/users/<id>: <h1> = «Фамилия Имя [Отчество]».
  // Админка иногда дублирует слова: «Иванов Иванов Пётр Петрович Петрович» → чистим.
  function parseAdminUserName(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let h1 = ((doc.querySelector('h1') || {}).textContent || '').replace(/\s+/g, ' ').trim();
    h1 = h1.split(' ').filter(function (w, i, a) {
      return w.toLowerCase() !== (a[i - 1] || '').toLowerCase();
    }).join(' ');
    return adminNameLooksReal(h1) ? h1 : '';
  }

  // Набор слов ФИО (строчные, ё→е, латиница/кириллица, ≥2 букв). Для сравнения «тот же человек».
  function nameWordSet(s) {
    return new Set(String(s || '').toLowerCase().replace(/ё/g, 'е')
      .split(/[^a-zа-я0-9]+/).filter(function (w) { return w.length >= 2 && /[a-zа-я]/.test(w); }));
  }
  // «Это тот же человек»: совпали минимум 2 слова ФИО (фамилия+имя), в любом порядке;
  // либо у одного из имён всего одно слово и оно совпало.
  function sameName(a, b) {
    const A = nameWordSet(a), B = nameWordSet(b);
    if (!A.size || !B.size) return false;
    let common = 0;
    A.forEach(function (w) { if (B.has(w)) common++; });
    return common >= 2 || (common >= 1 && Math.min(A.size, B.size) === 1);
  }
  // Строка из списка /admin/users содержит нашу почту?
  function rowHasEmail(text, emails) {
    const t = String(text || '').toLowerCase();
    return (emails || []).some(function (e) { return e && t.indexOf(String(e).toLowerCase()) !== -1; });
  }
  // Страница Super User: таблица Sub Users (колонки First Name / Last Name).
  // Строку выбираем по совпадению почты/телефона клиента, иначе первую с полным именем. → «Фамилия Имя».
  function parseSuperUserSubName(html, emails, phones) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const digits = function (s) { return String(s || '').replace(/\D/g, '').slice(-10); };
    const wantE = (emails || []).map(function (e) { return String(e).toLowerCase().trim(); }).filter(Boolean);
    const wantP = (phones || []).map(digits).filter(Boolean);
    let tbl = null;
    doc.querySelectorAll('table').forEach(function (t) {
      const head = ((t.querySelector('tr') || {}).textContent || '').toLowerCase();
      if (head.indexOf('first name') !== -1 && head.indexOf('last name') !== -1) tbl = t;
    });
    if (!tbl) return '';
    const heads = [].map.call(tbl.querySelectorAll('tr')[0].querySelectorAll('th,td'),
      function (x) { return x.textContent.trim().toLowerCase(); });
    const iF = heads.indexOf('first name'), iL = heads.indexOf('last name');
    const iE = heads.indexOf('email'), iP = heads.indexOf('phone');
    if (iF < 0 || iL < 0) return '';
    const rows = [].slice.call(tbl.querySelectorAll('tr'), 1).map(function (tr) {
      return [].map.call(tr.querySelectorAll('td'), function (td) { return td.textContent.trim(); });
    });
    const compose = function (r) {
      const first = (r[iF] || '').replace(/\s+/g, ' ').trim();
      const last = (r[iL] || '').replace(/\s+/g, ' ').trim();
      return (last && first) ? last + ' ' + first : '';
    };
    let match = rows.find(function (r) {
      return (iE >= 0 && wantE.indexOf((r[iE] || '').toLowerCase()) !== -1) ||
             (iP >= 0 && wantP.indexOf(digits(r[iP])) !== -1);
    });
    const fio = (match && compose(match)) || (rows.map(compose).find(Boolean) || '');
    return adminNameLooksReal(fio) ? fio : '';
  }

  // Полное ФИО клиента из админки Эдюсон. Использует те же ссылки, что и заполнение поля «АДМИНКА»
  // (мемоизированный lookupAdminLinks), поэтому лишних поисков не делает.
  async function lookupAdminFio(data, seed) {
    if (!ADMIN_LOOKUP) return '';
    let r;
    try { r = await getAdminLinks(data); }
    catch (e) { return ''; }
    const links = (r && r.links) || [];
    const emails = (data.emails || []).concat((seed && seed.emails) || []);
    const phones = (data.phones || []).concat((seed && seed.phones) || []);
    for (const l of links.slice(0, 4)) {
      try {
        const html = await gmFetchText(l.url);
        if (adminLooksLikeLogin(html)) return '';
        const fio = /\/admin\/super_users\//.test(l.url)
          ? parseSuperUserSubName(html, emails, phones)
          : parseAdminUserName(html);
        if (fio) return fio;
      } catch (e) { if (e.message === 'NOAUTH') return ''; }
    }
    return '';
  }

  // Мемоизация lookupAdminLinks по объекту data — чтобы магнит не искал в админке дважды
  // (один раз для ФИО, второй раз для поля «АДМИНКА»). WeakMap: в GM-хранилище ничего лишнего.
  const _adminLinksCache = new WeakMap();
  function getAdminLinks(data) {
    if (!_adminLinksCache.has(data)) _adminLinksCache.set(data, lookupAdminLinks(data));
    return _adminLinksCache.get(data);
  }
  // Выбор между именем из амо и из админки: берём то, где больше слов;
  // при равенстве — где есть отчество; иначе оставляем амо.
  function fullerName(amoName, adminName) {
    const a = adminNameWords(amoName).length, b = adminNameWords(adminName).length;
    if (b > a) return adminName;
    if (b === a && b >= 2 && hasPatronymic(adminName) && !hasPatronymic(amoName)) return adminName;
    return amoName || adminName;
  }

  // «Login link» на карточке юзера (/admin/users/<id>) — вход без пароля.
  // Это по сути пароль: не логируем, не храним, только в буфер / ПКМ→инкогнито.
  function parseLoginLink(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const a = Array.prototype.find.call(doc.querySelectorAll('a'),
      function (x) { return /^\s*login\s*link\s*$/i.test(x.textContent || ''); });
    if (!a) return null;
    let href = (a.getAttribute('href') || '').trim();
    if (!href) return null;
    try { href = new URL(href, ADMIN_BASE).href; } catch (e) {}
    return /^https?:\/\//i.test(href) ? href : null;
  }

  // Название курса на карточке юзера в админке: строка "Company: <a>Название</a>".
  // Берём САМЫЙ МАЛЕНЬКИЙ элемент со словом "Company:" и ссылкой на компанию — иначе цепляем меню.
  function parseUserCardCourse(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let best = null, bestLen = 1e9;
    doc.querySelectorAll('p, div, td, li, span').forEach(function (e) {
      const t = e.textContent || '';
      if (!/company\s*:/i.test(t)) return;
      if (!e.querySelector('a[href*="/admin/companies/"]')) return;
      if (t.length < bestLen) { best = e; bestLen = t.length; }
    });
    const a = best && best.querySelector('a[href*="/admin/companies/"]');
    return a ? (a.textContent || '').trim() : '';
  }

  // Почта из логин-линка (для отсева сотрудников @eduson.tv).
  function loginLinkEmail(url) {
    try { return (new URL(url)).searchParams.get('user_email') || ''; } catch (e) { return ''; }
  }

  // Достаёт логин-линки ПО ПОЛЮ «АДМИНКА» карточки OmniDesk (ту ссылку, что уже нашёл магнит),
  // а не свободным поиском по почте — иначе можно попасть на чужой/демо-аккаунт с похожей почтой.
  function readAdminUrlsFromCard() {
    let el = document.querySelector(OMNI_FIELDS.admin);
    if (!el || !isVisible(el)) el = findOmniInput(LABELS.admin);
    const raw = el ? String(el.value || el.textContent || '') : '';
    const out = { superIds: [], userIds: [] };
    (raw.match(/\/admin\/super_users\/(\d+)/g) || []).forEach(function (m) {
      const id = m.match(/(\d+)/)[1];
      if (out.superIds.indexOf(id) === -1) out.superIds.push(id);
    });
    (raw.match(/\/admin\/users\/(\d+)/g) || []).forEach(function (m) {
      const id = m.match(/(\d+)/)[1];
      if (out.userIds.indexOf(id) === -1) out.userIds.push(id);
    });
    return out;
  }

  // Возвращает { links: [{course, url}], error: null|'NOAUTH'|'ADMINKA_EMPTY'|текст }
  async function lookupLoginLinks() {
    const src = readAdminUrlsFromCard();
    if (!src.superIds.length && !src.userIds.length) {
      return { links: [], error: 'ADMINKA_EMPTY' };
    }
    let authError = false, lastErr = '';
    const userIds = src.userIds.slice();

    // super_user → его sub-users (ТОЛЬКО из таблицы «Sub Users», не из меню/шапки страницы)
    for (const sid of src.superIds.slice(0, 4)) {
      try {
        const page = await gmFetchText(superUserUrl(sid));
        if (adminLooksLikeLogin(page)) { authError = true; continue; }
        const doc = new DOMParser().parseFromString(page, 'text/html');
        doc.querySelectorAll('table tr a[href*="/admin/users/"]').forEach(function (a) {
          const m = (a.getAttribute('href') || '').match(/\/admin\/users\/(\d+)/);
          if (m && userIds.indexOf(m[1]) === -1) userIds.push(m[1]);
        });
      } catch (e) { if (e.message === 'NOAUTH') authError = true; else lastErr = e.message; }
    }

    const links = [];
    for (const uid of userIds.slice(0, 8)) {
      try {
        const card = await gmFetchText(userCardUrl(uid));
        if (adminLooksLikeLogin(card)) { authError = true; continue; }
        const ll = parseLoginLink(card);
        if (ll && !/@eduson\.tv$/i.test(loginLinkEmail(ll)) && !links.some(function (x) { return x.url === ll; })) {
          links.push({ course: parseUserCardCourse(card), url: ll });
        }
      } catch (e) { if (e.message === 'NOAUTH') authError = true; else lastErr = e.message; }
    }

    if (!links.length) {
      return { links: [], error: authError ? 'NOAUTH' : (lastErr || 'на карточке(ах) в админке нет «Login link»') };
    }
    return { links: links, error: null };
  }

  // Запасной путь, если поле АДМИНКА пустое: строгий поиск по amo-номеру (без свободного email).
  async function lookupLoginLinksByAmoId(amoId) {
    if (!amoId) return { links: [], error: 'нет amo-номера' };
    let authError = false, lastErr = '';
    try {
      const listHtml = await gmFetchText(ADMIN_BASE + '/admin/users?language=ru&q=' + encodeURIComponent(amoId));
      if (adminLooksLikeLogin(listHtml)) return { links: [], error: 'NOAUTH' };
      const rows = parseUserRowsFromList(listHtml).filter(function (r) { return r.text.indexOf(String(amoId)) !== -1; });
      const links = [];
      for (const r of rows.slice(0, 6)) {
        const card = await gmFetchText(userCardUrl(r.uid));
        if (adminLooksLikeLogin(card)) { authError = true; continue; }
        const ll = parseLoginLink(card);
        if (ll && !/@eduson\.tv$/i.test(loginLinkEmail(ll)) && !links.some(function (x) { return x.url === ll; })) {
          links.push({ course: parseUserCardCourse(card), url: ll });
        }
      }
      if (links.length) return { links: links, error: null };
      return { links: [], error: authError ? 'NOAUTH' : 'по amo-номеру карточка в админке не нашлась' };
    } catch (e) {
      return { links: [], error: e.message === 'NOAUTH' ? 'NOAUTH' : e.message };
    }
  }

  // Из HTML/текста админки достаём amo_lead_id / amo_contact_id (в «Tracking info» вида
  // {"amo_lead_id"=>"46492748", "amo_contact_id"=>"72877002", ...}).
  function collectAmoIds(text, leadIds, contactIds) {
    const s = String(text || '');
    (s.match(/amo[_\-\s]*lead[_\-\s]*id["'\s]*(?:=>|:)?["'\s]*(\d{4,})/gi) || []).forEach(function (m) {
      const id = (m.match(/(\d{4,})/) || [])[1];
      if (id && leadIds.indexOf(id) === -1) leadIds.push(id);
    });
    (s.match(/amo[_\-\s]*contact[_\-\s]*id["'\s]*(?:=>|:)?["'\s]*(\d{4,})/gi) || []).forEach(function (m) {
      const id = (m.match(/(\d{4,})/) || [])[1];
      if (id && contactIds.indexOf(id) === -1) contactIds.push(id);
    });
  }

  // Запасной путь для СДЕЛКИ: активной сделки в амо по почте не нашлось →
  // идём в админку Эдюсон, ищем по почте/телефону, берём amo_lead_id из «Tracking info»
  // (в списке /admin/users он часто виден сразу; иначе — открываем карточку юзера и его Super User),
  // затем по этому номеру берём выигранную сделку из амо.
  async function findDealViaAdmin(seed, api) {
    const queries = [];
    (seed.emails || []).forEach(function (e) { if (e && !/@eduson\.tv$/i.test(e)) queries.push(e); });
    (seed.phones || []).forEach(function (p) { const d = String(p).replace(/\D/g, ''); if (d.length >= 10) queries.push(d.slice(-10)); });
    if (!queries.length) return {};

    let auth = false;
    const leadIds = [], contactIds = [];

    for (const q of queries.slice(0, 3)) {
      let listHtml;
      try { listHtml = await gmFetchText(ADMIN_BASE + '/admin/users?language=ru&q=' + encodeURIComponent(q)); }
      catch (e) { if (e.message === 'NOAUTH') auth = true; continue; }
      if (adminLooksLikeLogin(listHtml)) { auth = true; continue; }

      collectAmoIds(listHtml, leadIds, contactIds);            // трекинг часто прямо в списке
      if (leadIds.length || contactIds.length) break;

      const rows = parseUserRowsFromList(listHtml);
      for (const r of rows.slice(0, 3)) {
        collectAmoIds(r.text, leadIds, contactIds);
        let card = '';
        try { card = await gmFetchText(userCardUrl(r.uid)); }
        catch (e) { if (e.message === 'NOAUTH') auth = true; continue; }
        if (adminLooksLikeLogin(card)) { auth = true; continue; }
        collectAmoIds(card, leadIds, contactIds);

        const suId = parseSuperUserIdFromUserCard(card);       // Super User → его sub-users
        if (suId && !leadIds.length) {
          try {
            const sup = await gmFetchText(superUserUrl(suId));
            if (!adminLooksLikeLogin(sup)) {
              collectAmoIds(sup, leadIds, contactIds);
              const sdoc = new DOMParser().parseFromString(sup, 'text/html');
              const subUids = [];
              sdoc.querySelectorAll('table tr a[href*="/admin/users/"]').forEach(function (a) {
                const mm = (a.getAttribute('href') || '').match(/\/admin\/users\/(\d+)/);
                if (mm && mm[1] !== r.uid && subUids.indexOf(mm[1]) === -1) subUids.push(mm[1]);
              });
              for (const su of subUids.slice(0, 3)) {
                try { const sc = await gmFetchText(userCardUrl(su)); if (!adminLooksLikeLogin(sc)) collectAmoIds(sc, leadIds, contactIds); }
                catch (e) {}
              }
            }
          } catch (e) {}
        }
        if (leadIds.length) break;
      }
      if (leadIds.length || contactIds.length) break;
    }

    // по найденным lead_id — берём выигранную сделку
    for (const lid of leadIds.slice(0, 8)) {
      try {
        const l = await api('/api/v4/leads/' + lid + '?with=contacts');
        if (l && l.id && isWon(l)) return { lead: l };
      } catch (e) { if (e.message === 'NOAUTH') return { error: 'NOAUTH' }; }
    }
    // выигранных по lead_id нет — пробуем контакт
    for (const cid of contactIds.slice(0, 4)) {
      try {
        const c = await api('/api/v4/contacts/' + cid + '?with=leads');
        if (c && c.id) return { contact: c };
      } catch (e) { if (e.message === 'NOAUTH') return { error: 'NOAUTH' }; }
    }
    return auth ? { error: 'NOAUTH' } : {};
  }

  // Совпадение курса обращения с курсом карточки в админке (по общим словам).
  function courseTokens(s) {
    return normCourse(s).split(' ').filter(function (w) {
      return w.length >= 3 && ['pro', 'про', 'для', 'при', 'тариф', 'курс'].indexOf(w) === -1;
    });
  }
  function courseOverlap(a, b) {
    const A = courseTokens(a), B = courseTokens(b);
    if (!A.length || !B.length) return 0;
    let n = 0;
    A.forEach(function (w) { if (B.indexOf(w) !== -1) n++; });
    return n;
  }
  function pickLoginLinkByCourse(links, target) {
    if (links.length <= 1) return links[0] || null;
    if (!target) return null;
    const scored = links.map(function (l) { return { l: l, s: courseOverlap(l.course, target) }; })
      .sort(function (x, y) { return y.s - x.s; });
    if (scored[0].s >= 2 && scored[0].s > (scored[1] ? scored[1].s : 0)) return scored[0].l;
    return null;
  }

  // Возвращает { links:[{url,courses,name}], isSuper:bool, error, ambiguous:bool }
  // isSuper=true  → это Super User, links ведут на /admin/super_users/<N>, ставим галочку СУПЕРЮЗЕР
  // isSuper=false → Super User нет, links ведут на карточку(и) юзера /admin/users/<id>
  //
  // ВАЖНО (кейс 568-975223, Попова Анна): при B2B-сделке один amo_lead_id висит на ДЕСЯТКАХ
  // юзеров (все участники обучения), у всех в трекинге один и тот же amo_contact_id покупателя.
  // Поэтому: по общему ключу (lead) берём ТОЛЬКО строки, где ФИО/почта совпали с нашим клиентом;
  // без совпадения по ФИО/почте — ничего не вставляем (лучше пусто, чем 20 чужих карточек).
  async function lookupAdminLinks(data) {
    const wantName = data.name || '';
    const wantEmails = (data.emails || []).map(function (e) { return String(e).toLowerCase().trim(); })
      .filter(function (e) { return e && !/@eduson\.tv$/i.test(e); });
    const canVerify = !!(wantName || wantEmails.length);

    // специфичные ключи (укажут на конкретного человека) — вперёд; общий lead — в конец
    const specific = [];
    if (data.amoContactId) specific.push(String(data.amoContactId));
    wantEmails.slice(0, 2).forEach(function (e) { specific.push(e); });
    const shared = [];
    if (data.cardAmoId && String(data.cardAmoId) !== String(data.amoLeadId)) shared.push(String(data.cardAmoId));
    if (data.amoLeadId) shared.push(String(data.amoLeadId));
    const keys = specific.concat(shared);
    if (!keys.length) return { links: [], isSuper: false, error: null };

    let authError = false, lastErr = '';

    // 1. Ищем строки в /admin/users по каждому ключу (до первого попадания)
    const userRows = [];
    for (let ki = 0; ki < keys.length; ki++) {
      const q = keys[ki];
      const isShared = ki >= specific.length;
      let raw;
      try {
        const html = await gmFetchText(ADMIN_BASE + '/admin/users?language=ru&q=' + encodeURIComponent(q));
        if (adminLooksLikeLogin(html)) { authError = true; continue; }
        raw = parseUserRowsFromList(html);
      } catch (e) { if (e.message === 'NOAUTH') authError = true; else lastErr = e.message; continue; }
      if (!raw.length) continue;

      let rows;
      if (isShared) {
        // общий ключ: только совпавшие по ФИО/почте; без возможности проверить — пропускаем
        if (!canVerify) continue;
        rows = raw.filter(function (r) { return sameName(r.text, wantName) || rowHasEmail(r.text, wantEmails); });
        if (!rows.length) continue;
      } else {
        rows = raw;
        // специфичный ключ вернул подозрительно много — тоже сузим по ФИО/почте, если можем
        if (canVerify && raw.length > 3) {
          const strict = raw.filter(function (r) { return sameName(r.text, wantName) || rowHasEmail(r.text, wantEmails); });
          if (strict.length) rows = strict;
        }
      }
      rows.forEach(function (r) { if (!userRows.some(function (u) { return u.uid === r.uid; })) userRows.push(r); });
      if (userRows.length) break;
    }
    if (!userRows.length) return { links: [], isSuper: false, error: authError ? 'NOAUTH' : (lastErr || null) };

    // 2. Открываем карточки, ещё раз сверяем ФИО/почту по самой карточке, собираем Super User / ссылки
    const superIds = [], cardUrls = [], nameByKey = {};
    for (const r of userRows.slice(0, 10)) {
      let card;
      try {
        card = await gmFetchText(userCardUrl(r.uid));
      } catch (e) { if (e.message === 'NOAUTH') authError = true; else lastErr = e.message; continue; }
      if (adminLooksLikeLogin(card)) { authError = true; continue; }
      if (canVerify) {
        const cardName = parseAdminUserName(card);
        const emailOk = wantEmails.some(function (e) { return card.toLowerCase().indexOf(e) !== -1; });
        const nameOk = sameName(cardName || r.text, wantName);
        if (!emailOk && !nameOk) continue; // не наш человек — мимо
      }
      const suId = parseSuperUserIdFromUserCard(card);
      // имя для окошка выбора: h1 карточки, иначе — из строки списка (после id, до курса/трекинга)
      const nm = parseAdminUserName(card) ||
        (String(r.text || '').replace(/^\s*\d+\s*/, '').match(/^[А-ЯЁA-Z][А-ЯЁа-яёA-Za-z-]+(?:\s+[А-ЯЁA-Z][А-ЯЁа-яёA-Za-z-]+){0,2}/) || ['аккаунт'])[0];
      if (suId) {
        if (superIds.indexOf(suId) === -1) { superIds.push(suId); nameByKey['s' + suId] = nm; }
      } else {
        const u = userCardUrl(r.uid);
        if (cardUrls.indexOf(u) === -1) { cardUrls.push(u); nameByKey[u] = nm; }
      }
    }

    if (superIds.length) {
      const links = [];
      for (const id of superIds.slice(0, 8)) {
        let courses = [];
        try {
          const page = await gmFetchText(superUserUrl(id));
          if (!adminLooksLikeLogin(page)) courses = parseSuperUserCourses(page);
        } catch (e) { /* название курса не критично */ }
        links.push({ url: superUserUrl(id), courses: courses, name: nameByKey['s' + id] || '' });
      }
      return { links: links, isSuper: true, error: null, ambiguous: links.length > 1 };
    }
    if (cardUrls.length) {
      return {
        links: cardUrls.map(function (u) { return { url: u, courses: [], name: nameByKey[u] || '' }; }),
        isSuper: false, error: null, ambiguous: cardUrls.length > 1,
      };
    }
    return { links: [], isSuper: false, error: authError ? 'NOAUTH' : (lastErr || null) };
  }

  function fillAdminField(links) {
    let el = document.querySelector(OMNI_FIELDS.admin);
    if (!el || !isVisible(el)) el = findOmniInput(LABELS.admin);
    if (!el) return { ok: false, why: 'поле «АДМИНКА» не нашлось (карточка в режиме «Изменить»?)' };
    const urls = links.map(function (l) { return l.url; });
    const val = (el.tagName === 'TEXTAREA') ? urls.join('\n') : urls.join(' ');
    setNativeValue(el, val);
    return (el.value || '').trim() ? { ok: true } : { ok: false, why: 'написала, но значение не прижилось' };
  }

  // Ставит галочку в чекбоксе OmniDesk (iCheck). Никогда не снимает.
  function checkOmniCheckbox(sel) {
    const el = document.querySelector(sel);
    if (!el) return { ok: false, why: 'чекбокс не нашёлся' };
    if (!el.checked) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
      if (setter && setter.set) setter.set.call(el, true); else el.checked = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('ifChecked'));
      el.dispatchEvent(new Event('ifChanged'));
    }
    // Визуальная обёртка iCheck
    const wrap = el.closest('.icheckbox_square-blue') || el.parentElement;
    if (wrap) wrap.classList.add('checked');
    return { ok: !!el.checked };
  }

  async function runAdminFill(data, ok, miss) {
    if (!ADMIN_LOOKUP) return;
    if (!data.amoLeadId && !data.amoContactId && !data.cardAmoId && !(data.emails || []).length) {
      miss.push(RU.admin + ' — нет amo-номера/почты, чтобы искать в админке');
      return;
    }
    let r;
    try { r = await getAdminLinks(data); }
    catch (e) { miss.push(RU.admin + ' — ошибка: ' + e.message); return; }

    let links = r.links || [];
    // Несколько совпадений (у студента 2+ аккаунта / у разных людей одинаковое ФИО) —
    // спрашиваем куратора, какие ссылки вписать (а не суём все).
    if (links.length > 1) {
      const chosen = await chooseAdminLinks(links, data.name || '');
      links = chosen || [];
      if (!links.length) { ok.push(RU.admin + ' — куратор выбрал не вписывать'); return; }
    }

    if (links.length) {
      data.admin = links.map(function (l) { return l.url; });
      data.isSuper = !!r.isSuper;
      const res = fillAdminField(links);
      const kind = r.isSuper ? 'Super User' : 'карточка юзера, Super User нет';
      const many = links.length > 1 ? ', ' + links.length + ' шт — все в буфере' : '';
      if (res.ok) ok.push(RU.admin + ' (' + kind + many + ')');
      else miss.push(RU.admin + ' — ' + res.why);
      if (links.length > 1) {
        try { GM_setClipboard(data.admin.join('\n')); } catch (e) {}
      }
      if (r.isSuper) {
        const cb = checkOmniCheckbox(OMNI_FIELDS.superuser);
        if (cb.ok) ok.push('СУПЕРЮЗЕР ✓');
        else miss.push('СУПЕРЮЗЕР — ' + (cb.why || 'галочка не поставилась'));
      }
    } else if (r.error === 'NOAUTH') {
      miss.push(RU.admin + ' — админка не пустила (открой www.eduson.tv и залогинься, потом жми снова)');
    } else if (r.error) {
      miss.push(RU.admin + ' — ' + r.error);
    } else {
      miss.push(RU.admin + ' — по ФИО/почте студент в админке не нашёлся (впиши ссылку руками)');
    }
  }

  /* ---------- даты ---------- */
  function fmtTs(ts) {
    const d = new Date(ts * 1000);
    return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + d.getFullYear();
  }
  function plusMonthsTs(ts, months) {
    const d = new Date(ts * 1000);
    const day = d.getDate();
    d.setMonth(d.getMonth() + months);
    if (d.getDate() < day) d.setDate(0);
    return fmtTs(Math.floor(d.getTime() / 1000));
  }

  /* ---------- сроки поддержки ---------- */
  function parseSupportFromLabel(label) {
    const s = String(label || '');
    if (/нет поддержки/i.test(s)) return 0;
    let m = s.match(/(\d+)\s*мес/i);
    if (m) return parseInt(m[1], 10);
    m = s.match(/(\d+)\s*год/i);
    if (m) return parseInt(m[1], 10) * 12;
    return null;
  }

  // НОВАЯ ФУНКЦИЯ: определяем месяцы поддержки по названию курса из amo
  function getSupportMonthsForCourse(courseName) {
    const c = String(courseName || '').toLowerCase();

    // Сначала проверяем по маппингу
    for (const [regex, omniName, months] of COURSE_MAPPING) {
      if (regex.test(c)) {
        return months;
      }
    }

    // Если не нашли в маппинге, используем старую логику
    if (c.includes('собственник')) return 24;
    if ((c.includes('excel') || c.includes('таблиц')) &&
        (c.includes('про') || c.includes('pro') || c.includes('бухгалтер'))) return 3;
    return DEFAULT_SUPPORT_MONTHS;
  }

  // НОВАЯ ФУНКЦИЯ: находим название курса в OmniDesk по названию из amo
  function findOmniCourseName(amoCourseName) {
    const c = String(amoCourseName || '').toLowerCase();

    // Проверяем по маппингу
    for (const [regex, omniName, months] of COURSE_MAPPING) {
      if (regex.test(c)) {
        return omniName;
      }
    }

    // Если не нашли, возвращаем как есть (попробуем найти похожее)
    return amoCourseName;
  }

  /* ---------- разбор полей amo ---------- */
  function amoFieldValue(f, lowerName) {
    const raw = (f.values || []).map(v => v.value).filter(v => v != null && String(v).trim() !== '');
    if (!raw.length) return '';
    let v = String(raw[0]).trim();
    if (/дат|поддерж|обслуживан|окончан|конец/.test(lowerName)) {
      if (/^\d{10}$/.test(v)) {
        const d = new Date(+v * 1000);
        v = String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + d.getFullYear();
      } else if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
        const p = v.slice(0, 10).split('-');
        v = p[2] + '.' + p[1] + '.' + p[0];
      }
    }
    return v;
  }
  function amoFieldValues(f) {
    return (f.values || []).map(v => String(v.value).trim()).filter(v => v !== '');
  }
  function courseFieldScore(n) {
    if (/продукт для шаблон/.test(n)) return 6;
    if (/категор/.test(n)) return 5;
    if (/курс|course/.test(n) && !/номинал|бюджет|цен|стоим/.test(n)) return 3;
    if (/программ/.test(n)) return 1;
    return 0;
  }
  function readAmoFields(fields, data, contactInfo) {
    let bestCourse = '', bestCourseScore = 0;
    (fields || []).forEach(f => {
      const n = (f.field_name || '').toLowerCase();
      const values = amoFieldValues(f);
      if (!values.length) return;
      if (contactInfo !== false) {
        if (/телефон|phone/.test(n)) {
          if (!data.phones) data.phones = [];
          values.forEach(v => {
            const clean = v.replace(/\s/g, '');
            const exists = data.phones.some(p => p.replace(/\D/g, '').slice(-10) === clean.replace(/\D/g, '').slice(-10));
            if (!exists) {
              data.phones.push(v);
            }
          });
        }
        else if (/e-?mail|почта/.test(n)) {
          if (!data.emails) data.emails = [];
          values.forEach(v => {
            const clean = v.toLowerCase().trim();
            const exists = data.emails.some(e => e.toLowerCase().trim() === clean);
            if (!exists) {
              data.emails.push(v);
            }
          });
        }
        else if (/(поддерж|обслуживан)/.test(n) && /(дат|окончан|конец)/.test(n)) {
          if (!data.support) data.support = values[0];
        }
        else if (/покуп|оплат|платеж|платёж|поступлен/.test(n) && /дат|срок/.test(n)) {
          if (!data.purchase) data.purchase = values[0];
        }
      }
      const cs = courseFieldScore(n);
      if (cs > bestCourseScore) { bestCourse = values[0]; bestCourseScore = cs; }
    });
    if (!data.course && bestCourseScore > 0) data.course = bestCourse;
  }
  // Слить в карточку ТОЛЬКО телефоны и почты доп. контакта — когда в окне
  // «нашлось несколько человек» куратор отметил галочками сразу нескольких
  // (у одного студента бывает 2–3 карточки амо с разными почтами/телефонами).
  // Курс, поддержку и сделку берём только из основного контакта.
  function mergeContactExtras(contact, data) {
    (((contact || {}).custom_fields_values) || []).forEach(function (f) {
      const n = (f.field_name || '').toLowerCase();
      const values = amoFieldValues(f);
      if (!values.length) return;
      if (/телефон|phone/.test(n)) {
        if (!data.phones) data.phones = [];
        values.forEach(function (v) {
          const clean = v.replace(/\s/g, '');
          if (!data.phones.some(p => p.replace(/\D/g, '').slice(-10) === clean.replace(/\D/g, '').slice(-10))) data.phones.push(v);
        });
      } else if (/e-?mail|почта/.test(n)) {
        if (!data.emails) data.emails = [];
        values.forEach(function (v) {
          const clean = v.toLowerCase().trim();
          if (!data.emails.some(e => e.toLowerCase().trim() === clean)) data.emails.push(v);
        });
      }
    });
  }
  /* ---------- закрытая (успешная) сделка ---------- */
  function isWon(l) {
    return l.status_id === 142 || (!!l.closed_at && l.status_id !== 143);
  }
  function dealCoursePreview(lead) {
    let best = '', bestScore = 0;
    (((lead || {}).custom_fields_values) || []).forEach(function (f) {
      const n = (f.field_name || '').toLowerCase();
      const values = amoFieldValues(f);
      if (!values.length) return;
      const cs = courseFieldScore(n);
      if (cs > bestScore) { best = values[0]; bestScore = cs; }
    });
    return best || String((lead && lead.name) || 'сделка');
  }
  function chooseDeal(deals) {
    return new Promise(function (resolve) {
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483647;background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(15,23,42,.35);padding:18px;max-width:460px;width:92%;font-family:' + HP_FONT + ';';
      // ✕ — жёсткая отмена всего заполнения
      const x = document.createElement('button');
      x.textContent = '✕';
      x.title = 'Отменить заполнение';
      x.style.cssText = 'position:absolute;top:8px;right:10px;background:none;border:none;font-size:16px;line-height:1;color:#9CA3AF;cursor:pointer;padding:4px;font-family:inherit;';
      x.onmouseenter = function () { x.style.color = '#EF4444'; };
      x.onmouseleave = function () { x.style.color = '#9CA3AF'; };
      x.onclick = function () { box.remove(); resolve('__CANCEL__'); };
      box.appendChild(x);
      const title = document.createElement('div');
      title.style.cssText = 'font-size:14px;font-weight:700;color:#111827;margin-bottom:4px;padding-right:18px;';
      title.textContent = 'У студента несколько оплаченных сделок 📚';
      const sub = document.createElement('div');
      sub.style.cssText = 'font-size:12px;color:#6B7280;margin-bottom:12px;';
      sub.textContent = 'Из какой взять курс и дату покупки?';
      box.appendChild(title);
      box.appendChild(sub);
      deals.slice(0, 6).forEach(function (l) {
        const btn = document.createElement('button');
        btn.style.cssText = 'display:block;width:100%;text-align:left;background:#F9FAFB;border:1px solid #E5E7EB;border-radius:10px;padding:10px 12px;margin-bottom:8px;cursor:pointer;font-size:13px;color:#111827;white-space:pre-wrap;';
        const lines = ['📚 ' + dealCoursePreview(l)];
        if (l.closed_at) lines.push('📅 куплено: ' + fmtTs(l.closed_at));
        btn.textContent = lines.join('\n');
        btn.onclick = function () { box.remove(); resolve(l); };
        box.appendChild(btn);
      });
      const cancel = document.createElement('button');
      cancel.style.cssText = 'background:none;border:none;color:#0284C7;font-size:12px;cursor:pointer;padding:4px;';
      cancel.textContent = 'Не брать курс и дату (только ФИО, почта, телефон)';
      cancel.onclick = function () { box.remove(); resolve(null); };
      box.appendChild(cancel);
      document.documentElement.appendChild(box);
    });
  }

  // Выбор ссылок для поля «АДМИНКА»: когда после сверки по ФИО/почте осталось >1 совпадения
  // (у студента может быть несколько аккаунтов; либо ФИО у разных людей совпало). Куратор
  // отмечает галочками, какие вставлять. Возвращает массив выбранных links (может быть пустым).
  function chooseAdminLinks(links, clientName) {
    return new Promise(function (resolve) {
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483647;background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(15,23,42,.35);padding:18px;max-width:460px;width:92%;font-family:' + HP_FONT + ';';
      const title = document.createElement('div');
      title.style.cssText = 'font-size:14px;font-weight:700;color:#111827;margin-bottom:4px;';
      title.textContent = 'Несколько совпадений в админке 🖥';
      const sub = document.createElement('div');
      sub.style.cssText = 'font-size:12px;color:#6B7280;margin-bottom:12px;';
      sub.textContent = 'Отметь, какие ссылки вписать в поле «АДМИНКА»' +
        (clientName ? ' (клиент: ' + clientName + ')' : '') + '.';
      box.appendChild(title);
      box.appendChild(sub);

      const cbs = [];
      links.slice(0, 10).forEach(function (l) {
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;gap:9px;align-items:flex-start;background:#F9FAFB;border:1px solid #E5E7EB;border-radius:10px;padding:10px 12px;margin-bottom:8px;cursor:pointer;font-size:13px;color:#111827;';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = true;
        cb.style.cssText = 'width:15px;height:15px;cursor:pointer;margin-top:1px;flex:0 0 auto;';
        cbs.push({ cb: cb, link: l });
        const txt = document.createElement('div');
        const nm = String(l.name || 'аккаунт').replace(/[<>&]/g, '');
        const crs = (l.courses && l.courses.length) ? l.courses.slice(0, 2).join(', ').replace(/[<>&]/g, '') : '';
        txt.innerHTML = '<div style="font-weight:600;">' + nm + '</div>' +
          (crs ? '<div style="font-size:11px;color:#6B7280;margin-top:2px;">📚 ' + crs + '</div>' : '') +
          '<div style="font-size:10px;color:#9CA3AF;margin-top:2px;word-break:break-all;">' +
          String(l.url).replace(/[<>&]/g, '').replace(/\?language=ru$/, '') + '</div>';
        row.appendChild(cb); row.appendChild(txt);
        box.appendChild(row);
      });

      const go = document.createElement('button');
      go.style.cssText = 'display:block;width:100%;background:' + HP_ACC + ';border:none;color:#fff;border-radius:10px;padding:10px;cursor:pointer;font-size:13px;font-weight:700;font-family:inherit;margin-top:2px;';
      go.textContent = 'Вставить отмеченные';
      go.onclick = function () {
        box.remove();
        resolve(cbs.filter(function (x) { return x.cb.checked; }).map(function (x) { return x.link; }));
      };
      box.appendChild(go);
      const skip = document.createElement('button');
      skip.style.cssText = 'background:none;border:none;color:#0284C7;font-size:12px;cursor:pointer;padding:6px 4px 0;display:block;margin:2px auto 0;font-family:inherit;';
      skip.textContent = 'Не вставлять ничего';
      skip.onclick = function () { box.remove(); resolve([]); };
      box.appendChild(skip);
      document.documentElement.appendChild(box);
    });
  }

  async function courseFromNotes(leadId, api) {
    try {
      const res = await api('/api/v4/leads/' + leadId + '/notes?limit=250');
      const notes = (res && res._embedded && res._embedded.notes) || [];
      for (const n of notes) {
        const text = JSON.stringify(n.params || {});
        const m = text.match(/курс[а-яё]*[^«"“]{0,60}[«"“]([^»"”]{2,80})[»"”]/i);
        if (m) return m[1].trim();
      }
    } catch (e) { if (e.message === 'NOAUTH') throw e; }
    return '';
  }
  async function applyLeadToData(lead, data, api, override) {
    if (override) { data.course = ''; data.support = ''; data.purchaseTs = 0; }
    readAmoFields(lead.custom_fields_values, data, false);
    data.purchaseTs = data.purchaseTs || lead.closed_at || 0;
    if (!data.course && lead.id) data.course = await courseFromNotes(lead.id, api);
    // Используем новую функцию для определения поддержки
    const months = getSupportMonthsForCourse(data.course);
    if (!data.support && data.purchaseTs) {
      if (months === 0) {
        data.support = ''; // Нет поддержки
      } else {
        data.support = plusMonthsTs(data.purchaseTs, months);
      }
    }
    // Сохраняем месяцы поддержки в data для отладки
    data.supportMonths = months;
  }
  function newClientData(source) {
    return { name: '', emails: [], phones: [], course: '', support: '', purchase: '',
             purchaseTs: 0, amoLeadId: 0, amoContactId: 0, cardAmoId: '',
             admin: [], isSuper: false, supportMonths: 0, noPurchase: false,
             source: source, ts: Date.now() };
  }
  async function assembleDataInto(contact, data, api) {
    data.amoContactId = data.amoContactId || contact.id || 0;
    data.name = data.name || String(contact.name || '').trim() ||
      [contact.first_name, contact.last_name].filter(Boolean).join(' ').trim();
    readAmoFields(contact.custom_fields_values, data);
    if (data.course && data.purchaseTs) {
      // Если уже есть курс и дата покупки, пересчитываем поддержку
      const months = getSupportMonthsForCourse(data.course);
      if (months === 0) {
        data.support = '';
      } else {
        data.support = plusMonthsTs(data.purchaseTs, months);
      }
      data.supportMonths = months;
      return data;
    }
    const leadIds = (((contact._embedded || {}).leads) || []).map(l => l.id).slice(0, 8);
    const leads = [];
    for (const lid of leadIds) {
      try {
        const l = await api('/api/v4/leads/' + lid);
        if (l && l.id) leads.push(l);
      } catch (e) { if (e.message === 'NOAUTH') throw e; }
    }
    const wonLeads = leads.filter(isWon).sort((a, b) => (b.closed_at || 0) - (a.closed_at || 0));
    if (!wonLeads.length) {
      // Клиент ещё не покупал курс (нет сделки WIN 100%), но контакт есть.
      if (data.name || (data.emails && data.emails.length)) {
        data.noPurchase = true;
        data.course = 'не покупал';
        data.support = '';
        data.supportMonths = 0;
      }
      return data;
    }
    let useLead = wonLeads[0];
    if (wonLeads.length > 1) useLead = await chooseDeal(wonLeads);
    if (useLead === '__CANCEL__') throw new Error('CANCELLED');
    if (useLead) {
      data.amoLeadId = useLead.id || data.amoLeadId;
      await applyLeadToData(useLead, data, api, true);
      data.chosenDeal = { id: useLead.id, course: dealCoursePreview(useLead),
                          closed: useLead.closed_at ? fmtTs(useLead.closed_at) : '' };
    }
    return data;
  }
  /* ---------- режим 1: кнопка внутри amoCRM ---------- */
  async function collectFromAmo() {
    const m = location.pathname.match(/\/(contacts|leads)\/detail\/(\d+)/);
    if (!m) { toast('Открой карточку клиента или сделки в amoCRM', 'warn'); return; }
    const [, type, id] = m;
    const data = newClientData(location.href);
    try {
      if (type === 'contacts') {
        const c = await amoApi('/api/v4/contacts/' + id + '?with=leads');
        await assembleDataInto(c, data, amoApi);
      } else {
        const l = await amoApi('/api/v4/leads/' + id + '?with=contacts');
        const cs = (l._embedded || {}).contacts || [];
        const cid = (cs.find(c => c.is_main) || cs[0] || {}).id;
        if (cid) {
          const c = await amoApi('/api/v4/contacts/' + cid + '?with=leads');
          await assembleDataInto(c, data, amoApi);
        }
        if (isWon(l) || !data.name) await applyLeadToData(l, data, amoApi);
      }
    } catch (e) {
      console.error(TAG, 'ошибка чтения amoCRM:', e);
      toast('Не получилось прочитать amoCRM.\nНажми F12 → вкладка Console и пришли текст возле ' + TAG, 'error');
      return;
    }
    if (data.name) data.name = fioOrder(data.name) || data.name;
    GM_setValue(STORE_KEY, data);
    console.log(TAG, 'данные:', data);
    toast(data, 'ok');
  }
  /* ---------- чтение данных клиента со страницы OmniDesk ---------- */
  function readCardValueNear(patterns, kind) {
    const labs = document.querySelectorAll('label, h6, [class*="label"]');
    const results = [];
    for (const p of patterns) {
      const pl = p.toLowerCase();
      for (const lab of labs) {
        const t = (lab.textContent || '').trim().toLowerCase();
        if (!t.includes(pl)) continue;
        let el = lab.parentElement;
        for (let i = 0; i < 5 && el; i++) {
          const text = el.innerText || '';
          if (kind === 'email') {
            const matches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
            if (matches) {
              matches.forEach(m => {
                if (!m.toLowerCase().endsWith('@eduson.tv') && !results.includes(m)) {
                  results.push(m);
                }
              });
            }
          } else {
            grabPhonesFromText(text).forEach(clean => {
              if (!results.includes(clean)) results.push(clean);
            });
          }
          el = el.parentElement;
        }
      }
    }
    return results;
  }
  function looksLikePhone(v) {
    if (/[a-zа-яё]/i.test(v) || v.includes('://')) return false;
    const d = v.replace(/\D/g, '');
    return d.length >= 10 && d.length <= 13;   // РФ 10–11, СНГ/зарубеж до 13 (напр. +375…)
  }
  // Телефоны из текста: РФ (+7/8) и зарубеж (+375, +380, +77, +998…). Двухступенчато:
  // кандидат по форме → отсев по числу цифр (10–13), чтобы не ловить номера обращений и id.
  function grabPhonesFromText(text) {
    const cands = String(text || '').match(/(?:\+\d{1,3}|\b8)[\s()\-–—.]{0,3}\d[\d\s()\-–—.]{6,16}\d/g) || [];
    const out = [];
    cands.forEach(function (c) {
      const d = c.replace(/\D/g, '');
      if (d.length >= 10 && d.length <= 13) {
        const clean = c.replace(/\s/g, '');
        if (out.indexOf(clean) === -1) out.push(clean);
      }
    });
    return out;
  }
  function grabContactSeed() {
    const seed = { phones: [], emails: [] };
    const emailVals = readCardValueNear(['email-адрес', 'e-mail', 'email', 'почта'], 'email');
    const phoneVals = readCardValueNear(['телефон', 'phone'], 'phone');
    emailVals.forEach(e => { if (!seed.emails.includes(e)) seed.emails.push(e); });
    phoneVals.forEach(p => { if (!seed.phones.includes(p)) seed.phones.push(p); });
    document.querySelectorAll('input, textarea').forEach(el => {
      const v = (el.value || '').trim();
      if (!v) return;
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && !v.toLowerCase().endsWith('@eduson.tv')) {
        if (!seed.emails.includes(v)) seed.emails.push(v);
      }
      if (looksLikePhone(v)) {
        const clean = v.replace(/\s/g, '');
        if (!seed.phones.includes(clean)) seed.phones.push(clean);
      }
    });
    const text = document.body.innerText || '';
    const emailMatches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
    if (emailMatches) {
      emailMatches.forEach(m => {
        if (!m.toLowerCase().endsWith('@eduson.tv') && !seed.emails.includes(m)) {
          seed.emails.push(m);
        }
      });
    }
    grabPhonesFromText(text).forEach(clean => {
      if (!seed.phones.includes(clean)) seed.phones.push(clean);
    });
    return seed;
  }
  function grabAmoIdFromPage() {
    const direct = document.querySelector('#field_-8380000');
    if (direct) {
      const m = (direct.value || '').match(/\b\d{6,10}\b/);
      if (m) return m[0];
    }
    const labs = document.querySelectorAll('label, h6, [class*="label"]');
    for (const lab of labs) {
      const t = (lab.textContent || '').trim();
      if (!/amocrm/i.test(t)) continue;
      let p = lab.parentElement;
      for (let i = 0; i < 5 && p; i++) {
        const m = (p.innerText || '').match(/\b\d{6,10}\b/);
        if (m) return m[0];
        p = p.parentElement;
      }
    }
    return '';
  }
  /* ---------- поиск клиента в амо ---------- */
  async function fetchClientById(id, seed, base) {
    const api = function (path) { return gmFetch(base + path); };
    let lead = null;
    try {
      lead = await api('/api/v4/leads/' + id + '?with=contacts');
      if (!(lead && lead.id)) lead = null;
    } catch (e) { if (e.message === 'NOAUTH') throw e; }
    if (lead) {
      const refs = ((lead._embedded || {}).contacts) || [];
      const contacts = [];
      for (const ref of refs.slice(0, 5)) {
        if (!ref || !ref.id) continue;
        try {
          const c = await api('/api/v4/contacts/' + ref.id + '?with=leads');
          if (c && c.id) contacts.push(c);
        } catch (e) { if (e.message === 'NOAUTH') throw e; }
      }
      if (contacts.length) {
        contacts.forEach(function (c) { scoreCandidate(c, seed); });
        contacts.sort(function (a, b) {
          return (b._score - a._score) || ((b.updated_at || 0) - (a.updated_at || 0));
        });
      }
      let chosen = null;
      if (contacts.length === 1) {
        chosen = contacts[0];
      } else if (contacts.length > 1) {
        contacts[0]._preferred = true;
        chosen = await chooseCandidate(contacts, seed);
        if (!chosen) throw new Error('CANCELLED');
      }
      const d = newClientData(base + (chosen ? '/contacts/detail/' + chosen.id : '/leads/detail/' + lead.id));
      d.amoLeadId = lead.id || 0;
      if (chosen) d.amoContactId = chosen.id || 0;
      if (isWon(lead)) {
        const wonLeads = [lead];
        if (chosen) {
          const otherLeadIds = (((chosen._embedded || {}).leads) || []).map(l => l.id).slice(0, 8);
          for (const lid of otherLeadIds) {
            if (lid === lead.id) continue;
            try {
              const l = await api('/api/v4/leads/' + lid);
              if (l && l.id && isWon(l)) wonLeads.push(l);
            } catch (e) { /* тихо пропускаем */ }
          }
        }
        wonLeads.sort((a, b) => (b.closed_at || 0) - (a.closed_at || 0));
        let useLead = wonLeads[0];
        if (wonLeads.length > 1) {
          useLead = await chooseDeal(wonLeads);
        }
        if (useLead === '__CANCEL__') throw new Error('CANCELLED');
        if (useLead) {
          d.amoLeadId = useLead.id || d.amoLeadId;
          await applyLeadToData(useLead, d, api, true);
          d.chosenDeal = { id: useLead.id, course: dealCoursePreview(useLead),
                           closed: useLead.closed_at ? fmtTs(useLead.closed_at) : '' };
        }
      }
      if (chosen) {
        d.name = String(chosen.name || '').trim() ||
          [chosen.first_name, chosen.last_name].filter(Boolean).join(' ').trim();
        readAmoFields(chosen.custom_fields_values, d, true);
        (chosen._mergeExtra || []).forEach(function (x) { mergeContactExtras(x, d); });
        if (contacts.length) {
          d.dealContacts = contacts.map(function (c) {
            const cEmails = [], cPhones = [];
            (c.custom_fields_values || []).forEach(f => {
              const n = (f.field_name || '').toLowerCase();
              const vals = amoFieldValues(f);
              if (/e-?mail|почта/.test(n)) vals.forEach(v => cEmails.push(v));
              if (/телефон|phone/.test(n)) vals.forEach(v => cPhones.push(v));
            });
            return { id: c.id, name: candidateName(c), emails: cEmails, phones: cPhones,
                     matchEmail: seed.emails.some(e => cEmails.some(ce => ce.toLowerCase() === e.toLowerCase())),
                     matchPhone: seed.phones.some(p => cPhones.some(cp => cp.replace(/\D/g, '').slice(-10) === p.replace(/\D/g, '').slice(-10))),
                     chosen: chosen && c.id === chosen.id };
          });
        }
      }
      return d;
    }
    try {
      const c = await api('/api/v4/contacts/' + id + '?with=leads');
      if (c && c.id) {
        const d = newClientData(base + '/contacts/detail/' + c.id);
        await assembleDataInto(c, d, api);
        return d;
      }
    } catch (e) { if (e.message === 'NOAUTH') throw e; }
    return null;
  }
  /* ---------- поиск по почте/телефону ---------- */
  function scoreCandidate(c, seed) {
    let s = 0;
    c._matchEmail = false; c._matchPhone = false;
    c._hintEmails = []; c._hintPhones = [];
    (c.custom_fields_values || []).forEach(function (f) {
      const n = (f.field_name || '').toLowerCase();
      const vals = amoFieldValues(f);
      if (!vals.length) return;
      if (/e-?mail|почта/.test(n)) {
        vals.forEach(v => {
          c._hintEmails.push(v);
          if (seed.emails.some(e => e.toLowerCase() === v.toLowerCase())) c._matchEmail = true;
        });
      }
      if (/телефон|phone/.test(n)) {
        vals.forEach(v => {
          const clean = v.replace(/\D/g, '').slice(-10);
          c._hintPhones.push(v);
          if (seed.phones.some(p => p.replace(/\D/g, '').slice(-10) === clean)) c._matchPhone = true;
        });
      }
    });
    if (c._matchEmail) s += 6;
    if (c._matchPhone) s += 3;
    const name = String(c.name || '').trim() || [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
    if (name) s += 1;
    if ((((c._embedded || {}).leads) || []).length) s += 1;
    c._score = s;
  }
  async function searchAmoCandidates(seed, base) {
    const queries = [];
    seed.emails.forEach(e => queries.push(e));
    seed.phones.forEach(p => {
      queries.push(p);
      const digits = p.replace(/\D/g, '');
      if (digits && digits !== p) queries.push(digits);
    });
    const byId = new Map();
    for (const q of queries) {
      let res;
      try {
        res = await gmFetch(base + '/api/v4/contacts?query=' + encodeURIComponent(q) + '&with=leads');
      } catch (e) {
        if (e.message === 'NOAUTH') throw e;
        continue;
      }
      (((res._embedded || {}).contacts) || []).forEach(function (c) {
        if (c && c.id && !byId.has(c.id)) byId.set(c.id, c);
      });
    }
    const list = Array.from(byId.values());
    list.forEach(function (c) { scoreCandidate(c, seed); });
    list.sort(function (a, b) {
      return (b._score - a._score) || ((b.updated_at || 0) - (a.updated_at || 0));
    });
    return list;
  }
  function candidateName(c) {
    return String(c.name || '').trim() ||
      [c.first_name, c.last_name].filter(Boolean).join(' ').trim() ||
      '(без имени)';
  }

  /* ---------- порядок имени: всегда «Фамилия Имя Отчество» ---------- */
  var FIO_MALE = ('александр алексей анатолий андрей антон аркадий арсений артем артур афанасий богдан ' +
    'борис вадим валентин валерий василий вениамин виктор виталий владимир владислав влад всеволод ' +
    'вячеслав геннадий георгий герман глеб григорий давид даниил данила данил денис дмитрий ' +
    'евгений егор ефим захар иван игнат игорь илья иннокентий кирилл константин кузьма лев леонид ' +
    'лука макар максим марк матвей мирон мирослав михаил моисей назар наум никита николай олег павел петр ' +
    'платон прохор родион роман ростислав руслан савва савелий святослав семен сергей спартак ' +
    'станислав степан тарас тимофей тимур тихон федор филипп фома эдуард эмиль юрий яков ян ярослав ' +
    'азамат азат айрат алан альберт амир арсен аскар ахмед батыр булат дамир ильдар ильдус ильнур ' +
    'ильшат ирек ислам иса камиль карен магомед марат мурад мурат наиль нариман нурлан рамазан рамиль ' +
    'рашид ринат рифат рустам рустем тагир тамерлан фарид хасан шамиль эльдар эрик').split(' ');
  var FIO_FEMALE = ('алена алина алиса алла анастасия ангелина анжела анна антонина алевтина валентина ' +
    'валерия варвара вера вероника виктория галина дарья диана дина ева евгения екатерина елена ' +
    'елизавета жанна зинаида зоя инна ирина карина кира кристина ксения лариса лидия лилия любовь ' +
    'людмила маргарита марина мария марьяна милана надежда наталья наталия нина оксана олеся ольга ' +
    'полина раиса регина римма светлана снежана софия софья таисия тамара татьяна ульяна элина ' +
    'эльвира юлия яна азиза айгуль айна алсу амина гузель дарина зарина зульфия камила лейла мадина ' +
    'малика сабина самира фатима эльмира юлдуз').split(' ');
  var FIO_MALE_SET = new Set(FIO_MALE);
  var FIO_NAME_SET = new Set(FIO_MALE.concat(FIO_FEMALE));

  var FIO_PARTICLE = /^(оглы|оглу|кызы|гызы|уулу|улы)$/;

  function fioLow(w) { return String(w || '').toLowerCase().replace(/ё/g, 'е'); }
  function fioIsName(w) { return FIO_NAME_SET.has(fioLow(w)); }
  function fioPatrStem(t) {
    var m = t.match(/^(.+?)(ович|евич|ьевич|ьич|ич|овна|евна|инична|ична)$/);
    if (!m) return null;
    var st = m[1];
    var known = FIO_MALE_SET.has(st) || FIO_MALE_SET.has(st + 'ий') || FIO_MALE_SET.has(st + 'й') ||
      FIO_MALE_SET.has(st + 'а') || FIO_MALE_SET.has(st + 'я') || FIO_MALE_SET.has(st.replace(/ь$/, 'ий'));
    return { suf: m[2], known: known };
  }
  // «сильное» отчество: тюркская частица или основа = известное мужское имя
  function fioStrongPatr(w) {
    var t = fioLow(w);
    if (FIO_PARTICLE.test(t)) return true;
    var s = fioPatrStem(t);
    return !!(s && s.known);
  }
  // «слабое» отчество: длинное однозначное окончание, но основу не опознали (для 3–4-словных ФИО)
  function fioWeakPatr(w) {
    var s = fioPatrStem(fioLow(w));
    return !!(s && /^(ович|евич|ьевич|овна|евна|инична|ична)$/.test(s.suf));
  }
  function fioCase(w) {
    if (/[А-ЯЁ]/.test(w) && /[а-яё]/.test(w)) return w;      // смешанный регистр — оставляем как есть
    return w.replace(/[А-Яа-яЁёA-Za-z]+/g, function (p) {
      return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
    });
  }
  function fioOrder(raw) {
    if (!NAME_FIO_ORDER) return raw;
    var s = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!s || !/[а-яё]/i.test(s)) return raw;                 // пусто или не кириллица — не трогаем
    var toks = s.replace(/,/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (toks.length < 2 || toks.length > 4) return s;

    // отчество ищем только в ФИО из 3+ слов (в двух словах «-ович» — обычно фамилия)
    var patrIdx = -1;
    if (toks.length >= 3) {
      for (var i = toks.length - 1; i >= 0; i--) { if (fioStrongPatr(toks[i])) { patrIdx = i; break; } }
      if (patrIdx < 0) for (var i2 = toks.length - 1; i2 >= 0; i2--) { if (fioWeakPatr(toks[i2])) { patrIdx = i2; break; } }
    }

    var patr = '', rest = toks.slice();
    if (patrIdx >= 0) {
      patr = toks[patrIdx];
      rest.splice(patrIdx, 1);
      // тюркская частица «оглы/кызы/…» — приклеиваем к ней имя отца слева
      if (FIO_PARTICLE.test(fioLow(patr)) && patrIdx > 0) {
        patr = toks[patrIdx - 1] + ' ' + patr;
        rest.splice(patrIdx - 1, 1);
      }
    }

    var nameIdx = -1;
    for (var j = 0; j < rest.length; j++) { if (fioIsName(rest[j])) { nameIdx = j; break; } }

    var surn, given;
    if (nameIdx >= 0) {
      given = rest[nameIdx];
      var sr = rest.slice(); sr.splice(nameIdx, 1);
      surn = sr.join(' ');
    } else if (patrIdx >= 0) {
      // имя по словарю не опознали — опираемся на позицию отчества
      if (patrIdx === toks.length - 1) {          // «Фамилия… Имя Отчество»
        given = rest[rest.length - 1];
        surn = rest.slice(0, -1).join(' ');
      } else {                                    // отчество впереди/в середине → «Имя Фамилия…»
        given = rest[0];
        surn = rest.slice(1).join(' ');
      }
    } else {
      return s;                                   // 2 слова без словарного имени — не рискуем
    }
    if (!surn || !given) return s;
    var out = fioCase(surn) + ' ' + fioCase(given) + (patr ? ' ' + fioCase(patr) : '');
    out = out.replace(/(^|\s)(Оглы|Оглу|Кызы|Гызы|Уулу|Улы)(?=\s|$)/g, function (_, a, b) { return a + b.toLowerCase(); });
    return out.replace(/\s+/g, ' ').trim();
  }
  // Окно «нашлось несколько человек». ГЛАВНОЕ действие — НАЖАТЬ на того, кто наш студент
  // (его данные и пойдут в карточку). Возвращает выбранный контакт. Если у студента несколько
  // карточек в амо — куратор ставит галочку «＋ слить» у остальных, тогда их телефоны/почты
  // добавятся к выбранному (в ._mergeExtra). По умолчанию ничего не слито — так безопаснее,
  // когда на одной сделке разные люди с общей почтой.
  function chooseCandidate(candidates, seed) {
    return new Promise(function (resolve) {
      const list = candidates.slice(0, 6);
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483647;background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(15,23,42,.35);padding:18px;max-width:480px;width:92%;font-family:' + HP_FONT + ';';
      const title = document.createElement('div');
      title.style.cssText = 'font-size:14px;font-weight:700;color:#111827;margin-bottom:4px;';
      title.textContent = 'В амо нашлось несколько человек 👥';
      const sub = document.createElement('div');
      sub.style.cssText = 'font-size:12px;color:#6B7280;margin-bottom:12px;';
      const by = [...seed.emails, ...seed.phones].filter(Boolean);
      sub.textContent = 'Нажми на того, кто наш студент — его данные пойдут в карточку.' +
        (by.length ? ' В карточке Омни: ' + by.join(', ') + '.' : '') +
        ' Если у студента несколько карточек в амо — отметь «＋ слить» у остальных.';
      box.appendChild(title);
      box.appendChild(sub);

      const cbs = new Map();
      list.forEach(function (c) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;align-items:stretch;margin-bottom:8px;';

        const pick = document.createElement('button');
        pick.style.cssText = 'flex:1;text-align:left;background:#F9FAFB;border:1px solid #E5E7EB;border-radius:10px;padding:10px 12px;cursor:pointer;font-size:13px;color:#111827;font-family:inherit;';
        pick.onmouseenter = function () { pick.style.background = '#E0F2FE'; pick.style.borderColor = '#7DD3FC'; };
        pick.onmouseleave = function () { pick.style.background = '#F9FAFB'; pick.style.borderColor = '#E5E7EB'; };
        const hints = [];
        if (c._hintEmails && c._hintEmails.length) hints.push('✉️ ' + c._hintEmails.slice(0, 3).join(', ') + (c._hintEmails.length > 3 ? ' …' : ''));
        if (c._hintPhones && c._hintPhones.length) hints.push('📞 ' + c._hintPhones.slice(0, 2).join(', '));
        if (c._matchEmail) hints.push('✅ почта совпала');
        else if (c._matchPhone) hints.push('✅ телефон совпал');
        pick.innerHTML = '<div style="font-weight:600;">' + (c._preferred ? '⭐ ' : '') +
          String(candidateName(c)).replace(/[<>&]/g, '') + '</div>' +
          (hints.length ? '<div style="font-size:11.5px;color:#6B7280;margin-top:2px;">' + hints.join('  ·  ').replace(/[<>]/g, '') + '</div>' : '');
        pick.onclick = function () {
          c._mergeExtra = list.filter(function (x) { return x !== c && cbs.get(x) && cbs.get(x).checked; });
          box.remove();
          resolve(c);
        };

        const mlab = document.createElement('label');
        mlab.title = 'слить телефоны и почты этой карточки в выбранного студента';
        mlab.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;border:1px solid #E5E7EB;border-radius:10px;padding:0 9px;cursor:pointer;font-size:9px;color:#6B7280;font-weight:700;flex:0 0 auto;';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.style.cssText = 'width:15px;height:15px;cursor:pointer;margin:0;';
        cbs.set(c, cb);
        mlab.appendChild(cb);
        mlab.appendChild(document.createTextNode('＋ слить'));

        row.appendChild(pick);
        row.appendChild(mlab);
        box.appendChild(row);
      });

      const cancel = document.createElement('button');
      cancel.style.cssText = 'background:none;border:none;color:#0284C7;font-size:12px;cursor:pointer;padding:6px 4px 0;display:block;margin:2px auto 0;font-family:inherit;';
      cancel.textContent = 'Отмена — никого не выбирать';
      cancel.onclick = function () { box.remove(); resolve(null); };
      box.appendChild(cancel);
      document.documentElement.appendChild(box);
    });
  }
  /* ---------- режим 2: кнопка в OmniDesk ---------- */
  async function smartFillOmni() {
    const base = 'https://' + AMO_SUBDOMAIN + '.amocrm.ru';
    const api = function (path) { return gmFetch(base + path); };
    const seed = grabContactSeed();
    const amoId = grabAmoIdFromPage();
    console.log(TAG, 'amo-номер:', amoId || '—', '| телефоны:', seed.phones, '| email:', seed.emails);
    let data = null, err = null, note = '';
    if (amoId) {
      toast('Виджу amo-номер ' + amoId + ' — иду в амо…', 'info', 6000);
      try { data = await fetchClientById(amoId, seed, base); }
      catch (e) { err = e; }
    }
    if (!err && !data && (seed.phones.length || seed.emails.length)) {
      const by = [];
      if (seed.phones.length) by.push('телефону ' + seed.phones.join(', '));
      if (seed.emails.length) by.push('email ' + seed.emails.join(', '));
      toast('amo-номера нет — ищу по ' + by.join(' и ') + '…', 'info', 6000);
      let candidates = [];
      try { candidates = await searchAmoCandidates(seed, base); }
      catch (e) { err = e; }
      if (!err && candidates.length) {
        let chosen = candidates[0];
        const second = candidates[1];
        // спрашиваем, если счёт близкий ИЛИ по контактам совпало сразу несколько человек
        // (бывает: на одной сделке разные люди с общей почтой — сам выбирать нельзя)
        const matchCount = candidates.filter(function (c) { return c._matchEmail || c._matchPhone; }).length;
        if (candidates.length > 1 && (matchCount > 1 || (chosen._score - (second ? second._score : 0)) < 4)) {
          chosen = await chooseCandidate(candidates, seed);
        }
        if (chosen) {
          const d = newClientData(base + '/contacts/detail/' + chosen.id);
          try {
            await assembleDataInto(chosen, d, api);
            (chosen._mergeExtra || []).forEach(function (x) { mergeContactExtras(x, d); });
            data = d;
            if (candidates.length > 1) {
              const extra = (chosen._mergeExtra || []).length;
              note = 'нашла поиском, выбрала: ' + candidateName(chosen) + (extra ? ' (+ ещё ' + extra + ' — слила почты/телефоны)' : '');
            }
          } catch (e) { err = e; }
        } else {
          toast('Хорошо, никого не выбираю 🙂', 'info');
          return;
        }
      }
    }
    if (err) {
      if (err.message === 'CANCELLED') { toast('Хорошо, никого не выбираю 🙂', 'info'); return; }
      console.error(TAG, 'ошибка:', err);
      if (err.message === 'NOAUTH') {
        toast('Браузер не пустил меня в амо 😕\nОткрой амо в соседней вкладке, убедись что залогинена,\nи нажми магнит ещё раз.', 'warn', 12000);
      } else {
        toast('Не получилось связаться с амо: ' + err.message, 'error');
      }
      return;
    }
    // Запасной путь: оплаченной сделки в амо по контактам клиента нет.
    // Частый случай — курс купили ДРУГОМУ человеку: в амо контакт покупателя (с другой
    // почтой), а в карточке OmniDesk — обучающийся. В админке Эдюсон у обучающегося в
    // «Tracking info» есть amo_lead_id / amo_contact_id — по ним и берём сделку из амо.
    const noDealYet = !data || data.noPurchase || data.course === 'не покупал'
      || (!data.chosenDeal && !data.course);
    if (!err && noDealYet && (seed.emails.length || seed.phones.length)) {
      toast('Оплаченной сделки в амо по клиенту не вижу — смотрю в админке Эдюсон…', 'info', 9000);
      try {
        const adm = await findDealViaAdmin(seed, api);
        let viaAdmin = false;
        if (adm && adm.lead) {
          if (!data) data = newClientData(base + '/leads/detail/' + adm.lead.id);
          data.noPurchase = false;
          data.course = ''; data.support = ''; data.purchaseTs = 0; data.supportMonths = 0;
          data.amoLeadId = adm.lead.id || data.amoLeadId;
          await applyLeadToData(adm.lead, data, api, true);
          data.chosenDeal = { id: adm.lead.id, course: dealCoursePreview(adm.lead),
                              closed: adm.lead.closed_at ? fmtTs(adm.lead.closed_at) : '' };
          viaAdmin = true;
        } else if (adm && adm.contact) {
          const d2 = newClientData(base + '/contacts/detail/' + adm.contact.id);
          try {
            await assembleDataInto(adm.contact, d2, api);
            if (!d2.noPurchase && d2.course && d2.course !== 'не покупал') {
              if (data && data.name) d2.name = data.name;
              data = d2;
              viaAdmin = true;
            }
          } catch (e) { /* NOAUTH или иное — оставляем что было */ }
        }
        if (viaAdmin) {
          note = (note ? note + '; ' : '') + 'сделку нашла через админку Эдюсон (возможно, курс купили другому человеку)';
          data.viaAdmin = true;
          // контакт в сделке — покупателя; амо-contact-id покупателя для поиска карточки
          // обучающегося не годится (ищем строго по его почте/телефону).
          data.amoContactId = 0;
          // почты/телефоны обучающегося — с карточки OmniDesk, не покупателя из сделки
          (seed.emails || []).forEach(function (e) {
            if (!/@eduson\.tv$/i.test(e) && data.emails.indexOf(e) === -1) data.emails.unshift(e);
          });
          (seed.phones || []).forEach(function (p) {
            if (data.phones.indexOf(p) === -1) data.phones.unshift(p);
          });
        }
      } catch (e) { /* админка недоступна — оставляем как есть */ }
    }
    if (!data || (!data.name && !data.emails.length && !data.phones.length && !data.course && !data.support)) {
      GM_setValue(DEBUG_KEY, { version: VER, url: location.href, amoId: amoId, seed: seed, result: 'ничего не нашлось', ts: Date.now() });
      toast('В амо ничего не нашлось 😕', 'warn');
      return;
    }
    data.cardAmoId = amoId || '';
    if (data.name) {
      var nameFio = fioOrder(data.name);
      if (nameFio && nameFio !== data.name) {
        note = (note ? note + '; ' : '') + 'имя переставила в порядок ФИО';
        data.name = nameFio;
      }
    }
    // ФИО должно быть полное: сравниваем имя из амо с ФИО из админки Эдюсон, берём где больше слов.
    // Если сделку нашли через админку (курс купили другому) — имя обучающегося берём из админки
    // (по его почте), а НЕ из контакта покупателя в сделке.
    try {
      const adminFio = await lookupAdminFio(data, seed);
      if (adminFio) {
        const useAdmin = data.viaAdmin && adminNameWords(adminFio).length >= 2;
        const better = useAdmin ? adminFio : fullerName(data.name || '', adminFio);
        if (better && better !== data.name) {
          note = (note ? note + '; ' : '') + (useAdmin ? 'ФИО обучающегося — из админки Эдюсон' : 'ФИО взяла из админки Эдюсон (полнее)');
          data.name = fioOrder(better) || better;
        }
      }
    } catch (e) { /* админка не критична для имени */ }
    GM_setValue(STORE_KEY, data);
    GM_setValue(DEBUG_KEY, { version: VER, url: location.href, amoId: amoId, seed: seed, data: data, note: note, ts: Date.now() });
    console.log(TAG, 'данные из амо:', data);
    fillInputsFromData(data, 'Нашлось в амо' + (note ? '\n(' + note + ')' : ''));
  }
  /* ---------- заполнение формы OmniDesk ---------- */
  function isVisible(el) { return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); }
  function controlFromLabelEl(lab) {
    let ctl = lab.control || (lab.htmlFor ? document.getElementById(lab.htmlFor) : null);
    if (ctl) return ctl;
    let p = lab.parentElement;
    for (let i = 0; i < 4 && p; i++) {
      ctl = p.querySelector('input:not([type=hidden]), textarea, select');
      if (ctl) return ctl;
      p = p.parentElement;
    }
    return null;
  }
  function findOmniInput(patterns) {
    for (const p of patterns) {
      const pl = p.toLowerCase();
      try {
        const byAttr = document.querySelector(
          'input[placeholder*="' + pl + '" i], textarea[placeholder*="' + pl + '" i], input[name*="' + pl + '" i]'
        );
        if (byAttr) return byAttr;
      } catch (e) { /*селектор не поддержался — идём дальше*/ }
      const labs = document.querySelectorAll('label, h6, [class*="label"]');
      let fallback = null;
      for (const lab of labs) {
        const t = (lab.textContent || '').trim().toLowerCase();
        if (!t.includes(pl)) continue;
        const ctl = controlFromLabelEl(lab);
        if (!ctl) continue;
        if (isVisible(ctl)) return ctl;
        if (!fallback) fallback = ctl;
      }
      if (fallback) return fallback;
    }
    return null;
  }
  function setNativeValue(el, value) {
    if (el.tagName === 'SELECT') {
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    try { el.focus(); } catch (e) {}
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    try { el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true })); } catch (e) {}
    el.dispatchEvent(new Event('input', { bubbles: true }));
    try { el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true })); } catch (e) {}
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    el.dispatchEvent(new Event('focusout', { bubbles: true }));
  }
  function normCourse(s) {
    return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9 ]/gi, ' ').replace(/\s+/g, ' ').trim();
  }
  // Слова-«мусор» в названиях курсов — не участвуют в сравнении.
  const COURSE_STOP = ['тариф', 'тарифа', 'тарифу', 'курс', 'курса', 'курсу', 'программа', 'программе',
    'обучение', 'обучению', 'доступ', 'для', 'при', 'под', 'the', 'and', 'пакет', 'версия', 'формат',
    'разработчик', 'разработчика', 'разработчику', 'developer'];
  // Синонимы тарифов: первая в группе — «ключ». Нужно, чтобы «Мастер» amo совпал с «Максимум» в омни и т.п.
  const TARIFF_SYN = [
    ['pro', 'про', 'профи', 'профессионал', 'профессиональный'],
    ['базовый', 'базовая', 'base', 'старт', 'стартовый', 'начальный', 'лайт', 'light', 'мини'],
    ['стандарт', 'стандартный', 'standard', 'оптимальный', 'оптимум', 'optimal'],
    ['премиум', 'премиальный', 'premium', 'vip', 'вип'],
    ['мастер', 'максимум', 'master', 'max', 'эксперт', 'экспертный', 'продвинутый', 'расширенный', 'advanced', 'ультра'],
  ];
  function tariffKey(w) {
    for (let i = 0; i < TARIFF_SYN.length; i++) if (TARIFF_SYN[i].indexOf(w) !== -1) return TARIFF_SYN[i][0];
    return null;
  }
  function courseSig(s) {
    return normCourse(s).split(' ').filter(function (w) { return w.length >= 3 && COURSE_STOP.indexOf(w) === -1; });
  }
  // Подбор варианта в выпадашке КУРС с учётом тарифа.
  // Пример: amo «Нейросети на практике: тариф PRO» → «Нейросети на практике: для себя, работы и бизнеса PRO».
  function pickCourseOption(sel, courseName) {
    const tSig = courseSig(courseName);
    if (!tSig.length) return null;
    const tSet = {}; tSig.forEach(function (w) { tSet[w] = 1; });
    const tKeys = {}; tSig.forEach(function (w) { const k = tariffKey(w); if (k) tKeys[k] = 1; });
    const tHasTariff = Object.keys(tKeys).length > 0;

    let best = null, bestScore = -1e9;
    sel.querySelectorAll('option').forEach(function (o) {
      const t = (o.textContent || '').trim();
      if (!t || t === '—' || t === '-') return;
      const oSig = courseSig(t);
      if (!oSig.length) return;
      const oSet = {}; oSig.forEach(function (w) { oSet[w] = 1; });
      let common = 0, commonReal = 0;
      tSig.forEach(function (w) { if (oSet[w]) { common++; if (!tariffKey(w)) commonReal++; } });
      // общее только по тарифному слову («Базовый», «PRO») — совпадение мнимое, пропускаем:
      // так «Data scientist: тариф Базовый» больше не цепляет «HR-менеджер. Базовый курс».
      if (commonReal === 0) return;
      // У обеих сторон есть свои значимые (не тарифные) слова, а общих меньше двух —
      // это разные курсы («Бизнес-аналитик» ≠ «Аналитик данных»), не угадываем даже при
      // совпадении тарифа. Лучше оставить поле пустым, чем подставить чужой курс.
      if (commonReal < 2) {
        const tReal = tSig.filter(function (w) { return !tariffKey(w); });
        const oReal = oSig.filter(function (w) { return !tariffKey(w); });
        const tMissing = tReal.some(function (w) { return !oSet[w]; });
        const oExtra = oReal.some(function (w) { return !tSet[w]; });
        if (tMissing && oExtra) return;
      }
      const targetCov = common / tSig.length;   // сколько слов amo нашлось в варианте
      const optCov = common / oSig.length;      // насколько вариант «про то же»

      const oKeys = {}; oSig.forEach(function (w) { const k = tariffKey(w); if (k) oKeys[k] = 1; });
      const oHasTariff = Object.keys(oKeys).length > 0;
      let tariffMatch = false;
      for (const k in tKeys) { if (oKeys[k]) tariffMatch = true; }
      const tariffClash = tHasTariff && !tariffMatch && oHasTariff;

      let score = targetCov * 70 + optCov * 20;
      if (tariffMatch) score += 25;
      if (tariffClash) score -= 45;                 // amo просит один тариф, вариант — другой
      if (!tHasTariff && oHasTariff) score -= 6;    // amo без тарифа, вариант с тарифом — лёгкий минус

      if (score > bestScore) { bestScore = score; best = o; }
    });
    return bestScore >= 45 ? best : null;
  }
  function fillCourseSelect(courseName) {
    const sel = document.querySelector(OMNI_FIELDS.course) || findOmniInput(LABELS.course);
    if (!sel || sel.tagName !== 'SELECT') return null;

    // Прямое точное совпадение — для служебных значений «не покупал», «без курса».
    const tgt = normCourse(courseName);
    if (tgt) {
      const exact = [].slice.call(sel.options).find(function (o) { return normCourse(o.textContent) === tgt; });
      if (exact) {
        sel.value = exact.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        sel.dispatchEvent(new Event('chosen:updated'));
        const sp = sel.parentElement.querySelector('.chosen-container .chosen-single span');
        if (sp) sp.textContent = exact.textContent.trim();
        return exact.textContent.trim();
      }
    }

    const opt = pickCourseOption(sel, courseName);
    if (!opt) {
      // Пробуем найти по маппингу с другим названием
      const omniName = findOmniCourseName(courseName);
      if (omniName !== courseName) {
        const opt2 = pickCourseOption(sel, omniName);
        if (opt2) {
          sel.value = opt2.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          sel.dispatchEvent(new Event('chosen:updated'));
          const span = sel.parentElement.querySelector('.chosen-container .chosen-single span');
          if (span) span.textContent = opt2.textContent.trim();
          return opt2.textContent.trim();
        }
      }
      return null;
    }

    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    sel.dispatchEvent(new Event('chosen:updated'));
    const span = sel.parentElement.querySelector('.chosen-container .chosen-single span');
    if (span) span.textContent = opt.textContent.trim();
    return opt.textContent.trim();
  }
  function setFieldById(sel, value, ruName, patterns, ok, miss) {
    let el = document.querySelector(sel);
    if (!el || !isVisible(el)) el = findOmniInput(patterns);
    if (!el) { miss.push(ruName + ' — поле на странице не нашлось'); return; }
    setNativeValue(el, value);
    if ((el.value || '').trim() === String(value).trim()) ok.push(ruName);
    else miss.push(ruName + ' — написала, но значение не прижилось');
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function getExistingValues(block) {
    const values = [];
    block.querySelectorAll('input').forEach(i => {
      if (i.type !== 'hidden' && !i.disabled && isVisible(i) && (i.value || '').trim()) {
        values.push(i.value.trim());
      }
    });
    // Уже сохранённые значения показываются текстом/чипами. Берём ТОЛЬКО то,
    // что целиком похоже на почту или телефон — не режем подписи поля по пробелам
    // (из-за этого скрипт раньше решал, что почта «уже есть», и не вписывал её).
    block.querySelectorAll('p, span, a, li, [class*="chip"], [class*="tag"], [class*="value"]').forEach(node => {
      if (node.querySelector && node.querySelector('input')) return;
      const text = (node.textContent || '').trim();
      if (!text || text.length > 100) return;
      const looksEmail = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(text);
      const looksPhone = /^\+?[\d][\d\s().-]{8,}$/.test(text);
      if ((looksEmail || looksPhone) && !values.includes(text)) values.push(text);
    });
    return values;
  }
  function valueExistsInBlock(block, value, isPhone) {
    const existing = getExistingValues(block);
    if (isPhone) {
      const cleanValue = value.replace(/\D/g, '').slice(-10);
      return existing.some(v => v.replace(/\D/g, '').slice(-10) === cleanValue);
    } else {
      const cleanValue = value.toLowerCase().trim();
      return existing.some(v => v.toLowerCase().trim() === cleanValue);
    }
  }
  async function addValueToAccBlock(block, value, patterns, isPhone) {
    if (valueExistsInBlock(block, value, isPhone)) {
      return { ok: true, why: 'уже есть', added: false };
    }
    const freeInputs = function (needVisible) {
      return Array.prototype.filter.call(block.querySelectorAll('input'), function (i) {
        return i.type !== 'hidden' && i.type !== 'checkbox' && !i.disabled &&
               (!needVisible || isVisible(i));
      });
    };
    let target = freeInputs(true).find(function (i) { return (i.value || '').trim() === ''; }) || null;
    if (!target) {
      const plus = block.querySelector('.additional_field.add_field, .add_field, [class*="add_field"]')
        || Array.prototype.find.call(block.querySelectorAll('a, button'), function (n) {
          const t = (n.textContent || '').trim();
          return t === '+' || /^добавить/i.test(t);
        });
      if (plus) { try { plus.click(); } catch (e) {} }
      for (let k = 0; k < 12 && !target; k++) {
        await sleep(150);
        target = freeInputs(true).find(function (i) { return (i.value || '').trim() === ''; }) || null;
      }
    }
    // последняя попытка — любое пустое поле ввода блока (вдруг «невидимость» ложная)
    if (!target) target = freeInputs(false).find(function (i) { return (i.value || '').trim() === ''; }) || null;
    if (!target) return { ok: false, why: 'строка ввода не появилась — открой блок почты, нажми «+» и повтори' };
    setNativeValue(target, value);
    await sleep(150);
    if ((target.value || '').trim() !== String(value).trim()) {
      setNativeValue(target, value);
      await sleep(150);
      if ((target.value || '').trim() !== String(value).trim()) {
        return { ok: false, why: 'написала, но значение не прижилось' };
      }
    }
    // Омни запоминает значение строки, только когда с неё «уходят» фокусом —
    // как когда вручную кликаешь на пустое поле. Делаем это по-настоящему.
    await blurAccRow(block, target);
    if ((target.value || '').trim() !== String(value).trim() &&
        !valueExistsInBlock(block, value, isPhone)) {
      return { ok: false, why: 'значение слетело после ухода с поля (сохрани почту вручную)' };
    }
    return { ok: true, why: '', added: true };
  }
  // «Уходим» с заполненной строки: ставим фокус на другую пустую строку блока
  // (или создаём её кнопкой «+») и снимаем — Омни фиксирует введённое значение.
  async function blurAccRow(block, target) {
    const emptyOther = function () {
      return Array.prototype.find.call(block.querySelectorAll('input'), function (i) {
        return i !== target && i.type !== 'hidden' && i.type !== 'checkbox' &&
               !i.disabled && isVisible(i) && (i.value || '').trim() === '';
      });
    };
    let other = emptyOther();
    if (!other) {
      const plus = block.querySelector('.additional_field.add_field, .add_field, [class*="add_field"]');
      if (plus) { try { plus.click(); } catch (e) {} await sleep(200); other = emptyOther(); }
    }
    try {
      if (other) {
        other.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        other.focus();
        other.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        other.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await sleep(120);
        other.blur();
      } else if (target.blur) { target.blur(); }
    } catch (e) {}
    try {
      target.dispatchEvent(new Event('change', { bubbles: true }));
      target.dispatchEvent(new Event('blur', { bubbles: true }));
      target.dispatchEvent(new Event('focusout', { bubbles: true }));
    } catch (e) {}
    await sleep(180);
  }
  // Запасной путь: пишем прямо в основное поле (#field_2 / #field_16),
  // если блок-«список» с заголовком найти не удалось.
  function fillAccFieldDirect(directSel, values, ruName, ok, miss) {
    let el = directSel ? document.querySelector(directSel) : null;
    if (!el) { miss.push(ruName + ' — поле на странице не нашлось'); return; }
    const val = values.join(', ');
    setNativeValue(el, val);
    if ((el.value || '').trim()) ok.push(ruName + ' (в основное поле — проверь глазами)');
    else miss.push(ruName + ' — поле на странице не нашлось');
  }
  // Поле-«теги» на Select2 (так в OmniDesk устроено поле EMAIL-АДРЕС):
  // просто вписать текст в input НЕЛЬЗЯ — Select2 хранит значения в своей модели
  // и при «Сохранить» читает именно её. Добавляем значения через API Select2,
  // выполняя код в контексте страницы (у него есть jQuery и Select2).
  function fillSelect2Field(block, values, isPhone) {
    return new Promise(function (resolve) {
      block.setAttribute('data-eduson-target', '1');
      document.documentElement.removeAttribute('data-eduson-s2-result');
      const payload = JSON.stringify({ values: values, isPhone: !!isPhone });
      // s2.onSelect({id,text}) — тот же метод, что вызывает клик по варианту
      // в выпадающем списке: создаёт «плашку», помечает поле изменённым
      // (data-b_changed) и шлёт change — только так OmniDesk сохраняет значение
      // (проверено на живой карточке: select2('data',…) НЕ сохраняется).
      const code =
        '(function(){var res={okCount:0,skipCount:0,err:null};try{' +
        'var $=window.jQuery;if(!$){res.err="нет jQuery на странице";return fin();}' +
        'var b=document.querySelector(\'[data-eduson-target="1"]\');' +
        'var orig=b.querySelector("input.form-custom-field-acc")||b.querySelector(\'input[name^="field_"]\');' +
        'if(!orig){res.err="поле не найдено";return fin();}' +
        'var $o=$(orig);var s2=$o.data("select2");' +
        'var P=' + payload + ';' +
        'var norm=function(v){return P.isPhone?String(v).replace(/\\D/g,"").slice(-10):String(v).toLowerCase().trim();};' +
        // что УЖЕ есть в поле: модель select2 + текст скрытого input + «плашки» в DOM
        'var have=[];' +
        'try{var cur=$o.select2("val");if(!Array.isArray(cur))cur=cur?[cur]:[];cur.forEach(function(v){if(v)have.push(norm(v));});}catch(e0){}' +
        'try{(orig.value||"").split(/[,;\\s]+/).forEach(function(p){p=p.trim();if(p)have.push(norm(p));});}catch(e0){}' +
        'try{b.querySelectorAll(".select2-search-choice,.select2-selection__choice,li.select2-selection__choice").forEach(function(x){' +
        'var tt=(x.textContent||"").replace(/^[\\s\\u00d7\\u2715\\u2716x]+|[\\s\\u00d7\\u2715\\u2716x]+$/g,"").trim();if(tt)have.push(norm(tt));});}catch(e0){}' +
        'var toAdd=P.values.filter(function(v){return have.indexOf(norm(v))===-1;});' +
        'res.skipCount=P.values.length-toAdd.length;' +
        'if(!toAdd.length){return fin();}' +   // всё уже в карточке — это НЕ ошибка
        'if(!s2||typeof s2.onSelect!=="function"){res.err="S2_NO_ONSELECT";return fin();}' +
        'var hasCSC=s2.opts&&typeof s2.opts.createSearchChoice==="function";' +
        'toAdd.forEach(function(v){try{var ch=null;' +
        'if(hasCSC){try{ch=s2.opts.createSearchChoice.call(s2,v,[]);}catch(e0){}' +
        'if(!ch){res.err="S2_BAD_VALUE:"+v;return;}}' +
        'if(!ch)ch={id:v,text:v};' +
        's2.onSelect(ch);have.push(norm(v));res.okCount++;}catch(e2){res.err=(e2&&e2.message)||String(e2);}});' +
        'try{$o.trigger("change");}catch(e3){}' +
        '}catch(e){res.err=(e&&e.message)||String(e);}return fin();' +
        'function fin(){document.documentElement.setAttribute("data-eduson-s2-result",JSON.stringify(res));}})();';
      try {
        const s = document.createElement('script');
        s.textContent = code;
        document.documentElement.appendChild(s);
        s.remove();
      } catch (e) { /* инъекция не прошла — обработаем ниже */ }
      let tries = 0;
      const iv = setInterval(function () {
        const r = document.documentElement.getAttribute('data-eduson-s2-result');
        if (r || tries++ > 40) {
          clearInterval(iv);
          document.documentElement.removeAttribute('data-eduson-s2-result');
          block.removeAttribute('data-eduson-target');
          let parsed;
          try { parsed = JSON.parse(r || '{"err":"страница не ответила"}'); }
          catch (e) { parsed = { err: 'ответ страницы не разобрать' }; }
          resolve(parsed);
        }
      }, 50);
    });
  }
  // Мягкая жалоба по почте: не «ошибка», а «допиши руками» — не пугает и не зажигает красный значок.
  function s2SoftMessage(err) {
    if (err === 'S2_NO_ONSELECT') return 'впиши руками — виджет омника не даёт вписать её сам';
    if (/^S2_BAD_VALUE:/.test(err)) return 'омник не принял адрес «' + err.slice(12) + '» — проверь формат / впиши руками';
    return err;
  }
  async function fillAccFieldAsync(patterns, values, ruName, ok, miss, directSel, soft) {
    let block = null;
    document.querySelectorAll('.a17_additional_fields').forEach(function (b) {
      if (block) return;
      const h = b.querySelector('h6');
      if (h && patterns.some(function (p) { return (h.textContent || '').trim().toLowerCase().includes(p); })) block = b;
    });
    if (!block) { fillAccFieldDirect(directSel, values, ruName, ok, miss); return; }
    const isPhone = patterns.some(p => p.includes('телефон'));
    const softBucket = soft || miss;   // куда складывать «не смогла, но не страшно»

    // EMAIL — виджет Select2 («теги»). Он инициализируется при входе
    // в режим «редактировать»; если ещё не готов — ждём и подталкиваем «+».
    let s2 = block.querySelector('.select2-container');
    if (!s2 && !isPhone) {
      for (let i = 0; i < 12 && !s2; i++) { await sleep(200); s2 = block.querySelector('.select2-container'); }
      if (!s2) {
        const plus = block.querySelector('.add_field');
        if (plus && isVisible(plus)) { try { plus.click(); } catch (e) {} }
        for (let i = 0; i < 12 && !s2; i++) { await sleep(200); s2 = block.querySelector('.select2-container'); }
      }
    }
    // EMAIL и другие поля-«теги» — через API Select2 (иначе не сохраняется)
    if (s2) {
      const r = await fillSelect2Field(block, values, isPhone);
      if (r.okCount) ok.push(ruName + ' (+' + r.okCount + ' новых)');
      if (r.skipCount) ok.push(ruName + ' (' + r.skipCount + ' уже были, пропущены)');
      if (r.err) {
        if (/^S2_/.test(r.err)) softBucket.push(ruName + ' — ' + s2SoftMessage(r.err));
        else miss.push(ruName + ' — ' + r.err);
      } else if (!r.okCount && !r.skipCount) {
        // ничего не добавили и нечего было — значит всё уже в карточке
        ok.push(ruName + ' — уже в карточке');
      }
      return;
    }
    const added = [];
    const skipped = [];
    let hasError = false;
    const uniqueValues = [];
    for (const val of values) {
      if (!valueExistsInBlock(block, val, isPhone)) {
        uniqueValues.push(val);
      } else {
        skipped.push(val);
      }
    }
    for (const val of uniqueValues) {
      const r = await addValueToAccBlock(block, val, patterns, isPhone);
      if (r.ok) {
        if (r.added) added.push(val);
        else skipped.push(val);
      } else {
        softBucket.push(ruName + ': ' + r.why + ' (' + val + ')');
        hasError = true;
      }
    }
    if (added.length) ok.push(ruName + ' (+' + added.length + ' новых)');
    if (skipped.length && !hasError) ok.push(ruName + ' (' + skipped.length + ' уже были, пропущены)');
    if (!added.length && !skipped.length && !hasError) {
      ok.push(ruName + ' — уже в карточке');
    }
  }
  // Сам жмёт «Сохранить» в карточке OmniDesk (ссылки <a class="info_save">сохранить</a>)
  function clickOmniSave() {
    const saves = Array.prototype.filter.call(
      document.querySelectorAll('a.info_save, .info_save'),
      function (el) { return isVisible(el); }
    );
    if (!saves.length) return false;
    saves.forEach(function (el) {
      try { el.click(); } catch (e) {}
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    return true;
  }

  // Карточка клиента в OmniDesk редактируется по ссылке «редактировать»
  // (она же «Изменить»). Пока не нажата — поля скрыты, а поле EMAIL ещё
  // не превратилось в виджет Select2. Нажимаем сами, если нужно.
  async function ensureOmniEditMode() {
    if (!IS_OMNI) return true;
    const saveShown = function () {
      return Array.prototype.some.call(document.querySelectorAll('a.info_save'), isVisible);
    };
    if (saveShown()) return true;
    const editLink = Array.prototype.find.call(
      document.querySelectorAll('.info_edit, a[class*="edit"]'),
      function (el) { return isVisible(el) && /редактир|изменить/i.test(el.textContent || ''); }
    );
    if (!editLink) return saveShown();
    try { editLink.click(); } catch (e) {}
    for (let i = 0; i < 20 && !saveShown(); i++) await sleep(150);
    await sleep(500); // дать Select2 в поле почты доинициализироваться
    return saveShown();
  }

  // Что из data.emails уже видно в карточке OmniDesk (чтобы не пытаться вписать снова).
  function cardEmailSet() {
    const set = new Set();
    try {
      grabContactSeed().emails.forEach(function (e) { set.add(String(e).toLowerCase().trim()); });
    } catch (e) {}
    return set;
  }

  // Глобальные переменные для хранения результатов заполнения
  let lastFillResult = { ok: [], miss: [], soft: [], data: null };
  async function fillInputsFromData(data, prefix) {
    const ok = [], miss = [], soft = [];   // soft = «не смогла, но не страшно — допиши руками»
    if (IS_OMNI) {
      const edit = await ensureOmniEditMode();
      if (!edit) miss.push('карточка не в режиме «редактировать» — нажми «редактировать» в блоке ДАННЫЕ ПОЛЬЗОВАТЕЛЯ');
    }
    let courseLabel = '';
    if (data.course) {
      courseLabel = fillCourseSelect(data.course);
      if (courseLabel) {
        ok.push(RU.course);
        // Проверяем, есть ли в названии курса указание на отсутствие поддержки
        if (/нет поддержки/i.test(courseLabel)) {
          data.support = '';
          data.supportMonths = 0;
        }
      } else {
        miss.push(RU.course + ' — не нашла похожий вариант в списке');
      }
    } else miss.push(RU.course + ' — в амо пусто');

    // Определяем месяцы поддержки на основе названия курса из amo
    let months = data.supportMonths !== undefined ? data.supportMonths : getSupportMonthsForCourse(data.course);
    if (months === 0) {
      // Нет поддержки — поле должно быть пустым
      data.support = '';
    } else if (!data.support && data.purchaseTs) {
      data.support = plusMonthsTs(data.purchaseTs, months);
    } else if (data.support && !data.purchaseTs) {
      // Оставляем как есть
    }

    if (!data.name) miss.push(RU.name + ' — в амо пусто');
    else setFieldById(OMNI_FIELDS.name, data.name, RU.name, LABELS.name, ok, miss);

    // Заполняем дату поддержки только если она есть
    if (data.support) {
      setFieldById(OMNI_FIELDS.support, data.support, RU.support, LABELS.support, ok, miss);
    } else if (data.noPurchase) {
      ok.push(RU.support + ' — прочерк (клиент не покупал)');
    } else {
      miss.push(RU.support + ' — поддержки нет (курс без поддержки)');
    }

    if (data.emails && data.emails.length) {
      const onCard = cardEmailSet();
      const freshEmails = data.emails.filter(function (e) { return !onCard.has(String(e).toLowerCase().trim()); });
      if (!freshEmails.length) {
        ok.push(RU.email + ' — уже в карточке');
      } else {
        await fillAccFieldAsync(['email', 'почта'], freshEmails, RU.email, ok, miss, OMNI_FIELDS.email, soft);
      }
    } else {
      miss.push(RU.email + ' — в амо пусто');
    }
    if (data.phones && data.phones.length) {
      await fillAccFieldAsync(['телефон', 'phone'], data.phones, RU.phone, ok, miss, OMNI_FIELDS.phone);
    } else {
      miss.push(RU.phone + ' — в амо пусто');
    }
    // АДМИНКА + галочка СУПЕРЮЗЕР — пропускаем, если клиент ещё не покупал курс.
    if (data.noPurchase) {
      ok.push(RU.admin + ' + СУПЕРЮЗЕР — пропущено (клиент не покупал)');
    } else {
      await runAdminFill(data, ok, miss);
    }
    // Скрипт сам жмёт «Сохранить» (если хоть что-то заполнилось)
    if (ok.length) {
      await sleep(400);
      if (clickOmniSave()) ok.push('💾 Сохранено');
      else miss.push('💾 кнопка «Сохранить» не нашлась — сохрани вручную');
    }
    // Сохраняем результат
    lastFillResult = { ok, miss, soft, data };
    // Дописываем результат заполнения в отчёт («Отчёт»), чтобы было видно,
    // что именно и почему не вписалось.
    try {
      const prev = GM_getValue(DEBUG_KEY) || {};
      prev.version = VER;
      prev.fill = { ok: ok.slice(), miss: miss.slice(), soft: soft.slice(), at: new Date().toISOString(), url: location.href };
      GM_setValue(DEBUG_KEY, prev);
    } catch (e) {}
    // Красный значок — только на настоящие ошибки (soft туда не идёт).
    updateErrorIcon(miss, ok);
    // Короткое сообщение. Подробности — по кнопке «Отчёт» в панели.
    const filledCount = ok.filter(function (s) { return !/^💾/.test(s); }).length;
    const softTail = soft.length ? '\n✍️ ' + soft.join('; ') : '';
    if (!ok.length) {
      toast('❌ Ничего не заполнилось.\nКарточка в режиме «редактировать»?\n👉 нажми сюда — покажу подробности', 'error', 10000, showFillReport);
    } else if (miss.length) {
      toast('⚠️ Заполнено, но ' + miss.length + ' не вышло.\n👉 нажми сюда — покажу подробности', 'warn', 9000, showFillReport);
    } else if (soft.length) {
      toast('✅ Готово и сохранено (' + filledCount + ' полей).' + softTail, 'ok', 8000, showFillReport);
    } else {
      toast('✅ Готово и сохранено (' + filledCount + ' полей).', 'ok', 4000);
    }
  }
  // Подробный отчёт по последнему заполнению — по кнопке «Отчёт».
  function showFillReport() {
    const R = lastFillResult;
    if (!R || (!R.ok.length && !R.miss.length)) {
      toast('Пока нечего показывать — сначала нажми «Заполнить».', 'warn');
      return;
    }
    const d = R.data || {};
    const lines = [
      d.name && '👤 ' + d.name,
      d.emails && d.emails.length && '✉️ ' + d.emails.join(', '),
      d.phones && d.phones.length && '📞 ' + d.phones.join(', '),
      d.course && '📚 ' + d.course,
      d.purchaseTs && '🧾 покупка: ' + fmtTs(d.purchaseTs),
      d.support && '📅 поддержка до ' + d.support,
      d.admin && d.admin.length && '🖥 ' + d.admin.join('  '),
      '— — —',
      '✅ ' + (R.ok.length ? R.ok.join(', ') : '—'),
      (R.soft && R.soft.length) ? '✍️ впиши руками: ' + R.soft.join(', ') : null,
      R.miss.length ? '❌ ' + R.miss.join(', ') : null,
    ].filter(Boolean).join('\n');
    toast(lines, R.miss.length ? 'warn' : 'ok', 20000);
    try { GM_setClipboard(JSON.stringify(GM_getValue(DEBUG_KEY) || {}, null, 2)); } catch (e) {}
  }
  function insertStored() {
    const d = GM_getValue(STORE_KEY);
    if (!d) { toast('Пока ничего не скопировано.\nНажми «Заполнить из амо» или кнопку в амо.', 'warn'); return; }
    fillInputsFromData(d, 'Вставляю скопированное');
  }
  async function fillAdminOnly() {
    const d = GM_getValue(STORE_KEY);
    if (!d) { toast('Сначала нажми «Заполнить из амо».', 'warn'); return; }
    toast('Ищу ссылку в админке Эдюсона…', 'info', 6000);
    const ok = [], miss = [];
    await runAdminFill(d, ok, miss);
    GM_setValue(STORE_KEY, d);
    updateErrorIcon(miss, ok);
    toast('АДМИНКА:\n' +
      (d.admin && d.admin.length ? d.admin.join('\n') + '\n— — —\n' : '') +
      (ok.length ? '✅ ' + ok.join(', ') : '') +
      (miss.length ? (ok.length ? '\n' : '') + '❌ ' + miss.join(', ') : ''),
      ok.length && !miss.length ? 'ok' : (ok.length ? 'warn' : 'error'), 12000);
  }
  /* ---------- отладка и вспомогательные кнопки ---------- */
  function dumpOmniFields() {
    const out = [];
    document.querySelectorAll('input, textarea, select').forEach(el => {
      if (el.type === 'hidden' || !isVisible(el)) return;
      let label = '';
      const lab = el.closest('label') || (el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null);
      if (lab) label = (lab.textContent || '').trim();
      if (!label) {
        const wrap = el.closest('.a17_additional_fields, .form-group, .field, [class*="field"], [class*="group"]');
        const wl = wrap && wrap.querySelector('h6, label, [class*="label"]');
        if (wl) label = (wl.textContent || '').trim();
      }
      out.push({
        label: label,
        placeholder: el.placeholder || '',
        name: el.name || '',
        id: el.id || '',
        type: el.type || el.tagName.toLowerCase(),
      });
    });
    const json = JSON.stringify(out, null, 2);
    console.log(TAG, 'поля формы OmniDesk:', json);
    try {
      GM_setClipboard(json);
      toast('Список полей формы скопирован в буфер обмена.', 'ok');
    } catch (e) {
      toast('Список полей выведен в консоль (F12 → Console).', 'warn');
    }
  }
  function showStored() {
    const d = GM_getValue(STORE_KEY);
    if (!d) { toast('Копилка пустая.', 'warn'); return; }
    toast('Сохранено ' + new Date(d.ts).toLocaleString('ru-RU') + ':\n' + [
      d.name    && '👤 ' + d.name,
      d.emails && d.emails.length && '✉️ ' + d.emails.join(', '),
      d.phones && d.phones.length && '📞 ' + d.phones.join(', '),
      d.course  && '📚 ' + d.course,
      d.support && '📅 ' + d.support,
    ].filter(Boolean).join('\n'), 'info');
  }
  function openAmoSearch() {
    const seed = grabContactSeed();
    const d = GM_getValue(STORE_KEY);
    const phones = (d && d.phones) || seed.phones || [];
    const emails = (d && d.emails) || seed.emails || [];
    const term = phones[0] || emails[0] || '';
    if (!term) { toast('Не нашла телефон/email на странице.', 'warn'); return; }
    window.open('https://' + AMO_SUBDOMAIN + '.amocrm.ru/contacts/list/?term=' + encodeURIComponent(term), '_blank');
  }
  function copyReport() {
    const dbg = GM_getValue(DEBUG_KEY);
    if (!dbg) { toast('Пока нечего показывать.', 'warn'); return; }
    const text = JSON.stringify(dbg, null, 2);
    console.log(TAG, 'отчёт:', text);
    try {
      GM_setClipboard(text);
      toast('Отчёт скопирован в буфер обмена. 💜', 'ok');
    } catch (e) {
      toast('Отчёт выведен в консоль (F12 → Console).', 'warn');
    }
  }
  /* ---------- интерфейс ---------- */
  // Функция для обновления значка ошибки
  function updateErrorIcon(miss, ok) {
    const errorIcon = document.getElementById('eduson-error-icon');
    const dropdown = document.getElementById('eduson-error-dropdown');
    if (!errorIcon || !dropdown) return;
    const hasErrors = miss && miss.length > 0;
    const hasWarnings = ok && ok.length > 0 && hasErrors;
    if (hasErrors) {
      errorIcon.style.display = 'flex';
      errorIcon.style.background = hasWarnings ? '#F59E0B' : '#EF4444';
      errorIcon.textContent = '⚠️';
      // Обновляем содержимое выпадающего списка
      dropdown.innerHTML = '';
      // Добавляем заголовок
      const header = document.createElement('div');
      header.style.cssText = 'padding: 8px 12px; font-weight: 700; color: #111827; border-bottom: 1px solid #E5E7EB;';
      header.textContent = '📋 Результат заполнения';
      dropdown.appendChild(header);
      // Добавляем успешные поля
      if (ok && ok.length) {
        const okDiv = document.createElement('div');
        okDiv.style.cssText = 'padding: 6px 12px; color: #16A34A; border-bottom: 1px solid #E5E7EB;';
        okDiv.textContent = '✅ ' + ok.join(' • ');
        dropdown.appendChild(okDiv);
      }
      // Добавляем ошибки
      const missDiv = document.createElement('div');
      missDiv.style.cssText = 'padding: 6px 12px; color: #DC2626;';
      missDiv.textContent = '❌ ' + miss.join(' • ');
      dropdown.appendChild(missDiv);
      // Добавляем кнопку копирования отчета
      const reportBtn = document.createElement('button');
      reportBtn.textContent = 'Скопировать отчёт';
      reportBtn.style.cssText = 'width:100%;margin-top:6px;padding:7px;background:#F3F4F6;border:1px solid #E5E7EB;border-radius:12px;cursor:pointer;font-size:11px;font-weight:700;color:#4B5563;font-family:' + HP_FONT + ';';
      reportBtn.onclick = function(e) {
        e.stopPropagation();
        copyReport();
      };
      dropdown.appendChild(reportBtn);
    } else {
      errorIcon.style.display = 'none';
    }
  }
  function showErrorDropdown() {
    const dropdown = document.getElementById('eduson-error-dropdown');
    if (!dropdown) return;
    dropdown.style.display = dropdown.style.display === 'block' ? 'none' : 'block';
  }
  function hideErrorDropdown() {
    const dropdown = document.getElementById('eduson-error-dropdown');
    if (dropdown) dropdown.style.display = 'none';
  }
  // Функция для проверки наличия карточки на странице
  function isCardPage() {
    // Проверяем наличие полей формы
    const hasFields = document.querySelector(OMNI_FIELDS.name) ||
                      document.querySelector(OMNI_FIELDS.email) ||
                      document.querySelector(OMNI_FIELDS.phone) ||
                      document.querySelector(OMNI_FIELDS.course) ||
                      document.querySelector(OMNI_FIELDS.support);
    return !!hasFields;
  }
  function ensurePanel() {
    // В amoCRM панель-«окошко» больше не показываем — всё делает кнопка-магнит в OmniDesk.
    if (IS_AMO) {
      const exAmo = document.getElementById('eduson-helper-panel');
      if (exAmo) exAmo.remove();
      return;
    }
    // Проверяем, что это страница с карточкой (только для OmniDesk)
    if (IS_OMNI && !isCardPage()) {
      // Удаляем панель, если она есть
      const existing = document.getElementById('eduson-helper-panel');
      if (existing) existing.remove();
      return;
    }
    if (document.getElementById('eduson-helper-panel')) return;
    const wrap = document.createElement('div');
    wrap.id = 'eduson-helper-panel';
    // Стиль — в гамме Возврат-мастера: белый фон, светло-серая рамка, округлый шрифт.
    wrap.style.cssText = 'position:fixed;z-index:2147483646;display:flex;flex-direction:column;gap:6px;background:#fff;padding:10px 13px;border:1px solid #E5E7EB;border-radius:16px;box-shadow:0 12px 36px rgba(15,23,42,.22);cursor:move;user-select:none;min-width:220px;max-width:96vw;font-family:' + HP_FONT + ';';
    // Округлый шрифт Nunito (если CSP не пустит — просто фолбэк)
    if (!document.getElementById('eduson-hp-font')) {
      try {
        const lf = document.createElement('link');
        lf.id = 'eduson-hp-font';
        lf.rel = 'stylesheet';
        lf.href = 'https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&display=swap';
        document.head.appendChild(lf);
      } catch (e) {}
    }
    // Позиция: по умолчанию — сразу под кружком сверху по центру; иначе — куда перетащили.
    if (panelPosition.x != null && panelPosition.y != null) {
      wrap.style.left = panelPosition.x + 'px';
      wrap.style.top = panelPosition.y + 'px';
    } else {
      wrap.style.left = '50%';
      wrap.style.top = '44px';
      wrap.style.transform = 'translateX(-50%)';
    }
    // В OmniDesk панель ВСЕГДА спрятана при загрузке страницы —
    // открывается только кликом по кружку 📋 сверху экрана.
    if (IS_OMNI) wrap.style.display = 'none';
    // Заголовок с крестиком
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;width:100%;margin-bottom:4px;';
    const title = document.createElement('span');
    title.textContent = 'Eduson Helper';
    title.style.cssText = 'font-size:11px;font-weight:800;color:' + HP_ACC + ';letter-spacing:.2px;';
    header.appendChild(title);
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'background:none;border:none;color:#6B7280;cursor:pointer;font-size:14px;padding:0 4px;line-height:1;';
    closeBtn.onclick = function(e) {
      e.stopPropagation();
      wrap.style.display = 'none';
    };
    closeBtn.onmouseenter = function() { this.style.color = '#DC2626'; };
    closeBtn.onmouseleave = function() { this.style.color = '#6B7280'; };
    header.appendChild(closeBtn);
    wrap.appendChild(header);
    // Основная строка с кнопкой и значком ошибки
    const mainRow = document.createElement('div');
    mainRow.style.cssText = 'display:flex;align-items:center;gap:6px;width:100%;flex-wrap:wrap;';
    const mainBtn = mkBtn(IS_AMO ? 'Скопировать' : 'Заполнить', true);
    mainBtn.style.cursor = 'pointer';
    mainBtn.onclick = function(e) {
      e.stopPropagation();
      if (IS_AMO) collectFromAmo();
      else smartFillOmni();
    };
    mainRow.appendChild(mainBtn);
    if (IS_OMNI) {
      // Кнопка «В амо» — сразу правее «Заполнить», в той же строке
      const bAmo = mkBtn('🔎 В амо');
      bAmo.style.padding = '4px 8px';
      bAmo.style.fontSize = '10px';
      bAmo.style.cursor = 'pointer';
      bAmo.onclick = function(e) { e.stopPropagation(); openAmoSearch(); };
      mainRow.appendChild(bAmo);
      // Кнопка «Отчёт» — подробности по последнему заполнению (по требованию)
      const bReport = mkBtn('Отчёт');
      bReport.style.padding = '4px 8px';
      bReport.style.fontSize = '10px';
      bReport.style.cursor = 'pointer';
      bReport.title = 'Показать подробный отчёт по последнему заполнению (и скопировать его в буфер)';
      bReport.onclick = function(e) { e.stopPropagation(); showFillReport(); };
      mainRow.appendChild(bReport);
    }
    if (IS_OMNI) {
      // Значок ошибки (изначально скрыт)
      const errorIcon = document.createElement('div');
      errorIcon.id = 'eduson-error-icon';
      errorIcon.style.cssText = 'display:none;width:28px;height:28px;border-radius:50%;background:#EF4444;color:#fff;align-items:center;justify-content:center;font-size:14px;cursor:pointer;font-weight:700;flex-shrink:0;box-shadow:0 2px 8px rgba(239,68,68,0.3);';
      errorIcon.textContent = '⚠️';
      errorIcon.onclick = function(e) {
        e.stopPropagation();
        showErrorDropdown();
      };
      mainRow.appendChild(errorIcon);
      // Выпадающий список ошибок
      const dropdown = document.createElement('div');
      dropdown.id = 'eduson-error-dropdown';
      dropdown.style.cssText = 'display:none;position:absolute;top:calc(100% + 8px);right:0;min-width:280px;max-width:400px;background:#fff;border-radius:14px;box-shadow:0 12px 36px rgba(15,23,42,.2);border:1px solid #E5E7EB;padding:4px 0;z-index:2147483647;font-size:12px;line-height:1.6;color:#111827;max-height:300px;overflow-y:auto;font-family:' + HP_FONT + ';';
      dropdown.onclick = function(e) {
        e.stopPropagation();
      };
      mainRow.appendChild(dropdown);
      mainRow.style.position = 'relative';
    }
    wrap.appendChild(mainRow);
    // Добавляем обработчики для перетаскивания
    wrap.addEventListener('mousedown', function(e) {
      if (e.target.closest('button') || e.target.closest('#eduson-error-dropdown')) return;
      isDragging = true;
      const rect = wrap.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      wrap.style.cursor = 'grabbing';
    });
    document.addEventListener('mousemove', function(e) {
      if (!isDragging) return;
      let x = e.clientX - dragOffsetX;
      let y = e.clientY - dragOffsetY;
      x = Math.max(0, Math.min(window.innerWidth - wrap.offsetWidth, x));
      y = Math.max(0, Math.min(window.innerHeight - wrap.offsetHeight, y));
      wrap.style.left = x + 'px';
      wrap.style.top = y + 'px';
      wrap.style.transform = 'none';
      panelPosition.x = x;
      panelPosition.y = y;
    });
    document.addEventListener('mouseup', function() {
      if (isDragging) {
        isDragging = false;
        wrap.style.cursor = 'move';
        // Сохраняем позицию
        try {
          GM_setValue('helperPanelPos', JSON.stringify(panelPosition));
        } catch (e) {}
      }
    });
    document.documentElement.appendChild(wrap);
    // Закрываем выпадающий список при клике вне него
    document.addEventListener('click', function(e) {
      const dropdown = document.getElementById('eduson-error-dropdown');
      const icon = document.getElementById('eduson-error-icon');
      if (dropdown && icon && !dropdown.contains(e.target) && !icon.contains(e.target)) {
        dropdown.style.display = 'none';
      }
    });
  }
  // Белый кружок 📋 — сверху экрана, слева вплотную к воронке 🌀 «Возврат-мастера».
  // По клику показывает/прячет панель хэлпера.
  // Кружок 📋 сверху экрана убран (v0.35) — его роль взяла кнопка-магнит
  // в шапке кейса: клик = заполнить, правый клик = панель с отчётом.
  function removeHelperBadge() {
    const ex = document.getElementById('eduson-helper-badge');
    if (ex) ex.remove();
  }

  // Кнопка-магнит в шапке кейса OmniDesk — в левой части, с отступом от статуса «Закрытое».
  // Белый квадрат (слегка закруглён) + серый магнит, крупнее родных иконок, чтобы бросался в глаза.
  // Клик — «притянуть» данные из амо и заполнить карточку (= «Заполнить»).
  // Правый клик — открыть/закрыть панель (отчёт, «🔎 В амо», ручная вставка).
  const MAGNET_SVG =
    '<svg viewBox="-1.6 4.8 19.9 22.4" width="20" height="20" xmlns="http://www.w3.org/2000/svg" ' +
    'style="display:block;fill:#6B7280;transition:fill .15s;">' +
    '<path d="M3.68 10.6h-2.76c-0.48 0-0.84-0.36-0.84-0.84v-2.68c0-0.48 0.36-0.84 0.84-0.84h2.76c0.48 0 0.84 0.36 0.84 0.84v2.68c0 0.44-0.36 0.84-0.84 0.84zM1.76 8.92h1.12v-1h-1.12v1zM15.8 10.6h-2.76c-0.48 0-0.84-0.36-0.84-0.84v-2.68c0-0.48 0.36-0.84 0.84-0.84h2.76c0.48 0 0.84 0.36 0.84 0.84v2.68c0 0.44-0.36 0.84-0.84 0.84zM13.88 8.92h1.12v-1h-1.12v1zM8.36 25.76c-2.32 0-4.2-0.8-5.6-2.36-3.4-3.8-2.72-10.84-2.68-11.12 0.040-0.44 0.4-0.76 0.84-0.76h2.76c0.24 0 0.44 0.080 0.6 0.28 0.16 0.16 0.24 0.4 0.24 0.64-0.080 1.56 0.040 6.040 1.76 7.92 0.56 0.56 1.2 0.84 2 0.84h0.12c0.8 0 1.44-0.28 2-0.84 1.76-1.88 1.88-6.36 1.76-7.92 0-0.24 0.080-0.44 0.24-0.64s0.4-0.28 0.6-0.28h2.76c0.44 0 0.8 0.32 0.84 0.76 0.040 0.28 0.72 7.32-2.68 11.12-1.36 1.56-3.24 2.36-5.56 2.36zM1.72 13.2c-0.080 1.8 0 6.52 2.32 9.080 1.080 1.2 2.52 1.8 4.36 1.8s3.28-0.6 4.36-1.8c2.32-2.6 2.4-7.28 2.32-9.080h-1.12c0 1.84-0.2 6.080-2.24 8.28-0.88 0.92-1.96 1.4-3.2 1.4h-0.12c-1.28 0-2.36-0.48-3.2-1.4-2.16-2.2-2.36-6.44-2.36-8.28 0 0-1.12 0-1.12 0z"></path></svg>';

  // Иконка-ключ для кнопки логин-линка (svgrepo, перекрашиваем в серый).
  const KEY_SVG =
    '<svg viewBox="0 0 32 32" width="25" height="25" xmlns="http://www.w3.org/2000/svg" ' +
    'style="display:block;fill:#6B7280;transition:fill .15s;">' +
    '<path d="M20.491 0c-4.971 0-9 4.036-9 9.015 0 2.232 0.813 4.27 2.155 5.844-0.276-0.017-0.557 0.076-0.768 0.287l-10.075 10.137c-0.39 0.39-0.39 1.024 0 1.414 0.007 0.008 0.016 0.012 0.024 0.020 0.002 0.003 0.004 0.006 0.006 0.008l4.904 4.997c0.39 0.39 1.024 0.39 1.414 0s0.39-1.024 0-1.414l-4.234-4.314 2.578-2.594 4.242 4.322c0.39 0.39 1.024 0.39 1.414 0s0.39-1.024 0-1.414l-4.245-4.326 5.387-5.421c0.209-0.209 0.302-0.485 0.288-0.758 1.582 1.384 3.646 2.229 5.912 2.229 4.971 0 9-4.036 9-9.015s-4.029-9.015-9-9.015zM20.49 16c-3.852 0-7-3.133-7-7s3.148-7 7-7 7 3.133 7 7c0 3.867-3.148 7-7 7z"></path></svg>';

  // Компактное окошко-дропдаун из кнопки-ключа. Каждая строка — настоящая ссылка:
  // ЛКМ = скопировать, ПКМ = родное меню браузера → «Открыть в инкогнито». Сам ничего не открывает.
  function showLoginLinks(links, note) {
    const old = document.getElementById('eduson-loginlink-box');
    if (old) old.remove();
    const box = document.createElement('div');
    box.id = 'eduson-loginlink-box';
    box.dataset.caseId = omniCaseId();
    box.style.cssText = 'position:fixed;z-index:2147483647;width:280px;max-width:92vw;background:#fff;color:#1F2937;' +
      'padding:9px 24px 9px 11px;border:1px solid #E5E7EB;border-radius:12px;font-family:' + HP_FONT + ';' +
      'box-shadow:0 12px 34px rgba(15,23,42,.28);border-left:4px solid #0284C7;';
    // Позиционируем как выпадашку из кнопки-ключа (иначе — снизу слева).
    const kbtn = document.getElementById('eduson-loginlink-btn');
    if (kbtn) {
      const r = kbtn.getBoundingClientRect();
      box.style.top = Math.round(r.bottom + 6) + 'px';
      box.style.right = Math.round(Math.max(8, window.innerWidth - r.right - 4)) + 'px';
    } else {
      box.style.left = '14px';
      box.style.bottom = '14px';
    }
    const title = document.createElement('div');
    title.textContent = links.length > 1 ? 'Логин-линк — выбери курс' : 'Логин-линк';
    title.style.cssText = 'font-weight:800;font-size:11px;color:#0284C7;margin-bottom:6px;';
    box.appendChild(title);
    if (note) {
      const n = document.createElement('div');
      n.textContent = note;
      n.style.cssText = 'font-size:10px;color:#6B7280;font-weight:700;margin:-2px 0 6px;';
      box.appendChild(n);
    }
    links.forEach(function (l) {
      const a = document.createElement('a');
      a.href = l.url;
      a.rel = 'noopener noreferrer';
      const label = (l._matched ? '★ ' : '') + (l.course || 'вход без пароля');
      a.textContent = label;
      a.style.cssText = 'display:block;font-weight:700;font-size:11.5px;color:#075985;text-decoration:none;' +
        'border-radius:8px;padding:6px 9px;margin-top:4px;cursor:pointer;' +
        (l._matched
          ? 'background:#FEF9C3;border:1.5px solid #FACC15;'
          : 'background:#E0F2FE;border:1px solid #BAE6FD;');
      a.onclick = function (e) {
        e.preventDefault();
        try { GM_setClipboard(l.url); } catch (err) {}
        a.textContent = '✓ скопировано';
        setTimeout(function () { a.textContent = label; }, 2000);
      };
      box.appendChild(a);
    });
    const hint = document.createElement('div');
    hint.textContent = 'ЛКМ — копировать · ПКМ — открыть в инкогнито';
    hint.style.cssText = 'font-size:9.5px;color:#9CA3AF;margin-top:6px;font-weight:600;';
    box.appendChild(hint);
    const x = document.createElement('span');
    x.textContent = '✕';
    x.style.cssText = 'position:absolute;top:5px;right:8px;cursor:pointer;color:#9CA3AF;font-size:12px;line-height:1;';
    x.onclick = function () { box.remove(); };
    box.appendChild(x);
    document.documentElement.appendChild(box);

    // Окно НЕ закрывается по клику мимо (Наталья: пропадало сразу, приходилось жать ключ заново).
    // Закрыть — крестиком или повторным кликом по ключу. Логин-линки этой карточки кэшируются
    // в памяти (не на диск): повторный клик по ключу открывает их мгновенно.
    setTimeout(function () { if (box.isConnected) box.remove(); }, 600000); // страховка: 10 минут
  }

  function readCourseTarget() {
    const st = GM_getValue(STORE_KEY);
    if (st && st.course) return st.course;
    let el = document.querySelector(OMNI_FIELDS.course);
    if (!el || !isVisible(el)) el = findOmniInput(LABELS.course);
    if (el) { const v = (el.value || el.textContent || '').trim(); if (v && v !== '—') return v; }
    return '';
  }

  let loginLinkBusy = false;
  // Логин-линки последней карточки — в памяти (НЕ на диск, НЕ в консоль). Чтобы не гонять
  // ключ по несколько раз на одном кейсе: повторный клик открывает их сразу.
  let _loginLinkCache = { caseId: '', links: null, note: '' };
  function omniCaseId() { return (location.pathname.match(/(\d{2,4}-\d{5,})/) || [])[1] || ''; }

  async function copyLoginLink() {
    // Повторный клик по ключу — если окно открыто, просто закрыть.
    const openBox = document.getElementById('eduson-loginlink-box');
    if (openBox) { openBox.remove(); return; }
    if (loginLinkBusy) return;

    const caseId = omniCaseId();
    // Уже искали на этой карточке — показываем из памяти, в админку не идём.
    if (caseId && _loginLinkCache.caseId === caseId && _loginLinkCache.links && _loginLinkCache.links.length) {
      showLoginLinks(_loginLinkCache.links, _loginLinkCache.note);
      return;
    }

    loginLinkBusy = true;
    // Показать + запомнить по карточке.
    const present = function (links, note) {
      _loginLinkCache = { caseId: caseId, links: links, note: note || '' };
      showLoginLinks(links, note);
    };
    try {
      toast('Ищу логин-линк в админке Эдюсон…', 'info', 6000);

      // Основной путь — по ссылке из поля «АДМИНКА» (её уже нашёл магнит), не свободным поиском.
      let res = await lookupLoginLinks();

      // Запасной путь: поле АДМИНКА пустое → строгий поиск по amo-номеру (без свободного email).
      if (res.error === 'ADMINKA_EMPTY') {
        const st = GM_getValue(STORE_KEY) || {};
        const amoId = grabAmoIdFromPage() || st.amoLeadId || st.amoContactId || st.cardAmoId || '';
        if (!amoId) {
          toast('Поле АДМИНКА пустое, amo-номера тоже нет.\nНажми сначала магнит 🧲 — он заполнит админку.', 'warn', 10000);
          return;
        }
        res = await lookupLoginLinksByAmoId(amoId);
      }

      if (res.error === 'NOAUTH') {
        toast('Админка не пустила 😕\nОткрой www.eduson.tv, залогинься и нажми ключ снова.', 'warn', 10000);
        return;
      }
      const links = res.links || [];
      if (!links.length) {
        toast('Логин-линк не нашёлся: ' + (res.error || 'неизвестно') + '.', 'warn', 9000);
        return;
      }
      if (links.length === 1) {
        present(links);
        return;
      }
      // Несколько курсов: показываем ВСЕ логин-линки. Если по курсу обращения
      // что-то уверенно подобралось — этот линк подсвечиваем ★ и ставим первым,
      // но остальные тоже на виду (курс обращения не всегда = нужный курс).
      const best = pickLoginLinkByCourse(links, readCourseTarget());
      if (best) {
        best._matched = true;
        const ordered = [best].concat(links.filter(function (l) { return l !== best; }));
        present(ordered, '★ — курс обращения; если нужен другой, бери его');
      } else {
        present(links);
      }
    } catch (e) {
      toast('Ошибка при поиске логин-линка: ' + e.message, 'error');
    } finally {
      loginLinkBusy = false;
    }
  }

  // Одна иконка в шапке кейса (ключ / магнит). Размер — как у нативных иконок омника,
  // чтобы не торчали вверх и не залезали на панель справа.
  function makeHdrIcon(id, svgHtml, titleText) {
    const btn = document.createElement('div');
    btn.id = id;
    btn.title = titleText;
    btn.style.cssText = 'width:30px;height:28px;flex:0 0 auto;box-sizing:border-box;' +
      'display:flex;align-items:center;justify-content:center;cursor:pointer;' +
      'background:#fff;border:1px solid #DADCE0;border-radius:5px;box-shadow:0 1px 2px rgba(0,0,0,.12);transition:background .15s;';
    btn.innerHTML = svgHtml;
    const svg = btn.firstChild;
    // 19px на обе: viewBox магнита обрезан по глифу (был с большими полями и казался мельче ключа)
    if (svg && svg.style) { svg.style.width = '19px'; svg.style.height = '19px'; svg.style.display = 'block'; }
    btn.onmouseenter = function () { btn.style.background = '#EEF0F3'; if (svg) svg.style.fill = '#374151'; };
    btn.onmouseleave = function () { btn.style.background = '#fff'; if (svg) svg.style.fill = '#6B7280'; };
    btn._flash = function () { if (svg) { svg.style.fill = '#0284C7'; setTimeout(function () { svg.style.fill = '#6B7280'; }, 700); } };
    return btn;
  }

  // Ключ 🔑 + магнит 🧲 в шапке кейса OmniDesk — в одном контейнере, ПОСЛЕДНИМ ребёнком
  // панели `.request-content-title-act` (там нативное выравнивание работает).
  // Контейнер держим последним: если омник перерисовал шапку — на следующем «тике»
  // возвращаем на место. Высота 34px = высота строки → кнопки по центру, ничего не торчит.
  function ensureHeaderButtons() {
    if (!IS_OMNI) return;
    // Перешли на другой кейс (OmniDesk — SPA) — убираем окно логин-линка от прошлой карточки.
    const lb = document.getElementById('eduson-loginlink-box');
    if (lb && lb.dataset.caseId && lb.dataset.caseId !== omniCaseId()) lb.remove();
    const bar = document.querySelector('.request-content-title-act');
    if (!bar) {
      const ex = document.getElementById('eduson-hdr-btns');
      if (ex) ex.remove();
      return;
    }
    let wrap = document.getElementById('eduson-hdr-btns');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'eduson-hdr-btns';
      wrap.style.cssText = 'float:right;display:flex;align-items:center;gap:5px;height:34px;margin:0 14px 0 6px;';

      const keyBtn = makeHdrIcon('eduson-loginlink-btn', KEY_SVG,
        'Логин-линк студента (вход без пароля). Открывать только в инкогнито.');
      keyBtn.onclick = function (e) { e.stopPropagation(); keyBtn._flash(); copyLoginLink(); };

      const magBtn = makeHdrIcon('eduson-magnet-btn', MAGNET_SVG,
        'Заполнить карточку из amoCRM. Правый клик — панель с отчётом.');
      magBtn.onclick = function (e) { e.stopPropagation(); magBtn._flash(); smartFillOmni(); };
      magBtn.oncontextmenu = function (e) {
        e.preventDefault(); e.stopPropagation();
        ensurePanel();
        const p = document.getElementById('eduson-helper-panel');
        if (p) p.style.display = (p.style.display === 'none') ? 'flex' : 'none';
      };

      wrap.appendChild(keyBtn);   // ключ слева
      wrap.appendChild(magBtn);   // магнит справа
    }
    // всегда последним ребёнком шапки — не даём кнопкам «уехать»
    if (bar.lastElementChild !== wrap) bar.appendChild(wrap);
  }
  function mkBtn(text, big) {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = big
      ? 'background:' + HP_ACC + ';color:#fff;border:none;border-radius:16px;padding:8px 16px;font-size:12px;font-weight:700;box-shadow:0 2px 8px rgba(2,132,199,.28);font-family:' + HP_FONT + ';transition:all 0.2s;cursor:pointer;'
      : 'background:#fff;color:' + HP_ACC + ';border:1.5px solid ' + HP_ACC_BD + ';border-radius:999px;padding:4px 12px;font-size:10px;font-weight:700;cursor:pointer;font-family:' + HP_FONT + ';transition:all 0.2s;';
    b.onmouseenter = function () {
      b.style.opacity = '.85';
      b.style.transform = 'scale(0.98)';
    };
    b.onmouseleave = function () {
      b.style.opacity = '1';
      b.style.transform = 'scale(1)';
    };
    return b;
  }
  function toast(msg, type, ms, onTap) {
    const colors = { ok: '#16A34A', warn: '#D97706', error: '#DC2626', info: '#0284C7' };
    const box = document.createElement('div');
    // Компактная белая карточка внизу слева — не перекрывает карточку клиента справа.
    box.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:2147483647;max-width:340px;background:#fff;color:#1F2937;padding:10px 28px 10px 14px;border:1px solid #E5E7EB;border-radius:14px;font-size:12px;line-height:1.5;font-family:' + HP_FONT + ';white-space:pre-wrap;box-shadow:0 12px 36px rgba(15,23,42,.22);border-left:5px solid ' + (colors[type] || colors.info) + ';';
    if (typeof msg === 'object' && msg) {
      const rows = [
        msg.name    && '👤 ' + msg.name,
        msg.emails && msg.emails.length && '✉️ ' + msg.emails.join(', '),
        msg.phones && msg.phones.length && '📞 ' + msg.phones.join(', '),
        msg.course  && '📚 ' + msg.course,
        msg.support && '📅 ' + msg.support,
      ].filter(Boolean);
      const missed = ['name', 'emails', 'phones', 'course', 'support'].filter(k => !msg[k] || !msg[k].length);
      box.textContent = rows.length ? rows.join('\n') : 'Ничего не распознано 😕';
      if (missed.length) box.textContent += '\nНе нашлось в амо: ' + missed.join(', ');
      box.textContent += '\n— — —\nДанные сохранены.';
    } else {
      box.textContent = msg;
    }
    // Крестик в углу — просто закрывает окошко, скрипт продолжает работать
    const closeX = document.createElement('span');
    closeX.textContent = '✕';
    closeX.title = 'Закрыть (не останавливает скрипт)';
    closeX.style.cssText = 'position:absolute;top:5px;right:9px;cursor:pointer;color:#9CA3AF;font-size:13px;line-height:1;padding:2px;';
    closeX.onmouseenter = function () { closeX.style.color = '#0284C7'; };
    closeX.onmouseleave = function () { closeX.style.color = '#9CA3AF'; };
    closeX.onclick = function (e) { e.stopPropagation(); box.remove(); };
    box.appendChild(closeX);
    if (onTap) {
      box.style.cursor = 'pointer';
      box.style.borderStyle = 'solid dashed solid solid';
      box.onclick = function () { box.remove(); try { onTap(); } catch (e) {} };
    } else {
      box.onclick = function () { box.remove(); };
    }
    document.documentElement.appendChild(box);
    setTimeout(function () { box.remove(); }, ms || 9000);
  }
  /* ---------- запуск ---------- */
  if (IS_AMO || IS_OMNI) {
    console.log(TAG, 'запущен на', location.host, 'версия ' + VER);
    ensurePanel();
    removeHelperBadge();
    ensureHeaderButtons();
    setInterval(function () { ensurePanel(); removeHelperBadge(); ensureHeaderButtons(); }, 1500);
  }

  /* ==================== МОДУЛЬ «Пинги и теги» (бывший Eduson Curator — Tools) ====================
     Раньше был отдельным юзерскриптом Slytherin7k/Curator-Tools. Слит сюда: одна установка,
     одна версия, общий репозиторий. Код изолирован в своём замыкании — со «старым» Хэлпером
     не конфликтует (все имена локальные). Кнопка-чат 💬 сама встаёт в общий ряд #eduson-hdr-btns. */
  (function () {
    'use strict';
  const VER = '0.71.0'; // синхр. с Хэлпером
  const ON_OMNI = /(^|\.)omnidesk\.ru$/.test(location.hostname);
  const TAG = '[curator-tools]';
  const ACC = '#0284C7';
  const ACC_DEEP = '#075985';
  const ACC_BD = '#BAE6FD';
  const FONT = 'Nunito, system-ui, -apple-system, "Segoe UI", sans-serif';

  /* ==================== СПРАВОЧНИК ==================== */
  // Кластеры: продакт + лид контента + ключевые слова курса для автоподсказки.
  // Автоподсказка — не обязательна: в панели всегда можно выбрать кластер вручную.
  const CLUSTERS = {
    'Менеджмент': {
      product: { name: 'Александр Зырянов', tag: '@alexanderzyryanov' },
      lead: { name: 'Наталья Сухаг', tag: '@nataliya_suhag' },
      kw: ['коммерческ', 'генеральн', 'исполнительн', ' ceo', 'роп ', 'управление командами', 'управление командой',
           'директор по продаж', 'менеджер отдела продаж', 'менеджер по продаж', 'отдел продаж', 'soft skills',
           'софт скилл', 'софт-скилл', 'управление продажами', 'тайм-менеджмент', 'тайм менеджмент',
           'бизнес-консультант', 'бизнес консультант', 'директор по закупкам', 'клиентск', 'категорийн',
           'антикризис', 'малым бизнесом', 'госзакуп', 'управление закупками', 'для отдела продаж', 'руководител',
           'лидер', 'управление медицинск', 'менеджмент', 'управление персоналом организации', 'операционн управлени']
    },
    'Финансы': {
      product: { name: 'Зоя Гавриленко', tag: '@zoya_vlady' },
      lead: { name: 'Денис Соболев', tag: '@densoboldr' },
      kw: ['финанс', 'финдир', 'управление финансами', 'операционный директор', 'экономик', 'управление предприятием',
           'операционное управление', 'финансовое моделир', 'фин модел', 'стратегическому развитию',
           'стратегическое управление', 'нефинансист', 'по строительству', 'по производству', 'инвестицион',
           'emba', 'мсфо', 'бюджетир', 'казначей', 'управленческий учёт', 'управленческий учет']
    },
    'Бухгалтерия': {
      product: { name: 'Джу', tag: '@hey_juliko' },
      lead: { name: 'Алан Гадзаонов', tag: '@alangadzaonov' },
      kw: ['бухгалтер', 'бухучёт', 'бухучет', 'бухгалтерск', ' 1с', '1с:', 'зарплата и кадры', 'основы учёта',
           'основы учета', 'excel', 'эксель', 'google-таблиц', 'гугл-таблиц', 'ms office', 'мастер презентаций',
           'право для бизнеса', 'внутренний аудитор', 'аудит', 'налог', 'ндс', 'усн', 'первичк',
           'кадровое делопроизводств']
    },
    'Маркетинг и дизайн': {
      product: { name: 'Александр Шамша', tag: '@Ashamsha' },
      lead: { name: 'Анастасия Злобина', tag: '@zlobina_nastya' },
      kw: ['маркетолог', 'маркетинг', 'smm', 'смм', 'копирайт', 'веб-дизайн', 'веб дизайн', 'графическ дизайн',
           'дизайнер', 'дизайн интерьер', 'трафик', 'таргет', 'контекстн реклам', 'seo', 'сео', 'реклам',
           'бренд', 'пиар', ' pr ', 'контент-маркет', 'интерьер', '3ds max', '3д макс', '3d max', 'revit',
           'autodesk', 'фотошоп', 'photoshop', 'figma', 'фигма']
    },
    'IT и Аналитика': {
      product: { name: 'Дмитрий Пронин', tag: '@Dmitriy_PR0' },
      lead: { name: 'Екатерина Гудовская', tag: '@egudovskaia' },
      kw: ['аналитик', 'data science', 'дата сайнс', 'датасайнс', 'power bi', 'sql', ' bi ', ' bi:', 'python',
           'питон', 'frontend', 'фронтенд', 'бэкенд', 'backend', 'fullstack', 'фулстек', 'веб-разработчик',
           'веб разработчик', 'разработчик', 'разработк', 'программир', 'программист', 'кодинг', 'coding',
           'vibe coding', 'вайб', 'тестировщик', 'тестирован', 'qa', 'it-директор', 'it директор', 'it-специалист',
           'айти', 'devops', 'девопс', 'кибербез', 'информационн безопасн', 'базы данных', ' java', 'javascript',
           'c++', 'nocode', 'ноукод', 'low-code', 'машинн обучени', 'ml ', 'нейросет']
    },
    'МПП (маркетплейсы, проекты, продакт)': {
      product: { name: 'Михаил Свирин', tag: '@mikhail_svirin' },
      lead: { name: 'Анна Серебрякова', tag: '@serebryaka' },
      kw: ['менеджер проект', 'маркетплейс', 'продакт', 'продукт-менеджер', 'продуктовый', 'управление проект',
           'проектами', 'project manager', 'проджект', 'по логистике', 'логист', 'склад', 'wildberries',
           'вайлдберриз', ' wb ', 'ozon', 'озон', 'поставк', 'цифровое предприним', 'cpo', 'проектного офиса',
           'управление логистикой', 'цепями поставок', 'цепочк поставок', 'инженер пто', 'птo', 'autocad',
           'автокад', 'в строительстве', 'управление строит', 'девелопмент']
    },
    'HR и психология': {
      product: { name: 'Анна Фирсова', tag: '@yatriks' },
      lead: { name: 'Алиса Арцыман', tag: '@alicearts' },
      kw: ['психолог', 'психотерап', ' hr', 'hr-', 'hr:', 'эйчар', 'управлению персоналом', 'управление персоналом',
           'подбор персонала', 'рекрут', 'рекрутер', 'адаптац персонал', 'обучение и развитие', 't&d', 'методист',
           'методолог', 'образовательн программ', 'продюсер онлайн', 'продюсер курс', 'онлайн-репетитор',
           'репетитор', 'развитие персонала', 'обучению персонала', 'обучения персонала', 'обучение персонала',
           'кадровое делопроизводств', 'кадровое дело', 'бизнес-ассистент', 'ассистент руковод',
           'mini-mba', 'мини-mba', 'коуч', 'наставник']
    },
    'Отраслевое управление': {
      product: { name: 'Алиса Затона', tag: '@alisa_zatona' },
      lead: null,
      kw: ['отраслев', 'госсектор', 'государственн управлени', 'медицинск организац', 'управление в образован']
    },
    'Ресейл': {
      product: { name: 'Дмитрий Пронин', tag: '@Dmitriy_PR0' },
      lead: null,
      note: 'ресерчер — Николай Екимов @n_ekimov',
      kw: ['ресейл', 'resale']
    },
    'Детские курсы': {
      product: { name: 'Даниил Терентев', tag: '@dd_terentev' },
      lead: null,
      kw: ['детск', 'для детей', 'школьник', 'подростк', 'для ребёнк', 'для ребенк']
    }
  };
  const CLUSTER_NAMES = Object.keys(CLUSTERS);

  // Команды продаж: руководитель → тег + список МОП
  // mops: строка «Фамилия Имя» — либо пара ['Фамилия Имя', '@личный_тег'].
  // Личные теги МОПов собраны 31.08.2026 из ТГ-чата «Передача клиентов кураторам»
  // (см. reference-mop-tags). Без пары / без тега — в панели покажем тег руководителя.
  const TEAMS = {
    'Людмила Отрокуша': { tag: '@Mila_Otrokusha', dept: 'департамент Кобзева',
      mops: [['Косарев Юрий', '@KOSAREV_YURII'], ['Перова Юлия', '@perovayu'], ['Лобков Артур', '@lobkovartur'], ['Бондаренко Андрей', '@Bondarenko_Andreyy'], ['Мартышкина Ольга', '@martyshkinaolga'], ['Пасхалиди Димитрий', '@eduson_dimitri'], ['Зинченко Алена', '@alena_zinchenko27']] },
    'Александр Куликов': { tag: '@alexandrkulikof', dept: 'департамент Кобзева',
      mops: [['Ильина Диана', '@dianaailina'], ['Кухто Арина', '@arinakuhto'], ['Беспалов Евгений', '@EMBespalov'], ['Забродская Карина', '@Karina_Zabrodskaya'], ['Пухова Полина', '@polya1995'], ['Пруненко Татьяна', '@tanya_prunenko']] },
    'Александр Кондратьев': { tag: '@kondratev_av', dept: 'РОП Финансы и Бухгалтерия · департамент Кобзева',
      mops: [['Данилов Алексей', '@alexeydaniloov'], ['Руденко Оксана', '@Oksana_Ru4'], ['Рассомакин Иван', '@RassomakinI'], ['Шапошникова Натали', '@n_shaposhnikova'], ['Шевелева Ксения', '@Shevelevaks']] },
    'Марина Чехова': { tag: '@marinachekhova', dept: 'департамент Кобзева',
      mops: [['Жолобова Анастасия', '@anastasia_dmitrievna_8'], ['Крестьянникова Александра', '@aleksandrakrestyannikova'], ['Гурулёва Дарья', '@Darya39'], ['Шарапова Анастасия', '@Sharapova_nastena'], 'Соколова Анастасия', 'Иваненко Андрей'] },
    'Александр Фоменко': { tag: '@av_fomenko', dept: 'РОП Менеджмент, МПП и HR · департамент Шарипова',
      mops: [['Дубровина Ольга', '@dubrosha_o'], ['Попова Анастасия', '@Anastasiia_alex_p'], ['Красовский Антон', '@Anton_Eduson'], 'Гетманов Николай', ['Мишин Иван', '@Ivan8Mishin'], ['Костюк Матвей', '@matthew_perry_eee'], ['Иванов Алексей', '@AlexIvan07'], 'Байраковский Кирилл'] },
    'Виталий Львовский': { tag: '@lvovskiy_vit', dept: 'департамент Шарипова',
      mops: [['Кузнецова Екатерина', '@ekaterina_mnogoslov'], ['Шмаков Юрий', '@shmakov_y'], ['Зыбченко Анастасия', '@nastya_eduson'], ['Сопилкина Наталья', '@NataliSopilkina'], ['Соловьева Светлана', '@SolovevaSvetlanaV'], 'Пилипенко Ольга', ['Уварова Ольга', '@OlgaUvarovaEDU'], 'Скакун Артур'] },
    'Анар Шабанов': { tag: '@az_anar', dept: 'департамент Шарипова',
      mops: [['Константинова Екатерина', '@E_Konstantinovaa'], ['Тагиль Карина', '@Karinatahil'], ['Кузнецов Артур', '@artur_kuznecov'], ['Левченко Владислав', '@vlevchenko84'], ['Пименова Виктория', '@pimenovaviktoria'], ['Тихомирова Алина', '@alina_niz'], ['Сычева Татьяна', '@tanyasycheva']] },
    'Владислав Кожанов': { tag: '@kozhanov_eduson', dept: 'департамент Шарипова',
      mops: [['Печинога Валерия', '@Valeria_Pechinoga_Eduson'], ['Шеханова Лилия', '@liliya_shekhanova'], ['Негреева Диана', '@negreevadi'], ['Агаджанян Валерия', '@agad_val'], 'Рагимов Максун', 'Тихомирова Мария'] },
    'Денис Клементович': { tag: '@Klem_Den_lucky', dept: 'РОП IT и Аналитика',
      mops: [['Соколовский Александр', '@A_Sokolovskii'], ['Виноградов Виктор', '@Vic_Vinogradov'], ['Рябова Эльвира', '@rbv_elya'], ['Шум Карина', '@karinashum'], ['Качегова Даяна', '@sukskil'], ['Яловегин Николай', '@love_tea_oolong'], ['Ильницкий Илларион', '@illarion_ilnitskiy'], ['Гончарова Ирина', '@irinagoncharova63'], ['Денежкин Никита', '@n_denezhkin'], ['Журавлева Евгения', '@svobodacoach'], 'Зинкевич Елизавета'] },
    'Владимир Толстов': { tag: '@Vladimir_Tolstov_m', dept: 'РОП Маркетинг',
      mops: [['Прохорова Василиса', '@Vasilisa_Prokhorova'], ['Романова Людмила', '@romanovalyud'], ['Гусев Кирилл', '@digital_0000'], ['Квон Екатерина', '@Katerinakvon'], ['Сартакова Евгения', '@evgeniya_eduson'], ['Умнова Виктория', '@Umvikayar'], 'Максимов Владислав', 'Папко Екатерина'] },
    'Давид Багатурия': { tag: '@D_Bagaturia', dept: '',
      mops: [['Белеева Мария', '@maria_beleeva'], ['Фролова Екатерина', '@frol_katrin'], ['Лем Станислав', '@stan_lem'], ['Степанов Петр', '@PeterStepanov'], ['Михайлова Карина', '@karina_michailova'], ['Брудковски Александра', '@brudkovski'], ['Гагилев Дмитрий', '@Gagilev'], 'Вендин Максим', 'Золотарев Игорь'] }
  };

  // МОП (в любом порядке слов) → { tag: личный ТГ, rg: тег руководителя }. Для автоподстановки в пинги.
  const MOP_INDEX = (function () {
    const norm = function (s) {
      return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z]+/g, ' ')
        .trim().split(/\s+/).filter(Boolean).sort().join(' ');
    };
    const idx = {};
    Object.keys(TEAMS).forEach(function (lead) {
      const rg = TEAMS[lead].tag;
      TEAMS[lead].mops.forEach(function (m) {
        const nm = Array.isArray(m) ? m[0] : m;
        idx[norm(nm)] = { name: nm, tag: (Array.isArray(m) && m[1]) || '', rg: rg };
      });
    });
    return { get: function (name) { return idx[norm(name)] || null; } };
  })();

  const DZ_DEFAULT = { name: 'Мария Старцева', tag: '@maria_startceva' };
  const DZ_REVIEWERS = [
    { name: 'Даниил Тюрин', tag: '@TurinDE' },
    { name: 'Вадим Романенко', tag: '@vadim_romanenk0' },
    { name: 'Анна Серебрякова', tag: '@serebryaka' },
    { name: 'Яков Дмитриев', tag: '@Dmitriev_Yakov' },
    { name: 'Нина Пилипенко', tag: '@Chosi88' }
  ];

  const DIPLOMA_OWNER = { name: 'Антон Трепко', tag: '@anteneshe' };

  const ESCALATIONS = [
    { name: 'Юля Проняева', tag: '@yilya_pronyaeva', note: 'справки об оплате, дипломы, негатив из чатов, претензии, сложные и негативные кейсы, непонятки по тикетам · можно в чат онбординга' },
    { name: 'Маша Киликян', tag: '@Sh_enma', note: 'закрывающие документы, справки' },
    { name: 'Лена Чубарь', tag: '@El_Chubb', note: 'ЭДО по закрывающим' },
    { name: 'Антон Трепко', tag: '@anteneshe', note: 'отправка диплома, проверка в ФИС ФРДО · замещение Маши Киликян по закрывающим' },
    { name: 'Катя Дедловская', tag: '@ededlovskaya', note: 'стажировка в IT и дизайне — тегать в чатах соответствующих кластеров' },
    { name: 'Мария Дудникова', tag: '@dudnikovamary', note: 'отключение от рассылки контактов, маркетинг' },
    { name: 'Поиск эксперта для консультации', tag: '@ededlovskaya @ChristinaErnandez', note: 'Катя Дедловская, Кристина Эрнандес · доска в Notion + чат обсуждения консультаций — задачу на доску ставим всегда' }
  ];

  // B2B — тоже департамент. Директора департаментов + B2B.
  const DIRECTORS = [
    { name: 'Александр Кобзев', tag: '@A_Kobzev', note: 'департамент Финансы и Бухгалтерия' },
    { name: 'Вагиз Шарипов', tag: '@vagiz_sh', note: 'департамент Менеджмент, МПП и HR' },
    { name: 'Алексей Семериков', tag: '@Semerikov_Aleksey', note: 'департамент Маркетинг, IT и Аналитика' },
    { name: 'Лена Чубарь', tag: '@El_Chubb', note: 'департамент B2B' },
    { name: 'Ленара Галялиева', tag: '@Lenara_Galyalieva', note: 'департамент B2B' }
  ];

  // Пинги.
  //   suggest: 'leadcontent' (лид контента → продакт кластера), 'dz' (проверяющие),
  //            'diploma' (всегда Антон Трепко), 'paymanual' (МОП по имени + тег вписывает куратор), 'none'
  //   linkKind: 'notion' | 'admin' (автозаполн. из поля АДМИНКА) | 'asana' | 'amo' (автозаполн. номером сделки)
  //   linkLabel: слово-метка перед ссылкой (в Телеграм-версии становится кликабельным)
  //   {тег} {метка+ссылка} {моп} {цитата} {имя} {email} {телефон} — подставляются.
  const PINGS = [
    { id: 'question', title: 'Завис вопрос', suggest: 'leadcontent', linkKind: 'notion', linkLabel: 'Вопрос',
      text: '{тег}\nПривет! Подвис вопрос от студента — посмотри, пожалуйста.\n{ссылка}',
      textNoResp: '{тег}\nПривет! Подвис вопрос от студента, ответственного нет — посмотри, пожалуйста.\n{ссылка}' },
    { id: 'dz', title: 'Зависла проверка ДЗ', suggest: 'dz', linkKind: 'homework', linkLabel: 'Карточка ДЗ',
      text: '{тег}\nПривет! Подвисла проверка ДЗ — посмотри, пожалуйста.\n{ссылка}' },
    { id: 'sending', title: 'Задержка отправки диплома', suggest: 'diploma', linkKind: 'asana', linkLabel: 'Задача в Асане',
      text: '{тег}\nПривет! Подвисла отправка диплома, задержка уже большая — возьми, пожалуйста, в ближайшую очередь.\n{ссылка}' },
    { id: 'payment', title: 'Вопрос по оплате / подарочному курсу', suggest: 'paymanual', linkKind: 'amo', linkLabel: 'Сделка',
      text: '{тег}\nПривет! Студент написал в амо по оплате / подарочному курсу — свяжись с ним, пожалуйста.\n{ссылка}' },
    { id: 'lead', title: 'Новый лид', suggest: 'none', linkKind: 'none',
      text: '✳️ НОВЫЙ ЛИД ✳️\nВозьмите в работу, пожалуйста.\n\nСообщение клиента:\n«{цитата}»\n\n{имя}\n{email}\n{телефон}' }
  ];

  /* ==================== ЧТЕНИЕ КОНТЕКСТА ==================== */
  function caseUrl() { return location.href.split('?')[0].split('#')[0]; }

  function sidebarValue(labelRe) {
    const labs = document.querySelectorAll('.right_info_panels *, #info_panel_wrap *, .info_panel_nano *');
    for (const el of labs) {
      const t = (el.textContent || '').trim();
      if (t.length > 40 || !labelRe.test(t)) continue;
      // значение — в следующем элементе или в родителе после лейбла
      let v = el.nextElementSibling && el.nextElementSibling.textContent;
      if (!v && el.parentElement) v = el.parentElement.textContent.replace(t, '');
      v = (v || '').replace(/\s+/g, ' ').trim();
      if (v && v !== '—' && v !== '-') return v;
    }
    return '';
  }

  function readCourse() { return sidebarValue(/^курс$/i); }

  function readUser() {
    return {
      name: sidebarValue(/^(полное имя|имя)$/i),
      email: sidebarValue(/^(email|e-mail|email-адрес|почта)$/i),
      phone: sidebarValue(/^(телефон|phone)$/i)
    };
  }

  function clientMsgs() {
    // сообщения клиента в переписке OmniDesk: li[id^="message_"] .js_only_text_orig,
    // клиентские — обычно без класса менеджера/бота
    const items = document.querySelectorAll('li[id^="message_"]');
    const res = [];
    items.forEach(function (li) {
      const c = (li.className || '') + ' ' + ((li.querySelector('.chat_msg_wrap') || {}).className || '');
      if (/manager|staff|bot|system|note|_ai|robot/i.test(c)) return;
      const t = li.querySelector('.js_only_text_orig') || li.querySelector('.js_only_text');
      const txt = (t ? t.textContent : '').replace(/\s+/g, ' ').trim();
      if (txt && !/^https?:\/\/\S+$/.test(txt)) res.push(txt);
    });
    return res;
  }
  function lastClientMsg() { const m = clientMsgs(); return m[m.length - 1] || ''; }
  function firstClientMsg() { const m = clientMsgs(); return m[0] || ''; }

  function amoDealNum() {
    const num = sidebarValue(/amocrm/i);
    let m = (num || '').match(/\d{5,}/);
    if (m) return m[0];
    const a = Array.from(document.querySelectorAll('a[href*="/leads/detail/"]'))
      .find(function (x) { return /leads\/detail\/\d+/.test(x.href); });
    m = a && a.href.match(/leads\/detail\/(\d+)/);
    return m ? m[1] : '';
  }
  function amoLink() {
    const n = amoDealNum();
    return n ? ('https://eduson.amocrm.ru/leads/detail/' + n) : '';
  }

  function adminLink() {
    const a = Array.from(document.querySelectorAll('.right_info_panels a[href*="eduson.tv/admin"], #info_panel_wrap a[href*="eduson.tv/admin"]'))[0];
    if (a) return a.href;
    const v = sidebarValue(/^админк/i);
    return /^https?:\/\//.test(v) ? v : '';
  }

  function autoLink(kind) {
    if (kind === 'amo') return amoLink();
    if (kind === 'admin') return adminLink();
    return ''; // notion, asana, homework — вписывает куратор
  }

  /* ---------- amoCRM: имя МОП по сделке ---------- */
  function gmFetch(url) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'GET', url: url, timeout: 15000,
        headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' },
        onload: function (res) {
          if (res.status === 200) {
            try { resolve(JSON.parse(res.responseText)); } catch (e) { reject(new Error('bad-json')); }
          } else if (res.status === 204) { resolve({}); }
          else if (res.status === 401 || res.status === 403) { reject(new Error('NOAUTH')); }
          else { reject(new Error('http-' + res.status)); }
        },
        onerror: function () { reject(new Error('net')); },
        ontimeout: function () { reject(new Error('timeout')); }
      });
    });
  }
  // Кто продал сделку. Источники по надёжности:
  //  1) заметка «Коллега <Имя> продал курс…» — фактическая запись о продаже (как у Возврат-мастера);
  //  2) поле сделки «УР МОП» / «Первый Менеджер» / «Менеджер КЦ».
  // Никаких догадок (по «Лид получил» / ответственному — там часто не тот). Возвращает { name, sure, err }.
  async function fetchMopName(dealNum) {
    if (!dealNum) return { name: '', sure: false, err: 'no-deal' };
    const base = 'https://eduson.amocrm.ru';

    // 1) заметка о продаже
    try {
      const j = await gmFetch(base + '/api/v4/leads/' + dealNum + '/notes?filter[note_type]=common&order[id]=desc&limit=250');
      const notes = ((j && j._embedded) || {}).notes || [];
      for (const n of notes) {
        const t = (n.params && (n.params.text || n.params.message)) || '';
        const m = t.match(/Коллега\s+(.+?)\s+продал/i);
        if (m) return { name: m[1].replace(/["'«».,]+/g, '').replace(/\s+/g, ' ').trim(), sure: true, err: '' };
      }
    } catch (e) { if (e.message === 'NOAUTH') return { name: '', sure: false, err: 'NOAUTH' }; }

    // 2) поле сделки
    let l;
    try { l = await gmFetch(base + '/api/v4/leads/' + dealNum); }
    catch (e) { return { name: '', sure: false, err: e.message }; }
    const cf = (l && l.custom_fields_values) || [];
    const fieldVal = function (re) {
      const f = cf.find(function (x) { return re.test(x.field_name || ''); });
      const v = f && f.values && f.values[0] && f.values[0].value;
      return (typeof v === 'string' && /[а-яёa-z]/i.test(v)) ? v.replace(/\s+/g, ' ').trim() : '';
    };
    const mop = fieldVal(/^ур\s*моп$/i) || fieldVal(/первый\s*менеджер/i) || fieldVal(/менеджер\s*кц/i);
    if (mop) return { name: mop, sure: true, err: '' };

    return { name: '', sure: false, err: '' };
  }

  function detectCluster(course) {
    const c = (course || readCourse() || '').toLowerCase().replace(/ё/g, 'е');
    if (!c) return null;
    let best = null, bestLen = 0;
    for (const name in CLUSTERS) {
      for (const k of CLUSTERS[name].kw) {
        if (c.indexOf(k) !== -1 && k.length > bestLen) { best = name; bestLen = k.length; }
      }
    }
    return best;
  }

  // Поле «Кластер» самой сделки в амо (короткий код) → наш кластер. Надёжнее, чем угадывать по курсу.
  const AMO_CLUSTER_MAP = {
    'hr': 'HR и психология',
    'it': 'IT и Аналитика', 'аналитика': 'IT и Аналитика',
    'финансы': 'Финансы',
    'маркетинг': 'Маркетинг и дизайн', 'дизайн': 'Маркетинг и дизайн', 'маркетинг и дизайн': 'Маркетинг и дизайн',
    'менеджмент': 'Менеджмент',
    'бухгалтерия': 'Бухгалтерия', 'бухучет': 'Бухгалтерия',
    'мпп': 'МПП (маркетплейсы, проекты, продакт)',
    'ресейл': 'Ресейл',
    'детские курсы': 'Детские курсы', 'детские': 'Детские курсы',
    'отраслевое управление': 'Отраслевое управление', 'отраслевое': 'Отраслевое управление'
  };
  async function clusterFromAmoDeal(dealNum) {
    if (!dealNum) return null;
    let l;
    try { l = await gmFetch('https://eduson.amocrm.ru/api/v4/leads/' + dealNum); }
    catch (e) { return null; }
    const cf = (l && l.custom_fields_values) || [];
    const f = cf.find(function (x) { return /^кластер$/i.test(x.field_name || ''); });
    const raw = f && f.values && f.values[0] && String(f.values[0].value || '').toLowerCase().replace(/ё/g, 'е').trim();
    if (!raw) return null;
    return AMO_CLUSTER_MAP[raw] || null;
  }

  /* ==================== ПОДСТАНОВКА В ПИНГ ==================== */
  // Кого предложить в выборе тега.
  function suggestTags(ping, cluster) {
    if (ping.suggest === 'dz') {
      return [{ label: DZ_DEFAULT.name + ' — по умолчанию', tag: DZ_DEFAULT.tag }]
        .concat(DZ_REVIEWERS.map(function (d) { return { label: d.name, tag: d.tag }; }));
    }
    if (ping.suggest === 'diploma') {
      return [{ label: DIPLOMA_OWNER.name + ' — ответственный по дипломам', tag: DIPLOMA_OWNER.tag }];
    }
    if (ping.suggest === 'leadcontent') {
      if (!cluster || !CLUSTERS[cluster]) return [];
      const c = CLUSTERS[cluster];
      const r = [];
      if (c.lead) r.push({ label: 'Лид контента · ' + c.lead.name, tag: c.lead.tag });
      r.push({ label: 'Продакт · ' + c.product.name, tag: c.product.tag });
      return r;
    }
    return [];
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Возвращает { plain, html } — html-версия делает слово-метку кликабельной (для вставки в Telegram Desktop).
  function pingFill(ping, tag, link, mop, noResp) {
    const u = readUser();
    const quote = ping.id === 'lead' ? (firstClientMsg() || lastClientMsg()) : lastClientMsg();
    const lbl = ping.linkLabel || 'Ссылка';
    // «Завис вопрос» без ответственного — отдельный текст (см. ping.textNoResp).
    const baseText = (noResp && ping.textNoResp) ? ping.textNoResp : ping.text;
    const linkPlain = link ? (lbl + ': ' + link) : (lbl + ': {вставь ссылку}');
    const linkHtml = link
      ? ('<a href="' + escapeHtml(link) + '">' + escapeHtml(lbl) + '</a>')
      : (escapeHtml(lbl) + ': {вставь ссылку}');

    function build(linkPart) {
      return baseText
        .replace('{тег}', tag || '{тег}')
        .replace('{ссылка}', linkPart)
        .replace('{моп}', mop || '{имя МОП}')
        .replace('{цитата}', quote || '{цитата из сообщения}')
        .replace('{имя}', u.name || '{имя}')
        .replace('{email}', u.email || '{email}')
        .replace('{телефон}', u.phone || '{телефон}');
    }
    const html = escapeHtml(build('@@LINK@@')).replace('@@LINK@@', linkHtml).replace(/\n/g, '<br>');
    return { plain: build(linkPlain), html: html };
  }

  /* ==================== UI ==================== */
  function copyText(t) {
    try { GM_setClipboard(t); } catch (e) {
      try { navigator.clipboard.writeText(t); } catch (e2) {}
    }
  }

  // Копирует и обычный текст, и html (Telegram Desktop сохраняет кликабельную ссылку).
  function copyRich(plain, html) {
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        navigator.clipboard.write([new window.ClipboardItem({
          'text/plain': new Blob([plain], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' })
        })]).catch(function () { copyText(plain); });
        return;
      }
    } catch (e) {}
    copyText(plain);
  }

  let toastTimer = null;
  function toast(msg, ms) {
    let box = document.getElementById('curator-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'curator-toast';
      box.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:2147483647;max-width:320px;background:#fff;color:#1F2937;padding:10px 14px;border:1px solid #E5E7EB;border-left:5px solid ' + ACC + ';border-radius:12px;font:600 12px/1.5 ' + FONT + ';white-space:pre-wrap;box-shadow:0 12px 36px rgba(15,23,42,.22);';
      document.body.appendChild(box);
    }
    box.textContent = msg;
    box.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.style.display = 'none'; }, ms || 2600);
  }

  function elt(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }

  // Панель можно таскать за шапку; позиция запоминается (curatorPanelPos).
  function makePanelDraggable(box, handle) {
    let sx, sy, ox, oy, drag = false;
    handle.addEventListener('mousedown', function (e) {
      if (e.target && e.target.tagName === 'SPAN') return; // крестик закрытия
      drag = true;
      const r = box.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!drag) return;
      let nx = ox + (e.clientX - sx), ny = oy + (e.clientY - sy);
      nx = Math.max(4, Math.min(nx, window.innerWidth - 60));
      ny = Math.max(4, Math.min(ny, window.innerHeight - 30));
      box.style.left = nx + 'px'; box.style.top = ny + 'px'; box.style.right = 'auto';
    });
    document.addEventListener('mouseup', function () {
      if (!drag) return;
      drag = false;
      try { GM_setValue('curatorPanelPos', JSON.stringify({ x: parseInt(box.style.left, 10), y: parseInt(box.style.top, 10) })); } catch (e) {}
    });
  }

  const PANEL_ID = 'curator-panel';
  function togglePanel() {
    let p = document.getElementById(PANEL_ID);
    if (p) { p.remove(); return; }
    p = buildPanel();
    document.body.appendChild(p);
  }

  function buildPanel() {
    const p = elt('div', 'position:fixed;z-index:2147483646;width:336px;max-height:82vh;overflow-x:hidden;overflow-y:auto;' +
      'background:#fff;color:#1F2937;border:1px solid #E5E7EB;border-radius:14px;box-shadow:0 18px 48px rgba(15,23,42,.24);' +
      'font-family:' + FONT + ';padding:9px 11px;');
    p.id = PANEL_ID;

    // позиция: запомненная или по умолчанию (правый верх)
    let pos = null;
    try { pos = JSON.parse(GM_getValue('curatorPanelPos') || 'null'); } catch (e) { pos = null; }
    if (pos && isFinite(pos.x) && isFinite(pos.y)) {
      p.style.left = Math.max(4, Math.min(pos.x, window.innerWidth - 60)) + 'px';
      p.style.top = Math.max(4, Math.min(pos.y, window.innerHeight - 30)) + 'px';
    } else {
      p.style.right = '18px'; p.style.top = '64px';
    }

    const head = elt('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;cursor:move;user-select:none;');
    head.appendChild(elt('div', 'font-weight:800;font-size:12px;color:' + ACC + ';letter-spacing:.3px;', '⠿ Пинги и теги'));
    const x = elt('span', 'cursor:pointer;color:#9CA3AF;font-size:15px;line-height:1;', '✕');
    x.onclick = togglePanel;
    head.appendChild(x);
    p.appendChild(head);
    makePanelDraggable(p, head);

    // вкладки
    const tabs = elt('div', 'display:flex;gap:6px;margin-bottom:8px;');
    const body = elt('div', '');
    const mkTab = function (label, fn) {
      const b = elt('div', 'flex:1;text-align:center;cursor:pointer;font-weight:800;font-size:11px;padding:6px 0;border-radius:999px;border:1.5px solid ' + ACC_BD + ';color:' + ACC + ';', label);
      b.onclick = function () {
        Array.from(tabs.children).forEach(function (t) { t.style.background = '#fff'; t.style.color = ACC; });
        b.style.background = ACC; b.style.color = '#fff';
        body.innerHTML = '';
        fn(body);
      };
      return b;
    };
    lessonCache = null; _lectCache = {}; // списки уроков — свои у каждого студента, обновляем при открытии
    const tPing = mkTab('Пинги', renderPings);
    const tTag = mkTab('Теги', renderTags);
    const tDoc = mkTab('Документ', renderDoc);
    const tLesson = mkTab('Урок', renderLesson);
    tabs.appendChild(tPing);
    tabs.appendChild(tTag);
    tabs.appendChild(tDoc);
    tabs.appendChild(tLesson);
    p.appendChild(tabs);
    p.appendChild(body);
    tPing.onclick();
    return p;
  }

  function renderPings(body) {
    PINGS.forEach(function (ping) {
      const row = elt('div', 'border:1px solid #E5E7EB;border-radius:12px;padding:9px 11px;margin-bottom:7px;cursor:pointer;font-weight:800;font-size:12.5px;');
      row.textContent = ping.title;
      row.onclick = function () { showPingResult(body, ping); };
      row.onmouseenter = function () { row.style.borderColor = ACC_BD; row.style.background = '#F0F9FF'; };
      row.onmouseleave = function () { row.style.borderColor = '#E5E7EB'; row.style.background = '#fff'; };
      body.appendChild(row);
    });
  }

  const fieldLabel = 'font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#9CA3AF;margin:10px 0 3px;';
  const inputCss = 'width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid #D1D5DB;border-radius:9px;font:600 12.5px ' + FONT + ';color:#111827;background:#fff;';

  const LINK_META = {
    notion: { label: 'Ссылка на карточку Notion', ph: 'ссылка на карточку Notion' },
    admin: { label: 'Ссылка на карточку в админке', ph: 'https://www.eduson.tv/admin/…' },
    homework: { label: 'Ссылка на карточку ДЗ', ph: 'https://…eduson.tv/ru/dashboard/homework_attempts/…' },
    asana: { label: 'Ссылка на задачу в Asana', ph: 'ссылка на задачу в Asana' },
    amo: { label: 'Ссылка на сделку', ph: 'https://eduson.amocrm.ru/leads/detail/…' }
  };

  function showPingResult(body, ping) {
    body.innerHTML = '';
    const back = elt('div', 'font-size:11px;font-weight:800;color:' + ACC + ';cursor:pointer;margin-bottom:6px;', '‹ назад к пингам');
    back.onclick = function () { body.innerHTML = ''; renderPings(body); };
    body.appendChild(back);
    body.appendChild(elt('div', 'font-weight:800;font-size:13px;margin-bottom:2px;', ping.title));

    let lastHtml = '';

    // --- Кластер (только для 'leadcontent') ---
    let clusterSel = null;
    if (ping.suggest === 'leadcontent') {
      const crs = readCourse();
      const byCourse = detectCluster(crs);
      const clLabel = elt('div', fieldLabel, 'Кластер' + (byCourse ? '' : ' — курс не распознан, выбери'));
      body.appendChild(clLabel);
      clusterSel = elt('select', inputCss);
      clusterSel.appendChild(new Option('— выбери кластер —', ''));
      CLUSTER_NAMES.forEach(function (n) { clusterSel.appendChild(new Option(n, n)); });
      clusterSel.value = byCourse || '';
      body.appendChild(clusterSel);
      if (crs) body.appendChild(elt('div', 'font-size:10.5px;color:#9CA3AF;font-weight:600;margin-top:2px;', 'курс: ' + crs));
      // надёжнее — поле «Кластер» самой сделки в амо; подтянется чуть позже,
      // но только если куратор к этому моменту ещё не выбрал что-то руками.
      const clInitial = byCourse || '';
      const deal = amoDealNum();
      if (deal) {
        clusterFromAmoDeal(deal).then(function (fromDeal) {
          if (fromDeal && fromDeal !== clusterSel.value && clusterSel.value === clInitial) {
            clusterSel.value = fromDeal;
            clLabel.textContent = 'Кластер — из сделки в амо';
            if (clusterSel.onchange) clusterSel.onchange();
          }
        });
      }
    }

    // --- МОП (только для 'paymanual') — подсказка кому писать, в текст пинга НЕ идёт ---
    let mopInput = null, mopNote = null;
    if (ping.suggest === 'paymanual') {
      body.appendChild(elt('div', fieldLabel, 'МОП сделки (для справки, в пинг не идёт)'));
      mopInput = elt('input', inputCss);
      mopInput.placeholder = 'кто вёл сделку';
      body.appendChild(mopInput);
      mopNote = elt('div', 'font-size:10.5px;color:#9CA3AF;font-weight:600;margin-top:2px;', '');
      body.appendChild(mopNote);
      const deal = amoDealNum();
      if (deal) {
        mopNote.textContent = 'смотрю в амо (сделка ' + deal + ')…';
        fetchMopName(deal).then(function (r) {
          if (r.name) {
            mopInput.value = r.name;
            mopNote.textContent = r.sure ? 'из амо — кто продал сделку' : 'по данным амо — проверь, тот ли это МОП';
            applyMopTag(r.name);
            recompute();
          } else if (r.err === 'NOAUTH') {
            mopNote.textContent = 'амо не пустило (' + deal + '). Открой eduson.amocrm.ru в соседней вкладке, войди, вернись и открой пинг заново. Если не помогает — впиши МОП сам.';
          } else if (r.err && r.err !== 'no-deal') {
            mopNote.textContent = 'амо ответило «' + r.err + '» по сделке ' + deal + ' — впиши имя МОП сам.';
          } else {
            mopNote.textContent = 'МОП в амо не нашёлся — впиши имя сам.';
          }
        }).catch(function () {
          mopNote.textContent = 'не получилось прочитать амо — впиши имя МОП сам.';
        });
      } else {
        mopNote.textContent = 'номера сделки в карточке нет — впиши имя сам.';
      }
    }

    // --- Кому (выбор тега) ---
    let tagSel = null, manualInput = null, respSel = null;
    const needTag = ping.suggest !== 'none';
    if (needTag) {
      // Для «завис вопрос»: тег на лида контента идёт только когда ответственного нет.
      if (ping.suggest === 'leadcontent') {
        body.appendChild(elt('div', fieldLabel, 'Ответственный по вопросу'));
        respSel = elt('select', inputCss);
        respSel.appendChild(new Option('Нет ответственного — тег лида контента', 'lead'));
        respSel.appendChild(new Option('Есть ответственный — впишу тег сам', 'own'));
        body.appendChild(respSel);
      }
      body.appendChild(elt('div', fieldLabel, ping.suggest === 'paymanual' ? 'Тег (впиши сам)' : 'Кому'));
      manualInput = elt('input', inputCss);
      manualInput.placeholder = '@тег';
      if (ping.suggest !== 'paymanual') {
        tagSel = elt('select', inputCss);
        body.appendChild(tagSel);
        manualInput.style.cssText = inputCss + 'margin-top:5px;display:none;';
      }
      body.appendChild(manualInput);
    }

    // --- Ссылка (для «Новый лид» ссылки нет — linkKind 'none') ---
    let linkInput = null;
    if (ping.linkKind && ping.linkKind !== 'none') {
      const lm = LINK_META[ping.linkKind] || LINK_META.notion;
      body.appendChild(elt('div', fieldLabel, lm.label));
      linkInput = elt('input', inputCss);
      linkInput.placeholder = lm.ph;
      linkInput.value = autoLink(ping.linkKind);
      body.appendChild(linkInput);
    }

    // --- Превью ---
    body.appendChild(elt('div', fieldLabel, 'Текст пинга'));
    const ta = elt('textarea', 'width:100%;box-sizing:border-box;min-height:150px;border:1px solid #D1D5DB;border-radius:10px;padding:8px 10px;font:500 12px/1.5 ' + FONT + ';color:#111827;resize:vertical;');
    body.appendChild(ta);

    // Автоподстановка тега МОПа в поле «Тег» (для 'paymanual'). Не затираем то, что куратор уже вписал.
    let mopTagBase = '';
    function applyMopTag(name) {
      if (ping.suggest !== 'paymanual' || !manualInput) return;
      const mi = MOP_INDEX.get(name);
      const t = mi ? (mi.tag || mi.rg) : '';
      if (t && !manualInput.value.trim()) manualInput.value = t;
      if (mopNote) {
        if (!mopTagBase) mopTagBase = mopNote.textContent;
        mopNote.textContent = mopTagBase + (
          !mi ? ' · тег в справочнике не нашла — впиши сам'
            : mi.tag ? ' · тег подставлен'
            : ' · личного тега нет — тег РГ ' + mi.rg);
      }
    }

    function chosenTag() {
      if (!needTag) return '';
      if (respSel && respSel.value === 'own') return manualInput.value.trim();
      if (tagSel && tagSel.value !== '__manual__') return tagSel.value;
      return manualInput.value.trim();
    }
    function recompute() {
      const noResp = !!(respSel && respSel.value === 'lead');
      const r = pingFill(ping, chosenTag(), linkInput ? linkInput.value.trim() : '', mopInput ? mopInput.value.trim() : '', noResp);
      ta.value = r.plain;
      lastHtml = r.html;
    }
    function fillTagSel() {
      if (!tagSel) return;
      tagSel.innerHTML = '';
      const opts = suggestTags(ping, clusterSel ? clusterSel.value : null);
      if (!opts.length) tagSel.appendChild(new Option(ping.suggest === 'leadcontent' ? '— сначала выбери кластер —' : '—', ''));
      opts.forEach(function (o) { tagSel.appendChild(new Option(o.label + '  ·  ' + o.tag, o.tag)); });
      if (!respSel) tagSel.appendChild(new Option('— вписать тег вручную —', '__manual__'));
      tagSel.value = opts.length ? opts[0].tag : '';
      if (!respSel) manualInput.style.display = 'none';
    }
    // «есть / нет ответственного» — переключает выбор лида контента ↔ ручной тег.
    function applyResp() {
      if (!respSel) return;
      const own = respSel.value === 'own';
      if (tagSel) tagSel.style.display = own ? 'none' : 'block';
      manualInput.style.display = own ? 'block' : 'none';
      recompute();
    }
    fillTagSel();
    applyResp();
    recompute();

    if (respSel) respSel.onchange = applyResp;
    if (clusterSel) clusterSel.onchange = function () { fillTagSel(); recompute(); };
    if (tagSel) tagSel.onchange = function () {
      if (!respSel) manualInput.style.display = tagSel.value === '__manual__' ? 'block' : 'none';
      recompute();
    };
    if (manualInput) manualInput.oninput = recompute;
    if (mopInput) mopInput.oninput = function () {
      // куратор поправил МОПа — подставим тег из справочника (если поле тега ещё пустое)
      applyMopTag(mopInput.value.trim());
      recompute();
    };
    if (linkInput) linkInput.oninput = recompute;
    ta.oninput = function () { lastHtml = ''; };

    const copyB = elt('div', 'margin-top:9px;text-align:center;background:' + ACC + ';color:#fff;font-weight:800;font-size:12px;padding:9px 0;border-radius:12px;cursor:pointer;', '📋 Копировать');
    copyB.onclick = function () {
      if (lastHtml) copyRich(ta.value, lastHtml); else copyText(ta.value);
      toast('Скопировано — вставь в нужный чат Телеграм');
    };
    body.appendChild(copyB);
  }

  // Вкладка «Теги» — отдельные разделы, внутри «Команд продаж» — подразделы по руководителям.
  function buildTagSections() {
    const prod = [], leads = [];
    CLUSTER_NAMES.forEach(function (name) {
      const c = CLUSTERS[name];
      const kw = (c.kw || []).join(' ');
      prod.push({ name: name + ' — ' + c.product.name, tag: c.product.tag, note: c.note || '', kw: kw });
      if (c.lead) leads.push({ name: name + ' — ' + c.lead.name, tag: c.lead.tag, note: '', kw: kw });
    });
    const teams = Object.keys(TEAMS).map(function (lead) {
      const t = TEAMS[lead];
      return {
        head: { name: lead, note: 'руководитель' + (t.dept ? ' · ' + t.dept : ''), tag: t.tag },
        rows: t.mops.map(function (m) {
          const nm = Array.isArray(m) ? m[0] : m;
          const own = Array.isArray(m) && m[1];
          return { name: nm, tag: own || t.tag, note: own ? '' : 'личного тега нет — тег РГ' };
        })
      };
    });
    return [
      { title: 'Продакты по кластерам', rows: prod },
      { title: 'Лиды контента', rows: leads },
      { title: 'Проверяющие ДЗ', rows: [{ name: DZ_DEFAULT.name, tag: DZ_DEFAULT.tag, note: 'по умолчанию' }]
        .concat(DZ_REVIEWERS.map(function (d) { return { name: d.name, tag: d.tag, note: '' }; })) },
      { title: 'Эскалации', rows: ESCALATIONS.map(function (e) { return { name: e.name, tag: e.tag, note: e.note }; }) },
      { title: 'Директора департаментов', rows: DIRECTORS.map(function (d) { return { name: d.name, tag: d.tag, note: d.note }; }) },
      { title: 'Команды продаж (МОП)', teams: teams }
    ];
  }
  const TAG_SECTIONS = buildTagSections();

  function matchRow(row, terms) {
    if (!terms.length) return true;
    const hay = (row.name + ' ' + row.tag + ' ' + (row.note || '') + ' ' + (row.kw || '')).toLowerCase().replace(/ё/g, 'е');
    return terms.every(function (t) { return hay.indexOf(t) !== -1; });
  }

  function renderTags(body) {
    const q = elt('input', 'width:100%;padding:8px 11px;border:1px solid #D1D5DB;border-radius:10px;font:600 13px ' + FONT + ';color:#111827;margin-bottom:8px;');
    q.type = 'search';
    q.placeholder = 'Поиск: МОП, кластер, имя, тег…';
    body.appendChild(q);
    const host = elt('div', '');
    body.appendChild(host);

    function tagRow(row, indent) {
      // Две строки: имя (+ примечание) сверху, тег снизу — ничего не сливается и не едет.
      const it = elt('div', 'padding:6px 8px 6px ' + (indent || 8) + 'px;border-radius:8px;cursor:pointer;');
      it.appendChild(elt('div', 'font-size:12.5px;font-weight:700;color:#111827;line-height:1.35;', row.name));
      const meta = elt('div', 'display:flex;flex-wrap:wrap;gap:4px 8px;margin-top:1px;align-items:baseline;');
      if (row.tag) meta.appendChild(elt('span', 'font:500 11.5px IBM Plex Mono,' + FONT + ';color:' + ACC_DEEP + ';', row.tag));
      else meta.appendChild(elt('span', 'font-size:11px;color:#9CA3AF;font-weight:600;', 'тега нет'));
      if (row.note) meta.appendChild(elt('span', 'font-size:11px;color:#9CA3AF;font-weight:600;', row.note));
      it.appendChild(meta);
      it.onmouseenter = function () { it.style.background = '#F0F9FF'; };
      it.onmouseleave = function () { it.style.background = 'transparent'; };
      it.onclick = function () {
        if (!row.tag) { toast('У ' + row.name + ' тега нет'); return; }
        copyText(row.tag); toast('Скопирован тег ' + row.tag);
      };
      return it;
    }
    function collapsible(titleText, count, openByDefault) {
      const wrap = elt('div', 'border-bottom:1px solid #EEF2F5;');
      const head = elt('div', 'display:flex;justify-content:space-between;align-items:center;cursor:pointer;padding:8px 4px;font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#6B7280;');
      const cont = elt('div', 'padding-bottom:6px;' + (openByDefault ? '' : 'display:none;'));
      const caret = elt('span', 'color:#9CA3AF;font-size:10px;', openByDefault ? '▲' : '▼');
      head.appendChild(elt('span', '', titleText + '  (' + count + ')'));
      head.appendChild(caret);
      head.onclick = function () {
        const open = cont.style.display === 'none';
        cont.style.display = open ? 'block' : 'none';
        caret.textContent = open ? '▲' : '▼';
      };
      wrap.appendChild(head); wrap.appendChild(cont);
      wrap._open = function () { cont.style.display = 'block'; caret.textContent = '▲'; };
      wrap._cont = cont;
      return wrap;
    }

    function draw() {
      const terms = q.value.trim().toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean);
      const searching = terms.length > 0;
      host.innerHTML = '';
      let anyHit = false;

      TAG_SECTIONS.forEach(function (sec) {
        if (sec.teams) {
          let teamMatches = [];
          sec.teams.forEach(function (t) {
            const hRows = t.rows.filter(function (r) { return matchRow(r, terms); });
            const headHit = matchRow(t.head, terms);
            if (searching && !headHit && !hRows.length) return;
            teamMatches.push({ t: t, rows: searching ? (headHit ? t.rows : hRows) : t.rows });
          });
          if (searching && !teamMatches.length) return;
          const total = teamMatches.reduce(function (a, x) { return a + x.rows.length + 1; }, 0);
          const box = collapsible(sec.title, total, searching);
          teamMatches.forEach(function (tm) {
            const sub = collapsible('  ' + tm.t.head.name.replace(' — руководитель', ''), tm.rows.length, searching);
            sub._cont.appendChild(tagRow(tm.t.head, 10));
            tm.rows.forEach(function (r) { sub._cont.appendChild(tagRow(r, 20)); });
            box._cont.appendChild(sub);
          });
          host.appendChild(box);
          anyHit = true;
        } else {
          const rows = sec.rows.filter(function (r) { return matchRow(r, terms); });
          if (searching && !rows.length) return;
          const box = collapsible(sec.title, rows.length, searching || sec.title === 'Продакты по кластерам');
          rows.forEach(function (r) { box._cont.appendChild(tagRow(r)); });
          host.appendChild(box);
          anyHit = true;
        }
      });
      if (!anyHit) host.appendChild(elt('div', 'color:#9CA3AF;font-weight:700;font-size:12px;padding:14px 0;text-align:center;', 'Ничего не найдено'));
    }
    q.addEventListener('input', draw);
    draw();
  }

  /* ==================== ВКЛАДКА «ДОКУМЕНТ» ====================
     Таблица «Академ.часы в курсах» (лист «Список курсов»): A — курс, B — ак.ч.,
     C — что выдаём (ДПП / УПК / «Диплом от Эдюсон» / …). По умолчанию показываем
     документ по курсу из карточки OmniDesk; можно выбрать любой другой курс. */
  const DOC_SHEET_CSV =
    'https://docs.google.com/spreadsheets/d/1XTS-f9ndG4J5StlnqZJK4GbSR1m6Vxq1LmRVoKlneeE/gviz/tq?tqx=out:csv&gid=0';
  const DOC_FULL = {
    'ДПП': 'Диплом о профессиональной переподготовке',
    'УПК': 'Удостоверение о повышении квалификации',
  };
  // кириллические двойники латиницы → латиница: чтобы «1С-Разработчик» (омник)
  // и «1C-Разработчик — 112 часов» (таблица) считались одним курсом.
  const DOC_FOLD = { 'а':'a','е':'e','о':'o','р':'p','с':'c','х':'x','к':'k','м':'m','т':'t','н':'h','в':'b','у':'y','і':'i','ѕ':'s' };
  function docNorm(s) {
    return String(s || '').toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[а-яіѕ]/g, function (ch) { return DOC_FOLD[ch] || ch; })
      .replace(/[^a-zа-я0-9]+/g, ' ').trim();
  }

  function gmText(url) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'GET', url: url, timeout: 20000,
        onload: function (res) {
          if (res.status === 200) resolve(res.responseText || '');
          else if (res.status === 401 || res.status === 403 || res.status === 0) reject(new Error('NOAUTH'));
          else reject(new Error('код ' + res.status));
        },
        onerror: function () { reject(new Error('сеть')); },
        ontimeout: function () { reject(new Error('долго не отвечает')); },
      });
    });
  }

  // CSV gviz → массив строк (кавычки, запятые и переводы строк внутри полей).
  function parseCsv(text) {
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cur); cur = ''; }
      else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (ch !== '\r') cur += ch;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  let docMapCache = null; // { list:[{course,doc,hours,section}], byNorm:{} }
  function loadDocMap() {
    if (docMapCache) return Promise.resolve(docMapCache);
    return gmText(DOC_SHEET_CSV + '&_cb=' + Date.now()).then(function (csv) {
      if (/<!doctype|<html|accounts\.google\.com/i.test(csv.slice(0, 400))) throw new Error('NOAUTH');
      const rows = parseCsv(csv);
      const list = []; let section = '';
      rows.forEach(function (r, idx) {
        const course = (r[0] || '').trim(), hours = (r[1] || '').trim(), doc = (r[2] || '').trim();
        if (!course) return;
        if (idx === 0) return;                         // строка заголовков
        if (!hours && !doc) { section = course; return; } // раздел / подраздел
        list.push({ course: course, doc: doc, hours: hours, section: section });
      });
      if (!list.length) throw new Error('таблица пустая');
      const byNorm = {};
      list.forEach(function (it) { byNorm[docNorm(it.course)] = it; });
      docMapCache = { list: list, byNorm: byNorm };
      return docMapCache;
    });
  }

  // Курс из карточки → запись таблицы. { item, exact } либо null.
  function matchDocCourse(map, course) {
    const n = docNorm(course);
    if (!n) return null;
    if (map.byNorm[n]) return { item: map.byNorm[n], exact: true };
    // а) запись таблицы целиком входит в курс из карточки (карточка = «... тариф Базовый») — самую длинную
    let a = null, aLen = 0;
    map.list.forEach(function (it) {
      const ni = docNorm(it.course);
      if (ni && ni.length >= 5 && n.indexOf(ni) !== -1 && ni.length > aLen) { a = it; aLen = ni.length; }
    });
    if (a) return { item: a, exact: false };
    // б) наоборот — курс из карточки входит в запись таблицы — самую короткую (ближе к запросу)
    let b = null, bLen = 1e9;
    map.list.forEach(function (it) {
      const ni = docNorm(it.course);
      if (ni && n.length >= 5 && ni.indexOf(n) !== -1 && ni.length < bLen) { b = it; bLen = ni.length; }
    });
    if (b) return { item: b, exact: false };
    // в) совпадение по значимым словам — только если совпало ≥2 (иначе не гадаем)
    const words = n.split(' ').filter(function (w) { return w.length >= 5; });
    if (words.length >= 2) {
      let hit = null, hs = 0;
      map.list.forEach(function (it) {
        const hay = docNorm(it.course);
        const s = words.filter(function (w) { return hay.indexOf(w) !== -1; }).length;
        if (s > hs) { hs = s; hit = it; }
      });
      if (hit && hs >= 2) return { item: hit, exact: false };
    }
    return null;
  }

  function renderDoc(body) {
    body.appendChild(elt('div', 'font-weight:800;font-size:13px;margin-bottom:6px;', 'Документ по курсу'));
    const status = elt('div', 'font-size:11.5px;font-weight:700;color:#9CA3AF;', 'Загружаю таблицу…');
    body.appendChild(status);
    const result = elt('div', 'margin-top:8px;');
    body.appendChild(result);
    const searchLabel = elt('div', fieldLabel, 'Другой курс — печатай название');
    searchLabel.style.display = 'none';
    const search = elt('input', inputCss);
    search.type = 'search';
    search.placeholder = 'напр. финансовый аналитик';
    search.style.display = 'none';
    const listBox = elt('div', 'margin-top:4px;max-height:220px;overflow:auto;border:1px solid #EEF2F5;border-radius:9px;display:none;');
    body.appendChild(searchLabel);
    body.appendChild(search);
    body.appendChild(listBox);
    const legend = elt('div', 'margin-top:12px;font-size:10.5px;color:#9CA3AF;font-weight:600;line-height:1.6;white-space:pre-wrap;',
      'ДПП — диплом о профессиональной переподготовке\nУПК — удостоверение о повышении квалификации');
    body.appendChild(legend);

    function showItem(it, note) {
      result.innerHTML = '';
      if (!it) {
        result.appendChild(elt('div', 'font-weight:800;font-size:13px;color:#B45309;', 'Курс в таблице не нашла'));
        result.appendChild(elt('div', 'font-size:11.5px;color:#6B7280;font-weight:600;margin-top:3px;', 'Найди курс через поиск ниже.'));
        return;
      }
      const card = elt('div', 'border:1px solid ' + ACC_BD + ';background:#F0F9FF;border-radius:12px;padding:10px 12px;');
      card.appendChild(elt('div', 'font-size:11px;color:#6B7280;font-weight:700;line-height:1.35;', it.course));
      card.appendChild(elt('div', 'font-weight:900;font-size:17px;color:' + ACC_DEEP + ';margin-top:3px;', it.doc || 'документ не указан'));
      if (it.hours) card.appendChild(elt('div', 'font-size:11px;color:#9CA3AF;font-weight:600;margin-top:4px;', it.hours + ' ак. ч.'));
      if (note) card.appendChild(elt('div', 'font-size:10.5px;color:#9CA3AF;font-weight:600;margin-top:5px;line-height:1.4;', note));
      result.appendChild(card);
    }

    loadDocMap().then(function (map) {
      status.style.display = 'none';
      searchLabel.style.display = '';
      search.style.display = '';

      function drawList() {
        const terms = docNorm(search.value).split(' ').filter(Boolean);
        listBox.innerHTML = '';
        if (!terms.length) { listBox.style.display = 'none'; return; }
        const hits = map.list.filter(function (it) {
          const hay = docNorm(it.course) + ' ' + docNorm(it.section);
          return terms.every(function (t) { return hay.indexOf(t) !== -1; });
        }).slice(0, 60);
        if (!hits.length) {
          listBox.appendChild(elt('div', 'padding:9px 11px;font-size:11.5px;color:#9CA3AF;font-weight:700;', 'Ничего не найдено'));
        } else {
          hits.forEach(function (it) {
            const row = elt('div', 'padding:7px 11px;cursor:pointer;border-bottom:1px solid #F3F4F6;');
            row.appendChild(elt('div', 'font-size:12px;font-weight:700;color:#111827;line-height:1.3;', it.course));
            row.appendChild(elt('div', 'font-size:10.5px;color:#6B7280;font-weight:600;margin-top:1px;',
              (it.doc || 'документ не указан') + (it.section ? '  ·  ' + it.section : '')));
            row.onmouseenter = function () { row.style.background = '#F0F9FF'; };
            row.onmouseleave = function () { row.style.background = 'transparent'; };
            row.onclick = function () {
              showItem(it, null);
              search.value = '';
              listBox.style.display = 'none';
            };
            listBox.appendChild(row);
          });
        }
        listBox.style.display = 'block';
      }
      search.addEventListener('input', drawList);
      search.addEventListener('focus', function () { if (search.value.trim()) drawList(); });

      const crs = readCourse();
      const m = matchDocCourse(map, crs);
      if (m) {
        showItem(m.item, m.exact ? '' : '⚠️ сопоставила по близости — проверь курс');
      } else {
        showItem(null);
        if (crs) {
          status.style.display = ''; status.style.color = '#B45309';
          status.textContent = 'В карточке курс «' + crs + '» — в таблице не нашла, найди через поиск.';
        }
      }
    }).catch(function (e) {
      status.style.color = '#B45309';
      status.textContent = (e && e.message === 'NOAUTH')
        ? 'Google не пустил. Открой таблицу «Академ.часы в курсах» в соседней вкладке, войди в аккаунт и открой панель заново.'
        : 'Не получилось прочитать таблицу (' + (e && e.message || 'ошибка') + ').';
    });
  }

  /* ==================== ВКЛАДКА «УРОК» ====================
     Ссылка на урок платформы по названию. Путь — как у логин-линка:
     поле АДМИНКА карточки → super_user / user на www.eduson.tv/admin →
     кабинет студента на academy-<slug>.eduson.tv/ru/users/<uid>/stats →
     учебный план курса (…/assignments/<N>) → уроки = <a href="/ru/courses/<id>">Название</a>.
     Ссылка на урок = https://<домен>/ru/courses/<id> (без токена — у кураторов есть доступ). */

  const EDU_ADMIN = 'https://www.eduson.tv';
  function superUserUrl2(id) { return EDU_ADMIN + '/admin/super_users/' + id + '?language=ru'; }
  const digits10 = function (s) { return String(s || '').replace(/\D/g, '').slice(-10); };

  function adminLinksInCard() {
    const set = [];
    document.querySelectorAll('.right_info_panels a[href*="eduson.tv/admin"], #info_panel_wrap a[href*="eduson.tv/admin"], .info_panel_nano a[href*="eduson.tv/admin"]')
      .forEach(function (a) { if (set.indexOf(a.href) === -1) set.push(a.href); });
    const v = adminLink();
    if (/^https?:\/\//.test(v) && set.indexOf(v) === -1) set.push(v);
    return set;
  }
  function adminUserSuperIds() {
    const users = [], supers = [];
    adminLinksInCard().forEach(function (h) {
      let m = h.match(/\/admin\/users\/(\d+)/); if (m && users.indexOf(m[1]) === -1) users.push(m[1]);
      m = h.match(/\/admin\/super_users\/(\d+)/); if (m && supers.indexOf(m[1]) === -1) supers.push(m[1]);
    });
    return { users: users, supers: supers };
  }
  function looksLikeAdminLogin(html) {
    const h = String(html || '');
    if (/Admin Zone|\/admin\/super_users|\/admin\/users\//i.test(h)) return false;
    return /name=["']user\[email\]|id=["']user_password|Sign in|Войти/i.test(h.slice(0, 2000));
  }
  // super_user HTML → uid обучающегося (по email/тел из карточки, иначе первая полная строка)
  function subUserUidFromSuper(html, email, phone) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let tbl = null;
    doc.querySelectorAll('table').forEach(function (t) {
      const head = ((t.querySelector('tr') || {}).textContent || '').toLowerCase();
      if (head.indexOf('email') !== -1 && head.indexOf('first name') !== -1) tbl = t;
    });
    if (!tbl) return '';
    const trs = [].slice.call(tbl.querySelectorAll('tr'));
    const heads = [].slice.call(trs[0].querySelectorAll('th,td')).map(function (x) { return x.textContent.trim().toLowerCase(); });
    const iE = heads.indexOf('email'), iP = heads.indexOf('phone');
    const wantE = String(email || '').toLowerCase().trim(), wantP = digits10(phone);
    const uidOf = function (tr) { const a = tr.querySelector('a[href*="/admin/users/"]'); const m = a && a.getAttribute('href').match(/\/admin\/users\/(\d+)/); return m ? m[1] : ''; };
    const rows = trs.slice(1);
    const hit = rows.find(function (tr) {
      const c = [].slice.call(tr.querySelectorAll('td')).map(function (td) { return td.textContent.trim(); });
      return (wantE && iE >= 0 && (c[iE] || '').toLowerCase() === wantE) ||
             (wantP && iP >= 0 && digits10(c[iP]) === wantP);
    });
    if (hit && uidOf(hit)) return uidOf(hit);
    const any = rows.find(function (tr) { return uidOf(tr); });
    return any ? uidOf(any) : '';
  }
  // admin/users/<uid> HTML → https://academy-*.eduson.tv/ru/users/<uid>/stats
  function cabinetUrlFromUserCard(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const a = doc.querySelector('a[href*=".eduson.tv/ru/users/"][href*="/stats"]')
          || doc.querySelector('a[href*=".eduson.tv/ru/users/"]')
          || doc.querySelector('a[href*="/ru/users/"][href*="/stats"]');
    const href = a && a.getAttribute('href');
    if (href && /^https?:\/\//.test(href)) {
      return href.indexOf('/stats') !== -1 ? href : href.replace(/\/?$/, '') + '/stats';
    }
    const m = String(html).match(/https?:\/\/(academy-[\w-]+\.eduson\.tv)\/ru\/users\/(\d+)/);
    if (m) return 'https://' + m[1] + '/ru/users/' + m[2] + '/stats';
    return '';
  }
  // страница /stats → [{name,url}] учебных планов
  function plansFromStats(html, baseUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = [];
    doc.querySelectorAll('a[href*="/assignments/"]').forEach(function (a) {
      const href = a.getAttribute('href') || '';
      if (!/\/ru\/users\/\d+\/assignments\/\d+/.test(href)) return;
      const name = (a.textContent || '').replace(/\s+/g, ' ').replace(/^курс:\s*/i, '').trim();
      let url; try { url = new URL(href, baseUrl).href; } catch (e) { url = href; }
      if (name && !out.some(function (x) { return x.url === url; })) out.push({ name: name, url: url });
    });
    return out;
  }
  // страница плана → [{id,name}] уроков (мини-курсов внутри программы)
  const LECT_BTN = /^(начать курс|продолжить(?: обучение)?|перейти|смотреть|открыть|назад к программе)$/i;
  const stripDur = function (s) {
    return String(s || '').replace(/\s+\d+\s*(мин(ут[аы]?)?|час[аов]*|ч|сек)\.?\s*$/i, '').trim();
  };
  // страница плана → верхнеуровневые уроки (мини-курсы). Вложенные лекции берём потом по клику.
  function lessonsFromPlan(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const byId = {};
    doc.querySelectorAll('a[href*="/ru/courses/"]').forEach(function (a) {
      const href = a.getAttribute('href') || '';
      if (/\/lectures\//.test(href)) return;                       // это ссылка на вложенную лекцию
      const m = href.match(/\/ru\/courses\/(\d+)(?:[/?#]|$)/);
      if (!m) return;
      const name = stripDur((a.textContent || '').replace(/\s+/g, ' ').trim());
      if (!name || name.length < 3 || LECT_BTN.test(name)) return;
      if (!byId[m[1]] || byId[m[1]].length < name.length) byId[m[1]] = name;
    });
    return Object.keys(byId).map(function (id) { return { id: id, name: byId[id] }; });
  }
  // страница урока /ru/courses/<id> → вложенные лекции [{path,name}]
  function lecturesFromCourse(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const byPath = {};
    doc.querySelectorAll('a[href*="/lectures/"]').forEach(function (a) {
      const m = (a.getAttribute('href') || '').match(/(\/ru\/courses\/\d+\/lectures\/\d+)/);
      if (!m) return;
      const name = stripDur((a.textContent || '').replace(/\s+/g, ' ').trim());
      if (!name || name.length < 3 || LECT_BTN.test(name)) return;
      if (!byPath[m[1]] || byPath[m[1]].length < name.length) byPath[m[1]] = name;
    });
    return Object.keys(byPath).map(function (p) { return { path: p, name: byPath[p] }; });
  }
  let _lectCache = {};
  function fetchCourseLectures(domain, courseId) {
    if (_lectCache[courseId]) return Promise.resolve(_lectCache[courseId]);
    return gmText(domain + '/ru/courses/' + courseId).then(function (html) {
      const arr = lecturesFromCourse(html);
      _lectCache[courseId] = arr;
      return arr;
    });
  }
  function pickPlan(plans, course) {
    const n = docNorm(course);
    if (!n) return null;
    const exact = plans.find(function (p) { return docNorm(p.name) === n; });
    if (exact) return exact;
    const words = n.split(' ').filter(function (w) { return w.length >= 4; });
    let best = null, bs = 0;
    plans.forEach(function (p) {
      const hay = docNorm(p.name);
      const s = words.filter(function (w) { return hay.indexOf(w) !== -1; }).length;
      if (s > bs) { bs = s; best = p; }
    });
    if (best && (bs >= 2 || (bs >= 1 && words.length === 1))) return best;
    return null;
  }

  let lessonCache = null; // { domain, lessons:[{id,name}], planName, plans, note }
  async function loadLessons() {
    if (lessonCache) return lessonCache;
    const ids = adminUserSuperIds();
    if (!ids.users.length && !ids.supers.length) throw new Error('в карточке нет ссылки на админку — нажми сначала магнит 🧲');
    const u = readUser();

    let userIds = ids.users.slice();
    for (let i = 0; i < ids.supers.length && !userIds.length; i++) {
      const sHtml = await gmText(superUserUrl2(ids.supers[i]));
      if (looksLikeAdminLogin(sHtml)) throw new Error('NOAUTH');
      const uid = subUserUidFromSuper(sHtml, u.email, u.phone);
      if (uid) userIds.push(uid);
    }
    if (!userIds.length) throw new Error('не нашла обучающегося в супере');

    let cabUrl = '';
    for (let j = 0; j < userIds.length && !cabUrl; j++) {
      const cHtml = await gmText(EDU_ADMIN + '/admin/users/' + userIds[j] + '?language=ru');
      if (looksLikeAdminLogin(cHtml)) throw new Error('NOAUTH');
      cabUrl = cabinetUrlFromUserCard(cHtml);
    }
    if (!cabUrl) throw new Error('не нашла кабинет студента на платформе');
    const domain = (cabUrl.match(/^https?:\/\/[^/]+/) || [''])[0];

    const statsHtml = await gmText(cabUrl);
    if (looksLikeAdminLogin(statsHtml)) throw new Error('NOAUTH');
    const plans = plansFromStats(statsHtml, cabUrl);
    if (!plans.length) throw new Error('у студента нет учебных планов в кабинете');

    let picked = pickPlan(plans, readCourse());
    let note = '';
    if (!picked) { picked = plans[0]; note = plans.length > 1 ? 'курс из карточки не совпал — взяла «' + picked.name + '»' : ''; }

    const planHtml = await gmText(picked.url);
    const lessons = lessonsFromPlan(planHtml);
    if (!lessons.length) throw new Error('в учебном плане не нашла уроков');

    lessonCache = { domain: domain, lessons: lessons, planName: picked.name, plans: plans, note: note };
    return lessonCache;
  }

  function renderLesson(body) {
    body.appendChild(elt('div', 'font-weight:800;font-size:13px;margin-bottom:6px;', 'Ссылка на урок'));
    const status = elt('div', 'font-size:11.5px;font-weight:700;color:#9CA3AF;', 'Ищу курс студента на платформе…');
    body.appendChild(status);

    const searchLabel = elt('div', fieldLabel, 'Название урока');
    searchLabel.style.display = 'none';
    const search = elt('input', inputCss);
    search.type = 'search';
    search.placeholder = 'напр. управление конфликтами';
    search.style.display = 'none';
    const listBox = elt('div', 'margin-top:4px;max-height:260px;overflow:auto;border:1px solid #EEF2F5;border-radius:9px;display:none;');
    body.appendChild(searchLabel); body.appendChild(search); body.appendChild(listBox);
    const hint = elt('div', 'margin-top:10px;font-size:10px;color:#9CA3AF;font-weight:600;line-height:1.5;', '');
    body.appendChild(hint);

    // кнопка глубокого поиска (по вложенным лекциям) — между строкой поиска и списком
    const deepBtn = elt('div', 'display:none;margin-top:6px;text-align:center;background:#F0F9FF;color:' + ACC + ';border:1px solid ' + ACC_BD + ';border-radius:10px;padding:7px 8px;font-size:11px;font-weight:800;cursor:pointer;line-height:1.35;', '🔍 Искать и во вложенных уроках (лекции спикеров)');
    body.insertBefore(deepBtn, listBox);

    loadLessons().then(function (data) {
      status.style.display = 'none';
      searchLabel.style.display = ''; search.style.display = ''; deepBtn.style.display = 'block';
      searchLabel.textContent = 'Название урока · курс: ' + data.planName + ' · уроков: ' + data.lessons.length;
      if (data.note) { status.style.display = ''; status.style.color = '#B45309'; status.textContent = '⚠️ ' + data.note; }

      let deep = data.deep || null;   // [{name, url, parent}] — все вложенные лекции курса (кэш в lessonCache)
      let deepLoading = false;

      const nameDiv = function (name) { return elt('div', 'font-size:12px;font-weight:700;color:#111827;line-height:1.35;', name); };
      const urlDiv = function (url) { return elt('div', 'font-size:10px;color:#6B7280;font-weight:600;margin-top:2px;word-break:break-all;', url); };

      // Строка вложенной лекции (плоский результат глубокого поиска).
      const lessonRow = function (name, url, parent) {
        const wrap = elt('div', 'border-bottom:1px solid #F3F4F6;');
        const main = elt('div', 'padding:8px 11px;cursor:pointer;');
        main.appendChild(nameDiv(name));
        if (parent) main.appendChild(elt('div', 'font-size:9.5px;color:#9CA3AF;font-weight:700;margin-top:1px;', 'в уроке: ' + parent));
        main.appendChild(urlDiv(url));
        main.onclick = function () { copyText(url); toast('Ссылка на урок скопирована:\n' + name); wrap.style.background = '#DCFCE7'; };
        wrap.appendChild(main);
        return wrap;
      };

      // Строка урока верхнего уровня + кнопка «▾» раскрытия вложенных лекций.
      const courseRowWithExpand = function (l) {
        const url = data.domain + '/ru/courses/' + l.id;
        const wrap = elt('div', 'border-bottom:1px solid #F3F4F6;');
        const row = elt('div', 'padding:8px 11px;display:flex;gap:8px;align-items:flex-start;');
        const main = elt('div', 'flex:1;min-width:0;cursor:pointer;');
        main.appendChild(nameDiv(l.name));
        main.appendChild(urlDiv(url));
        main.onclick = function () { copyText(url); toast('Ссылка на урок скопирована:\n' + l.name); wrap.style.background = '#DCFCE7'; };
        const exp = elt('div', 'flex:0 0 auto;cursor:pointer;font-size:11px;font-weight:800;color:' + ACC + ';padding:2px 7px;border:1px solid ' + ACC_BD + ';border-radius:8px;line-height:1.4;', '▾');
        exp.title = 'вложенные уроки';
        const sub = elt('div', 'display:none;padding:2px 11px 8px 20px;');
        exp.onclick = function () {
          if (sub.style.display === 'block') { sub.style.display = 'none'; exp.textContent = '▾'; return; }
          sub.style.display = 'block'; exp.textContent = '…';
          fetchCourseLectures(data.domain, l.id).then(function (arr) {
            exp.textContent = '▴'; sub.innerHTML = '';
            if (!arr.length) { sub.appendChild(elt('div', 'font-size:10.5px;color:#9CA3AF;font-weight:600;padding:4px 0;', 'вложенных уроков нет — бери ссылку выше')); return; }
            arr.forEach(function (lc) {
              const lu = data.domain + lc.path;
              const sr = elt('div', 'padding:6px 0;cursor:pointer;border-top:1px solid #F3F4F6;');
              sr.appendChild(elt('div', 'font-size:11.5px;font-weight:700;color:#111827;line-height:1.3;', lc.name));
              sr.appendChild(elt('div', 'font-size:9.5px;color:#6B7280;font-weight:600;margin-top:1px;word-break:break-all;', lu));
              sr.onclick = function () { copyText(lu); toast('Ссылка на урок скопирована:\n' + lc.name); sr.style.background = '#DCFCE7'; };
              sub.appendChild(sr);
            });
          }).catch(function () { exp.textContent = '▾'; sub.style.display = 'none'; toast('Не удалось открыть вложенные уроки'); });
        };
        row.appendChild(main); row.appendChild(exp);
        wrap.appendChild(row); wrap.appendChild(sub);
        return wrap;
      };

      function draw() {
        const terms = docNorm(search.value).split(' ').filter(Boolean);
        listBox.innerHTML = '';
        if (!terms.length) { listBox.style.display = 'none'; return; }
        const match = function (name) { const hay = docNorm(name); return terms.every(function (t) { return hay.indexOf(t) !== -1; }); };
        const courseHits = data.lessons.filter(function (l) { return match(l.name); }).slice(0, 40);
        const lectHits = deep ? deep.filter(function (x) { return match(x.name); }).slice(0, 40) : [];
        if (!courseHits.length && !lectHits.length) {
          listBox.appendChild(elt('div', 'padding:9px 11px;font-size:11.5px;color:#9CA3AF;font-weight:700;line-height:1.5;',
            deep ? 'Ничего не найдено.' : 'Среди уроков не нашла. Лекции спикеров внутри уроков — нажми «Искать и во вложенных» над списком.'));
        } else {
          courseHits.forEach(function (l) { listBox.appendChild(courseRowWithExpand(l)); });
          lectHits.forEach(function (x) { listBox.appendChild(lessonRow(x.name, x.url, x.parent)); });
        }
        listBox.style.display = 'block';
      }
      search.addEventListener('input', draw);

      const markDeepDone = function () {
        deepBtn.textContent = '✓ Вложенные уроки в поиске (' + deep.length + ')';
        deepBtn.style.background = '#DCFCE7'; deepBtn.style.cursor = 'default';
      };
      if (deep) markDeepDone();

      deepBtn.onclick = function () {
        if (deepLoading || deep) return;
        deepLoading = true;
        deepBtn.style.cursor = 'default';
        const total = data.lessons.length;
        let done = 0; const acc = [];
        deepBtn.textContent = 'Проверяю уроки… 0 / ' + total + ' (можно искать дальше)';
        const queue = data.lessons.slice();
        const worker = function () {
          const l = queue.shift();
          if (!l) return Promise.resolve();
          return fetchCourseLectures(data.domain, l.id).then(function (arr) {
            arr.forEach(function (lc) { acc.push({ name: lc.name, url: data.domain + lc.path, parent: l.name }); });
          }).catch(function () {}).then(function () {
            done++;
            if (done % 5 === 0 || done === total) deepBtn.textContent = 'Проверяю уроки… ' + done + ' / ' + total + ' (можно искать дальше)';
            return worker();
          });
        };
        const workers = [];
        for (let i = 0; i < 10; i++) workers.push(worker());
        Promise.all(workers).then(function () {
          deep = acc; data.deep = acc; deepLoading = false;
          markDeepDone();
          draw();
        });
      };

      const others = (data.plans || []).map(function (p) { return p.name; }).filter(function (n) { return n !== data.planName; });
      hint.textContent = 'Клик по названию — ссылка на урок в буфере. «▾» у строки — вложенные уроки (лекции спикеров). Кнопка «Искать во вложенных» разово подгружает все лекции курса в поиск (~30–40 сек, поиск при этом работает). Работает, пока ты залогинена в www.eduson.tv.' +
        (others.length ? ' Другие курсы студента: ' + others.join('; ') + '.' : '');
    }).catch(function (e) {
      status.style.color = '#B45309';
      status.textContent = (e && e.message === 'NOAUTH')
        ? 'Не пустило на www.eduson.tv. Открой админку в соседней вкладке, войди и открой панель заново.'
        : 'Не получилось: ' + ((e && e.message) || 'ошибка') + '.';
    });
  }

  /* ==================== КНОПКА В ШАПКЕ ==================== */
  // Вид кнопки — как у ключа/магнита Хэлпера, чтобы стояли ровным рядом с одинаковым зазором.
  const BTN_SVG = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

  function makeCuratorBtn() {
    const btn = document.createElement('div');
    btn.id = 'curator-tools-btn';
    btn.title = 'Пинги в Телеграм и справочник тегов';
    btn.style.cssText = 'width:30px;height:28px;flex:0 0 auto;box-sizing:border-box;display:flex;align-items:center;' +
      'justify-content:center;cursor:pointer;background:#fff;border:1px solid #DADCE0;border-radius:5px;' +
      'box-shadow:0 1px 2px rgba(0,0,0,.12);color:#5F6368;transition:background .15s;';
    btn.innerHTML = BTN_SVG;
    btn.onmouseenter = function () { btn.style.background = '#F1F3F4'; };
    btn.onmouseleave = function () { btn.style.background = '#fff'; };
    btn.onclick = function (e) { e.stopPropagation(); togglePanel(); };
    return btn;
  }

  function ensureButton() {
    const bar = document.querySelector('.request-content-title-act');
    if (!bar) {
      const w = document.getElementById('curator-hdr'); if (w) w.remove();
      const b = document.getElementById('curator-tools-btn'); if (b) b.remove();
      return;
    }
    const helper = document.getElementById('eduson-hdr-btns');
    let btn = document.getElementById('curator-tools-btn');

    if (helper && helper.parentElement === bar) {
      // Хэлпер установлен — кладём кнопку последней В ЕГО контейнер: общий gap и один отступ на всю группу.
      const standalone = document.getElementById('curator-hdr');
      if (standalone) standalone.remove();
      btn = document.getElementById('curator-tools-btn');
      if (!btn) btn = makeCuratorBtn();
      if (btn.parentElement !== helper || helper.lastElementChild !== btn) helper.appendChild(btn);
      return;
    }

    // Хэлпера нет — свой контейнер в том же стиле (float:right, gap:5px, отступ справа 14px).
    let wrap = document.getElementById('curator-hdr');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'curator-hdr';
      wrap.style.cssText = 'float:right;display:flex;align-items:center;gap:5px;height:34px;margin:0 14px 0 6px;';
      wrap.appendChild((btn && !btn.parentElement) ? btn : makeCuratorBtn());
    }
    if (bar.lastElementChild !== wrap) bar.appendChild(wrap);
  }

  console.log(TAG, 'запущен, версия ' + VER, '| host:', location.hostname);
  // На eduson.amocrm.ru скрипт нужен только ради разрешения @connect (чтения сделки) — UI не строим.
  if (ON_OMNI) {
    ensureButton();
    setInterval(ensureButton, 1500);
  }
  })();

})();
