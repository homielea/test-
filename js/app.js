'use strict';

/* ---------- State ---------- */
const S = {
  data: null, knots: null,
  lang: localStorage.getItem('mp_lang') || 'gl',
  audio: localStorage.getItem('mp_audio') === '1',
  session: null,           // { mode, list, idx, answers[], examSource, timer, deadline }
  stack: [],               // view history
};
const stats = JSON.parse(localStorage.getItem('mp_stats') || '{}'); // id -> {seen, wrong}

/* ---------- Helpers ---------- */
const $ = (id) => document.getElementById(id);
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const LET = ['A', 'B', 'C', 'D'];
const t = (gl, es) => (S.lang === 'gl' ? gl : es);
const qText = (q) => t(q.q_gl, q.q_es);
const qOpts = (q) => t(q.options_gl, q.options_es);
const moduleName = (id) => { const m = S.data.modules.find((m) => m.id === id); return m ? t(m.gl, m.es) : ''; };
function saveStats() { localStorage.setItem('mp_stats', JSON.stringify(stats)); }
function record(id, correct) {
  const s = stats[id] || { seen: 0, wrong: 0 };
  s.seen++; if (!correct) s.wrong++;
  stats[id] = s; saveStats();
}

/* ---------- Text to speech (hands-free) ---------- */
let voices = [];
function loadVoices() { voices = window.speechSynthesis ? speechSynthesis.getVoices() : []; }
if (window.speechSynthesis) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
function pickVoice() {
  if (!voices.length) loadVoices();
  const want = S.lang === 'gl' ? ['gl', 'pt-pt', 'pt', 'es'] : ['es', 'gl', 'pt'];
  for (const pref of want) {
    const v = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(pref));
    if (v) return v;
  }
  return voices[0] || null;
}
function speak(text) {
  if (!S.audio || !window.speechSynthesis) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice();
  if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = S.lang === 'gl' ? 'gl-ES' : 'es-ES'; }
  u.rate = 0.95;
  speechSynthesis.speak(u);
}
function stopSpeak() { if (window.speechSynthesis) speechSynthesis.cancel(); }
function speakQuestion(q) {
  const opts = qOpts(q).map((o, i) => `${LET[i]}. ${o}`).join('. ');
  speak(`${qText(q)}. ${opts}`);
}

/* ---------- Router ---------- */
const TITLES = {
  home: 'Mariñeiro Pescador', practice: 'Practicar', 'exam-setup': 'Simulacro',
  quiz: 'Pregunta', results: 'Resultado', knots: 'Nós mariñeiros', knot: 'Nó',
};
function show(view, push = true) {
  stopSpeak();
  document.querySelectorAll('.view').forEach((v) => (v.hidden = true));
  $('view-' + view).hidden = false;
  if (push && S.stack[S.stack.length - 1] !== view) S.stack.push(view);
  $('title').textContent = TITLES[view] || 'Mariñeiro Pescador';
  $('backBtn').hidden = view === 'home';
  window.scrollTo(0, 0);
}
function goBack() {
  // leaving a running exam? confirm
  if (S.session && S.session.mode === 'exam' && ['quiz'].includes(S.stack[S.stack.length - 1])) {
    if (!confirm('Saír do exame? Perderás o progreso.')) return;
    clearInterval(S.session.timer); S.session = null;
  }
  S.stack.pop();
  const prev = S.stack[S.stack.length - 1] || 'home';
  show(prev, false);
  if (prev === 'home') renderHome();
  if (prev === 'knots') show('knots', false);
}

/* ---------- Home ---------- */
function renderHome() {
  const ids = Object.keys(stats);
  const seen = ids.reduce((n, id) => n + stats[id].seen, 0);
  const wrong = ids.filter((id) => stats[id].wrong > 0).length;
  $('statsLine').textContent = seen
    ? `Levas ${seen} respostas · ${wrong} preguntas para repasar`
    : '';
}

/* ---------- Practice: module picker ---------- */
function renderModulePicker() {
  const wrap = $('moduleList'); wrap.innerHTML = '';
  const all = document.createElement('button');
  all.className = 'big-btn';
  all.innerHTML = `<span class="ico">🌊</span><span><b>Todos os módulos</b><small>${S.data.questions.length} preguntas</small></span>`;
  all.onclick = () => startQuiz({ mode: 'practice', list: shuffle(S.data.questions) });
  wrap.appendChild(all);
  S.data.modules.forEach((m) => {
    const qs = S.data.questions.filter((q) => q.module === m.id);
    const b = document.createElement('button');
    b.className = 'big-btn';
    b.innerHTML = `<span class="ico">${['', '⚓', '🚦', '🐟', '🧊'][m.id]}</span><span><b>${m.id}. ${t(m.gl, m.es)}</b><small>${qs.length} preguntas</small></span>`;
    b.onclick = () => startQuiz({ mode: 'practice', list: shuffle(qs) });
    wrap.appendChild(b);
  });
}

