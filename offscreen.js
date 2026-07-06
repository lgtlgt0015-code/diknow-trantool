// Offscreen document: runs in extension context, handles tab audio capture + WebCodecs encoding.
// Receives START_CAPTURE / STOP_CAPTURE from service worker.
// Sends CAPTURE_READY / CAPTURE_ERROR / CAPTURE_ENDED / OPUS_CHUNK back to service worker.

const MSG = {
  startCapture: 'START_CAPTURE',
  stopCapture: 'STOP_CAPTURE',
  captureReady: 'CAPTURE_READY',
  captureError: 'CAPTURE_ERROR',
  captureEnded: 'CAPTURE_ENDED',
  opusChunk: 'OPUS_CHUNK',
};

const CAPTURE_STATES = {
  idle: 'idle',
  starting: 'starting',
  running: 'running',
  stopping: 'stopping',
};

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const FRAME_MS = 20;
const FRAME_SIZE = (SAMPLE_RATE * FRAME_MS) / 1000; // 320 samples

const WORKLET_URL = chrome.runtime.getURL('audio-worklet-processor.js');
const sessions = new Map();

function sendToSW(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function createSession(tabId) {
  return {
    tabId,
    state: CAPTURE_STATES.idle,
    opChain: Promise.resolve(),
    audioCtx: null,
    monitorAudioCtx: null,
    encoder: null,
    source: null,
    monitorSource: null,
    workletNode: null,
    monitorGain: null,
    mediaStream: null,
    frameTimestamp: 0,
  };
}

function getOrCreateSession(tabId) {
  let session = sessions.get(tabId);
  if (!session) {
    session = createSession(tabId);
    sessions.set(tabId, session);
  }
  return session;
}

function enqueueForTab(tabId, task) {
  const session = getOrCreateSession(tabId);
  const next = session.opChain.then(task, task);
  session.opChain = next.catch(() => {});
  return next;
}

function disconnectNode(node) {
  try { node?.disconnect(); } catch {}
}

async function closeAudioContext(ctx) {
  if (ctx && ctx.state !== 'closed') {
    try { await ctx.close(); } catch {}
  }
}

async function cleanupSession(session) {
  session.state = CAPTURE_STATES.stopping;

  disconnectNode(session.workletNode);
  disconnectNode(session.monitorGain);
  disconnectNode(session.monitorSource);
  disconnectNode(session.source);
  session.mediaStream?.getTracks().forEach((track) => track.stop());

  const encoder = session.encoder;
  if (encoder && encoder.state !== 'closed') {
    try { await encoder.flush(); } catch {}
    try { encoder.close(); } catch {}
  }

  await closeAudioContext(session.audioCtx);
  await closeAudioContext(session.monitorAudioCtx);

  session.workletNode = null;
  session.monitorGain = null;
  session.monitorSource = null;
  session.source = null;
  session.mediaStream = null;
  session.encoder = null;
  session.audioCtx = null;
  session.monitorAudioCtx = null;
  session.frameTimestamp = 0;
  session.state = CAPTURE_STATES.idle;
  sessions.delete(session.tabId);
}

async function startCapture(streamId, tabId) {
  const session = getOrCreateSession(tabId);

  if (session.state === CAPTURE_STATES.running) {
    sendToSW({ type: MSG.captureReady, tabId });
    return;
  }

  if (session.mediaStream || session.audioCtx || session.encoder) {
    await cleanupSession(session);
    sessions.set(tabId, session);
  }

  session.state = CAPTURE_STATES.starting;
  try {
    session.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });

    session.audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    session.monitorAudioCtx = new AudioContext();

    await session.audioCtx.audioWorklet.addModule(WORKLET_URL);

    const encoder = new AudioEncoder({
      output: (chunk) => {
        const active = sessions.get(tabId);
        if (active?.encoder !== encoder) return;
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        // Chrome extension message passing uses JSON; send a plain Array, not Uint8Array.
        sendToSW({ type: MSG.opusChunk, tabId, data: Array.from(bytes), timestamp: chunk.timestamp });
      },
      error: (err) => {
        sendToSW({ type: MSG.captureError, tabId, error: err.message });
      },
    });
    session.encoder = encoder;

    encoder.configure({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: CHANNELS, bitrate: 32000 });

    session.source = session.audioCtx.createMediaStreamSource(session.mediaStream);
    session.monitorSource = session.monitorAudioCtx.createMediaStreamSource(session.mediaStream);
    // numberOfOutputs:0 makes this a sink node; Chrome won't silence inputs when output is unconnected.
    session.workletNode = new AudioWorkletNode(session.audioCtx, 'audio-capture-processor', {
      processorOptions: { frameSize: FRAME_SIZE },
      numberOfOutputs: 0,
    });

    session.workletNode.port.onmessage = ({ data: pcm }) => {
      const active = sessions.get(tabId);
      if (active !== session || encoder.state !== 'configured') return;
      const audioData = new AudioData({
        format: 's16-planar',
        sampleRate: SAMPLE_RATE,
        numberOfFrames: pcm.length,
        numberOfChannels: CHANNELS,
        timestamp: session.frameTimestamp,
        data: pcm,
      });
      encoder.encode(audioData);
      audioData.close();
      session.frameTimestamp += FRAME_MS * 1000;
    };

    session.source.connect(session.workletNode);
    session.monitorGain = session.monitorAudioCtx.createGain();
    session.monitorGain.gain.value = 1;
    session.monitorSource.connect(session.monitorGain);
    session.monitorGain.connect(session.monitorAudioCtx.destination);
    session.state = CAPTURE_STATES.running;
    sendToSW({ type: MSG.captureReady, tabId });
  } catch (err) {
    try { await cleanupSession(session); } catch {}
    sendToSW({ type: MSG.captureError, tabId, error: err.message });
  }
}

async function stopCapture(tabId) {
  const session = sessions.get(tabId);
  if (!session) {
    sendToSW({ type: MSG.captureEnded, tabId });
    return;
  }

  await cleanupSession(session);
  sendToSW({ type: MSG.captureEnded, tabId });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MSG.startCapture && message.tabId != null) {
    enqueueForTab(message.tabId, () => startCapture(message.streamId, message.tabId));
  } else if (message?.type === MSG.stopCapture && message.tabId != null) {
    enqueueForTab(message.tabId, () => stopCapture(message.tabId));
  }
});
