// Espacio de trabajo de un proyecto: etapas, conversación con la IA, preguntas, edición, revisión y documentos.
// Todo el DOM se arma con textContent (nunca innerHTML con datos del usuario o de la IA) para evitar XSS.
(() => {
  const apiBase = window.location.protocol.startsWith('http') ? '' : 'http://localhost:3001';
  const projectId = new URLSearchParams(window.location.search).get('id');
  const POLL_MS = 15000;

  const STATUS_LABELS = { NOT_STARTED: 'Sin iniciar', DRAFT: 'En curso', APPROVED: 'Aprobada', OUTDATED: 'Desactualizada' };
  const ROLE_LABELS = { owner: 'Propietario', editor: 'Editor', viewer: 'Lector' };
  const CATEGORY_LABELS = {
    missing_info: 'Falta información', action_failed: 'Acción fallida', no_permission: 'Sin permisos', not_found: 'No existe',
    invalid_data: 'Datos inválidos', external_unavailable: 'Dependencia caída', concurrency: 'Concurrencia', other: 'Otro',
  };
  const ACTION_LABELS = {
    'project.created': 'creó el proyecto', 'project.updated': 'editó el proyecto', 'member.added': 'agregó un miembro',
    'member.role_changed': 'cambió un rol', 'member.removed': 'quitó un miembro', 'stage.ai_update': 'actualizó una etapa con la IA',
    'stage.manual_edit': 'editó manualmente una etapa', 'stage.approved': 'aprobó una etapa', 'questions.answered': 'respondió preguntas',
    'review.run': 'ejecutó la revisión final', 'export.generated': 'generó los documentos',
  };

  const state = { project: null, stages: [], members: [], current: null, stageData: null, busy: false, editing: false };
  const $ = (id) => document.getElementById(id);

  if (window.mermaid) {
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      fontFamily: "'JetBrains Mono', monospace",
      themeVariables: {
        darkMode: true,
        background: '#040a15',
        primaryColor: '#10203f',
        primaryTextColor: '#e6ecf7',
        primaryBorderColor: '#4c8dff',
        secondaryColor: '#0b1730',
        tertiaryColor: '#152a52',
        lineColor: '#d6b25e',
        textColor: '#e6ecf7',
        edgeLabelBackground: '#0b1730',
        attributeBackgroundColorOdd: '#0b1730',
        attributeBackgroundColorEven: '#10203f',
      },
    });
  }

  // ---------- Utilidades DOM ----------
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (value === undefined || value === null || value === false) return;
      if (key === 'class') el.className = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key in el && typeof value !== 'string') el[key] = value;
      else el.setAttribute(key, value === true ? '' : value);
    });
    children.flat(Infinity).forEach((child) => {
      if (child === null || child === undefined || child === false) return;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return el;
  }
  const list = (items) => (items?.length ? h('ul', {}, items.map((i) => h('li', {}, i))) : h('p', { class: 'empty' }, 'Ninguno'));
  function table(headers, rows) {
    if (!rows.length) return h('p', { class: 'empty' }, 'Ninguno');
    return h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, headers.map((x) => h('th', {}, x)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, c ?? '')))))));
  }
  const section = (title, ...body) => h('section', {}, h('h3', {}, title), ...body);
  const fmtDate = (value) => (value ? new Date(value).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' }) : '');
  const yes = (v) => (v ? 'sí' : 'no');

  let diagramSeq = 0;
  async function diagram(code) {
    const box = h('div', { class: 'diagram' });
    if (!code) return box;
    if (!window.mermaid) {
      box.append(h('pre', { class: 'light' }, code));
      return box;
    }
    try {
      const { svg } = await window.mermaid.render(`mmd${(diagramSeq += 1)}`, code);
      box.innerHTML = svg; // SVG generado por Mermaid en modo "strict" (sanitizado)
    } catch (err) {
      box.append(h('pre', { class: 'light' }, code));
    }
    return box;
  }

  function banner(message, type = 'info') {
    const el = $('globalStatus');
    if (!message) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.className = `banner ${type}`;
    el.textContent = message;
  }

  // ---------- API ----------
  let refreshInFlight = null;
  function refreshSession() {
    if (!refreshInFlight) {
      refreshInFlight = fetch(`${apiBase}/api/refresh`, { method: 'POST', credentials: 'include' })
        .then((r) => r.ok).catch(() => false).finally(() => { refreshInFlight = null; });
    }
    return refreshInFlight;
  }

  async function call(path, { method = 'GET', body } = {}) {
    const send = () => fetch(`${apiBase}${path}`, {
      method,
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let res = await send();
    if (res.status === 401 && (await refreshSession())) res = await send();
    if (res.status === 401) {
      window.location.href = 'index.html';
      throw new Error('Sesión expirada');
    }
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.error || `Error ${res.status}`);
      Object.assign(error, { status: res.status, data });
      throw error;
    }
    return data;
  }

  const projectPath = (suffix = '') => `/api/projects/${encodeURIComponent(projectId)}${suffix}`;
  const canEdit = () => ['owner', 'editor'].includes(state.project?.role);
  const isOwner = () => state.project?.role === 'owner';

  function describeError(err) {
    const extra = err.data?.findings?.length ? ` ${err.data.findings.map((f) => f.message).join(' · ')}` : '';
    const details = err.data?.details?.length ? ` (${err.data.details.slice(0, 4).join('; ')})` : '';
    return `${err.message}${extra}${details}`;
  }

  // ---------- Carga ----------
  async function loadProject() {
    const data = await call(projectPath());
    state.project = data.project;
    state.stages = data.stages;
    state.members = data.members;
    // Si hay un trabajo de IA en curso (de otra pestaña, de otro integrante o antes de recargar), se sigue su progreso.
    if (data.activeJob && !state.busy) {
      const { id, stage, createdAt } = data.activeJob;
      setTimeout(() => withBusy(async () => {
        await waitForJob(id);
        banner(`La IA terminó de trabajar en "${stageLabel(stage || state.current)}".`, 'success');
      }, undefined, new Date(createdAt).getTime()), 0);
    }
    $('projectName').textContent = data.project.name;
    document.title = `Ideator · ${data.project.name}`;
    const badge = $('myRole');
    badge.textContent = ROLE_LABELS[data.project.role];
    badge.className = `role-badge ${data.project.role}`;
    if (!state.current) {
      const fromHash = window.location.hash.slice(1);
      state.current = state.stages.some((s) => s.stage === fromHash) ? fromHash : data.project.currentStage;
    }
    renderStepper();
  }

  async function loadStage() {
    state.stageData = await call(projectPath(`/stages/${state.current}`));
    await renderStage();
  }

  async function reloadAll() {
    await loadProject();
    await loadStage();
  }

  function renderStepper() {
    const nav = $('stepper');
    nav.replaceChildren(...state.stages.map((s, index) => h('button', {
      type: 'button',
      class: `step ${s.stage === state.current ? 'active' : ''}`,
      onclick: () => selectStage(s.stage),
    },
    h('span', { class: 'step-name' }, `${index + 1}. ${s.label}`),
    h('span', { class: `step-status st-${s.status}` }, STATUS_LABELS[s.status] || s.status),
    s.openBlocking ? h('span', { class: 'blocking-count' }, `${s.openBlocking} pregunta(s) bloqueante(s)`) : null,
    !s.openBlocking && s.openNonBlocking ? h('span', { class: 'pending-count' }, `${s.openNonBlocking} pregunta(s) opcional(es)`) : null)));
  }

  async function selectStage(stage) {
    if (state.busy) return;
    state.current = stage;
    state.editing = false;
    window.location.hash = stage;
    banner('');
    renderStepper();
    await loadStage().catch((err) => banner(describeError(err), 'error'));
  }

  // ---------- Render de la etapa ----------
  async function renderStage() {
    const d = state.stageData;
    const isReview = d.stage === 'REVIEW';
    $('stageTitle').textContent = d.label;
    $('stageMeta').textContent = isReview
      ? 'Revisión consolidada del proyecto'
      : `${STATUS_LABELS[d.status]} · versión ${d.version}${d.updatedBy ? ` · último cambio: ${d.updatedBy.name} (${fmtDate(d.updatedAt)})` : ''}${d.approvedBy ? ` · aprobada por ${d.approvedBy.name}` : ''}`;

    const blocked = !d.previousApproved;
    $('approveButton').hidden = isReview || !canEdit();
    const openBlocking = d.questions.filter((q) => q.status === 'open' && q.blocking).length;
    $('approveButton').disabled = state.busy || !d.content || d.status === 'APPROVED' || blocked || openBlocking > 0;
    $('approveButton').title = openBlocking ? 'Resuelve las preguntas bloqueantes antes de aprobar' : '';
    $('editButton').hidden = isReview || !canEdit() || !d.content;
    $('historyButton').hidden = isReview;
    $('generateButton').hidden = isReview || !canEdit() || d.stage === 'DEFINITION' || Boolean(d.content) || blocked;
    $('chatForm').hidden = isReview || !canEdit();
    $('chatInput').disabled = state.busy || blocked;
    $('sendButton').disabled = state.busy || blocked;
    $('chatHint').textContent = !canEdit()
      ? 'Tienes rol de lector: puedes revisar todo, pero no modificar.'
      : blocked
        ? 'Primero hay que aprobar la etapa anterior.'
        : isReview
          ? ''
          : d.stage === 'DEFINITION' && !d.content
            ? 'Empieza describiendo tu idea: qué problema quieres resolver y para quién.'
            : 'Pide cambios o aclara decisiones; la IA actualizará la etapa.';

    renderMessages(d.messages);
    renderQuestions(d.questions);
    renderFindings(isReview ? [] : d.findings);
    if (!state.editing) $('editor').hidden = true;

    const content = $('content');
    content.replaceChildren(h('p', { class: 'empty' }, 'Cargando…'));
    const body = isReview ? await renderReview() : d.content ? await RENDERERS[d.stage](d) : emptyState(d);
    content.replaceChildren(body);
  }

  function emptyState(d) {
    if (!d.previousApproved) return h('p', { class: 'empty' }, 'Esta etapa se habilita cuando se apruebe la anterior.');
    if (d.stage === 'DEFINITION') return h('p', { class: 'empty' }, 'Aún no hay definición. Escribe tu idea en la conversación para comenzar.');
    return h('p', { class: 'empty' }, 'Aún no hay propuesta. Usa "Generar propuesta con IA" para crearla a partir de las etapas aprobadas.');
  }

  function renderMessages(messages) {
    const ol = $('messages');
    ol.replaceChildren(...(messages.length ? messages : []).map((m) => h('li', { class: `msg ${m.role}` },
      h('span', { class: 'who' }, m.role === 'assistant' ? `Ideator · ${fmtDate(m.createdAt)}` : `${m.author?.name || 'Usuario'} · ${fmtDate(m.createdAt)}`),
      m.content)));
    if (!messages.length) ol.append(h('li', { class: 'empty' }, 'Sin mensajes todavía.'));
    ol.scrollTop = ol.scrollHeight;
  }

  function renderFindings(findings) {
    const box = $('findings');
    if (!findings?.length) {
      box.replaceChildren();
      return;
    }
    box.replaceChildren(h('div', { class: 'findings' }, findings.map((f) => h('div', { class: `finding ${f.severity}` },
      `${f.severity === 'error' ? 'Inconsistencia' : 'Advertencia'}: ${f.message}`))));
  }

  // ---------- Preguntas ----------
  function renderQuestions(questions) {
    const box = $('questionsBox');
    const open = questions.filter((q) => q.status === 'open');
    const closed = questions.filter((q) => q.status !== 'open' && !(q.answer || '').startsWith('Reemplazada'));
    box.replaceChildren();
    if (!open.length && !closed.length) return;

    if (open.length) {
      const blockingCount = open.filter((q) => q.blocking).length;
      box.append(h('h2', {}, `Preguntas pendientes${blockingCount ? ` · ${blockingCount} bloqueante(s)` : ''}`));
      box.append(h('p', { class: 'hint' }, 'Las bloqueantes deben resolverse antes de aprobar la etapa. Puedes elegir una opción, escribir tu propia respuesta o descartarla explicando por qué.'));
      const inputs = new Map();
      open.forEach((q) => {
        const textarea = h('textarea', { rows: 2, placeholder: 'Tu respuesta…', disabled: !canEdit() });
        const dismiss = h('input', { type: 'checkbox', disabled: !canEdit() });
        const optionButtons = (q.options || []).map((option) => h('button', {
          type: 'button',
          class: 'option',
          disabled: !canEdit(),
          onclick: (event) => {
            textarea.value = option;
            event.currentTarget.parentElement.querySelectorAll('.option').forEach((b) => b.classList.remove('selected'));
            event.currentTarget.classList.add('selected');
          },
        }, option));
        inputs.set(q.id, { textarea, dismiss, stage: q.stage });
        box.append(h('div', { class: `question ${q.blocking ? 'blocking' : ''}` },
          h('div', {},
            h('span', { class: `tag ${q.blocking ? 'blocking' : 'optional'}` }, q.blocking ? 'Bloqueante' : 'Opcional'),
            q.source === 'review' ? h('span', { class: 'tag review' }, 'Revisión final') : null,
            state.current === 'REVIEW' ? h('span', { class: 'tag optional' }, stageLabel(q.stage)) : null),
          h('div', { class: 'q-text' }, q.text),
          q.reason ? h('div', { class: 'q-reason' }, q.reason) : null,
          optionButtons.length ? h('div', { class: 'options' }, optionButtons) : null,
          textarea,
          h('label', { class: 'dismiss' }, dismiss, 'Descartar (la respuesta se toma como motivo)')));
      });
      if (canEdit()) {
        box.append(h('div', { class: 'row' }, h('button', {
          type: 'button',
          id: 'answerButton',
          disabled: state.busy,
          onclick: (event) => submitAnswers(inputs, event.currentTarget),
        }, 'Enviar respuestas')));
      }
    }
    if (closed.length) {
      box.append(h('details', { class: 'answered' },
        h('summary', {}, `Decisiones tomadas (${closed.length})`),
        h('ul', {}, closed.map((q) => h('li', {}, h('strong', {}, q.text), ' → ', q.status === 'dismissed' ? `(descartada) ${q.answer || ''}` : q.answer || '', q.answeredBy ? ` — ${q.answeredBy.name}` : '')))));
    }
  }

  const stageLabel = (stage) => state.stages.find((s) => s.stage === stage)?.label || stage;

  async function submitAnswers(inputs, trigger) {
    const answers = [...inputs.entries()]
      .filter(([, input]) => input.textarea.value.trim())
      .map(([questionId, input]) => ({ questionId, answer: input.textarea.value.trim(), dismiss: input.dismiss.checked, stage: input.stage }));
    if (!answers.length) {
      banner('Escribe o elige al menos una respuesta.', 'error');
      return;
    }
    const stages = new Set(answers.map((a) => a.stage));
    if (stages.size > 1) {
      banner('Responde preguntas de una sola etapa a la vez.', 'error');
      return;
    }
    await withBusy(async () => {
      const result = await runJob('/questions/answers', { answers: answers.map(({ stage, ...rest }) => rest) });
      banner(result.turn ? `Respuestas registradas. ${result.turn.reply}` : 'Respuestas registradas.', 'success');
      if (state.current === 'REVIEW' && result.stage) {
        await loadProject();
        await selectStage(result.stage);
      }
    }, trigger);
  }

  // ---------- Trabajos de IA en segundo plano ----------
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Espera a que termine un trabajo consultando su estado. Devuelve el resultado o lanza el error.
  async function waitForJob(jobId) {
    for (;;) {
      const { job } = await call(projectPath(`/jobs/${encodeURIComponent(jobId)}`));
      if (job.status === 'succeeded') return job.result || {};
      if (job.status === 'failed') {
        const error = new Error(job.error?.message || 'La IA no pudo completar la tarea');
        Object.assign(error, { status: job.error?.status, data: job.error || {} });
        throw error;
      }
      await sleep(2500);
    }
  }

  // Lanza una acción de IA (respuesta 202 con el trabajo) y espera su resultado.
  async function runJob(path, body) {
    const data = await call(projectPath(path), { method: 'POST', body });
    return data.job ? waitForJob(data.job.id) : data;
  }

  // ---------- Acciones ----------
  // Ejecuta una acción larga (la IA puede tardar 30-90 s) mostrando progreso visible junto al botón usado y arriba.
  // Aviso que el contador de progreso no pisa durante unos segundos.
  let noticeUntil = 0;
  function busyNotice(message) {
    noticeUntil = Date.now() + 5000;
    banner(message, 'error');
  }
  const BUSY_BUTTONS = '#answerButton, #sendButton, #approveButton, #generateButton';
  async function withBusy(fn, trigger, startedAt = Date.now()) {
    if (state.busy) {
      // Nunca ignorar en silencio: avisar que hay un trabajo en curso.
      busyNotice('La IA todavía está trabajando en la petición anterior. Espera a que termine y vuelve a intentarlo.');
      return false;
    }
    state.busy = true;
    const started = startedAt;
    const originalLabel = trigger?.textContent;
    const sendLabel = $('sendButton').textContent;
    const tick = () => {
      const total = Math.max(0, Math.floor((Date.now() - started) / 1000));
      const elapsed = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
      const text = `La IA está trabajando… ${elapsed} (puede tardar 1 a 4 minutos; puedes recargar la página sin perder el trabajo)`;
      if (Date.now() > noticeUntil) banner(text, 'info');
      document.querySelectorAll(BUSY_BUTTONS).forEach((b) => {
        b.disabled = true;
        b.title = 'La IA está trabajando; espera a que termine.';
        if (b === trigger) b.textContent = `Procesando… ${elapsed}`;
        else if (b.id === 'answerButton' || b.id === 'sendButton') b.textContent = `IA trabajando… ${elapsed}`;
      });
    };
    tick();
    const timer = setInterval(tick, 1000);
    $('thinking').hidden = false;
    try {
      await fn();
    } catch (err) {
      banner(describeError(err), 'error');
    } finally {
      clearInterval(timer);
      if (/^La IA (está|todavía está) trabajando/.test($('globalStatus').textContent)) banner('');
      noticeUntil = 0;
      if (trigger && originalLabel) trigger.textContent = originalLabel;
      $('sendButton').textContent = sendLabel;
      document.querySelectorAll(BUSY_BUTTONS).forEach((b) => { b.title = ''; });
      state.busy = false;
      $('thinking').hidden = true;
      await reloadAll().catch(() => {});
    }
    return true;
  }

  $('chatForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = $('chatInput').value.trim();
    if (!message) return;
    if (state.busy) {
      busyNotice('La IA todavía está trabajando en la petición anterior. Tu mensaje no se envió; espera a que termine.');
      return;
    }
    // Muestra el mensaje de inmediato mientras la IA responde.
    const ol = $('messages');
    ol.querySelector('.empty')?.remove();
    ol.append(h('li', { class: 'msg user' }, h('span', { class: 'who' }, 'Tú · enviando…'), message));
    ol.scrollTop = ol.scrollHeight;
    await withBusy(async () => {
      $('chatInput').value = '';
      await runJob(`/stages/${state.current}/messages`, { message });
    }, $('sendButton'));
  });

  $('chatInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) $('chatForm').requestSubmit();
  });

  $('generateButton').addEventListener('click', () => withBusy(async () => {
    banner('');
    await runJob(`/stages/${state.current}/generate`);
  }, $('generateButton')));

  $('approveButton').addEventListener('click', () => withBusy(async () => {
    await call(projectPath(`/stages/${state.current}/approve`), { method: 'POST', body: { version: state.stageData.version } });
    banner(`Etapa "${state.stageData.label}" aprobada.`, 'success');
    const index = state.stages.findIndex((s) => s.stage === state.current);
    state.current = state.stages[index + 1]?.stage || state.current;
    window.location.hash = state.current;
  }));

  $('editButton').addEventListener('click', () => {
    state.editing = true;
    $('editor').hidden = false;
    $('editorText').value = JSON.stringify(state.stageData.content, null, 2);
    $('editorText').dataset.version = state.stageData.version;
    $('editorNote').value = '';
    $('editorText').focus();
  });
  $('cancelEdit').addEventListener('click', () => {
    state.editing = false;
    $('editor').hidden = true;
  });
  $('saveEdit').addEventListener('click', async () => {
    let content;
    try {
      content = JSON.parse($('editorText').value);
    } catch (err) {
      banner(`El JSON no es válido: ${err.message}`, 'error');
      return;
    }
    try {
      await call(projectPath(`/stages/${state.current}/content`), {
        method: 'PUT',
        body: { content, version: Number($('editorText').dataset.version), note: $('editorNote').value },
      });
      state.editing = false;
      $('editor').hidden = true;
      banner('Cambios guardados. La etapa vuelve a quedar en curso y debe aprobarse otra vez.', 'success');
      await reloadAll();
    } catch (err) {
      banner(describeError(err), 'error');
    }
  });

  // ---------- Diálogos ----------
  function openDialog(title, body) {
    $('dialogTitle').textContent = title;
    $('dialogBody').replaceChildren(body);
    if (!$('dialog').open) $('dialog').showModal();
  }
  $('dialogClose').addEventListener('click', () => $('dialog').close());

  $('historyButton').addEventListener('click', async () => {
    try {
      const { versions } = await call(projectPath(`/stages/${state.current}/versions`));
      const viewer = h('div');
      openDialog(`Historial · ${state.stageData.label}`, h('div', {},
        versions.length ? h('ul', { class: 'list-plain' }, versions.map((v) => h('li', {},
          h('strong', {}, `v${v.version}`), ` · ${v.source === 'ai' ? 'IA' : 'edición manual'} · ${v.createdBy?.name || '—'} · ${fmtDate(v.createdAt)}`,
          v.note ? h('div', { class: 'meta' }, v.note) : null,
          h('button', { type: 'button', class: 'ghost', onclick: () => viewer.replaceChildren(h('h4', {}, `Versión ${v.version}`), h('pre', {}, JSON.stringify(v.content, null, 2))) }, 'Ver')))) : h('p', { class: 'empty' }, 'Sin versiones.'),
        viewer));
    } catch (err) {
      banner(describeError(err), 'error');
    }
  });

  $('auditButton').addEventListener('click', async () => {
    try {
      const { entries } = await call(projectPath('/audit'));
      openDialog('Actividad del proyecto', h('ul', { class: 'list-plain' }, entries.map((e) => h('li', {},
        h('strong', {}, e.user?.name || 'Sistema'), ` ${ACTION_LABELS[e.action] || e.action}`,
        e.details?.stage ? ` (${stageLabel(e.details.stage)})` : '', e.details?.email ? ` (${e.details.email})` : '',
        h('div', { class: 'meta' }, fmtDate(e.createdAt))))));
    } catch (err) {
      banner(describeError(err), 'error');
    }
  });

  $('membersButton').addEventListener('click', () => renderMembersDialog());

  async function renderMembersDialog(message = '') {
    const { members } = await call(projectPath('/members'));
    const status = h('p', { class: 'hint' }, message);
    const rows = members.map((m) => {
      const controls = [];
      if (isOwner() && m.role !== 'owner') {
        const select = h('select', { onchange: async () => {
          try {
            await call(projectPath(`/members/${m.id}`), { method: 'PATCH', body: { role: select.value } });
            renderMembersDialog('Rol actualizado.');
          } catch (err) { status.textContent = describeError(err); }
        } }, ['editor', 'viewer'].map((r) => h('option', { value: r, selected: r === m.role }, ROLE_LABELS[r])));
        controls.push(select, h('button', { type: 'button', class: 'danger', onclick: async () => {
          try {
            await call(projectPath(`/members/${m.id}`), { method: 'DELETE' });
            renderMembersDialog('Miembro quitado.');
          } catch (err) { status.textContent = describeError(err); }
        } }, 'Quitar'));
      } else {
        controls.push(h('span', { class: `role-badge ${m.role}` }, ROLE_LABELS[m.role]));
      }
      return h('div', { class: 'member-row' }, h('div', {}, h('strong', {}, m.name), h('div', { class: 'meta' }, m.username)), h('div', { class: 'row' }, controls));
    });

    let invite = null;
    if (isOwner()) {
      const email = h('input', { type: 'email', placeholder: 'correo@ejemplo.com' });
      const role = h('select', {}, h('option', { value: 'editor' }, 'Editor'), h('option', { value: 'viewer' }, 'Lector'));
      invite = h('form', { class: 'invite', onsubmit: async (event) => {
        event.preventDefault();
        try {
          await call(projectPath('/members'), { method: 'POST', body: { email: email.value, role: role.value } });
          renderMembersDialog('Colaborador agregado.');
          loadProject();
        } catch (err) { status.textContent = describeError(err); }
      } }, email, role, h('button', { type: 'submit' }, 'Invitar'));
    }
    openDialog('Miembros del proyecto', h('div', {}, rows, invite, isOwner() ? h('p', { class: 'hint' }, 'El invitado debe tener una cuenta registrada. Editor: puede conversar, editar y aprobar. Lector: solo puede ver.') : null, status));
  }

  // ---------- Renderizadores por etapa ----------
  const RENDERERS = {
    async DEFINITION({ content: c }) {
      return h('div', {},
        section(c.productName || 'Producto', h('p', {}, c.summary)),
        section('Problema',
          h('p', {}, h('strong', {}, 'Problema: '), c.problem.statement),
          h('p', {}, h('strong', {}, 'Contexto: '), c.problem.context),
          h('p', {}, h('strong', {}, 'Situación actual: '), c.problem.currentSituation),
          h('p', {}, h('strong', {}, 'Mejora esperada: '), c.problem.expectedImprovement)),
        section('Tipos de usuario', c.userTypes.map((u) => h('div', { class: 'card' }, h('h4', {}, u.name), h('p', {}, u.description),
          h('p', {}, h('strong', {}, 'Objetivos')), list(u.goals), h('p', {}, h('strong', {}, 'Permisos')), list(u.permissions)))),
        section('Resultados esperados', table(['Resultado', 'Métrica'], c.expectedOutcomes.map((o) => [o.outcome, o.successMetric]))),
        section('Alcance del MVP',
          h('h4', {}, 'Incluido'), table(['ID', 'Funcionalidad', 'Descripción', 'Usuarios'], c.mvp.inScope.map((f) => [f.id, f.feature, f.description, f.userTypes.join(', ')])),
          h('h4', {}, 'Fuera del MVP'), table(['Funcionalidad', 'Motivo'], c.mvp.outOfScope.map((f) => [f.feature, f.reason]))),
        section(`Recorrido principal: ${c.mainJourney.name}`, h('p', { class: 'meta' }, `Actor: ${c.mainJourney.actor}`),
          table(['#', 'Usuario', 'Sistema'], [...c.mainJourney.steps].sort((a, b) => a.order - b.order).map((s) => [s.order, s.userAction, s.systemResponse]))),
        section('Requisitos funcionales', table(['ID', 'Descripción', 'Func.', 'Usuarios'], c.functionalRequirements.map((r) => [r.id, r.description, r.featureId, r.userTypes.join(', ')]))),
        section('Reglas de negocio', table(['ID', 'Regla'], c.businessRules.map((r) => [r.id, r.rule]))),
        section('Restricciones técnicas', list(c.technicalConstraints)),
        section('Integraciones', table(['Integración', 'Propósito', 'Si falla'], c.integrations.map((i) => [i.name, i.purpose, i.failureBehavior]))),
        section('Seguridad', list(c.security)),
        section('Casos borde', table(['Tipo', 'Escenario', 'Comportamiento'], c.edgeCases.map((e) => [CATEGORY_LABELS[e.category] || e.category, e.scenario, e.expectedBehavior]))),
        section('Puntos abiertos (no bloqueantes)', list(c.openItems)));
    },

    async DATA_MODEL({ content: c, diagrams }) {
      const attrType = (a) => (a.type === 'enum' ? `enum(${(a.enumValues || []).join(', ')})` : a.maxLength ? `${a.type}(${a.maxLength})` : a.type);
      return h('div', {},
        section('Modelo de datos', h('p', {}, c.overview)),
        section('Diagrama entidad-relación', await diagram(diagrams.er)),
        section('Entidades', c.entities.map((e) => h('div', { class: 'card' },
          h('h4', {}, `${e.name} · tabla ${e.tableName}`), h('p', { class: 'meta' }, e.description),
          table(['Columna', 'Tipo', 'PK', 'Oblig.', 'Único', 'Default', 'FK', 'Descripción'], e.attributes.map((a) => [
            a.name, attrType(a), a.primaryKey ? 'PK' : '', yes(!a.nullable), yes(a.unique), a.default ?? '',
            a.references ? `${a.references.entity}.${a.references.attribute} (${a.references.onDelete})` : '', a.description,
          ])),
          e.indexes.length ? h('div', {}, h('strong', {}, 'Índices'), list(e.indexes.map((i) => `${i.unique ? 'UNIQUE ' : ''}(${i.columns.join(', ')}) — ${i.reason}`))) : null,
          e.constraints.length ? h('div', {}, h('strong', {}, 'Restricciones'), list(e.constraints)) : null))),
        section('Relaciones', table(['Desde', 'Hacia', 'Cardinalidad', 'Vía', 'Descripción'], c.relationships.map((r) => [r.from, r.to, r.cardinality, r.via || '', r.description]))));
    },

    async API({ content: c }) {
      return h('div', {},
        section('Convenciones',
          h('p', {}, h('strong', {}, 'Base URL: '), c.baseUrl),
          h('p', {}, h('strong', {}, 'Autenticación: '), c.authentication),
          h('p', {}, h('strong', {}, 'Formato de error: '), c.errorFormat), list(c.conventions)),
        section(`Endpoints (${c.endpoints.length})`, c.endpoints.map((e) => h('details', { class: 'endpoint' },
          h('summary', {}, h('span', { class: `method m-${e.method}` }, e.method), `${e.path} — ${e.summary}`),
          h('p', { class: 'meta' }, `${e.id} · ${e.auth === 'public' ? 'público' : 'autenticado'}${e.roles.length ? ` · roles: ${e.roles.join(', ')}` : ''} · entidades: ${e.entities.join(', ') || '—'} · requisitos: ${e.requirementIds.join(', ') || '—'}`),
          e.pathParams.length ? h('div', {}, h('h4', {}, 'Parámetros de ruta'), table(['Nombre', 'Tipo', 'Descripción'], e.pathParams.map((p) => [p.name, p.type, p.description]))) : null,
          e.queryParams.length ? h('div', {}, h('h4', {}, 'Query'), table(['Nombre', 'Tipo', 'Oblig.', 'Validación'], e.queryParams.map((p) => [p.name, p.type, yes(p.required), p.validation]))) : null,
          e.headers.length ? h('div', {}, h('h4', {}, 'Headers'), table(['Nombre', 'Oblig.', 'Descripción'], e.headers.map((x) => [x.name, yes(x.required), x.description]))) : null,
          e.requestBody ? h('div', {}, h('h4', {}, `Body (${e.requestBody.contentType})`),
            table(['Campo', 'Tipo', 'Oblig.', 'Validación'], e.requestBody.fields.map((f) => [f.name, f.type, yes(f.required), f.validation])),
            e.requestBody.example ? h('pre', { class: 'light' }, e.requestBody.example) : null) : null,
          h('h4', {}, 'Respuestas'),
          table(['Código', 'Cuándo', 'Body'], e.responses.map((r) => [String(r.status), r.description, r.body ? h('pre', { class: 'light' }, r.body) : '']))))));
    },

    async FRONTEND({ content: c, diagrams }) {
      return h('div', {},
        section('Interfaz', h('p', {}, c.overview), h('p', { class: 'meta' }, `Pantalla inicial: ${c.entryScreenId} · Flujo principal: ${c.mainFlow.join(' → ')}`)),
        section('Mapa de navegación', await diagram(diagrams.navigation)),
        section(`Pantallas (${c.screens.length})`, c.screens.map((s) => h('details', { class: 'screen' },
          h('summary', {}, `${s.id} · ${s.name} (${s.route})`),
          h('p', {}, s.purpose),
          h('p', { class: 'meta' }, `Acceden: ${s.roles.join(', ') || 'todos'} · Estados: ${s.states.join(', ')}`),
          h('p', {}, h('strong', {}, 'Muestra: '), s.dataShown.join('; ') || '—'),
          table(['Acción', 'Endpoint', 'Visible para', 'Resultado'], s.actions.map((a) => [a.label, a.endpointId || '(navegación)', a.roles.join(', ') || 'todos', a.result])),
          h('pre', {}, s.wireframe)))));
    },

    async ARCHITECTURE({ content: c, architectures }) {
      const chosen = architectures?.find((a) => a.id === c.templateId);
      const kv = (obj) => table(['Aspecto', 'Decisión'], Object.entries(obj).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v]));
      return h('div', {},
        section('Arquitectura seleccionada', h('div', { class: 'card selected' }, h('h4', {}, chosen ? chosen.name : c.templateId), h('p', {}, c.justification)),
          h('h4', {}, 'Alternativas descartadas'), table(['Arquitectura', 'Motivo'], c.alternativesDiscarded.map((a) => [a.templateId, a.reason]))),
        section('Base de datos', kv(c.database)),
        section('Backend', kv(c.backend)),
        section('Frontend', kv(c.frontend)),
        section('Comunicación', h('p', {}, c.communication)),
        section('Autenticación y autorización', kv(c.authentication)),
        section('Despliegue', kv({ docker: c.deployment.docker, hosting: c.deployment.hosting, ambientes: c.deployment.environments, configuración: c.deployment.configuration }),
          h('h4', {}, 'Variables de entorno'), table(['Variable', 'Descripción', 'Ejemplo'], c.deployment.envVars.map((v) => [v.name, v.description, v.example]))),
        section('Observabilidad', kv(c.observability)),
        section('Pruebas', h('p', {}, c.testing)),
        section('Estructura del proyecto', h('pre', {}, c.projectStructure)),
        section('Riesgos', list(c.risks)),
        section('Arquitecturas base disponibles', (architectures || []).map((a) => h('div', { class: `card ${a.id === c.templateId ? 'selected' : ''}` }, h('h4', {}, `${a.name} (${a.id})`), h('p', { class: 'meta' }, a.bestFor)))));
    },
  };

  // ---------- Revisión y documentos ----------
  async function renderReview() {
    const review = await call(projectPath('/review'));
    const wrap = h('div');
    const statusSection = section(review.ready ? 'Listo para generar los documentos' : 'Antes de generar los documentos',
      review.ready ? h('p', {}, 'Todas las etapas están aprobadas, no hay inconsistencias ni preguntas bloqueantes y la revisión con IA está al día.')
        : h('ul', { class: 'reasons' }, review.reasons.map((r) => h('li', {}, r))));
    wrap.append(statusSection);

    wrap.append(section('Estado de las etapas', table(['Etapa', 'Estado', 'Versión'],
      state.stages.filter((s) => s.stage !== 'REVIEW').map((s) => [s.label, STATUS_LABELS[review.stages[s.stage]?.status] || '', String(review.stages[s.stage]?.version ?? '')]))));

    const errors = review.findings.filter((f) => f.severity === 'error');
    const warnings = review.findings.filter((f) => f.severity === 'warning');
    wrap.append(section('Consistencia entre etapas',
      errors.length || warnings.length ? h('div', { class: 'findings' }, [...errors, ...warnings].map((f) => h('div', { class: `finding ${f.severity}` }, `${stageLabel(f.stage)}: ${f.message}`)))
        : h('p', {}, 'Sin hallazgos.')));

    if (review.openBlocking.length) {
      wrap.append(section('Preguntas bloqueantes abiertas', h('ul', {}, review.openBlocking.map((q) => h('li', {},
        h('a', { href: `#${q.stage}`, onclick: (event) => { event.preventDefault(); selectStage(q.stage); } }, stageLabel(q.stage)), `: ${q.text}`)))));
    }

    const reviewInfo = review.review
      ? h('p', { class: 'meta' }, `Última revisión con IA: ${fmtDate(review.review.ranAt)} · ${review.review.issues} observación(es) · ${review.reviewUpToDate ? 'al día' : 'desactualizada'}${review.review.summary ? ` — ${review.review.summary}` : ''}`)
      : h('p', { class: 'meta' }, 'Aún no se ejecuta la revisión con IA.');
    const allApproved = Object.entries(review.stages).filter(([s]) => s !== 'REVIEW').every(([, v]) => v.status === 'APPROVED');
    wrap.append(section('Revisión final con IA', reviewInfo,
      h('p', { class: 'hint' }, 'Busca contradicciones entre etapas y vacíos que obligarían a la IA implementadora a inventar decisiones. Lo que encuentre aparece como preguntas en la etapa afectada.'),
      canEdit() ? h('button', { type: 'button', disabled: state.busy || !allApproved, onclick: (event) => withBusy(async () => {
        const result = await runJob('/review');
        banner(result.issues.length ? `La revisión encontró ${result.issues.length} observación(es).` : 'La revisión no encontró problemas.', result.issues.length ? 'info' : 'success');
      }, event.currentTarget) }, 'Ejecutar revisión con IA') : null));

    const files = h('div', { class: 'files' });
    wrap.append(section('Documentos finales',
      h('p', { class: 'hint' }, 'Se generan dos archivos Markdown autocontenidos (producto.md y arquitectura.md) para entregar a otra IA.'),
      h('button', { type: 'button', disabled: !review.ready, onclick: async () => {
        try {
          const { files: docs } = await call(projectPath('/export'));
          files.replaceChildren(...docs.map((doc) => h('div', { class: 'card' },
            h('div', { class: 'row' }, h('h4', { style: 'margin-right:auto' }, doc.name),
              h('button', { type: 'button', class: 'ghost', onclick: () => navigator.clipboard?.writeText(doc.content).then(() => banner(`${doc.name} copiado.`, 'success')) }, 'Copiar'),
              h('a', { href: `${apiBase}${projectPath(`/export/${doc.name}`)}`, download: doc.name }, h('button', { type: 'button' }, 'Descargar'))),
            h('pre', { class: 'light', style: 'max-height:360px;overflow:auto;white-space:pre-wrap' }, doc.content))));
        } catch (err) {
          banner(describeError(err), 'error');
        }
      } }, 'Generar documentos'),
      files));
    return wrap;
  }

  // ---------- Colaboración: refresco periódico ----------
  setInterval(async () => {
    if (state.busy || state.editing || document.hidden || $('dialog').open) return;
    const before = state.stageData?.version;
    const beforeStatus = state.stageData?.status;
    const beforeQuestions = JSON.stringify((state.stageData?.questions || []).map((q) => q.status));
    const beforeMessages = state.stageData?.messages?.length;
    try {
      await loadProject();
      const next = await call(projectPath(`/stages/${state.current}`));
      const changed = next.version !== before || next.status !== beforeStatus || next.messages.length !== beforeMessages
        || JSON.stringify(next.questions.map((q) => q.status)) !== beforeQuestions;
      if (changed) {
        const draft = $('chatInput').value;
        state.stageData = next;
        await renderStage();
        $('chatInput').value = draft;
        if (next.version !== before && next.updatedBy) banner(`${next.updatedBy.name} actualizó esta etapa.`, 'info');
      }
    } catch (err) { /* reintenta en el próximo ciclo */ }
  }, POLL_MS);

  window.addEventListener('hashchange', () => {
    const stage = window.location.hash.slice(1);
    if (stage && stage !== state.current && state.stages.some((s) => s.stage === stage)) selectStage(stage);
  });

  // ---------- Inicio ----------
  if (!projectId) {
    window.location.href = 'index.html';
    return;
  }
  reloadAll().catch((err) => {
    $('projectName').textContent = err.status === 404 ? 'Proyecto no encontrado' : 'Error';
    banner(err.status === 404 ? 'El proyecto no existe o no tienes acceso.' : describeError(err), 'error');
  });
})();