/* ---------- Exam setup ---------- */
function renderExamSetup() {
  const wrap = $('examSourceList'); wrap.innerHTML = '';
  const sources = [
    { key: 'Xuño 2018', label: 'Exame real — Xuño 2018' },
    { key: 'Marzo 2018', label: 'Exame real — Marzo 2018' },
    { key: 'random', label: 'Aleatorio — 30 preguntas mesturadas' },
  ];
  sources.forEach((s) => {
    const b = document.createElement('button'); b.className = 'big-btn';
    b.innerHTML = `<span class="ico">📝</span><span><b>${s.label}</b><small>30 preguntas · 50 minutos</small></span>`;
    b.onclick = () => {
      let list;
      if (s.key === 'random') list = shuffle(S.data.questions).slice(0, 30);
      else list = S.data.questions.filter((q) => q.exam === s.key);
      startQuiz({ mode: 'exam', list, examSource: s.label });
    };
    wrap.appendChild(b);
  });
}

/* ---------- Quiz engine ---------- */
function startQuiz(opts) {
  S.session = { idx: 0, answers: [], ...opts };
  $('timer').hidden = opts.mode !== 'exam';
  if (opts.mode === 'exam') {
    S.session.deadline = Date.now() + 50 * 60 * 1000;
    S.session.timer = setInterval(tickTimer, 1000);
    tickTimer();
  }
  show('quiz');
  renderQuestion();
}
function tickTimer() {
  const left = Math.max(0, Math.floor((S.session.deadline - Date.now()) / 1000));
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');
  const el = $('timer'); el.textContent = `${mm}:${ss}`;
  el.classList.toggle('warn', left <= 300);
  if (left <= 0) { clearInterval(S.session.timer); finishExam(); }
}
function renderQuestion() {
  const ss = S.session, q = ss.list[ss.idx];
  $('progressBar').style.width = ((ss.idx) / ss.list.length * 100) + '%';
  $('qCounter').textContent = `${ss.idx + 1}/${ss.list.length}`;
  $('moduleTag').textContent = `Módulo ${q.module}: ${moduleName(q.module)}`;
  $('questionText').textContent = qText(q);
  $('feedback').hidden = true;
  $('nextBtn').hidden = true;
  $('replayAudio').hidden = !S.audio;
  const wrap = $('options'); wrap.innerHTML = '';
  qOpts(q).forEach((opt, i) => {
    const b = document.createElement('button');
    b.className = 'opt';
    b.innerHTML = `<span class="letter">${LET[i]}</span><span>${opt}</span>`;
    b.onclick = () => answer(i);
    wrap.appendChild(b);
  });
  if (S.audio) speakQuestion(q);
}
function answer(choice) {
  const ss = S.session, q = ss.list[ss.idx];
  if (ss.answers[ss.idx] != null) return;
  ss.answers[ss.idx] = choice;
  const btns = [...$('options').children];
  if (ss.mode === 'practice') {
    record(q.id, choice === q.answer);
    btns.forEach((b, i) => {
      b.disabled = true;
      if (i === q.answer) b.classList.add('correct');
      else if (i === choice) b.classList.add('wrong');
      else b.classList.add('dim');
    });
    const ok = choice === q.answer;
    const fb = $('feedback');
    fb.className = 'feedback ' + (ok ? 'ok' : 'bad');
    fb.innerHTML = `<b>${ok ? '✓ Correcto' : '✗ Incorrecto'}</b>${q.explanation_gl ? '<span>' + q.explanation_gl + '</span>' : ''}`;
    fb.hidden = false;
    if (S.audio) speak((ok ? 'Correcto. ' : 'Incorrecto. ') + (q.explanation_gl || ''));
    $('nextBtn').hidden = false;
  } else {
    // exam: no feedback, just mark selection and advance
    btns.forEach((b, i) => { b.disabled = true; if (i === choice) b.style.borderColor = 'var(--sea)'; });
    setTimeout(next, 250);
  }
}
function next() {
  const ss = S.session;
  if (ss.idx + 1 >= ss.list.length) {
    if (ss.mode === 'exam') finishExam(); else finishPractice();
    return;
  }
  ss.idx++; renderQuestion();
}
function finishPractice() {
  const ss = S.session;
  const correct = ss.list.reduce((n, q, i) => n + (ss.answers[i] === q.answer ? 1 : 0), 0);
  showResults({ correct, total: ss.list.length, mode: 'practice' });
}
function finishExam() {
  const ss = S.session;
  clearInterval(ss.timer);
  let correct = 0; const perMod = {};
  ss.list.forEach((q, i) => {
    const ok = ss.answers[i] === q.answer;
    if (ok) correct++;
    record(q.id, ok);
    perMod[q.module] = perMod[q.module] || { ok: 0, total: 0, wrong: 0 };
    perMod[q.module].total++; perMod[q.module].ok += ok ? 1 : 0; perMod[q.module].wrong += ok ? 0 : 1;
  });
  const mod2wrong = (perMod[2] || { wrong: 0 }).wrong;
  const pass = correct >= 20 && mod2wrong <= 5;
  showResults({ correct, total: ss.list.length, mode: 'exam', pass, perMod, mod2wrong });
}

