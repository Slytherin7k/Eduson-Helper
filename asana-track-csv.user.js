// ==UserScript==
// @name         Asana: почта + трек → CSV из "Отправлено (прислать трек студенту)"
// @namespace    asana-track-extractor
// @version      2.0.1
// @description  Собирает почту и трек-номер по всем карточкам колонки и сохраняет в CSV
// @author       Astanina Natalia
// @match        https://app.asana.com/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/Slytherin7k/Eduson-Helper/main/asana-track-csv.user.js
// @downloadURL  https://raw.githubusercontent.com/Slytherin7k/Eduson-Helper/main/asana-track-csv.user.js
// ==/UserScript==

(function () {
  'use strict';

  const PROJECT_NAME = 'Дипломы/удостоверения';
  const PROJECT_GID_FALLBACK = '1205385541192038';     // на случай, если по имени не найдём
  const COLUMN_NAME = 'Отправлено (прислать трек студенту)';
  const ANTON_GID = '1209569244751265';                // Anton T (кто пишет треки)
  const TRACK_RE = /\b\d{10,}\b/g;                     // трек — длинное число, напр. 80514625417069
  const EMAIL_RE = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;

  // v2.0: вместо того чтобы открывать каждую карточку по очереди, берём данные
  // напрямую у Асаны (та же сессия, что и в браузере) — быстро и без зависаний.
  async function api(path) {
    const r = await fetch('/api/1.0' + path, { credentials: 'include' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.errors && j.errors[0] && j.errors[0].message) || ('HTTP ' + r.status));
    return j;
  }

  async function apiAll(path) {
    const out = [];
    let offset = '';
    for (let i = 0; i < 50; i++) {
      const sep = path.includes('?') ? '&' : '?';
      const j = await api(path + sep + 'limit=100' + (offset ? '&offset=' + offset : ''));
      out.push(...(j.data || []));
      if (!j.next_page || !j.next_page.offset) break;
      offset = j.next_page.offset;
    }
    return out;
  }

  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();

  async function findProjectGid() {
    try {
      const ws = await apiAll('/workspaces?opt_fields=name');
      for (const w of ws) {
        const ps = await apiAll(`/workspaces/${w.gid}/projects?opt_fields=name&archived=false`);
        const p = ps.find((x) => norm(x.name) === norm(PROJECT_NAME));
        if (p) return p.gid;
      }
    } catch (e) { console.warn('[Asana] поиск проекта по имени не удался', e); }
    return PROJECT_GID_FALLBACK;
  }

  // Почта лежит в описании карточки строкой «Эл.почта: адрес»
  function extractEmail(notes) {
    const text = String(notes || '');
    const line = text.match(/почта[^:\n]*:\s*(\S+)/i);
    if (line && EMAIL_RE.test(line[1])) return line[1].match(EMAIL_RE)[0];
    const m = text.match(EMAIL_RE);
    return m ? m[0] : '';
  }

  // Берём САМЫЙ ПОСЛЕДНИЙ по времени трек: при переотправке у карточки их бывает два и больше.
  // Сначала ищем в комментариях Антона; если у него нет — в любых комментариях.
  function extractTrack(stories) {
    const comments = stories
      .filter((s) => s.type === 'comment' || s.resource_subtype === 'comment_added')
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const pick = (list) => {
      let best = null;
      for (const s of list) {
        const all = String(s.text || '').match(TRACK_RE);
        if (all) best = { track: all[all.length - 1], date: s.created_at };
      }
      return best;
    };
    const isAnton = (s) => s.created_by && (s.created_by.gid === ANTON_GID || /anton/i.test(s.created_by.name || ''));
    return pick(comments.filter(isAnton)) || pick(comments) || { track: '', date: '' };
  }

  // Несколько запросов одновременно (по 5), чтобы не ждать каждую карточку по очереди
  async function mapLimit(items, limit, fn, onProgress) {
    const res = new Array(items.length);
    let next = 0, done = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        try { res[i] = await fn(items[i]); }
        catch (e) { res[i] = { error: String(e.message || e) }; }
        done++;
        if (onProgress) onProgress(done, items.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return res;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function saveCSV(rows, filename) {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['почта', 'трек-номер', 'задача', 'дата трека'];
    const lines = [header.map(esc).join(';')];
    for (const r of rows) {
      lines.push([esc(r.email), esc(r.track), esc(r.title || ''), esc(r.trackDate || '')].join(';'));
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], {
      type: 'text/csv;charset=utf-8;',
    });
    downloadBlob(blob, filename);
  }

  async function run(setStatus) {
    setStatus('⏳ Ищу колонку…');
    const projectGid = await findProjectGid();
    const sections = await apiAll(`/projects/${projectGid}/sections?opt_fields=name`);
    const section = sections.find((s) => norm(s.name) === norm(COLUMN_NAME));
    if (!section) {
      alert(`Не нашла колонку «${COLUMN_NAME}» в проекте «${PROJECT_NAME}».`);
      return;
    }

    const tasks = (await apiAll(`/sections/${section.gid}/tasks?opt_fields=name,notes,completed`))
      .filter((t) => !t.completed);
    console.log(`[Asana] Карточек в колонке: ${tasks.length}`);
    if (!tasks.length) { alert('В колонке сейчас нет карточек.'); return; }

    const found = await mapLimit(tasks, 5, async (t) => {
      const stories = await apiAll(`/tasks/${t.gid}/stories?opt_fields=type,resource_subtype,text,created_at,created_by.name`);
      return extractTrack(stories);
    }, (d, n) => setStatus(`⏳ ${d} из ${n}…`));

    const rows = tasks.map((t, i) => ({
      taskId: t.gid,
      title: (t.name || '').trim(),
      email: extractEmail(t.notes),
      track: found[i].track || '',
      trackDate: String(found[i].date || '').slice(0, 10),
      error: found[i].error || '',
    }));

    console.table(rows.map((r) => ({ 'почта': r.email, 'трек-номер': r.track, 'дата трека': r.trackDate, задача: r.title })));

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    saveCSV(rows, `asana-treki-${stamp}.csv`);

    const missing = rows.filter((r) => !r.email || !r.track);
    alert(
      `Готово! Обработано ${rows.length} карточек.\n` +
      `CSV-файл сохранён (проверьте загрузки браузера).` +
      (missing.length
        ? `\n\n⚠ Без почты или трека: ${missing.length}\n` +
          missing.slice(0, 10).map((r) => '• ' + r.title).join('\n') +
          (missing.length > 10 ? '\n…' : '')
        : '')
    );

    window.__asanaTrackRows = rows;
  }

  // Находим кнопку «Фильтр» и её flex-строку в тулбаре
  function findFilterButton() {
    const btns = Array.from(document.querySelectorAll('.FilterTrain-textButton, [role="button"]'));
    return btns.find(
      (b) => /(^|\s)Фильтр(\s|$)/.test(b.textContent.trim()) && b.querySelector('svg')
    );
  }

  // Встраиваем кнопку в тулбар слева от «Фильтр»
  function addButton() {
    if (document.getElementById('asana-track-btn')) return;

    const filterBtn = findFilterButton();
    if (!filterBtn) return; // тулбар ещё не готов

    // .ButtonGroup — обёртка кнопки Фильтр; вставляем перед ней в общей flex-строке
    const filterGroup = filterBtn.closest('.ButtonGroup') || filterBtn;
    const toolbarRow = filterGroup.parentElement;
    if (!toolbarRow) return;

    const btn = document.createElement('button');
    btn.id = 'asana-track-btn';
    btn.type = 'button';
    btn.textContent = '📦 Почта→трек (CSV)';
    Object.assign(btn.style, {
      height: '28px',            // = высоте кнопки «Фильтр»
      lineHeight: '28px',
      padding: '0 10px',
      marginRight: '8px',
      background: '#796EFF',
      color: '#fff',
      border: 'none',
      borderRadius: '6px',       // как у соседних кнопок
      cursor: 'pointer',
      fontSize: '12px',
      fontWeight: '600',
      whiteSpace: 'nowrap',
      display: 'inline-flex',
      alignItems: 'center',
      boxSizing: 'border-box',
      flex: '0 0 auto',
    });

    btn.addEventListener('click', () => {
      btn.disabled = true;
      const prev = btn.textContent;
      btn.textContent = '⏳ Собираю…';
      run((t) => { btn.textContent = t; })
        .catch((e) => { console.error(e); alert('Не получилось собрать: ' + (e.message || e)); })
        .finally(() => {
          btn.disabled = false;
          btn.textContent = prev;
        });
    });

    // вставляем слева от группы с «Фильтр»
    toolbarRow.insertBefore(btn, filterGroup);
  }

  // Asana перерисовывает тулбар — держим кнопку на месте
  setInterval(() => {
    if (!document.getElementById('asana-track-btn') && findFilterButton()) {
      addButton();
    }
  }, 1500);
})();
