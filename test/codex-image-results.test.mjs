import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { showVisualResult, CODEX_VISUAL_INSTRUCTIONS } from '../src/codex-image-results.mjs';
const url = 'data:image/png;base64,aGVsbG8=';
function render(result) {
  const images = [],
    texts = [];
  vm.runInNewContext('(' + showVisualResult.toString() + ')(result)', {
    result,
    image: x => images.push(x),
    text: x => texts.push(x),
  });
  return { images, texts };
}
test('Codex flattened dynamic results forward images separately from metadata', () => {
  const r = render('metadata\n' + url + '\nmore metadata');
  assert.deepEqual(r.images, [url]);
  assert.deepEqual(r.texts, ['metadata', 'more metadata']);
  assert.ok(!r.texts.join('').includes('base64'));
  assert.ok(CODEX_VISUAL_INSTRUCTIONS.includes(showVisualResult.toString()));
});
test('structured dynamic and MCP visual results remain compatible', () => {
  assert.deepEqual(
    render({
      contentItems: [
        { type: 'inputText', text: 'metadata' },
        { type: 'inputImage', imageUrl: url },
      ],
    }),
    { texts: ['metadata'], images: [url] },
  );
  const image = { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' };
  assert.deepEqual(render({ content: [image] }).images, [image]);
});
test('unknown image-bearing objects are not stringified into model text', () => {
  assert.throws(() => render({ imageUrl: url }), /Unsupported visual/);
  assert.throws(() => render('data:image/png;base64,broken text'), /Unsupported image/);
});
