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

  // ── Visitor language (contract v2.5): «RU | EN» toggle, top-right ──────
  // Default: localStorage['maximall.lang'] (the visitor's last choice, shared with the consultant panel), else the browser
  // language (en* → en, else ru). The choice goes to the player as &lang=. The page's own texts switch live; messages that
  // come from the server are shown as sent.
  const LANG_KEY = 'maximall.lang';
  const TEXT = {
    ru: {
      title: 'MaxiMall — салон OLIVEEKA в 3D',
      social: 'Мы в соцсетях',
      email: 'Почта',
      pathLabel: 'Расположение',
      pathHere: 'САЛОН',
      descriptor: 'Сантехника и мебель для ванных комнат',
      loadingLabel: 'Загрузка салона',
      footer: '© Maxi Mall · Веб · Обновлено ',
      cancel: 'Отменить',
      back: 'Назад',
      retry: 'Повторить',
      cta: 'Войти в 3D-комнату',
      idleLead: 'Откройте 3D-салон за считанные секунды — мы запустим сервер для вас.',
      tips: [
        'Подсказка: для перемещения на компьютере используйте клавиши WASD и мышь.',
        'Для управления на телефоне используйте виртуальные кнопки на экране.',
        'В 3D-модели вы можете менять цвета и материалы мебели одним касанием.',
        'Для наилучшего качества рекомендуется использовать стабильное интернет-соединение.',
        'Окружение загружается на облачном сервере, чтобы не перегружать ваше устройство.',
        'Чёткость изображения зависит от скорости соединения: при слабом соединении качество может временно снизиться.'
      ],
      stages: ['Подключение к MaxiMall', 'Открываем салон OLIVEEKA', 'Загружаем сцену и материалы', 'Подключаем 3D-трансляцию'],
      ready: 'Салон OLIVEEKA готов',
      slow: 'Ещё немного — грузим тяжёлые материалы',
      etaS: 'осталось {s} с',
      etaM: 'осталось {m} мин',
      etaMS: 'осталось {m} мин {s} с',
      openFailed: 'Не удалось открыть салон.',
      metaReady: '100% · готово',
      statusError: 'Ошибка',
      statusEnter: 'Вход',
      statusLoading: 'Загрузка',
      noInstance: 'Все 3D-серверы сейчас заняты. Попробуйте снова через несколько минут. Если проблема не решится, свяжитесь с Maxi Mall.',
      connError: 'Ошибка подключения к серверу.',
      connFailed: 'Не удалось подключиться к серверу. Пожалуйста, попробуйте снова.',
      lost: 'Связь потеряна. Ожидание восстановления…',
      dropped: 'Связь с сервером прервана. Пожалуйста, попробуйте снова.',
      reconnecting: 'Переподключение (попытка {n})…',
      inUse: '3D-комната уже открыта в другой вкладке.',
      waitStop: 'Ожидайте завершения…',
      connected: 'Соединение установлено.',
      offline: 'Пожалуйста, проверьте подключение к интернету.',
      noSocket: 'Нет соединения с сервером. Повторное подключение…'
    },
    en: {
      title: 'MaxiMall — the OLIVEEKA showroom in 3D',
      social: 'Follow us',
      email: 'Email',
      pathLabel: 'Location',
      pathHere: 'SHOWROOM',
      descriptor: 'Bathroom fixtures and furniture',
      loadingLabel: 'Loading the showroom',
      footer: '© Maxi Mall · Web · Updated ',
      cancel: 'Cancel',
      back: 'Back',
      retry: 'Retry',
      cta: 'Enter the 3D room',
      idleLead: "Open the 3D showroom in seconds — we'll start a server for you.",
      tips: [
        'Tip: on a computer, move around with the WASD keys and the mouse.',
        'On a phone, use the on-screen virtual buttons.',
        'In the 3D model you can change furniture colours and materials with a single tap.',
        'For the best quality, use a stable internet connection.',
        'The scene runs on a cloud server, so your device is not overloaded.',
        'Image sharpness depends on your connection speed: on a weak connection the quality may drop for a while.'
      ],
      stages: ['Connecting to MaxiMall', 'Opening the OLIVEEKA showroom', 'Loading the scene and materials', 'Starting the 3D stream'],
      ready: 'The OLIVEEKA showroom is ready',
      slow: 'Almost there — loading heavy materials',
      etaS: '{s} s left',
      etaM: '{m} min left',
      etaMS: '{m} min {s} s left',
      openFailed: 'Could not open the showroom.',
      metaReady: '100% · ready',
      statusError: 'Error',
      statusEnter: 'Entering',
      statusLoading: 'Loading',
      noInstance: 'All 3D servers are busy right now. Please try again in a few minutes. If the problem persists, contact Maxi Mall.',
      connError: 'Error connecting to the server.',
      connFailed: 'Could not connect to the server. Please try again.',
      lost: 'Connection lost. Waiting for it to come back…',
      dropped: 'The connection to the server was interrupted. Please try again.',
      reconnecting: 'Reconnecting (attempt {n})…',
      inUse: 'The 3D room is already open in another tab.',
      waitStop: 'Please wait until it finishes…',
      connected: 'Connected.',
      offline: 'Please check your internet connection.',
      noSocket: 'No connection to the server. Reconnecting…'
    }
  };

  // Kiosk: after an inactivity redirect (?reason=idle) the next visitor starts from the default, not the previous choice.
  if (new URLSearchParams(window.location.search).get('reason') === 'idle') {
    try { localStorage.removeItem(LANG_KEY); } catch (e) { /* storage blocked */ }
  }

  function initialLang() {
    try {
      const saved = localStorage.getItem(LANG_KEY);
      if (saved === 'ru' || saved === 'en') return saved;
    } catch (e) { /* storage blocked */ }
    return /^en/i.test(navigator.language || '') ? 'en' : 'ru';
  }
  let lang = initialLang();

  // T('key', { n: 2 }) → text in the current language; M(...) → the same, resolved when shown (follows a later switch).
  function T(key, params) {
    const v = TEXT[lang][key];
    return params ? v.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : v;
  }
  function M(key, params) { return () => T(key, params); }
  function txt(v) { return typeof v === 'function' ? v() : v; }

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

  let tipInterval = null;
  let tipIndex = 0;
  let tipFinal = false; // «Соединение установлено.» is shown in place of the tips

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

  let ctaKey = 'cta';
  function setCta(enabled, labelKey) {
    btn.disabled = !enabled;
    ctaKey = labelKey || 'cta';
    btn.textContent = T(ctaKey);
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
  const STAGES = [0, 16, 42, 74]; // thresholds of TEXT.stages
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
    const labels = T('stages');
    let label = labels[0];
    STAGES.forEach((threshold, i) => { if (pct >= threshold) label = labels[i]; });
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
    if (left < 60) return T('etaS', { s: left });
    const m = Math.floor(left / 60);
    const s = left % 60;
    return s ? T('etaMS', { m, s }) : T('etaM', { m });
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
      label = txt(idleNotice) || T('idleLead');
      meta = '';
      status = '';
      alert = !!idleNotice;
    } else if (state === 'error') {
      label = txt(progress.error) || T('openFailed');
      meta = shown + '%';
      status = T('statusError');
    } else if (state === 'ready') {
      label = T('ready');
      meta = T('metaReady');
      status = T('statusEnter');
    } else {
      const stalled = progress.capReachedAt && pct >= progress.cap && Date.now() - progress.capReachedAt > STALL_MS;
      label = txt(progress.override) || (stalled ? T('slow') : stageLabelFor(pct));
      meta = shown + '% · ' + etaLabel(pct);
      status = T('statusLoading');
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
    tipFinal = false;
    tipsText.textContent = T('tips')[tipIndex];
    tipsText.style.opacity = 1;
    tipInterval = setInterval(() => {
      tipIndex = (tipIndex + 1) % T('tips').length;
      tipsText.style.opacity = 0;
      setTimeout(() => {
        tipsText.textContent = T('tips')[tipIndex];
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
    showFailure(M('noInstance'));
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
      setTransient(M('connError'));
      if (!connectErrorTimeout) {
        connectErrorTimeout = setTimeout(() => {
          connectErrorTimeout = null;
          if (isLoaderVisible()) {
            showError(M('connFailed'));
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
      setTransient(M('lost'));
      if (!connectErrorTimeout) {
        connectErrorTimeout = setTimeout(() => {
          connectErrorTimeout = null;
          if (isLoaderVisible()) {
            showError(M('dropped'));
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
      setTransient(M('reconnecting', { n: attempt }));
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
    showNotice(data.message || M('inUse'));
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
    showError(data.message || M('connError'));
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
      setCta(false, 'waitStop');
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
      tipFinal = true;
      tipsText.textContent = T('connected');
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
        `&deviceId=${encodeURIComponent(deviceId)}` +
        `&lang=${lang}`; // v2.5: the visitor language (player overlays + consultant)

      if (wsUrl) {
        pixelStreamLink += `&ss=${encodeURIComponent(wsUrl)}`;
      }

      // CR-WEB-01 (v1.3): the site has no visitor login of its own (only the admin login), so the lead identity comes from
      // UE (its login, sent in the MaxiMallAI "ready" event). If this launcher was opened with ?username= (e.g. a kiosk
      // or QR link), pass it through as a hint; the page still prefers the UE-reported username.
      // Same path-safe rule as the server's saves check: Unicode letters/digits, space, . _ @ -, at most 64, no "..".
      const hintUser = new URLSearchParams(window.location.search).get('username');
      if (hintUser && [...hintUser].length <= 64 && !hintUser.includes('..') && /^[\p{L}\p{M}\p{N} ._@-]+$/u.test(hintUser)) {
        pixelStreamLink += `&username=${encodeURIComponent(hintUser)}`;
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
      showError(M('offline'));
      return;
    }

    if (!socket.connected) {
      showError(M('noSocket'));
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

  // ── Language toggle ────────────────────────────────────────────────────
  const langButtons = Array.prototype.slice.call(document.querySelectorAll('#lang .lang__opt'));

  function applyLang() {
    document.documentElement.lang = lang;
    document.title = T('title');
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = T(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', T(el.dataset.i18nAria)); });
    langButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
    btn.textContent = T(ctaKey);
    if (tipFinal) tipsText.textContent = T('connected');
    else if (tipInterval) tipsText.textContent = T('tips')[tipIndex];
    renderProgress();
  }

  langButtons.forEach((b) => {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      const next = b.dataset.lang === 'en' ? 'en' : 'ru';
      try { localStorage.setItem(LANG_KEY, next); } catch (err) { /* storage blocked */ }
      if (next === lang) return;
      lang = next;
      applyLang();
    });
  });

  // A Russian page is already in the markup: rewrite only for English (the toggle state is set either way).
  if (lang !== 'ru') applyLang();
  else langButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));

  renderProgress();
})();
