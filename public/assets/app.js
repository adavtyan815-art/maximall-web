/* MaxiMall landing + loading flow.
 * Backend contract (socket events, emits, storage keys, redirect URL) is kept
 * identical to the previous inline script — see docs/REDESIGN_PLAN.md §4.
 * Only the view layer (what is shown and how progress is drawn) changed. */
(function () {
  'use strict';

  const socket = io();

  // ── Load update date from settings ────────────────────────────────────
  async function loadClientSettings() {
    try {
      const res = await fetch('/api/settings');
      const settings = await res.json();
      if (settings && settings.updateDate) {
        const dateSpan = document.getElementById('update-date');
        if (dateSpan) dateSpan.textContent = settings.updateDate;
      }
    } catch (err) { console.error('Failed to load settings', err); }
  }
  loadClientSettings();

  // ── Element refs ──────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const btn = $('btn');
  const tipsText = $('tip');
  const progressStage = $('progress-stage');
  const progressMeta = $('progress-meta');
  const progressTrack = $('progress-track');
  const progressFill = $('progress-fill');
  const progressStatus = $('progress-status');
  const cancelLoadingBtn = $('cancel-loading-btn');
  const backBtn = $('back-btn');
  const retryBtn = $('retry-btn');

  const CTA_LABEL = 'Войти в 3D-комнату';
  const IDLE_LEAD = 'Откройте 3D-салон за считанные секунды — мы запустим сервер для вас.';

  // Device Identification (Persistent)
  let deviceId = localStorage.getItem('deviceId');
  if (!deviceId) {
    // crypto.randomUUID exists only on secure origins (HTTPS/localhost); fall back elsewhere.
    deviceId = (window.crypto && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
    localStorage.setItem('deviceId', deviceId);
  }

  // The UUID that was dynamically assigned during this session
  let assignedUuid = sessionStorage.getItem('assignedUuid');
  let globalHostToken = sessionStorage.getItem('global_hostToken');
  let isRescuedRedirect = false;

  const tips = [
    'Подсказка: для перемещения на компьютере используйте клавиши WASD и мышь.',
    'Для управления на телефоне используйте виртуальные кнопки на экране.',
    'В 3D-модели вы можете менять цвета и материалы мебели одним касанием.',
    'Для наилучшего качества рекомендуется использовать стабильное интернет-соединение.',
    'Окружение загружается на облачном сервере, чтобы не перегружать ваше устройство.',
    'Чёткость изображения зависит от скорости соединения: при слабом соединении качество может временно снизиться.'
  ];
  let tipInterval = null;
  let tipIndex = 0;

  // ── View state ────────────────────────────────────────────────────────
  // idle | loading | ready | error   (see docs/REDESIGN_PLAN.md §3)
  function getState() { return stage.dataset.state; }

  function setState(next) {
    stage.dataset.state = next;
    renderProgress();
  }

  // Equivalent of the old `loadingUI.style.display === 'flex'` check:
  // the loader is on screen while loading and during the ready hand-off.
  function isLoaderVisible() {
    const s = getState();
    return s === 'loading' || s === 'ready';
  }

  function setCta(enabled, label) {
    btn.disabled = !enabled;
    btn.textContent = label || CTA_LABEL;
  }

  // Idle notices (session in another tab, offline, …) take the stage-label slot,
  // as the splash spec places messages "на месте подписи этапа".
  let idleNotice = null;
  function showNotice(msg) {
    idleNotice = msg;
    renderProgress();
  }

  function hideNotice() {
    idleNotice = null;
    renderProgress();
  }

  function resetSessionTokens() {
    assignedUuid = null;
    globalHostToken = null;
    sessionStorage.removeItem('assignedUuid');
    sessionStorage.removeItem('global_hostToken');
  }

  // ── Determinate progress (splash spec) ─────────────────────────────────
  const TICK_MS = 120;               // spec: update step 120 ms
  const BASE_EST_S = 40;             // measured buffer wake ≈ 36–39 s
  const STALL_MS = 10000;            // spec: stage longer than 10 s → "ещё немного"
  const CREEP_PER_TICK = 0.1 * TICK_MS / 1000; // 0.1 %/s while waiting at a cap
  const STAGES = [
    [0, 'Подключение к MaxiMall'],
    [16, 'Открываем салон OLIVEEKA'],
    [42, 'Загружаем сцену и материалы'],
    [74, 'Подключаем 3D-трансляцию']
  ];
  const READY_LABEL = 'Салон OLIVEEKA готов';
  const SLOW_LABEL = 'Ещё немного — грузим тяжёлые материалы';
  // Backend events raise the ceiling; progress never runs past `limit` on its own.
  const CAPS = {
    request: { cap: 15, limit: 15.9 },
    pending: { cap: 41, limit: 41.9 },
    booting: { cap: 84, limit: 96 }
  };

  const progress = {
    pct: 0, cap: 0, limit: 0,
    timer: null, finishing: null,
    startedAt: 0, pausedMs: 0, pausedAt: 0,
    capReachedAt: 0,
    override: null,     // transient connection message shown instead of the stage
    error: null         // error message (error state)
  };

  function stageLabelFor(pct) {
    let label = STAGES[0][1];
    for (const [threshold, text] of STAGES) if (pct >= threshold) label = text;
    return label;
  }

  function elapsedSeconds() {
    if (!progress.startedAt) return 0;
    const pausedNow = progress.pausedAt ? Date.now() - progress.pausedAt : 0;
    return (Date.now() - progress.startedAt - progress.pausedMs - pausedNow) / 1000;
  }

  function etaLabel(pct) {
    const elapsed = elapsedSeconds();
    const est = Math.max(BASE_EST_S, pct > 5 ? (elapsed * 100) / pct : BASE_EST_S);
    const left = Math.max(1, Math.ceil(((100 - pct) / 100) * est));
    if (left < 60) return 'осталось ' + left + ' с';
    const m = Math.floor(left / 60);
    const s = left % 60;
    return 'осталось ' + m + ' мин' + (s ? ' ' + s + ' с' : '');
  }

  function renderProgress() {
    const state = getState();
    const pct = state === 'idle' ? 0 : progress.pct;
    const shown = Math.floor(pct); // floor: never display a threshold the stage label has not reached

    progressFill.style.width = pct.toFixed(1) + '%';
    progressTrack.setAttribute('aria-valuenow', String(shown));
    // Door width in design px (spec: 240 → 580); CSS multiplies by the scale unit.
    stage.style.setProperty('--door', (240 + pct * 3.4).toFixed(1));

    let label;
    let meta;
    let status;
    let alert = !!progress.override;
    if (state === 'idle') {
      label = idleNotice || IDLE_LEAD;
      meta = '';
      status = '';
      alert = !!idleNotice;
    } else if (state === 'error') {
      label = progress.error || 'Не удалось открыть салон.';
      meta = shown + '%';
      status = 'Ошибка';
    } else if (state === 'ready') {
      label = READY_LABEL;
      meta = '100% · готово';
      status = 'Вход';
    } else {
      const stalled = progress.capReachedAt && pct >= progress.cap && Date.now() - progress.capReachedAt > STALL_MS;
      label = progress.override || (stalled ? SLOW_LABEL : stageLabelFor(pct));
      meta = shown + '% · ' + etaLabel(pct);
      status = 'Загрузка';
    }
    if (progressStage.textContent !== label) progressStage.textContent = label;
    progressStage.classList.toggle('is-alert', alert);
    progressMeta.textContent = meta;
    progressStatus.textContent = status;
  }

  function progressTick() {
    if (progress.pct < progress.cap) {
      progress.pct = Math.min(progress.cap, progress.pct + (100 / BASE_EST_S) * (TICK_MS / 1000));
      if (progress.pct >= progress.cap) progress.capReachedAt = Date.now();
    } else if (progress.pct < progress.limit) {
      progress.pct = Math.min(progress.limit, progress.pct + CREEP_PER_TICK);
    }
    renderProgress();
  }

  // Start (or resume after a pause) — never moves progress backwards.
  function progressStart() {
    if (progress.finishing) return;
    if (!progress.startedAt) {
      progress.startedAt = Date.now();
      raiseCap('request');
    }
    if (progress.pausedAt) {
      progress.pausedMs += Date.now() - progress.pausedAt;
      progress.pausedAt = 0;
    }
    if (!progress.timer) progress.timer = setInterval(progressTick, TICK_MS);
    renderProgress();
  }

  function progressPause() {
    if (progress.timer) { clearInterval(progress.timer); progress.timer = null; }
    if (progress.startedAt && !progress.pausedAt) progress.pausedAt = Date.now();
  }

  function progressReset() {
    progressPause();
    if (progress.finishing) { clearInterval(progress.finishing); progress.finishing = null; }
    Object.assign(progress, {
      pct: 0, cap: 0, limit: 0, startedAt: 0, pausedMs: 0, pausedAt: 0,
      capReachedAt: 0, override: null, error: null
    });
    renderProgress();
  }

  function raiseCap(key) {
    const c = CAPS[key];
    if (c.cap > progress.cap) {
      progress.cap = c.cap;
      progress.limit = c.limit;
      progress.capReachedAt = 0;
    }
  }

  function completeProgress(callback) {
    progressPause();
    progress.override = null;
    if (progress.finishing) clearInterval(progress.finishing);
    progress.finishing = setInterval(() => {
      if (progress.pct < 100) {
        progress.pct = Math.min(100, progress.pct + (100 - progress.pct) * 0.25 + 0.5);
        renderProgress();
      } else {
        clearInterval(progress.finishing);
        progress.finishing = null;
        if (callback) callback();
      }
    }, 30);
  }

  function setTransient(msg) {
    progress.override = msg;
    renderProgress();
  }

  function clearTransient() {
    if (progress.override) {
      progress.override = null;
      renderProgress();
    }
  }

  // ── Tips ──────────────────────────────────────────────────────────────
  function startTips() {
    if (tipInterval) return;
    tipsText.textContent = tips[tipIndex];
    tipsText.style.opacity = 1;
    tipInterval = setInterval(() => {
      tipIndex = (tipIndex + 1) % tips.length;
      tipsText.style.opacity = 0;
      setTimeout(() => {
        tipsText.textContent = tips[tipIndex];
        tipsText.style.opacity = 1;
      }, 600);
    }, 8000);
  }

  function stopTips() {
    if (tipInterval) { clearInterval(tipInterval); tipInterval = null; }
  }

  // ── UI state helpers (same call sites as before) ───────────────────────
  function showLoadingUI() {
    stage.classList.remove('is-leaving');
    progress.error = null;
    setState('loading');
    hideNotice();
    progressStart();
    startTips();
  }

  function showLauncherUI(keepError = false) {
    stage.classList.remove('is-leaving');
    progressReset();
    setState('idle');
    if (!keepError) hideNotice();
    stopTips();
  }

  function showFailure(msg) {
    progressPause();
    progress.override = null;
    progress.error = msg;
    stopTips();
    setState('error');
    retryBtn.focus({ preventScroll: true });
  }

  function showNoInstanceUI() {
    showFailure('Все 3D-серверы сейчас заняты. Попробуйте снова через несколько минут. Если проблема не решится, свяжитесь с Maxi Mall.');
  }

  function showError(msg) {
    // A failure during loading stays on the splash (spec: message in place of
    // the stage, bar frozen, «Повторить»). Otherwise it appears under the CTA.
    if (isLoaderVisible() || getState() === 'error') {
      showFailure(msg);
    } else {
      showLauncherUI(true);
      showNotice(msg);
    }
    setCta(true);
    resetSessionTokens();
  }

  // ── Retry, back & cancel ───────────────────────────────────────────────
  backBtn.onclick = (e) => {
    e.preventDefault();
    showLauncherUI();
    setCta(true);
    resetSessionTokens();
    btn.focus({ preventScroll: true });
  };

  retryBtn.onclick = (e) => {
    e.preventDefault();
    resetSessionTokens();
    requestInstance();
  };

  cancelLoadingBtn.onclick = (e) => {
    e.preventDefault();
    if (socket.connected && (assignedUuid || globalHostToken)) {
      socket.emit('cancel-request', {
        instanceUuid: assignedUuid || undefined,
        hostToken: globalHostToken || undefined
      });
    }
    showLauncherUI();
    setCta(true);
    resetSessionTokens();
    btn.focus({ preventScroll: true });
  };

  // ── Socket Events ──────────────────────────────────────────────────────
  let connectErrorTimeout = null;
  let requestSocketId = null;   // socket.id that carried the latest request-instance

  socket.on('connect_error', (err) => {
    console.error('Connection Error:', err);
    if (isLoaderVisible()) {
      setTransient('Ошибка подключения к серверу.');
      if (!connectErrorTimeout) {
        connectErrorTimeout = setTimeout(() => {
          connectErrorTimeout = null;
          if (isLoaderVisible()) {
            showError('Не удалось подключиться к серверу. Пожалуйста, попробуйте снова.');
          }
        }, 8000);
      }
    } else {
      btn.disabled = false;
    }
  });

  socket.on('connect', () => {
    console.log('Connected to server');
    if (connectErrorTimeout) {
      clearTimeout(connectErrorTimeout);
      connectErrorTimeout = null;
    }
    clearTransient();

    // Check if redirected due to inactivity
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('reason') === 'idle') {
      console.log('Bypassing auto-resume/loading because redirect was due to inactivity.');

      // Clean reason=idle from history to avoid loops on manual refresh
      urlParams.delete('reason');
      const newSearch = urlParams.toString();
      const cleanUrl = newSearch !== '' ? `${location.pathname}?${newSearch}` : location.pathname;
      window.history.replaceState({}, '', cleanUrl);

      // Explicitly clear any session storage tokens so they don't resume on subsequent pages
      resetSessionTokens();

      // Show launcher UI and stop progress bar
      showLauncherUI();
      return;
    }

    // 1. Auto-Resume Check (Skip login button if active session exists)
    socket.emit('check-active-session', {
      deviceId,
      hostToken: globalHostToken || undefined
    });

    // Fallback for explicitly stored session
    if (assignedUuid && globalHostToken) {
      showLoadingUI();
      socket.emit('resume-instance', {
        instanceUuid: assignedUuid,
        hostToken: globalHostToken,
        deviceId: deviceId
      });
    }
  });

  socket.on('disconnect', (reason) => {
    console.warn('Disconnected:', reason);
    if (isLoaderVisible()) {
      progressPause();
      setTransient('Связь потеряна. Ожидание восстановления…');
      if (!connectErrorTimeout) {
        connectErrorTimeout = setTimeout(() => {
          connectErrorTimeout = null;
          if (isLoaderVisible()) {
            showError('Связь с сервером прервана. Пожалуйста, попробуйте снова.');
          }
        }, 10000);
      }
    }
  });

  // In Socket.IO v4 reconnection events are emitted by the Manager (socket.io),
  // not by the socket — the previous `socket.on('reconnect_attempt')` never fired.
  socket.io.on('reconnect_attempt', (attempt) => {
    console.log('Attempting to reconnect:', attempt);
    if (isLoaderVisible()) {
      setTransient(`Переподключение (попытка ${attempt})…`);
    }
  });

  socket.on('session-found', (data) => {
    console.log('Active session detected on server. Auto-resuming...');
    assignedUuid = data.uuid;
    globalHostToken = data.hostToken;
    sessionStorage.setItem('assignedUuid', assignedUuid);
    sessionStorage.setItem('global_hostToken', globalHostToken);

    showLoadingUI();
    socket.emit('resume-instance', {
      instanceUuid: assignedUuid,
      hostToken: globalHostToken,
      deviceId: deviceId
    });
  });

  socket.on('session-in-use', (data) => {
    console.log('Active stream detected in another tab:', data);
    showLauncherUI(true);
    showNotice(data.message || '3D-комната уже открыта в другой вкладке.');
    setCta(true);
    resetSessionTokens();
  });

  socket.on('session-not-found', () => {
    if (assignedUuid) return;
    // A request sent on this same connection is still in flight — the answer
    // (instance-assigned / status) is on its way, so stay on the splash.
    if (getState() === 'loading' && requestSocketId === socket.id) return;
    // Otherwise nothing is pending server-side (e.g. the socket dropped before
    // the instance was assigned): return to the launcher with the button usable.
    showLauncherUI();
    setCta(true);
  });

  socket.on('instance-assigned', (data) => {
    assignedUuid = data.uuid;
    globalHostToken = data.hostToken;
    sessionStorage.setItem('assignedUuid', assignedUuid);
    sessionStorage.setItem('global_hostToken', globalHostToken);

    if (data.rescued) {
      isRescuedRedirect = true;
    } else {
      isRescuedRedirect = false;
    }
  });

  socket.on('no-instance-available', () => {
    showNoInstanceUI();
    btn.disabled = false;
  });

  socket.on('instance-error', (data) => {
    showError(data.message || 'Ошибка подключения к серверу.');
  });

  socket.on('instance-status', (data) => {
    const { status } = data;
    if (status === 'stopped') {
      if (data.lastError) {
        showError(data.lastError);
      } else {
        showLauncherUI();
        setCta(true);
        resetSessionTokens();
      }
    }
    else if (status === 'stopping') {
      showLauncherUI();
      setCta(false, 'Ожидайте завершения…');
    }
    else if (status === 'pending') {
      showLoadingUI();
      raiseCap('pending');   // server is booting
    }
    else if (status === 'booting_server') {
      showLoadingUI();
      raiseCap('booting');   // server is up, 3D app is starting
    }
  });

  socket.on('server-ready', (data) => {
    completeProgress(() => {
      stopTips();
      tipsText.textContent = 'Соединение установлено.';
      setState('ready');

      let targetUrl = data.pinggyUrl || data.ip || 'http://localhost:8000';

      // If it is a relative proxy path (e.g. /instance/<uuid>), preserve it. Otherwise, add default http scheme.
      if (!targetUrl.startsWith('/') && !targetUrl.startsWith('http')) {
        targetUrl = `http://${targetUrl}:8000`;
      }

      // Build WebSocket signaling URL (ss parameter) if using relative proxying
      let wsUrl = '';
      if (targetUrl.startsWith('/')) {
        const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        wsUrl = `${wsProtocol}://${window.location.host}${targetUrl}/ws`;
      }

      let pixelStreamLink =
        `${targetUrl}/player.html` +
        `?backendUrl=${encodeURIComponent(window.location.origin)}` +
        `&instanceUuid=${assignedUuid}` +
        `&hostToken=${encodeURIComponent(globalHostToken)}` +
        `&deviceId=${encodeURIComponent(deviceId)}`;

      if (wsUrl) {
        pixelStreamLink += `&ss=${encodeURIComponent(wsUrl)}`;
      }

      // Spec: hold the finished state 0.6 s, then a 250 ms crossfade.
      // Rescued sessions keep the previous 3 s delay.
      const FADE_MS = 250;
      const delay = isRescuedRedirect ? 3000 : 600 + FADE_MS;
      setTimeout(() => { stage.classList.add('is-leaving'); }, delay - FADE_MS);
      setTimeout(() => { window.location.href = pixelStreamLink; }, delay);
    });
  });

  // ── Button click: request server via WebSocket ──────────────────────────
  function requestInstance() {
    if (!navigator.onLine) {
      showError('Пожалуйста, проверьте подключение к интернету.');
      return;
    }

    if (!socket.connected) {
      showError('Нет соединения с сервером. Повторное подключение…');
      socket.connect();
      return;
    }

    btn.disabled = true;
    progressReset();
    showLoadingUI();
    requestSocketId = socket.id;

    socket.emit('request-instance', {
      hostToken: globalHostToken || undefined,
      deviceId: deviceId
    });
  }

  btn.onclick = (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    requestInstance();
  };

  renderProgress();
})();
