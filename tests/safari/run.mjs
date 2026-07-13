import assert from 'node:assert/strict'
import { Browser, Builder, By, until } from 'selenium-webdriver'

const url = process.env.SINGSCOPE_TEST_URL ?? 'http://127.0.0.1:4173'
const capabilities = {
  browserName: Browser.SAFARI,
  platformName: 'ios',
  'safari:useSimulator': true,
  ...(process.env.IOS_DEVICE_UDID ? { 'safari:deviceUDID': process.env.IOS_DEVICE_UDID } : {}),
}

const driver = await new Builder().forBrowser(Browser.SAFARI).withCapabilities(capabilities).build()

async function nativeTap(element) {
  await driver.executeScript((target) => target.scrollIntoView({ block: 'center' }), element)
  await driver.actions().click(element).perform()
}

try {
  await driver.get(url)
  await driver.wait(until.elementLocated(By.css('h1')), 20_000)
  assert.match(await driver.getTitle(), /SingScope/i)
  assert.match(await driver.findElement(By.css('body')).getText(), /SingScope/i)

  const support = await driver.executeScript(() => ({
    audioContext: typeof AudioContext === 'function',
    audioWorklet: 'audioWorklet' in AudioContext.prototype,
    mediaRecorder: typeof MediaRecorder === 'function',
    indexedDb: typeof indexedDB === 'object',
    canvas: Boolean(document.createElement('canvas').getContext('2d')),
    recorderTypes: ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus'].filter(
      (type) => typeof MediaRecorder === 'function' && MediaRecorder.isTypeSupported(type),
    ),
  }))
  assert.equal(support.audioContext, true)
  assert.equal(support.audioWorklet, true)
  assert.equal(support.mediaRecorder, true)
  assert.equal(support.indexedDb, true)
  assert.equal(support.canvas, true)
  assert.ok(support.recorderTypes.length >= 1)

  const dismissButtons = await driver.findElements(
    By.xpath("//button[normalize-space()='Dismiss']"),
  )
  if (dismissButtons[0] && (await dismissButtons[0].isDisplayed())) {
    await nativeTap(dismissButtons[0])
  }

  const continueButtons = await driver.findElements(
    By.xpath("//button[normalize-space()='Continue']"),
  )
  if (continueButtons[0]) {
    await driver.wait(until.elementIsEnabled(continueButtons[0]), 20_000)
    await nativeTap(continueButtons[0])
    const onboardingComplete = () =>
      driver.executeScript(() => localStorage.getItem('singscope:onboarding:v1'))
    if ((await onboardingComplete()) !== 'complete') {
      await driver.executeScript((element) => element.click(), continueButtons[0])
    }
    await driver.wait(async () => (await onboardingComplete()) === 'complete', 10_000)
  }

  const demoButton = await driver.wait(
    until.elementLocated(By.css('[data-testid="open-demo"]')),
    10_000,
  )
  await nativeTap(demoButton)
  await driver.sleep(1_000)
  if (!String(await driver.executeScript(() => window.location.hash)).startsWith('#/practice/')) {
    await driver.executeScript((element) => element.click(), demoButton)
  }
  const canvas = await driver.wait(until.elementLocated(By.css('canvas')), 10_000)
  assert.equal(await canvas.isDisplayed(), true)

  const startButton = await driver.wait(
    until.elementLocated(By.xpath("//button[normalize-space()='Start']")),
    10_000,
  )
  await driver.sleep(750)
  await nativeTap(startButton)
  await driver.wait(
    async () => /Countdown|Recording/.test(await driver.findElement(By.css('body')).getText()),
    10_000,
  )
  await driver.sleep(3_500)
  assert.match(await driver.findElement(By.css('body')).getText(), /Recording/)

  const stopButton = await driver.findElement(By.xpath("//button[normalize-space()='Stop']"))
  await nativeTap(stopButton)
  await driver.wait(
    async () => /Review/.test(await driver.findElement(By.css('body')).getText()),
    20_000,
  )
  await driver.navigate().refresh()
  const reloadedCanvas = await driver.wait(until.elementLocated(By.css('canvas')), 10_000)
  assert.equal(await reloadedCanvas.isDisplayed(), true)
} catch (error) {
  const body = await driver
    .findElement(By.css('body'))
    .getText()
    .catch(() => 'Body unavailable')
  console.error(`Safari smoke body at failure:\n${body.slice(0, 4_000)}`)
  throw error
} finally {
  await driver.quit()
}
