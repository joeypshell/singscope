import { expect, test } from '@playwright/test'

import { installDeterministicBrowserAdapters, openApp, openSyntheticDemo } from './helpers'

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

test('manual keyboard settings never overlap at an iPhone viewport', async ({ page }) => {
  await openApp(page)
  await page.getByRole('button', { name: 'New project' }).click()
  await page
    .getByRole('group', { name: 'Target source' })
    .getByRole('button', { name: 'Manual' })
    .click()

  const keyboard = page.getByRole('region', { name: 'Enter melody with piano' })
  const settings = keyboard.locator('.ss-keyboard-settings')
  const settingsBox = await settings.boundingBox()
  expect(settingsBox).not.toBeNull()
  if (settingsBox === null) throw new Error('The keyboard settings have no rendered box.')

  const fields = await settings.locator(':scope > .ss-field').evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect()
      return {
        label: element.textContent.trim(),
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      }
    }),
  )
  expect(fields).toHaveLength(3)
  const intersects = (left: (typeof fields)[number], right: (typeof fields)[number]) =>
    left.x < right.x + right.width - 0.5 &&
    left.x + left.width > right.x + 0.5 &&
    left.y < right.y + right.height - 0.5 &&
    left.y + left.height > right.y + 0.5
  for (const [index, field] of fields.entries()) {
    expect.soft(field.x).toBeGreaterThanOrEqual(settingsBox.x - 0.5)
    expect.soft(field.x + field.width).toBeLessThanOrEqual(settingsBox.x + settingsBox.width + 0.5)
    for (const other of fields.slice(index + 1)) {
      expect.soft(intersects(field, other), `${field.label} overlaps ${other.label}`).toBe(false)
    }
  }

  const controls = keyboard.locator(
    '.ss-octave-control button, .ss-keyboard-settings select, .ss-keyboard-actions button',
  )
  const sizes = await controls.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect()
      return { label: element.textContent.trim(), width: box.width, height: box.height }
    }),
  )
  for (const control of sizes) {
    expect.soft(control.width, `${control.label} is not squeezed`).toBeGreaterThanOrEqual(43.5)
    expect
      .soft(control.height, `${control.label} has a 44px touch target`)
      .toBeGreaterThanOrEqual(43.5)
  }

  const layout = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewportWidth + 1)
})
