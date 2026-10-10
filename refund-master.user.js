// ==UserScript==
// @name         Eduson Refund Master (Возврат-мастер)
// @namespace    eduson-refund-master
// @version      1.45.0
// @description  Помощник по возвратам: собирает данные из amoCRM (ФИО клиента — из карточки OmniDesk, при неполном имени добирает из админки Эдюсон); широкая панель в две колонки (анкета + данные амо + строка таблицы слева; после переговоров + ТГ + Асана справа); строка таблицы одной вставкой A→X; сообщения ТГ/РГ/Асаны по сценарию кейса.
// @author       Astanina Natalia
// @homepageURL  https://github.com/Slytherin7k/Eduson-Helper
// @updateURL    https://raw.githubusercontent.com/Slytherin7k/Eduson-Helper/main/refund-master.user.js
// @downloadURL  https://raw.githubusercontent.com/Slytherin7k/Eduson-Helper/main/refund-master.user.js
// @match        https://*.omnidesk.ru/*
// @match        https://docs.google.com/spreadsheets/d/11GNvwRy-fJwL2zg1KZbGouXzy5XXvJBlKXvtCHdgFfg/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_openInTab
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      eduson.amocrm.ru
// @connect      eduson.tv
// @connect      docs.google.com
// @connect      app.asana.com
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
  const CUTOFF_DATE = new Date(2026, 5, 5); // 05.06.2026 — с этой даты сумму считают в калькуляторе

  // Асана: карточки возвратов. ТЕСТ: пока пусто — кнопка «Создать карточку» не работает, чтобы случайно
  // не создать карточку в рабочем проекте. Для теста впиши gid тестового проекта (копия «Возвраты» с теми же колонками).
  // Рабочий проект «Возвраты»: 1206957485248244 (workspace 143258801040308).
  const ASANA_PROJECT = '1206957485248244';   // действующий проект «Возвраты» — Наталья разрешила тестировать на нём (03.10)
  const ASANA_WS = '143258801040308';
  const ASANA_DUE_DAYS = 10;   // срок карточки = дата создания + 10 дней

  /* ============ ЗАПИСЬ В ТАБЛИЦУ ИЗ МАСТЕРА (без копирования) ============
     Две половины одного скрипта, говорят через GM_setValue / GM_addValueChangeListener:
      • на странице OmniDesk — мастер кладёт «задание» (строка, данные, режим new/edit);
      • на странице таблицы возвратов — «работник»: встаёт на ячейку и вставляет данные,
        как будто куратор нажал Ctrl+V, и перечитывает строку, чтобы убедиться.
     Пишет ТОЛЬКО A–P и V–X. Q–U не трогает (их заполняют руками/другие). Обновлять можно
     только свою строку (в X должен быть номер этого обращения). Новая строка — только пустая.
     Хоть что-то не так → ничего не пишет, мастер отдаёт строку в буфер, как раньше. */

  const SH_COLS = 25; // A..Y (Y — Asana)
  const SHEET_WORKER_VER = 'w4';   // версия «работника» (видна в сообщениях об ошибках)
  // Пауза. В СКРЫТОЙ вкладке Chrome растягивает таймеры (после ~5 мин скрытости — до минуты), из-за чего запись
  // «зависала». Поэтому в скрытой вкладке время отсчитываем через MessageChannel — он не тормозится.
  function shSleep(ms) {
    return new Promise(function (res) {
      if (typeof document === 'undefined' || !document.hidden) { setTimeout(res, ms); return; }
      const t0 = Date.now(), ch = new MessageChannel();
      ch.port1.onmessage = function () { if (Date.now() - t0 >= ms) res(); else ch.port2.postMessage(0); };
      ch.port2.postMessage(0);
    });
  }
  function shParseCsvRow(t) {
    const out = []; let cur = '', q = false;
    t = String(t || '');
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (q) {
        if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '\n') break;
      else if (c !== '\r') cur += c;
    }
    out.push(cur);
    while (out.length < SH_COLS) out.push('');
    return out;
  }
  function shNum(s) {
    const n = parseFloat(String(s || '').replace(/[\s ₽%]/g, '').replace(',', '.'));
    return isFinite(n) ? n : NaN;
  }

  // ---- половина 2: «работник» на странице таблицы ----
  function sheetWorker() {
    // «Работником» становится ТОЛЬКО вкладка, которую открыл сам мастер (в адресе rmauto=1). Ваши собственные вкладки
    // с таблицей мастер не трогает и не использует — раньше они (особенно старые, со старой версией скрипта)
    // перехватывали задание и не выполняли его. Служебные ключи — rm2_sheet_*: старые вкладки их не слушают.
    if (!/[?&]rmauto=1/.test(location.search)) return;
    const tok = Math.random().toString(36).slice(2);
    const beat = function () { try { GM_setValue('rm3_sheet_alive', JSON.stringify({ t: Date.now(), tok: tok })); } catch (e) { /* ignore */ } };
    beat(); setInterval(beat, 2000);
    const seen = {};
    // Вкладку, которую открыл сам мастер (в адресе rmauto=1), он же и закрывает: через 25 с после записи,
    // а если задания так и не было — через 4 минуты (иначе в фоне она «засыпает» и тормозит).
    const AUTO = /[?&]rmauto=1/.test(location.search);
    let busy = false, jobsDone = 0, lastAct = Date.now();
    // вкладка закрывается/уходит — сразу сообщаем «меня нет» (иначе мастер ещё ~12 с считает её живой и шлёт задание в пустоту)
    const imGone = function () { try { GM_setValue('rm3_sheet_alive', JSON.stringify({ t: 0, tok: tok })); } catch (e) { /* ignore */ } };
    window.addEventListener('pagehide', imGone);
    window.addEventListener('beforeunload', imGone);
    if (AUTO) {
      setInterval(function () {
        if (busy) return;
        if (Date.now() - lastAct > (jobsDone ? 25000 : 240000)) { imGone(); try { window.close(); } catch (e) { /* ignore */ } }
      }, 5000);
    }

    let curId = '', curStage = '';
    const stage = function (s) { curStage = s; try { GM_setValue('rm3_sheet_prog', JSON.stringify({ id: curId, s: s, t: Date.now() })); } catch (e) { /* ignore */ } };
    function report(id, r) {
      r.id = id;
      try { GM_setValue('rm3_sheet_res', JSON.stringify(r)); } catch (e) { /* ignore */ }
    }
    function readRow(row) {
      const u = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/gviz/tq?tqx=out:csv&gid=' + SHEET_GID +
        '&range=A' + row + ':Y' + row + '&_cb=' + Date.now();
      const fetched = fetch(u, { credentials: 'include' }).then(function (r) { return r.text(); });
      const timeout = shSleep(20000).then(function () { throw new Error('таблица не отдала строку за 20 секунд'); });
      return Promise.race([fetched, timeout]).then(function (t) {
        if (/<!doctype|<html|accounts\.google\.com/i.test(String(t).slice(0, 400))) throw new Error('нужен вход в Google');
        if (/"status"\s*:\s*"error"/.test(t)) throw new Error('таблица не отдала строку');
        return shParseCsvRow(t);
      });
    }
    const nameBox = function () { return document.querySelector('#t-name-box'); };
    const nameVal = function () {
      const e = nameBox(); if (!e) return '';
      return String((e.value !== undefined && e.value !== '') ? e.value : (e.innerText || e.textContent || '')).trim().toUpperCase();
    };
    async function gotoCell(addr) {
      if (nameVal() === addr) return true;
      location.hash = 'gid=' + SHEET_GID + '&range=' + addr;
      for (let i = 0; i < 14; i++) { await shSleep(250); if (nameVal() === addr) return true; }
      // запасной путь: через поле имени
      const e = nameBox();
      if (e) {
        try {
          e.focus(); if (e.select) e.select();
          document.execCommand('selectAll'); document.execCommand('insertText', false, addr);
          ['keydown', 'keypress', 'keyup'].forEach(function (t) {
            e.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          });
        } catch (x) { /* ignore */ }
        for (let i = 0; i < 14; i++) { await shSleep(250); if (nameVal() === addr) return true; }
      }
      return nameVal() === addr;
    }
    // Ячейки со ссылками вставляем как HTML-ссылки: в таблице они синие и кликабельные (формула =HYPERLINK в xlsx
    // и простой адрес при программной вставке остаются чёрными). vals — массив ячеек; «=HYPERLINK("url")» → ссылка.
    function pasteCells(vals) {
      const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const plain = [], tds = [];
      vals.forEach(function (v) {
        v = String(v == null ? '' : v);
        const m = /^=HYPERLINK\("([^"]*)"\)$/.exec(v);
        const u = m ? m[1] : (/^https?:\/\/\S+$/.test(v) ? v : '');
        plain.push(m ? m[1] : v);
        tds.push('<td>' + (u ? '<a href="' + esc(u) + '">' + esc(u) + '</a>' : esc(v).replace(/\n/g, '<br>')) + '</td>');
      });
      return pasteText(plain.join('\t'), '<meta charset="utf-8"><table><tr>' + tds.join('') + '</tr></table>');
    }
    function pasteText(text, html) {
      const ed = document.querySelector('#waffle-rich-text-editor');
      if (!ed) return false;
      try { ed.focus(); } catch (e) { /* ignore */ }
      const dt = new DataTransfer(); dt.setData('text/plain', text);
      if (html) dt.setData('text/html', html);
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      ed.dispatchEvent(ev);
      return ev.defaultPrevented;   // таблица «забрала» вставку
    }

    async function runJob(j) {
      const row = parseInt(j.row, 10);
      if (!row || row < 2) return { ok: false, msg: 'странный номер строки' };
      stage('читаю строку ' + row);
      const cur = await readRow(row);
      if (j.mode === 'new') {
        // занята — если есть куратор или ФИО; «пустая» строка с одной ссылкой в X — остаток прошлой попытки:
        // если это ссылка на ЭТО ЖЕ обращение, спокойно дописываем поверх; чужая ссылка — считаем занятой
        const xHere = cur[23].trim();
        if (cur[0].trim() || cur[1].trim() || (xHere && !(j.key && xHere.indexOf(j.key) >= 0)))
          return { ok: false, occupied: true, msg: 'строка ' + row + ' уже занята («' + (cur[0] || cur[1] || ('в столбце X: ' + xHere)).slice(0, 40) + '…»)' };
      } else {
        // «продолжение» возврата из другого чата: в X чужая (прежняя) ссылка, но в W — та же сделка амо
        const sameDeal = j.leadId && String(cur[22] || '').indexOf('leads/detail/' + j.leadId) >= 0;
        if (!sameDeal && (!j.key || cur[23].indexOf(j.key) < 0))
          return { ok: false, msg: 'в строке ' + row + ' другое обращение (в X нет ' + (j.key || '?') + '). Обновлять нельзя — проверь номер строки.' };
      }
      // 1) A–P
      stage('перехожу к A' + row);
      if (!(await gotoCell('A' + row))) return { ok: false, msg: 'не смогла встать на A' + row + ' (поле имени показывает «' + nameVal() + '», вкладка ' + (document.hidden ? 'скрытая' : 'видимая') + ')' };
      stage('вставляю A–P');
      if (!pasteText(j.seg1.join('\t'))) return { ok: false, msg: 'таблица не приняла вставку (A–P)' };
      await shSleep(900);
      // 2) V–X
      stage('перехожу к V' + row);
      if (!(await gotoCell('V' + row))) return { ok: false, msg: 'A–P записала, но не смогла встать на V' + row + ' (поле имени показывает «' + nameVal() + '»)' };
      stage('вставляю V–X');
      if (!pasteCells(j.seg2)) return { ok: false, msg: 'A–P записала, но V–X таблица не приняла' };
      // 2.5) при «Возврате» с карточкой Асаны: U (дата отключения доступа) и Y (ссылка на Асану) — каждая своей вставкой
      const extra = j.extra || [];
      for (let e = 0; e < extra.length; e++) {
        await shSleep(900);
        if (!(await gotoCell(extra[e].col + row))) return { ok: false, msg: 'основное записала, но не смогла встать на ' + extra[e].col + row };
        if (!pasteCells([extra[e].val])) return { ok: false, msg: 'основное записала, но ' + extra[e].col + ' таблица не приняла' };
      }
      stage('проверяю запись');
      // 3) перепроверка
      let last = [], bad = [];
      const wantOf = {};   // что ждали в расходящихся столбцах — для сообщения об ошибке
      // мягкое сравнение текста: регистр, пробелы, «ё», кавычки, дата дд.мм.гггг / д.м.гг
      const softTxt = function (s) {
        return String(s || '').replace(/[  \s]+/g, ' ').replace(/[«»“”"]/g, '"').replace(/ё/gi, 'е').trim().toLowerCase();
      };
      const softDate = function (s) {
        const m = /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})/.exec(String(s).trim());
        if (!m) return null;
        return (+m[1]) + '.' + (+m[2]) + '.' + (m[3].length === 2 ? 2000 + (+m[3]) : +m[3]);
      };
      for (let i = 0; i < 8; i++) {
        await shSleep(1500);
        last = await readRow(row); bad = [];
        j.seg1.forEach(function (v, k) {
          if (k === 5 || k === 12 || v === '' || (v.charAt(0) === '=')) return;   // формулы F, M — считает сама таблица
          const got = (last[k] || '').trim(), want = String(v).trim();
          if (k === 6 || k === 11 || k === 14) {
            const a = shNum(got), b = shNum(want);
            if (!(a === b || (b === 0 && isNaN(a)))) { bad.push(k); wantOf[k] = want; }   // «0» таблица может показать как « - ₽ »
          }
          else if (got !== want) {
            const dg = softDate(got), dw = softDate(want);
            if (dg && dw ? dg === dw : softTxt(got) === softTxt(want)) return;
            bad.push(k); wantOf[k] = want;
          }
        });
        j.seg2.forEach(function (v, k) {
          const m = /HYPERLINK\("([^"]*)"\)/.exec(v);
          const want = (m ? m[1] : v).trim();
          if (want && (last[21 + k] || '').trim() !== want) bad.push(21 + k);
        });
        extra.forEach(function (x) {
          if ((last[x.idx] || '').trim() !== String(x.val).trim()) bad.push(x.idx);
        });
        if (!bad.length) break;
      }
      // в строке теперь чужое обращение — скорее всего, другой куратор вписал в ту же строку одновременно
      const xNow = (last[23] || '').trim();
      if (bad.length && xNow && j.key && xNow.indexOf(j.key) < 0)
        return { ok: false, conflict: true, msg: 'в строке ' + row + ' теперь запись другого обращения (вероятно, другой куратор вписал в ту же строку одновременно)' };
      if (bad.length) return { ok: false, msg: 'строка ' + row + ' записалась не полностью (расходятся столбцы: ' +
        bad.map(function (k) { return String.fromCharCode(65 + k); }).join(',') + ') — проверь её глазами. Подробно: ' +
        bad.map(function (k) {
          return String.fromCharCode(65 + k) + ': в таблице «' + String(last[k] || '').slice(0, 30) + '», ждали «' + String(wantOf[k] !== undefined ? wantOf[k] : '').slice(0, 30) + '»';
        }).join('; ') };
      return { ok: true, row: row, msg: 'записано и перепроверено' };
    }

    GM_addValueChangeListener('rm3_sheet_job', function (name, oldV, newV) {
      let j; try { j = JSON.parse(newV); } catch (e) { return; }
      if (!j || !j.id || seen[j.id]) return;
      // Задание АДРЕСНОЕ: мастер сам выбирает одну вкладку (j.to) и шлёт задание ей; остальные игнорируют.
      // (Раньше вкладки «боролись» за задание через общее значение; при задержке синхронизации обе уступали — и никто не работал.)
      if (j.to && j.to !== tok) return;
      seen[j.id] = 1;
      curId = j.id; stage('получила задание');
      // «задание принято» + сведения о вкладке (для диагностики, если что-то пойдёт не так)
      try { GM_setValue('rm3_sheet_ack', JSON.stringify({ id: j.id, t: Date.now(), hid: !!document.hidden, tok: tok, v: SHEET_WORKER_VER })); } catch (e) { /* ignore */ }
      (async function () {
        try {
          busy = true;
          stage('начинаю');
          // общий предохранитель: если какой-то шаг завис — не молчим, а сообщаем, на каком шаге
          const guard = shSleep(50000).then(function () { return { ok: false, msg: 'вкладка с таблицей зависла на шаге «' + curStage + '»' }; });
          report(j.id, await Promise.race([runJob(j), guard]));
        } catch (e) { report(j.id, { ok: false, msg: 'ошибка на шаге «' + curStage + '»: ' + (e && e.message || e) }); }
        busy = false; jobsDone++; lastAct = Date.now();
      })();
    });
  }
  // ---- половина 1: мост на стороне OmniDesk ----
  const _shPending = {}, _shAck = {}, _shStage = {}, _shAckInfo = {};
  let _shListening = false;
  function shListen() {
    if (_shListening) return; _shListening = true;
    GM_addValueChangeListener('rm3_sheet_res', function (name, oldV, newV) {
      let r; try { r = JSON.parse(newV); } catch (e) { return; }
      const cb = r && _shPending[r.id];
      if (cb) { delete _shPending[r.id]; cb(r); }
    });
    // текущий шаг работы вкладки с таблицей — чтобы при зависании сказать, на чём остановилась
    GM_addValueChangeListener('rm3_sheet_prog', function (name, oldV, newV) {
      let r; try { r = JSON.parse(newV); } catch (e) { return; }
      if (r && r.id) _shStage[r.id] = r.s;
    });
    // «задание принято» — вкладка с таблицей сразу подтверждает, что получила его
    GM_addValueChangeListener('rm3_sheet_ack', function (name, oldV, newV) {
      let r; try { r = JSON.parse(newV); } catch (e) { return; }
      if (r && r.id) _shAckInfo[r.id] = (r.hid ? 'скрытая' : 'видимая') + ', ' + (r.v || '?');
      const cb = r && _shAck[r.id];
      if (cb) cb();
    });
  }
  // Сердцебиение вкладки-работника: {t: время, tok: её метка}. Задание адресуем именно этой вкладке.
  function sheetBeat() {
    let v = GM_getValue('rm3_sheet_alive', 0);
    try { if (typeof v === 'string') v = JSON.parse(v); } catch (e) { v = { t: 0 }; }
    if (v && typeof v === 'object') return { t: parseInt(v.t, 10) || 0, tok: v.tok || '' };
    return { t: 0, tok: '' };
  }
  function sheetAlive() { return Date.now() - sheetBeat().t < 12000; }
  // Открыть таблицу в фоне (если ещё не открыта и не открывали в последние 90 с). Вкладка сама закроется после работы.
  // force — открыть заново, даже если недавно открывали (прошлая вкладка не отвечает).
  function ensureSheetTab(force) {
    if (!force) {
      if (sheetAlive()) return;
      const b = sheetBeat();
      const closed = !!b.tok && b.t === 0;   // вкладка сама сообщила «меня закрыли» — новую можно открывать сразу
      const last = parseInt(GM_getValue('rm3_sheet_opened', 0), 10) || 0;
      if (!closed && Date.now() - last < 90000) return;
    }
    try { GM_setValue('rm3_sheet_opened', Date.now()); } catch (e) { /* ignore */ }
    const url = SHEET_URL.replace('/edit#', '/edit?rmauto=1#');
    try { GM_openInTab(url, { active: false, insert: true }); }
    catch (e) { try { window.open(url, '_blank'); } catch (e2) { /* ignore */ } }
  }
  // job: {mode:'new'|'edit', row, key, seg1:[16], seg2:[3], extra:[…]} → Promise<{ok,msg}>
  // Ждём, пока таблица откроется (до 90 с); после отправки задания ждём «принято» (10 с) — если тишина,
  // вкладка мертва: открываем таблицу заново и отправляем ещё раз (до 2 раз); затем 60 с на саму запись.
  function sheetSend(job) {
    shListen();
    return new Promise(function (resolve) {
      job.id = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      job.n = 0;
      let finished = false, resT = 0, poll = 0, ackT = 0, acked = false, retries = 0;
      const done = function (r) {
        if (finished) return; finished = true;
        clearTimeout(resT); clearTimeout(ackT); clearInterval(poll);
        delete _shPending[job.id]; delete _shAck[job.id];
        resolve(r);
      };
      _shPending[job.id] = done;
      _shAck[job.id] = function () { acked = true; clearTimeout(ackT); };
      const post = function () {
        job.n++;
        job.to = sheetBeat().tok;   // адресуем задание вкладке, которая сейчас «жива»
        try { GM_setValue('rm3_sheet_job', JSON.stringify(job)); } catch (e) { done({ ok: false, msg: 'не смогла передать задание' }); return; }
        clearTimeout(resT);
        resT = setTimeout(function () { done({ ok: false, msg: 'таблица не ответила за 60 секунд после запроса' + (_shStage[job.id] ? ' (последний шаг вкладки: «' + _shStage[job.id] + '»)' : ' (вкладка приняла задание, но не начала работу)') + (_shAckInfo[job.id] ? ' [вкладка: ' + _shAckInfo[job.id] + ']' : '') }); }, 60000);
        ackT = setTimeout(function () {
          if (acked || finished) return;
          if (retries >= 2) { done({ ok: false, msg: 'вкладка с таблицей не отвечает (задание не принято)' }); return; }
          retries++;
          clearTimeout(resT);
          try { GM_setValue('rm3_sheet_alive', JSON.stringify({ t: 0, tok: '' })); } catch (e) { /* ignore */ }   // прошлая вкладка мертва
          ensureSheetTab(true);
          waitAlive();
        }, 10000);
      };
      const waitAlive = function () {
        clearInterval(poll);
        let waited = 0;
        poll = setInterval(function () {
          waited += 500;
          if (sheetAlive()) { clearInterval(poll); setTimeout(post, 1200); }
          else if (waited > 90000) { done({ ok: false, msg: 'таблица не открылась за 90 секунд (или в ней не работает скрипт)' }); }
        }, 500);
      };
      if (sheetAlive()) { post(); return; }
      ensureSheetTab();
      waitAlive();
    });
  }
  /* ============ ЗАПИСЬ В GOOGLE-КАЛЬКУЛЯТОР (лист куратора) ============
     Тот же приём, что и для таблицы возвратов: мастер на OmniDesk кладёт задание в GM_setValue, а вкладка калькулятора
     (открытая мастером, rmauto=1) встаёт на ячейку, вставляет столбец значений «как Ctrl+V» и сверяет «Итого к возврату».
     Ключи rm3_calc_*. Один лист на куратора (название листа = ФИО; у Нины Пилипенко лист «Валикова Нина»). */
  const CALC_ID = '11GNvwRy-fJwL2zg1KZbGouXzy5XXvJBlKXvtCHdgFfg';
  const CALC_SHEET_GIDS = {
    'Астанина Наталья': '0', 'Перова Кристина': '275787535', 'Хациева Расита': '1063839769', 'Руденко Диана': '1477527828',
    'Донцова Ольга': '626782997', 'Пилипенко Нина': '2028694928', 'Косьянова Юлия': '1653698740', 'Цурикова Юлия': '1613973097',
    'Фомина Дарья': '107345549', 'Романенко Вадим': '2011870216', 'Белякова Валерия': '1133222434', 'Емельянова Дина': '177768578',
  };

  function calcWorker() {
    if (!/[?&]rmauto=1/.test(location.search)) return;   // работает только вкладка, которую открыл мастер
    const tok = Math.random().toString(36).slice(2);
    const beat = function () { try { GM_setValue('rm3_calc_alive', JSON.stringify({ t: Date.now(), tok: tok })); } catch (e) { /* ignore */ } };
    beat(); setInterval(beat, 2000);
    const imGone = function () { try { GM_setValue('rm3_calc_alive', JSON.stringify({ t: 0, tok: tok })); } catch (e) { /* ignore */ } };
    window.addEventListener('pagehide', imGone); window.addEventListener('beforeunload', imGone);
    let busy = false, jobsDone = 0, lastAct = Date.now();
    setInterval(function () {
      if (busy) return;
      if (Date.now() - lastAct > (jobsDone ? 20000 : 240000)) { imGone(); try { window.close(); } catch (e) { /* ignore */ } }
    }, 5000);
    const seen = {};
    const nameVal = function () {
      const e = document.querySelector('#t-name-box'); if (!e) return '';
      return String((e.value !== undefined && e.value !== '') ? e.value : (e.innerText || e.textContent || '')).trim().toUpperCase();
    };
    async function gotoCell(gid, addr) {
      if (nameVal() === addr) return true;
      location.hash = 'gid=' + gid + '&range=' + addr;
      for (let i = 0; i < 16; i++) { await shSleep(250); if (nameVal() === addr) return true; }
      const e = document.querySelector('#t-name-box');
      if (e) {
        try {
          e.focus(); if (e.select) e.select();
          document.execCommand('selectAll'); document.execCommand('insertText', false, addr);
          ['keydown', 'keypress', 'keyup'].forEach(function (t) {
            e.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          });
        } catch (x) { /* ignore */ }
        for (let i = 0; i < 14; i++) { await shSleep(250); if (nameVal() === addr) return true; }
      }
      return nameVal() === addr;
    }
    function pasteText(text) {
      const ed = document.querySelector('#waffle-rich-text-editor');
      if (!ed) return false;
      try { ed.focus(); } catch (e) { /* ignore */ }
      const dt = new DataTransfer(); dt.setData('text/plain', text);
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      ed.dispatchEvent(ev);
      return ev.defaultPrevented;
    }
    function readCell(gid, addr) {
      const u = 'https://docs.google.com/spreadsheets/d/' + CALC_ID + '/gviz/tq?tqx=out:csv&gid=' + gid + '&range=' + addr + ':' + addr + '&_cb=' + Date.now();
      const fetched = fetch(u, { credentials: 'include' }).then(function (r) { return r.text(); });
      const timeout = shSleep(15000).then(function () { throw new Error('таблица не отдала ячейку за 15 секунд'); });
      return Promise.race([fetched, timeout]).then(function (t) {
        if (/<!doctype|<html|accounts\.google\.com/i.test(String(t).slice(0, 400))) throw new Error('нужен вход в Google');
        return (shParseCsvRow(t)[0] || '').trim();
      });
    }
    async function runJob(j) {
      if (!(await gotoCell(j.gid, j.cell))) return { ok: false, msg: 'не смогла встать на ' + j.cell + ' (поле имени показывает «' + nameVal() + '»).' };
      if (!pasteText(j.text)) return { ok: false, msg: 'калькулятор не принял вставку.' };
      let got = '';
      for (let i = 0; i < 8; i++) {
        await shSleep(1300);
        got = await readCell(j.gid, j.expectCell);
        const v = shNum(got);
        if (isFinite(v) && Math.abs(v - j.expect) < 0.02) return { ok: true, msg: 'записано и сверено' };
      }
      return { ok: false, msg: 'записала, но «Итого» в калькуляторе ' + (got || 'пусто') + ' вместо ' + j.expect + ' — проверь лист.' };
    }
    GM_addValueChangeListener('rm3_calc_job', function (name, oldV, newV) {
      let j; try { j = JSON.parse(newV); } catch (e) { return; }
      if (!j || !j.id || seen[j.id]) return;
      if (j.to && j.to !== tok) return;
      seen[j.id] = 1;
      try { GM_setValue('rm3_calc_ack', JSON.stringify({ id: j.id, t: Date.now() })); } catch (e) { /* ignore */ }
      (async function () {
        busy = true;
        let r;
        try {
          const guard = shSleep(45000).then(function () { return { ok: false, msg: 'вкладка калькулятора зависла.' }; });
          r = await Promise.race([runJob(j), guard]);
        } catch (e) { r = { ok: false, msg: 'ошибка: ' + ((e && e.message) || e) }; }
        r.id = j.id;
        try { GM_setValue('rm3_calc_res', JSON.stringify(r)); } catch (e) { /* ignore */ }
        busy = false; jobsDone++; lastAct = Date.now();
      })();
    });
  }

  const _calcPending = {}, _calcAck = {};
  let _calcListening = false;
  function calcBeat() {
    let v = GM_getValue('rm3_calc_alive', 0);
    try { if (typeof v === 'string') v = JSON.parse(v); } catch (e) { v = { t: 0 }; }
    if (v && typeof v === 'object') return { t: parseInt(v.t, 10) || 0, tok: v.tok || '' };
    return { t: 0, tok: '' };
  }
  function calcAlive() { return Date.now() - calcBeat().t < 12000; }
  function ensureCalcTab(gid, force) {
    if (!force) {
      if (calcAlive()) return;
      const b = calcBeat(), closed = !!b.tok && b.t === 0;
      const last = parseInt(GM_getValue('rm3_calc_opened', 0), 10) || 0;
      if (!closed && Date.now() - last < 60000) return;
    }
    try { GM_setValue('rm3_calc_opened', Date.now()); } catch (e) { /* ignore */ }
    const url = 'https://docs.google.com/spreadsheets/d/' + CALC_ID + '/edit?rmauto=1#gid=' + gid;
    try { GM_openInTab(url, { active: false, insert: true }); }
    catch (e) { try { window.open(url, '_blank'); } catch (e2) { /* ignore */ } }
  }
  // job: {gid, cell, text, expectCell, expect} → Promise<{ok,msg}>
  function calcSheetSend(job) {
    if (!_calcListening) {
      _calcListening = true;
      GM_addValueChangeListener('rm3_calc_res', function (n, o, v) {
        let r; try { r = JSON.parse(v); } catch (e) { return; }
        const cb = r && _calcPending[r.id]; if (cb) { delete _calcPending[r.id]; cb(r); }
      });
      GM_addValueChangeListener('rm3_calc_ack', function (n, o, v) {
        let r; try { r = JSON.parse(v); } catch (e) { return; }
        const cb = r && _calcAck[r.id]; if (cb) cb();
      });
    }
    return new Promise(function (resolve) {
      job.id = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      job.n = 0;
      let finished = false, resT = 0, poll = 0, ackT = 0, acked = false, retries = 0;
      const done = function (r) {
        if (finished) return; finished = true;
        clearTimeout(resT); clearTimeout(ackT); clearInterval(poll);
        delete _calcPending[job.id]; delete _calcAck[job.id];
        resolve(r);
      };
      _calcPending[job.id] = done;
      _calcAck[job.id] = function () { acked = true; clearTimeout(ackT); };
      const post = function () {
        job.n++;
        job.to = calcBeat().tok;
        try { GM_setValue('rm3_calc_job', JSON.stringify(job)); } catch (e) { done({ ok: false, msg: 'не смогла передать задание.' }); return; }
        clearTimeout(resT);
        resT = setTimeout(function () { done({ ok: false, msg: 'калькулятор не ответил за 60 секунд.' }); }, 60000);
        ackT = setTimeout(function () {
          if (acked || finished) return;
          if (retries >= 2) { done({ ok: false, msg: 'вкладка калькулятора не отвечает.' }); return; }
          retries++;
          clearTimeout(resT);
          try { GM_setValue('rm3_calc_alive', JSON.stringify({ t: 0, tok: '' })); } catch (e) { /* ignore */ }
          ensureCalcTab(job.gid, true);
          waitAlive();
        }, 10000);
      };
      const waitAlive = function () {
        clearInterval(poll);
        let waited = 0;
        poll = setInterval(function () {
          waited += 500;
          if (calcAlive()) { clearInterval(poll); setTimeout(post, 1200); }
          else if (waited > 90000) done({ ok: false, msg: 'калькулятор не открылся за 90 секунд (или в нём не работает скрипт).' });
        }, 500);
      };
      if (calcAlive()) { post(); return; }
      ensureCalcTab(job.gid);
      waitAlive();
    });
  }

  // Запрос в API Асаны от имени куратора (нужен вход в app.asana.com в этом же браузере).
  // Заголовок X-Allow-Asana-Client — как у самого сайта Асаны.
  function asanaApi(method, path, bodyObj) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: method, url: 'https://app.asana.com/api/1.0' + path, timeout: 20000,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Allow-Asana-Client': '1' },
        data: bodyObj ? JSON.stringify(bodyObj) : undefined,
        onload: function (r) {
          let j = {}; try { j = JSON.parse(r.responseText || '{}'); } catch (e) { /* ignore */ }
          if (r.status >= 200 && r.status < 300) resolve(j.data !== undefined ? j.data : j);
          else if (r.status === 401 || r.status === 403) reject(new Error('NOAUTH'));
          else reject(new Error('http-' + r.status + ' ' + ((j.errors && j.errors[0] && j.errors[0].message) || '')));
        },
        onerror: function () { reject(new Error('сеть')); },
        ontimeout: function () { reject(new Error('таймаут')); }
      });
    });
  }

  // Файл → вложение карточки Асаны (multipart: parent = номер карточки, file = сам файл).
  function asanaUpload(taskGid, file) {
    return new Promise(function (resolve, reject) {
      const fd = new FormData();
      fd.append('parent', String(taskGid));
      fd.append('file', file, file.name || ('file-' + Date.now()));
      GM_xmlhttpRequest({
        method: 'POST', url: 'https://app.asana.com/api/1.0/attachments', timeout: 120000,
        headers: { 'Accept': 'application/json', 'X-Allow-Asana-Client': '1' },   // Content-Type с границей поставит сам браузер
        data: fd,
        onload: function (r) {
          let j = {}; try { j = JSON.parse(r.responseText || '{}'); } catch (e) { /* ignore */ }
          if (r.status >= 200 && r.status < 300) resolve(j.data || j);
          else if (r.status === 401 || r.status === 403) reject(new Error('NOAUTH'));
          else reject(new Error('http-' + r.status + ' ' + ((j.errors && j.errors[0] && j.errors[0].message) || '')));
        },
        onerror: function () { reject(new Error('сеть при загрузке файла')); },
        ontimeout: function () { reject(new Error('файл грузился слишком долго')); }
      });
    });
  }

  /* ==================== ТРЕКИНГ ОТКРЫТИЙ ПАНЕЛИ ====================
     Та же Google-таблица, что и у Хэлпера («Хэлпер — трекинг открытий (Ответы)»): считаем и открытия
     Возврат-мастера, отдельной строкой. Имя куратора смотрим САМИ — один раз читаем его профиль
     OmniDesk (staff/profile, поле #full_name_1, свой домен — обычный fetch без GM), а не спрашиваем.
     Если вдруг не нашли — тогда спросим один раз сами. Хранится отдельно от Хэлпера (у каждого
     юзерскрипта своё хранилище GM_setValue). */
  const TRACK_FORM_ID = '1FAIpQLSccdINuowvzjGyK-XZDD2bBBbecYG3hN4diphiQzBKkKWuzNg';
  const TRACK_ENTRY_WHO = 'entry.2127510800';
  const TRACK_ENTRY_WHAT = 'entry.1222951321';
  function trackAskName() {
    const name = String(prompt('Как записать тебя в статистику открытий Возврат-мастера? (спрошу один раз, запомню)') || '').trim();
    if (name) GM_setValue('rm_curator_name', name);
    return name;
  }
  function trackCurator() {
    const saved = GM_getValue('rm_curator_name', '');
    if (saved) return Promise.resolve(saved);
    return fetch('https://eduson.omnidesk.ru/staff/profile/', { credentials: 'include' })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        const m = html.match(/id="full_name_1"[^>]*value="([^"]*)"/i);
        const name = (m && m[1]) ? m[1].trim() : '';
        if (name) { GM_setValue('rm_curator_name', name); return name; }
        return trackAskName();
      })
      .catch(function () { return trackAskName(); });
  }
  function trackSend(what) {
    trackCurator().then(function (who) {
      if (!who) return;
      GM_xmlhttpRequest({
        method: 'POST', url: 'https://docs.google.com/forms/d/e/' + TRACK_FORM_ID + '/formResponse', timeout: 15000, anonymous: true,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        data: TRACK_ENTRY_WHO + '=' + encodeURIComponent(who) + '&' + TRACK_ENTRY_WHAT + '=' + encodeURIComponent(what),
        onload: function () {}, onerror: function () {}, ontimeout: function () {}
      });
    });
  }

  // Таблица длительности программ (курс → академ.часы + срок в днях). Публичная, gviz-CSV.
  // Столбцы: A Наименование программы | B Кол-во академ. часов | C Срок освоения, дней | D Тип диплома.
  // Питает два поля калькулятора: ак.ч. (C6) и дней (C7).
  const DURATION_SHEET_ID = '1p0Yo4ikx_AegiJitKjgAiYN7ydpHcENIjT-3Xppkon4';
  const DURATION_CSV_URL = 'https://docs.google.com/spreadsheets/d/' + DURATION_SHEET_ID +
    '/gviz/tq?tqx=out:csv&gid=0';

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
  const RESULTS = ['Возврат', 'Остается', 'В работе'];
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

  // Дата смены оферты (= начало расчёта через калькулятор). Название сценария «До ДД.ММ.ГГГГ».
  const OFFER_DATE_STR = '05.06.2026';

  // Сценарии кейса. Палитра всей панели меняется по сценарию (см. THEMES).
  //  before — куплено до смены оферты (серая тема, без калькулятора)
  //  gt3    — куплено после смены оферты, заявка > 3 дней (стандартная голубая тема, калькулятор)
  //  le3    — заявка ≤ 3 дней (оранжевая тема, передаём РГ)
  //  resale — ресейл TeachMeSkills (фиолетовая тема; в OmniDesk у курса эмодзи 🅿️)
  //  kids   — детские курсы (жёлтая тема; эмодзи 🐣, пока не у всех — есть ручной выбор)
  const SCENARIOS = {
    before: { name: 'До ' + OFFER_DATE_STR },
    gt3:    { name: 'Больше 3 дней' },
    le3:    { name: 'Меньше или равно 3 д.' },
    resale: { name: 'Ресейл TeachMeSkills' },
    kids:   { name: 'Детские курсы' },
  };
  const SCEN_MANUAL = [
    ['', '— по кейсу (авто) —'],
    ['before', SCENARIOS.before.name],
    ['gt3', SCENARIOS.gt3.name],
    ['le3', SCENARIOS.le3.name],
    ['resale', SCENARIOS.resale.name],
    ['kids', SCENARIOS.kids.name],
  ];
  // Метка-эмодзи в поле КУРС карточки OmniDesk → сценарий.
  const KURS_MARK = { '\u{1F17F}': 'resale', '\u{1F423}': 'kids' }; // 🅿️ ресейл, 🐣 детские

  // Убрать метку-эмодзи из названия курса (в amo её нет, но на всякий случай).
  function stripMark(s) {
    return String(s || '').replace(/[\u{1F17F}\u{1F423}]️?/gu, '').replace(/\s+/g, ' ').trim();
  }

  // Команды продаж: тег РГ (руководителя) → его МОПы. Для автоподстановки в блок
  // «Возврат ≤ 3 дней → РГ». Актуально на 31.08.2026. Имена МОПов — в любом порядке слов.
  const RG_TEAMS = {
    '@Mila_Otrokusha': ['Косарев Юрий', 'Перова Юлия', 'Лобков Артур', 'Бондаренко Андрей', 'Мартышкина Ольга', 'Пасхалиди Димитрий', 'Зинченко Алена'],
    '@alexandrkulikof': ['Ильина Диана', 'Кухто Арина', 'Беспалов Евгений', 'Забродская Карина', 'Пухова Полина', 'Пруненко Татьяна'],
    '@kondratev_av': ['Данилов Алексей', 'Руденко Оксана', 'Рассомакин Иван', 'Шапошникова Натали', 'Шевелева Ксения'],
    '@marinachekhova': ['Жолобова Анастасия', 'Крестьянникова Александра', 'Гурулёва Дарья', 'Шарапова Анастасия', 'Соколова Анастасия', 'Иваненко Андрей'],
    '@av_fomenko': ['Дубровина Ольга', 'Попова Анастасия', 'Красовский Антон', 'Гетманов Николай', 'Мишин Иван', 'Костюк Матвей', 'Иванов Алексей', 'Байраковский Кирилл'],
    '@lvovskiy_vit': ['Кузнецова Екатерина', 'Шмаков Юрий', 'Зыбченко Анастасия', 'Сопилкина Наталья', 'Соловьева Светлана', 'Пилипенко Ольга', 'Уварова Ольга', 'Скакун Артур'],
    '@az_anar': ['Константинова Екатерина', 'Тагиль Карина', 'Кузнецов Артур', 'Левченко Владислав', 'Пименова Виктория', 'Тихомирова Алина', 'Сычева Татьяна'],
    '@kozhanov_eduson': ['Печинога Валерия', 'Шеханова Лилия', 'Негреева Диана', 'Агаджанян Валерия', 'Рагимов Максун', 'Тихомирова Мария'],
    '@Klem_Den_lucky': ['Соколовский Александр', 'Виноградов Виктор', 'Рябова Эльвира', 'Шум Карина', 'Качегова Даяна', 'Яловегин Николай', 'Ильницкий Илларион', 'Гончарова Ирина', 'Денежкин Никита', 'Журавлева Евгения', 'Зинкевич Елизавета'],
    '@Vladimir_Tolstov_m': ['Прохорова Василиса', 'Романова Людмила', 'Гусев Кирилл', 'Квон Екатерина', 'Сартакова Евгения', 'Умнова Виктория', 'Максимов Владислав', 'Папко Екатерина'],
    '@D_Bagaturia': ['Белеева Мария', 'Фролова Екатерина', 'Лем Станислав', 'Степанов Петр', 'Михайлова Карина', 'Брудковски Александра', 'Гагилев Дмитрий', 'Вендин Максим', 'Золотарев Игорь'],
  };
  const rgByMop = (function () {
    const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z]+/g, ' ')
      .trim().split(/\s+/).filter(Boolean).sort().join(' ');
    const idx = {};
    Object.keys(RG_TEAMS).forEach(rg => RG_TEAMS[rg].forEach(n => { idx[norm(n)] = rg; }));
    return name => idx[norm(name)] || '';
  })();

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

  // Запрос в API амо с записью (PATCH): те же куки сессии, что и у чтения. Отдаёт JSON ({} при 204).
  function gmAmoJson(method, path, bodyObj) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: method, url: 'https://' + AMO_SUBDOMAIN + '.amocrm.ru' + path, timeout: 20000,
        headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json', 'Content-Type': 'application/json' },
        data: bodyObj ? JSON.stringify(bodyObj) : undefined,
        onload: function (res) {
          if (res.status >= 200 && res.status < 300) {
            if (res.status === 204 || !res.responseText) { resolve({}); return; }
            try { resolve(JSON.parse(res.responseText)); } catch (e) { reject(new Error('ответ амо не разбирается')); }
          } else if (res.status === 401 || res.status === 403) { reject(new Error('NOAUTH'));
          } else { reject(new Error('амо ответило кодом ' + res.status + ' ' + String(res.responseText || '').slice(0, 140))); }
        },
        onerror: function () { reject(new Error('сеть или куки не пустили')); },
        ontimeout: function () { reject(new Error('долго нет ответа')); },
      });
    });
  }
  // Метки сделок в амо: все метки аккаунта (id, название, цвет)
  async function amoAllLeadTags() {
    const out = [];
    for (let page = 1; page <= 6; page++) {
      const j = await gmAmoJson('GET', '/api/v4/leads/tags?limit=250&page=' + page);
      const arr = (j._embedded && j._embedded.tags) || [];
      arr.forEach(t => out.push({ id: t.id, name: String(t.name || ''), color: t.color || '' }));
      if (arr.length < 250) break;
    }
    return out;
  }
  // оранжевый ли цвет метки (#rrggbb): оттенок 18–48°, заметная насыщенность
  function isOrangeHex(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return false;
    const n = parseInt(m[1], 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d < 0.08) return false;
    let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    return h >= 18 && h <= 48;
  }

  // GET, отдаёт текст (HTML) — для страниц админки Эдюсон.
  // На один прогон сбора (прогрев / «🔄 амо») кэшируем ответы по URL: страницу студента в
  // админке (~1.3 МБ) раньше тянули дважды — за ФИО и за ссылкой на кабинет. Теперь один раз.
  let _rmPageCache = null;
  function _gmFetchTextImpl(url) {
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
  function gmFetchText(url) {
    if (!_rmPageCache) return _gmFetchTextImpl(url);
    if (_rmPageCache.has(url)) return _rmPageCache.get(url);
    const p = _gmFetchTextImpl(url);
    _rmPageCache.set(url, p);
    p.catch(() => { if (_rmPageCache && _rmPageCache.get(url) === p) _rmPageCache.delete(url); });
    return p;
  }

  /* ---------- блокировка курса студента в админке Эдюсон ----------
     Курс студента = отдельный пользователь (sub user) у суперюзера. «Заблокировать курс» = поставить у него
     галочку «Archived» (`user[archived]`) в форме редактирования; статус в списке суперюзера станет «blocked».
     Не удаляем ничего. Форму отправляем ЦЕЛИКОМ (как браузер), меняя только эту галочку, и перечитываем. */
  const EDU_ADMIN = 'https://www.eduson.tv';
  function gmPostForm(url, bodyStr, referer) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'POST', url: url, timeout: 25000, data: bodyStr,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': referer, 'Origin': EDU_ADMIN },
        onload: function (r) {
          if (r.status >= 200 && r.status < 400) resolve(r.responseText || '');
          else if (r.status === 401 || r.status === 403) reject(new Error('NOAUTH'));
          else if (r.status === 422) reject(new Error('админка не приняла форму (токен устарел?) — обнови страницу и повтори'));
          else reject(new Error('админка ответила кодом ' + r.status));
        },
        onerror: function () { reject(new Error('сеть или куки не пустили')); },
        ontimeout: function () { reject(new Error('долго нет ответа')); },
      });
    });
  }
  const parseHtml = function (t) { return new DOMParser().parseFromString(t, 'text/html'); };
  // Курсы студента: [{uid, company, status}] — по ссылкам из поля «АДМИНКА» (7302) карточки OmniDesk.
  async function adminStudentCourses() {
    const raw = omniCardField(7302) || '';
    let superIds = (raw.match(/\/admin\/super_users\/(\d+)/g) || []).map(function (m) { return m.match(/(\d+)/)[1]; });
    const userIds = (raw.match(/\/admin\/users\/(\d+)/g) || []).map(function (m) { return m.match(/(\d+)/)[1]; });
    if (!superIds.length && !userIds.length) throw new Error('в карточке нет ссылки в поле «АДМИНКА»');
    for (const uid of userIds.slice(0, 2)) {   // из страницы пользователя берём его суперюзера
      const t = await _gmFetchTextImpl(EDU_ADMIN + '/admin/users/' + uid + '?language=ru');
      const m = t.match(/Super User:\s*(?:<[^>]*>\s*)*(\d+)/i) || t.match(/\/admin\/super_users\/(\d+)/);
      if (m && superIds.indexOf(m[1]) === -1) superIds.push(m[1]);
    }
    const out = [];
    for (const sid of superIds.slice(0, 2)) {
      const doc = parseHtml(await _gmFetchTextImpl(EDU_ADMIN + '/admin/super_users/' + sid + '?language=ru'));
      let tbl = null;
      doc.querySelectorAll('table').forEach(function (t) {
        const head = (t.querySelector('tr') || {}).textContent || '';
        if (/first name/i.test(head) && /company/i.test(head)) tbl = t;
      });
      if (!tbl) continue;
      const heads = Array.from(tbl.querySelectorAll('tr')[0].querySelectorAll('th,td')).map(function (x) { return x.textContent.trim().toLowerCase(); });
      const iC = heads.indexOf('company'), iS = heads.indexOf('status');
      Array.from(tbl.querySelectorAll('tr')).slice(1).forEach(function (tr) {
        const a = tr.querySelector('a[href*="/admin/users/"]');
        const m = a && a.getAttribute('href').match(/\/admin\/users\/(\d+)/);
        const td = Array.from(tr.querySelectorAll('td')).map(function (x) { return x.textContent.replace(/\s+/g, ' ').trim(); });
        if (m) out.push({ uid: m[1], company: iC >= 0 ? td[iC] : '', status: iS >= 0 ? td[iS] : '' });
      });
    }
    // Студент БЕЗ суперюзера (одиночный аккаунт, «Groups: Default»): курсов-суб-пользователей нет, блокируем сам аккаунт —
    // у него та же форма с галочкой «Archived» (/admin/users/<id>/edit).
    if (!out.length && userIds.length) {
      for (const uid of userIds.slice(0, 2)) {
        try {
          const doc = parseHtml(await _gmFetchTextImpl(EDU_ADMIN + '/admin/users/' + uid + '/edit?language=ru'));
          const cb = doc.querySelector('input[type=checkbox][name="user[archived]"]');
          if (!cb) continue;
          const sel = doc.querySelector('select[name="user[company_id]"]');
          const comp = sel && sel.selectedOptions && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent.trim() : '';
          out.push({ uid: uid, company: comp || ('Аккаунт студента №' + uid), status: cb.checked ? 'blocked' : 'available' });
        } catch (e) { if (e.message === 'NOAUTH') throw e; }
      }
    }
    if (!out.length) throw new Error('курсы студента не нашлись');
    return out;
  }
  // Поставить/снять «Archived» у курса-пользователя uid. Перечитывает форму и бросает ошибку, если не сработало.
  async function adminSetArchived(uid, archived) {
    const editUrl = EDU_ADMIN + '/admin/users/' + uid + '/edit?language=ru';
    const doc = parseHtml(await _gmFetchTextImpl(editUrl));
    const form = doc.querySelector('form#edit_user_' + uid) ||
      Array.from(doc.forms).find(function (f) { return f.querySelector('[name="user[archived]"]'); });
    if (!form) throw new Error('форма редактирования не нашлась');
    const cb = form.querySelector('input[type=checkbox][name="user[archived]"]');
    if (!cb) throw new Error('галочка «Archived» не нашлась');
    cb.checked = !!archived;
    const body = new URLSearchParams();
    new FormData(form).forEach(function (v, k) { if (typeof v === 'string') body.append(k, v); });
    await gmPostForm(EDU_ADMIN + form.getAttribute('action'), body.toString(), editUrl);
    const doc2 = parseHtml(await _gmFetchTextImpl(editUrl));
    const cb2 = doc2.querySelector('input[type=checkbox][name="user[archived]"]');
    if (!cb2 || cb2.checked !== !!archived) throw new Error('админка приняла запрос, но галочка не поменялась — проверь вручную');
    return true;
  }

  /* ---------- повторный возврат: поиск уже внесённых строк по сделке амо / обращению ---------- */
  function shParseCsvRows(t) {
    const rows = []; let row = [], cur = '', q = false;
    t = String(t || '');
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (q) {
        if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c !== '\r') cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }
  function parseRuDate(s) {
    const m = String(s || '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null;
  }
  // Ищем строки с этой сделкой (столбец W) или этим обращением (столбец X). gviz-запрос с where.
  // → { matches: [{cur, fio, date, result, sum, sameCase}], sameCase: bool, recent: match|null }
  async function sheetFindDuplicates(leadId, caseKey, claimDateStr) {
    const conds = [];
    if (/^\d+$/.test(leadId || '')) conds.push("W contains 'leads/detail/" + leadId + "'");
    if (/^[\w-]+$/.test(caseKey || '')) conds.push("X contains '" + caseKey + "'");
    if (!conds.length) return { matches: [], sameCase: false, recent: null };
    const q = 'select A,B,D,N,O,X,Y where ' + conds.join(' or ');
    const t = await sheetQuery('tq=' + encodeURIComponent(q));
    if (looksLikeLoginPage(t)) throw new Error('нужен вход в Google');
    if (/"status"\s*:\s*"error"/.test(t)) throw new Error('таблица не ответила на проверку');
    const rows = shParseCsvRows(t).slice(1);   // первая строка — заголовки
    const matches = rows.filter(r => r.some(x => String(x).trim())).map(r => ({
      cur: (r[0] || '').trim(), fio: (r[1] || '').trim(), date: (r[2] || '').trim(),
      result: (r[3] || '').trim(), sum: (r[4] || '').replace(/\s+/g, ' ').trim(),
      sameCase: !!caseKey && String(r[5] || '').indexOf(caseKey) >= 0,
      asana: (String(r[6] || '').match(/https?:\/\/app\.asana\.com\/\S*?\/task\/(\d+)/) || [])[0] || '',
    }));
    const now = parseRuDate(claimDateStr) || new Date();
    // «недавний» повтор: с даты заявки той строки прошло меньше месяца (или дату не прочитать — на всякий случай предупредим)
    const recent = matches.slice().reverse().find(m => {
      if (m.sameCase) return false;
      const d = parseRuDate(m.date);
      if (!d) return true;
      return (now - d) / 86400000 < 31;
    }) || null;
    return { matches, sameCase: matches.some(m => m.sameCase), recent };
  }
  // Номер строки ПОСЛЕДНЕГО совпадения в столбце (бинарный поиск по счётчикам gviz, ~13 запросов, ~5 с).
  async function sheetLocateRow(colLetter, needle) {
    const cnt = async function (from) {
      const t = await sheetQuery('tq=' + encodeURIComponent("select count(" + colLetter + ") where " + colLetter + " contains '" + needle + "'") +
        '&range=' + colLetter + from + ':' + colLetter + 8000);
      const m = String(t).replace(/"/g, '').match(/(\d+)\s*$/);
      return m ? +m[1] : 0;
    };
    if (!(await cnt(1))) return 0;
    let lo = 1, hi = 8000;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if ((await cnt(mid)) >= 1) lo = mid; else hi = mid - 1;
    }
    return lo;
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

  /* ---------- длительность курса из таблицы (для калькулятора) ---------- */
  //
  // Читаем публичную gviz-CSV таблицу «длительность программ» и по названию курса
  // (из амо) находим строку → отдаём академ.часы (B) и срок в днях (C).
  // Матч: точное совпадение → пересечение слов с учётом тарифа (ПРО/Мастер/Базовый…).
  // Ничего не роняем: не нашли / таблица недоступна — куратор впишет вручную.

  function parseCsvRows(text) {
    const rows = [];
    let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') { q = true; }
      else if (ch === ',') { row.push(cur); cur = ''; }
      else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (ch !== '\r') { cur += ch; }
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  // нормализация: нижний регистр, ё→е, только буквы/цифры; отдельно — фолд латиница↔кириллица
  // по безопасным «двойникам» (a c e o p x y), чтобы «1C» = «1С».
  const durBase = s => String(s || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ').trim();
  const DUR_FOLD = { a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у' };
  const durFold = s => s.replace(/[aceopxy]/g, c => DUR_FOLD[c]);
  // тариф курса одним словом (считаем ДО фолда — иначе «pro» ломается)
  function durTariff(base) {
    const t = ' ' + base + ' ';
    if (/ пр[оo] |pro/.test(t)) return 'pro';
    if (/ мастер |master/.test(t)) return 'master';
    if (/ премиум |premium/.test(t)) return 'premium';
    if (/ эксперт |expert/.test(t)) return 'expert';
    if (/ оптимальн/.test(t)) return 'opt';
    if (/ базов|начальн| старт |base|start/.test(t)) return 'base';
    return '';
  }
  const DUR_STOP = /^(про|рrо|мастер|master|премиум|premium|эксперт|expert|базовый|базовая|базовое|начальный|тариф|курс|для|при)$/;
  const durToks = fold => fold.split(' ').filter(w => w.length >= 3 && !DUR_STOP.test(w));

  // rows: [{name,hours,days}] — уже без шапки. Возвращает {hours,days,name,exact,dupes} | null.
  function pickDuration(courseName, rows) {
    const wantBase = durBase(courseName);
    if (!wantBase) return null;
    const wantTar = durTariff(wantBase);
    const wantFold = durFold(wantBase);
    const wantToks = durToks(wantFold);
    if (!wantToks.length) return null;
    let best = null, bestScore = 0;
    rows.forEach(r => {
      const nBase = durBase(r.name);
      if (!nBase) return;
      const nFold = durFold(nBase);
      let score;
      if (nFold === wantFold) {
        score = 1000;
      } else {
        const toks = nFold.split(' ').filter(Boolean);
        const common = wantToks.filter(w => toks.indexOf(w) !== -1);
        if (common.length < 2 && !(common.length === 1 && wantToks.length === 1)) return;
        score = common.length * 10;
        if (nFold.indexOf(wantFold) !== -1 || wantFold.indexOf(nFold) !== -1) score += 15;
        score += Math.round(common.length / Math.max(wantToks.length, toks.length) * 10);
        const nTar = durTariff(nBase);
        if (wantTar && nTar) score += (wantTar === nTar) ? 8 : -14;
        score -= Math.min(6, Math.abs(toks.length - wantToks.length));
      }
      if (score > bestScore) { bestScore = score; best = r; }
    });
    if (!best || bestScore < 14) return null;
    const bn = durFold(durBase(best.name));
    const dupes = rows.filter(r => durFold(durBase(r.name)) === bn).length;
    return { hours: String(best.hours || '').trim(), days: String(best.days || '').trim(),
      name: best.name, exact: bestScore >= 1000, dupes: dupes };
  }

  let _durRows = null;
  function fetchDurationRows() {
    if (_durRows) return Promise.resolve(_durRows);
    return gmFetchText(DURATION_CSV_URL + '&_cb=' + Date.now()).then(text => {
      if (looksLikeLoginPage(text)) throw new Error('нужен вход в Google');
      const rows = parseCsvRows(text).slice(1)
        .map(r => ({ name: (r[0] || '').trim(), hours: (r[1] || '').trim(), days: (r[2] || '').trim() }))
        .filter(r => r.name && (r.hours || r.days));
      if (!rows.length) throw new Error('таблица длительности пустая');
      _durRows = rows;
      return rows;
    });
  }
  function fetchCourseDuration(courseName) {
    return fetchDurationRows().then(rows => pickDuration(courseName, rows));
  }

  /* ---------- расчёт возврата прямо в мастере (вместо Google-калькулятора) ----------
     Формула калькулятора: Итого = Сумма − Сумма ÷ Дней курса × (дни от доступа до обращения)
                                    − Комиссия − CPL − Прочие расходы (15% от суммы).
     Предварительно комиссия = 3% от суммы. Окончательно — ставка по способу оплаты × ТОЧНАЯ сумма оплаты (от РГ). */
  const CPL_SHEET_ID = '1TGEuWE6o23MCo-zjhBHMaP1nG17eeyTXtU_-9Rv7-ac';   // «Месяц · CPL», строки идут подряд с января 2026
  const CPL_CSV_URL = 'https://docs.google.com/spreadsheets/d/' + CPL_SHEET_ID + '/gviz/tq?tqx=out:csv&gid=0';
  const CPL_BASE_YEAR = 2026;
  const CPL_FALLBACK = [3142, 3575, 3824, 3634, 3505, 3723, 3447, 3453, 3317];   // янв–сен 2026 (запас, если таблица недоступна)
  const MONTHS_RU = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  const OTHER_COSTS_PCT = 0.15;
  const PRELIM_COMM_PCT = 0.03;

  let _cplRows = null;
  function fetchCplRows() {
    if (_cplRows) return Promise.resolve(_cplRows);
    return gmFetchText(CPL_CSV_URL + '&_cb=' + Date.now()).then(text => {
      if (looksLikeLoginPage(text)) throw new Error('нужен вход в Google');
      const out = [];
      parseCsvRows(text).slice(1).forEach(r => {
        let s = String(r[1] || '').replace(/\s/g, '');
        if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
        const v = parseFloat(s.replace(',', '.'));
        if (isFinite(v) && v > 0) out.push(v);
      });
      if (!out.length) throw new Error('таблица CPL пустая');
      _cplRows = out;
      return out;
    });
  }
  // CPL за месяц покупки; если за него ещё не рассчитан — за предыдущий (последний известный).
  function cplForDate(d, rows) {
    if (!d || !rows || !rows.length) return null;
    let idx = (d.getFullYear() - CPL_BASE_YEAR) * 12 + d.getMonth();
    if (idx < 0) idx = 0;
    let fallback = false;
    if (idx > rows.length - 1) { idx = rows.length - 1; fallback = true; }
    const y = CPL_BASE_YEAR + Math.floor(idx / 12), m = idx % 12;
    return { cpl: rows[idx], label: MONTHS_RU[m] + ' ' + y, fallback: fallback };
  }

  // Ставки приёма платежей (таблица «Ставки эквайеров»: https://docs.google.com/spreadsheets/d/1NrZbQ1FIqmpsvWNRWSza6o-k2hRo5siK).
  // Если ставки в таблице поменяются — обновить здесь (или поправить ставку руками в поле «Ставка»).
  const PAY_RATES = (function () {
    const L = [];
    // проценты — только до сотой (2,806 → 2,81)
    const add = (g, name, rate, extra) => L.push(Object.assign({ g: g, name: name, rate: Math.round(rate * 10000) / 10000 }, extra || {}));
    [['Юкасса', [['СБП', 0.004], ['SberPay', 0.0183], ['Банковские карты', 0.0183], ['Кредит Сбер (через Юкассу)', 0.061]]],
     ['CloudPayments', [['T-Pay', 0.03], ['МИР Pay', 0.0366], ['Банковские карты', 0.0366], ['Рассрочка (без процентов)', 0], ['Рассрочка', 0.15006]]],
     ['Т-Банк', [['T-Pay', 0.011], ['AlfaPay и SberPay', 0.01342], ['Банковские карты', 0.01342], ['UnionPay', 0.038918], ['Банковские карты (зарубежные)', 0.038918], ['СБП', 0.004]]],
     ['ГПБ', [['Банковские карты', 0.01159], ['СБП', 0.0085], ['SberPay', 0.01159], ['T-Pay', 0.0095]]],
     ['Точка', [['Банковские карты', 0.01037], ['СБП', 0.0035]]],
     ['TipTop', [['Банковские карты', 0.035], ['GooglePay', 0.035], ['Apple Pay', 0.035], ['MasterPass', 0.035]]],
     ['Яндекс Сплит', [['Полная или частичная оплата', 0.02196]]],
     ['Сбер Кредит', [['Рассрочка Сбер / Сбер рассрочка (любой срок)', 0.02806]]],
     ['Т-Банк Долями', [['Рассрочка 6 недель', 0.08418], ['Рассрочка 3, 6, 10 мес', 0.069]]],
     ['Ванта', [['Рассрочка Ванта (комиссия — скидкой)', 0]]],
     ['Фреш Кредит', [['Фреш-кредит (комиссия — скидкой)', 0]]],
     ['Т-Банк Кредит', [['Рассрочка Т-банк / кредит (комиссия — скидкой)', 0]]],
     ['Всегда ДА', [['Рассрочка / кредит (комиссия — скидкой)', 0]]],
    ].forEach(p => p[1].forEach(m => add(p[0], m[0], m[1])));
    // Ресурс Развития: сначала комиссия БАНКА со всей суммы, потом комиссия БРОКЕРА с суммы, поступившей из банка
    // (10% если поступило до 50 000 ₽, 8% если от 50 000 ₽).
    const RR = [
      ['Альфа банк', 'Беларусь', 'Р:12=.105,18=.16,24=.22;К:6=.0483,12=.0873,24=.1548,36=.2176,48=.2741'],
      ['Поритет банк', 'Беларусь', 'Р:6=.075,9=.105,12=.12;К:12=.1004,18=.1421,24=.1813,36=.2525'],
      ['РРБ Банк', 'Беларусь', 'Р:6=.0677,9=.0919,12=.105;К:24=.1813,36=.2525'],
      ['СберБанк', 'Беларусь', 'К:6=.0497,9=.07,12=.0897,18=.1274,24=.1631,36=.2285,48=.2871,60=.3396'],
      ['Добрабыт', 'Беларусь', 'Р:12=.09,18=.12;К:6=.0558,12=.1004,18=.1421,24=.1813,36=.2525'],
      ['Банк БТА', 'Беларусь', 'К:12=.1004,18=.1421,24=.1813,36=.2525,48=.3153,60=.3709'],
      ['Решение', 'Беларусь', 'К:6=.0878,9=.107,12=.1262,24=.1966,36=.2592,48=.3158'],
      ['Статус', 'Беларусь', 'К:6=.047,12=.0863,18=.1241,24=.163,36=.2525'],
      ['МТБанк', 'Беларусь', 'Р:6=.048,9=.0677,12=.0868,18=.1234,24=.158,36=.2119,48=.2792,60=.3307'],
      ['БАПБ', 'Беларусь', 'К:6=.0451,12=.0815,18=.1162,24=.149,36=.2099'],
      ['Halyk', 'Казахстан', 'К:3=.1,6=.1,12=.1,24=.1,36=.1,48=.1,60=.1;Р:3=.1,6=.1,12=.13,24=.19'],
      ['Jusan', 'Казахстан', 'К:3=.11,6=.11,12=.11,24=.11,36=.11,48=.11,60=.11;Р:3=.15,6=.16,12=.17,24=.19'],
      ['Home', 'Казахстан', 'Р:3=.05,6=.08,12=.14,14=.14,18=.15,24=.15'],
      ['Евразийский', 'Казахстан', 'К:3=.06,6=.075,9=.1,12=.14'],
      ['Anobank', 'Узбекистан', 'Р:3=.075,6=.12,9=.17,12=.22,24=.27'],
      ['MBANK', 'Кыргызстан', 'Р:3=.05,6=.085,9=.115,12=.145,18=.21,24=.27'],
      ['BakaiBank', 'Кыргызстан', 'Р:3=.04,6=.07,9=.09,12=.13,18=.17,24=.22'],
      ['Оптима банк', 'Кыргызстан', 'Р:3=.045,6=.07,9=.1,12=.13'],
    ];
    RR.forEach(b => b[2].split(';').forEach(grp => {
      const kind = grp.charAt(0) === 'К' ? 'Кредит' : 'Рассрочка';
      grp.slice(2).split(',').forEach(t => {
        const kv = t.split('=');
        add('Ресурс Развития', b[0] + ' (' + b[1] + ') · ' + kind + ' ' + kv[0] + ' мес', parseFloat(kv[1]), { rr: true });
      });
    }));
    L.forEach(x => {
      const pct = (x.rate * 100).toFixed(2).replace('.', ',');
      x.label = x.g + ' · ' + x.name + ' — ' + pct + '%' + (x.rr ? ' банк + брокер' : '');
    });
    return L;
  })();
  const rrBrokerPct = received => (received < 50000 ? 0.10 : 0.08);

  // Таблица «Заявления на возврат» (тип оплаты → нужно ли заявление). Публичная, gviz-CSV.
  // Столбцы: A Тип оплаты | B Рассрочка/Полная | C Нужно заявление? | D Комментарий | E Файл с заявлением.
  const PAYTYPE_SHEET_ID = '1_teJgVR7pcCIqgFKLvdXxLDvur7r74c_MlK4daY_-Ng';
  const PAYTYPE_CSV_URL = 'https://docs.google.com/spreadsheets/d/' + PAYTYPE_SHEET_ID +
    '/gviz/tq?tqx=out:csv&gid=0';
  let _payTypeRows = null;
  function fetchPayTypeRows() {
    if (_payTypeRows) return Promise.resolve(_payTypeRows);
    return gmFetchText(PAYTYPE_CSV_URL + '&_cb=' + Date.now()).then(text => {
      if (looksLikeLoginPage(text)) throw new Error('нужен вход в Google');
      const rows = parseCsvRows(text).slice(1)
        .map(r => ({
          type: (r[0] || '').trim(), kind: (r[1] || '').trim(), zayav: (r[2] || '').trim(),
          comment: (r[3] || '').trim(), file: (r[4] || '').trim(),
        }))
        .filter(r => r.type);
      if (!rows.length) throw new Error('таблица типов оплаты пустая');
      _payTypeRows = rows;
      return rows;
    });
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
      if (!out.course && /продукт для шаблон/.test(n)) out.course = stripMark(vals[0]);
      else if (!out.course && /категор/.test(n) && !/старая/.test(n)) out.course = stripMark(vals[0]);
      if (!out.cluster && n === 'кластер') out.cluster = vals[0];
    });
    if (!out.cluster) {
      (((lead || {}).custom_fields_values) || []).forEach(f => {
        const n = (f.field_name || '').toLowerCase().trim();
        if (!out.cluster && /^кластер$/.test(n)) out.cluster = (fieldValues(f)[0] || '');
      });
    }
    if (!out.course) out.course = stripMark(String((lead && lead.name) || ''));
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
  let _pctDebug = '';   // как мастер нашёл процент — показывается в отчёте «ⓘ»
  async function fetchProgressPct(courseName, seedEmail, seedPhone) {
    _pctDebug = '';
    const raw = omniCardField(7302) || '';
    const userIds = (raw.match(/\/admin\/users\/(\d+)/g) || []).map(m => m.match(/(\d+)/)[1]);
    const superIds = (raw.match(/\/admin\/super_users\/(\d+)/g) || []).map(m => m.match(/(\d+)/)[1]);
    if (!userIds.length && !superIds.length) return '';
    const A = 'https://www.eduson.tv';
    const digits = s => String(s || '').replace(/\D/g, '').slice(-10);
    const wantPhone = digits(seedPhone), wantEmail = String(seedEmail || '').toLowerCase().trim();
    const lc = s => String(s || '').toLowerCase().replace(/ё/g, 'е');
    // Совпадение названий курсов: какая ДОЛЯ значимых слов названия из амо есть в названии на платформе
    // (слова сравниваем по первым 5 буквам — переживает склонения). Раньше хватало одного общего слова,
    // и «Графический дизайнер» путался с «Веб-дизайнером» (общее слово «дизайнер»).
    const STOPW = { курс: 1, курсы: 1, профессия: 1, обучение: 1, программа: 1, специалист: 1, с_нуля: 1 };
    const wordsOf = s => lc(s).replace(/тариф.*$/, '').replace(/\([^)]*\)/g, ' ').split(/[^a-zа-я0-9]+/).filter(w => w.length >= 4 && !STOPW[w]);   // «тариф Базовый» — не часть названия курса
    const courseScore = (a, b) => {
      const wa = wordsOf(a); if (!wa.length) return 0;
      const sb = new Set(wordsOf(b).map(w => w.slice(0, 5)));
      return wa.filter(w => sb.has(w.slice(0, 5))).length / wa.length;
    };
    const SURE = 0.75;   // «уверенное» совпадение; между 0 и этим — спорно, процент лучше не показывать, чем показать чужой

    let ids = userIds.slice(0, 3), lockedUid = '';
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
        let picked = null, bestSc = 0;
        if (iC >= 0 && courseName) {
          rows.forEach(tr => { const sc = courseScore(courseName, cells(tr)[iC]); if (sc > bestSc) { bestSc = sc; picked = tr; } });
          if (bestSc < SURE) picked = null;
        }
        // курс называется похоже, но не так же (0 < совпадение < 75%) и строк несколько — не гадаем
        if (!picked && bestSc > 0 && rows.length > 1) continue;
        if (!picked) picked = rows.find(tr => { const c = cells(tr); return (wantEmail && iE >= 0 && (c[iE] || '').toLowerCase() === wantEmail) || (wantPhone && iP >= 0 && digits(c[iP]) === wantPhone); });
        if (!picked) picked = rows[0];
        const u = picked && uidOf(picked);
        if (u && ids.indexOf(u) === -1) ids.unshift(u);
        // курс нашёлся уверенно (по названию) — смотрим ТОЛЬКО этого студента-суба, не перескакиваем на соседние
        if (u && bestSc >= SURE) { lockedUid = u; break; }
      } catch (e) { if (e.message === 'NOAUTH') return ''; }
    }
    if (lockedUid) { ids = [lockedUid]; _pctDebug = 'курс найден в таблице суб-юзеров (аккаунт ' + lockedUid + ')'; }
    else _pctDebug = 'аккаунт выбран не по названию курса';

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
        let planUrl = '', sureCard = false;
        if (cards.length) {
          let card = null, cardBest = 0;
          if (courseName) cards.forEach(c => { const sc = courseScore(courseName, c.textContent); if (sc > cardBest) { cardBest = sc; card = c; } });
          if (cardBest < SURE) card = null;
          sureCard = !!card;
          // название похоже лишь частично («дизайнер» у двух разных курсов) — не гадаем, пропускаем этого студента
          if (!card && cardBest > 0 && multi) continue;
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
        // запасной разбор текста страницы — только если курс выбран не уверенно (иначе легко поймать чужой процент)
        if (!m && !sureCard) m = planHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').match(/(\d{1,3})\s*%\s+\d+\s+курс/i);
        if (m) { _pctDebug += '; процент из плана курса' + (sureCard ? ' (карточка по названию)' : ''); return String(Math.min(100, Math.max(0, +m[1]))); }
        // Курс найден уверенно, страница плана открылась, а процента на ней нет — у курса ещё нет прогресса: 0%.
        // Общий процент со страницы статистики здесь брать НЕЛЬЗЯ: он считается по всем курсам студента и даёт чужое число.
        if (sureCard && planHtml.length > 2000) { _pctDebug += '; на странице плана процента нет — считаю 0'; return '0'; }
        // иначе (курс один или не определён) — общий со страницы статистики, но не когда у студента несколько курсов
        if (!multi) {
          const ov = readScale(sdoc);
          if (ov !== '') { _pctDebug += '; общий процент со страницы статистики'; return ov; }
        }
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
    // «мягкие» кнопки: светло-фиолетовые, яркими становятся только при наведении и нажатии (см. стиль rm-soft-style)
    if (tag === 'button' && styles && styles.indexOf('/*soft*/') >= 0) e.className = 'rm-soft';
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // Гамма панели — через CSS-переменные на корне панели, меняется по сценарию (см. THEMES).
  // Стандартная (голубая) — «Больше 3 дней» и пока сценарий не определён.
  // Кнопки и блоки — сильно закруглённые; шрифт — округлый (Nunito с фолбэком).
  const ACC = 'var(--rm-acc)', ACC_DK = 'var(--rm-acc-dk)', ACC_LT = 'var(--rm-acc-lt)', ACC_BD = 'var(--rm-acc-bd)';
  const ACC_FG = 'var(--rm-acc-fg,#fff)';  // текст поверх акцента (на кнопках/шапке) — обычно белый, для светлых тем тёмный
  const C_AUTO = '#9CA3AF', C_MAN = ACC;
  // Оформление панели единое (фиолетовый акцент, белый фон); цвет СЦЕНАРИЯ показывает только бейдж в шапке.
  const THEME_DEFAULT = {
    '--rm-acc': '#EA580C', '--rm-acc-dk': '#9A3412', '--rm-acc-lt': '#FFEDD5',
    '--rm-acc-bd': '#FDBA74', '--rm-bg': '#FFFFFF', '--rm-card': '#FFFFFF', '--rm-acc-fg': '#FFFFFF',
  };
  const SC_DEFAULT = { '--rm-acc': '#0284C7', '--rm-acc-dk': '#075985', '--rm-acc-lt': '#E0F2FE' };
  const THEMES = {
    before: { '--rm-acc': '#6B7280', '--rm-acc-dk': '#374151', '--rm-acc-lt': '#F1F5F9', '--rm-acc-bd': '#CBD5E1', '--rm-bg': '#F4F4F5', '--rm-card': '#FFFFFF', '--rm-acc-fg': '#FFFFFF' },
    le3:    { '--rm-acc': '#EA580C', '--rm-acc-dk': '#9A3412', '--rm-acc-lt': '#FFEFE2', '--rm-acc-bd': '#FDBA74', '--rm-bg': '#FFF7ED', '--rm-card': '#FFFFFF', '--rm-acc-fg': '#FFFFFF' },
    resale: { '--rm-acc': '#7C3AED', '--rm-acc-dk': '#5B21B6', '--rm-acc-lt': '#F1EBFF', '--rm-acc-bd': '#C4B5FD', '--rm-bg': '#F5F3FF', '--rm-card': '#FFFFFF', '--rm-acc-fg': '#FFFFFF' },
    kids:   { '--rm-acc': '#FCE98B', '--rm-acc-dk': '#6B5610', '--rm-acc-lt': '#FEFBEA', '--rm-acc-bd': '#F3E39C', '--rm-bg': '#FFFDF3', '--rm-card': '#FFFFFF', '--rm-acc-fg': '#5E4C0E' },
  };
  const themeFor = s => THEMES[s] || SC_DEFAULT;
  const applyTheme = (elm, s) => {
    Object.keys(THEME_DEFAULT).forEach(k => elm.style.setProperty(k, THEME_DEFAULT[k]));
    const th = themeFor(s);   // цвет сценария — только для бейджа
    elm.style.setProperty('--rm-sc', th['--rm-acc']);
    elm.style.setProperty('--rm-sc-dk', th['--rm-acc-dk']);
    elm.style.setProperty('--rm-sc-lt', th['--rm-acc-lt']);
    elm.style.setProperty('--rm-sc-fg', th['--rm-acc-fg'] || '#FFFFFF');
  };
  const FONT = "system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif";
  const S = {
    box: 'position:fixed;z-index:2147483646;background:#fff;color:#1F2937;border-radius:16px;box-shadow:0 12px 36px rgba(15,23,42,.22);width:min(470px,96vw);max-width:96vw;max-height:94vh;min-width:300px;min-height:200px;display:flex;flex-direction:column;font-family:' + FONT + ';font-size:12.5px;border:1px solid #E5E7EB;overflow:hidden;',
    head: 'display:flex;justify-content:space-between;align-items:center;gap:6px;padding:10px 12px 8px 14px;background:#1F2937;color:#fff;border-bottom:1px solid #111827;border-radius:16px 16px 0 0;cursor:move;user-select:none;flex:0 0 auto;',
    title: 'font-size:13.5px;font-weight:700;white-space:nowrap;color:#fff;',
    hBtn: 'background:transparent;border:none;color:#D1D5DB;border-radius:8px;padding:2px 7px;font-size:12px;line-height:1.4;cursor:pointer;font-family:inherit;font-weight:500;',
    body: 'padding:0;overflow:hidden;flex:1 1 auto;min-height:0;display:flex;',
    grid: 'display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;margin-top:8px;',
    col: 'flex:1 1 300px;min-width:0;display:flex;flex-direction:column;',
    scen: 'font-size:11px;line-height:1.5;margin:0 0 7px;padding:9px 12px;border-radius:14px;background:' + ACC_LT + ';border:1px solid ' + ACC_BD + ';white-space:pre-wrap;color:' + ACC_DK + ';',
    // блоки — плоские секции с подчёркнутым заголовком (не карточки в рамках)
    block: 'margin-top:8px;background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:10px;',
    blockHdr: 'font-size:12.5px;font-weight:600;color:#1F2937;',
    grp: 'font-size:11px;font-weight:700;color:#6B7280;margin:10px 0 2px;',
    legend: 'font-size:11px;margin:2px 0 4px;line-height:1.5;',
    amoCard: 'margin-top:8px;background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:10px;',
    negBox: 'margin-top:8px;background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:10px;',
    fwrap: 'margin:0 0 6px;min-width:0;',
    lab: 'font-size:11px;color:#6B7280;font-weight:400;margin:0 0 2px;display:flex;justify-content:space-between;align-items:baseline;gap:6px;',
    tag: 'font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;flex:0 0 auto;',
    input: 'width:100%;box-sizing:border-box;border:1px solid #E5E7EB;border-radius:8px;padding:4px 9px;min-height:30px;font-size:12.5px;font-family:inherit;background:#F9FAFB;color:#1F2937;',
    btn: 'width:100%;box-sizing:border-box;background:#F97316;color:#fff;border:1px solid #F97316;border-radius:10px;padding:8px 12px;font-size:12.5px;font-weight:500;cursor:pointer;font-family:inherit;margin-top:7px;/*soft*/',
    btnAlt: 'width:100%;box-sizing:border-box;background:transparent;color:#1F2937;border:1px solid #E5E7EB;border-radius:10px;padding:8px 12px;font-size:12.5px;font-weight:500;cursor:pointer;font-family:inherit;margin-top:7px;',
    big: 'width:100%;box-sizing:border-box;background:#F97316;color:#fff;border:1px solid #F97316;border-radius:10px;padding:9px 12px;font-size:12.5px;font-weight:500;cursor:pointer;font-family:inherit;margin-top:7px;/*soft*/',
    small: 'width:100%;box-sizing:border-box;background:transparent;color:#4B5563;border:1px solid #E5E7EB;border-radius:8px;padding:6px 9px;font-size:11.5px;font-weight:500;cursor:pointer;font-family:inherit;margin-top:6px;',
    status: 'font-size:11.5px;margin-top:8px;line-height:1.45;white-space:pre-wrap;color:#6B7280;padding:7px 14px;',
    hint: 'font-size:11.5px;color:#6B7280;margin-top:8px;line-height:1.45;',
    warn: 'font-size:11px;color:#B45309;margin-top:3px;line-height:1.35;',
    err: 'font-size:11.5px;font-weight:500;color:#B91C1C;background:#FEF2F2;border:1px solid #FCA5A5;border-radius:8px;padding:8px 10px;margin-top:9px;line-height:1.4;',
    row: 'display:flex;gap:6px;',
  };

  // Карточки с цветными значками (макет «Г»): значок — набор тонких линейных иконок одного стиля
  const ICON_SVG = {
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/>',
    clip: '<rect x="6" y="5" width="12" height="16" rx="2"/><path d="M9 5V4h6v1M9 11h6M9 15h6"/>',
    calc: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M9 12h.01M12 12h.01M15 12h.01M9 16h.01M12 16h.01M15 16h.01"/>',
    send: '<path d="M21 3 10 14M21 3l-7 18-4-7-7-4z"/>',
    tasks: '<path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    chat: '<path d="M4 5h16v11H9l-5 4z"/>',
    plug: '<path d="M9 7V3M15 7V3M6 7h12v4a6 6 0 0 1-12 0zM12 17v4"/>',
    tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><path d="M8 8h.01"/>',
  };
  const mkIcon = (name, size) => {
    const s = size || 16;
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="display:block">' + (ICON_SVG[name] || ICON_SVG.clip) + '</svg>';
  };
  const BADGE = {
    blue:   'background:#FFEDD5;color:#C2410C;',
    green:  'background:#FFEDD5;color:#C2410C;',
    amber:  'background:#FFEDD5;color:#C2410C;',
    violet: 'background:#FFEDD5;color:#C2410C;',
    red:    'background:#FFEDD5;color:#C2410C;',
    gray:   'background:#FFEDD5;color:#C2410C;',
  };
  // значок и цвет подбираются по названию блока
  const CARD_LOOK = [
    [/Данные из амо|Карточка OmniDesk/, 'user', 'blue'],
    [/Анкета|Заметка/, 'clip', 'amber'],
    [/Итог переговоров/, 'chat', 'green'],
    [/Калькулятор/, 'calc', 'green'],
    [/РГ/, 'send', 'red'],
    [/Телеграм|продакту/, 'send', 'blue'],
    [/Тип оплаты/, 'file', 'amber'],
    [/Асаны/, 'tasks', 'violet'],
    [/Блокировка/, 'lock', 'red'],
    [/таблиц/, 'file', 'gray'],
    [/Метка/, 'tag', 'gray'],
    [/Шаблон/, 'chat', 'gray'],
  ];
  const cardHdr = (titleText) => {
    const look = (CARD_LOOK.find(r => r[0].test(titleText)) || [null, 'clip', 'gray']);
    const h = el('div', 'display:flex;align-items:center;gap:8px;margin-bottom:8px;min-width:0;');
    const ic = el('span', 'width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex:0 0 auto;' + BADGE[look[2]]);
    ic.innerHTML = mkIcon(look[1], 16);
    h.appendChild(ic);
    h.titleEl = el('span', 'font-size:12.5px;font-weight:600;color:#1F2937;min-width:0;', titleText);
    h.appendChild(h.titleEl);
    return h;
  };
  // Делает блок-карточку сворачиваемой: всё, что кладёшь в возвращённый body, прячется по клику на заголовок.
  const makeCollapsible = (block, open, onOpen) => {
    const hdr = block.firstElementChild;
    const body = el('div', open ? '' : 'display:none;');
    block.appendChild(body);
    const chev = el('span', 'margin-left:auto;color:#9CA3AF;font-size:11px;flex:0 0 auto;', open ? '▴' : '▾');
    hdr.appendChild(chev);
    hdr.style.cursor = 'pointer';
    hdr.style.marginBottom = open ? '8px' : '0';
    hdr.onclick = () => {
      const o = body.style.display === 'none';
      body.style.display = o ? 'block' : 'none';
      chev.textContent = o ? '▴' : '▾';
      hdr.style.marginBottom = o ? '8px' : '0';
      if (o && onOpen) onOpen();
    };
    return body;
  };

  // Комбо-поле с поиском (как в Хэлпере, вкладка «Создать карточку»): печатаешь — фильтруется,
  // клик по стрелке/полю — весь список. rows: [{label, value}]. setRows() — подменить список позже.
  function combo(rows, ph, initial) {
    const wrap = el('div', 'position:relative;');
    const inp = el('input', S.input + 'padding-right:26px;font-weight:700;');
    inp.setAttribute('autocomplete', 'off');
    inp.placeholder = ph || '';
    if (initial != null) inp.value = initial;
    const caret = el('span', 'position:absolute;right:8px;top:8px;padding:3px;color:#9CA3AF;font-size:9px;cursor:pointer;', '▼');
    const menu = el('div', 'position:absolute;left:0;right:0;top:calc(100% + 2px);z-index:20;background:#fff;border:1px solid #D1D5DB;border-radius:9px;box-shadow:0 10px 28px rgba(15,23,42,.18);max-height:230px;overflow:auto;display:none;');
    wrap.appendChild(inp); wrap.appendChild(caret); wrap.appendChild(menu);
    let cb = null;
    const draw = (filter) => {
      menu.innerHTML = '';
      const f = String(filter || '').toLowerCase().replace(/ё/g, 'е');
      (rows || []).slice(0, 400).forEach(r => {
        const hay = (r.label + ' ' + (r.value || '')).toLowerCase().replace(/ё/g, 'е');
        if (f && hay.indexOf(f) === -1) return;
        const it = el('div', 'padding:7px 10px;font:600 11.5px ' + FONT + ';color:#111827;cursor:pointer;border-bottom:1px solid #F3F4F6;line-height:1.3;');
        if (r.parts) r.parts.forEach(p => it.appendChild(el('span', p.muted ? 'color:#9CA3AF;font-weight:600;' : '', p.text)));
        else it.textContent = r.label;
        it.onmouseenter = () => { it.style.background = '#F0F9FF'; };
        it.onmouseleave = () => { it.style.background = '#fff'; };
        it.onmousedown = (e) => {
          e.preventDefault();
          inp.value = r.value != null ? r.value : r.label;
          menu.style.display = 'none';
          if (cb) cb();
        };
        menu.appendChild(it);
      });
      menu.style.display = menu.children.length ? 'block' : 'none';
    };
    let justFocused = false;
    const openAll = () => draw('');
    inp.onfocus = () => { justFocused = true; inp.select(); openAll(); };
    inp.onmouseup = (e) => { if (justFocused) { e.preventDefault(); justFocused = false; } };
    inp.onclick = () => { if (menu.style.display === 'none') openAll(); };
    caret.onmousedown = (e) => {
      e.preventDefault();
      if (menu.style.display === 'none') { inp.focus(); openAll(); } else { menu.style.display = 'none'; }
    };
    inp.oninput = () => { justFocused = false; draw(inp.value); if (cb) cb(); };
    inp.onkeydown = (e) => { if (e.key === 'Escape') menu.style.display = 'none'; };
    inp.onblur = () => { setTimeout(() => { menu.style.display = 'none'; }, 150); };
    return {
      el: wrap, input: inp,
      get value() { return inp.value; },
      set value(v) { inp.value = v; },
      onPick: (fn) => { cb = fn; },
      setRows: (r) => { rows = r || []; },
    };
  }

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
    trackSend('Возврат-мастер');

    // стиль «мягких» кнопок (hover/нажатие нельзя задать в inline-стилях)
    try {
      if (!document.getElementById('rm-soft-style')) {
        const st = document.createElement('style');
        st.id = 'rm-soft-style';
        st.textContent = '.rm-soft{transition:background .12s,color .12s,border-color .12s}' +
          '.rm-soft:hover:not(:disabled),.rm-soft:active:not(:disabled){background:var(--rm-acc)!important;color:#fff!important;border-color:var(--rm-acc)!important}' +
          '.rm-soft:disabled{opacity:.55;cursor:default}';
        (document.head || document.documentElement).appendChild(st);
      }
    } catch (e) { /* ignore */ }
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
      name: '', status: pick('status', STATUSES[0]),   // новое обращение — всегда «по умолчанию», без «последнего выбора»
      claimDate: pick('claimDate', todayStr()), accessDate: '',
      progress: pick('progress', ''), cluster: '', course: '', payType: '',
      reason: pick('reason', REASONS[0]),
      amount: '', result: pick('result', 'В работе'),
      agreedSum: pick('agreedSum', ''), mop: '', mopFromNote: false,
      clientComment: pick('clientComment', ''),
      amoLink: '', omniLink: location.href.split('#')[0], purchaseDate: '',
      producer: '', rowNumber: pick('rowNumber', ''),
      sentRow: pick('sentRow', ''),   // строка, в которую мастер уже записал этот кейс (для «Обновить»)
      approveLink: pick('approveLink', ''),                 // ссылка на согласование в ТГ → в описание Асаны
      asanaUrl: pick('asanaUrl', ''), asanaGid: pick('asanaGid', ''), asanaDate: pick('asanaDate', ''),   // карточка Асаны этого кейса
      rgTag: pick('rgTag', ''),
      deals: [], dealId: pick('dealId', ''),
      calcHours: pick('calcHours', ''), calcDays: pick('calcDays', ''),
      calcCpl: pick('calcCpl', ''), calcCplTouched: !!cs.calcCplTouched,   // CPL: сам по месяцу покупки, пока куратор не поправил
      calcPay: pick('calcPay', ''), calcPayTouched: !!cs.calcPayTouched, calcPaid: pick('calcPaid', ''), calcRate: pick('calcRate', ''),   // окончательный расчёт
      payTypeSel: pick('payTypeSel', ''),
      scenOverride: '',   // сценарий при каждом открытии — «авто»; ручной выбор не запоминаем
    };
    // калькулятор: если по кейсу уже сохранены ак.ч./дни — считаем, что куратор их проверил,
    // и не перетираем автоподстановкой из таблицы.
    T.calcDurTouched = !!(cs.calcHours || cs.calcDays);
    const inputs = {};
    const seedEmail = omniCardField(2) || grabSeedFromPage();
    const seedPhone = omniCardField(16);
    let saveT = 0;
    const saveCase = () => {
      clearTimeout(saveT);
      saveT = setTimeout(() => {
        const keep = {};
        ['curator', 'status', 'claimDate', 'progress', 'reason', 'clientComment', 'result', 'agreedSum', 'rowNumber', 'sentRow', 'approveLink', 'asanaUrl', 'asanaGid', 'asanaDate', 'rgTag', 'dealId', 'calcHours', 'calcDays', 'calcCpl', 'calcCplTouched', 'calcPay', 'calcPayTouched', 'calcPaid', 'calcRate', 'payTypeSel']
          .forEach(k => { keep[k] = T[k]; });
        try { GM_setValue(CASE_KEY, JSON.stringify(keep)); } catch (e) { /* ignore */ }
      }, 300);
    };

    panel = el('div', S.box);
    applyTheme(panel, '');   // стартовая палитра — стандартная; сменится в updateScenario

    const head = el('div', S.head);
    head.appendChild(el('div', S.title, 'Мастер'));
    const hBtns = el('div', 'display:flex;gap:4px;align-items:center;flex:0 0 auto;');
    const scenChip = el('span', 'background:var(--rm-sc-lt);color:var(--rm-sc-dk);border-radius:999px;padding:2px 10px;font-size:11px;font-weight:500;cursor:default;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:4px;', '…');
    hBtns.appendChild(scenChip);
    const bRefresh = el('button', S.hBtn, '↻ амо');
    bRefresh.title = 'Собрать данные из амо заново';
    const bInfo = el('button', S.hBtn, 'ⓘ');
    bInfo.title = 'Подробный отчёт по сбору данных из амо';
    const bCollapse = el('button', S.hBtn, '–');
    const bClose = el('button', S.hBtn, '✕');
    hBtns.appendChild(bRefresh); hBtns.appendChild(bInfo); hBtns.appendChild(bCollapse); hBtns.appendChild(bClose);
    head.appendChild(hBtns);
    panel.appendChild(head);

    const body = el('div', S.body);
    panel.appendChild(body);

    // scenarioBox и statusBox — на всю ширину, над двумя колонками.
    // Мягкая заливка фона по сценарию + акцентная полоска слева (как у блоков панели).
    const scenBox = el('div', 'margin:0 0 7px;');
    const scenarioBox = el('div', 'font-size:11.5px;line-height:1.5;margin:0;padding:8px 10px;border-radius:8px;' +
      'background:' + ACC_LT + ';white-space:pre-wrap;color:' + ACC_DK + ';');
    const scenName = el('div', 'display:none;', 'Определяю сценарий…');   // название сценария теперь только в плашке шапки
    // 1-я строка — счётчик дней; ниже кнопки в строку: документы по сценарию + «подробнее»; остальной текст — по «подробнее»
    const scenDays = el('div', 'font-size:12px;font-weight:600;color:' + ACC_DK + ';');
    const scenText = el('div', 'display:none;margin-top:6px;', '');
    const scenBtnStyle = 'background:#fff;border:1px solid ' + ACC_BD + ';color:' + ACC_DK + ';border-radius:8px;padding:4px 10px;font-size:11px;font-weight:500;cursor:pointer;font-family:inherit;';
    // «подробнее» — знак вопроса в круге (по клику раскрывается/сворачивается остальной текст сценария)
    const scenMoreOff = 'width:22px;height:22px;box-sizing:border-box;border-radius:50%;padding:0;background:#fff;border:1.5px solid ' + ACC_BD + ';color:' + ACC_DK + ';font-size:12px;font-weight:700;line-height:1;cursor:pointer;font-family:inherit;flex:0 0 auto;';
    const scenMore = el('button', scenMoreOff, '?');
    scenMore.title = 'Подробнее';
    let scenOpen = false;
    scenMore.onclick = () => {
      scenOpen = !scenOpen;
      scenText.style.display = scenOpen ? 'block' : 'none';
      scenMore.style.cssText = scenMoreOff + (scenOpen ? 'background:' + ACC_BD + ';' : '');
    };
    scenarioBox.appendChild(scenName);
    scenarioBox.appendChild(scenDays);
    // документы по сценарию: старая оферта — одна; новая оферта — оферта + политика возвратов (кнопки, открывают в новой вкладке)
    const scenLinks = el('div', 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px;');
    const setScenLinks = (list) => {
      scenLinks.innerHTML = '';
      list = list.concat([['Архив оферт', 'https://eduson.academy/archive']]);   // архив — во всех сценариях
      list.forEach(([t, u]) => {
        const b = el('button', scenBtnStyle, t);
        b.title = u;
        b.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); try { window.open(u, '_blank', 'noopener'); } catch (e) { GM_openInTab(u, { active: true }); } };
        scenLinks.appendChild(b);
      });
      scenLinks.appendChild(scenMore);
    };
    scenLinks.appendChild(scenMore);
    scenarioBox.appendChild(scenLinks);
    scenarioBox.appendChild(scenText);
    scenarioBox.style.padding = '8px 10px';
    const scenPick = el('select', S.input);
    scenPick.style.cssText += 'margin-top:5px;font-size:11px;font-weight:700;';
    SCEN_MANUAL.forEach(([v, t]) => { const o = el('option', null, t); o.value = v; scenPick.appendChild(o); });
    scenPick.value = T.scenOverride || '';
    scenPick.title = 'Обычно определяется сам. Здесь можно задать сценарий вручную.';
    scenBox.appendChild(scenarioBox);
    // выбор сценария вручную нужен редко — прячем в «запасной вариант» (⚙ внизу вкладки «Принять»)
    scenPick.addEventListener('change', () => { T.scenOverride = scenPick.value; saveCase(); updateScenario(); });
    // клик по плашке сценария в шапке → меню выбора сценария (то же, что «⚙ запасной вариант»)
    scenChip.style.cursor = 'pointer';
    scenChip.title = 'Нажми, чтобы выбрать сценарий вручную';
    scenChip.addEventListener('mousedown', ev => ev.stopPropagation());   // не начинать перетаскивание панели
    let scenMenu = null;
    const closeScenMenu = () => { if (scenMenu) { scenMenu.remove(); scenMenu = null; } document.removeEventListener('mousedown', onScenOut, true); document.removeEventListener('keydown', onScenKey, true); };
    const onScenOut = ev => { if (scenMenu && !scenMenu.contains(ev.target) && ev.target !== scenChip) closeScenMenu(); };
    const onScenKey = ev => { if (ev.key === 'Escape') closeScenMenu(); };
    scenChip.addEventListener('click', ev => {
      ev.stopPropagation();
      if (scenMenu) { closeScenMenu(); return; }
      const r = scenChip.getBoundingClientRect();
      scenMenu = el('div', 'position:fixed;z-index:2147483647;background:#fff;border:1px solid #E5E7EB;border-radius:12px;box-shadow:0 8px 24px rgba(15,23,42,.22);padding:4px;min-width:210px;font-family:' + FONT + ';font-size:12.5px;color:#1F2937;');
      scenMenu.style.top = (r.bottom + 6) + 'px';
      scenMenu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 230)) + 'px';
      const cur = T.scenOverride || '';
      SCEN_MANUAL.forEach(([v, t]) => {
        const it = el('div', 'padding:7px 10px;border-radius:8px;cursor:pointer;display:flex;justify-content:space-between;gap:10px;' + (v === cur ? 'font-weight:700;background:#F3F4F6;' : ''), t);
        if (v === cur) it.appendChild(el('span', 'color:#6D28D9;', '✓'));
        it.addEventListener('mouseenter', () => { it.style.background = '#F3F4F6'; });
        it.addEventListener('mouseleave', () => { it.style.background = v === cur ? '#F3F4F6' : ''; });
        it.addEventListener('click', () => {
          T.scenOverride = v; scenPick.value = v; saveCase(); updateScenario(); closeScenMenu();
        });
        scenMenu.appendChild(it);
      });
      document.body.appendChild(scenMenu);
      document.addEventListener('mousedown', onScenOut, true);
      document.addEventListener('keydown', onScenKey, true);
    });
    const statusBox = el('div', S.status, 'Собираю данные из амо…');
    statusBox.style.cssText += 'margin:0;border-top:1px solid #E5E7EB;flex:0 0 auto;max-height:64px;overflow:auto;';
    // пустая строка статуса не занимает места
    let statusCollapsed = false;
    // Нижняя строка состояния живёт только на вкладке «Данные». На остальных вкладках она молчит;
    // исключение — свежее предупреждение/ошибка (жёлтое или красное), оно покажется, пока не переключишь вкладку.
    let statusTab = 0, statusFresh = false;
    const syncStatusVis = () => {
      statusBox.style.display = (!statusCollapsed && statusBox.textContent.trim() && (statusTab === 0 || statusFresh)) ? 'block' : 'none';
    };
    try {
      new MutationObserver(() => {
        if (statusTab !== 0) {
          Promise.resolve().then(() => {   // цвет выставляется сразу после текста — смотрим после
            const m = /rgb\((\d+)/.exec(statusBox.style.color || '');
            statusFresh = !!(m && parseInt(m[1], 10) >= 170);
            syncStatusVis();
          });
        }
        syncStatusVis();
      }).observe(statusBox, { childList: true, characterData: true, subtree: true });
    } catch (e) { /* ignore */ }
    // Статус «коротко + подробности под спойлером»: сразу виден только итог, остальное — по «▸ подробнее».
    let statusDet = null;
    const setStatusSum = (head, det) => {
      statusBox.textContent = '';
      statusDet = null;
      statusBox.appendChild(document.createTextNode(head));
      if (!det) return;
      const d = document.createElement('div');
      d.style.cssText = 'display:none;margin-top:4px;';
      d.textContent = det; statusDet = d;
      const a = document.createElement('a');
      a.textContent = ' ▸ подробнее';
      a.style.cssText = 'cursor:pointer;text-decoration:underline;white-space:nowrap;';
      a.addEventListener('click', () => {
        const open = d.style.display === 'none';
        d.style.display = open ? 'block' : 'none';
        a.textContent = open ? ' ▾ свернуть' : ' ▸ подробнее';
      });
      statusBox.appendChild(a); statusBox.appendChild(d);
    };
    // дописать к текущему статусу: в подробности (если они есть), иначе просто в конец
    const statusAdd = (t) => {
      if (statusDet && statusDet.isConnected) statusDet.textContent += ' ' + t.trim();
      else statusBox.textContent += t;
    };
    // Полный отчёт по сбору из амо — прячется за кнопкой «ℹ️» в шапке.
    // Открывается над строкой статуса и закрывается: повторным нажатием на «ⓘ», крестиком или Esc.
    let lastAmoDetail = '';
    const infoBox = el('div', 'display:none;flex:0 0 auto;max-height:190px;overflow:auto;border-top:1px solid #E5E7EB;background:#F9FAFB;padding:8px 14px;font-size:11px;line-height:1.5;color:#374151;white-space:pre-wrap;');
    const infoClose = el('span', 'float:right;cursor:pointer;color:#6B7280;font-size:14px;line-height:1;padding:0 0 0 10px;', '✕');
    infoClose.title = 'Закрыть';
    const infoText = el('div', '', '');
    infoBox.appendChild(infoClose); infoBox.appendChild(infoText);
    const toggleInfo = (force) => {
      const open = force !== undefined ? force : infoBox.style.display === 'none';
      infoBox.style.display = open ? 'block' : 'none';
      if (open) infoText.textContent = lastAmoDetail || 'Отчёта пока нет — нажми «↻ амо».';
    };
    bInfo.onclick = () => toggleInfo();
    infoClose.onclick = () => toggleInfo(false);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && infoBox.isConnected && infoBox.style.display !== 'none') toggleInfo(false); });

    // Вкладки слева (по шагам работы): 1 Клиент · 2 Решение · 3 Согласование · 4 Асана.
    // Таблица возвратов — не вкладка, а закреплённая панель внизу (строку заводят и потом обновляют).
    // Вкладки по МЕСТУ, куда уходят данные: Данные · Расчёт · Сообщения (ТГ/РГ) · Асана · Записи (таблица, админка)
    const TAB_DEF = [['Данные'], ['Расчёт'], ['Шаблоны'], ['Сообщения'], ['Асана'], ['Доступ']];
    const tabHooks = {};   // действие при открытии вкладки (например, перерисовать «Асану»)
    const tabsWrap = el('div', 'display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0;');
    const tabRail = el('div', 'flex:0 0 auto;background:#fff;border-bottom:1px solid #E5E7EB;display:flex;gap:0;padding:0 4px;');
    const paneBox = el('div', 'flex:1 1 auto;min-width:0;overflow:auto;padding:10px 12px 12px;background:#F3F4F6;');
    const panes = TAB_DEF.map(() => el('div', 'display:none;'));
    const railBtns = [];
    const selectTab = (i) => {
      panes.forEach((p, k) => { p.style.display = k === i ? 'block' : 'none'; });
      railBtns.forEach((b, k) => {
        b.style.background = k === i ? '#fff' : 'transparent';
        b.style.color = k === i ? ACC : '#6B7280';
        b.style.borderBottomColor = k === i ? ACC : 'transparent';
        b.style.fontWeight = k === i ? '600' : '400';
      });
      try { GM_setValue('rm_tab', i); } catch (e) { /* ignore */ }
      statusTab = i; statusFresh = false; syncStatusVis();
      if (tabHooks[i]) tabHooks[i]();
    };
    TAB_DEF.forEach((t, i) => {
      const b = el('div', 'flex:1 1 0;min-width:0;cursor:pointer;text-align:center;padding:9px 2px 8px;font-size:12px;border-bottom:2.5px solid transparent;user-select:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;', t[0]);
      b.title = ['Данные: клиент, анкета, результат, сумма и строка в таблице возвратов',
        'Расчёт: калькулятор возврата',
        'Шаблоны: готовые ответы клиенту (новая и старая оферта)',
        'Сообщения: ТГ продакту и РГ',
        'Асана: тип оплаты и заявление, ссылка на согласование, файлы, карточка возврата',
        'Доступ: блокировка курса, метка в амо, карточка OmniDesk'][i];
      b.onclick = () => selectTab(i);
      railBtns.push(b); tabRail.appendChild(b);
    });
    panes.forEach(p => paneBox.appendChild(p));
    tabsWrap.appendChild(tabRail); tabsWrap.appendChild(paneBox);
    body.appendChild(tabsWrap);
    const colL = panes[0], calcPane = panes[1], tplPane = panes[2], msgPane = panes[3], asanaPane = panes[4], recPane = panes[5];   // recPane = вкладка «Доступ»
    // если калькулятор по сценарию не нужен — на вкладке «Расчёт» это написано, а не пусто
    const calcNoEl = el('div', 'font-size:12px;color:#6B7280;line-height:1.5;padding:6px 2px;', 'Для этого обращения калькулятор не нужен: он нужен при возврате по новой оферте (покупка после 05.06) — больше 3 дней или в течение 3 дней.');
    calcPane.appendChild(calcNoEl);
    // подпись этапа в начале каждой вкладки
    const stepNote = (pane, text, mt) => { const n = el('div', 'font-size:11.5px;color:' + ACC_DK + ';background:' + ACC_LT + ';border-radius:8px;padding:6px 9px;margin:' + (mt || 0) + 'px 0 10px;line-height:1.4;', text); pane.appendChild(n); };
    colL.appendChild(scenBox);

    // «Таблица возвратов» — не закреплена: карточка с кнопкой «Отправить/Обновить» стоит на вкладке «Клиент»
    // (первая запись) и на вкладке «Асана» (обновить строку после создания карточки). Запасной вариант
    // (строка вручную, копирование) — спрятан в карточке на «Клиенте».
    const dockMore = el('div', 'display:none;');
    const dockToggle = el('button', 'background:none;border:none;color:#6B7280;font-size:11px;font-weight:500;cursor:pointer;padding:0;font-family:inherit;text-decoration:underline;', '⚙ вручную ▾');
    dockToggle.onclick = () => {
      const v = dockMore.style.display === 'none';
      dockMore.style.display = v ? 'block' : 'none';
      dockToggle.textContent = '⚙ вручную ' + (v ? '▴' : '▾');
    };
    dockMore.appendChild(el('div', S.lab + 'margin-top:8px;', 'Сценарий (обычно определяется сам, здесь можно задать вручную)'));
    dockMore.appendChild(scenPick);
    scenPick.style.marginTop = '0';
    panel.appendChild(infoBox);
    panel.appendChild(statusBox);
    selectTab(0);   // мастер всегда открывается на вкладке «Данные»

    // блок-«карточка» с заголовком; accent=true → сиреневая полоска слева
    const mkBlock = (parent, titleText, accent) => {
      const b = el('div', S.block);   // accent больше не рисуем полоской: оформление плоское
      if (titleText) b.appendChild(cardHdr(titleText));
      parent.appendChild(b);
      return b;
    };

    const mkField = (parent, key, label, kind, opts) => {
      opts = opts || {};
      const wrap = el('div', S.fwrap);
      const lab = el('div', S.lab);
      lab.appendChild(el('span', 'flex:1 1 auto;' + (opts.danger ? 'color:#B4605A;font-weight:500;' : ''), label));
      // тег «из амо» показываем только у предзаполненных полей; «впиши» убрали совсем
      if (kind === 'auto' && !opts.noTag) {
        const pl = el('span', 'flex:0 0 auto;color:' + C_AUTO + ';cursor:help;');
        pl.innerHTML = mkIcon('plug', 12);
        pl.title = 'Подставлено из амо';
        lab.appendChild(pl);
      }
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
        if (opts.area) field.style.height = '38px';
        if (opts.ph) field.placeholder = opts.ph;
        field.value = T[key];
        field.addEventListener('input', () => { T[key] = field.value; saveCase(); if (opts.onChange) opts.onChange(); });
      }
      if (opts.danger) field.style.cssText += ';border-color:#E3B9B5;';
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
    // Для таблицы (столбец O): «0» при «Остаётся», пусто при «В работе», иначе число.
    const agreed = () => T.result === 'Остается' ? '0' : (T.result === 'В работе' ? '' : agreedRaw());
    // Для сообщений и Асаны: «15000 ₽» / «0» / пусто.
    const agreedTxt = () => {
      if (T.result === 'Остается') return '0';
      if (T.result === 'В работе') return '';
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
    // Блеклая подпись «✓ скопировано» рядом с кнопкой, откуда копировали.
    let copyHintEl = null, copyHintT = 0;
    const flashCopied = (text, bad) => {
      try {
        const btn = document.activeElement;
        const r = (btn && btn.tagName === 'BUTTON' && panel && panel.contains(btn)) ? btn.getBoundingClientRect() : null;
        if (!copyHintEl) {
          copyHintEl = el('div', 'position:fixed;z-index:2147483647;font:700 10.5px ' + FONT + ';pointer-events:none;' +
            'padding:2px 8px;border-radius:8px;background:#fff;box-shadow:0 2px 8px rgba(15,23,42,.14);transition:opacity .25s;opacity:0;');
          document.documentElement.appendChild(copyHintEl);
        }
        copyHintEl.textContent = text;
        copyHintEl.style.color = bad ? '#DC2626' : '#9CA3AF';
        if (r) {
          copyHintEl.style.left = Math.round(Math.max(4, r.left + r.width / 2 - 45)) + 'px';
          copyHintEl.style.top = Math.round(r.bottom + 4) + 'px';
        } else {
          copyHintEl.style.left = '50%'; copyHintEl.style.top = '16px';
        }
        copyHintEl.style.opacity = '1';
        clearTimeout(copyHintT);
        copyHintT = setTimeout(() => { if (copyHintEl) copyHintEl.style.opacity = '0'; }, 1500);
      } catch (e) { /* не критично */ }
    };
    const copy = (text, msg, warn) => {
      try {
        GM_setClipboard(text); statusBox.textContent = msg; statusBox.style.color = warn ? '#B45309' : '#15803D';
        flashCopied('✓ скопировано');
      }
      catch (e) { statusBox.textContent = 'Не получилось скопировать 😕'; statusBox.style.color = '#DC2626'; flashCopied('не скопировалось', true); }
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
      flashCopied(ok ? '✓ скопировано' : 'не скопировалось', !ok);
    };

    /* ---- сценарий: текст + видимость блоков ---- */
    let tableBlock = null, calcBlock = null, rgBlock = null, tgBlock = null, tgHdr = null, rowLinkBtn = null, negBox = null, payTypeBlock = null;
    let sumWrap = null, errBox = null, tgRefreshHook = null, calcRecalc = null;
    const dateWarn = el('div', S.warn);
    const show = (elm, v) => { if (elm) elm.style.display = v ? 'block' : 'none'; };
    // При результате «Возврат» сумма обязательна: конкретное число больше нуля.
    const sumMissing = () => T.result === 'Возврат' && !(agreedNum() > 0);

    // Текущий сценарий кейса (пересчитывается в updateScenario). Пусто, пока не знаем дату.
    let curScen = '', _rkClusterApplied = '';
    const markScen = () => {
      const k = omniCardField(4660) || '';
      for (const mark in KURS_MARK) { if (k.indexOf(mark) !== -1) return KURS_MARK[mark]; }
      return '';
    };
    const isRK = () => curScen === 'resale' || curScen === 'kids';

    const updateScenario = () => {
      const p = parseRu(T.accessDate), c = parseRu(T.claimDate);
      const days = (p && c) ? Math.round((c - p) / 86400000) : null;
      const needSum = sumMissing();

      // 1) сценарий: ручной выбор → метка в OmniDesk → по датам
      let scen = T.scenOverride || markScen();
      if (!scen) {
        if (!p) scen = '';
        else if (p < CUTOFF_DATE) scen = 'before';
        else if (days != null && days <= 3) scen = 'le3';
        else if (days != null) scen = 'gt3';
        else scen = 'postUnknown';
      }
      curScen = scen;

      // 2) для ресейла/детских — кластер и продакт подставляются по сценарию (один раз;
      //    дальше куратор при желании может поправить вручную). «Пройдено = 0» ставим
      //    ТОЛЬКО когда амо ничего не дало — в refreshFromAmo, чтобы не мешать подтяжке из админки.
      if ((scen === 'resale' || scen === 'kids') && _rkClusterApplied !== scen) {
        _rkClusterApplied = scen;
        const wantCl = scen === 'resale' ? 'Ресейл' : 'Детские курсы';
        if (T.cluster !== wantCl) {
          T.cluster = wantCl;
          if (inputs.cluster && inputs.cluster._fill) inputs.cluster._fill(wantCl);
          T.producer = PRODUCERS[wantCl] || '';
          if (inputs.producer) inputs.producer.value = T.producer;
          renderAmoCard();
        }
      }
      if (scen !== 'resale' && scen !== 'kids') _rkClusterApplied = '';

      // Возврат в день покупки — нормально (c == p); ругаемся только если заявка РАНЬШЕ выдачи доступа.
      dateWarn.textContent = (p && c && c < p) ? '⚠️ Дата заявки раньше даты выдачи доступа — проверь даты.' : '';
      // поле «Согласованная сумма» видно только при результате «Возврат»
      if (sumWrap) sumWrap.style.display = (T.result === 'Возврат') ? 'block' : 'none';
      // при результате «Возврат» сумма подсвечена красным (внимание: это деньги), иначе обычное поле
      if (inputs.agreedSum) {
        const isRef = T.result === 'Возврат';
        inputs.agreedSum.style.borderColor = isRef ? '#EF4444' : '#E5E7EB';
        inputs.agreedSum.style.background = isRef ? '#FEF2F2' : '#F9FAFB';
        inputs.agreedSum.style.color = isRef ? '#B91C1C' : '#1F2937';
        inputs.agreedSum.style.fontWeight = isRef ? '700' : '400';
      }
      if (errBox && !needSum && T.result !== 'В работе') errBox.style.display = 'none';

      // 3) палитра всей панели по сценарию + плашка сценария (имя жирным + что делать)
      applyTheme(panel, scen === 'gt3' || scen === 'postUnknown' || !scen ? '' : scen);
      const meta = SCENARIOS[scen] || { name: '' };
      const nm = scen === 'postUnknown' ? 'После ' + OFFER_DATE_STR + ' — впиши дату заявки'
        : scen ? (meta.name || '—') : 'Сначала впиши дату выдачи доступа';
      scenName.textContent = '● ' + nm;
      scenChip.textContent = nm; scenChip.title = nm;

      const L = [];
      // 1-я строка — счётчик дней (во всех сценариях, когда обе даты есть) — отдельно над кнопками
      scenDays.textContent = days != null ? '⏱ ' + days + ' дн. с покупки до заявки' : '';
      scenDays.style.display = days != null ? 'block' : 'none';
      // 2-я строка — что делать
      if (scen === 'resale') L.push('→ Заполни строку в таблице возвратов (вкладка «Данные») и отправь «Сообщение в ТГ» (вкладка «Сообщения»).');
      else if (scen === 'kids') L.push('→ Заполни строку в таблице возвратов (вкладка «Данные») и отправь «Сообщение в ТГ» (вкладка «Сообщения»).');
      else if (scen === 'before') L.push('→ Старая оферта, калькулятор не нужен. Заполни строку в таблице возвратов (вкладка «Данные»).');
      else if (scen === 'le3') L.push('→ Возврат ≤ 3 дней: строка в таблице («Данные»), калькулятор («Расчёт»), «Сообщение РГ» («Сообщения»).');
      else if (scen === 'gt3') L.push('→ Заполни строку в таблице возвратов («Данные»), потом калькулятор («Расчёт»).');
      else if (scen === 'postUnknown') L.push('→ Куплено после ' + OFFER_DATE_STR + '. Впиши «Дата заявки на возврат» — покажу, ≤ 3 дней или больше.');
      else L.push('→ Впиши «Дата выдачи доступа» в блоке «Данные из амо».');
      // 3-я строка — длительность курса (из таблицы), как только подтянулась
      if (clean(T.calcDays) || clean(T.calcHours)) {
        L.push('📚 Курс по таблице: ' + (clean(T.calcHours) || '?') + ' ак.ч. · ' + (clean(T.calcDays) || '?') + ' дн. — сверь в калькуляторе');
      }
      if (T.result === 'В работе') L.push('⚠️ «В работе»: карточку Асаны можно скопировать только после решения «Возврат».');
      scenText.textContent = L.join('\n');
      if (scen === 'before') setScenLinks([['Старая оферта', 'https://eduson.academy/offer-old-25-02-2026']]);
      else if (scen === 'le3' || scen === 'gt3' || scen === 'postUnknown') setScenLinks([['Оферта', 'https://eduson.academy/offer'], ['Политика возвратов', 'https://eduson.academy/refund']]);
      else setScenLinks([]);

      show(rgBlock, scen === 'le3');
      show(payTypeBlock, T.result === 'Возврат');
      show(tableBlock, true);   // строка в таблице возвратов — нужна ВСЕГДА
      // калькулятор — для «после новой оферты» сценариев (в т.ч. выбранных вручную), не для ресейла/детских/старой оферты
      const calcOn = scen === 'gt3' || scen === 'le3' || scen === 'postUnknown';
      show(calcBlock, calcOn);
      if (calcNoEl) calcNoEl.style.display = calcOn ? 'none' : 'block';
      show(tgBlock, true);
      show(rowLinkBtn, true);
      if (tgHdr && tgHdr.titleEl) tgHdr.titleEl.textContent = (scen === 'resale' || scen === 'kids') ? 'Сообщение в ТГ' : 'Сообщение продакту в Телеграм';
      if (tgRefreshHook) tgRefreshHook();
      if (calcRecalc) calcRecalc();
    };
    const onDate = () => updateScenario();
    const syncAgreed = () => {
      if (T.result === 'Остается') { T.agreedSum = '0'; if (inputs.agreedSum) inputs.agreedSum.value = '0'; }
      // «Возврат»: по умолчанию сумма возврата = сумма оплаты из амо (можно поправить руками)
      if (T.result === 'Возврат' && !(agreedNum() > 0)) {
        const a = parseFloat(String(T.amount || '').replace(/[\s ]/g, '').replace(',', '.'));
        if (isFinite(a) && a > 0) {
          T.agreedSum = String(Math.round(a * 100) / 100);
          if (inputs.agreedSum) inputs.agreedSum.value = T.agreedSum;
          saveCase();
        }
      }
    };
    // Сменилась заявка/сумма в амо: «Сумма возврата» переезжает на новую сумму, но только если куратор её сам не менял
    // (т. е. она пустая или равна прежней сумме оплаты). Руками вписанное число не трогаем.
    const amtNum = v => parseFloat(String(v || '').replace(/[\s ]/g, '').replace(',', '.'));
    const followAmount = (prev) => {
      if (T.result !== 'Возврат') return;
      const cur = amtNum(T.agreedSum), was = amtNum(prev), now = amtNum(T.amount);
      if (!isFinite(now) || now <= 0) return;
      if (!(cur > 0) || (isFinite(was) && Math.abs(cur - was) < 0.005)) {
        T.agreedSum = String(Math.round(now * 100) / 100);
        if (inputs.agreedSum) inputs.agreedSum.value = T.agreedSum;
        saveCase();
      }
    };

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
    const bForm = mkBlock(colL, 'Анкета');
    // короткие поля — по два в ряд, чтобы панель не вытягивалась вниз
    const fRow1 = el('div', 'display:grid;grid-template-columns:1fr 1fr;gap:8px;');
    const fRow2 = el('div', 'display:grid;grid-template-columns:1fr 1fr;gap:8px;');
    const fRow3 = el('div', 'display:grid;grid-template-columns:1fr 1fr;gap:8px;');
    bForm.appendChild(fRow1);
    mkField(fRow1, 'curator', 'Куратор', 'man', { list: CURATORS, save: 'rm_curator' });
    mkField(fRow1, 'claimDate', 'Дата заявки', 'man', { ph: 'дд.мм.гггг', onChange: onDate });
    bForm.appendChild(dateWarn);
    bForm.appendChild(fRow2);
    mkField(fRow2, 'status', 'Статус', 'man', { list: STATUSES });
    // Результат (в работе / остаётся / возврат) — рядом со статусом; при «Возврат» ниже появляется строка с суммой
    mkField(fRow2, 'result', 'Результат', 'man', { list: RESULTS, onChange: () => {
      syncAgreed(); updateScenario(); if (tabHooks.asana) tabHooks.asana();
      // при «Возврате» статус в анкете сам становится «Делаем возврат»
      if (T.result === 'Возврат' && STATUSES.indexOf('Делаем возврат') >= 0 && T.status !== 'Делаем возврат') {
        T.status = 'Делаем возврат';
        if (inputs.status) { if (inputs.status._fill) inputs.status._fill(T.status); else inputs.status.value = T.status; }
        saveCase();
      }
    } });
    bForm.appendChild(fRow3);
    mkField(fRow3, 'progress', 'Пройдено, %', 'man', { ph: '15 или 0' });
    sumWrap = el('div', T.result === 'Возврат' ? '' : 'display:none;');
    const sumLab = el('div', S.lab, 'Сумма возврата, ₽');
    sumLab.title = 'Конкретная сумма, число больше нуля. Пустой при «Возврат» оставлять нельзя.';
    sumWrap.appendChild(sumLab);
    const sumInput = el('input', S.input);
    sumInput.style.cssText += 'font-weight:600;';
    sumInput.placeholder = 'число ₽';
    sumInput.value = T.agreedSum;
    sumInput.addEventListener('input', () => { T.agreedSum = sumInput.value; saveCase(); updateScenario(); });
    inputs.agreedSum = sumInput;
    sumWrap.appendChild(sumInput);
    fRow3.appendChild(sumWrap);
    mkField(bForm, 'reason', 'Причина возврата', 'man', { list: REASONS, danger: true });
    mkField(bForm, 'clientComment', 'Комментарий клиента (цитата)', 'man', { area: true, ph: 'Вставь текст клиента', danger: true });

    // 2) Данные из амо (сворачивается для правки)
    const amoCard = el('div', S.amoCard);
    const amoHdr = el('div', 'display:flex;justify-content:space-between;align-items:center;gap:6px;');
    const amoHdrTitle = cardHdr('Данные из амо');
    amoHdrTitle.style.marginBottom = '0';
    amoHdr.appendChild(amoHdrTitle);
    const bEdit = el('button', 'background:#F3F4F6;border:none;color:#4B5563;border-radius:999px;padding:3px 10px;font-size:10.5px;font-weight:500;cursor:pointer;font-family:inherit;flex:0 0 auto;', '✎ поправить');
    amoHdr.appendChild(bEdit);
    amoCard.appendChild(amoHdr);
    amoCard.appendChild(amoSummary);

    // Выбор курса — виден, только если у клиента несколько выигранных сделок.
    // Красный, крупный — часто это главный источник ошибок.
    // Свёрнут в одну строку-плашку (чтобы окно не растягивалось); выбор курса и апгрейд — под ней по клику.
    const dealPick = el('div', 'display:none;margin:8px 0 2px;background:#FFF7ED;border:1px solid #FED7AA;border-radius:10px;overflow:hidden;');
    const dealBar = el('div', 'display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;user-select:none;');
    const dealWarnIc = el('span', 'color:#EA580C;flex:0 0 auto;display:flex;');
    dealWarnIc.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4 3 20h18z"/><path d="M12 10v4M12 17h.01"/></svg>';
    dealBar.appendChild(dealWarnIc);
    const dealBarTxt = el('div', 'flex:1 1 auto;min-width:0;');
    dealBarTxt.appendChild(el('div', 'font-size:12px;font-weight:600;color:#9A3412;', 'В амо несколько заявок'));
    const dealSub = el('div', 'font-size:10.5px;color:#9A3412;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;', '');
    dealBarTxt.appendChild(dealSub);
    dealBar.appendChild(dealBarTxt);
    const dealChev = el('span', 'color:#EA580C;font-size:11px;flex:0 0 auto;', '▾');
    dealBar.appendChild(dealChev);
    dealPick.appendChild(dealBar);
    const dealBody = el('div', 'display:none;padding:0 10px 10px;');
    dealPick.appendChild(dealBody);
    const setDealOpen = (v) => { dealBody.style.display = v ? 'block' : 'none'; dealChev.textContent = v ? '▴' : '▾'; };
    dealBar.onclick = () => setDealOpen(dealBody.style.display === 'none');
    const dealHint = el('div', 'font-size:10.5px;color:#9A3412;margin-bottom:6px;line-height:1.45;white-space:pre-wrap;', '');
    dealBody.appendChild(dealHint);
    const dealSelect = el('select', S.input);
    dealSelect.style.cssText += 'background:#fff;font-size:12px;padding:6px 9px;border:1px solid #FDBA74;';
    dealBody.appendChild(dealSelect);
    const dealChecksHdr = el('div', 'font-size:10.5px;font-weight:600;color:#9A3412;margin:8px 0 3px;', 'Апгрейд: отметь заявки, которые объединить');
    dealBody.appendChild(dealChecksHdr);
    const dealChecks = el('div', 'display:flex;flex-direction:column;gap:4px;');
    dealBody.appendChild(dealChecks);
    const bSumDeals = el('button', S.small, 'Сложить суммы отмеченных заявок');
    bSumDeals.style.cssText += 'background:#fff;color:#9A3412;border:1px solid #FDBA74;font-weight:600;margin-top:7px;';
    dealBody.appendChild(bSumDeals);
    amoCard.appendChild(dealPick);

    const amoFields = el('div', 'display:none;margin-top:4px;');
    bEdit.onclick = () => {
      const open = amoFields.style.display === 'none';
      amoFields.style.display = open ? 'block' : 'none';
      amoSummary.style.display = open ? 'none' : 'block';
      bEdit.textContent = open ? '▲ свернуть' : '✎ поправить';
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
      const prevAmt = T.amount;
      setF('course', d.course); setF('payType', d.payType); setF('amount', d.amount); setF('cluster', d.cluster);
      followAmount(prevAmt);   // «Сумма возврата» идёт за суммой выбранной заявки (если её не меняли руками)
      if (d.purchaseDate) { T.accessDate = d.purchaseDate; if (inputs.accessDate) inputs.accessDate.value = d.purchaseDate; }
      T.amoLink = 'https://' + AMO_SUBDOMAIN + '.amocrm.ru/leads/detail/' + d.id;
      T.producer = PRODUCERS[T.cluster] || '';
      if (inputs.producer) inputs.producer.value = T.producer;
      _rkClusterApplied = ''; // курс/сделка сменились — заново кластер по сценарию
      renderAmoCard(); updateScenario();
      if (!opts.refetch) return;
      T.progress = ''; if (inputs.progress) inputs.progress.value = '';
      T.mop = ''; T.mopFromNote = false; if (inputs.mop) inputs.mop.value = '';
      renderAmoCard();
      loadCalcDuration(d.course, true); // курс сменился — заново ак.ч./дни для калькулятора
      statusBox.textContent = '';
      fetchDealExtras(d.id, d.course, seedEmail, seedPhone).then(x => {
        if (x.progress !== '') { T.progress = x.progress; if (inputs.progress) inputs.progress.value = x.progress; }
        if (x.mop) {
          T.mop = x.mop; T.mopFromNote = x.mopFromNote; if (inputs.mop) inputs.mop.value = x.mop;
          if (!clean(T.rgTag)) { const rg = rgByMop(x.mop); if (rg) { T.rgTag = rg; if (inputs.rgTag) inputs.rgTag.value = rg; } }
        }
        saveCase(); renderAmoCard();
        // всё нашлось — молчим; говорим, только если процент не нашёлся
        statusBox.textContent = x.progress !== '' ? '' : 'Процент прохождения не нашёлся: впиши руками.';
        statusBox.style.color = '#B45309';
      }).catch(() => {
        statusBox.textContent = '⚠️ Не подтянула % / МОП для нового курса — впиши руками.';
        statusBox.style.color = '#B45309';
      });
    };
    const dealAmt = d => parseInt(String((d && d.amount) || '').replace(/\D/g, ''), 10) || 0;
    // Грубая «база» названия курса — без слова «тариф …» и знаков, для сравнения «один курс или разные».
    const courseBase = s => String(s || '').toLowerCase().replace(/ё/g, 'е')
      .replace(/тариф.*$/, '').replace(/[^а-яa-z0-9]+/g, ' ').trim();
    // Какие заявки объединяем (апгрейд). По умолчанию отмечены заявки того же курса, что выбран
    // в списке (тарифы одного курса); куратор может отметить/снять любые. mergeTouched — если
    // куратор уже сам менял галочки, при смене курса в списке их не сбрасываем.
    let mergeIds = new Set(), mergeKey = '', mergeTouched = false;
    const mergeDefault = () => {
      const ds = T.deals || [];
      const main = ds.find(d => d.id === dealSelect.value) || ds[0];
      const base = main ? courseBase(main.course) : '';
      const same = base ? ds.filter(d => courseBase(d.course) === base) : [];
      return new Set(same.length >= 2 ? same.map(d => d.id) : []);
    };
    const mergeSelected = () => (T.deals || []).filter(d => mergeIds.has(d.id));
    const updateMergeBtn = () => {
      const sel = mergeSelected();
      const total = sel.reduce((a, d) => a + dealAmt(d), 0);
      bSumDeals.textContent = sel.length >= 2
        ? 'Объединить ' + sel.length + ' заявки: сумма ' + total.toLocaleString('ru-RU') + ' ₽'
        : 'Отметь минимум 2 заявки, чтобы объединить';
    };
    const renderDealChecks = () => {
      dealChecks.innerHTML = '';
      (T.deals || []).forEach(d => {
        const amt = dealAmt(d);
        const row = el('label', 'display:flex;align-items:flex-start;gap:7px;font-size:11px;font-weight:500;color:#111827;cursor:pointer;line-height:1.35;background:#fff;border:1px solid #FED7AA;border-radius:8px;padding:5px 8px;');
        const cb = el('input', 'margin:2px 0 0;flex:0 0 auto;cursor:pointer;');
        cb.type = 'checkbox';
        cb.checked = mergeIds.has(d.id);
        cb.addEventListener('change', () => {
          mergeTouched = true;
          if (cb.checked) mergeIds.add(d.id); else mergeIds.delete(d.id);
          updateMergeBtn();
        });
        row.appendChild(cb);
        row.appendChild(el('span', 'flex:1 1 auto;min-width:0;', (d.course || 'курс?') + '  ·  ' +
          (amt ? amt.toLocaleString('ru-RU') + ' ₽' : '—') + (d.purchaseDate ? '  ·  ' + d.purchaseDate : '')));
        dealChecks.appendChild(row);
      });
      updateMergeBtn();
    };
    const renderDealPick = () => {
      const ds = T.deals || [];
      if (ds.length < 2) { dealPick.style.display = 'none'; return; }
      dealPick.style.display = 'block';
      dealSelect.innerHTML = '';
      ds.forEach(d => {
        const amt = dealAmt(d);
        const label = (d.course || 'курс?') + '  ·  ' + (amt ? amt.toLocaleString('ru-RU') + ' ₽' : '—') +
          (d.purchaseDate ? '  ·  ' + d.purchaseDate : '');
        const o = el('option', null, label); o.value = d.id; dealSelect.appendChild(o);
      });
      dealSelect.value = ds.some(d => d.id === T.dealId) ? T.dealId : ds[0].id;
      const key = ds.map(d => d.id).join(',');
      if (key !== mergeKey) { mergeKey = key; mergeTouched = false; mergeIds = mergeDefault(); }
      renderDealChecks();
      const oneCourse = new Set(ds.map(d => courseBase(d.course)).filter(Boolean)).size <= 1;
      dealHint.style.color = '#9A3412';
      dealHint.textContent = oneCourse
        ? 'Похоже на апгрейд одного курса (докупка тарифа): заявки отмечены галочками. Проверь и нажми кнопку ниже, суммы сложатся.'
        : 'Курсы разные: выбери в списке курс, на который просят возврат. Если часть заявок это апгрейд одного курса, отметь их и объедини.';
      updateDealSub();
    };
    const updateDealSub = () => {
      const d = (T.deals || []).find(x => x.id === dealSelect.value);
      dealSub.textContent = (T.deals || []).length + ' шт. · выбрана: ' + ((d && d.course) || 'курс?');
    };
    dealSelect.addEventListener('change', () => {
      const d = (T.deals || []).find(x => x.id === dealSelect.value);
      if (!d) return;
      T.dealId = d.id; saveCase(); updateDealSub();
      if (!mergeTouched) { mergeIds = mergeDefault(); renderDealChecks(); }
      applyDeal(d, { refetch: true });
    });
    // Апгрейд: объединяем ОТМЕЧЕННЫЕ заявки — самая дорогая из них становится основным курсом,
    // «Сумма оплаты» = сумма отмеченных.
    bSumDeals.onclick = () => {
      const sel = mergeSelected();
      if (sel.length < 2) {
        dealHint.textContent = 'Отметь галочками минимум 2 заявки, которые нужно объединить.';
        dealHint.style.color = '#B91C1C';
        return;
      }
      const total = sel.reduce((a, d) => a + dealAmt(d), 0);
      const main = sel.slice().sort((a, b) => dealAmt(b) - dealAmt(a))[0];
      T.dealId = main.id; saveCase();
      dealSelect.value = main.id; updateDealSub();
      applyDeal(main, { refetch: true });
      const prevAmt = T.amount;
      T.amount = String(total);
      if (inputs.amount) inputs.amount.value = T.amount;
      followAmount(prevAmt);
      renderAmoCard(); saveCase();
      dealHint.textContent = 'Объединены ' + sel.length + ' заявки (' + sel.map(d => d.course || 'курс?').join(' + ') + ') = ' +
        total.toLocaleString('ru-RU') + ' ₽ → в «Сумму оплаты». Основной курс — «' + (main.course || '?') + '». Проверь курс и сумму.';
      dealHint.style.color = '#166534';
    };

    // 3) Строка в таблице возвратов
    tableBlock = mkBlock(el('div'), 'Строка в таблице возвратов');   // в колонку ставится ниже, под «Итогом переговоров»
    const rowNumWrap = el('div', 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;');
    rowNumWrap.appendChild(el('span', 'font-size:11px;color:#6B7280;flex:0 0 auto;', '№ строки'));
    const rowNumInput = el('input', S.input);
    rowNumInput.style.cssText += 'width:62px;flex:0 0 auto;font-size:13px;font-weight:600;text-align:center;padding:4px 6px;';
    rowNumInput.placeholder = '—';
    rowNumInput.title = 'Свободная строка внизу таблицы возвратов';
    rowNumInput.value = T.rowNumber;
    rowNumWrap.appendChild(rowNumInput);
    const bFindRow = el('button', S.small, 'найти');
    bFindRow.style.cssText += 'width:auto;flex:0 0 auto;margin-top:0;padding:6px 10px;white-space:nowrap;background:#fff;color:#374151;font-weight:500;';
    bFindRow.title = 'Посмотреть в гугл-таблице возвратов, какая строка внизу свободна';
    rowNumWrap.appendChild(bFindRow);
    // значок результата поиска: ✓ или ⚠; по клику показывает/прячет описание
    const rowFlag = el('button', 'display:none;flex:0 0 auto;background:none;border:none;cursor:pointer;padding:0 2px;font-size:15px;line-height:1;font-family:inherit;');
    rowFlag.style.marginLeft = 'auto';
    tableBlock.firstElementChild.appendChild(rowFlag);   // значок — справа в заголовке «Строка в таблице возвратов»
    const rowNote = el('div', 'flex:1 1 100%;font-size:10.5px;line-height:1.45;color:#6B7280;background:#F9FAFB;border-radius:8px;padding:6px 9px;');
    rowNote.style.display = 'none';
    rowFlag.onclick = () => { rowNote.style.display = rowNote.style.display === 'none' ? 'block' : 'none'; };
    const setRowNote = (kind, text) => {
      rowNote.style.display = 'none';
      if (kind === 'wait') { rowFlag.style.display = 'none'; return; }
      rowFlag.style.display = 'inline-block';
      rowFlag.textContent = kind === 'warn' ? '⚠' : '✓';
      rowFlag.style.color = kind === 'warn' ? '#B45309' : '#15803D';
      rowFlag.title = 'Нажми, чтобы ' + (kind === 'warn' ? 'прочитать, что не так' : 'увидеть подробности');
      rowNote.textContent = text;
    };
    tableBlock.appendChild(rowNumWrap);

    // Поиск свободной строки: заполняет поле и пишет короткую заметку рядом.
    // mode: 'click' — кнопкой; 'auto' — сам при открытии мастера (поле подсвечивается,
    // если поле уже было вписано и не совпало — заметка про это скажет, не потеряется).
    let rowFinding = false;
    const findRowInto = (mode) => {
      if (rowFinding) return;
      rowFinding = true;
      const had = String(T.rowNumber || '').trim();
      const prevTxt = bFindRow.textContent;
      bFindRow.textContent = '…'; bFindRow.disabled = true;
      setRowNote('wait');
      // авто-режим: если прогрев уже нашёл строку — берём оттуда, без ~28 запросов к таблице
      const warmRow = (mode === 'auto' && _rmWarm.caseId === rmCaseId() && _rmWarm.rowInfo
        && _rmWarm.ts && Date.now() - _rmWarm.ts < 600000) ? _rmWarm.rowInfo : null;
      (warmRow ? Promise.resolve(warmRow) : findNextFreeRow()).then(r => {
        if (r.next) {
          const changed = had && had !== String(r.next);
          T.rowNumber = String(r.next);
          rowNumInput.value = T.rowNumber;
          rowNumInput.style.background = '#FFF7ED'; // подсветка: значение подставлено автопоиском
          try { GM_setValue('rm_row', T.rowNumber); } catch (e) { /* ignore */ }
          saveCase(); updateRowLabels();
          setRowNote((r.strayBelow || changed) ? 'warn' : 'ok',
            'Свободная строка — ' + r.next + ' (плотный блок заканчивается на ' + r.lastData + ').' +
            (changed ? ' В поле было ' + had + ', заменила на автопоиск.' : '') +
            (r.strayBelow
              ? ' Но НИЖЕ блока есть ещё ' + r.strayBelow + ' заполненных строк(и): открой таблицу и глянь, не туда ли писать.'
              : ' Всё равно проверь глазами.'));
        } else {
          setRowNote('warn', 'Не смогла прочитать таблицу (' + r.error + '). Впиши № строки руками.');
        }
      }).catch(() => {
        setRowNote('warn', 'Не смогла прочитать таблицу. Впиши № строки руками.');
      }).then(() => {
        rowFinding = false; bFindRow.disabled = false; bFindRow.textContent = prevTxt;
      });
    };
    bFindRow.onclick = () => findRowInto('click');

    // Запись в таблицу вставкой из мастера убрана: строка копируется кнопкой и вставляется руками (Ctrl+V).
    let autoNoteFn = null, rowManual = false;
    const sendLabels = () => {};

    const bAll = el('button', S.big);
    bAll.style.cssText += 'width:auto;flex:1 1 auto;margin-top:0;padding:6px 10px;white-space:nowrap;';
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
    rowNumWrap.appendChild(bAll);
    rowNumWrap.appendChild(rowNote);   // описание ⚠/✓ раскрывается под строкой

    // Копирование по частям — спрятано за значком ✂ в заголовке блока (слева от ⚠/✓), по клику раскрывается список кнопок
    const moreBox = el('div', 'display:none;margin-top:6px;');
    const partsBtn = el('button', 'margin-left:auto;background:none;border:none;cursor:pointer;padding:0 3px;font-size:15px;line-height:1;color:#6B7280;font-family:inherit;', '✂');
    partsBtn.title = 'Копировать по частям, если что-то поехало';
    partsBtn.onclick = () => {
      const v = moreBox.style.display === 'none';
      moreBox.style.display = v ? 'block' : 'none';
      partsBtn.style.color = v ? '#EA580C' : '#6B7280';
    };
    tableBlock.firstElementChild.insertBefore(partsBtn, rowFlag);
    rowFlag.style.marginLeft = '6px';
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
    const tblLinks = el('div', 'display:flex;gap:6px;margin-top:6px;');
    tableBlock.appendChild(tblLinks);
    rowLinkBtn = el('button', S.btnAlt + 'flex:1 1 0;margin-top:0;font-size:11.5px;padding:6px 8px;', 'Ссылка на строку');
    rowLinkBtn.title = 'Скопировать ссылку на строку для заметки в OmniDesk';
    rowLinkBtn.onclick = () => {
      const n = parseInt(String(T.rowNumber).trim(), 10);
      if (!n) { statusBox.textContent = 'Сначала впиши № строки в блоке «Строка в таблице возвратов».'; statusBox.style.color = '#B45309'; return; }
      copy(SHEET_URL + '&range=' + n + ':' + n, 'Ссылка на строку ' + n + ' в буфере ✓ Вставь в заметку OmniDesk');
    };
    tblLinks.appendChild(rowLinkBtn);

    const openTableBtn = el('button', S.btnAlt + 'flex:1 1 0;margin-top:0;font-size:11.5px;padding:6px 8px;', 'Открыть таблицу');
    openTableBtn.onclick = () => { window.open(SHEET_URL, '_blank', 'noopener'); };
    tblLinks.appendChild(openTableBtn);

    // 5) Калькулятор — только если куплено после 05.06
    calcBlock = mkBlock(calcPane, 'Калькулятор возврата (куплено после 05.06)');
    calcBlock.style.display = 'none';
    const bCalcOpen = el('button', S.btnAlt, 'Открыть калькулятор');
    bCalcOpen.onclick = () => { try { window.open(CALC_URL, '_blank'); } catch (e) { copy(CALC_URL, 'Ссылка на калькулятор в буфере ✓'); } };
    calcBlock.appendChild(bCalcOpen);

    // Длительность курса (ак.ч. C6 + дней C7). ЯРКИЙ блок — авто-подбор часто не точный.
    const durWrap = el('div', 'margin:6px 0 2px;padding:8px 10px;background:#FFF7ED;border:1px solid #FED7AA;border-radius:10px;');
    durWrap.appendChild(el('div', 'font-size:11.5px;font-weight:800;color:' + ACC_DK + ';margin-bottom:8px;line-height:1.4;',
      'ПРОВЕРЬ длительность курса'));
    const durCombo = combo([], 'загружаю список курсов…', clean(T.course) || '');
    durCombo.el.style.marginBottom = '6px';
    durCombo.input.style.border = '1px solid #FED7AA';
    durWrap.appendChild(durCombo.el);
    const durRow = el('div', 'display:flex;gap:8px;');
    const mkDur = (key, label) => {
      const w = el('div', 'flex:1 1 0;min-width:0;');
      w.appendChild(el('div', 'font-size:10px;color:#374151;font-weight:700;margin-bottom:3px;', label));
      const inp = el('input', S.input);
      inp.style.cssText += 'text-align:center;font-weight:800;font-size:15px;padding:7px;';
      inp.placeholder = '—';
      inp.value = T[key] || '';
      inp.addEventListener('input', () => {
        T[key] = inp.value.replace(/[^\d]/g, ''); inp.value = T[key];
        T.calcDurTouched = true; inp.style.background = ''; saveCase(); updateScenario();
      });
      inputs[key] = inp;
      w.appendChild(inp);
      return w;
    };
    durRow.appendChild(mkDur('calcHours', 'Академ. часы (C6)'));
    durRow.appendChild(mkDur('calcDays', 'Срок, дней (C7)'));
    durWrap.appendChild(durRow);
    const durNote = el('div', 'font-size:10px;color:#6B7280;margin-top:6px;line-height:1.4;font-weight:600;', '');
    durWrap.appendChild(durNote);
    calcBlock.appendChild(durWrap);

    /* ---- расчёт прямо здесь: CPL → предварительный → окончательный ---- */
    const fmtRub = n => (Math.round(n * 100) / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';
    const fmtPct = r => (r * 100).toFixed(2).replace('.', ',') + '%';
    const numIn = v => { const n = parseFloat(String(v || '').replace(/[\s ]/g, '').replace(',', '.')); return isFinite(n) ? n : NaN; };
    const rcWrap = el('div', 'margin-top:8px;');
    calcBlock.appendChild(rcWrap);
    const rcLab = t => el('div', 'font-size:10px;color:#374151;font-weight:700;margin:6px 0 3px;', t);
    const rcLines = (card, rows) => {
      card.innerHTML = '';
      rows.forEach(r => {
        if (r.warn) { card.appendChild(el('div', 'font-size:11px;color:#B45309;font-weight:600;line-height:1.4;margin-top:2px;', r.warn)); return; }
        const line = el('div', 'display:flex;justify-content:space-between;gap:8px;font-size:11.5px;line-height:1.5;color:#374151;' +
          (r.total ? 'border-top:1px solid #E5E7EB;margin-top:4px;padding-top:4px;font-weight:800;font-size:13px;color:#111827;' : ''));
        line.appendChild(el('span', 'min-width:0;', r.l));
        line.appendChild(el('span', 'white-space:nowrap;font-variant-numeric:tabular-nums;', r.v));
        card.appendChild(line);
      });
    };
    const rcPush = (btn, total) => {
      if (!isFinite(total)) return;
      T.agreedSum = String(Math.round(Math.max(total, 0) * 100) / 100);
      if (inputs.agreedSum) inputs.agreedSum.value = T.agreedSum;
      saveCase(); updateScenario();
      const old = btn.textContent; btn.textContent = '✓ Подставлено в «Сумму возврата»';
      setTimeout(() => { btn.textContent = old; }, 2200);
    };

    // CPL
    rcWrap.appendChild(rcLab('CPL — стоимость привлечения клиента, ₽'));
    const cplInp = el('input', S.input);
    cplInp.placeholder = 'подставится по месяцу покупки';
    cplInp.value = T.calcCpl || '';
    cplInp.addEventListener('input', () => { T.calcCpl = cplInp.value; T.calcCplTouched = true; saveCase(); calcRecalc(); });
    rcWrap.appendChild(cplInp);
    const cplNote = el('div', 'font-size:10px;color:#6B7280;margin-top:3px;line-height:1.4;font-weight:600;', '');
    rcWrap.appendChild(cplNote);

    // предварительный
    const preCard = el('div', 'margin-top:8px;padding:8px 10px;background:#fff;border:1px solid #E5E7EB;border-radius:10px;');
    preCard.appendChild(el('div', 'font-size:11.5px;font-weight:800;color:' + ACC_DK + ';margin-bottom:4px;', 'Предварительный расчёт'));
    const preBody = el('div', ''); preCard.appendChild(preBody);
    const prePush = el('button', S.big + 'margin-top:6px;', 'Подставить в таблицу калькулятора');
    const preMsg = el('div', 'font-size:10.5px;line-height:1.4;font-weight:600;margin-top:4px;display:none;', '');
    preCard.appendChild(prePush); preCard.appendChild(preMsg);
    rcWrap.appendChild(preCard);

    // окончательный
    const finCard = el('div', 'margin-top:8px;padding:8px 10px;background:#fff;border:1px solid #E5E7EB;border-radius:10px;');
    finCard.appendChild(el('div', 'font-size:11.5px;font-weight:800;color:' + ACC_DK + ';margin-bottom:2px;', 'Окончательный расчёт'));
    finCard.appendChild(el('div', 'font-size:10px;color:#6B7280;line-height:1.4;font-weight:600;', 'Сначала уточни у РГ точный способ оплаты и точную сумму до копеек — в амо МОПы часто ошибаются.'));
    finCard.appendChild(rcLab('Способ оплаты'));
    const payCombo = combo(PAY_RATES.map(x => ({ label: x.label, value: x.label })), 'печатай: Юкасса, Сплит, Halyk…', T.calcPay || '');
    finCard.appendChild(payCombo.el);
    const fRow = el('div', 'display:flex;gap:8px;');
    const fW1 = el('div', 'flex:1 1 0;min-width:0;'), fW2 = el('div', 'flex:1 1 0;min-width:0;');
    fW1.appendChild(rcLab('Точная сумма оплаты, ₽'));
    const paidInp = el('input', S.input); paidInp.placeholder = 'от РГ'; paidInp.value = T.calcPaid || '';
    fW1.appendChild(paidInp);
    fW2.appendChild(rcLab('Ставка, %'));
    const rateInp = el('input', S.input); rateInp.placeholder = '—'; rateInp.value = T.calcRate || '';
    fW2.appendChild(rateInp);
    fRow.appendChild(fW1); fRow.appendChild(fW2);
    finCard.appendChild(fRow);
    const finBody = el('div', 'margin-top:6px;'); finCard.appendChild(finBody);
    const finPush = el('button', S.big + 'margin-top:6px;', 'Подставить в таблицу калькулятора');
    const finPushSum = el('button', S.big + 'margin-top:6px;', 'Подставить в «Сумму возврата»');
    const finMsg = el('div', 'font-size:10.5px;line-height:1.4;font-weight:600;margin-top:4px;display:none;', '');
    finCard.appendChild(finPush); finCard.appendChild(finPushSum); finCard.appendChild(finMsg);
    rcWrap.appendChild(finCard);
    // оба расчёта сворачиваются по клику на заголовок
    [preCard, finCard].forEach(card => {
      const hdr = card.firstChild, base = hdr.textContent;
      const content = el('div', '');
      while (hdr.nextSibling) content.appendChild(hdr.nextSibling);
      card.appendChild(content);
      hdr.style.cursor = 'pointer'; hdr.style.userSelect = 'none';
      const paint = open => { content.style.display = open ? 'block' : 'none'; hdr.textContent = base + (open ? ' ▴' : ' ▾'); hdr.style.marginBottom = open ? '4px' : '0'; };
      let open = true; paint(true);
      hdr.onclick = () => { open = !open; paint(open); };
    });

    const payItem = () => PAY_RATES.find(x => x.label === (T.calcPay || '').trim()) || null;
    const setPay = (it) => {
      T.calcPay = it.label; payCombo.value = it.label;
      T.calcRate = (it.rate * 100).toFixed(2).replace('.', ','); rateInp.value = T.calcRate;
    };
    payCombo.onPick(() => {
      T.calcPay = payCombo.value.trim(); T.calcPayTouched = true;
      const it = payItem();
      if (it) { T.calcRate = (it.rate * 100).toFixed(2).replace('.', ','); rateInp.value = T.calcRate; }
      saveCase(); calcRecalc();
    });
    // способ оплаты из амо («Форма оплаты») → сразу выбираем подходящий пункт (если однозначно)
    const PAYFORM_TO_GROUP = { 'Сбер рассрочка': 'Сбер Кредит', 'Рассрочка Т-банк': 'Т-Банк Кредит', 'Рассрочка Ванта': 'Ванта',
      'Фреш-кредит': 'Фреш Кредит', 'Яндекс Сплит': 'Яндекс Сплит' };
    paidInp.addEventListener('input', () => { T.calcPaid = paidInp.value; saveCase(); calcRecalc(); });
    rateInp.addEventListener('input', () => { T.calcRate = rateInp.value; saveCase(); calcRecalc(); });

    let cplRows = null, cplFailed = false, lastPre = NaN, lastFin = NaN, lastPreCol = null, lastFinCol = null;
    fetchCplRows().then(r => { cplRows = r; calcRecalc(); }).catch(() => { cplRows = CPL_FALLBACK; cplFailed = true; calcRecalc(); });

    calcRecalc = () => {
      const p = parseRu(T.accessDate), c = parseRu(T.claimDate);
      const used = (p && c) ? Math.round((c - p) / 86400000) : NaN;
      const D = numIn(T.calcDays), S0 = numIn(T.amount);

      // CPL по месяцу покупки (пока куратор сам не вписал)
      const ci = cplForDate(p, cplRows);
      if (ci && !T.calcCplTouched) { T.calcCpl = String(ci.cpl); cplInp.value = T.calcCpl; }
      if (ci) {
        cplNote.textContent = (T.calcCplTouched ? 'вписано вручную · ' : '') + 'по таблице: CPL за ' + ci.label + ' = ' + ci.cpl +
          (ci.fallback ? ' (за месяц покупки ещё не рассчитан — взят последний известный)' : '') + (cplFailed ? ' · таблица недоступна, запасные данные' : '');
      } else cplNote.textContent = p ? 'загружаю таблицу CPL…' : 'впиши дату выдачи доступа — подставлю CPL';
      const cpl = numIn(T.calcCpl);

      // способ оплаты по «Форме оплаты» из амо — пока куратор сам не выбирал
      if (!T.calcPay && !T.calcPayTouched && PAYFORM_TO_GROUP[T.payType]) {
        const it = PAY_RATES.find(x => x.g === PAYFORM_TO_GROUP[T.payType]);
        if (it) { setPay(it); saveCase(); }
      }

      // общая часть формулы
      const need = (paid) => {
        const miss = [];
        if (!(paid > 0)) miss.push('сумма оплаты');
        if (!(D > 0)) miss.push('срок курса, дней');
        if (!isFinite(used)) miss.push('даты доступа и заявки');
        if (!isFinite(cpl)) miss.push('CPL');
        return miss;
      };
      const rowsFor = (paid, commRows, comm) => {
        const usedCost = paid / D * used, other = paid * OTHER_COSTS_PCT;
        const total = paid - usedCost - comm - cpl - other;
        const rows = [
          { l: 'Оплачено', v: fmtRub(paid) },
          { l: '− за использованное время (' + used + ' из ' + D + ' дн.)', v: fmtRub(usedCost) },
        ].concat(commRows, [
          { l: '− CPL', v: fmtRub(cpl) },
          { l: '− прочие расходы 15%', v: fmtRub(other) },
          { l: 'Итого к возврату', v: fmtRub(total), total: true },
        ]);
        if (total < 0) rows.push({ warn: 'Получается меньше нуля — по формуле возвращать нечего. Проверь даты и срок курса.' });
        return { rows: rows, total: total };
      };

      // предварительный
      const miss1 = need(S0);
      const cn = v => (Math.round(v * 100) / 100).toString().replace('.', ',');
      const colOf = (paid, comm) => [cn(paid), clean(T.calcHours), clean(T.calcDays), clean(T.accessDate), clean(T.claimDate), comm, cn(cpl)];
      if (miss1.length) { rcLines(preBody, [{ warn: 'Не хватает: ' + miss1.join(', ') + '.' }]); lastPre = NaN; }
      else {
        const r = rowsFor(S0, [{ l: '− комиссия 3%', v: fmtRub(S0 * PRELIM_COMM_PCT) }], S0 * PRELIM_COMM_PCT);
        rcLines(preBody, r.rows); lastPre = r.total; lastPreCol = colOf(S0, '=C5*0,03');
      }
      prePush.disabled = !isFinite(lastPre);

      // окончательный
      const paid = numIn(T.calcPaid);
      const rate = Math.round(numIn(T.calcRate) * 100) / 10000;   // ставка — только до сотой доли процента
      const miss2 = need(paid);
      if (!isFinite(rate)) miss2.push('способ оплаты / ставка');
      if (miss2.length) { rcLines(finBody, [{ warn: 'Не хватает: ' + miss2.join(', ') + '.' }]); lastFin = NaN; }
      else {
        const it = payItem();
        let comm, commRows;
        if (it && it.rr) {
          const bank = paid * rate, recv = paid - bank, bp = rrBrokerPct(recv), brk = recv * bp;
          comm = bank + brk;
          commRows = [
            { l: '− комиссия банка ' + fmtPct(rate) + ' с ' + fmtRub(paid), v: fmtRub(bank) },
            { l: '− комиссия брокера ' + fmtPct(bp) + ' с поступивших ' + fmtRub(recv), v: fmtRub(brk) },
          ];
        } else {
          comm = paid * rate;
          commRows = [{ l: '− комиссия ' + fmtPct(rate) + ' с ' + fmtRub(paid), v: fmtRub(comm) }];
        }
        const r = rowsFor(paid, commRows, comm); rcLines(finBody, r.rows); lastFin = r.total; lastFinCol = colOf(paid, cn(comm));
      }
      finPush.disabled = !isFinite(lastFin);
      finPushSum.disabled = !isFinite(lastFin);
    };
    prePush.onclick = () => rcToSheet(prePush, preMsg, 'pre');
    finPush.onclick = () => rcToSheet(finPush, finMsg, 'fin');
    finPushSum.onclick = () => rcPush(finPushSum, lastFin);

    // Запись в Google-калькулятор: на листе куратора (лист называется по ФИО) — предв. C5:C11, оконч. C23:C29;
    // вставляет вкладка-«работник» (открывается сама), потом сверяет «Итого к возврату» (C14 / C32) с нашим расчётом.
    function rcToSheet(btn, msgEl, kind) {
      const col = kind === 'pre' ? lastPreCol : lastFinCol, total = kind === 'pre' ? lastPre : lastFin;
      if (!col || !isFinite(total)) return;
      const gid = CALC_SHEET_GIDS[T.curator];
      const say = (t, bad) => { msgEl.style.display = 'block'; msgEl.style.color = bad ? '#B45309' : '#15803D'; msgEl.textContent = t; };
      if (gid == null) { copy(col.join('\n'), 'Для куратора «' + T.curator + '» нет листа в калькуляторе — значения в буфере.'); say('⚠️ Нет листа калькулятора для «' + T.curator + '» — значения в буфере (Ctrl+V в «Оплаченная сумма»).', true); return; }
      btn.disabled = true; const old = btn.textContent; btn.textContent = 'Записываю в калькулятор…';
      say('Открываю калькулятор в фоне, это 5–20 секунд…', false);
      calcSheetSend({ gid: gid, cell: kind === 'pre' ? 'C5' : 'C23', text: col.join('\n'),
        expectCell: kind === 'pre' ? 'C14' : 'C32', expect: Math.round(total * 100) / 100 }).then(r => {
        btn.disabled = false; btn.textContent = old;
        if (r.ok) say('✓ Записано в лист «' + T.curator + '». Итого в таблице сошлось: ' + fmtRub(total), false);
        else { copy(col.join('\n'), 'Не вышло записать — значения в буфере.'); say('⚠️ ' + r.msg + ' Значения в буфере: вставь Ctrl+V в «Оплаченная сумма» вручную.', true); }
      });
    }
    calcRecalc();

    // Список курсов таблицы длительности → в комбо (один раз).
    let _durSelectFilled = false;
    const fillDurSelect = (selName) => {
      fetchDurationRows().then(rows => {
        if (!_durSelectFilled) {
          const seen = {};
          const opts = [];
          rows.forEach(r => {
            if (seen[r.name]) return; seen[r.name] = 1;
            opts.push({ label: r.name + '  —  ' + (r.hours || '?') + ' ак.ч., ' + (r.days || '?') + ' дн.', value: r.name });
          });
          durCombo.setRows(opts);
          durCombo.input.placeholder = 'печатай название курса…';
          _durSelectFilled = true;
        }
        // явное совпадение из таблицы — ставим; иначе, если поле пустое, показываем курс из амо
        const want = selName || (durCombo.value.trim() ? '' : (clean(T.course) || ''));
        if (want) durCombo.value = want;
      }).catch(() => { durCombo.input.placeholder = 'таблица недоступна — впиши ак.ч. и дни вручную'; });
    };
    const applyDurByName = (name) => {
      const r = (_durRows || []).find(x => x.name === name);
      if (!r) return false;
      T.calcHours = r.hours; T.calcDays = r.days; T.calcDurTouched = true;
      if (inputs.calcHours) { inputs.calcHours.value = r.hours; inputs.calcHours.style.background = '#FFFBF7'; }
      if (inputs.calcDays) { inputs.calcDays.value = r.days; inputs.calcDays.style.background = '#FFFBF7'; }
      durNote.style.color = '#15803D';
      durNote.textContent = '';
      saveCase(); updateScenario();
      return true;
    };
    // onPick срабатывает и при вводе, и при выборе из списка — применяем только точное совпадение.
    durCombo.onPick(() => { applyDurByName(durCombo.value.trim()); });
    fillDurSelect('');

    // Подтягиваем ак.ч./дни по названию курса. force=true — при смене курса (сбрасываем «проверено»).
    let calcDurLoading = false;
    const loadCalcDuration = (courseName, force) => {
      const c = String(courseName || T.course || '').trim();
      if (!c || calcDurLoading) return;
      if (force) T.calcDurTouched = false;
      if (T.calcDurTouched) { fillDurSelect(''); return; }
      calcDurLoading = true;
      durNote.style.color = '#92400E';
      durNote.textContent = 'Смотрю таблицу длительности курсов…';
      fetchCourseDuration(c).then(r => {
        if (r && (r.hours || r.days)) {
          if (!T.calcDurTouched) {
            T.calcHours = r.hours; T.calcDays = r.days;
            if (inputs.calcHours) { inputs.calcHours.value = r.hours; inputs.calcHours.style.background = '#FFFBF7'; }
            if (inputs.calcDays) { inputs.calcDays.value = r.days; inputs.calcDays.style.background = '#FFFBF7'; }
            saveCase();
          }
          fillDurSelect(r.name);
          durNote.style.color = r.exact ? '#15803D' : '#B45309';
          // подпись «по близости» убрана; остаётся только зелёное подтверждение точного совпадения и предупреждение о дублях
          durNote.textContent = r.dupes > 1 ? 'в таблице несколько строк с этим курсом — сверь!' : '';
        } else {
          fillDurSelect('');
          durNote.style.color = '#B45309';
          durNote.textContent = '⚠️ Не нашёл курс «' + c + '» в таблице длительности — выбери в списке выше или впиши вручную.';
        }
        updateScenario();
      }).catch(e => {
        durNote.style.color = '#B45309';
        durNote.textContent = '⚠️ Таблица длительности недоступна (' + ((e && e.message) || '?') + ') — впиши вручную.';
      }).then(() => { calcDurLoading = false; });
    };

    // C5 сумма · C6 ак.ч. · C7 дней · C8 дата доступа · C9 дата обращения · C10 комиссия · C11 CPL(вручную)
    const calcCol = comm => [num(T.amount), clean(T.calcHours), clean(T.calcDays),
      clean(T.accessDate), clean(T.claimDate), comm, ''].join('\n');
    // две кнопки расчёта — в один ряд; длинная инструкция спрятана под «как посчитать»
    const calcBtnRow = el('div', 'display:flex;gap:6px;margin-top:6px;');
    const bCalcPre = el('button', S.big, 'Предв. расчёт (C5)');
    bCalcPre.title = 'Скопировать в «Оплаченная сумма» 1-го блока калькулятора';
    bCalcPre.style.cssText += 'flex:1 1 0;margin-top:0;padding:7px 6px;font-size:12px;';
    bCalcPre.onclick = () => copy(calcCol('=C5*0,05'),
      '✓ Предв. расчёт в буфере → «Оплаченная сумма» 1-го блока, Ctrl+V.');
    const bCalcFin = el('button', S.big, 'Оконч. расчёт (C23)');
    bCalcFin.title = 'Скопировать в «Оплаченная сумма» 2-го блока калькулятора';
    bCalcFin.style.cssText += 'flex:1 1 0;margin-top:0;padding:7px 6px;font-size:12px;';
    bCalcFin.onclick = () => copy(calcCol(''),
      '✓ Оконч. расчёт в буфере → «Оплаченная сумма» 2-го блока, Ctrl+V.');
    calcBtnRow.appendChild(bCalcPre);
    calcBtnRow.appendChild(bCalcFin);
    // запасной вариант (через Google-таблицу калькулятора) спрятан: основной расчёт теперь выше, в мастере
    // знак «?» справа от заголовка «Калькулятор возврата» открывает запасной вариант
    const oldCalcWrap = el('div', 'display:none;margin:6px 0;padding:8px 10px;background:#F9FAFB;border:1px dashed #D1D5DB;border-radius:10px;');
    const calcQOff = 'margin-left:auto;width:22px;height:22px;box-sizing:border-box;border-radius:50%;padding:0;background:#fff;border:1.5px solid ' + ACC_BD + ';color:' + ACC_DK + ';font-size:12px;font-weight:700;line-height:1;cursor:pointer;font-family:inherit;flex:0 0 auto;';
    const oldCalcTgl = el('button', calcQOff, '?');
    oldCalcTgl.title = 'Запасной вариант: через таблицу калькулятора';
    oldCalcTgl.onclick = () => {
      const v = oldCalcWrap.style.display === 'none';
      oldCalcWrap.style.display = v ? 'block' : 'none';
      oldCalcTgl.style.cssText = calcQOff + (v ? 'background:' + ACC_BD + ';' : '');
    };
    calcBlock.firstElementChild.appendChild(oldCalcTgl);
    calcBlock.insertBefore(oldCalcWrap, calcBlock.children[1]);
    oldCalcWrap.appendChild(el('div', 'font-size:11px;font-weight:700;color:#374151;margin-bottom:2px;', 'Запасной вариант: через таблицу калькулятора'));
    oldCalcWrap.appendChild(bCalcOpen);
    oldCalcWrap.appendChild(calcBtnRow);
    const calcHelp = el('div', S.hint + 'white-space:pre-wrap;',
      '1. Проверь курс и ак.ч./дни в жёлтом блоке выше (если не тот — выбери в списке).\n' +
      '2. «Предв. расчёт» → Ctrl+V в жёлтую ячейку «Оплаченная сумма» ПЕРВОГО блока калькулятора.\n' +
      '3. В калькуляторе руками впиши CPL (в амо его нет). «Итого возврата» посчитается само — это сумма по оферте.\n' +
      '4. После согласования: «Оконч. расчёт» → во ВТОРОЙ блок; там же руками впиши фактическую комиссию.\n' +
      'Копируется 7 значений в столбик: сумма · ак.ч. · дней · дата доступа · дата обращения · комиссия · (CPL пусто).');
    oldCalcWrap.appendChild(calcHelp);

    /* ============ ПРАВАЯ КОЛОНКА ============ */


    errBox = el('div', S.err + 'display:none;');
    colL.appendChild(errBox);
    colL.appendChild(tableBlock);   // «Данные»: под «Итогом переговоров» — № строки и кнопка «Копировать всю строку»
    // При результате «Возврат» без конкретной суммы — не даём копировать всю строку.
    const guardSum = () => {
      if (!sumMissing()) { if (errBox && T.result !== 'В работе') errBox.style.display = 'none'; return true; }
      if (errBox) {
        errBox.textContent = '⚠️ Впиши «Сумму возврата» — конкретное число больше нуля.';
        errBox.style.display = 'block';
      }
      updateScenario();
      return false;
    };
    // Карточка Асаны — только когда решение принято и (при возврате) есть сумма.
    const guardHandoff = () => {
      if (T.result === 'В работе') {
        if (errBox) {
          errBox.textContent = '⚠️ Результат «В работе»: карточку Асаны можно скопировать только после решения «Возврат».';
          errBox.style.display = 'block';
        }
        return false;
      }
      return guardSum();
    };
    // Сообщение продакту в ТГ — только когда результат «Возврат» и указана сумма
    // (при «Остаётся»/«В работе» решение ещё не принято — продакту сообщать рано).
    const guardRefund = () => {
      if (T.result !== 'Возврат') {
        if (errBox) {
          errBox.textContent = '⚠️ Сообщение продакту можно скопировать только после результата «Возврат» и с указанной суммой.';
          errBox.style.display = 'block';
        }
        return false;
      }
      return guardSum();
    };

    // Блоки «РГ» и «Продакту»: сворачиваются по клику на заголовок; внутри виден и правится текст сообщения.
    // Пока куратор сам ничего не менял, текст пересобирается при открытии вкладки и при смене данных;
    // после ручной правки — не трогаем, пока не нажмёшь «собрать заново».
    // «✍️【…】» — места, куда надо вписать своё: при копировании они уходят жирным.
    const msgHtml = (txt) => {
      var x = String(txt).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      x = x.replace(/ ?✍️【([^】]*)】/g, function (m, g) { return ' <b>✍️ ' + g + '</b>'; });
      var q = clean(T.clientComment).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      if (q && x.indexOf(q) >= 0) x = x.replace(q, '<blockquote>' + q + '</blockquote>');
      return x.split('\n').join('<br>');
    };
    const copyRich = (txt, okMsg) => {
      let ok = false;
      try {
        if (navigator.clipboard && window.ClipboardItem) {
          navigator.clipboard.write([new window.ClipboardItem({
            'text/plain': new Blob([txt], { type: 'text/plain' }),
            'text/html': new Blob([msgHtml(txt)], { type: 'text/html' })
          })]).catch(function () { try { GM_setClipboard(txt); } catch (e) { /* ignore */ } });
          ok = true;
        }
      } catch (e) { /* нет rich-буфера */ }
      if (!ok) { try { GM_setClipboard(txt); ok = true; } catch (e) { /* ignore */ } }
      statusBox.textContent = ok ? okMsg : 'Не получилось скопировать';
      statusBox.style.color = ok ? '#15803D' : '#DC2626';
      flashCopied(ok ? '✓ скопировано' : 'не скопировалось', !ok);
    };
    const mkMsgEditor = (body, getText, guard, okMsg) => {
      let dirty = false;
      const area = el('textarea', S.input + 'min-height:120px;font-size:11.5px;line-height:1.5;resize:none;overflow:hidden;margin-top:4px;');
      // окно подгоняется под весь текст сразу (без прокрутки внутри); в свёрнутом блоке считать нечего — подгоняем при раскрытии
      const fit = () => { if (!area.offsetParent) return; area.style.height = 'auto'; area.style.height = (area.scrollHeight + 4) + 'px'; };
      area.addEventListener('input', () => { dirty = true; fit(); });
      const refresh = (force) => { if (force || !dirty) { area.value = getText(); if (force) dirty = false; } fit(); };
      body.appendChild(area);
      const row = el('div', 'display:flex;gap:6px;align-items:center;margin-top:6px;');
      const btn = el('button', S.big, 'Скопировать сообщение');
      btn.style.cssText += 'flex:1 1 auto;margin-top:0;';
      const reset = el('span', 'font-size:11px;color:#6B7280;text-decoration:underline;cursor:pointer;white-space:nowrap;', '↺ собрать заново');
      reset.title = 'Стереть мои правки и собрать текст заново из данных';
      reset.onclick = () => refresh(true);
      btn.onclick = () => { if (guard && !guard()) return; refresh(false); copyRich(area.value, okMsg); };
      row.appendChild(btn); row.appendChild(reset);
      body.appendChild(row);
      return { area, btn, refresh, fit };
    };

    // 2) РГ — только при возврате ≤ 3 дней
    rgBlock = mkBlock(msgPane, 'Возврат ≤ 3 дней → передаём РГ', true);
    rgBlock.style.display = 'none';
    const rgBody = makeCollapsible(rgBlock, false, () => rgEd.fit());
    mkField(rgBody, 'rgTag', 'Тег РГ в ТГ (подставится по МОПу, можно поправить)', 'man', { ph: '@kondratev_av' });
    const rgLines = () => [
      'Здравствуйте! Возврат в течение 3-х дней.',
      '1) ' + clean(T.amoLink),
      '2) ' + stripMark(clean(T.course)),
      '3) ' + (clean(T.rgTag) || B('тег РГ')),
      '4) Покупка ' + clean(T.purchaseDate || T.accessDate) + ', запрос возврата ' + clean(T.claimDate),
      '5) Причина: ',
      Q(clean(T.clientComment) || B('вставь текст клиента')),
      'Ответственный: ' + (clean(T.mop) || B('кто продал')),
      '',
      'Свяжитесь, пожалуйста. 🙏',
    ].join('\n');

    // 3) Сообщение продакту в Телеграм
    tgBlock = mkBlock(msgPane, 'Сообщение продакту в Телеграм', true);
    tgHdr = tgBlock.firstElementChild;
    const tgBody = makeCollapsible(tgBlock, false, () => tgEd.fit());
    mkField(tgBody, 'producer', 'Тег продакта в ТГ (по кластеру)', 'auto', { ph: '@hey_juliko' });
    const courseTxt = () => stripMark(clean(T.course));
    const dealDatesTxt = () => 'Покупка ' + clean(T.purchaseDate || T.accessDate) + ', запрос возврата ' + clean(T.claimDate);
    // Ресейл TeachMeSkills — @Dmitriy_PR0 (всегда, кластер IT) + @n_ekimov в п.7
    const tgResale = () => [
      'Здравствуйте!',
      '1. ' + clean(T.amoLink),
      '2. ' + (courseTxt() || B('курс')),
      '3. @Dmitriy_PR0',
      '4. ' + dealDatesTxt(),
      '5. курс ресейла, поэтому процент прохождения не знаю',
      '6. Причина:',
      Q(clean(T.clientComment) || B('вставь текст клиента')),
      '7. @n_ekimov Нужно, чтобы партнеры связались для отработки. Передайте, пожалуйста.',
    ].join('\n');
    // Детские курсы — только @dd_terentev
    const tgKids = () => [
      '@dd_terentev Привет! Поступила заявка на возврат.',
      '',
      '1. ' + clean(T.amoLink),
      '2. ' + (courseTxt() || B('курс')),
      '3. Дата покупки: ' + clean(T.purchaseDate || T.accessDate) + ' Дата заявки: ' + clean(T.claimDate),
      '4. Причина: ' + (clean(T.clientComment) || B('вставь текст клиента')),
      '5. Пожалуйста, свяжитесь для отработки возврата.',
    ].join('\n');
    const tgNormal = () => [
      'Здравствуйте!',
      '1) ' + clean(T.amoLink),
      '2) ' + courseTxt(),
      '3) ' + clean(T.producer),
      '4) ' + dealDatesTxt(),
      '5) ' + clean(T.progress) + '% прохождения',
      '6) Причина:',
      Q(clean(T.clientComment) || B('вставь текст клиента')),
      '7) ' + B('комментарий куратора — впиши'),
      '8) По оферте: ' + agreedTxt() + ' FYI',
    ].join('\n');
    const tgLockNote = el('div', 'font-size:11.5px;font-weight:700;color:#E11D1D;background:#FEE2E2;border-radius:8px;padding:6px 9px;margin-top:4px;display:none;', 'Сообщение продакту доступно, когда результат «Возврат».');
    tgBlock.insertBefore(tgLockNote, tgBody);   // над сворачиваемой частью — видна и в свёрнутом блоке
    const rgEd = mkMsgEditor(rgBody, () => marked(rgLines()), null, 'Сообщение для РГ в буфере ✓ Отправь в ТГ.');
    const tgEd = mkMsgEditor(tgBody, () => marked(curScen === 'resale' ? tgResale() : curScen === 'kids' ? tgKids() : tgNormal()),
      () => (curScen === 'resale' || curScen === 'kids') ? true : guardRefund(),   // обычное сообщение — только при «Возврат» и с суммой
      'Сообщение в буфере ✓ Жирным — что дописать.');
    // блокировка: пока результат не «Возврат», сообщение продакту не отправить (ресейл и детские курсы — без этого условия)
    const syncTgLock = () => {
      const locked = curScen !== 'resale' && curScen !== 'kids' && T.result !== 'Возврат';
      tgEd.btn.disabled = locked; tgEd.area.disabled = locked;
      tgEd.btn.style.cursor = locked ? 'not-allowed' : 'pointer';
      tgEd.area.style.opacity = locked ? '.55' : '1';
      tgLockNote.style.display = locked ? 'block' : 'none';
    };
    // ---- Шаблоны ответов клиенту: новая / старая оферта + общие ----
    // В тексте: {ИМЯ} {ДАТА} {СУММА} {ДНЕЙ} {ПРОЦ} — подставляются из данных мастера; чего нет — отмечается «✍️【…】» (вписать самой).
    const LN = (...a) => a.join('\n');
    const TPL_NEW = [
      { t: 'Первое сообщение / уточнение причины', x: LN(
        '{ИМЯ}, здравствуйте!', '',
        'Мне очень жаль, что вы хотите отказаться от обучения у нас.', '',
        'Пожалуйста, расскажите по возможности максимально подробно, в чем причина такого решения?', '',
        'Это очень важно для нас — мы постоянно работаем над улучшением, и ваше мнение нам очень ценно. 💙') },
      { t: 'Удержание (основные предложения)', x: LN(
        'Напоминаю, что доступ к курсу и обновлениям программы предоставляются бессрочно. У вас есть возможность получить диплом в любой момент, но для этого необходимо завершить курс на 100%. ',
        'Также у вас действует кураторская поддержка по вопросам обучения и техническим сложностям до {ДАТА}.', '',
        'Хочу вам предложить всё же остаться на текущем курсе или, как альтернативный вариант, перевестись на другой курс в нашей Академии (не превышающий стоимость текущего, либо с доплатой в виде разницы). Уточните, пожалуйста, рассмотрели бы такой вариант или остаетесь на текущем курсе? ') },
      { t: 'Отбивка о предварительном расчёте', x: LN(
        'Мы работаем согласно условиям публичной оферты. Это стандартная практика в сфере онлайн-образования:', '',
        '7.2. "Сумма возврата определяется как разница между уплаченной Заказчиком суммой, стоимостью фактически оказанных услуг и фактически понесенными расходами Исполнителя."', '',
        'Направляю также ссылку на оферту: https://eduson.academy/offer', '',
        'Обращаем внимание, что при отказе от обучения доступ к подарочному курсу таже будет закрыт.', '',
        'Сейчас мне потребуется немного времени, чтобы рассчитать предварительную сумму к возврату. В ближайшее время вернусь к вам с информацией. Ожидайте, пожалуйста.') },
      { t: 'Согласовали сумму (окончательная сумма)', x: LN(
        'Расчет суммы возврата произведен в соответствии со ст. 32 Закона РФ «О защите прав потребителей», Публичной офертой и Политикой возвратов ООО «Эдюсон».', '',
        'При расчете суммы возврата были учтены обстоятельства исполнения договора до даты получения уведомления об отказе, а также расходы Исполнителя, связанные с заключением, началом исполнения и исполнением договора, в порядке, предусмотренном Политикой возвратов.', '',
        'Общая сумма к возврату составила {СУММА} руб.', '',
        'В соответствии с разделом 8 Политики возвратов внутренняя методика расчета стоимости фактически оказанных услуг и фактически понесенных расходов является внутренним документом Исполнителя и не подлежит обязательному опубликованию. При этом Заказчику предоставляется расчет суммы возврата по конкретному договору с указанием оплаченной суммы, суммы удержаний и итоговой суммы возврата.', '',
        'Расчет произведен на основании данных, документов и учетных сведений Исполнителя в порядке, предусмотренном Политикой возвратов.', '',
        'Публичная оферта: https://eduson.academy/offer',
        'Политика возврата: https://eduson.academy/refund', '',
        'Подскажите, направляем запрос на возврат средств?') },
    ];
    const TPL_OLD = [
      { t: 'Первое сообщение / уточнение причины', x: LN(
        '{ИМЯ}, здравствуйте! ', '',
        'Мне очень жаль, что вы хотите отказаться от обучения у нас.', '',
        'Пожалуйста, расскажите по возможности максимально подробно, в чем причина такого решения?',
        'Это очень важно для нас — мы постоянно работаем над улучшением, и ваше мнение нам очень ценно. 💙', '',
        'Также дублируем для вас ссылку на нашу оферту: https://eduson.academy/offer-old-25-02-2026',
        'Условия возврата обозначены в пункте 8.') },
      { t: 'Удержание (возврат невозможен, основные предложения)', x: LN(
        'Мы работаем согласно условиям публичной оферты. Это стандартная практика в сфере онлайн-образования. На момент подачи заявления на возврат у вас было зафиксировано {ДНЕЙ} доступа к курсу и {ПРОЦ}% прохождения. Согласно условиям оферты 8.3.5. возврат денежных средств уже невозможен.', '',
        '"Если с момента оплаты Заказчиком доступа к Программе прошло более 45 (сорока пяти) календарных дней, возврат денежных средств не производится."', '',
        'Направляю также ссылку на оферту: https://eduson.academy/offer-old-25-02-2026', '',
        'Напоминаю, что доступ к курсу и обновлениям программы предоставляются бессрочно. У вас есть возможность получить диплом в любой момент, но для этого необходимо завершить курс на 100%. ',
        'Также у вас действует кураторская поддержка по вопросам обучения и техническим сложностям до {ДАТА}.', '',
        'Хочу вам предложить всё же остаться на текущем курсе или, как альтернативный вариант, перевестись на другой курс в нашей Академии (не превышающий стоимость текущего, либо с доплатой в виде разницы). Уточните, пожалуйста, рассмотрели бы такой вариант или остаетесь на текущем курсе? ') },
    ];
    const TPL_COMMON = [
      { t: 'Подписать заявление Т-банка', x: 'Направляю вам заявление на подпись. Пришлите подписанное заявление в ответном сообщении, пожалуйста.' },
      { t: 'Заявление от юр. лица', x: 'Согласовали для вас возврат на сумму {СУММА} руб. Для того чтобы мы могли оформить заявку на возврат, просим вас прислать заявление от юр. лица в свободной форме с указанием реквизитов для перевода. Ожидаем от вас подписанный документ в виде скана или фото хорошего качества.' },
      { t: 'Оплата на реквизиты компании: заявление', tip: 'Заявление можно скачать в типе оплаты, раздел «Асана»', x: 'Согласовали для вас возврат на сумму {СУММА} руб. Для того чтобы мы могли оформить заявку на возврат, просим вас прислать заполненное заявление. Ожидаем от вас подписанный документ в виде скана или фото хорошего качества.' },
      { t: 'Прощание с клиентом', x: LN(
        'Передали ваше обращение в работу.',
        'Возврат с нашей стороны осуществляется на те же реквизиты, с которых поступил платеж, в течение 10 рабочих дней. Дальнейшее зачисление денег на ваш счет, зависит от банка. Пожалуйста, ожидайте.',
        'Если у вас возникнут дополнительные вопросы или решите все же оставить или заменить обучение, напишите нам, будем рады помочь.🙂', '',
        'Успеха вам в дальнейших начинаниях!') },
      { t: 'Деньги переведены', x: LN(
        'Здравствуйте!', '',
        'С нашей стороны возврат д/с произвели. Срок зачисления д/с зависит от банка. Точные сроки лучше узнавать в поддержке вашего банка.', '',
        'Как только получите д/с, напишите, пожалуйста, в этот чат. Заранее спасибо!') },
    ];
    const tplBlock = mkBlock(tplPane, 'Шаблоны ответов клиенту', true);
    const tplSeg = el('div', 'display:flex;border:1px solid #E5E7EB;border-radius:8px;overflow:hidden;margin-bottom:4px;');
    const tplSegBtns = {};
    [['new', 'Новая оферта'], ['old', 'Старая оферта']].forEach(([k, t]) => {
      const b = el('button', 'flex:1;border:0;padding:6px 4px;font-size:11.5px;font-weight:500;cursor:pointer;font-family:inherit;', t);
      b.onclick = () => { tplMode = k; tplRender(); };
      tplSegBtns[k] = b; tplSeg.appendChild(b);
    });
    const tplList = el('div', '');
    tplBlock.appendChild(tplSeg); tplBlock.appendChild(tplList);
    let tplMode = '';   // '' — по сценарию (старая оферта = «до 05.06»), 'new'/'old' — выбрано руками
    const tplEff = () => tplMode || (curScen === 'before' ? 'old' : 'new');
    const tplEdits = {};   // правки текста руками: ключ режим+название → текст
    const tplRows = [];
    const plural = (n, f) => { const a = Math.abs(n) % 100, b = a % 10; return n + ' ' + (a > 10 && a < 20 ? f[2] : b === 1 ? f[0] : b >= 2 && b <= 4 ? f[1] : f[2]); };
    const tplVals = () => {
      const mark = s => '✍️【' + s + '】';
      const w = nameWords(T.name);
      const p = parseRu(T.accessDate), c = parseRu(T.claimDate);
      const days = (p && c) ? Math.round((c - p) / 86400000) : null;
      const sup = (String(omniCardField(7301) || '').match(/\d{2}\.\d{2}\.\d{4}/) || [''])[0];
      return {
        'ИМЯ': (w.length > 1 ? w[1] : (w[0] || '')) || mark('имя'),
        'ДАТА': sup || mark('дата окончания поддержки'),
        'СУММА': mark('сумма'),   // сумма в шаблонах не подставляется сама — вписывается руками
        'ДНЕЙ': days != null ? plural(days, ['день', 'дня', 'дней']) : mark('сколько дней'),
        'ПРОЦ': clean(T.progress) || mark('%'),
      };
    };
    // Поддержка уже закончилась (дата в карточке раньше сегодняшней) — строки про кураторскую поддержку в шаблоне нет
    const supportEnded = () => {
      const m = String(omniCardField(7301) || '').match(/\d{2}\.\d{2}\.\d{4}/);
      const d = m && parseRu(m[0]);
      if (!d) return false;   // даты нет — не угадываем, строка остаётся с пометкой «вписать дату»
      const now = new Date(); now.setHours(0, 0, 0, 0);
      return d < now;
    };
    const tplFill = (x) => {
      if (supportEnded()) x = x.replace(/ ?\nТакже у вас действует кураторская поддержка[^\n]*\{ДАТА\}\./, '');
      const v = tplVals();
      return x.replace(/\{(ИМЯ|ДАТА|СУММА|ДНЕЙ|ПРОЦ)\}/g, (m, k) => v[k]);
    };
    const tplFit = (a) => { if (!a.offsetParent) return; a.style.height = 'auto'; a.style.height = (a.scrollHeight + 4) + 'px'; };
    const tplRender = () => {
      const mode = tplEff();
      tplSegBtns.new.style.cssText += 'background:' + (mode === 'new' ? '#1F2937;color:#fff;' : '#fff;color:#4B5563;');
      tplSegBtns.old.style.cssText += 'background:' + (mode === 'old' ? '#1F2937;color:#fff;' : '#fff;color:#4B5563;');
      tplList.innerHTML = ''; tplRows.length = 0;
      (mode === 'old' ? TPL_OLD : TPL_NEW).concat(TPL_COMMON).forEach((tp, i) => {
        const key = mode + ':' + tp.t;
        const row = el('div', i ? 'border-top:1px solid #F3F4F6;' : '');
        const hd = el('div', 'display:flex;align-items:center;gap:6px;padding:7px 0;cursor:pointer;');
        const ttl = el('span', 'flex:1 1 auto;min-width:0;font-size:12px;font-weight:500;color:#1F2937;', tp.t);
        if (tp.tip) ttl.title = tp.tip;
        const cp = el('button', S.small, 'Копировать');
        cp.style.cssText += 'width:auto;flex:0 0 auto;margin-top:0;padding:3px 9px;font-size:11px;';
        const chev = el('span', 'color:#9CA3AF;font-size:11px;flex:0 0 auto;', '▾');
        hd.appendChild(ttl); hd.appendChild(cp); hd.appendChild(chev);
        const body = el('div', 'display:none;padding-bottom:8px;');
        const area = el('textarea', S.input + 'min-height:80px;font-size:11.5px;line-height:1.5;resize:none;overflow:hidden;');
        area.value = tplEdits[key] !== undefined ? tplEdits[key] : tplFill(tp.x);
        area.addEventListener('input', () => { tplEdits[key] = area.value; tplFit(area); });
        body.appendChild(area);
        hd.onclick = () => {
          const o = body.style.display === 'none';
          body.style.display = o ? 'block' : 'none'; chev.textContent = o ? '▴' : '▾';
          if (o) tplFit(area);
        };
        cp.onclick = (ev) => { ev.stopPropagation(); copy(area.value, 'Шаблон «' + tp.t + '» в буфере ✓'); };
        row.appendChild(hd); row.appendChild(body); tplList.appendChild(row);
        tplRows.push({ key: key, tp: tp, area: area });
      });
    };
    // обновление: если режим (по сценарию) сменился — перерисовать; иначе пересобрать тексты, которые не правили руками
    let tplShown = '';
    const tplRefresh = () => {
      const mode = tplEff();
      if (mode !== tplShown) { tplShown = mode; tplRender(); return; }
      tplRows.forEach(r => { if (tplEdits[r.key] === undefined) { r.area.value = tplFill(r.tp.x); tplFit(r.area); } });
    };
    tplRender(); tplShown = tplEff();
    const refreshMsgs = () => { tgEd.refresh(false); rgEd.refresh(false); syncTgLock(); tplRefresh(); };
    tabHooks[2] = tplRefresh; tabHooks[3] = refreshMsgs; tgRefreshHook = refreshMsgs;
    refreshMsgs();

    // 3.5) Тип оплаты и заявление — видно только при результате «Возврат» (см. show(payTypeBlock, ...) выше).
    // Список типов и «нужно ли заявление» тянем из гугл-таблицы «Заявления на возврат».
    const payTypeUnset = () => !clean(T.payTypeSel);
    // В выпадающем списке и в заголовке Асаны — «Рассрочка/Полная» ПЕРВЫМ словом перед типом
    // (для этого и заводили колонку B в таблице «Заявления на возврат»); в списке это слово бледнее типа.
    const payTypeLabel = r => (r.kind ? r.kind + ' ' + r.type : r.type);
    payTypeBlock = mkBlock(asanaPane, 'Тип оплаты и заявление', true);
    payTypeBlock.style.display = T.result === 'Возврат' ? 'block' : 'none';
    const payTypeLab = el('div', S.lab);
    payTypeLab.appendChild(el('span', 'flex:1 1 auto;', 'Тип оплаты'));
    payTypeBlock.appendChild(payTypeLab);
    const payTypeCombo = combo([], 'выбери тип оплаты…', clean(T.payTypeSel));
    payTypeBlock.appendChild(payTypeCombo.el);
    const zayavBox = el('div', 'margin-top:8px;');
    const renderZayav = () => {
      zayavBox.innerHTML = '';
      const row = _payTypeRows && _payTypeRows.find(r => payTypeLabel(r) === T.payTypeSel);
      if (payTypeUnset()) {
        zayavBox.appendChild(el('div', 'font-size:10.5px;color:#9CA3AF;', 'Выбери тип оплаты — покажу, нужно ли заявление.'));
        return;
      }
      if (!row) {
        zayavBox.appendChild(el('div', 'font-size:10.5px;color:#9CA3AF;', _payTypeRows ? 'Такого типа нет в таблице.' : 'Загружаю таблицу…'));
        return;
      }
      const needsIt = /^да/i.test(row.zayav);
      const need = el('div', 'font-size:12.5px;font-weight:800;color:' + (needsIt ? '#DC2626' : '#15803D') + ';', 'Заявление: ' + (row.zayav || '—'));
      zayavBox.appendChild(need);
      if (row.comment) zayavBox.appendChild(el('div', 'font-size:10.5px;color:#6B7280;margin-top:4px;white-space:pre-wrap;line-height:1.4;', row.comment));
      if (row.file) {
        const a = el('a', 'font-size:11px;font-weight:700;color:' + ACC + ';display:inline-block;margin-top:6px;', '📎 Файл с заявлением');
        a.href = row.file; a.target = '_blank'; a.rel = 'noopener';
        zayavBox.appendChild(a);
      }
    };
    payTypeCombo.onPick(() => {
      T.payTypeSel = payTypeCombo.value.trim(); saveCase(); renderZayav();
      if (tabHooks.asana) tabHooks.asana();   // колонка Асаны зависит от «нужно ли заявление»
    });
    payTypeBlock.appendChild(zayavBox);
    renderZayav();
    fetchPayTypeRows().then(rows => {
      payTypeCombo.setRows(rows.map(r => ({
        label: payTypeLabel(r), value: payTypeLabel(r),
        parts: [{ text: r.kind + ' ', muted: true }, { text: r.type }],
      })));
    }).catch(() => { /* список не загрузился — куратор впишет тип вручную */ });

    // 4) Карточка Асаны
    const payForTitle = () => {
      if (!payTypeUnset()) return clean(T.payTypeSel);
      const pt = clean(T.payType);
      return /полн/i.test(pt) ? 'Полная (' + B('укажи банк') + ')' : pt;
    };
    const asanaTitle = () => payForTitle() + '/' + clean(T.name) + '/' + stripMark(clean(T.course)) + '/' + agreedTxt();
    const asanaBody = () => [
      'Куратор: ' + clean(T.curator),
      'Ссылка на амо: ' + clean(T.amoLink),
      'Сколько возвращаем: ' + agreed(),
      'Дата оплаты: ' + clean(T.purchaseDate || T.accessDate),
      'Дата обращения за возвратом: ' + clean(T.claimDate),
      'Согласование возврата (ссылка): ' + B('вставь ссылку на согласование в ТГ'),
    ].join('\n');
    // Описание для создания карточки прямо из мастера: без «впиши сам»-меток; ссылка на согласование — из вкладки «Согласов.»
    const asanaNotes = () => [
      'Куратор: ' + clean(T.curator),
      'Ссылка на амо: ' + clean(T.amoLink),
      'Сколько возвращаем: ' + agreed(),
      'Дата оплаты: ' + clean(T.purchaseDate || T.accessDate),
      'Дата обращения за возвратом: ' + clean(T.claimDate),
      'Согласование возврата (ссылка): ' + clean(T.approveLink),
    ].join('\n');
    // Нужно ли заявление (определяет колонку Асаны): true / false / null — тип оплаты не выбран или не найден в таблице.
    const needZayav = () => {
      if (payTypeUnset()) return null;
      const row = _payTypeRows && _payTypeRows.find(r => payTypeLabel(r) === T.payTypeSel);
      return row ? /^да/i.test(row.zayav) : null;
    };
    const asanaBlock = mkBlock(asanaPane, 'Карточка Асаны', true);
    const asInfo = el('div', 'font-size:11px;line-height:1.6;color:#374151;');
    asanaBlock.appendChild(asInfo);
    // Ссылка на согласование (после ответа продакта) — попадает в описание карточки Асаны
    const apLink = el('div', 'margin-top:8px;');
    asanaBlock.appendChild(apLink);
    mkField(apLink, 'approveLink', 'Ссылка на согласование (после ответа продакта)', 'man', { ph: 'https://t.me/…' });
    const asDone = el('div', 'display:none;margin-top:8px;');
    const asLink = el('a', 'font-size:11.5px;font-weight:800;color:' + ACC + ';word-break:break-all;');
    asLink.target = '_blank'; asLink.rel = 'noopener';
    asDone.appendChild(asLink);
    const asDate = el('div', 'font-size:10.5px;color:#6B7280;margin-top:3px;', '');
    asDone.appendChild(asDate);
    const bAsanaCopy = el('button', S.big, 'Скопировать ссылку на карточку');
    bAsanaCopy.onclick = () => {
      if (!T.asanaUrl) { statusBox.style.color = '#B45309'; statusBox.textContent = 'Карточка ещё не создана.'; return; }
      copy(T.asanaUrl, 'Ссылка на карточку Асаны в буфере ✓');
    };
    asDone.appendChild(bAsanaCopy);
    asanaBlock.appendChild(asDone);
    const bAsanaCreate = el('button', S.big, 'Создать карточку в Асане');
    const bAsanaUpd = el('button', S.btnAlt, 'Обновить название и описание в Асане');
    asanaBlock.appendChild(bAsanaCreate);
    asanaBlock.appendChild(bAsanaUpd);
    const fmtDate = d => String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + d.getFullYear();
    const asanaDueISO = () => { const d = new Date(Date.now() + ASANA_DUE_DAYS * 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    const asNo = el('div', S.hint + 'margin-top:0;', 'При результате «Остаётся» или «В работе» карточка в Асане не нужна.');
    asanaPane.insertBefore(asNo, asanaBlock);
    let blockBlockEl = null, omniBlockEl = null;   // «Блокировка курса» и «Карточка OmniDesk» — создаются ниже
    const renderAsana = () => {
      const isRef = T.result === 'Возврат';   // карточка Асаны — только при возврате
      asanaBlock.style.display = isRef ? 'block' : 'none';
      asNo.style.display = isRef ? 'none' : 'block';
      // вкладка «Доступ» (блокировка курса, карточка OmniDesk) показывается всегда — не только при «Возврате»
      if (blockBlockEl) blockBlockEl.style.display = 'block';
      if (omniBlockEl) omniBlockEl.style.display = 'block';
      const nz = needZayav();
      const colName = nz === null ? '— (выбери тип оплаты выше)' : (nz ? 'Заявление получено' : 'Делаем возврат (не нужно заявление)');
      asInfo.innerHTML = '';
      [['Колонка', colName]].forEach(r => {
        const row = el('div', 'display:flex;gap:8px;justify-content:space-between;padding:3px 0;border-bottom:1px solid #EEF0F2;');
        row.appendChild(el('span', 'color:#6B7280;flex:0 0 auto;', r[0]));
        row.appendChild(el('span', 'font-weight:700;text-align:right;min-width:0;word-break:break-word;', r[1]));
        asInfo.appendChild(row);
      });
      const has = !!T.asanaUrl;
      asDone.style.display = has ? 'block' : 'none';
      bAsanaCreate.style.display = has ? 'none' : 'block';
      bAsanaUpd.style.display = has ? 'block' : 'none';
      if (has) {
        asLink.href = T.asanaUrl; asLink.textContent = 'Карточка создана — открыть в Асане';
        asDate.textContent = 'Создана ' + (T.asanaDate || '') + ' · эта дата уйдёт в таблицу как «Дата отключения доступа».';
      }
      if (!ASANA_PROJECT) { bAsanaCreate.title = 'Проект Асаны для теста не задан'; }
    };
    tabHooks[4] = renderAsana; tabHooks.asana = renderAsana;
    let asBusy = false;
    const asErr = (e) => {
      const m = String((e && e.message) || e);
      return m === 'NOAUTH' ? 'Асана не пустила. Открой app.asana.com в соседней вкладке, войди и попробуй снова.' : m;
    };
    bAsanaCreate.onclick = async () => {
      if (asBusy) return;
      if (!ASANA_PROJECT) { statusBox.style.color = '#B45309'; statusBox.textContent = 'Проект Асаны для теста ещё не задан — пока копируй «Заголовок» и «Описание» ниже.'; return; }
      if (!guardHandoff()) return;
      const nz = needZayav();
      if (nz === null) { statusBox.style.color = '#B45309'; statusBox.textContent = 'Выбери тип оплаты выше: от него зависит колонка Асаны.'; return; }
      const title = asanaTitle();
      if (title.indexOf(MB1) >= 0) { statusBox.style.color = '#B45309'; statusBox.textContent = 'В названии осталось «впиши сам» (банк?) — выбери конкретный тип оплаты выше.'; return; }
      asBusy = true; bAsanaCreate.disabled = true; statusBox.style.color = '#374151';
      statusBox.textContent = 'Создаю карточку в Асане…';
      try {
        const secs = await asanaApi('GET', '/projects/' + ASANA_PROJECT + '/sections?opt_fields=name');
        const want = nz ? 'Заявление получено' : 'Делаем возврат';
        const sec = (secs || []).find(s => String(s.name).indexOf(want) === 0);
        if (!sec) throw new Error('в проекте нет колонки «' + want + '…»');
        const t = await asanaApi('POST', '/tasks?opt_fields=name,created_at', { data: { name: title, notes: asanaNotes(), projects: [ASANA_PROJECT], memberships: [{ project: ASANA_PROJECT, section: sec.gid }], due_on: asanaDueISO() } });
        if (!t || !t.gid) throw new Error('Асана не вернула номер карточки');
        T.asanaGid = String(t.gid);
        T.asanaUrl = 'https://app.asana.com/1/' + ASANA_WS + '/project/' + ASANA_PROJECT + '/task/' + t.gid;
        T.asanaDate = fmtDate(t.created_at ? new Date(t.created_at) : new Date());
        saveCase(); renderAsana();
        statusBox.style.color = '#15803D';
        statusBox.textContent = '✓ Карточка создана в колонке «' + sec.name + '». Ссылку на неё и дату отключения доступа допиши в строку таблицы руками.';
        if (asQueue.some(x => x.state === 'queued')) uploadQueue();   // файлы, выбранные до создания карточки
      } catch (e) {
        statusBox.style.color = '#B45309';
        statusBox.textContent = '⚠️ Не получилось создать карточку: ' + asErr(e) + '. Заголовок и описание можно скопировать кнопками ниже.';
      }
      asBusy = false; bAsanaCreate.disabled = false;
    };
    bAsanaUpd.onclick = async () => {
      if (asBusy || !T.asanaGid) return;
      const title = asanaTitle();
      if (title.indexOf(MB1) >= 0) { statusBox.style.color = '#B45309'; statusBox.textContent = 'В названии осталось «впиши сам» — выбери тип оплаты выше.'; return; }
      asBusy = true; bAsanaUpd.disabled = true; statusBox.style.color = '#374151';
      statusBox.textContent = 'Обновляю карточку в Асане…';
      try {
        await asanaApi('PUT', '/tasks/' + T.asanaGid, { data: { name: title, notes: asanaNotes() } });
        statusBox.style.color = '#15803D'; statusBox.textContent = '✓ Название и описание карточки обновлены.';
      } catch (e) {
        statusBox.style.color = '#B45309'; statusBox.textContent = '⚠️ Не получилось обновить карточку: ' + asErr(e);
      }
      asBusy = false; bAsanaUpd.disabled = false;
    };

    // запасной вариант — как раньше, копированием
    const rowA = el('div', S.row);
    const bAsanaT = el('button', S.btnAlt + 'flex:1;margin-top:0;', '📋 Заголовок');
    bAsanaT.onclick = () => { if (!guardHandoff()) return; copyMsg(asanaTitle(), 'Заголовок Асаны в буфере ✓ Жирным — что дописать.'); };
    const bAsanaB = el('button', S.btnAlt + 'flex:1;margin-top:0;', '📋 Описание');
    bAsanaB.onclick = () => { if (!guardHandoff()) return; copyMsg(asanaBody(), 'Описание карточки Асаны в буфере ✓ Жирным — что дописать (ссылка на согласование).'); };
    rowA.appendChild(bAsanaT); rowA.appendChild(bAsanaB);
    const asFallback = el('div', 'margin-top:6px;');
    asFallback.appendChild(rowA);

    // ---- файлы к карточке Асаны (до создания — ждут в очереди, после — грузятся сразу) ----
    const asQueue = [];   // {file, state: 'queued' | 'up' | 'done' | 'err', msg}
    const asFileInp = el('input', 'display:none'); asFileInp.type = 'file'; asFileInp.multiple = true;
    const bAttach = el('button', S.big, 'Прикрепить файл к карточке');
    const asFileList = el('div', 'font-size:11.5px;color:#374151;margin-top:4px;line-height:1.5;');
    const renderFiles = () => {
      asFileList.innerHTML = '';
      asQueue.forEach((it, i) => {
        const row = el('div', 'display:flex;gap:6px;align-items:baseline;');
        const mark = it.state === 'done' ? '✓' : it.state === 'up' ? '…' : it.state === 'err' ? '⚠️' : '•';
        row.appendChild(el('span', 'flex:0 0 auto;color:' + (it.state === 'done' ? '#15803D' : it.state === 'err' ? '#B45309' : '#6B7280') + ';', mark));
        row.appendChild(el('span', 'flex:1 1 auto;min-width:0;word-break:break-all;', it.file.name + (it.state === 'queued' && !T.asanaGid ? ' — загрузится после создания карточки' : '') + (it.state === 'err' ? ' — ' + it.msg : '')));
        if (it.state === 'queued' || it.state === 'err') {
          const x = el('span', 'flex:0 0 auto;cursor:pointer;color:#6B7280;', '✕');
          x.title = 'Убрать из списка';
          x.onclick = () => { asQueue.splice(i, 1); renderFiles(); };
          row.appendChild(x);
        }
        asFileList.appendChild(row);
      });
      bAttach.textContent = asQueue.length ? 'Прикрепить ещё файл' : 'Прикрепить файл к карточке';
    };
    // загрузить всё, что ждёт (нужна уже созданная карточка)
    const uploadQueue = async () => {
      if (!T.asanaGid) return;
      for (const it of asQueue) {
        if (it.state !== 'queued' && it.state !== 'err') continue;
        it.state = 'up'; renderFiles();
        try { await asanaUpload(T.asanaGid, it.file); it.state = 'done'; }
        catch (e) { it.state = 'err'; it.msg = asErr(e); }
        renderFiles();
      }
      const bad = asQueue.filter(x => x.state === 'err').length;
      if (asQueue.length) {
        statusBox.style.color = bad ? '#B45309' : '#15803D';
        statusBox.textContent = bad ? '⚠️ Часть файлов не загрузилась — см. список под кнопкой.' : '✓ Файлы прикреплены к карточке.';
      }
    };
    bAttach.onclick = () => asFileInp.click();
    asFileInp.onchange = () => {
      Array.from(asFileInp.files || []).forEach(f => asQueue.push({ file: f, state: 'queued', msg: '' }));
      asFileInp.value = '';
      renderFiles();
      if (T.asanaGid) uploadQueue();
    };
    asanaBlock.insertBefore(asFileInp, bAsanaCreate);   // «Прикрепить файл» — ПЕРЕД «Создать карточку»
    asanaBlock.insertBefore(bAttach, bAsanaCreate);
    asanaBlock.insertBefore(asFileList, bAsanaCreate);

    // ---- Блокировка курса студента в админке (Archived; ничего не удаляем) ----
    blockBlockEl = mkBlock(recPane, 'Блокировка курса в админке', true);
    blockBlockEl.style.display = 'block';
    const blkHint = el('div', S.hint + 'margin-top:0;', 'Закрывает доступ к выбранному курсу (ставит «Archived» в админке). Ничего не удаляется, блокировку можно снять.');
    const blkList = el('div', 'margin-top:6px;');
    blockBlockEl.appendChild(blkHint);
    blockBlockEl.appendChild(blkList);
    const blkRefresh = el('span', 'display:inline-block;margin-top:6px;font-size:11px;color:#6B7280;text-decoration:underline;cursor:pointer;', '↻ обновить список курсов');
    blockBlockEl.appendChild(blkRefresh);
    let blkBusy = false;
    const blkStatusRu = s => ({ available: 'доступен', blocked: 'заблокирован', expired: 'истёк' }[String(s).toLowerCase()] || s);
    const renderBlkList = (courses) => {
      blkList.innerHTML = '';
      courses.forEach(c => {
        const blocked = String(c.status).toLowerCase() === 'blocked';
        const row = el('div', 'display:flex;gap:8px;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid #EEF0F2;');
        const txt = el('div', 'min-width:0;flex:1 1 auto;');
        txt.appendChild(el('div', 'font-size:12px;font-weight:600;color:#1F2937;word-break:break-word;', c.company || ('курс ' + c.uid)));
        txt.appendChild(el('div', 'font-size:11px;color:' + (blocked ? '#B45309' : '#6B7280') + ';', blkStatusRu(c.status)));
        row.appendChild(txt);
        const b = el('button', S.small, blocked ? 'Разблокировать' : 'Заблокировать');
        b.style.cssText += 'width:auto;flex:0 0 auto;margin-top:0;padding:5px 10px;';
        b.onclick = async () => {
          if (blkBusy) return;
          const what = blocked ? 'РАЗБЛОКИРОВАТЬ' : 'ЗАБЛОКИРОВАТЬ';
          if (!window.confirm(what + ' курс «' + (c.company || c.uid) + '» для «' + (clean(T.name) || 'студента') + '»?\n\n' +
            (blocked ? 'Доступ к курсу снова откроется.' : 'Студент потеряет доступ к этому курсу (ничего не удаляется, можно разблокировать).'))) return;
          blkBusy = true; b.disabled = true; statusBox.style.color = '#374151';
          statusBox.textContent = (blocked ? 'Разблокирую' : 'Блокирую') + ' курс «' + (c.company || c.uid) + '»…';
          try {
            await adminSetArchived(c.uid, !blocked);
            c.status = blocked ? 'available' : 'blocked';
            statusBox.style.color = '#15803D';
            statusBox.textContent = '✓ Курс «' + (c.company || c.uid) + '» ' + (blocked ? 'разблокирован' : 'заблокирован') + ' (проверено по админке).';
            renderBlkList(courses);
          } catch (e) {
            statusBox.style.color = '#B45309';
            statusBox.textContent = '⚠️ ' + (e && e.message === 'NOAUTH' ? 'Админка не пустила: открой eduson.tv/admin в соседней вкладке, войди и повтори' : ((e && e.message) || e)) + '. Проверь курс в админке вручную.';
          }
          blkBusy = false; b.disabled = false;
        };
        row.appendChild(b);
        blkList.appendChild(row);
      });
    };
    // список курсов грузится сам при открытии вкладки «Доступ» (отдельной кнопки «показать» нет)
    let blkLoaded = false;
    const loadCourses = async () => {
      if (blkBusy) return;
      blkBusy = true;
      blkList.innerHTML = '';
      blkList.appendChild(el('div', 'font-size:11.5px;color:#6B7280;', 'Загружаю курсы студента из админки…'));
      try {
        const courses = await adminStudentCourses();
        renderBlkList(courses);
        blkLoaded = true;
      } catch (e) {
        blkList.innerHTML = '';
        blkList.appendChild(el('div', 'font-size:11.5px;color:#B45309;line-height:1.4;',
          '⚠️ ' + (e && e.message === 'NOAUTH' ? 'Админка не пустила: открой eduson.tv/admin в соседней вкладке, войди и нажми «обновить список»' : ((e && e.message) || e))));
      }
      blkBusy = false;
    };
    blkRefresh.onclick = () => loadCourses();
    tabHooks[5] = () => { if (!blkLoaded && !blkBusy) loadCourses(); if (renderOmni) renderOmni(); };

    // ---- Карточка OmniDesk: «Дата окончания поддержки» + пометки (воз, замороз) + галочка возврата ----
    // Формат как в образце (обращение 736-620950): «25.09.2027 (воз, замороз)». Дата остаётся ТА ЖЕ, что в поле;
    // дописываются пометки в скобках. Галочка — «Сделали возврат» (#field_8788) или «Частичный возврат» (#field_11808).
    omniBlockEl = mkBlock(recPane, 'Карточка OmniDesk', true);
    omniBlockEl.style.display = 'block';
    const omCur = el('div', 'font-size:12px;color:#374151;line-height:1.5;word-break:break-word;', '');
    const mkOmChk = (label, type, checked, name) => {
      const l = el('label', 'display:flex;gap:6px;align-items:center;font-size:12px;cursor:pointer;');
      const i = el('input', 'margin:0;'); i.type = type; i.checked = checked; if (name) i.name = name;
      l.appendChild(i); l.appendChild(document.createTextNode(label));
      return { l: l, i: i };
    };
    const rbFull = mkOmChk('Сделали возврат', 'radio', true, 'rm-omni-flag'), rbPart = mkOmChk('Частичный возврат', 'radio', false, 'rm-omni-flag');
    const omFlag = el('div', 'display:flex;gap:16px;margin-top:6px;flex-wrap:wrap;align-items:center;');
    omFlag.appendChild(el('span', 'font-size:11px;color:#6B7280;', 'Галочка:'));
    omFlag.appendChild(rbFull.l); omFlag.appendChild(rbPart.l);
    const bOmni = el('button', S.big, 'Записать в карточку');
    omniBlockEl.appendChild(omCur); omniBlockEl.appendChild(omFlag); omniBlockEl.appendChild(bOmni);

    // ---- Метка в сделке амо: «Полный возврат» / «Частичный возврат» (вкладка «Доступ») ----
    // Метка ДОБАВЛЯЕТСЯ к уже стоящим (остальные не трогаем). Полный возврат в амо заведён дважды (разного цвета):
    // нужна ОРАНЖЕВАЯ. Если цвет определить не удалось — мастер покажет обе метки на выбор и запомнит ответ.
    const amoTagBlockEl = mkBlock(recPane, 'Метка в сделке амо', true);
    amoTagBlockEl.style.display = 'block';
    const tagRow = el('div', 'display:flex;gap:6px;');
    const bTagFull = el('button', S.big, 'Полный возврат');
    const bTagPart = el('button', S.btnAlt, 'Частичный возврат');
    [bTagFull, bTagPart].forEach(b => { b.style.cssText += 'flex:1 1 0;margin-top:0;padding:7px 6px;font-size:12px;'; });
    tagRow.appendChild(bTagFull); tagRow.appendChild(bTagPart);
    const tagNote = el('div', 'font-size:11.5px;line-height:1.45;margin-top:6px;color:#6B7280;', 'Поставит метку в карточке сделки амо (остальные метки останутся).');
    const tagChoose = el('div', 'display:none;margin-top:6px;');
    amoTagBlockEl.appendChild(tagRow); amoTagBlockEl.appendChild(tagNote); amoTagBlockEl.appendChild(tagChoose);
    let tagBusy = false;
    const tagLeadId = () => (String(T.amoLink || '').match(/leads\/detail\/(\d+)/) || [])[1] || String(T.dealId || '');
    const tagSay = (txt, color) => { tagNote.textContent = txt; tagNote.style.color = color || '#6B7280'; };
    const putTag = async (tag, leadId) => {
      const lead = await gmAmoJson('GET', '/api/v4/leads/' + leadId);
      const have = ((lead._embedded && lead._embedded.tags) || []).map(t => ({ id: t.id }));
      if (have.some(t => t.id === tag.id)) { tagSay('Метка «' + tag.name + '» уже стоит в сделке ' + leadId + '.', '#15803D'); return; }
      await gmAmoJson('PATCH', '/api/v4/leads/' + leadId, { _embedded: { tags: have.concat([{ id: tag.id }]) } });
      const after = await gmAmoJson('GET', '/api/v4/leads/' + leadId);
      const ok = ((after._embedded && after._embedded.tags) || []).some(t => t.id === tag.id);
      if (!ok) throw new Error('амо приняло запрос, но метка не появилась — проверь сделку вручную');
      tagSay('✓ Метка «' + tag.name + '» поставлена в сделке ' + leadId + ' (проверено).', '#15803D');
    };
    const setReturnTag = async (kind) => {
      if (tagBusy) return;
      const leadId = tagLeadId();
      if (!leadId) { tagSay('Не вижу номера сделки в амо — нажми «↻ амо» вверху.', '#B45309'); return; }
      const want = kind === 'full' ? /^полн\S*\s+возврат/i : /^частичн\S*\s+возврат/i;
      const label = kind === 'full' ? 'Полный возврат' : 'Частичный возврат';
      tagBusy = true; bTagFull.disabled = bTagPart.disabled = true; tagChoose.style.display = 'none';
      tagSay('Ищу метку «' + label + '» в амо…', '#374151');
      try {
        const cands = (await amoAllLeadTags()).filter(t => want.test(t.name.trim()));
        if (!cands.length) throw new Error('в амо нет метки «' + label + '»');
        let tag = null;
        if (cands.length === 1) tag = cands[0];
        else {
          const remembered = String(GM_getValue('rm_tag_' + kind, ''));
          tag = cands.find(t => String(t.id) === remembered) || null;
          if (!tag) { const orange = cands.filter(t => isOrangeHex(t.color)); if (orange.length === 1) tag = orange[0]; }
        }
        if (!tag) {
          // не смогли выбрать сами — пусть куратор укажет один раз, дальше запомним
          tagSay('В амо несколько меток «' + label + '». Нажми оранжевую (выбор запомню):', '#B45309');
          tagChoose.innerHTML = ''; tagChoose.style.display = 'flex'; tagChoose.style.gap = '6px'; tagChoose.style.flexWrap = 'wrap';
          cands.forEach(t => {
            const b = el('button', 'border:1px solid #D1D5DB;border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer;font-family:inherit;background:' + (t.color || '#F3F4F6') + ';color:#1F2937;', t.name + (t.color ? '' : ' · №' + t.id));
            b.title = 'Метка №' + t.id + (t.color ? ' · цвет ' + t.color : '');
            b.onclick = async () => {
              try { GM_setValue('rm_tag_' + kind, String(t.id)); } catch (e) { /* ignore */ }
              tagChoose.style.display = 'none';
              tagBusy = true; bTagFull.disabled = bTagPart.disabled = true;
              try { await confirmAndPut(t, leadId); } catch (e) { tagFail(e); }
              tagBusy = false; bTagFull.disabled = bTagPart.disabled = false;
            };
            tagChoose.appendChild(b);
          });
        } else {
          await confirmAndPut(tag, leadId);
        }
      } catch (e) { tagFail(e); }
      tagBusy = false; bTagFull.disabled = bTagPart.disabled = false;
    };
    const confirmAndPut = async (tag, leadId) => {
      if (!window.confirm('Поставить метку «' + tag.name + '» в сделке ' + leadId + '?\n\nОстальные метки в сделке сохранятся.')) { tagSay('Отменено: метка не ставилась.', '#6B7280'); return; }
      tagSay('Ставлю метку «' + tag.name + '»…', '#374151');
      await putTag(tag, leadId);
    };
    const tagFail = (e) => {
      const m = (e && e.message) || String(e);
      tagSay('Не получилось: ' + (m === 'NOAUTH' ? 'амо не пустило, обнови вкладку амо в этом браузере и повтори' : m) + '. Поставь метку руками: ' + 'в карточке сделки, в верхней строке с метками.', '#B45309');
    };
    recPane.insertBefore(amoTagBlockEl, omniBlockEl);   // порядок на вкладке: блокировка курса → метка в амо → карточка OmniDesk
    bTagFull.onclick = () => setReturnTag('full');
    bTagPart.onclick = () => setReturnTag('part');
    // ---- Заметка в обращении: ссылки на строку таблицы и карточку Асаны (ТОЛЬКО скрытая заметка, клиенту ничего не уходит) ----
    const noteBlockEl = mkBlock(recPane, 'Заметка в обращении', true);
    noteBlockEl.appendChild(el('div', S.hint + 'margin-top:0;', 'Добавляет в СКРЫТУЮ заметку обращения ссылки на строку таблицы и карточку Асаны. Клиенту ничего не уходит: если поле не в режиме заметки, мастер откажется и ничего не напишет.'));
    const notePrev = el('div', 'margin-top:6px;font-size:11.5px;color:#374151;white-space:pre-wrap;word-break:break-all;background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;padding:6px 8px;', '');
    const bNote = el('button', S.big, 'Добавить ссылки в заметку');
    noteBlockEl.appendChild(notePrev); noteBlockEl.appendChild(bNote);
    // ссылки и так уходят в заметку сами (autoNoteFn) — ручной блок не нужен; код оставлен на случай, если захочется вернуть
    (noteBlockEl.parentNode && noteBlockEl.parentNode !== recPane ? noteBlockEl.parentNode : noteBlockEl).style.display = 'none';
    const noteText = () => {
      const L = []; const n = parseInt(String(T.sentRow || ''), 10);
      if (n) L.push('Строка в таблице возвратов: ' + SHEET_URL + '&range=' + n + ':' + n);
      if (T.asanaUrl) L.push('Карточка в Асане: ' + T.asanaUrl);
      return L.join('\n');
    };
    const renderNote = () => { notePrev.textContent = noteText() || 'Пока нечего добавлять: нет ни строки в таблице, ни карточки Асаны.'; };
    // Проверка: поле действительно в режиме СКРЫТОЙ ЗАМЕТКИ. Нужны ВСЕ признаки сразу:
    //  • подсказка «скрытую заметку» (в textarea или в самом редакторе Redactor — у куратора в рабочем статусе она там),
    //  • фон блока заметки (chat_orange2_bg_ / chat_orange2_bg / bg-add-note),
    //  • кнопка «ДОБАВИТЬ» (а не «ОТПРАВИТЬ») и подпись «CTRL+ENTER для добавления».
    // Иначе — отказ: текст мог бы уйти клиенту.
    const omniNoteBox = () => {
      const ta = document.querySelector('#comment');
      if (!ta) return { ok: false, why: 'не нашла поле для заметки на странице' };
      const wrap = ta.closest('.chat_msg_win_box_wrap');
      const area = ta.closest('.chat_chat_msg_win_wrap') || document;
      const btn = area.querySelector('.btn_add_reply');
      const ed = wrap && wrap.querySelector('.redactor-editor, [contenteditable="true"]');
      const phs = [ta.placeholder || '', ed ? (ed.getAttribute('placeholder') || ed.getAttribute('data-placeholder') || '') : ''];
      const phOk = phs.some(p => /скрыт\S*\s+заметк/i.test(p));
      const bgOk = !!(wrap && (wrap.classList.contains('chat_orange2_bg_') || wrap.classList.contains('chat_orange2_bg') || wrap.classList.contains('bg-add-note')));
      const btnOk = !!(btn && /^\s*добавить\s*$/i.test(btn.textContent || ''));
      const hintEl = area.querySelector('.for-reply-text');
      const hintOk = !hintEl || /добавлени/i.test(hintEl.textContent || '');
      if (!(phOk && bgOk && btnOk && hintOk)) return { ok: false, why: 'поле сейчас НЕ в режиме скрытой заметки (может уйти клиенту) — ничего не отправляю', ta: ta, wrap: wrap, area: area, btn: btn };
      return { ok: true, ta: ta, wrap: wrap, area: area, btn: btn, ed: ed };
    };
    // кнопка-переключатель «Добавить заметку (N)» рядом с редактором (повторное нажатие возвращает режим ответа)
    const omniSwitchEl = () => Array.from(document.querySelectorAll('.chat_btn_connect_c')).find(e => /заметк/i.test((e.title || '') + ' ' + (e.getAttribute('data-original-title') || '')));
    let noteBusy = false;
    const noteDone = {};   // уже добавленные тексты (чтобы не плодить одинаковые заметки)
    // Добавить скрытую заметку. Сам включает режим заметки (если сейчас «ответ клиенту»), проверяет все признаки
    // до вставки, после вставки и перед нажатием, затем возвращает режим как был. → {ok, why}
    // Текст заметки: ссылки вставляем КЛИКАБЕЛЬНЫМИ (<a href>), с короткой подписью вместо длинного адреса.
    const noteEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const noteLinkTxt = u => /docs\.google\.com/.test(u) ? 'строка ' + ((u.match(/range=(\d+)/) || [])[1] || 'в таблице') : (/asana\.com/.test(u) ? 'открыть карточку' : u);
    const noteVisible = text => String(text).replace(/https?:\/\/[^\s<]+/g, u => noteLinkTxt(u));
    const noteHtml = text => noteEsc(text).replace(/https?:\/\/[^\s<]+/g, u => {
      const raw = u.replace(/&amp;/g, '&');
      return '<a href="' + noteEsc(raw) + '">' + noteEsc(noteLinkTxt(raw)) + '</a>';
    }).replace(/\n/g, '<br>');
    // ПИСЬМО (/staff/cases/record/…): поля #comment нет — заметка добавляется через ссылку «Добавить заметку»
    // и всплывающее окно «Добавление заметки к обращению» (#noteCont + кнопка #note_button). Окно — только для заметок,
    // клиенту оно ничего не отправляет. Поле «уведомить сотрудника» (#note_staff_id) не трогаем.
    const omniAddNoteMail = async (text) => {
      const vis = noteVisible(text);
      const isVis = e => !!(e && (e.offsetParent || e.getClientRects().length));
      const modal = document.querySelector('.add-note-cont');
      const ta0 = document.querySelector('#noteCont');
      if (!modal || !ta0) return { ok: false, why: 'не нашла окно заметки в письме' };
      const link = Array.from(document.querySelectorAll('a.a_link_add_note_js')).find(isVis);
      if (!link) return { ok: false, why: 'не нашла ссылку «Добавить заметку» в письме' };
      link.click();
      let ta = null;
      for (let i = 0; i < 16; i++) { await omSleep(250); ta = document.querySelector('#noteCont'); if (isVis(ta)) break; }
      if (!isVis(ta)) return { ok: false, why: 'окно заметки не открылось' };
      const closeModal = () => { try { const c = document.querySelector('.mfp-close'); if (c) c.click(); } catch (e) { /* ignore */ } };
      if (!/заметк/i.test((modal.textContent || '').slice(0, 200))) { closeModal(); return { ok: false, why: 'окно не похоже на окно заметки — ничего не пишу' }; }
      if ((ta.value || '').trim()) { closeModal(); return { ok: false, why: 'в окне заметки уже что-то написано — очисти и повтори' }; }
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, text);
      ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new Event('change', { bubbles: true }));
      await omSleep(400);
      const btn = document.querySelector('#note_button');
      if (!btn || (ta.value || '').indexOf(text.slice(0, 20)) < 0) { closeModal(); return { ok: false, why: 'текст не встал в окно заметки' }; }
      btn.click();
      const snippet = vis.split('\n')[0].replace(/\s+/g, '').slice(-24);
      let seen = false;
      for (let i = 0; i < 30 && !seen; i++) {
        await omSleep(300);
        const gone = !isVis(document.querySelector('#noteCont'));
        seen = gone && (document.body.innerText || '').replace(/\s+/g, '').indexOf(snippet) >= 0;
      }
      if (!seen) return { ok: false, why: 'не уверена, что заметка добавилась — проверь обращение' };
      noteDone[text] = 1;
      return { ok: true };
    };
    const omniAddNote = async (text) => {
      if (!document.querySelector('#comment') && document.querySelector('#noteCont')) return omniAddNoteMail(text);
      const vis = noteVisible(text);
      let toggled = false;
      let box = omniNoteBox();
      if (!box.ok) {
        const isReply = !!(box.btn && /^\s*отправить\s*$/i.test(box.btn.textContent || ''));
        const sw = omniSwitchEl();
        if (isReply && sw) {
          sw.click(); toggled = true;
          for (let i = 0; i < 12; i++) { await omSleep(250); box = omniNoteBox(); if (box.ok) break; }
        }
      }
      const switchBack = () => { if (!toggled) return; const sw = omniSwitchEl(); if (sw && omniNoteBox().ok) { try { sw.click(); } catch (e) { /* ignore */ } } };
      if (!box.ok) { switchBack(); return { ok: false, why: box.why }; }
      try {
        const box2 = omniNoteBox();
        if (!box2.ok) throw new Error(box2.why);
        const ed = box2.wrap.querySelector('.redactor-editor, [contenteditable="true"]');
        if (ed) {
          if ((ed.innerText || '').trim()) throw new Error('в поле заметки уже что-то написано — очисти его и повтори');
          ed.focus();
          document.execCommand('insertHTML', false, noteHtml(text));   // кликабельные ссылки
        } else {
          if ((box2.ta.value || '').trim()) throw new Error('в поле заметки уже что-то написано — очисти его и повтори');
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box2.ta, text);
          box2.ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
        await omSleep(500);
        const box3 = omniNoteBox();   // режим не должен был измениться
        if (!box3.ok) throw new Error(box3.why);
        const cur = ed ? (ed.innerText || '') : (box3.ta.value || '');
        if (cur.replace(/\s+/g, '').indexOf(vis.split('\n')[0].replace(/\s+/g, '').slice(0, 30)) < 0) throw new Error('текст не вставился в поле заметки');
        box3.btn.click();
        const snippet = vis.split('\n')[0].replace(/\s+/g, '').slice(-24);
        let seen = false;
        for (let i = 0; i < 25 && !seen; i++) {
          await omSleep(300);
          const left = ed ? (ed.innerText || '').trim() : (box3.ta.value || '').trim();
          seen = !left && (document.body.innerText || '').replace(/\s+/g, '').indexOf(snippet) >= 0;
        }
        if (!seen) throw new Error('не уверена, что заметка добавилась — проверь обращение');
        noteDone[text] = 1;
        switchBack();
        return { ok: true };
      } catch (e) {
        switchBack();
        return { ok: false, why: (e && e.message) || String(e) };
      }
    };
    // автоматически, сразу после действия: kind = 'row' | 'asana'; результат дописывается в строку статуса
    // АВТОЗАМЕТКА ОТКЛЮЧЕНА по просьбе Натальи (страх, что ссылка уйдёт клиенту): скрипт больше ничего не пишет в поле обращения.
    // Код ниже никем не вызывается (autoNoteFn остаётся null); ручной блок «Заметка в обращении» скрыт и тоже отключён.
    const _autoNoteDisabled = async (kind) => {
      const text = kind === 'row'
        ? (parseInt(String(T.sentRow || ''), 10) ? 'Строка в таблице возвратов: ' + SHEET_URL + '&range=' + T.sentRow + ':' + T.sentRow : '')
        : (T.asanaUrl ? 'Карточка в Асане: ' + T.asanaUrl : '');
      if (!text || noteDone[text]) return;
      for (let i = 0; i < 40 && noteBusy; i++) await omSleep(400);   // если уже идёт другая заметка — ждём очереди
      if (noteBusy || noteDone[text]) return;
      noteBusy = true;
      const r = await omniAddNote(text);
      noteBusy = false;
      if (r.ok) { statusAdd(' ✓ Ссылка добавлена в скрытую заметку.'); }
      else {
        try { GM_setClipboard(text); } catch (e) { /* ignore */ }
        statusBox.style.color = '#B45309';
        // провал заметки скрывать нельзя — показываем сразу, рядом с итогом
        if (statusDet && statusDet.isConnected) statusBox.insertBefore(document.createTextNode(' · ⚠️ заметка не добавлена, ссылка в буфере'), statusBox.childNodes[1]);
        statusAdd(' ⚠️ В заметку не добавила (' + r.why + '). Ссылка в буфере — вставь в заметку руками.');
      }
    };
    bNote.disabled = true;
    const _manualNoteDisabled = async () => {
      if (noteBusy) return;
      const text = noteText();
      if (!text) { statusBox.style.color = '#B45309'; statusBox.textContent = 'Пока нечего добавлять: сначала запиши строку в таблицу и/или создай карточку Асаны.'; return; }
      if (noteDone[text] && !window.confirm('Эти же ссылки уже добавлялись в заметку. Добавить ещё раз?')) return;
      if (!window.confirm('Добавить в СКРЫТУЮ заметку обращения:\n\n' + text + '\n\nКлиент её не увидит. Добавить?')) return;
      noteBusy = true; bNote.disabled = true; statusBox.style.color = '#374151'; statusBox.textContent = 'Добавляю заметку…';
      const r = await omniAddNote(text);
      noteBusy = false; bNote.disabled = false;
      if (r.ok) { statusBox.style.color = '#15803D'; statusBox.textContent = '✓ Заметка добавлена в обращение (скрытая, клиенту не видна).'; }
      else {
        try { GM_setClipboard(text); } catch (e) { /* ignore */ }
        statusBox.style.color = '#B45309';
        statusBox.textContent = '⚠️ Не добавила заметку: ' + r.why + '. Ссылки в буфере — вставь руками.';
      }
    };
    const renderOmni = () => { const cur = omniCardField(7301); omCur.textContent = 'Дата окончания поддержки сейчас: ' + (cur || '— пусто —'); renderNote(); };
    const omSleep = ms => new Promise(r => setTimeout(r, ms));
    const omVis = e => !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length));
    const omNorm = s => String(s || '').replace(/\s+/g, ' ').trim();
    let omBusy = false;
    bOmni.onclick = async () => {
      if (omBusy) return;
      const cur = omniCardField(7301);
      const dm = String(cur || '').match(/\d{1,2}\.\d{1,2}\.\d{4}/);
      if (!dm) { statusBox.style.color = '#B45309'; statusBox.textContent = 'В поле «Дата окончания поддержки» нет даты — впиши её в карточке вручную, потом повтори.'; return; }
      // пометки дописываются ВСЕГДА: «(воз, замороз)»
      const newVal = dm[0] + ' (воз, замороз)';
      const flagId = rbFull.i.checked ? '8788' : '11808';
      const flagName = rbFull.i.checked ? 'Сделали возврат' : 'Частичный возврат';
      if (!window.confirm('Записать в карточку этого обращения:\n\n• Дата окончания поддержки: ' + newVal + '\n• Галочка: «' + flagName + '»\n\nСохранить?')) return;
      omBusy = true; bOmni.disabled = true; statusBox.style.color = '#374151';
      statusBox.textContent = 'Записываю в карточку OmniDesk…';
      try {
        const saveShown = () => Array.from(document.querySelectorAll('a.info_save')).some(omVis);
        if (!saveShown()) {   // карточка открывается на правку по «редактировать»
          const ed = Array.from(document.querySelectorAll('.info_edit, a[class*="edit"]')).find(e => omVis(e) && /редактир|изменить/i.test(e.textContent || ''));
          if (!ed) throw new Error('не нашла «редактировать» в карточке');
          ed.click();
          for (let i = 0; i < 20 && !saveShown(); i++) await omSleep(150);
          await omSleep(400);
          if (!saveShown()) throw new Error('карточка не перешла в режим правки');
        }
        const inp = document.getElementById('field_7301');
        if (!inp) throw new Error('поле «Дата окончания поддержки» не нашлось');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inp, newVal);
        inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true }));
        const cb = document.getElementById('field_' + flagId);
        if (!cb) throw new Error('галочка «' + flagName + '» не нашлась');
        if (!cb.checked) {   // красивые галочки (iCheck) переключаются кликом по «ins.iCheck-helper»
          const helper = cb.parentElement && cb.parentElement.querySelector('.iCheck-helper');
          if (helper) helper.click(); else { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
          await omSleep(200);
        }
        if (!cb.checked) throw new Error('галочка «' + flagName + '» не поставилась');
        Array.from(document.querySelectorAll('a.info_save')).filter(omVis).forEach(a => a.click());
        for (let i = 0; i < 25; i++) { await omSleep(300); if (!saveShown()) break; }
        await omSleep(700);
        const after = omniCardField(7301), cb2 = document.getElementById('field_' + flagId);
        if (omNorm(after) !== omNorm(newVal) || !(cb2 && cb2.checked))
          throw new Error('после сохранения в карточке «' + omNorm(after) + '» — не совпало, проверь вручную');
        statusBox.style.color = '#15803D';
        statusBox.textContent = '✓ В карточке: ' + newVal + ', галочка «' + flagName + '» (проверено).';
        renderOmni();
      } catch (e) {
        statusBox.style.color = '#B45309';
        statusBox.textContent = '⚠️ Не получилось записать в карточку: ' + ((e && e.message) || e) + '. Проверь поле в карточке и допиши вручную.';
      }
      omBusy = false; bOmni.disabled = false;
    };


    // порядок блоков по смыслу: на «Решении» — расчёт → оплата → итог; на «Согласовании» — продакт → РГ
    msgPane.insertBefore(tgBlock, rgBlock);
    renderAsana();

    // № строки → подпись кнопки
    const updateRowLabels = () => {
      bAll.textContent = 'Копировать строку';
      bAll.title = 'Скопировать всю строку A–X, вставить в ячейку A' + (T.rowNumber || '?') + ' (Ctrl+V)';
    };
    rowNumInput.addEventListener('input', () => {
      T.rowNumber = rowNumInput.value.replace(/\D/g, ''); rowNumInput.value = T.rowNumber;
      rowNumInput.style.background = ''; // куратор поправил вручную — снимаем подсветку автопоиска
      GM_setValue('rm_row', T.rowNumber); saveCase(); updateRowLabels();
    });
    updateRowLabels();
    // При каждом открытии мастера сам ищем свободную строку: поле подсвечивается жёлтым — куратор сверяет и при необходимости правит.
    findRowInto('auto');

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
    // Панель теперь узкая и фиксированного размера (ручной ресайз убран, как в Хэлпере).
    let collapsed = GM_getValue('rm_collapsed') === '1';
    // Свернуть (–): прячем тело и статус.
    const applyCollapsed = () => {
      body.style.display = collapsed ? 'none' : 'flex';
      if (collapsed) infoBox.style.display = 'none';
      statusCollapsed = collapsed; syncStatusVis();
      panel.style.minHeight = collapsed ? '0' : '200px';
      bCollapse.textContent = collapsed ? '▢' : '–';
    };
    applyCollapsed();
    bCollapse.onclick = () => { collapsed = !collapsed; GM_setValue('rm_collapsed', collapsed ? '1' : '0'); applyCollapsed(); };
    bClose.onclick = () => { if (panel) { panel.remove(); panel = null; } };

    document.documentElement.appendChild(panel);
    // Таблицу открываем в фоне заранее, чтобы «Отправить» было быстрым, — но НЕ при простом открытии мастера
    // (тимлид и другие смотрят, ничего не вписывая), а только когда человек впервые что-то поменял в полях панели.
    // Строку не ищем и ничего не пишем — только открываем страницу; сама закроется, если не понадобится.
    let sheetWarmed = false;
    const warmSheetOnce = () => { if (sheetWarmed) return; sheetWarmed = true; try { ensureSheetTab(); } catch (e) { /* ignore */ } };
    // прогрев отключён (Наталья: таблица открывалась при смене статуса) — вкладка теперь открывается только по «Отправить»/«Обновить»
    // panel.addEventListener('input', warmSheetOnce, true);
    // panel.addEventListener('change', warmSheetOnce, true);
    makeDraggable(panel, head);
    renderAmoCard();
    updateScenario();

    // автосбор из амо. force=true (кнопка «🔄 амо») — всегда свежий сбор, мимо прогрева.
    const refreshFromAmo = function (force) {
      statusBox.textContent = (!force && _rmWarm.running && _rmWarm.caseId === rmCaseId())
        ? 'Дособираю данные из амо…' : 'Собираю данные из амо…';
      statusBox.style.color = '#374151';
      getWarmData(force).then(d => {
        if (!d) throw new Error('пустой сбор');
        T.amoLink = d.amoLink; T.omniLink = d.omniLink; T.purchaseDate = d.purchaseDate; T.mopFromNote = d.mopFromNote;
        const setF = (k, v) => { if (v) { T[k] = v; if (inputs[k] && inputs[k]._fill) inputs[k]._fill(v); else if (inputs[k]) inputs[k].value = v; } };
        setF('name', d.name); setF('course', d.course); setF('cluster', d.cluster);
        setF('payType', d.payType); setF('amount', d.amount); setF('mop', d.mop);
        if (d.purchaseDate) setF('accessDate', d.purchaseDate);
        // Тег РГ — по МОПу (кто продал). Не затираем то, что куратор уже вписал.
        if (d.mop && !clean(T.rgTag)) {
          const rg = rgByMop(d.mop);
          if (rg) { T.rgTag = rg; if (inputs.rgTag) inputs.rgTag.value = rg; }
        }
        // «Пройдено, %» — «0» тоже валидно (setF его бы пропустил как falsy).
        // Для ресейла/детских, если админка ничего не дала, ставим 0 (в ресейле % не знаем).
        if (d.progress !== '') { T.progress = d.progress; if (inputs.progress) inputs.progress.value = d.progress; saveCase(); }
        else if (markScen() && !clean(T.progress)) { T.progress = '0'; if (inputs.progress) inputs.progress.value = '0'; saveCase(); }
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

        _rkClusterApplied = ''; // после свежего сбора из амо — заново подставить кластер по сценарию
        syncAgreed(); renderAmoCard(); updateScenario();
        loadCalcDuration(d.course); // ак.ч. + дни для калькулятора — по названию курса

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
          (_pctDebug ? '\nПроцент: ' + _pctDebug : '') +
          (d.mop
            ? '\nМОП: ' + d.mop + (d.mopFromNote ? ' (из сообщения о продаже)' : ' (ОТВЕТСТВЕННЫЙ сделки — проверь!)')
            : '\nМОП не нашла — впиши руками, кто продал курс.') +
          (what.length < 6 ? '\nПусто? Открой карточку клиента в OmniDesk (виджет amoCRM) и нажми 🔄' : '');
        // в панели — только короткая строка
        const manyCourses = (T.deals || []).length > 1;
        statusBox.style.fontWeight = '';
        if (manyCourses) {
          statusBox.textContent = 'В амо несколько заявок (' + T.deals.length + '): открой жёлтую плашку в «Данных из амо» и выбери курс или объедини заявки.';
          statusBox.style.color = '#B45309';
        } else if (!what.length) {
          statusBox.textContent = '⚠️ Из амо почти ничего — проверь карточку в OmniDesk, детали в «ℹ️»';
          statusBox.style.color = '#DC2626';
        } else if (what.length < 6 || !mopSure) {
          statusBox.textContent = '⚠️ Из амо' + (d.amoId ? ' (сделка ' + d.amoId + ')' : '') +
            (!mopSure ? ' · МОП проверь' : ' · часть полей пуста') + ' — детали в «ℹ️»';
          statusBox.style.color = '#B45309';
        } else {
          statusBox.textContent = '';   // всё собралось — молчим (детали по «ⓘ»)
        }
      }).catch(e => {
        statusBox.textContent = e.message === 'NOAUTH'
          ? 'Амо не пустило 😕 Открой-обнови вкладку амо в этом браузере и нажми «🔄 амо».'
          : (e.message === 'пустой сбор'
            ? 'Из амо ничего не собралось — открой карточку клиента в OmniDesk (виджет amoCRM) и нажми «🔄 амо».'
            : 'Ошибка амо: ' + e.message);
        statusBox.style.color = '#DC2626';
      });
    };
    bRefresh.onclick = () => refreshFromAmo(true);
    refreshFromAmo();
  }

  /* ---------- фоновый прогрев (как в Хэлпере) ---------- */
  // При открытии чата в фоне собираем данные из амо + ищем свободную строку, чтобы клик
  // по «🌀 Возврат-мастер» открывал панель уже готовой. Выключить — RM_WARM_ON_LOAD = false.
  const RM_WARM_ON_LOAD = true;
  const rmCaseId = () => (location.pathname.match(/(\d{2,4}-\d{5,})/) || [])[1] || '';
  let _rmWarm = { caseId: '', ts: 0, running: false, data: null, rowInfo: null };
  let _rmWarmedCase = '';

  function withPageCache(fn) {
    if (_rmPageCache) return Promise.resolve().then(fn); // уже есть активный кэш (идёт прогрев)
    _rmPageCache = new Map();
    return Promise.resolve().then(fn).then(
      v => { _rmPageCache = null; return v; },
      e => { _rmPageCache = null; throw e; }
    );
  }

  async function prewarm() {
    if (!RM_WARM_ON_LOAD || !location.hostname.endsWith('omnidesk.ru')) return;
    const cid = rmCaseId();
    if (!cid || cid === _rmWarmedCase) return;
    // сайдбар/виджет амо ещё не подгрузился — подождём следующего тика
    const refs = grabAmoRefs();
    if (!omniCardField(2) && !omniCardField(16) && !refs.leads.length && !refs.contacts.length && !grabSeedFromPage()) return;
    _rmWarmedCase = cid;
    _rmWarm = { caseId: cid, ts: 0, running: true, data: null, rowInfo: null };
    _rmPageCache = new Map();
    try {
      // свободную строку таблицы заранее больше не ищем — её ищет кнопка «Отправить»
      const data = await collectRefundData().catch(() => null);
      if (rmCaseId() !== cid) return; // куратор ушёл на другой чат
      _rmWarm.data = data;
      _rmWarm.rowInfo = null;
      _rmWarm.ts = Date.now();
    } catch (e) { /* тихо — при клике будет полный сбор */ }
    finally { _rmPageCache = null; if (_rmWarm.caseId === cid) _rmWarm.running = false; }
  }

  // Данные для панели: из свежего прогрева, либо ждём идущий прогрев, либо собираем сами.
  function getWarmData(force) {
    const cid = rmCaseId();
    const fresh = _rmWarm.caseId === cid && _rmWarm.ts && Date.now() - _rmWarm.ts < 600000;
    if (!force && fresh && _rmWarm.data) return Promise.resolve(_rmWarm.data);
    if (!force && _rmWarm.running && _rmWarm.caseId === cid) {
      return new Promise(res => {
        let n = 0;
        const iv = setInterval(() => {
          if (!_rmWarm.running || _rmWarm.caseId !== cid || n++ > 80) { clearInterval(iv); res(null); }
        }, 150);
      }).then(() => (_rmWarm.data && _rmWarm.caseId === cid) ? _rmWarm.data : withPageCache(collectRefundData));
    }
    return withPageCache(collectRefundData);
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

  // Раньше здесь крутился setInterval каждые 2 с — постоянная фоновая нагрузка на страницу
  // OmniDesk, даже когда ничего не менялось. Теперь реагируем на реальные изменения DOM
  // (с коротким дебаунсом) + редкий страховочный проход, и ничего не делаем в фоновой вкладке.
  function keepSynced(fn) {
    let pending = false;
    const kick = function () {
      if (pending) return;
      pending = true;
      setTimeout(function () { pending = false; try { fn(); } catch (e) {} }, 200);
    };
    try {
      new MutationObserver(kick).observe(document.body || document.documentElement,
        { childList: true, subtree: true });
    } catch (e) { /* нет MutationObserver — останется страховочный интервал */ }
    window.addEventListener('popstate', kick);
    setInterval(function () { if (!document.hidden) { try { fn(); } catch (e) {} } }, 5000);
    try { fn(); } catch (e) {}
  }

  if (location.hostname === 'docs.google.com') {
    if (location.pathname.indexOf(CALC_ID) >= 0) calcWorker();   // вкладка калькулятора, открытая мастером
  } else if (location.hostname.endsWith('omnidesk.ru')) {
    console.log(TAG, 'запущен, версия ' + '1.34.7');
    keepSynced(function () {
      removeLauncher();
      ensureMenuItem();
      try { prewarm(); } catch (e) { /* прогрев не критичен */ }
    });
  }
})();
