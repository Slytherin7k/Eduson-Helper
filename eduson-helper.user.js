// ==UserScript==
// @name         Eduson Helper: amoCRM → OmniDesk
// @namespace    eduson-helper
// @version      0.36.0
// @description  Кнопка в OmniDesk сама находит клиента в amoCRM и заполняет карточку: ФИО, email, телефон, курс, дату поддержки и ссылку на Super User в админке Эдюсона
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
// @connect      eduson.tv
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
    [/java/i, 'Java', 12],
    [/javascript/i, 'JavaScript', 12],
    [/sql/i, 'SQL', 12],
  ];

  /* ================================================ */

  const STORE_KEY = 'lastClient';
  const DEBUG_KEY = 'lastDebug';
  const IS_AMO  = location.hostname.endsWith('amocrm.ru');
  const IS_OMNI = location.hostname.endsWith('omnidesk.ru');
  const TAG = '[amohelper]';

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

  // Возвращает { links:[{url,courses}], isSuper:bool, error: null|'NOAUTH'|'текст' }
  // isSuper=true  → это Super User, links ведут на /admin/super_users/<N>, ставим галочку СУПЕРЮЗЕР
  // isSuper=false → Super User нет, links ведут на карточку(и) юзера /admin/users/<id>
  async function lookupAdminLinks(data) {
    const keys = [];
    if (data.amoLeadId) keys.push(String(data.amoLeadId));
    if (data.cardAmoId && String(data.cardAmoId) !== String(data.amoLeadId)) keys.push(String(data.cardAmoId));
    if (data.amoContactId) keys.push(String(data.amoContactId));
    (data.emails || []).slice(0, 2).forEach(function (e) {
      if (e && !/@eduson\.tv$/i.test(e)) keys.push(e);
    });
    if (!keys.length) return { links: [], isSuper: false, error: null };

    let authError = false, lastErr = '';

    // 1. Ищем карточки юзеров в /admin/users по каждому ключу (до первого попадания)
    const userRows = [];
    for (const q of keys) {
      try {
        const html = await gmFetchText(ADMIN_BASE + '/admin/users?language=ru&q=' + encodeURIComponent(q));
        if (adminLooksLikeLogin(html)) { authError = true; continue; }
        const raw = parseUserRowsFromList(html);
        let rows = raw.filter(function (r) { return r.text.indexOf(q) !== -1; });
        if (!rows.length && raw.length && raw.length <= 5) rows = raw; // доверяем поиску админки
        if (rows.length) {
          rows.forEach(function (r) { if (!userRows.some(function (u) { return u.uid === r.uid; })) userRows.push(r); });
          break;
        }
      } catch (e) { if (e.message === 'NOAUTH') authError = true; else lastErr = e.message; }
    }
    if (!userRows.length) return { links: [], isSuper: false, error: authError ? 'NOAUTH' : (lastErr || null) };

    // 2. Открываем карточки: собираем номера Super User либо (если нет) ссылки на карточки
    const superIds = [];
    const cardUrls = [];
    for (const r of userRows.slice(0, 6)) {
      try {
        const card = await gmFetchText(userCardUrl(r.uid));
        if (adminLooksLikeLogin(card)) { authError = true; continue; }
        const suId = parseSuperUserIdFromUserCard(card);
        if (suId) { if (superIds.indexOf(suId) === -1) superIds.push(suId); }
        else { if (cardUrls.indexOf(userCardUrl(r.uid)) === -1) cardUrls.push(userCardUrl(r.uid)); }
      } catch (e) { if (e.message === 'NOAUTH') authError = true; else lastErr = e.message; }
    }

    if (superIds.length) {
      const links = [];
      for (const id of superIds.slice(0, 6)) {
        let courses = [];
        try {
          const page = await gmFetchText(superUserUrl(id));
          if (!adminLooksLikeLogin(page)) courses = parseSuperUserCourses(page);
        } catch (e) { /* название курса не критично */ }
        links.push({ url: superUserUrl(id), courses: courses });
      }
      return { links: links, isSuper: true, error: null };
    }
    if (cardUrls.length) {
      return { links: cardUrls.map(function (u) { return { url: u, courses: [] }; }), isSuper: false, error: null };
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
    try { r = await lookupAdminLinks(data); }
    catch (e) { miss.push(RU.admin + ' — ошибка: ' + e.message); return; }

    if (r.links.length) {
      data.admin = r.links.map(function (l) { return l.url; });
      data.isSuper = !!r.isSuper;
      const res = fillAdminField(r.links);
      const kind = r.isSuper ? 'Super User' : 'карточка юзера, Super User нет';
      const many = r.links.length > 1 ? ', ' + r.links.length + ' шт — все в буфере' : '';
      if (res.ok) ok.push(RU.admin + ' (' + kind + many + ')');
      else miss.push(RU.admin + ' — ' + res.why);
      if (r.links.length > 1) {
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
      miss.push(RU.admin + ' — в админке студент не нашёлся');
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
      box.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483647;background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.35);padding:18px;max-width:460px;width:92%;font-family:Segoe UI,Arial,sans-serif;';
      const title = document.createElement('div');
      title.style.cssText = 'font-size:14px;font-weight:700;color:#111827;margin-bottom:4px;';
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
      cancel.style.cssText = 'background:none;border:none;color:#7C3AED;font-size:12px;cursor:pointer;padding:4px;';
      cancel.textContent = 'Не брать курс и дату (только ФИО, почта, телефон)';
      cancel.onclick = function () { box.remove(); resolve(null); };
      box.appendChild(cancel);
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
             admin: [], isSuper: false, supportMonths: 0,
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
    if (!wonLeads.length) return data;
    let useLead = wonLeads[0];
    if (wonLeads.length > 1) useLead = await chooseDeal(wonLeads);
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
            const matches = text.match(/(?:\+7|8)[\s(.-]*\d{3}[\s).-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g);
            if (matches) {
              matches.forEach(m => {
                const clean = m.replace(/\s/g, '');
                if (!results.includes(clean)) results.push(clean);
              });
            }
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
    return d.length === 10 || d.length === 11;
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
    const phoneMatches = text.match(/(?:\+7|8)[\s(.-]*\d{3}[\s).-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g);
    if (phoneMatches) {
      phoneMatches.forEach(m => {
        const clean = m.replace(/\s/g, '');
        if (!seed.phones.includes(clean)) seed.phones.push(clean);
      });
    }
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
  function chooseCandidate(candidates, seed) {
    return new Promise(function (resolve) {
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483647;background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.35);padding:18px;max-width:460px;width:92%;font-family:Segoe UI,Arial,sans-serif;';
      const title = document.createElement('div');
      title.style.cssText = 'font-size:14px;font-weight:700;color:#111827;margin-bottom:4px;';
      title.textContent = 'В амо нашлось несколько человек 👥';
      const sub = document.createElement('div');
      sub.style.cssText = 'font-size:12px;color:#6B7280;margin-bottom:12px;';
      const by = [...seed.emails, ...seed.phones].filter(Boolean);
      sub.textContent = 'Кто из них наш студент?' + (by.length ? ' (в карточке Омни: ' + by.join(', ') + ')' : '');
      box.appendChild(title);
      box.appendChild(sub);
      candidates.slice(0, 5).forEach(function (c) {
        const btn = document.createElement('button');
        btn.style.cssText = 'display:block;width:100%;text-align:left;background:#F9FAFB;border:1px solid #E5E7EB;border-radius:10px;padding:10px 12px;margin-bottom:8px;cursor:pointer;font-size:13px;color:#111827;white-space:pre-wrap;';
        const hints = [];
        if (c._hintEmails.length) hints.push('✉️ ' + c._hintEmails.join(', '));
        if (c._hintPhones.length) hints.push('📞 ' + c._hintPhones.join(', '));
        if (c._matchEmail) hints.push('✅ почта совпала');
        else if (c._matchPhone) hints.push('✅ телефон совпал');
        btn.textContent = (c._preferred ? '⭐ ' : '') + candidateName(c) + (hints.length ? '\n' + hints.join('  ·  ') : '');
        btn.onclick = function () { box.remove(); resolve(c); };
        box.appendChild(btn);
      });
      const cancel = document.createElement('button');
      cancel.style.cssText = 'background:none;border:none;color:#7C3AED;font-size:12px;cursor:pointer;padding:4px;';
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
        if (candidates.length > 1 && (chosen._score - (second ? second._score : 0)) < 4) {
          chosen = await chooseCandidate(candidates, seed);
        }
        if (chosen) {
          const d = newClientData(base + '/contacts/detail/' + chosen.id);
          try {
            await assembleDataInto(chosen, d, api);
            data = d;
            if (candidates.length > 1) note = 'нашла поиском, выбрала: ' + candidateName(chosen);
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
        toast('Браузер не пустил меня в амо 😕\nПлан Б: открой амо, нажми там фиолетовую кнопку,\nвернись сюда и нажми «📋 Вставить скопированное».', 'warn', 12000);
      } else {
        toast('Не получилось связаться с амо: ' + err.message, 'error');
      }
      return;
    }
    if (!data || (!data.name && !data.emails.length && !data.phones.length && !data.course && !data.support)) {
      GM_setValue(DEBUG_KEY, { version: '0.36', url: location.href, amoId: amoId, seed: seed, result: 'ничего не нашлось', ts: Date.now() });
      toast('В амо ничего не нашлось 😕', 'warn');
      return;
    }
    data.cardAmoId = amoId || '';
    GM_setValue(STORE_KEY, data);
    GM_setValue(DEBUG_KEY, { version: '0.36', url: location.href, amoId: amoId, seed: seed, data: data, note: note, ts: Date.now() });
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
    return String(s || '').toLowerCase().replace(/[^a-zа-яё0-9 ]/gi, ' ').replace(/\s+/g, ' ').trim();
  }
  function pickCourseOption(sel, courseName) {
    const target = normCourse(courseName);
    if (!target) return null;

    // Сначала ищем по маппингу (точное соответствие)
    const omniCourseName = findOmniCourseName(courseName);
    const targetOmni = normCourse(omniCourseName);

    let best = null, bestScore = 0;
    sel.querySelectorAll('option').forEach(o => {
      const t = (o.textContent || '').trim();
      if (!t || t === '—') return;
      const n = normCourse(t);
      let score = 0;

      // Проверяем точное совпадение с названием из маппинга
      if (targetOmni && n === targetOmni) {
        score = 100;
      } else if (n === target) {
        score = 100;
      } else if (n.includes(target) || target.includes(n)) {
        score = 80;
      } else {
        // Сравниваем по словам
        const words = n.split(' ');
        let hit = 0;
        target.split(' ').forEach(w => {
          if (w.length > 2 && words.some(word => word.includes(w) || w.includes(word))) hit++;
        });
        // Также проверяем ключевые слова (Excel, 1С и т.д.)
        const keyWords = ['excel', '1с', 'собственник', 'python', 'java', 'javascript', 'sql', 'figma', 'photoshop', 'smm'];
        for (const kw of keyWords) {
          if (target.includes(kw) && n.includes(kw)) {
            hit += 3;
          }
        }
        score = Math.min(100, Math.round(hit / Math.max(target.split(' ').length, 1) * 40));
      }

      if (score > bestScore) { bestScore = score; best = o; }
    });
    return bestScore >= 40 ? best : null;
  }
  function fillCourseSelect(courseName) {
    const sel = document.querySelector(OMNI_FIELDS.course) || findOmniInput(LABELS.course);
    if (!sel || sel.tagName !== 'SELECT') return null;

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
        'if(!s2||typeof s2.onSelect!=="function"){res.err="Select2 без onSelect";return fin();}' +
        'var P=' + payload + ';' +
        'var norm=function(v){return P.isPhone?String(v).replace(/\\D/g,"").slice(-10):String(v).toLowerCase().trim();};' +
        'var cur=$o.select2("val");if(!Array.isArray(cur))cur=cur?[cur]:[];' +
        'var have=cur.map(norm);' +
        'var hasCSC=s2.opts&&typeof s2.opts.createSearchChoice==="function";' +
        'P.values.forEach(function(v){if(have.indexOf(norm(v))!==-1){res.skipCount++;return;}' +
        'try{var ch=null;' +
        'if(hasCSC){try{ch=s2.opts.createSearchChoice.call(s2,v,[]);}catch(e0){}' +
        'if(!ch){res.err="OmniDesk не принял адрес «"+v+"» (проверь формат)";return;}}' +
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
  async function fillAccFieldAsync(patterns, values, ruName, ok, miss, directSel) {
    let block = null;
    document.querySelectorAll('.a17_additional_fields').forEach(function (b) {
      if (block) return;
      const h = b.querySelector('h6');
      if (h && patterns.some(function (p) { return (h.textContent || '').trim().toLowerCase().includes(p); })) block = b;
    });
    if (!block) { fillAccFieldDirect(directSel, values, ruName, ok, miss); return; }
    const isPhone = patterns.some(p => p.includes('телефон'));

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
      if (r.err) miss.push(ruName + ' — ' + r.err);
      else if (!r.okCount && !r.skipCount) miss.push(ruName + ' — нечего добавлять');
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
        miss.push(ruName + ': ' + r.why + ' (' + val + ')');
        hasError = true;
      }
    }
    if (added.length) ok.push(ruName + ' (+' + added.length + ' новых)');
    if (skipped.length && !hasError) ok.push(ruName + ' (' + skipped.length + ' уже были, пропущены)');
    if (!added.length && !skipped.length && !hasError) {
      miss.push(ruName + ' — нет новых значений для добавления');
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

  // Глобальные переменные для хранения результатов заполнения
  let lastFillResult = { ok: [], miss: [], data: null };
  async function fillInputsFromData(data, prefix) {
    const ok = [], miss = [];
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
    } else {
      miss.push(RU.support + ' — поддержки нет (курс без поддержки)');
    }

    if (data.emails && data.emails.length) {
      await fillAccFieldAsync(['email', 'почта'], data.emails, RU.email, ok, miss, OMNI_FIELDS.email);
    } else {
      miss.push(RU.email + ' — в амо пусто');
    }
    if (data.phones && data.phones.length) {
      await fillAccFieldAsync(['телефон', 'phone'], data.phones, RU.phone, ok, miss, OMNI_FIELDS.phone);
    } else {
      miss.push(RU.phone + ' — в амо пусто');
    }
    // АДМИНКА: ссылка на Super User в админке Эдюсона
    await runAdminFill(data, ok, miss);
    // Скрипт сам жмёт «Сохранить» (если хоть что-то заполнилось)
    if (ok.length) {
      await sleep(400);
      if (clickOmniSave()) ok.push('💾 Сохранено');
      else miss.push('💾 кнопка «Сохранить» не нашлась — сохрани вручную');
    }
    // Сохраняем результат
    lastFillResult = { ok, miss, data };
    // Дописываем результат заполнения в отчёт («📤 Отчёт»), чтобы было видно,
    // что именно и почему не вписалось.
    try {
      const prev = GM_getValue(DEBUG_KEY) || {};
      prev.version = '0.36';
      prev.fill = { ok: ok.slice(), miss: miss.slice(), at: new Date().toISOString(), url: location.href };
      GM_setValue(DEBUG_KEY, prev);
    } catch (e) {}
    // Обновляем значок ошибки
    updateErrorIcon(miss, ok);
    // Короткое сообщение. Подробности — по кнопке «📤 Отчёт» в панели.
    const filledCount = ok.filter(function (s) { return !/^💾/.test(s); }).length;
    if (!ok.length) {
      toast('❌ Ничего не заполнилось.\nКарточка в режиме «редактировать»?\n👉 нажми сюда — покажу подробности', 'error', 10000, showFillReport);
    } else if (miss.length) {
      toast('⚠️ Заполнено, но ' + miss.length + ' не вышло.\n👉 нажми сюда — покажу подробности', 'warn', 9000, showFillReport);
    } else {
      toast('✅ Готово и сохранено (' + filledCount + ' полей).', 'ok', 4000);
    }
  }
  // Подробный отчёт по последнему заполнению — по кнопке «📤 Отчёт».
  function showFillReport() {
    const R = lastFillResult;
    if (!R || (!R.ok.length && !R.miss.length)) {
      toast('Пока нечего показывать — сначала нажми «✨ Заполнить».', 'warn');
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
      R.miss.length ? '❌ ' + R.miss.join(', ') : null,
    ].filter(Boolean).join('\n');
    toast(lines, R.miss.length ? 'warn' : 'ok', 20000);
    try { GM_setClipboard(JSON.stringify(GM_getValue(DEBUG_KEY) || {}, null, 2)); } catch (e) {}
  }
  function insertStored() {
    const d = GM_getValue(STORE_KEY);
    if (!d) { toast('Пока ничего не скопировано.\nНажми «✨ Заполнить из амо» или кнопку в амо.', 'warn'); return; }
    fillInputsFromData(d, 'Вставляю скопированное');
  }
  async function fillAdminOnly() {
    const d = GM_getValue(STORE_KEY);
    if (!d) { toast('Сначала нажми «✨ Заполнить из амо».', 'warn'); return; }
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
      reportBtn.textContent = '📤 Отчёт';
      reportBtn.style.cssText = 'width:100%;margin-top:6px;padding:6px;background:#F3F4F6;border:1px solid #E5E7EB;border-radius:6px;cursor:pointer;font-size:11px;color:#374151;';
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
    // Стиль — как у кружка: белый фон, светло-сиреневая рамка, мягкая тень.
    wrap.style.cssText = 'position:fixed;z-index:2147483646;display:flex;flex-direction:column;gap:4px;background:#fff;padding:8px 12px;border:1px solid #DDD6FE;border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.22);cursor:move;user-select:none;min-width:220px;max-width:96vw;';
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
    title.style.cssText = 'font-size:11px;font-weight:600;color:#7C3AED;';
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
    const mainBtn = mkBtn(IS_AMO ? '📋 Скопировать' : '✨ Заполнить', true);
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
      const bReport = mkBtn('📤 Отчёт');
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
      dropdown.style.cssText = 'display:none;position:absolute;top:calc(100% + 8px);right:0;min-width:280px;max-width:400px;background:#fff;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,0.2);border:1px solid #DDD6FE;padding:4px 0;z-index:2147483647;font-size:12px;line-height:1.6;color:#111827;max-height:300px;overflow-y:auto;';
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

  // Кнопка-магнит в шапке кейса OmniDesk — слева от статуса «Закрытое».
  // Белый круг + серый магнит, крупнее родных иконок, чтобы бросалась в глаза.
  // Клик — «притянуть» данные из амо и заполнить карточку (= «✨ Заполнить»).
  // Правый клик — открыть/закрыть панель (отчёт, «🔎 В амо», ручная вставка).
  const MAGNET_SVG =
    '<svg viewBox="-7.5 0 32 32" width="26" height="26" xmlns="http://www.w3.org/2000/svg" ' +
    'style="display:block;fill:#6B7280;transition:fill .15s;">' +
    '<path d="M3.68 10.6h-2.76c-0.48 0-0.84-0.36-0.84-0.84v-2.68c0-0.48 0.36-0.84 0.84-0.84h2.76c0.48 0 0.84 0.36 0.84 0.84v2.68c0 0.44-0.36 0.84-0.84 0.84zM1.76 8.92h1.12v-1h-1.12v1zM15.8 10.6h-2.76c-0.48 0-0.84-0.36-0.84-0.84v-2.68c0-0.48 0.36-0.84 0.84-0.84h2.76c0.48 0 0.84 0.36 0.84 0.84v2.68c0 0.44-0.36 0.84-0.84 0.84zM13.88 8.92h1.12v-1h-1.12v1zM8.36 25.76c-2.32 0-4.2-0.8-5.6-2.36-3.4-3.8-2.72-10.84-2.68-11.12 0.040-0.44 0.4-0.76 0.84-0.76h2.76c0.24 0 0.44 0.080 0.6 0.28 0.16 0.16 0.24 0.4 0.24 0.64-0.080 1.56 0.040 6.040 1.76 7.92 0.56 0.56 1.2 0.84 2 0.84h0.12c0.8 0 1.44-0.28 2-0.84 1.76-1.88 1.88-6.36 1.76-7.92 0-0.24 0.080-0.44 0.24-0.64s0.4-0.28 0.6-0.28h2.76c0.44 0 0.8 0.32 0.84 0.76 0.040 0.28 0.72 7.32-2.68 11.12-1.36 1.56-3.24 2.36-5.56 2.36zM1.72 13.2c-0.080 1.8 0 6.52 2.32 9.080 1.080 1.2 2.52 1.8 4.36 1.8s3.28-0.6 4.36-1.8c2.32-2.6 2.4-7.28 2.32-9.080h-1.12c0 1.84-0.2 6.080-2.24 8.28-0.88 0.92-1.96 1.4-3.2 1.4h-0.12c-1.28 0-2.36-0.48-3.2-1.4-2.16-2.2-2.36-6.44-2.36-8.28 0 0-1.12 0-1.12 0z"></path></svg>';

  function ensureMagnetButton() {
    if (!IS_OMNI) return;
    const bar = document.querySelector('.request-content-title-act');
    if (!bar) {
      const ex = document.getElementById('eduson-magnet-btn');
      if (ex) ex.remove();
      return;
    }
    if (document.getElementById('eduson-magnet-btn')) return;
    const btn = document.createElement('div');
    btn.id = 'eduson-magnet-btn';
    btn.title = 'Заполнить карточку из amoCRM. Правый клик — панель с отчётом.';
    btn.style.cssText = 'float:right;width:34px;height:34px;margin:-2px 8px 0 4px;display:flex;align-items:center;justify-content:center;cursor:pointer;' +
      'background:#fff;border:1px solid #E1E1E4;border-radius:50%;box-shadow:0 1px 5px rgba(0,0,0,.20);transition:background .15s,box-shadow .15s;';
    btn.innerHTML = MAGNET_SVG;
    const svg = btn.firstChild;
    btn.onmouseenter = function () { btn.style.background = '#F4F4F6'; btn.style.boxShadow = '0 2px 8px rgba(0,0,0,.28)'; if (svg) svg.style.fill = '#374151'; };
    btn.onmouseleave = function () { btn.style.background = '#fff'; btn.style.boxShadow = '0 1px 5px rgba(0,0,0,.20)'; if (svg) svg.style.fill = '#6B7280'; };
    btn.onclick = function (e) {
      e.stopPropagation();
      if (svg) { svg.style.fill = '#7C3AED'; setTimeout(function () { svg.style.fill = '#6B7280'; }, 700); }
      smartFillOmni();
    };
    btn.oncontextmenu = function (e) {
      e.preventDefault(); e.stopPropagation();
      ensurePanel();
      const wrap = document.getElementById('eduson-helper-panel');
      if (wrap) wrap.style.display = (wrap.style.display === 'none') ? 'flex' : 'none';
    };
    // добавляем последним ребёнком → при float:right оказывается ЛЕВЕЕ статуса «Закрытое»
    bar.appendChild(btn);
  }
  function mkBtn(text, big) {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = big
      ? 'background:#7C3AED;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:12px;font-weight:600;box-shadow:0 2px 8px rgba(124,58,237,.3);font-family:Segoe UI,Arial,sans-serif;transition:all 0.2s;'
      : 'background:#fff;color:#7C3AED;border:1px solid #DDD6FE;border-radius:6px;padding:4px 8px;font-size:10px;cursor:pointer;font-family:Segoe UI,Arial,sans-serif;transition:all 0.2s;';
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
    const colors = { ok: '#16A34A', warn: '#D97706', error: '#DC2626', info: '#7C3AED' };
    const box = document.createElement('div');
    // Компактная белая карточка внизу слева — не перекрывает карточку клиента справа.
    box.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:2147483647;max-width:340px;background:#fff;color:#1F2937;padding:10px 28px 10px 14px;border:1px solid #DDD6FE;border-radius:12px;font:12px/1.5 Segoe UI,Arial,sans-serif;white-space:pre-wrap;box-shadow:0 6px 24px rgba(0,0,0,.22);border-left:5px solid ' + (colors[type] || colors.info) + ';';
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
    closeX.onmouseenter = function () { closeX.style.color = '#7C3AED'; };
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
    console.log(TAG, 'запущен на', location.host, 'версия 0.36');
    ensurePanel();
    removeHelperBadge();
    ensureMagnetButton();
    setInterval(function () { ensurePanel(); removeHelperBadge(); ensureMagnetButton(); }, 1500);
  }
})();