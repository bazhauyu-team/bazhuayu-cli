import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { test } from 'node:test';
import { TrackingClient } from '../dist/runtime/tracking.js';

test('tracking uploads encrypted CLI payload to CN production endpoint', async () => {
  const originalDisabled = process.env.OCTOPUS_TRACKING_DISABLED;
  const originalUrl = process.env.OCTOPUS_TRACKING_URL;
  delete process.env.OCTOPUS_TRACKING_DISABLED;
  delete process.env.OCTOPUS_TRACKING_URL;

  const requests = [];
  const client = new TrackingClient({ authSource: 'env' }, async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  });

  try {
    client.send({
      time: 'Mon, 18 May 2026 00:00:00 GMT',
      name: 'TrackCollectStart',
      content: {
        taskId: 'task-1',
        taskFile: '',
        success: true
      }
    });

    await waitFor(() => requests.length === 1);
    assert.equal(requests[0].url, 'https://tracking.bazhuayu.com/extract/upload');
    assert.equal(requests[0].init.method, 'POST');
    assert.equal(requests[0].init.headers['Content-Type'], 'application/json');

    const body = JSON.parse(requests[0].init.body);
    assert.equal(typeof body.data, 'string');
    const payload = JSON.parse(decryptTrackingPayload(body.data));
    assert.equal(payload.product, 'Bazhuayu');
    assert.equal(payload.channel, 'Cli');
    assert.equal(payload.common.keySource, 'env');
    assert.equal(payload.common.nodeVersion, process.version);
    assert.equal(payload.events.length, 1);
    assert.equal(payload.events[0].name, 'TrackCollectStart');
    assert.equal(payload.events[0].content.taskId, 'task-1');
    assert.equal(payload.events[0].content.taskFile, '');
  } finally {
    if (originalDisabled === undefined) delete process.env.OCTOPUS_TRACKING_DISABLED;
    else process.env.OCTOPUS_TRACKING_DISABLED = originalDisabled;
    if (originalUrl === undefined) delete process.env.OCTOPUS_TRACKING_URL;
    else process.env.OCTOPUS_TRACKING_URL = originalUrl;
  }
});

test('tracking close aborts stalled uploads', async () => {
  const originalDisabled = process.env.OCTOPUS_TRACKING_DISABLED;
  const originalUrl = process.env.OCTOPUS_TRACKING_URL;
  delete process.env.OCTOPUS_TRACKING_DISABLED;
  process.env.OCTOPUS_TRACKING_URL = 'http://127.0.0.1:1';
  let uploadSignal;
  const client = new TrackingClient({}, async (_url, init) => {
    uploadSignal = init.signal;
    return await new Promise((_resolve, reject) => {
      if (uploadSignal.aborted) {
        reject(uploadSignal.reason);
        return;
      }
      uploadSignal.addEventListener('abort', () => reject(uploadSignal.reason), { once: true });
    });
  });

  try {
    client.send({
      time: 'Mon, 18 May 2026 00:00:00 GMT',
      name: 'TrackCollectEnd',
      content: { taskId: 'task-1' }
    });
    await waitFor(() => Boolean(uploadSignal));
    await client.close(10);
    assert.equal(uploadSignal.aborted, true);
  } finally {
    if (originalDisabled === undefined) delete process.env.OCTOPUS_TRACKING_DISABLED;
    else process.env.OCTOPUS_TRACKING_DISABLED = originalDisabled;
    if (originalUrl === undefined) delete process.env.OCTOPUS_TRACKING_URL;
    else process.env.OCTOPUS_TRACKING_URL = originalUrl;
  }
});

function decryptTrackingPayload(value) {
  const keyBuffer = Buffer.alloc(16);
  keyBuffer.write('Octopus1');
  const decipher = createDecipheriv('aes-128-ecb', keyBuffer, null);
  return decipher.update(value, 'base64', 'utf8') + decipher.final('utf8');
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('condition was not met before timeout');
}