/* ---------- Results ---------- */
function showResults(r) {
  show('results');
  const wrong = r.total - r.correct;
  if (r.mode === 'exam') {
    $('resultBadge').textContent = r.pass ? '✅' : '❌';
    $('resultTitle').textContent = r.pass ? 'APTO/A' : 'NON APTO/A';
    $('resultScore').className = 'result-score ' + (r.pass ? 'pass' : 'fail');
    $('resultScore').textContent = `${r.correct}/${r.total} acertos · ${wrong} fallos`;
    const bd = $('resultBreakdown'); bd.innerHTML = '';
    Object.keys(r.perMod).sort().forEach((m) => {
      const pm = r.perMod[m];
      const row = document.createElement('div');
      const fails = m === '2' ? pm.wrong > 5 : false;
      row.className = 'brow ' + (fails ? 'fail' : 'pass');
      const limit = m === '2' ? ' (máx. 5 fallos)' : '';
      row.innerHTML = `<span>Módulo ${m}${limit}</span><b>${pm.ok}/${pm.total}</b>`;
      bd.appendChild(row);
    });
    const note = document.createElement('div'); note.className = 'brow';
    note.innerHTML = `<span>Criterio</span><b>20+ acertos · Mód.2 ≤5 fallos</b>`;
    bd.appendChild(note);
  } else {
    const pct = Math.round(r.correct / r.total * 100);
    $('resultBadge').textContent = pct >= 67 ? '🎉' : '💪';
    $('resultTitle').textContent = 'Práctica rematada';
    $('resultScore').className = 'result-score ' + (pct >= 67 ? 'pass' : 'fail');
    $('resultScore').textContent = `${r.correct}/${r.total} acertos (${pct}%)`;
    $('resultBreakdown').innerHTML = '';
  }
  // Review wrong
  const ss = S.session;
  const wrongList = ss.list.filter((q, i) => ss.answers[i] !== q.answer);
  const rb = $('reviewWrongBtn');
  rb.hidden = wrongList.length === 0;
  rb.onclick = () => startQuiz({ mode: 'practice', list: wrongList });
  S.session = null;
}

