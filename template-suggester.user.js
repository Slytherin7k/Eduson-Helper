// ==UserScript==
// @name         Эдюсон — Подсказчик шаблонов
// @namespace    eduson-curator
// @version      0.4.0
// @description  Автоматически предлагает подходящие шаблоны OmniDesk на вопрос клиента. Панель в левом сайдбаре обращения. Ничего не отправляет — вставку и отправку делает куратор.
// @author       Наталья + Claude
// @match        https://eduson.omnidesk.ru/staff/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      eduson.omnidesk.ru
// @updateURL    https://raw.githubusercontent.com/Slytherin7k/Eduson-Helper/main/template-suggester.user.js
// @downloadURL  https://raw.githubusercontent.com/Slytherin7k/Eduson-Helper/main/template-suggester.user.js
// ==/UserScript==

(function () {
  'use strict';

  var VER = '0.4.0';
  var TAG = '[Подсказчик шаблонов]';
  var log = function () { try { console.log.apply(console, [TAG].concat([].slice.call(arguments))); } catch (e) {} };

  // ------------------------------------------------------------------
  //  Ключи хранилища
  // ------------------------------------------------------------------
  var K_INDEX = 'ts_index_v1';       // { ts, items:[{id,name,cat,kind}] }
  var K_BODY  = 'ts_body_';          // + id  ->  { ts, text }
  var K_LEARN = 'ts_learn_v1';       // { picks:[], tok:{ token: { tplId: weight } } }
  var K_UI    = 'ts_ui_v1';          // { collapsed:bool, view:'suggest'|'my' }
  var K_MYANS = 'ts_myans_v1';       // { items:[{id,q:[tok],text,n,ts,first,course}] }
  var MYANS_MAX = 250;

  var INDEX_TTL = 7 * 24 * 3600 * 1000;    // неделя
  var BODY_TTL  = 30 * 24 * 3600 * 1000;   // месяц

  // ------------------------------------------------------------------
  //  Мелкие утилиты
  // ------------------------------------------------------------------
  function gv(k, d) { try { var v = GM_getValue(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function sv(k, v) { try { GM_setValue(k, JSON.stringify(v)); } catch (e) {} }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  }); }

  function decodeEntities(s) {
    var t = document.createElement('textarea');
    t.innerHTML = s;
    return t.value;
  }

  // HTML шаблона -> обычный текст (для вставки и для сравнения)
  function htmlToText(html) {
    if (!html) return '';
    var s = String(html);
    s = s.replace(/\r/g, '');
    s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
    s = s.replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n');
    s = s.replace(/<\s*li\s*[^>]*>/gi, '• ');
    s = s.replace(/<[^>]+>/g, '');
    s = decodeEntities(s);
    s = s.replace(/ /g, ' ');
    s = s.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n');
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
  }

  // ------------------------------------------------------------------
  //  Токенизация (для сопоставления)
  // ------------------------------------------------------------------
  var STOP = (
    'и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между ' +
    'здравствуйте здравствуй добрый день вечер утро доброе спасибо пожалуйста подскажите скажите помогите прошу очень хочу хотел хотела нужно можете подскажет прошу заранее благодарю извините день ага угу это эта эти этот мой моя мои свой своя ваш ваша ваше просто ещё пока никак ' +
    'отправить отправьте отправила прислать пришлите присылаю получить сделать сказать написать написала подскажете'
  ).split(/\s+/);
  var STOPSET = {};
  STOP.forEach(function (w) { STOPSET[w] = 1; });

  // концепты службы поддержки — приводим разные формулировки к одному корню,
  // чтобы «зайти», «войти», «вход», «логин» считались одним и тем же
  var CONCEPTS = [
    [/^(войт|войд|вход|зайт|зайд|захож|зашл|зашел|залог|логин|авториз|энтер)/, 'вход'],
    [/^парол/, 'пароль'],
    [/^(доступ|достеп|откр(о|ы))/, 'доступ'],
    [/^(регистр|зарегистр|региться|регаться)/, 'регистрация'],
    [/^(оплат|оплач|плат(е|ё)ж|заплат|платил)/, 'оплата'],
    [/^(возврат|вернут|верну|refund|деньг|средств)/, 'возврат'],
    [/^диплом/, 'диплом'],
    [/^(удостовер|упк)/, 'удостоверение'],
    [/^справк/, 'справка'],
    [/^(вычет|ндфл|фнс|налог)/, 'вычет'],
    [/^(продл|продлен|продлит)/, 'продление'],
    [/^поддержк/, 'поддержка'],
    [/^(урок|лекц|модул|заняти|видео)/, 'урок'],
    [/^(домашк|практическ|задани)/, 'дз'],
    [/^(тест|квиз|экзамен|итогов|аттест)/, 'тест'],
    [/^сертификат/, 'сертификат'],
    [/^(договор|оферт|лицензи)/, 'договор'],
    [/^(чек|квитанц)/, 'чек'],
    [/^отзыв/, 'отзыв'],
    [/^(рассрочк|кредит)/, 'рассрочка'],
    [/^куратор/, 'куратор'],
    [/^(преподав|эксперт|методист|спикер|наставник)/, 'эксперт'],
    [/^прогресс/, 'прогресс'],
    [/^(скидк|акци|промокод|дешевл)/, 'скидка'],
    [/^(трудоустр|резюме|ваканси|работодат|стажиров|карьер)/, 'трудоустройство'],
    [/^(приложени|андроид|android|ios|телефон|мобильн)/, 'приложение'],
    [/^(кэш|кеш|браузер|грузит|грузят|виснет|тормоз|ошибк|баг|404)/, 'техпроблема'],
    [/^(перевод|перевест).{0,4}(курс|друг)/, 'переводкурса']
  ];
  function concept(w) {
    for (var i = 0; i < CONCEPTS.length; i++) if (CONCEPTS[i][0].test(w)) return CONCEPTS[i][1];
    return null;
  }

  function stemLite(w) {
    // грубое отсечение частых окончаний
    return w.replace(/(иями|ями|иях|ями|ами|иев|ов|ев|ий|ый|ая|яя|ое|ее|ые|ие|ого|его|ому|ему|ыми|ими|ах|ях|ью|ям|ям|ах|у|ю|а|я|ы|и|е|о|й|ь)$/i, '');
  }

  function tokenize(str) {
    if (!str) return [];
    var s = String(str).toLowerCase().replace(/ё/g, 'е');
    s = s.replace(/https?:\/\/\S+/g, ' ');
    s = s.replace(/[^a-zа-я0-9]+/gi, ' ');
    var out = [];
    s.split(/\s+/).forEach(function (w) {
      if (!w || w.length < 3) return;
      if (STOPSET[w]) return;
      if (/^\d+$/.test(w) && w.length < 4) return;
      var cx = concept(w);
      if (cx) { out.push(cx); return; }
      var st = /[a-z]/.test(w) ? w : stemLite(w);
      if (st.length < 3) st = w;
      if (STOPSET[st]) return;
      out.push(st);
    });
    return out;
  }

  function bag(tokens) {
    var b = {};
    tokens.forEach(function (t) { b[t] = (b[t] || 0) + 1; });
    return b;
  }

  // ------------------------------------------------------------------
  //  HTTP (внутри домена — обычный fetch с cookie)
  // ------------------------------------------------------------------
  function getText(url) {
    return fetch(url, { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) { if (!r.ok) throw new Error(url + ' -> ' + r.status); return r.text(); });
  }
  function getJSON(url) {
    return fetch(url, { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) { if (!r.ok) throw new Error(url + ' -> ' + r.status); return r.json(); });
  }

  // ------------------------------------------------------------------
  //  Индекс шаблонов
  // ------------------------------------------------------------------
  function parseMacrosIndex(html) {
    var d = new DOMParser().parseFromString(html, 'text/html');
    var items = [];
    var seen = {};

    function pushRow(row, kind) {
      var a = row.querySelector('a[href*="/staff/macros/edit/"]');
      if (!a) return;
      var m = a.getAttribute('href').match(/edit\/(\d+)/);
      if (!m) return;
      var id = m[1];
      if (id === '0' || seen[id + kind]) return;
      var nameEl = row.querySelector('.knowledge-item-hd');
      var catEl = row.querySelector('.knowledge-item-amm');
      var name = (nameEl ? nameEl.textContent : row.textContent).replace(/\s+/g, ' ').trim();
      var cat = catEl ? catEl.textContent.replace(/\s+/g, ' ').trim() : '';
      if (!name) return;
      seen[id + kind] = 1;
      items.push({ id: id, name: name, cat: cat, kind: kind });
    }

    var common = d.querySelector('#div_common');
    if (common) common.querySelectorAll('.knowledge-item').forEach(function (r) { pushRow(r, 'common'); });

    var personal = d.querySelector('#div_personal');
    if (personal) personal.querySelectorAll('.lw_item .knowledge-item, .lw_item').forEach(function (r) { pushRow(r, 'personal'); });

    // страховка: если структура поменялась — пробуем плоско
    if (!items.length) {
      d.querySelectorAll('a[href*="/staff/macros/edit/"]').forEach(function (a) {
        var m = a.getAttribute('href').match(/edit\/(\d+)/);
        if (!m || m[1] === '0') return;
        var row = a.closest('.knowledge-item, li, tr') || a.parentElement;
        pushRow(row, 'common');
      });
    }
    return items;
  }

  // IDF: редкие слова важнее частых («excel», «курс», «урок» почти не весят)
  var _idf = {};
  var _idfDefault = 1;
  function buildIdf(items) {
    var N = items.length || 1, df = {};
    items.forEach(function (it) {
      var seen = {};
      for (var t in it.tok) seen[t] = 1;
      if (it.btok) for (var b in it.btok) seen[b] = 1;
      for (var s in seen) df[s] = (df[s] || 0) + 1;
    });
    _idf = {};
    for (var t2 in df) _idf[t2] = Math.log((N + 1) / (df[t2] + 1)) + 0.15;
    _idfDefault = Math.log((N + 1) / 1) + 0.15;
  }
  function idf(t) { return _idf.hasOwnProperty(t) ? _idf[t] : _idfDefault; }

  // токены тела шаблона из уже скачанного кэша (если есть)
  function bodyTokensFor(id) {
    var c = gv(K_BODY + id, null);
    if (!c || !c.text) return null;
    return bag(tokenize(c.text));
  }

  // у каждого элемента должен быть .tok (в хранилище токены не пишем — там только id/name/cat/kind)
  function hydrate(data) {
    if (data && data.items) {
      data.items.forEach(function (it) {
        if (!it.tok) it.tok = bag(tokenize(it.name + ' ' + it.cat));
        if (!it.ntok) it.ntok = Object.keys(it.tok).length || 1;
        if (!it.btok) { var bt = bodyTokensFor(it.id); if (bt) { it.btok = bt; it.nbtok = Object.keys(bt).length || 1; } }
      });
      buildIdf(data.items);
    }
    return data;
  }

  var _indexPromise = null;
  function loadIndex(force) {
    var cached = gv(K_INDEX, null);
    if (!force && cached && cached.items && cached.items.length && (Date.now() - cached.ts) < INDEX_TTL) {
      return Promise.resolve(hydrate(cached));
    }
    if (_indexPromise) return _indexPromise;
    _indexPromise = getText('/staff/macros/')
      .then(function (html) {
        var items = parseMacrosIndex(html);
        if (!items.length) throw new Error('индекс пуст');
        var data = hydrate({ ts: Date.now(), items: items });
        sv(K_INDEX, { ts: data.ts, items: items.map(function (i) { return { id: i.id, name: i.name, cat: i.cat, kind: i.kind }; }) });
        log('индекс загружен:', items.length, 'шаблонов');
        return data;
      })
      .catch(function (e) {
        log('ошибка индекса', e);
        if (cached && cached.items) return hydrate(cached);
        throw e;
      })
      .then(function (d) { _indexPromise = null; return d; }, function (e) { _indexPromise = null; throw e; });
    return _indexPromise;
  }

  // ------------------------------------------------------------------
  //  Тело шаблона (текст ответа)
  // ------------------------------------------------------------------
  function parseMacroBody(html) {
    var d = new DOMParser().parseFromString(html, 'text/html');
    var best = '';
    d.querySelectorAll('textarea').forEach(function (ta) {
      var n = ta.getAttribute('name') || '';
      if (/\[email_to_user\]\[1\]/.test(n)) {
        var v = ta.value || ta.textContent || '';
        if (v.trim().length > best.length) best = v;
      }
    });
    // запасной вариант — любое поле контента ответа
    if (!best) {
      d.querySelectorAll('textarea').forEach(function (ta) {
        var n = ta.getAttribute('name') || '';
        if (/\[content\]/.test(n) && !/note/.test(n)) {
          var v = ta.value || ta.textContent || '';
          if (v.trim().length > best.length) best = v;
        }
      });
    }
    return best;
  }

  var _bodyInflight = {};
  function loadBody(id) {
    var c = gv(K_BODY + id, null);
    if (c && c.text != null && (Date.now() - c.ts) < BODY_TTL) return Promise.resolve(c.text);
    if (_bodyInflight[id]) return _bodyInflight[id];
    _bodyInflight[id] = getText('/staff/macros/edit/' + id)
      .then(function (html) {
        var raw = parseMacroBody(html);
        var text = htmlToText(raw);
        sv(K_BODY + id, { ts: Date.now(), text: text, raw: raw });
        delete _bodyInflight[id];
        return text;
      })
      .catch(function (e) { delete _bodyInflight[id]; log('тело', id, e); return ''; });
    return _bodyInflight[id];
  }
  function loadBodyRaw(id) {
    return loadBody(id).then(function () {
      var c = gv(K_BODY + id, null);
      return c ? (c.raw || '') : '';
    });
  }

  // очередь на прогрев тел (не более N параллельно)
  function warmBodies(ids, conc) {
    conc = conc || 4;
    var i = 0;
    function next() {
      if (i >= ids.length) return Promise.resolve();
      var id = ids[i++];
      return loadBody(id).then(next);
    }
    var runners = [];
    for (var k = 0; k < conc; k++) runners.push(next());
    return Promise.all(runners);
  }

  // фоновая вычитка ВСЕХ текстов шаблонов (для поиска по тексту). Раз в неделю.
  var K_CRAWL = 'ts_crawl_v1';   // { ts, done, total }
  var _crawling = false;
  function crawlBodies(items, force, onProgress) {
    if (_crawling) return Promise.resolve();
    var st = gv(K_CRAWL, null);
    if (!force && st && st.done >= items.length * 0.9 && (Date.now() - st.ts) < INDEX_TTL) {
      return Promise.resolve();
    }
    _crawling = true;
    var ids = items.map(function (i) { return i.id; });
    var done = 0, idx = 0, conc = 5;
    function tickProg() {
      done++;
      if (done % 10 === 0 || done === ids.length) {
        sv(K_CRAWL, { ts: Date.now(), done: done, total: ids.length });
        if (onProgress) onProgress(done, ids.length);
      }
    }
    function next() {
      if (idx >= ids.length) return Promise.resolve();
      var id = ids[idx++];
      return loadBody(id).then(function () {
        tickProg();
        return new Promise(function (r) { setTimeout(r, 40); }).then(next);
      });
    }
    var runners = [];
    for (var k = 0; k < conc; k++) runners.push(next());
    return Promise.all(runners).then(function () {
      sv(K_CRAWL, { ts: Date.now(), done: ids.length, total: ids.length });
      _crawling = false;
      if (onProgress) onProgress(ids.length, ids.length);
    }, function () { _crawling = false; });
  }

  // ------------------------------------------------------------------
  //  Обучение
  // ------------------------------------------------------------------
  function learnData() {
    return gv(K_LEARN, { picks: [], tok: {} });
  }
  function learnPick(qTokens, tplId, course) {
    var L = learnData();
    L.picks = L.picks || [];
    L.picks.push({ q: qTokens.slice(0, 40), t: tplId, c: course || '', ts: Date.now() });
    if (L.picks.length > 4000) L.picks = L.picks.slice(-3000);
    L.tok = L.tok || {};
    var uniq = {};
    qTokens.forEach(function (tk) {
      if (uniq[tk]) return; uniq[tk] = 1;
      L.tok[tk] = L.tok[tk] || {};
      L.tok[tk][tplId] = (L.tok[tk][tplId] || 0) + 1;
    });
    sv(K_LEARN, L);
    log('запомнила выбор', tplId, 'по словам:', qTokens.slice(0, 8).join(', '));
  }
  function learnedScore(L, qbag, tplId) {
    var s = 0;
    for (var tk in qbag) {
      var row = L.tok[tk];
      if (row && row[tplId]) s += row[tplId];
    }
    return s;
  }

  // ------------------------------------------------------------------
  //  Текущее обращение: вопрос клиента + курс
  // ------------------------------------------------------------------
  function caseId() {
    return window.CurrentCaseId || (location.pathname.match(/\/cases\/(?:chat|record)\/(\d+)/) || [])[1] || null;
  }
  function isEmailCase() { return /\/cases\/record\//.test(location.pathname); }

  function sidebarValue(label) {
    label = label.toUpperCase();
    var scope = document.querySelectorAll('.right_info_panels *, #info_panel_wrap *, .sidebar *, .sidebar-cont *, .r_sidebar *');
    for (var i = 0; i < scope.length; i++) {
      var e = scope[i];
      if (e.children.length === 0 && e.textContent.trim().toUpperCase() === label) {
        var p = e.parentElement;
        if (p) {
          var txt = (p.innerText || '').replace(new RegExp(label, 'i'), '').replace(/\s+/g, ' ').trim();
          if (txt) return txt;
        }
        if (e.nextElementSibling) return e.nextElementSibling.textContent.replace(/\s+/g, ' ').trim();
      }
    }
    return '';
  }

  function caseCourse() {
    return sidebarValue('КУРС') || sidebarValue('COURSE') || '';
  }

  function caseSubject() {
    var t = (document.title || '').replace(/\s*[—-]\s*OmniDesk.*$/i, '').trim();
    return t;
  }

  // последний блок реплик клиента (после нашего последнего ответа), иначе — последняя реплика клиента
  function clientQuestion() {
    var cid = caseId();
    if (!cid) return Promise.resolve({ text: caseSubject(), course: caseCourse() });
    return getJSON('/staff/json-messages/' + cid).then(function (j) {
      var msgs = (j.messages || []).filter(function (m) { return !m.b_note; });
      var lastStaff = -1;
      for (var i = 0; i < msgs.length; i++) if (msgs[i].staff_fullname) lastStaff = i;
      var tail = [];
      for (var k = msgs.length - 1; k > lastStaff && k >= 0; k--) {
        if (msgs[k].user_fullname) tail.unshift(msgs[k]);
      }
      if (!tail.length) {
        for (var q = msgs.length - 1; q >= 0; q--) { if (msgs[q].user_fullname) { tail.unshift(msgs[q]); break; } }
      }
      var text = tail.map(function (m) { return htmlToText(m.content || ''); }).join('\n');
      return { text: (caseSubject() + '\n' + text).trim(), course: caseCourse(), raw: text };
    }).catch(function (e) {
      log('вопрос клиента', e);
      return { text: caseSubject(), course: caseCourse() };
    });
  }

  // ------------------------------------------------------------------
  //  Скоринг
  // ------------------------------------------------------------------
  // совпадение запроса с названием+категорией шаблона (с поправкой на «раздутость» названия)
  function overlapScore(qbag, tbag, ntok) {
    var s = 0;
    for (var tk in qbag) {
      if (tbag[tk]) s += idf(tk) * (1 + Math.min(tk.length, 10) / 10);
    }
    if (ntok && ntok > 6) s = s / Math.sqrt(ntok / 6);
    return s;
  }

  var BODY_WEIGHT = 0.45;
  // общий балл: название/категория (полный вес) + текст шаблона (пониженный вес, по факту наличия слова)
  function itemScore(qbag, it) {
    var s = overlapScore(qbag, it.tok, it.ntok);
    if (it.btok) {
      var b = 0;
      for (var tk in qbag) {
        if (it.btok[tk] && !it.tok[tk]) b += idf(tk) * (1 + Math.min(tk.length, 10) / 10);
      }
      // тело большое — нормируем сильнее, чтобы длинные шаблоны не выигрывали объёмом
      if (it.nbtok && it.nbtok > 12) b = b / Math.sqrt(it.nbtok / 12);
      s += BODY_WEIGHT * b;
    }
    return s;
  }

  function rank(index, question) {
    var qbag = bag(tokenize(question.text));
    var courseBag = bag(tokenize(question.course || ''));
    var L = learnData();
    var learnMax = 1;

    var scored = index.items.map(function (it) {
      var base = itemScore(qbag, it);
      // курс: совпадение курса с категорией/названием шаблона
      var cb = 0;
      if (Object.keys(courseBag).length) {
        for (var ck in courseBag) if (it.tok[ck]) cb += idf(ck) * 1.2;
      }
      var ls = learnedScore(L, qbag, it.id);
      if (ls > learnMax) learnMax = ls;
      return { it: it, base: base, cb: cb, ls: ls };
    });

    scored.forEach(function (r) {
      r.score = r.base + r.cb + (r.ls / learnMax) * 5;
      if (r.it.kind === 'personal' && r.base > 0) r.score += 0.3;
    });

    // «Мои ответы» — участвуют в подсказках наравне с шаблонами
    var my = (myAnswers().items || []);
    my.forEach(function (a) {
      var qn = (a.q || []).length || 1, hit = 0;
      (a.q || []).forEach(function (t) { if (qbag[t]) hit++; });
      var atok = bag(tokenize(a.text));
      var abody = 0;
      for (var tk in qbag) if (atok[tk]) abody += idf(tk) * (1 + Math.min(tk.length, 10) / 10);
      var na = Object.keys(atok).length || 1;
      if (na > 12) abody = abody / Math.sqrt(na / 12);
      var s = (hit / qn) * 6 + BODY_WEIGHT * abody + Math.min(a.n || 1, 8) * 0.5;
      if (s < 1.2) return;
      var it = { kind: 'my', id: a.id, name: myTitle(a.text), cat: '', text: a.text, n: a.n || 1 };
      scored.push({ it: it, base: s, cb: 0, ls: 0, score: s });
    });

    scored.sort(function (a, b) { return b.score - a.score; });
    return scored;
  }

  // ------------------------------------------------------------------
  //  Вставка текста в поле ответа (Redactor 3, page-world)
  // ------------------------------------------------------------------
  function insertIntoReply(text) {
    var email = isEmailCase();
    var id = email ? 'response_html' : 'comment';
    var payload = JSON.stringify(String(text));
    // ЧАТ (#comment): поле ответа — ПРОСТОЙ <textarea>. Пишем в него обычный текст напрямую,
    // Redactor НЕ трогаем. `$R('#comment').insertion.set` включал богатый редактор с панелью
    // форматирования (которой быть не должно) и оборачивал текст в «<p>…</p>» → они уходили
    // клиенту и деформировали поле. Если богатый редактор уже был активирован — сносим его.
    // ПОЧТА (#response_html): письму нужен HTML — там работаем через Redactor.
    var code;
    if (email) {
      code = '(function(){try{var T=' + payload + ';var app=(window.$R)?$R("#response_html"):null;var ta=document.getElementById("response_html");' +
        'if(app&&app.insertion){app.editor.startFocus();app.insertion.set(T);try{app.selection.collapseToEnd();}catch(e){}' +
        'try{var el=app.editor.getElement().nodes[0];if(ta){ta.value=el.innerHTML;ta.dispatchEvent(new Event("input",{bubbles:true}));ta.dispatchEvent(new Event("change",{bubbles:true}));}' +
        'el.dispatchEvent(new Event("input",{bubbles:true}));}catch(e){}document.documentElement.setAttribute("data-ts-insert","ok");}' +
        'else if(ta){ta.value=T;ta.dispatchEvent(new Event("input",{bubbles:true}));ta.dispatchEvent(new Event("change",{bubbles:true}));document.documentElement.setAttribute("data-ts-insert","ok-plain");}' +
        'else{document.documentElement.setAttribute("data-ts-insert","err:no field");}' +
        '}catch(e){document.documentElement.setAttribute("data-ts-insert","err:"+(e&&e.message||e));}})();';
    } else {
      code = '(function(){try{var T=' + payload + ';var ta=document.getElementById("comment");' +
        'if(!ta){document.documentElement.setAttribute("data-ts-insert","err:no field");return;}' +
        'try{if(window.$R&&document.querySelector(".redactor-box")){$R("#comment","destroy");}}catch(e){}' +
        'ta.style.display="";' +
        'var setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set;' +
        'if(setter)setter.call(ta,T);else ta.value=T;' +
        'ta.dispatchEvent(new Event("input",{bubbles:true}));' +
        'ta.dispatchEvent(new Event("change",{bubbles:true}));' +
        'ta.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));' +
        'document.documentElement.setAttribute("data-ts-insert","ok");' +
        '}catch(e){document.documentElement.setAttribute("data-ts-insert","err:"+(e&&e.message||e));}})();';
    }
    var s = document.createElement('script');
    s.textContent = code;
    document.documentElement.appendChild(s);
    s.remove();
    var res = document.documentElement.getAttribute('data-ts-insert') || '';
    document.documentElement.removeAttribute('data-ts-insert');
    log('вставка:', res);
    return res.indexOf('ok') === 0;
  }

  function replyIsEmpty() {
    var id = isEmailCase() ? 'response_html' : 'comment';
    var ta = document.getElementById(id);
    var v = ta ? (ta.value || '') : '';
    v = v.replace(/<[^>]+>/g, '').replace(/&nbsp;| |\s/g, '');
    return v.length === 0;
  }

  // ------------------------------------------------------------------
  //  Пассивное обучение: замечаем, каким шаблоном куратор ответил
  // ------------------------------------------------------------------
  function similar(a, b) {
    // доля слов шаблона, встретившихся в отправленном тексте
    var ta = bag(tokenize(a)), tb = tokenize(b), hit = 0, tot = 0;
    var seen = {};
    tb.forEach(function (t) { if (seen[t]) return; seen[t] = 1; tot++; if (ta[t]) hit++; });
    return tot ? hit / tot : 0;
  }

  function jaccard(a, b) {
    var ba = {}, n = 0;
    tokenize(a).forEach(function (t) { ba[t] = 1; });
    var seen = {};
    tokenize(b).forEach(function (t) { if (seen[t]) return; seen[t] = 1; if (ba[t]) n++; });
    var u = Object.keys(ba).length + Object.keys(seen).length - n;
    return u ? n / u : 0;
  }

  // ---- «Мои ответы»: свободно напечатанные ответы куратора с счётчиком ----
  function myAnswers() { return gv(K_MYANS, { items: [] }); }
  function saveMyAnswers(d) { sv(K_MYANS, d); }
  function myTitle(text) {
    var t = String(text).replace(/\s+/g, ' ').trim();
    var m = t.match(/^.{0,90}?[.!?…](\s|$)/);
    var s = (m ? m[0] : t).trim();
    if (s.length > 80) s = s.slice(0, 78) + '…';
    return s || t.slice(0, 60);
  }

  // словарь «дежурных» слов — если ВЕСЬ ответ состоит только из них, это просто «да, конечно» / «спасибо»
  var ACK_WORDS = {};
  ('да нет ок окей хорошо конечно спасибо большое огромное вам благодарю благодарствую принято поняла понял ' +
   'понятно ясно все всё уже готово договорились верно так не за что пожалуйста всегда рада рад была был ' +
   'помочь помогу помогать хорошего доброго дня вечера утра всего доброе добрый вечер утро и тоже вам взаимно ' +
   'отлично супер замечательно прекрасно здорово обращайтесь если что')
    .split(' ').forEach(function (w) { ACK_WORDS[w] = 1; });

  function isJustAck(text) {
    var norm = String(text).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я\s]/gi, ' ').replace(/\s+/g, ' ').trim();
    if (!norm) return true;
    var words = norm.split(' ');
    for (var i = 0; i < words.length; i++) {
      if (words[i].length > 1 && !ACK_WORDS[words[i]]) return false;
    }
    return true;
  }

  function rememberMyAnswer(qTokens, text, course, manual) {
    if (!text) return;
    text = String(text).replace(/[ \t]+\n/g, '\n').trim();
    var words = text.replace(/\s+/g, ' ').trim().split(' ');
    if (manual) {
      if (text.length < 10) { toast('В поле ответа пусто или совсем коротко.'); return; }
    } else {
      // авто: запоминаем от одного предложения; пропускаем только «дежурные» короткие фразы
      if (words.length < 3 || text.length < 16) return;
      if (isJustAck(text)) return;
    }
    var d = myAnswers();
    d.items = d.items || [];
    var qb = bag(qTokens);
    var best = null, bestScore = 0;
    d.items.forEach(function (it) {
      var qn = (it.q || []).length || 1, hit = 0;
      (it.q || []).forEach(function (t) { if (qb[t]) hit++; });
      var qsim = hit / qn;
      var asim = jaccard(text, it.text);
      var sc = asim * 0.7 + qsim * 0.3;
      if (sc > bestScore) { bestScore = sc; best = it; }
    });
    if (best && bestScore >= 0.5) {
      best.n = (best.n || 1) + 1;
      best.text = text;                                     // держим самую свежую формулировку
      best.ts = Date.now();
      best.course = course || best.course || '';
      var qs = {}; (best.q || []).forEach(function (t) { qs[t] = 1; });
      qTokens.forEach(function (t) { if (!qs[t]) { best.q.push(t); qs[t] = 1; } });
      best.q = best.q.slice(0, 60);
      toast('Запомнила твой ответ (уже ' + best.n + '×).');
    } else {
      d.items.push({ id: 'my_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4),
        q: qTokens.slice(0, 40), text: text, n: 1, ts: Date.now(), first: Date.now(), course: course || '' });
      toast(manual ? 'Сохранила ответ в «Мои ответы».' : 'Запомнила твой ответ — теперь он в 📊.');
    }
    if (d.items.length > MYANS_MAX) {
      var now = Date.now();
      d.items.sort(function (a, b) {
        return (b.n * 5 + (b.ts > now - 30 * 864e5 ? 3 : 0)) - (a.n * 5 + (a.ts > now - 30 * 864e5 ? 3 : 0));
      });
      d.items = d.items.slice(0, MYANS_MAX);
    }
    saveMyAnswers(d);
  }
  function deleteMyAnswer(id) {
    var d = myAnswers();
    d.items = (d.items || []).filter(function (it) { return it.id !== id; });
    saveMyAnswers(d);
  }

  var _lastQ = null;
  function hookSend() {
    // текст ловим В МОМЕНТ отправки (capture-фаза, до обработчика OmniDesk — поле ещё не очищено)
    document.addEventListener('click', function (e) {
      if (!e.target.closest) return;
      var b = e.target.closest('.btn_add_reply, .js_send_reply, button[type=submit].send, .chat_send');
      if (b && !e.target.closest('.btn_add_note, .js_add_note')) {
        var t = readReplyText();
        setTimeout(function () { onSend(t); }, 60);
      }
    }, true);
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        var t = readReplyText();
        setTimeout(function () { onSend(t); }, 60);
      }
    }, true);
  }
  function readReplyText() {
    var id = isEmailCase() ? 'response_html' : 'comment';
    var ta = document.getElementById(id);
    var t1 = ta ? htmlToText(ta.value || '') : '';
    // если source Redactor'а вдруг ещё не синкнулся — подстрахуемся видимым редактором рядом с полем
    var wrap = ta && ta.closest ? ta.closest('.redactor-box, .chat_msg_win, .msg-box, form, .request-answer') : null;
    var vis = wrap ? wrap.querySelector('.redactor-in, [contenteditable="true"]') : null;
    var t2 = vis ? (vis.innerText || '').trim() : '';
    return t2.length > t1.length ? t2 : t1;
  }
  function onSend(sent) {
    try {
      if (!sent || sent.length < 15 || !_lastQ) return;
      var q = tokenize(_lastQ);
      var idx = gv(K_INDEX, null);
      var best = null, bestSim = 0;
      if (idx) idx.items.forEach(function (it) {
        var c = gv(K_BODY + it.id, null);
        if (!c || !c.text) return;
        var sim = similar(sent, c.text);
        if (sim > bestSim) { bestSim = sim; best = it; }
      });
      if (best && bestSim >= 0.62) {
        learnPick(q, best.id, caseCourse());
        toast('Запомнила: на такой вопрос — «' + best.name + '».');
      } else {
        rememberMyAnswer(q, sent, caseCourse());
      }
    } catch (e) { log('onSend', e); }
  }

  // ------------------------------------------------------------------
  //  UI
  // ------------------------------------------------------------------
  var CSS = [
    '#ts-panel{position:absolute;left:6px;right:6px;bottom:42px;z-index:30;display:flex;flex-direction:column;',
    '  max-height:min(60vh,560px);background:#fff;border:1px solid #dfe3e8;border-radius:9px;',
    '  box-shadow:0 3px 14px rgba(30,40,60,.10);padding:9px 10px;',
    '  font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#2b3038;}',
    '#ts-panel.ts-collapsed{max-height:none;}',
    '#ts-panel *{box-sizing:border-box;}',
    '#ts-head{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;font-weight:700;letter-spacing:.02em;color:#5a6472;text-transform:uppercase;font-size:11px;flex:0 0 auto;}',
    '#ts-head .ts-sp{flex:1;}',
    '#ts-head .ts-ic{color:#9aa3af;font-weight:400;}',
    '#ts-body{margin-top:8px;display:flex;flex-direction:column;min-height:0;flex:1 1 auto;}',
    '#ts-search{width:100%;border:1px solid #d6dbe1;border-radius:6px;padding:6px 8px;font:12px inherit;outline:none;flex:0 0 auto;}',
    '#ts-search:focus{border-color:#3a8fd6;}',
    '#ts-list{margin-top:6px;flex:1 1 auto;overflow-y:auto;overflow-x:hidden;min-height:40px;}',
    '.ts-row{padding:6px 7px;border:1px solid #e6e9ed;border-radius:6px;margin-bottom:5px;cursor:pointer;background:#fff;transition:border-color .12s,background .12s;}',
    '.ts-row:hover{border-color:#3a8fd6;background:#f5faff;}',
    '.ts-row .ts-nm{font-weight:600;color:#1f2933;display:block;margin-bottom:2px;}',
    '.ts-row .ts-meta{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}',
    '.ts-chip{font-size:10px;padding:1px 6px;border-radius:999px;background:#eef1f4;color:#5a6472;white-space:nowrap;}',
    '.ts-chip.k{background:#e7f0fb;color:#2f6fb0;}',
    '.ts-chip.my{background:#e9f7ec;color:#2e8b57;}',
    '.ts-mdel{margin-left:auto;color:#c0c6cd;cursor:pointer;font-size:11px;padding:0 2px;}',
    '.ts-mdel:hover{color:#d9534f;}',
    '.ts-bar{height:3px;border-radius:2px;background:#3a8fd6;margin-top:4px;}',
    '#ts-status{color:#8a929c;font-size:11px;padding:4px 2px;}',
    '#ts-empty{color:#8a929c;font-size:11px;padding:6px 2px;line-height:1.5;}',
    '.ts-refresh,.ts-my,.ts-remember{cursor:pointer;color:#9aa3af;font-size:11px;}',
    '.ts-refresh:hover,.ts-my:hover,.ts-remember:hover{color:#3a8fd6;}',
    '.ts-remember{font-size:14px;font-weight:700;line-height:1;}',
    // всплывающее превью
    '#ts-pop{position:fixed;z-index:99999;width:420px;max-width:92vw;max-height:80vh;overflow:auto;background:#fff;border:1px solid #cfd6dd;border-radius:10px;box-shadow:0 12px 40px rgba(20,30,50,.22);padding:12px;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#2b3038;}',
    '#ts-pop h4{margin:0 0 4px;font-size:13px;color:#1f2933;}',
    '#ts-pop .ts-pmeta{margin:0 0 8px;}',
    '#ts-pop .ts-ptext{white-space:pre-wrap;max-height:44vh;overflow:auto;border:1px solid #eef1f4;border-radius:6px;padding:8px;background:#fafbfc;color:#333;}',
    '#ts-pop .ts-pbtns{display:flex;gap:8px;margin-top:10px;}',
    '#ts-pop button{border:0;border-radius:7px;padding:8px 12px;font:13px inherit;cursor:pointer;}',
    '#ts-pop .ts-ins{background:#2f8fd6;color:#fff;font-weight:600;}',
    '#ts-pop .ts-ins:hover{background:#2478ba;}',
    '#ts-pop .ts-cp{background:#eef1f4;color:#3a4450;}',
    '#ts-pop .ts-cl{background:transparent;color:#8a929c;margin-left:auto;}',
    '#ts-toast{position:fixed;left:16px;bottom:16px;z-index:99999;background:#28313f;color:#fff;padding:9px 13px;border-radius:8px;font:12px/1.4 sans-serif;max-width:340px;box-shadow:0 8px 24px rgba(0,0,0,.25);}'
  ].join('\n');

  function injectCSS() {
    if (document.getElementById('ts-css')) return;
    var st = document.createElement('style');
    st.id = 'ts-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  var _toastT = null;
  function toast(msg) {
    var el = document.getElementById('ts-toast');
    if (!el) { el = document.createElement('div'); el.id = 'ts-toast'; document.body.appendChild(el); }
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(_toastT);
    _toastT = setTimeout(function () { el.style.display = 'none'; }, 4200);
  }

  function catColor(cat) {
    var h = 0;
    for (var i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) % 360;
    return 'hsl(' + h + ',42%,92%)';
  }

  // ---- всплывающее превью ----
  var _pop = null;
  function closePop() { if (_pop) { _pop.remove(); _pop = null; document.removeEventListener('mousedown', outsidePop, true); } }
  function outsidePop(e) { if (_pop && !_pop.contains(e.target) && !e.target.closest('.ts-row')) closePop(); }

  function kindLabel(item) {
    if (item.kind === 'my') return 'мой ответ' + (item.n > 1 ? ' ×' + item.n : '');
    return item.kind === 'personal' ? 'личный' : 'общий';
  }

  function openPop(item, anchorRect, qTokens) {
    closePop();
    var isMy = item.kind === 'my';
    _pop = document.createElement('div');
    _pop.id = 'ts-pop';
    _pop.innerHTML =
      '<h4>' + esc(item.name) + '</h4>' +
      '<div class="ts-pmeta"><span class="ts-chip k">' + esc(kindLabel(item)) + '</span> ' +
      (item.cat ? '<span class="ts-chip">' + esc(item.cat) + '</span>' : '') +
      (isMy ? ' <a href="#" class="ts-del" style="font-size:11px;color:#b06">удалить из памяти</a>' : '') +
      '</div>' +
      '<div class="ts-ptext">Загружаю текст…</div>' +
      '<div class="ts-pbtns">' +
      '<button class="ts-ins" disabled>Вставить в ответ</button>' +
      '<button class="ts-cp" disabled>Копировать</button>' +
      '<button class="ts-cl">Закрыть</button>' +
      '</div>';
    document.body.appendChild(_pop);
    if (isMy) {
      var del = _pop.querySelector('.ts-del');
      if (del) del.onclick = function (e) { e.preventDefault(); deleteMyAnswer(item.id); toast('Удалила из памяти.'); closePop(); if (_question && _index) showRanked(_index, _question); };
    }

    function place() {
      if (!_pop) return;
      var ph = _pop.offsetHeight, pw = _pop.offsetWidth;
      var vw = window.innerWidth, vh = window.innerHeight;
      // по горизонтали: справа от строки, иначе слева, иначе прижать к краю
      var left = anchorRect.right + 12;
      if (left + pw > vw - 12) left = anchorRect.left - pw - 12;
      if (left < 12) left = Math.max(12, vw - pw - 12);
      // по вертикали: если строка в нижней половине экрана — открываем ВВЕРХ
      var top;
      if (anchorRect.top > vh * 0.5) top = anchorRect.bottom - ph;      // низ окошка у низа строки → растёт вверх
      else top = anchorRect.top;                                         // верх окошка у верха строки → растёт вниз
      if (top + ph > vh - 12) top = vh - ph - 12;
      if (top < 12) top = 12;
      _pop.style.top = top + 'px';
      _pop.style.left = left + 'px';
    }
    place();

    _pop.querySelector('.ts-cl').onclick = closePop;
    setTimeout(function () { document.addEventListener('mousedown', outsidePop, true); }, 0);

    var textP = isMy ? Promise.resolve(item.text) : loadBody(item.id);
    textP.then(function (text) {
      if (!_pop) return;
      var box = _pop.querySelector('.ts-ptext');
      var ins = _pop.querySelector('.ts-ins');
      var cp = _pop.querySelector('.ts-cp');
      box.textContent = text || '(в шаблоне нет текста ответа — только действия)';
      place();
      if (text) {
        ins.disabled = false; cp.disabled = false;
        ins.onclick = function () {
          var doIns = function () {
            var ok = insertIntoReply(text);
            if (ok) { learnPick(qTokens, item.id, caseCourse()); toast('Вставила. Проверь и отправь сама.'); closePop(); }
            else { GM_setClipboard(text); toast('Не смогла вставить — текст в буфере, вставь Ctrl+V.'); }
          };
          if (!replyIsEmpty()) {
            if (confirm('В поле ответа уже есть текст. Заменить его?')) doIns();
          } else doIns();
        };
        cp.onclick = function () { GM_setClipboard(text); learnPick(qTokens, item.id, caseCourse()); toast('Скопировала в буфер.'); };
      }
    });
  }

  // ---- панель ----
  // Панель — плавающая карточка в пустом сером месте левого столбца, прижата к низу
  // (над футером «ПАРАМЕТРЫ …»/«ДОПОЛНИТЕЛЬНЫЕ ОПЦИИ»). Работает и в обычном виде, и в «бабле».
  function anchorHost() {
    var footer = document.querySelector('.chat_l_sidebar_footer');
    if (footer && footer.parentElement) return footer.parentElement; // .sidebar-cont
    var title = document.querySelector('.sidebar-cont .sidebar-title');
    if (title && title.parentElement) return title.parentElement;
    return null;
  }

  var _panel = null;
  var _curCase = null;
  var _lastScored = null;
  var _question = null;
  var _myView = false;

  function buildPanel() {
    var host = anchorHost();
    if (!host) return false;
    if (_panel && host.contains(_panel)) return true;

    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

    _panel = document.createElement('div');
    _panel.id = 'ts-panel';
    var ui = gv(K_UI, { collapsed: false });
    if (ui.collapsed) _panel.className = 'ts-collapsed';
    _panel.innerHTML =
      '<div id="ts-head"><span>💬 Подсказка шаблонов</span><span class="ts-sp"></span>' +
      '<span class="ts-remember" title="Запомнить текст из поля ответа как «мой ответ»">＋</span>' +
      '<span class="ts-my" title="Мои частые ответы">📊</span>' +
      '<span class="ts-refresh" title="Обновить базу шаблонов">⟳</span>' +
      '<span class="ts-ic">' + (ui.collapsed ? '▸' : '▾') + '</span></div>' +
      '<div id="ts-body"' + (ui.collapsed ? ' style="display:none"' : '') + '>' +
      '<input id="ts-search" placeholder="Поиск по всем шаблонам…" />' +
      '<div id="ts-status">Загружаю…</div>' +
      '<div id="ts-list"></div>' +
      '</div>';

    host.appendChild(_panel);

    // не отдаём нажатия горячим клавишам OmniDesk
    ['keydown', 'keypress', 'keyup'].forEach(function (ev) {
      _panel.addEventListener(ev, function (e) { e.stopPropagation(); }, false);
    });

    var head = _panel.querySelector('#ts-head');
    var body = _panel.querySelector('#ts-body');
    var icon = _panel.querySelector('.ts-ic');
    _panel.querySelector('.ts-remember').addEventListener('click', function (e) {
      e.stopPropagation();
      var txt = readReplyText();
      if (!txt || txt.length < 12) { toast('Сначала напечатай ответ в поле — потом жми ＋.'); return; }
      rememberMyAnswer(_question ? tokenize(_question.text) : [], txt, caseCourse(), true);
      if (_myView) renderMyList();
    });

    head.addEventListener('click', function (e) {
      if (e.target.classList.contains('ts-refresh') || e.target.classList.contains('ts-my') || e.target.classList.contains('ts-remember')) return;
      var u = gv(K_UI, { collapsed: false });
      u.collapsed = !u.collapsed;
      sv(K_UI, u);
      body.style.display = u.collapsed ? 'none' : '';
      icon.textContent = u.collapsed ? '▸' : '▾';
      _panel.classList.toggle('ts-collapsed', u.collapsed);
    });
    _panel.querySelector('.ts-refresh').addEventListener('click', function (e) {
      e.stopPropagation();
      _panel.querySelector('#ts-status').textContent = 'Обновляю базу…';
      GM_deleteValue(K_CRAWL);
      loadIndex(true).then(function () { toast('Обновляю базу шаблонов и их тексты…'); recompute(true); });
    });
    _panel.querySelector('.ts-my').addEventListener('click', function (e) {
      e.stopPropagation();
      _myView = !_myView;
      _panel.querySelector('.ts-my').style.color = _myView ? '#3a8fd6' : '';
      _panel.querySelector('#ts-search').style.display = _myView ? 'none' : '';
      if (_myView) renderMyList();
      else if (_lastScored) renderRows(_lastScored.slice(0, 6), { statusMsg: suggestStatus() });
    });

    var search = _panel.querySelector('#ts-search');
    var searchT = null;
    search.addEventListener('input', function () {
      clearTimeout(searchT);
      searchT = setTimeout(function () { renderSearch(search.value.trim()); }, 180);
    });

    return true;
  }

  function renderRows(scoredList, opts) {
    var list = _panel.querySelector('#ts-list');
    var status = _panel.querySelector('#ts-status');
    opts = opts || {};
    list.innerHTML = '';
    if (!scoredList.length) {
      list.innerHTML = '<div id="ts-empty">' + (opts.emptyMsg || 'Ничего не нашла.') + '</div>';
      status.textContent = '';
      return;
    }
    var max = scoredList[0].score || 1;
    var qTokens = _question ? tokenize(_question.text) : [];
    scoredList.forEach(function (r) {
      var it = r.it;
      var row = document.createElement('div');
      row.className = 'ts-row';
      var pct = opts.noBar ? 0 : Math.max(8, Math.round((r.score / max) * 100));
      row.innerHTML =
        '<span class="ts-nm">' + esc(it.name) + '</span>' +
        '<span class="ts-meta">' +
        '<span class="ts-chip ' + (it.kind === 'my' ? 'my' : 'k') + '">' + esc(kindLabel(it)) + '</span>' +
        (it.cat ? '<span class="ts-chip" style="background:' + catColor(it.cat) + '">' + esc(it.cat) + '</span>' : '') +
        '</span>' +
        (opts.noBar ? '' : '<div class="ts-bar" style="width:' + pct + '%"></div>');
      row.addEventListener('click', function () {
        openPop(it, row.getBoundingClientRect(), qTokens);
      });
      list.appendChild(row);
    });
    status.textContent = opts.statusMsg || '';
  }

  // ---- список «Мои частые ответы» ----
  function renderMyList() {
    var list = _panel.querySelector('#ts-list');
    var status = _panel.querySelector('#ts-status');
    var items = (myAnswers().items || []).slice().sort(function (a, b) {
      return (b.n || 1) - (a.n || 1) || b.ts - a.ts;
    });
    list.innerHTML = '';
    status.textContent = 'мои ответы: ' + items.length + ' (учатся сами по мере работы)';
    if (!items.length) {
      list.innerHTML = '<div id="ts-empty">Пока пусто. Отвечай как обычно — скрипт запомнит те ответы, что печатаешь руками, и повторы посчитает.</div>';
      return;
    }
    items.forEach(function (a) {
      var it = { kind: 'my', id: a.id, name: myTitle(a.text), cat: a.course ? a.course.slice(0, 22) : '', text: a.text, n: a.n || 1 };
      var row = document.createElement('div');
      row.className = 'ts-row';
      row.innerHTML =
        '<span class="ts-nm">' + esc(it.name) + '</span>' +
        '<span class="ts-meta"><span class="ts-chip my">×' + (a.n || 1) + '</span>' +
        (it.cat ? '<span class="ts-chip">' + esc(it.cat) + '</span>' : '') +
        '<span class="ts-mdel" data-id="' + esc(a.id) + '" title="Удалить">✕</span></span>';
      row.querySelector('.ts-mdel').addEventListener('click', function (e) {
        e.stopPropagation();
        deleteMyAnswer(a.id); renderMyList();
      });
      row.addEventListener('click', function () { openPop(it, row.getBoundingClientRect(), _question ? tokenize(_question.text) : []); });
      list.appendChild(row);
    });
  }

  function renderSearch(q) {
    if (!q) { if (_lastScored) renderRows(_lastScored.slice(0, 6), { statusMsg: suggestStatus() }); return; }
    loadIndex().then(function (index) {
      var qb = bag(tokenize(q));
      var ql = q.toLowerCase().replace(/ё/g, 'е');
      var res = index.items.map(function (it) {
        var hay = (it.name + ' ' + it.cat).toLowerCase().replace(/ё/g, 'е');
        var sub = hay.indexOf(ql) >= 0 ? 6 : 0;
        return { it: it, score: itemScore(qb, it) + sub };
      }).filter(function (r) { return r.score > 0; });
      res.sort(function (a, b) { return b.score - a.score; });
      renderRows(res.slice(0, 25), { noBar: true, statusMsg: 'найдено: ' + res.length, emptyMsg: 'По запросу ничего нет.' });
    });
  }

  function suggestStatus() {
    if (!_question) return '';
    var c = _question.course ? ' · курс: ' + _question.course : '';
    return 'по вопросу клиента' + c;
  }

  var _index = null;

  function showRanked(index, question, extraStatus) {
    var scored = rank(index, question);
    _lastScored = scored;
    if (_myView) return scored;                        // открыт список «Мои ответы» — не трогаем
    var floor = Math.max(1.5, (scored[0] ? scored[0].score : 0) * 0.30);
    var top = scored.filter(function (r) { return r.score >= floor; }).slice(0, 6);
    if (top.length < 2) top = scored.slice(0, 3);
    var weak = !scored[0] || scored[0].score < 3;
    var base = weak ? 'уверенного совпадения нет — попробуй поиск' : suggestStatus();
    renderRows(top, { statusMsg: base + (extraStatus ? ' · ' + extraStatus : '') });
    return scored;
  }

  function recompute(force) {
    if (!_panel) return;
    var cid = caseId();
    _curCase = cid;
    var status = _panel.querySelector('#ts-status');
    if (status) status.textContent = 'Читаю вопрос…';

    Promise.all([loadIndex(force), clientQuestion()]).then(function (arr) {
      var index = arr[0], question = arr[1];
      _index = index;
      _question = question;
      _lastQ = question.raw || question.text;

      var st = gv(K_CRAWL, null);
      var crawlNote = (!st || st.done < index.items.length * 0.9)
        ? 'читаю тексты шаблонов ' + (st ? st.done : 0) + '/' + index.items.length : '';
      showRanked(index, question, crawlNote);
      warmBodies((_lastScored || []).slice(0, 14).map(function (r) { return r.it.id; }), 4);

      // фоном дочитываем все тексты шаблонов; по мере готовности — пересчитываем
      var lastRerank = 0;
      setTimeout(function () {
        crawlBodies(index.items, force, function (done, total) {
          if (!_panel || _curCase !== cid) return;
          var now = Date.now();
          if (done === total || now - lastRerank > 4000) {
            lastRerank = now;
            hydrate(index);                       // подтянуть новые it.btok из кэша
            if (_question) showRanked(index, _question, done === total ? '' : 'читаю тексты ' + done + '/' + total);
          }
        });
      }, 3000);
    }).catch(function (e) {
      log('recompute', e);
      if (status) status.textContent = 'Не удалось загрузить базу шаблонов. Нажми ⟳.';
    });
  }

  // ------------------------------------------------------------------
  //  Жизненный цикл (SPA)
  // ------------------------------------------------------------------
  function tick() {
    if (!/\/staff\/cases\/(chat|record)\//.test(location.pathname)) {
      if (_panel) { _panel.remove(); _panel = null; _curCase = null; }
      return;
    }
    injectCSS();
    var built = buildPanel();
    if (!built) return;
    var cid = caseId();
    if (cid && cid !== _curCase) {
      closePop();
      recompute(false);
    }
  }

  // Раньше tick крутился по setInterval каждые 1.5 с — постоянная фоновая нагрузка на OmniDesk,
  // даже когда на странице ничего не менялось. Теперь реагируем на реальные изменения DOM
  // (с коротким дебаунсом) + редкий страховочный проход, и ничего не делаем в фоновой вкладке.
  function keepSynced(fn) {
    var pending = false;
    var kick = function () {
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

  injectCSS();
  hookSend();
  keepSynced(tick);
  log('готов, версия', VER);
})();
