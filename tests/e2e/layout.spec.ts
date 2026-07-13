import { expect, test } from '@playwright/test'

import { installDeterministicBrowserAdapters, openSyntheticDemo } from './helpers'

test.beforeEach(async ({ page }) => {
  await installDeterministicBrowserAdapters(page)
})

test('practice UI fits the iPhone viewport with touch-sized controls', async ({ page }) => {
  await openSyntheticDemo(page)

  const layout = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    viewportHeight: window.innerHeight,
  }))
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewportWidth + 1)

  const chart = page.getByRole('img', { name: /Live target and detected pitch chart/ })
  const chartBox = await chart.boundingBox()
  expect(chartBox).not.toBeNull()
  if (chartBox === null) throw new Error('The practice chart has no rendered box.')
  expect(chartBox.width).toBeLessThanOrEqual(layout.viewportWidth)
  expect(chartBox.height).toBeLessThanOrEqual(layout.viewportHeight)

  const controls = page.locator('button:visible, input[type="range"]:visible')
  const sizes = await controls.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect()
      return {
        label: element.getAttribute('aria-label') ?? element.textContent,
        width: box.width,
        height: box.height,
      }
    }),
  )
  for (const control of sizes) {
    expect
      .soft(control.height, `${control.label.trim()} has a 44px touch target`)
      .toBeGreaterThanOrEqual(43.5)
  }

  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible()
})