/* ---------- Knots ---------- */
function renderKnots() {
  $('knotExamNote').textContent = S.knots.exam_note_gl;
  const grid = $('knotList'); grid.innerHTML = '';
  S.knots.knots.forEach((k) => {
    const c = document.createElement('div'); c.className = 'knot-card';
    c.innerHTML = `<img src="${k.image}" alt="${k.name_gl}" loading="lazy"><span>${k.name_gl}</span>${k.exam_required ? '<span class="req">Exame</span>' : ''}`;
    c.onclick = () => openKnot(k);
    grid.appendChild(c);
  });
}
function openKnot(k) {
  show('knot');
  $('knotName').textContent = k.name_gl;
  $('knotReq').hidden = !k.exam_required;
  $('knotImg').src = k.image; $('knotImg').alt = k.name_gl;
  $('knotUse').textContent = k.use_gl;
  const ol = $('knotSteps'); ol.innerHTML = '';
  k.steps_gl.forEach((s) => { const li = document.createElement('li'); li.textContent = s; ol.appendChild(li); });
  $('knotSpeak').onclick = () => {
    const on = S.audio; S.audio = true; // allow speaking even if global audio off
    speak(`${k.name_gl}. ${k.use_gl}. Pasos. ` + k.steps_gl.map((s, i) => `${i + 1}. ${s}`).join(' '));
    S.audio = on;
  };
}
function renderKnotQuiz() {
  const area = $('knotQuizArea');
  const all = S.knots.knots;
  const target = all[Math.floor(Math.random() * all.length)];
  const byImage = Math.random() < 0.5;
  // 4 options
  const opts = shuffle([target, ...shuffle(all.filter((k) => k !== target)).slice(0, 3)]);
  area.innerHTML = '';
  if (byImage) {
    const img = document.createElement('img'); img.className = 'kq-img'; img.src = target.image; img.alt = '';
    area.appendChild(img);
    const p = document.createElement('div'); p.className = 'kq-prompt'; p.textContent = 'Cal é este nó?';
    area.appendChild(p);
  } else {
    const p = document.createElement('div'); p.className = 'kq-prompt';
    p.textContent = '¿Que nó usarías para…? ' + target.use_gl;
    area.appendChild(p);
    if (S.audio) speak(p.textContent);
  }
  const wrap = document.createElement('div'); wrap.className = 'options';
  opts.forEach((k) => {
    const b = document.createElement('button'); b.className = 'opt';
    b.innerHTML = `<span>${k.name_gl}</span>`;
    b.onclick = () => {
      [...wrap.children].forEach((x) => x.disabled = true);
      if (k === target) b.classList.add('correct');
      else { b.classList.add('wrong'); [...wrap.children][opts.indexOf(target)].classList.add('correct'); }
      const nx = document.createElement('button'); nx.className = 'primary-btn'; nx.textContent = 'Outro nó ›';
      nx.style.marginTop = '1rem'; nx.onclick = renderKnotQuiz; area.appendChild(nx);
    };
    wrap.appendChild(b);
  });
  area.appendChild(wrap);
}

/* ---------- Wire up ---------- */
function setLang(l) {
  S.lang = l; localStorage.setItem('mp_lang', l);
  $('langBtn').textContent = l.toUpperCase();
  document.documentElement.lang = l;
  // re-render current question if in quiz
  if (S.session) renderQuestion();
}
function setAudio(on) {
  S.audio = on; localStorage.setItem('mp_audio', on ? '1' : '0');
  $('audioBtn').setAttribute('aria-pressed', on ? 'true' : 'false');
  if (!on) stopSpeak();
}

function init() {
  setLang(S.lang); setAudio(S.audio);
  $('langBtn').onclick = () => setLang(S.lang === 'gl' ? 'es' : 'gl');
  $('audioBtn').onclick = () => setAudio(!S.audio);
  $('backBtn').onclick = goBack;
  $('nextBtn').onclick = next;
  $('replayAudio').onclick = () => speakQuestion(S.session.list[S.session.idx]);
  $('resultHomeBtn').onclick = () => { S.stack = ['home']; show('home', false); renderHome(); };
  document.querySelectorAll('[data-go]').forEach((b) => {
    b.onclick = () => {
      const g = b.dataset.go;
      if (g === 'practice') { renderModulePicker(); show('practice'); }
      else if (g === 'exam-setup') { renderExamSetup(); show('exam-setup'); }
      else if (g === 'knots') { renderKnots(); show('knots'); }
      else if (g === 'review') {
        const wrong = S.data.questions.filter((q) => (stats[q.id] || {}).wrong > 0)
          .sort((a, b) => stats[b.id].wrong - stats[a.id].wrong);
        if (!wrong.length) { alert('Aínda non tes preguntas falladas. Fai algunha práctica primeiro.'); return; }
        startQuiz({ mode: 'practice', list: wrong });
      }
    };
  });
  // knot tabs
  document.querySelectorAll('[data-knottab]').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('[data-knottab]').forEach((x) => x.classList.toggle('active', x === b));
      const quiz = b.dataset.knottab === 'quiz';
      $('knotsLearn').hidden = quiz; $('knotsQuiz').hidden = !quiz;
      if (quiz) renderKnotQuiz();
    };
  });

  Promise.all([
    fetch('data/questions.json').then((r) => r.json()),
    fetch('data/knots.json').then((r) => r.json()),
  ]).then(([q, k]) => {
    S.data = q; S.knots = k;
    S.stack = ['home']; renderHome();
  }).catch((e) => {
    $('view-home').innerHTML = '<p>Erro cargando os datos. Recarga a páxina.</p>';
    console.error(e);
  });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
init();
