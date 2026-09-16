// ==UserScript==
// @name         Eduson — Вечернее закрытие обращений
// @namespace    eduson-evening-close
// @version      1.2.0
// @description  С 19:56 до 20:50 автоматически вставляет прощальный шаблон в поле ответа во всех открытых обращениях OmniDesk. НЕ отправляет — отправляешь и закрываешь сама.
// @author       Astanina Natalia
// @homepageURL  https://github.com/Slytherin7k/Eduson-Helper
// @updateURL    https://raw.githubusercontent.com/Slytherin7k/Eduson-Helper/main/evening-close.user.js
// @downloadURL  https://raw.githubusercontent.com/Slytherin7k/Eduson-Helper/main/evening-close.user.js
// @match        https://*.omnidesk.ru/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ============================ НАСТРОЙКИ ============================ */

  // Окно работы (часы компьютера, у Натальи = московское). Формат "ЧЧ:ММ".
  const START = '19:56';
  const END   = '20:50';

  // Поставить true — скрипт вставляет шаблон в любое время (для проверки). В работе — false.
  const FORCE_ON = false;

  // Текст прощания. Правится здесь.
  const TEXT =
    'Больше от вас не поступало сообщений, поэтому предполагаю, что вопросов пока нет. ' +
    'Обращение закрываю, но если что-то понадобится — обязательно пишите, мы с радостью поможем! ' +
    'Работаем каждый день с 8:00 до 20:00 по московскому времени. 🙂 Доброго вечера!';

  // По первым словам скрипт понимает, что шаблон уже вставлен (не дублирует, умеет «убрать»).
  const MARK = 'Больше от вас не поступало сообщений';

  const TAG = '[Вечернее закрытие]';
  const ACC = '#0284C7';
  const FONT = '"Nunito","Segoe UI",Arial,sans-serif';

  /* ============================ ВРЕМЯ ============================ */

  function toMin(hhmm) { const p = hhmm.split(':'); return (+p[0]) * 60 + (+p[1]); }
  const START_M = toMin(START), END_M = toMin(END);

  function inWindow() {
    if (FORCE_ON) return true;
    const d = new Date();
    const m = d.getHours() * 60 + d.getMinutes();
    return m >= START_M && m <= END_M;
  }

  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }
  function isDisabledToday() {
    try { return GM_getValue('ec_disabled_date', '') === todayStr(); } catch (e) { return false; }
  }
  function setDisabledToday() {
    try { GM_setValue('ec_disabled_date', todayStr()); } catch (e) {}
  }

  /* ============================ СТРАНИЦА ОБРАЩЕНИЯ ============================ */

  // Определяем тип открытого обращения по URL.
  //  email  → поле ответа = редактор #response_html
  //  chat   → поле ответа клиенту = редактор #comment (Телеграм/ВК/виджет)
  function ticketInfo() {
    const p = location.pathname;
    let kind = null;
    if (/\/staff\/cases\/record\//.test(p)) kind = 'email';
    else if (/\/staff\/cases\/chat\//.test(p)) kind = 'chat';
    if (!kind) return null;
    const num = (p.match(/(\d{2,4}-\d{4,})/) || [])[1] || '';
    if (!num) return null;
    return { kind: kind, key: kind + ':' + num, num: num };
  }

  // Запуск кода в контексте страницы (там живут $R, jQuery, глобалы OmniDesk).
  // Ответ — через атрибут data-ecx на <html>. Тот же приём, что в основном Помощнике.
  function pageOp(bodyCode) {
    return new Promise(function (resolve) {
      try { document.documentElement.removeAttribute('data-ecx'); } catch (e) {}
      try {
        const s = document.createElement('script');
        s.textContent =
          '(function(){var R={};try{' + bodyCode +
          '}catch(e){R.err=(e&&e.message)||String(e);}' +
          'document.documentElement.setAttribute("data-ecx",JSON.stringify(R));})();';
        document.documentElement.appendChild(s);
        s.remove();
      } catch (e) { resolve({ err: 'инъекция не прошла' }); return; }
      let n = 0;
      const iv = setInterval(function () {
        const r = document.documentElement.getAttribute('data-ecx');
        if (r || n++ > 60) {
          clearInterval(iv);
          try { document.documentElement.removeAttribute('data-ecx'); } catch (e) {}
          let parsed; try { parsed = JSON.parse(r || '{"err":"страница не ответила"}'); }
          catch (e) { parsed = { err: 'ответ не разобрать' }; }
          resolve(parsed);
        }
      }, 50);
    });
  }

  function consts(kind) {
    return 'var KIND=' + JSON.stringify(kind) +
           ';var TEXT=' + JSON.stringify(TEXT) +
           ';var MARK=' + JSON.stringify(MARK) + ';';
  }

  // ЧАТ (#comment) — это ПРОСТОЙ <textarea>, Redactor к нему не трогаем (иначе появляется
  // панель форматирования и текст оборачивается в «<p>…</p>», которые уходят клиенту).
  // ПОЧТА (#response_html) — там Redactor нужен (письму нужен HTML).
  const FIND_EDITOR =
    'var RID=(KIND==="chat")?"comment":"response_html";' +
    'var ta=document.getElementById(RID);' +
    'var app=null,node=null;' +
    'if(KIND==="email"){try{app=window.$R("#"+RID);node=(app&&app.editor)?app.editor.getElement().nodes[0]:null;}catch(e){}}' +
    'function taVal(){return ta?String(ta.value||""):"";}' +
    'function bodyText(){return KIND==="chat"?taVal().replace(/<[^>]*>/g," ").replace(/\\uFEFF/g,"").trim()' +
    ' :((node?(node.innerText||node.textContent||""):taVal()).replace(/\\uFEFF/g,"").trim());}' +
    'function setTa(v){try{var st=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set;if(st)st.call(ta,v);else ta.value=v;}catch(e){ta.value=v;}' +
    ' ta.dispatchEvent(new Event("input",{bubbles:true}));ta.dispatchEvent(new Event("change",{bubbles:true}));}';

  const PROBE_BODY = FIND_EDITOR +
    'if(KIND==="chat"){' +
    ' R.hasEditor=!!(ta && ta.offsetParent!==null);' +
    ' R.editorEmpty=!bodyText();' +
    ' R.hasMark=taVal().indexOf(MARK)!==-1;' +
    ' var rb=document.querySelector(".btn_add_reply");var fr=document.querySelector(".for-reply-text");' +
    ' R.replyMode=!!(rb&&rb.offsetParent!==null)||!!(fr&&/ответ/i.test(fr.textContent||""));' +
    '}else{' +
    ' R.hasEditor=!!(app&&app.insertion);' +
    ' R.editorEmpty=!bodyText();' +
    ' R.hasMark=bodyText().indexOf(MARK)!==-1;' +
    ' R.replyMode=true;' +
    '}' +
    'try{var sid=window.staff_id,cid=window.CurrentCaseId;R.caseId=cid;' +
    ' var dr=localStorage.getItem("case_reply_"+sid+"_"+cid)||"";' +
    ' var clean=dr.replace(/<[^>]*>/g,"").replace(/\\uFEFF|\\s/g,"");' +
    ' R.draft=!!(clean.length>0&&dr.indexOf(MARK)===-1);}catch(e){}' ;

  const INSERT_BODY = FIND_EDITOR +
    'if(KIND==="chat"){' +
    ' if(!ta){R.err="нет поля ответа";}else{' +
    '  try{if(window.$R&&document.querySelector(".redactor-box")){$R("#comment","destroy");}}catch(e){}' +
    '  ta.style.display="";' +
    '  setTa(TEXT);' +
    '  try{ta.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));}catch(e){}' +
    '  R.ok=true;}' +
    '}else{' +
    ' if(!app||!app.insertion){R.err="редактор не готов";}else{' +
    '  try{app.editor.startFocus();}catch(e){}' +
    '  try{app.insertion.set(TEXT);}catch(e){R.err=(e&&e.message)||String(e);}' +
    '  try{if(app.selection&&app.selection.collapseToEnd)app.selection.collapseToEnd();}catch(e){}' +
    '  try{var n2=app.editor.getElement().nodes[0];if(ta){setTa(n2.innerHTML);}n2.dispatchEvent(new Event("input",{bubbles:true}));}catch(e){}' +
    '  R.ok=true;}' +
    '}' ;

  const CLEAR_BODY = FIND_EDITOR +
    'if(bodyText().indexOf(MARK)!==-1 || taVal().indexOf(MARK)!==-1){' +
    ' if(KIND==="chat"){setTa("");}' +
    ' else{try{app.editor.startFocus();app.insertion.set("");}catch(e){}if(ta){setTa("");}}' +
    ' R.cleared=true;}' ;

  // Кто написал последним: 'staff' (мы ответили — шаблон уместен) / 'client' (висит вопрос) / null
  function lastMsgKind(caseId) {
    if (!caseId) return Promise.resolve(null);
    return fetch('/staff/json-messages/' + caseId, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'include'
    }).then(function (r) { return r.json(); }).then(function (j) {
      const msgs = (j.messages || []).filter(function (m) { return !m.b_note; });
      if (!msgs.length) return null;
      const m = msgs[msgs.length - 1];
      if (m.staff_fullname) return 'staff';
      if (m.user_fullname) return 'client';
      return null;
    }).catch(function () { return null; });
  }

  /* ============================ ПЛАШКА ============================ */

  let bannerHidden = false;
  let insertedHere = false;
  let lastNote = '';

  function ensureBanner() {
    let b = document.getElementById('ec-banner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'ec-banner';
      b.style.cssText =
        'position:fixed;left:14px;bottom:14px;z-index:2147483000;' +
        'background:#fff;border:1px solid #E5E7EB;border-radius:14px;' +
        'box-shadow:0 8px 28px rgba(0,0,0,.16);padding:10px 12px;' +
        'font-family:' + FONT + ';font-size:12px;color:#111827;max-width:340px;line-height:1.4;';
      document.body.appendChild(b);
    }
    return b;
  }

  function pill(label, handler, primary) {
    const el = document.createElement('button');
    el.textContent = label;
    el.style.cssText = primary
      ? 'background:' + ACC + ';color:#fff;border:none;border-radius:999px;padding:5px 12px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;margin:3px 4px 0 0;'
      : 'background:#fff;color:' + ACC + ';border:1.5px solid ' + ACC + ';border-radius:999px;padding:4px 11px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;margin:3px 4px 0 0;';
    el.onclick = handler;
    return el;
  }

  function renderBanner() {
    if (bannerHidden) { const ex = document.getElementById('ec-banner'); if (ex) ex.remove(); return; }
    const b = ensureBanner();
    b.textContent = '';

    const head = document.createElement('div');
    head.style.cssText = 'font-weight:800;margin-bottom:2px;';
    head.textContent = '🌙 Вечернее закрытие · ' + START + '–' + END;
    b.appendChild(head);

    const sub = document.createElement('div');
    sub.style.cssText = 'color:#6B7280;';
    if (isDisabledToday()) sub.textContent = 'Выключено до завтра.';
    else if (insertedHere) sub.textContent = '✓ шаблон вставлен в это обращение' + (lastNote ? ' — ' + lastNote : '');
    else sub.textContent = 'Готово к работе. Отправляешь и закрываешь сама.';
    b.appendChild(sub);

    const row = document.createElement('div');
    if (!isDisabledToday()) {
      row.appendChild(pill('Вставить во все', function () { broadcast('insert'); handled = {}; tick(); }, true));
      row.appendChild(pill('Убрать из всех', function () { broadcast('clear'); clearHere(); }));
      row.appendChild(pill('Выключить до завтра', function () { broadcast('disable'); setDisabledToday(); renderBanner(); }));
    } else {
      row.appendChild(pill('Включить снова', function () {
        try { GM_setValue('ec_disabled_date', ''); } catch (e) {}
        renderBanner();
      }, true));
    }
    row.appendChild(pill('✕', function () { bannerHidden = true; renderBanner(); }));
    b.appendChild(row);
  }

  function toast(msg) {
    const t = document.createElement('div');
    t.textContent = '🌙 ' + msg;
    t.style.cssText =
      'position:fixed;left:14px;bottom:120px;z-index:2147483000;background:#111827;color:#fff;' +
      'font-family:' + FONT + ';font-size:12px;padding:9px 13px;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.28);opacity:0;transition:opacity .2s;';
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.style.opacity = '1'; });
    setTimeout(function () { t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 300); }, 4200);
  }

  /* ============================ КРОСС-ВКЛАДКИ ============================ */

  let bc = null;
  try { bc = new BroadcastChannel('eduson-evening-close'); } catch (e) {}
  function broadcast(action) { if (bc) try { bc.postMessage({ action: action }); } catch (e) {} }
  if (bc) bc.onmessage = function (ev) {
    const a = (ev.data || {}).action;
    if (a === 'clear') clearHere();
    else if (a === 'disable') { setDisabledToday(); renderBanner(); }
    else if (a === 'insert') { handled = {}; tick(); }
  };

  /* ============================ ЛОГИКА ============================ */

  let handled = {};          // key обращения → уже вставлено в этой сессии
  let busy = false;

  async function clearHere() {
    const info = ticketInfo();
    if (!info) return;
    const res = await pageOp(consts(info.kind) + CLEAR_BODY);
    if (res.cleared) {
      insertedHere = false;
      delete handled[info.key];
      toast('убрала шаблон из этого обращения');
      renderBanner();
    }
  }

  async function tick() {
    if (busy) return;
    const info = ticketInfo();
    if (!info) { removeBanner(); return; }

    if (!inWindow()) { removeBanner(); return; }
    renderBanner();
    if (isDisabledToday()) return;
    if (handled[info.key]) return;

    busy = true;
    try {
      const probe = await pageOp(consts(info.kind) + PROBE_BODY);
      if (probe.err || !probe.hasEditor) return;
      if (probe.hasMark) { handled[info.key] = true; insertedHere = true; renderBanner(); return; }
      if (!probe.editorEmpty) return;      // не затираем набранное
      if (probe.draft) return;             // есть сохранённый черновик OmniDesk
      if (!probe.replyMode) return;        // чат в нерабочем статусе — поле запечатано

      const who = await lastMsgKind(probe.caseId);
      const res = await pageOp(consts(info.kind) + INSERT_BODY);
      if (res.ok) {
        handled[info.key] = true;
        insertedHere = true;
        lastNote = (who === 'client') ? '⚠️ последним писал клиент, проверь' : '';
        toast(who === 'client'
          ? 'вставила — но последним писал клиент, проверь перед отправкой'
          : 'вставила — проверь и отправь');
        renderBanner();
      } else if (res.err) {
        console.warn(TAG, 'вставка не удалась:', res.err);
      }
    } finally {
      busy = false;
    }
  }

  function removeBanner() { const ex = document.getElementById('ec-banner'); if (ex) ex.remove(); }

  // OmniDesk — SPA: следим за сменой обращения, чтобы плашка и статус «вставлено» обновлялись.
  let lastPath = location.pathname;
  function watchPath() {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      insertedHere = false;
      lastNote = '';
      bannerHidden = false;
      renderBanner();
    }
  }

  console.log(TAG, 'запущен, версия 1.2.0 · окно ' + START + '–' + END + (FORCE_ON ? ' · FORCE_ON' : ''));
  setInterval(function () { watchPath(); tick(); }, 12000);
  setTimeout(tick, 2500);
})();
