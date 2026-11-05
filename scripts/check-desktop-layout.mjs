import assert from 'node:assert/strict';
export async function checkDesktopLayout(page) {
  await page.evaluate(() => {
    window.layoutOriginal = {
      rfb: fixtureView.view.rfb,
      sequence: fixtureView.view.sequence,
      lease: fixtureView.view.lease,
      screen: document.querySelector('.remote-desktop-screen'),
    };
  });
  const unchanged = async () =>
    assert.equal(
      await page.evaluate(
        () =>
          fixtureView.view.rfb === layoutOriginal.rfb &&
          fixtureView.view.sequence === layoutOriginal.sequence &&
          fixtureView.view.lease === layoutOriginal.lease &&
          document.querySelector('.remote-desktop-screen') === layoutOriginal.screen &&
          layoutOriginal.screen.isConnected,
      ),
      true,
    );
  await page.locator('[data-desktop-window]').click();
  await page.waitForFunction(() => document.querySelector('.desktop-window-expanded'));
  await unchanged();
  await page.locator('[data-desktop-fullscreen]').click();
  await page.waitForFunction(() =>
    document.fullscreenElement?.classList.contains('remote-desktop-provider'),
  );
  await unchanged();
  await page.locator('[data-desktop-fullscreen]').click();
  await page.waitForFunction(() => !document.fullscreenElement);
  assert.equal(await page.locator('.desktop-window-expanded').count(), 1);
  await unchanged();
  await page.locator('[data-desktop-window]').click();
  assert.equal(await page.locator('.desktop-window-expanded').count(), 0);
  await unchanged();
  await page.locator('[data-desktop-fullscreen]').click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  await page.locator('[data-desktop-window]').click();
  await page.waitForFunction(() => !document.fullscreenElement);
  assert.equal(await page.locator('.desktop-window-expanded').count(), 0);
  await unchanged();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-desktop-window]').click();
  await unchanged();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator('[data-desktop-window]').click();
  await unchanged();
  console.log(
    'PASS layout: fill-window / actual browser fullscreen / side-view / mobile; same RFB object, connection sequence, lease and screen DOM throughout.',
  );
}
