import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceSession, VOICE_MODEL, VOICE_NAME } from '../src/voice.mjs';

const key = 'sk-test-voice-secret-123456789',
  offer =
    'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n',
  answer = offer.replace('1 1', '2 2');

test('voice negotiation sends only server-held authorization and configures transcription plus explicit bot speech', async () => {
  let calls = 0;
  const result = await createVoiceSession({
    sdp: offer,
    apiKey: key,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.openai.com/v1/realtime/calls');
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, `Bearer ${key}`);
      assert.equal(options.body.get('sdp'), offer);
      assert.equal(options.headers['Content-Type'], undefined);
      const session = JSON.parse(options.body.get('session'));
      assert.equal(session.model, 'gpt-realtime-2.1');
      assert.equal(session.type, 'realtime');
      assert.deepEqual(session.output_modalities, ['audio']);
      assert.deepEqual(session.audio.input.transcription, {
        model: 'gpt-4o-mini-transcribe',
        language: 'he',
      });
      assert.equal(session.audio.input.turn_detection.create_response, false);
      assert.equal(session.audio.input.turn_detection.interrupt_response, false);
      assert.equal(session.audio.input.turn_detection.idle_timeout_ms, undefined);
      assert.deepEqual(session.tools, []);
      assert.equal(session.tool_choice, 'none');
      assert.equal(session.audio.output.voice, 'marin');
      assert.ok(!JSON.stringify(session).includes(key));
      return new Response(answer, { status: 201, headers: { 'Content-Type': 'application/sdp' } });
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { sdp: answer, model: VOICE_MODEL, voice: VOICE_NAME });
  assert.ok(!JSON.stringify(result).includes(key));
});

test('voice rejects malformed offers, keys and languages before contacting the API', async () => {
  let calls = 0;
  const fetchImpl = () => {
    calls++;
    throw new Error('Unexpected fetch');
  };
  for (const change of [
    { apiKey: '' },
    { apiKey: 'key\nheader' },
    { sdp: 'not SDP' },
    { sdp: offer + '\0' },
    { sdp: offer + 'x'.repeat(128 * 1024) },
    { language: 'unknown' },
  ])
    await assert.rejects(createVoiceSession({ sdp: offer, apiKey: key, fetchImpl, ...change }));
  assert.equal(calls, 0);
  await createVoiceSession({
    sdp: offer,
    apiKey: key,
    language: 'en',
    fetchImpl: async (url, options) => {
      assert.equal(
        JSON.parse(options.body.get('session')).audio.input.transcription.language,
        'en',
      );
      return new Response(answer);
    },
  });
});

test('voice errors redact credentials and do not retry or follow redirects', async () => {
  let calls = 0;
  await assert.rejects(
    createVoiceSession({
      sdp: offer,
      apiKey: key,
      fetchImpl: async () => {
        calls++;
        return new Response(
          JSON.stringify({
            error: { message: `Invalid key ${key}; Authorization: Bearer ${key}` },
          }),
          { status: 401 },
        );
      },
    }),
    error => {
      assert.match(error.message, /HTTP 401/);
      assert.ok(!error.message.includes(key));
      assert.match(error.message, /redacted/);
      return true;
    },
  );
  assert.equal(calls, 1);
  await assert.rejects(
    createVoiceSession({
      sdp: offer,
      apiKey: key,
      fetchImpl: async () =>
        new Response('', { status: 302, headers: { Location: 'https://example.invalid' } }),
    }),
    /redirects are not allowed/,
  );
  await assert.rejects(
    createVoiceSession({
      sdp: offer,
      apiKey: key,
      fetchImpl: async () => {
        throw new Error(`network for ${key}`);
      },
    }),
    error => !error.message.includes(key),
  );
});

test('voice rejects non-SDP or credential-echo success responses', async () => {
  for (const text of ['<html>error</html>', answer + `a=secret:${key}\r\n`])
    await assert.rejects(
      createVoiceSession({ sdp: offer, apiKey: key, fetchImpl: async () => new Response(text) }),
      /invalid voice SDP/,
    );
});

test('voice bounds successful and failed response bodies while streaming', async () => {
  for (const [status, size] of [
    [200, 128 * 1024 + 1],
    [500, 8193],
  ]) {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(size));
      },
      cancel() {
        cancelled = true;
      },
    });
    await assert.rejects(
      createVoiceSession({
        sdp: offer,
        apiKey: key,
        fetchImpl: async () => new Response(body, { status }),
      }),
      /size limit/,
    );
    assert.equal(cancelled, true);
  }
});

test('voice connection timeout also covers an open response body', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('v=0\r\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    createVoiceSession({
      sdp: offer,
      apiKey: key,
      timeoutMs: 25,
      fetchImpl: async () => new Response(body),
    }),
    /timed out/,
  );
  assert.equal(cancelled, true);
});

test('voice cancellation interrupts negotiation without retrying or exposing abort reasons', async () => {
  const controller = new AbortController();
  let calls = 0,
    upstreamSignal;
  const pending = createVoiceSession({
    sdp: offer,
    apiKey: key,
    signal: controller.signal,
    fetchImpl: async (url, options) => {
      calls++;
      upstreamSignal = options.signal;
      return new Promise(() => {});
    },
  });
  controller.abort(new Error(`private detail ${key}`));
  await assert.rejects(pending, /Voice connection cancelled/);
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(calls, 1);
  await assert.rejects(
    createVoiceSession({
      sdp: offer,
      apiKey: key,
      signal: controller.signal,
      fetchImpl: () => {
        calls++;
      },
    }),
    /cancelled/,
  );
  assert.equal(calls, 1);
});
