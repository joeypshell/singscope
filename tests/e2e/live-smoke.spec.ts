import { expect, test } from '@playwright/test'

test.setTimeout(60_000)

test('deployed shell opens and its bundled demo is available', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('singscope:onboarding:v1', 'complete'))
  await page.goto('./')

  await expect(page.getByRole('heading', { name: 'SingScope' })).toBeVisible()
  const demo = page.getByRole('button', { name: 'Open synthetic demo' })
  await expect(demo).toBeVisible()
  const dismiss = page.getByRole('button', { name: 'Dismiss' })
  if (await dismiss.isVisible()) await dismiss.click()
  await demo.click()
  await expect(page.getByRole('heading', { name: 'Synthetic warm-up' })).toBeVisible()
  await expect(
    page.getByRole('img', { name: /Live target and detected pitch chart/ }),
  ).toBeVisible()

  const response = await page.request.get(new URL('demo-reference.wav', page.url()).href)
  expect(response.ok()).toBe(true)
  expect(response.headers()['content-type']).toContain('audio')
})
