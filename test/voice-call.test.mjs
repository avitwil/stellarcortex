import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCall, isDuplicateVoiceTranscript } from '../public/voice-call.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let n = 0; n < 15; n++) await Promise.resolve();
};
class Target {
  listeners = new Map();
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
  }
  removeEventListener(name, fn) {
    this.listeners.get(name)?.delete(fn);
  }
  fire(name, event = {}) {
    for (const fn of [...(this.listeners.get(name) || [])]) fn(event);
    this[`on${name}`]?.(event);
  }
}
function fixture(options = {}) {
  let sequence = 0;
  const timers = new Map(),
    recognitions = [],
    utterances = [],
    pcs = [],
    audios = [],
    mediaCalls = [],
    apiCalls = [],
    apiSignals = [],
    states = [],
    transcripts = [],
    speechStarts = [];
  class Recognition extends Target {
    constructor() {
      super();
      recognitions.push(this);
    }
    start() {
      this.starts = (this.starts || 0) + 1;
      this.fire('start');
    }
    abort() {
      this.aborted = true;
      this.fire('end');
    }
  }
  class Track extends Target {
    enabled = true;
    stopped = false;
    stop() {
      this.stopped = true;
      this.fire('ended');
    }
  }
  const track = new Track(),
    remoteTrack = new Track(),
    stream = { getTracks: () => [track], getAudioTracks: () => [track] },
    remoteStream = { getTracks: () => [remoteTrack] };
  class Channel extends Target {
    readyState = 'connecting';
    sent = [];
    send(text) {
      if (this.readyState !== 'open') throw new Error('Not open');
      this.sent.push(JSON.parse(text));
    }
    close() {
      this.readyState = 'closed';
      this.fire('close');
    }
  }
  class Peer extends Target {
    constructor() {
      super();
      pcs.push(this);
      this.iceGatheringState = options.icePending ? 'gathering' : 'complete';
      this.connectionState = 'new';
      this.iceConnectionState = 'new';
      this.channel = new Channel();
    }
    addTrack(value, media) {
      this.added = { track: value, stream: media };
    }
    createDataChannel(name) {
      this.channelName = name;
      return this.channel;
    }
    async createOffer() {
      return { type: 'offer', sdp: 'offer-sdp' };
    }
    async setLocalDescription(offer) {
      this.localDescription = { ...offer, sdp: 'gathered-sdp' };
    }
    async setRemoteDescription(answer) {
      this.remoteDescription = answer;
      if (!options.channelPending) {
        this.channel.readyState = 'open';
        this.channel.fire('open');
      }
      this.connectionState = 'connected';
    }
    close() {
      this.connectionState = 'closed';
      this.closed = true;
      this.fire('connectionstatechange');
    }
  }
  class Audio {
    constructor() {
      audios.push(this);
    }
    play() {
      this.played = true;
      return options.playError ? Promise.reject(options.playError) : Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
    remove() {
      this.removed = true;
    }
    setAttribute() {}
  }
  const synth = {
    cancelled: 0,
    speak: value => utterances.push(value),
    cancel() {
      this.cancelled++;
    },
    getVoices: () => [
      { lang: 'he-IL', name: 'Hebrew' },
      { lang: 'en-US', name: 'English' },
    ],
  };
  const environment = {
    isSecureContext: true,
    SpeechRecognition: Recognition,
    SpeechSynthesisUtterance: class {
      constructor(text) {
        this.text = text;
      }
    },
    speechSynthesis: synth,
    RTCPeerConnection: Peer,
    Audio,
    navigator: {
      mediaDevices: {
        getUserMedia: input => {
          mediaCalls.push(input);
          return options.mediaPromise || Promise.resolve(stream);
        },
      },
    },
    setTimeout: (callback, ms) => {
      const id = ++sequence;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimeout: id => timers.delete(id),
  };
  const api = async (path, body, config) => {
    apiCalls.push({ path, body });
    apiSignals.push(config?.signal);
    if (options.apiPromise) return options.apiPromise;
    return { sdp: 'answer-sdp', model: 'test-voice', voice: 'test-speaker' };
  };
  const call = new VoiceCall({
    environment,
    api,
    onState: state => states.push(state),
    onTranscript: text => transcripts.push(text),
    onSpeechStart: () => speechStarts.push(true),
  });
  const advance = delay => {
    const item = [...timers].find(([, value]) => value.ms === delay);
    assert.ok(item, `Expected ${delay}ms timer`);
    timers.delete(item[0]);
    item[1].callback();
  };
  const event = value => pcs.at(-1).channel.fire('message', { data: JSON.stringify(value) });
  const final = (recognition, text, { index = 0, interim = false } = {}) => {
    const results = [];
    results[index] = Object.assign([{ transcript: text }], { isFinal: !interim });
    recognition.fire('result', { resultIndex: index, results });
  };
  return {
    call,
    environment,
    states,
    transcripts,
    speechStarts,
    recognitions,
    utterances,
    pcs,
    audios,
    track,
    remoteTrack,
    stream,
    remoteStream,
    synth,
    timers,
    mediaCalls,
    apiCalls,
    apiSignals,
    advance,
    event,
    final,
  };
}

test('voice capabilities and construction never capture audio; unsupported or insecure starts fail cleanly', async () => {
  const f = fixture();
  assert.equal(f.call.active, false);
  assert.equal(f.call.setMuted(true), false);
  assert.equal(f.call.interrupt(), false);
  assert.equal(await f.call.speak('No call'), false);
  assert.equal(f.mediaCalls.length, 0);
  assert.deepEqual(VoiceCall.capabilities(f.environment), {
    browser: true,
    openai: true,
    secure: true,
  });
  f.environment.isSecureContext = false;
  await assert.rejects(f.call.start({ mode: 'openai' }), /HTTPS or localhost/);
  assert.equal(f.mediaCalls.length, 0);
  assert.equal(f.call.active, false);
  assert.equal(f.states.at(-1).status, 'error');
});

test('browser recognition forwards final transcripts once, restarts carefully, and pauses for playback', async () => {
  const f = fixture();
  await f.call.start({ mode: 'browser', language: 'he', botId: 'stellar' });
  let recognition = f.recognitions[0];
  assert.equal(recognition.lang, 'he-IL');
  assert.equal(recognition.continuous, true);
  assert.equal(f.mediaCalls.length, 0);
  assert.equal(f.states.at(-1).status, 'listening');
  recognition.fire('speechstart');
  f.final(recognition, 'שלום', { interim: true });
  assert.equal(f.transcripts.length, 0);
  f.final(recognition, 'שלום');
  f.final(recognition, 'שלום');
  assert.deepEqual(f.transcripts, ['שלום']);
  assert.equal(f.states.at(-1).status, 'thinking');
  assert.equal(f.speechStarts.length, 1);
  recognition.fire('end');
  f.advance(250);
  recognition = f.recognitions.at(-1);
  f.final(recognition, 'שלום');
  assert.deepEqual(f.transcripts, ['שלום']);
  f.final(recognition, 'משפט חדש', { index: 1 });
  assert.equal(f.transcripts.length, 2);
  const speech = f.call.speak('תשובה סופית');
  assert.equal(recognition.aborted, true);
  assert.equal(f.utterances.at(-1).lang, 'he-IL');
  assert.equal(f.utterances.at(-1).voice.name, 'Hebrew');
  f.final(recognition, 'Echo from bot', { index: 2 });
  assert.equal(f.transcripts.length, 2);
  f.utterances.at(-1).onend();
  assert.equal(await speech, true);
  f.advance(200);
  assert.equal(f.recognitions.length, 3);
  f.call.stop();
  assert.equal(f.recognitions.at(-1).aborted, true);
  assert.equal(f.timers.size, 0);
  assert.equal(f.states.at(-1).status, 'idle');
});

test('pure transcript replay detection preserves intentional repetitions outside the reconnect window', () => {
  const previous = { text: ' yes ', recognitionId: 1, at: 1000 };
  assert.equal(
    isDuplicateVoiceTranscript(previous, { text: 'yes', recognitionId: 2, at: 1500 }),
    true,
  );
  assert.equal(
    isDuplicateVoiceTranscript(previous, { text: 'yes', recognitionId: 1, at: 1500 }),
    false,
  );
  assert.equal(
    isDuplicateVoiceTranscript(previous, { text: 'yes', recognitionId: 2, at: 3000 }),
    false,
  );
  assert.equal(
    isDuplicateVoiceTranscript(previous, { text: 'no', recognitionId: 2, at: 1500 }),
    false,
  );
});

test('browser mute and interruption release recognition, suppress old callbacks, and resolve interrupted playback', async () => {
  const f = fixture();
  await f.call.start({ mode: 'browser', language: 'en' });
  const first = f.recognitions[0],
    lateResult = [...first.listeners.get('result')][0];
  f.call.setMuted(true);
  assert.equal(first.aborted, true);
  f.final(first, 'Ignored');
  assert.equal(f.transcripts.length, 0);
  assert.equal(f.states.at(-1).status, 'muted');
  f.call.setMuted(false);
  assert.equal(f.recognitions.length, 2);
  const pending = f.call.speak('a '.repeat(1000));
  const oldEnd = f.utterances.at(-1).onend;
  assert.equal(f.call.interrupt(), true);
  assert.equal(await pending, false);
  assert.equal(f.synth.cancelled, 1);
  oldEnd();
  assert.equal(f.utterances.length, 1);
  f.call.stop();
  lateResult({
    resultIndex: 0,
    results: [Object.assign([{ transcript: 'Late' }], { isFinal: true })],
  });
  assert.equal(f.transcripts.length, 0);
  assert.equal(f.timers.size, 0);
});

test('browser recognition permission failures terminate without automatic retry', async () => {
  const f = fixture();
  await f.call.start({ mode: 'browser' });
  f.recognitions[0].fire('error', { error: 'not-allowed' });
  assert.equal(f.call.active, false);
  assert.match(f.states.at(-1).error, /not-allowed/);
  assert.equal(f.timers.size, 0);
  assert.equal(f.recognitions[0].aborted, true);
});

test('WebRTC exchanges only SDP via authenticated app API and routes input text to the selected bot callback', async () => {
  const f = fixture();
  assert.equal(await f.call.start({ mode: 'openai', language: 'he', botId: 'bot-1' }), true);
  const pc = f.pcs[0];
  assert.equal(pc.channelName, 'oai-events');
  assert.equal(pc.added.track, f.track);
  assert.equal(f.mediaCalls.length, 1);
  assert.deepEqual(f.apiCalls, [
    { path: '/api/voice/session', body: { sdp: 'gathered-sdp', language: 'he', botId: 'bot-1' } },
  ]);
  assert.deepEqual(pc.remoteDescription, { type: 'answer', sdp: 'answer-sdp' });
  f.event({ type: 'input_audio_buffer.speech_started', item_id: 'user-1' });
  f.event({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'user-1',
    transcript: 'העבר את המשימה לאבי',
  });
  f.event({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'user-1',
    transcript: 'העבר את המשימה לאבי',
  });
  assert.deepEqual(f.transcripts, ['העבר את המשימה לאבי']);
  assert.equal(f.speechStarts.length, 1);
  assert.equal(f.states.at(-1).status, 'thinking');
  assert.equal(
    pc.channel.sent.some(e => e.type === 'response.create'),
    false,
  );
  f.call.stop();
  assert.equal(f.track.stopped, true);
  assert.equal(pc.closed, true);
  assert.equal(pc.channel.readyState, 'closed');
  assert.equal(f.timers.size, 0);
});

test('WebRTC speaks only explicit completed reply input and waits for actual audio stop rather than response generation', async () => {
  const f = fixture();
  await f.call.start({ mode: 'openai' });
  const pc = f.pcs[0];
  pc.fire('track', { streams: [f.remoteStream] });
  await flush();
  assert.equal(f.audios[0].muted, true);
  let resolved = false;
  const speech = f.call.speak('Exact completed bot reply').then(value => {
      resolved = true;
      return value;
    }),
    create = pc.channel.sent.at(-1);
  assert.equal(create.type, 'response.create');
  assert.equal(create.response.conversation, 'none');
  assert.deepEqual(create.response.output_modalities, ['audio']);
  assert.deepEqual(create.response.tools, []);
  assert.equal(create.response.tool_choice, 'none');
  assert.equal(create.response.input[0].content[0].text, 'Exact completed bot reply');
  const response = {
    id: 'response-1',
    metadata: create.response.metadata,
    status: 'completed',
    output: [{ content: [{ type: 'audio' }] }],
  };
  f.event({ type: 'response.created', response });
  f.event({ type: 'output_audio_buffer.started', response_id: 'response-1' });
  assert.equal(f.audios[0].muted, false);
  f.event({ type: 'response.done', response });
  await flush();
  assert.equal(resolved, false);
  f.event({ type: 'output_audio_buffer.stopped', response_id: 'response-1' });
  assert.equal(await speech, true);
  assert.equal(f.audios[0].muted, true);
  assert.equal(f.states.at(-1).status, 'listening');
  f.call.stop();
  assert.equal(f.remoteTrack.stopped, true);
  assert.equal(f.audios[0].paused, true);
  assert.equal(f.audios[0].srcObject, null);
});

test('WebRTC barge-in cancels and clears audio; stale completion cannot end a newer reply', async () => {
  const f = fixture();
  await f.call.start({ mode: 'openai' });
  const pc = f.pcs[0];
  const first = f.call.speak('First reply'),
    one = pc.channel.sent.at(-1).response;
  f.event({ type: 'response.created', response: { id: 'r1', metadata: one.metadata } });
  f.event({ type: 'output_audio_buffer.started', response_id: 'r1' });
  f.event({ type: 'input_audio_buffer.speech_started', item_id: 'user-2' });
  assert.equal(await first, false);
  assert.deepEqual(
    pc.channel.sent.slice(-2).map(e => e.type),
    ['response.cancel', 'output_audio_buffer.clear'],
  );
  assert.equal(f.audios[0].muted, true);
  assert.equal(f.speechStarts.length, 1);
  const second = f.call.speak('Second reply'),
    two = pc.channel.sent.at(-1).response;
  f.event({ type: 'response.created', response: { id: 'r2', metadata: two.metadata } });
  f.event({
    type: 'response.done',
    response: { id: 'r1', metadata: one.metadata, status: 'cancelled' },
  });
  assert.equal(f.states.at(-1).status, 'speaking');
  f.call.interrupt();
  assert.equal(await second, false);
  f.call.stop();
});

test('muted WebRTC audio disables the track and ignores both immediate and delayed muted utterances', async () => {
  const f = fixture();
  await f.call.start({ mode: 'openai' });
  f.event({ type: 'input_audio_buffer.speech_started', item_id: 'before-mute' });
  f.call.setMuted(true);
  assert.equal(f.track.enabled, false);
  f.event({ type: 'input_audio_buffer.speech_started', item_id: 'during-mute' });
  f.event({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'ignored-now',
    transcript: 'Do not enqueue',
  });
  f.call.setMuted(false);
  assert.equal(f.track.enabled, true);
  for (const item_id of ['before-mute', 'during-mute', 'ignored-now'])
    f.event({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id,
      transcript: 'Do not enqueue late',
    });
  assert.equal(f.transcripts.length, 0);
  f.event({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'new',
    transcript: 'Fresh request',
  });
  assert.deepEqual(f.transcripts, ['Fresh request']);
  f.call.stop();
});

test('late creation of an interrupted response cannot clear a newer owned audio buffer', async () => {
  const f = fixture();
  await f.call.start({ mode: 'openai' });
  const channel = f.pcs[0].channel;
  const first = f.call.speak('First reply'),
    firstMetadata = channel.sent.at(-1).response.metadata;
  f.call.interrupt();
  assert.equal(await first, false);
  const second = f.call.speak('Second reply'),
    secondMetadata = channel.sent.at(-1).response.metadata;
  f.event({ type: 'response.created', response: { id: 'second', metadata: secondMetadata } });
  f.event({ type: 'output_audio_buffer.started', response_id: 'second' });
  const before = channel.sent.length;
  f.event({ type: 'response.created', response: { id: 'first', metadata: firstMetadata } });
  assert.deepEqual(
    channel.sent.slice(before).map(event => event.type),
    ['response.cancel'],
  );
  assert.equal(channel.sent.at(-1).response_id, 'first');
  assert.equal(f.audios[0].muted, false);
  f.event({ type: 'output_audio_buffer.stopped', response_id: 'second' });
  assert.equal(await second, true);
  f.call.stop();
});

test('Realtime final transcripts are delivered in utterance order even when transcription completion is reversed', async () => {
  const f = fixture();
  await f.call.start({ mode: 'openai' });
  f.event({ type: 'input_audio_buffer.speech_started', item_id: 'a' });
  f.event({ type: 'input_audio_buffer.committed', item_id: 'a', previous_item_id: null });
  f.event({ type: 'input_audio_buffer.speech_started', item_id: 'b' });
  f.event({ type: 'input_audio_buffer.committed', item_id: 'b', previous_item_id: 'a' });
  f.event({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'b',
    transcript: 'Second request',
  });
  assert.deepEqual(f.transcripts, []);
  f.event({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'a',
    transcript: 'First request',
  });
  assert.deepEqual(f.transcripts, ['First request', 'Second request']);
  f.event({ type: 'input_audio_buffer.speech_started', item_id: 'c' });
  f.call.setMuted(true);
  f.call.setMuted(false);
  f.event({ type: 'input_audio_buffer.speech_started', item_id: 'd' });
  f.event({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'd',
    transcript: 'Fresh after mute',
  });
  assert.deepEqual(f.transcripts, ['First request', 'Second request', 'Fresh after mute']);
  f.call.stop();
  assert.equal(f.timers.size, 0);
});

test('stopping during microphone permission releases a late grant without starting a peer connection', async () => {
  const capture = deferred(),
    f = fixture({ mediaPromise: capture.promise }),
    start = f.call.start({ mode: 'openai' });
  f.call.stop();
  assert.equal(await start, false);
  assert.equal(f.timers.size, 0);
  capture.resolve(f.stream);
  await flush();
  assert.equal(f.track.stopped, true);
  assert.equal(f.pcs.length, 0);
  assert.equal(f.apiCalls.length, 0);
  assert.equal(f.states.at(-1).status, 'idle');
});

test('stopping during SDP request closes every resource and ignores the old answer after a new call starts', async () => {
  const exchange = deferred(),
    f = fixture({ apiPromise: exchange.promise }),
    start = f.call.start({ mode: 'openai' });
  await flush();
  assert.equal(f.apiCalls.length, 1);
  const old = f.pcs[0];
  assert.equal(f.apiSignals[0].aborted, false);
  f.call.stop();
  assert.equal(await start, false);
  assert.equal(f.track.stopped, true);
  assert.equal(old.closed, true);
  assert.equal(f.apiSignals[0].aborted, true);
  await f.call.start({ mode: 'browser' });
  exchange.resolve({ sdp: 'late-answer' });
  await flush();
  assert.equal(old.remoteDescription, undefined);
  assert.equal(f.call.mode, 'browser');
  assert.equal(f.states.at(-1).status, 'listening');
  f.call.stop();
});

test('ICE and data-channel setup timeouts release the microphone and do not leave timers', async () => {
  for (const [option, timeout] of [
    ['icePending', 8000],
    ['channelPending', 15000],
  ]) {
    const f = fixture({ [option]: true }),
      pending = f.call.start({ mode: 'openai' }),
      failed = assert.rejects(pending, /timed out/);
    await flush();
    f.advance(timeout);
    await failed;
    assert.equal(f.track.stopped, true);
    assert.equal(f.pcs[0].closed, true);
    assert.equal(f.call.active, false);
    assert.equal(f.timers.size, 0);
  }
});

test('permission, playback and disconnected transport failures clean up without hidden microphone capture', async () => {
  const denied = fixture({ mediaPromise: Promise.reject(new Error('Permission denied')) });
  await assert.rejects(denied.call.start({ mode: 'openai' }), /Permission denied/);
  assert.equal(denied.call.active, false);
  assert.equal(denied.pcs.length, 0);
  assert.equal(denied.timers.size, 0);
  const f = fixture({ playError: new Error('Autoplay blocked') });
  await f.call.start({ mode: 'openai' });
  f.pcs[0].fire('track', { streams: [f.remoteStream] });
  await flush();
  assert.equal(f.call.active, false);
  assert.equal(f.track.stopped, true);
  assert.equal(f.remoteTrack.stopped, true);
  assert.match(f.states.at(-1).error, /Autoplay blocked/);
  const other = fixture();
  await other.call.start({ mode: 'openai' });
  other.pcs[0].connectionState = 'disconnected';
  other.pcs[0].fire('connectionstatechange');
  assert.equal(other.call.active, false);
  assert.equal(other.track.stopped, true);
  assert.equal(other.pcs[0].channel.readyState, 'closed');
});

test('unexpected realtime answers are cancelled and cancellation errors are ignored, while real service errors end the call', async () => {
  const f = fixture();
  await f.call.start({ mode: 'openai' });
  const channel = f.pcs[0].channel;
  f.event({ type: 'response.created', response: { id: 'unexpected', metadata: {} } });
  assert.deepEqual(
    channel.sent.map(e => e.type),
    ['response.cancel', 'output_audio_buffer.clear'],
  );
  f.event({
    type: 'error',
    error: { event_id: channel.sent[0].event_id, message: 'Nothing active' },
  });
  assert.equal(f.call.active, true);
  f.event({ type: 'error', error: { code: 'quota_exceeded', message: 'Voice quota exhausted' } });
  assert.equal(f.call.active, false);
  assert.equal(f.track.stopped, true);
  assert.match(f.states.at(-1).error, /quota exhausted/);
});
