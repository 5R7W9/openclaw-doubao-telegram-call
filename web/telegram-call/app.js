import {
  createTelegramCallRelay,
  detectSpeechFromPcm16,
} from './relay.js';

const ROUTE_PREFIX = '/plugins/doubao-telegram-call/telegram-call';

const DoubaoTelegramCallApp = (() => {
  const params = new URLSearchParams(window.location.search);
  const state = {
    callId: params.get('callId') || '',
    token: params.get('token') || '',
    profileId: params.get('profile') || '',
    stream: null,
    audioContext: null,
    sourceNode: null,
    captureNode: null,
    scriptProcessor: null,
    silenceNode: null,
    ringtoneContext: null,
    ringtoneTimer: null,
    ringtoneAudioUnlocked: false,
    ringing: false,
    relay: null,
    muted: false,
    bootstrap: null,
    lastRelayLogAt: 0,
    firstUserAudioLogged: false,
    firstUserSpeechAudioLogged: false,
  };
  let workletPreloadPromise;

  const elements = {
    root: document.getElementById('telegram-call-root'),
    callerName: document.getElementById('caller-name'),
    callStatus: document.getElementById('call-status'),
    connectionState: document.getElementById('connection-state'),
    relayState: document.getElementById('relay-state'),
    micState: document.getElementById('mic-state'),
    avatarImage: document.getElementById('avatar-image'),
    avatarFallback: document.getElementById('avatar-fallback'),
    answerButton: document.getElementById('answer-button'),
    muteButton: document.getElementById('mute-button'),
    hangupButton: document.getElementById('hangup-button'),
  };

  function start() {
    window.Telegram?.WebApp?.ready?.();
    window.Telegram?.WebApp?.expand?.();
    elements.answerButton.addEventListener('click', answer);
    elements.muteButton.addEventListener('click', toggleMute);
    elements.hangupButton.addEventListener('click', hangup);
    elements.hangupButton.disabled = false;
    setHangupLabel('拒绝', '拒绝来电');
    setUiState('idle', '来电', '待机', '未请求');
    clientLog('page_ready');
    void preloadAudioWorklet();
    startRingtone();
  }

  async function answer() {
    if (!state.callId || !state.token) {
      setError('缺少通话令牌');
      return;
    }

    await stopRingtone();
    clientLog('answer_clicked');
    elements.answerButton.disabled = true;
    elements.hangupButton.disabled = false;
    setHangupLabel('挂断', '挂断电话');
    setUiState('connecting', '接听中', '连接中', '请求中');

    try {
      const payload = await requestAnswer();
      clientLog('answer_ok');

      state.bootstrap = payload;
      elements.callerName.textContent = payload.call?.label || 'OpenClaw';
      renderAvatar(payload.call);
      setUiState('connecting', '接入中', '连接中', '请求中');

      state.relay = createTelegramCallRelay({
        bootstrap: payload,
        callId: state.callId,
        token: state.token,
        profileId: state.profileId || payload.call?.profileId,
        onStatus: updateRelayStatus,
        onTranscript: updateTranscript,
        onPlaybackStart: (entry) => {
          clientLog('playback_started', {
            name: entry?.relaySessionId,
            message: 'output_audio',
          });
        },
        onError: (error) => {
          if (elements.root?.dataset?.state !== 'ended') {
            setError(translateError(error));
          }
        },
      });
      window.openClawTelegramCallRelay = state.relay;

      let answerCancelled = false;
      const micPromise = navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      }).then((stream) => {
        if (answerCancelled) {
          stopMediaStream(stream);
          return stream;
        }
        state.stream = stream;
        elements.micState.textContent = '已开启';
        clientLog('mic_live', describeStream(state.stream));
        setUiState('connecting', '接入中', '连接中', '已开启');
        return stream;
      });
      const relayStartPromise = state.relay.start().then((session) => {
        clientLog('relay_started');
        return session;
      });

      await Promise.all([micPromise, relayStartPromise]).catch((error) => {
        answerCancelled = true;
        throw error;
      });
      setUiState('connected', '已接通', '聆听中', '已开启');
      elements.muteButton.disabled = false;
      await startAudioCapture();
      clientLog('capture_started');
      window.dispatchEvent(new CustomEvent('openclaw:telegram-call-bootstrap', { detail: payload }));
    } catch (error) {
      clientLog('answer_error', errorInfo(error));
      await stopRelay();
      stopLocalMedia();
      if (state.bootstrap) {
        await sendHangup();
      }
      setError(translateError(error));
    }
  }

  function stopMediaStream(stream) {
    for (const track of stream?.getTracks?.() || []) {
      track.stop();
    }
  }

  async function requestAnswer() {
    const response = await fetch(`${ROUTE_PREFIX}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callId: state.callId,
        token: state.token,
        profileId: state.profileId || undefined,
        telegramInitData: window.Telegram?.WebApp?.initData || undefined,
      }),
    });
    const payload = await response.json();
    if (!response.ok || payload.ok !== true) {
      throw new Error(payload.message || '无法接听电话');
    }
    return payload;
  }

  async function hangup() {
    await stopRingtone();
    clientLog('hangup_clicked');
    elements.hangupButton.disabled = true;
    await stopRelay();
    stopLocalMedia();
    try {
      await sendHangup();
    } finally {
      setUiState('ended', '已结束', '已关闭', '关闭');
      elements.answerButton.disabled = true;
      elements.muteButton.disabled = true;
    }
  }

  async function sendHangup() {
    if (!state.callId || !state.token) {
      return;
    }
    await fetch(`${ROUTE_PREFIX}/hangup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId: state.callId, token: state.token }),
    }).catch(() => undefined);
  }

  function startRingtone() {
    if (state.ringtoneTimer || state.ringing) {
      return;
    }
    state.ringing = true;
    window.addEventListener('pointerdown', unlockRingtoneAudio, { capture: true, once: true });
    window.addEventListener('keydown', unlockRingtoneAudio, { capture: true, once: true });
    state.ringtoneTimer = window.setInterval(() => {
      playRingPulse();
    }, 1400);
    playRingPulse();
  }

  async function stopRingtone() {
    state.ringing = false;
    window.removeEventListener('pointerdown', unlockRingtoneAudio, { capture: true });
    window.removeEventListener('keydown', unlockRingtoneAudio, { capture: true });
    if (state.ringtoneTimer) {
      window.clearInterval(state.ringtoneTimer);
      state.ringtoneTimer = null;
    }
    const context = state.ringtoneContext;
    state.ringtoneContext = null;
    if (context && context.state !== 'closed') {
      await context.close?.().catch?.(() => undefined);
    }
  }

  function unlockRingtoneAudio(event) {
    if (isCallControlEvent(event)) {
      return;
    }
    state.ringtoneAudioUnlocked = true;
    playRingPulse();
  }

  async function playRingPulse() {
    if (!state.ringing) {
      return;
    }
    if (!state.ringtoneAudioUnlocked) {
      return;
    }
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) {
      return;
    }
    try {
      state.ringtoneContext = state.ringtoneContext || new AudioCtor({ latencyHint: 'interactive' });
      const context = state.ringtoneContext;
      await context.resume?.();
      if (!state.ringing || context.state === 'closed') {
        return;
      }
      const now = context.currentTime;
      const gain = context.createGain();
      const oscillator = context.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(880, now);
      oscillator.frequency.setValueAtTime(660, now + 0.22);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.045, now + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.46);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.addEventListener('ended', () => {
        oscillator.disconnect();
        gain.disconnect();
      }, { once: true });
      oscillator.start(now);
      oscillator.stop(now + 0.48);
    } catch {
      void stopRingtone();
    }
  }

  function isCallControlEvent(event) {
    return Boolean(event?.target?.closest?.('.control-button'));
  }

  function toggleMute() {
    state.muted = !state.muted;
    for (const track of state.stream?.getAudioTracks?.() || []) {
      track.enabled = !state.muted;
    }
    elements.muteButton.setAttribute('aria-pressed', String(state.muted));
    elements.muteButton.querySelector('span:last-child').textContent = state.muted ? '取消静音' : '静音';
    elements.micState.textContent = state.muted ? '已静音' : '已开启';
  }

  async function startAudioCapture() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!state.stream || !AudioCtor) {
      throw new Error('此 WebView 无法录音');
    }
    const audio = state.relay?.audio || state.bootstrap?.gatewayRelay?.audio || {};
    const requestedRate = audio.inputSampleRateHz || 24000;
    const frameMs = audio.inputFrameMs || 20;
    state.audioContext = new AudioCtor({
      latencyHint: 'interactive',
    });
    await state.audioContext.resume?.();
    const source = state.audioContext.createMediaStreamSource(state.stream);
    const silenceNode = state.audioContext.createGain();
    silenceNode.gain.value = 0;
    state.sourceNode = source;
    state.silenceNode = silenceNode;

    if (state.audioContext.audioWorklet && typeof window.AudioWorkletNode === 'function') {
      try {
        await startAudioWorkletCapture({
          source,
          silenceNode,
          requestedRate,
          frameMs,
        });
        clientLog('capture_worklet_started', {
          inputRate: state.audioContext.sampleRate,
          outputRate: requestedRate,
        });
        return;
      } catch (error) {
        clientLog('capture_worklet_failed', errorInfo(error));
        source.disconnect?.();
      }
    }

    startScriptProcessorCapture({
      source,
      silenceNode,
      requestedRate,
      frameMs,
    });
    clientLog('capture_script_processor_started', {
      inputRate: state.audioContext.sampleRate,
      outputRate: requestedRate,
    });
  }

  async function startAudioWorkletCapture(options) {
    const { source, silenceNode, requestedRate, frameMs } = options;
    await preloadAudioWorklet();
    await state.audioContext.audioWorklet.addModule(`${ROUTE_PREFIX}/assets/pcm-worklet.js`);
    const captureNode = new AudioWorkletNode(state.audioContext, 'telegram-call-pcm-capture', {
      processorOptions: {
        frameMs,
        targetSampleRateHz: requestedRate,
      },
    });
    captureNode.port.onmessage = (event) => {
      sendPcmFrame(event.data?.pcm16, event.data?.sampleRateHz);
    };
    source.connect(captureNode);
    captureNode.connect(silenceNode);
    silenceNode.connect(state.audioContext.destination);
    state.captureNode = captureNode;
  }

  function preloadAudioWorklet() {
    if (!workletPreloadPromise) {
      workletPreloadPromise = typeof fetch === 'function'
        ? fetch(`${ROUTE_PREFIX}/assets/pcm-worklet.js`, { cache: 'force-cache' })
          .then(() => undefined)
          .catch(() => undefined)
        : Promise.resolve();
    }
    return workletPreloadPromise;
  }

  function startScriptProcessorCapture(options) {
    const { source, silenceNode, requestedRate, frameMs } = options;
    if (typeof state.audioContext.createScriptProcessor !== 'function') {
      throw new Error('此 WebView 不支持备用录音路径');
    }
    const processor = state.audioContext.createScriptProcessor(1024, 1, 1);
    const resampler = createPcmFrameResampler({
      inputSampleRateHz: state.audioContext.sampleRate || requestedRate,
      outputSampleRateHz: requestedRate,
      frameMs,
    });
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer?.getChannelData?.(0);
      if (!input) {
        return;
      }
      for (const pcm16 of resampler.push(input)) {
        sendPcmFrame(pcm16.buffer, requestedRate);
      }
    };
    source.connect(processor);
    processor.connect(silenceNode);
    silenceNode.connect(state.audioContext.destination);
    state.scriptProcessor = processor;
  }

  function sendPcmFrame(pcm16, sampleRateHz) {
    if (state.muted || !pcm16) {
      return;
    }
    const detail = {
      callId: state.callId,
      relay: state.bootstrap?.gatewayRelay,
      pcm16,
      sampleRateHz,
      timestamp: performance.now(),
    };
    if (!state.firstUserAudioLogged) {
      state.firstUserAudioLogged = true;
      clientLog('first_user_audio', {
        name: String(sampleRateHz || ''),
        message: `${pcm16.byteLength ?? pcm16.length ?? 0} bytes`,
      });
    }
    if (!state.firstUserSpeechAudioLogged && detectSpeechFromPcm16(pcm16).speech) {
      state.firstUserSpeechAudioLogged = true;
      clientLog('first_user_speech_audio', {
        name: String(sampleRateHz || ''),
        message: `${pcm16.byteLength ?? pcm16.length ?? 0} bytes`,
      });
    }
    state.relay?.appendAudioFrame?.(detail);
    window.dispatchEvent(new CustomEvent('openclaw:telegram-call-audio-frame', { detail }));
  }

  function stopLocalMedia() {
    state.captureNode?.disconnect?.();
    state.captureNode = null;
    if (state.scriptProcessor) {
      state.scriptProcessor.onaudioprocess = null;
      state.scriptProcessor.disconnect?.();
      state.scriptProcessor = null;
    }
    state.sourceNode?.disconnect?.();
    state.sourceNode = null;
    state.silenceNode?.disconnect?.();
    state.silenceNode = null;
    state.audioContext?.close?.().catch?.(() => undefined);
    state.audioContext = null;
    for (const track of state.stream?.getTracks?.() || []) {
      track.stop();
    }
    state.stream = null;
  }

  async function stopRelay() {
    const relay = state.relay;
    state.relay = null;
    if (window.openClawTelegramCallRelay === relay) {
      window.openClawTelegramCallRelay = null;
    }
    await relay?.stop?.();
  }

  function updateRelayStatus(kind, detail) {
    const now = Date.now();
    if (kind === 'error' || kind === 'closed' || now - state.lastRelayLogAt > 1000) {
      state.lastRelayLogAt = now;
      clientLog('relay_status', {
        name: kind,
        message: detail,
      });
    }
    if (kind === 'error') {
      setError(translateRelayDetail(detail) || '通话中继失败');
      return;
    }
    const relayLabels = {
      gateway_connecting: '连接网关',
      relay_connected: '已连接',
      relay_connecting: '启动中',
      relay_ready: '就绪',
      listening: '聆听中',
      thinking: '思考中',
      speaking: '回话中',
      tool_call_aborted: '继续通话',
      closed: '已关闭',
    };
    elements.relayState.textContent = relayLabels[kind] || translateRelayDetail(detail) || kind;
    if (kind === 'listening') {
      elements.callStatus.textContent = '聆听中';
    } else if (kind === 'thinking') {
      elements.callStatus.textContent = '思考中';
    } else if (kind === 'speaking') {
      elements.callStatus.textContent = '回话中';
    }
  }

  function updateTranscript(transcript) {
    if (!transcript?.text) {
      return;
    }
    if (transcript.role === 'user' && transcript.final) {
      elements.callStatus.textContent = '思考中';
    }
    if (transcript.role === 'assistant') {
      elements.callStatus.textContent = '回话中';
    }
  }

  function setUiState(kind, status, relay, mic) {
    elements.root.dataset.state = kind;
    elements.connectionState.textContent = status;
    elements.callStatus.textContent = status;
    elements.relayState.textContent = relay;
    elements.micState.textContent = mic;
  }

  function setError(message) {
    stopRingtone();
    clientLog('ui_error', { message });
    setUiState('error', '错误', '失败', '关闭');
    elements.callStatus.textContent = message;
    elements.answerButton.disabled = false;
    elements.hangupButton.disabled = false;
    setHangupLabel('关闭', '关闭通话');
    elements.muteButton.disabled = true;
  }

  function setHangupLabel(text, ariaLabel) {
    elements.hangupButton.setAttribute('aria-label', ariaLabel);
    elements.hangupButton.querySelector('span:last-child').textContent = text;
  }

  function renderAvatar(call = {}) {
    const fallbackText = readString(call.avatarText) || createInitials(call.label || 'OpenClaw');
    if (elements.avatarFallback) {
      elements.avatarFallback.textContent = fallbackText;
      elements.avatarFallback.hidden = false;
    }
    if (!elements.avatarImage) {
      return;
    }
    const avatarUrl = normalizeAvatarUrl(call.avatarUrl);
    elements.avatarImage.onerror = () => {
      elements.avatarImage.hidden = true;
      if (elements.avatarFallback) {
        elements.avatarFallback.hidden = false;
      }
    };
    if (!avatarUrl) {
      elements.avatarImage.removeAttribute('src');
      elements.avatarImage.hidden = true;
      return;
    }
    elements.avatarImage.onload = () => {
      elements.avatarImage.hidden = false;
      if (elements.avatarFallback) {
        elements.avatarFallback.hidden = true;
      }
    };
    elements.avatarImage.src = avatarUrl;
  }

  function normalizeAvatarUrl(value) {
    const text = readString(value);
    if (!text) {
      return '';
    }
    try {
      return new URL(text, window.location.href).href;
    } catch {
      return '';
    }
  }

  function createInitials(label) {
    const text = readString(label) || 'OC';
    const asciiWords = text.match(/[A-Za-z0-9]+/g);
    if (asciiWords?.length) {
      return asciiWords
        .slice(0, 2)
        .map((word) => word[0])
        .join('')
        .toUpperCase();
    }
    return Array.from(text).slice(0, 2).join('').toUpperCase();
  }

  function readString(value) {
    if (typeof value !== 'string') {
      return '';
    }
    return value.trim();
  }

  function clientLog(stage, detail = {}) {
    const body = JSON.stringify({
      callId: state.callId || undefined,
      profileId: state.profileId || undefined,
      stage,
      atMs: Math.round(performance.now()),
      name: detail.name,
      message: detail.message,
    });
    try {
      if (navigator.sendBeacon) {
        const blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(`${ROUTE_PREFIX}/client-log`, blob)) {
          return;
        }
      }
      fetch(`${ROUTE_PREFIX}/client-log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => undefined);
    } catch {
      // Diagnostics must never disturb the call path.
    }
  }

  function errorInfo(error) {
    return {
      name: error?.name || 'Error',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  function translateError(error) {
    return translateRelayDetail(error instanceof Error ? error.message : String(error));
  }

  function translateRelayDetail(detail) {
    const text = typeof detail === 'string' ? detail.trim() : '';
    const known = {
      Connecting: '连接中',
      Connected: '已连接',
      Ready: '就绪',
      Listening: '聆听中',
      Speaking: '回话中',
      Closed: '已关闭',
      'Plugin relay WebSocket failed': '通话中继连接失败',
      'Missing plugin relay bootstrap': '缺少通话启动信息',
      'WebSocket is not available in this browser': '此浏览器不支持 WebSocket',
      'AudioContext is not available in this browser': '此 WebView 无法播放音频',
      'No AVAudioSessionCaptureDevice device': 'Telegram 无法打开麦克风，请重试；如果仍失败，请用系统浏览器打开此通话链接',
      'Plugin relay did not return a session id': '通话中继没有返回会话编号',
      'Realtime relay failed': '实时通话中继失败',
      'Call expired': '来电已过期，请重新发起',
    };
    return known[text] || text || '';
  }

  function describeStream(stream) {
    const track = stream?.getAudioTracks?.()[0];
    return {
      name: track?.kind || 'audio',
      message: track?.readyState || 'live',
    };
  }

  function createPcmFrameResampler(options) {
    const inputRate = options.inputSampleRateHz || options.outputSampleRateHz || 24000;
    const outputRate = options.outputSampleRateHz || inputRate;
    const frameSamples = Math.max(1, Math.round(outputRate * (options.frameMs || 20) / 1000));
    let pending = new Float32Array(0);

    return {
      push(input) {
        const resampled = resampleFloat32(input, inputRate, outputRate);
        pending = concatFloat32(pending, resampled);
        const frames = [];
        while (pending.length >= frameSamples) {
          const frame = pending.subarray(0, frameSamples);
          frames.push(floatToPcm16(frame));
          pending = pending.subarray(frameSamples);
        }
        return frames;
      },
    };
  }

  function resampleFloat32(input, inputRate, outputRate) {
    if (!input?.length) {
      return new Float32Array(0);
    }
    if (inputRate === outputRate) {
      return new Float32Array(input);
    }
    const outputLength = Math.max(1, Math.round(input.length * outputRate / inputRate));
    const output = new Float32Array(outputLength);
    const ratio = inputRate / outputRate;
    for (let index = 0; index < outputLength; index += 1) {
      const position = index * ratio;
      const left = Math.floor(position);
      const right = Math.min(input.length - 1, left + 1);
      const fraction = position - left;
      output[index] = input[left] + (input[right] - input[left]) * fraction;
    }
    return output;
  }

  function concatFloat32(left, right) {
    if (!left.length) {
      return right;
    }
    if (!right.length) {
      return left;
    }
    const joined = new Float32Array(left.length + right.length);
    joined.set(left, 0);
    joined.set(right, left.length);
    return joined;
  }

  function floatToPcm16(frame) {
    const pcm16 = new Int16Array(frame.length);
    for (let index = 0; index < frame.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, frame[index]));
      pcm16[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return pcm16;
  }

  return { start, answer, hangup };
})();

window.DoubaoTelegramCallApp = DoubaoTelegramCallApp;
DoubaoTelegramCallApp.start();
