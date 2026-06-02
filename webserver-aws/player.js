// ============================================================
// Pixel Streaming Backend Connector
// Append this code to the END of your existing player.js file
// on the AWS EC2 instance.
// 
// Prerequisites: 
//   1. The HTML page must load Socket.io client BEFORE player.js
//      Add to your HTML <head>:
//      <script src="https://cdn.socket.io/4.7.4/socket.io.min.js"></script>
//
//   2. The player page URL must include query params from the redirect:
//      ?backendUrl=https://your-backend.com&instanceUuid=xxx&hostToken=yyy
// ============================================================

(function () {
  'use strict';

  console.log('[PixelConnector] Initializing script...');

  // ── 1. Parse URL parameters ─────────────────────────────────────
  const urlParams = new URLSearchParams(window.location.search);
  const BACKEND_URL = urlParams.get('backendUrl');
  const INSTANCE_UUID = urlParams.get('instanceUuid');
  const DEVICE_ID = urlParams.get('deviceId');

  console.log('[PixelConnector] Backend URL:', BACKEND_URL);
  console.log('[PixelConnector] Instance UUID:', INSTANCE_UUID);
  console.log('[PixelConnector] Device ID:', DEVICE_ID ? DEVICE_ID.substring(0, 8) + '...' : 'MISSING');

  if (!BACKEND_URL || !INSTANCE_UUID) {
    console.warn('[PixelConnector] Missing backendUrl or instanceUuid in URL. Backend tracking disabled.');
    return;
  }

  // ── 2. State ─────────────────────────────────────────────────────
  let hostToken = urlParams.get('hostToken') || localStorage.getItem('hostToken');

  // If token came in URL, save it to localStorage for this domain (for refresh support)
  if (urlParams.get('hostToken')) {
    console.log('[PixelConnector] Saving hostToken from URL to localStorage');
    localStorage.setItem('hostToken', urlParams.get('hostToken'));
  }

  console.log('[PixelConnector] Host Token:', hostToken ? hostToken.substring(0, 8) + '...' : 'MISSING');

  let socket = null;
  let heartbeatInterval = null;
  let reconnectAttempts = 0;
  let isIntentionalDisconnect = false;
  let gracePeriodTimer = null;
  let isInGracePeriod = false;

  const MAX_RECONNECT_ATTEMPTS = 10;
  const HEARTBEAT_INTERVAL_MS = 10000; // 10 seconds
  const RECONNECT_DELAY_BASE_MS = 2000;

  // ── 3. UI Overlay ────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = 'pixel-connector-overlay';
  overlay.style.cssText = `
    display: none;
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(15, 23, 42, 0.95);
    z-index: 99999;
    font-family: 'Inter', sans-serif;
    color: #f8fafc;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 2rem;
  `;
  overlay.innerHTML = `
    <div style="max-width: 380px;">
      <div id="pc-spinner" style="
        width: 40px; height: 40px; border: 3px solid rgba(255,255,255,0.1);
        border-top: 3px solid #38bdf8; border-radius: 50%;
        animation: pcspin 1s linear infinite; margin: 0 auto 1.5rem;
      "></div>
      <h2 id="pc-title" style="font-size: 1.5rem; margin-bottom: 0.75rem; font-weight: 600;">Connecting...</h2>
      <p id="pc-msg" style="color: #94a3b8; font-size: 0.95rem; margin-bottom: 1.5rem;"></p>
      <div id="pc-time-bar-wrap" style="display:none; background: rgba(255,255,255,0.1); border-radius: 4px; overflow:hidden; margin-bottom: 0.5rem;">
        <div id="pc-time-bar" style="height: 4px; background: #6366f1; width: 0%; transition: width 1s linear;"></div>
      </div>
      <div id="pc-time-text" style="font-size: 0.75rem; color: #64748b;"></div>
    </div>
    <style>
      @keyframes pcspin { 0%{transform:rotate(0deg)} 100%{transform:rotate(360deg)} }
    </style>
  `;
  document.body.appendChild(overlay);

  function showOverlay(title, msg, showSpinner = true, isError = false) {
    console.log(`[PixelConnector] Showing overlay: ${title} - ${msg}`);
    overlay.style.display = 'flex';
    document.getElementById('pc-title').textContent = title;
    document.getElementById('pc-msg').textContent = msg;
    document.getElementById('pc-spinner').style.display = showSpinner ? 'block' : 'none';
    document.getElementById('pc-title').style.color = isError ? '#f87171' : '#f8fafc';
  }

  function hideOverlay() {
    console.log('[PixelConnector] Hiding overlay');
    overlay.style.display = 'none';
    document.getElementById('pc-time-bar-wrap').style.display = 'none';
  }

  function updateTimeBar(displayUsed, displayLimit, realUsed, realLimit) {
    const barWrap = document.getElementById('pc-time-bar-wrap');
    const bar = document.getElementById('pc-time-bar');
    const text = document.getElementById('pc-time-text');
    if (!barWrap || !bar || !text) return;

    barWrap.style.display = 'block';
    const pct = Math.min(100, (displayUsed / displayLimit) * 100);
    bar.style.width = pct + '%';
    bar.style.background = pct > 0.8 ? '#ef4444' : pct > 0.6 ? '#f59e0b' : '#6366f1';

    const remainDisplay = Math.max(0, Math.floor((displayLimit - displayUsed) / 60));
    text.textContent = `${remainDisplay} min remaining`;
  }

  // ── 4. Connect ───────────────────────────────────────────────────
  function connect() {
    if (typeof io === 'undefined') {
      console.error('[PixelConnector] Socket.io not loaded. Add the script to your HTML head.');
      showOverlay('Connection Error', 'Socket.io library not found. Contact support.', false, true);
      return;
    }

    console.log('[PixelConnector] Connecting to backend socket...');
    socket = io(BACKEND_URL, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 10000,
      extraHeaders: {
        'ngrok-skip-browser-warning': 'true',
      },
    });

    socket.on('connect', onSocketConnect);
    socket.on('display-started', onDisplayStarted);
    socket.on('heartbeat-ack', onHeartbeatAck);
    socket.on('quota-exceeded', onQuotaExceeded);
    socket.on('instance-stopping', onInstanceStopping);
    socket.on('grace-period-started', onGracePeriodStarted);
    socket.on('disconnect', onSocketDisconnect);
    socket.on('connect_error', onConnectError);
    socket.on('error', onServerError);
  }

  // ── 5. Socket Event Handlers ─────────────────────────────────────

  function onSocketConnect() {
    console.log('[PixelConnector] Connected! Socket ID:', socket.id);
    reconnectAttempts = 0;
    isInGracePeriod = false;
    if (gracePeriodTimer) clearTimeout(gracePeriodTimer);

    // Join instance room first
    console.log('[PixelConnector] Emitting join-instance:', INSTANCE_UUID);
    socket.emit('join-instance', INSTANCE_UUID);

    // Send display-start
    console.log('[PixelConnector] Emitting display-start with token:', hostToken);
    socket.emit('display-start', {
      instanceUuid: INSTANCE_UUID,
      hostToken: hostToken,
      deviceId: DEVICE_ID,
      timestamp: Date.now(),
    });

    // Start sending heartbeats
    startHeartbeat();
  }

  function onDisplayStarted(data) {
    console.log('[PixelConnector] Display session confirmed by server');

    // Save/update token (in case server generated a new one)
    if (data.hostToken) {
      hostToken = data.hostToken;
      localStorage.setItem('hostToken', data.hostToken);
    }

    // Hide overlay — user is now in session
    hideOverlay();

    // Update time bar if data returned
    if (data.displayLimit) {
      updateTimeBar(data.displayUsed, data.displayLimit, data.realUsed, data.realLimit);
    }
  }

  function onHeartbeatAck(data) {
    console.log('[PixelConnector] Heartbeat acknowledged');
    if (data.displayLimit) {
      updateTimeBar(data.displayUsed, data.displayLimit, data.realUsed, data.realLimit);
    }
  }

  function onServerError(err) {
    console.error('[PixelConnector] Server error received:', err.message);
    showOverlay('Session Error', err.message, false, true);
  }

  function onQuotaExceeded(data) {
    console.warn('[PixelConnector] Quota exceeded:', data.message);
    stopHeartbeat();
    isIntentionalDisconnect = true;

    showOverlay(
      'Time Limit Reached',
      data.message || 'Your session time has been fully used.',
      false,
      true
    );

    setTimeout(() => {
      const connectUrl = BACKEND_URL + '/?instanceUuid=' + INSTANCE_UUID;
      window.location.replace(connectUrl);
    }, 4000);
  }

  function onInstanceStopping(data) {
    console.warn('[PixelConnector] Instance stopping:', data.message);
    stopHeartbeat();
    isIntentionalDisconnect = true;

    showOverlay(
      'Server Shutting Down',
      'The server is stopping. You will be redirected shortly.',
      true,
      false
    );

    setTimeout(() => {
      const connectUrl = BACKEND_URL + '/?instanceUuid=' + INSTANCE_UUID;
      window.location.replace(connectUrl);
    }, 3000);
  }

  function onGracePeriodStarted(data) {
    console.log('[PixelConnector] Grace period started by server:', data.message);
    isInGracePeriod = true;
  }

  function onSocketDisconnect(reason) {
    console.log('[PixelConnector] Socket disconnected. Reason:', reason);
    stopHeartbeat();

    if (isIntentionalDisconnect) return;

    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      showOverlay(
        'Reconnecting...',
        `Lost connection to server. Attempting to reconnect... (${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})`,
        true,
        false
      );
      scheduleReconnect();
    } else {
      showOverlay(
        'Connection Lost',
        'Unable to reconnect to the server. Please refresh the page.',
        false,
        true
      );
    }
  }

  function onConnectError(err) {
    console.error('[PixelConnector] Connection error:', err.message);
    if (!isIntentionalDisconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      scheduleReconnect();
    }
  }

  // ── 6. Heartbeat ─────────────────────────────────────────────────

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatInterval = setInterval(() => {
      if (socket && socket.connected) {
        socket.emit('heartbeat', {
          instanceUuid: INSTANCE_UUID,
          hostToken: hostToken,
          deviceId: DEVICE_ID,
          timestamp: Date.now(),
        });
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  function stopHeartbeat() {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  }

  // ── 7. Reconnection ───────────────────────────────────────────────

  function scheduleReconnect() {
    reconnectAttempts++;
    const delay = Math.min(RECONNECT_DELAY_BASE_MS * Math.pow(1.5, reconnectAttempts - 1), 30000);
    console.log(`[PixelConnector] Reconnect attempt ${reconnectAttempts} in ${Math.round(delay / 1000)}s`);

    setTimeout(() => {
      if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
        socket = null;
      }
      connect();
    }, delay);
  }

  // ── 8. Page Visibility (tab switch / minimize) ───────────────────

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      console.log('[PixelConnector] Tab hidden');
    } else {
      console.log('[PixelConnector] Tab visible again');
      if (!socket || !socket.connected) {
        scheduleReconnect();
      }
    }
  });

  // ── 9. Page Unload (close tab / navigate away) ───────────────────

  window.addEventListener('beforeunload', () => {
    isIntentionalDisconnect = true;
    stopHeartbeat();

    if (socket && socket.connected && hostToken) {
      socket.emit('player-disconnect', {
        instanceUuid: INSTANCE_UUID,
        hostToken: hostToken,
        deviceId: DEVICE_ID,
      });
    }

    if (socket) {
      socket.disconnect();
    }
  });

  // ── 10. Initialize ────────────────────────────────────────────────

  showOverlay('Starting Session', 'Establishing connection to game server...', true, false);
  connect();

  console.log('[PixelConnector] Component initialized');
})();
