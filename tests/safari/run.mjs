import assert from 'node:assert/strict'
import { Browser, Builder, By, Key, until } from 'selenium-webdriver'
import input from 'selenium-webdriver/lib/input.js'

const url = process.env.SINGSCOPE_TEST_URL ?? 'http://127.0.0.1:4173'
const capabilities = {
  browserName: Browser.SAFARI,
  platformName: 'ios',
  'safari:useSimulator': true,
  ...(process.env.IOS_DEVICE_UDID ? { 'safari:deviceUDID': process.env.IOS_DEVICE_UDID } : {}),
}

const smokeTimeoutMs = Number(process.env.SAFARI_SMOKE_TIMEOUT_MS ?? 90_000)
const watchdog = setTimeout(() => {
  console.error(`Safari smoke exceeded ${smokeTimeoutMs}ms; forcing the CI retry to continue`)
  process.exit(1)
}, smokeTimeoutMs)

let driver
let touchSequence = 0

async function nativeTap(element) {
  await driver.executeScript((target) => target.scrollIntoView({ block: 'center' }), element)
  const touch = new input.Pointer(`singscope-touch-${touchSequence++}`, input.Pointer.Type.TOUCH)
  console.log(`Sending W3C touch action ${touchSequence}`)
  await driver
    .actions({ async: true })
    .insert(
      touch,
      touch.move({ origin: element, duration: 100, width: 8, height: 8 }),
      touch.press(input.Button.LEFT, 8, 8, 0.5),
      touch.release(input.Button.LEFT),
    )
    .perform()
  console.log(`Completed W3C touch action ${touchSequence}`)
}

async function practicePhase() {
  return driver.executeScript(() => {
    const status =
      document.querySelector('.ss-pitch-summary .ss-visually-hidden')?.textContent ?? ''
    return /Practice state:\s*([a-z]+)\./.exec(status)?.[1] ?? null
  })
}

async function waitForPracticePhase(expected, timeout = 10_000) {
  await driver.wait(async () => expected.includes(await practicePhase()), timeout)
}

async function trustedStart(element) {
  await nativeTap(element)
  try {
    await waitForPracticePhase(['countdown', 'recording'], 3_000)
    return
  } catch {
    const phase = await practicePhase()
    if (!['idle', 'ready', 'retry'].includes(phase)) {
      throw new Error(`Start touch left practice in the unexpected “${phase ?? 'unknown'}” phase`)
    }
    console.warn('SafariDriver touch did not start audio; retrying Start with a trusted key action')
  }

  await driver.executeScript((target) => target.focus(), element)
  await driver.actions({ async: true }).sendKeys(Key.ENTER).perform()
  await waitForPracticePhase(['countdown', 'recording'], 10_000)
}

try {
  console.log(`Creating Simulator Safari session for ${url}`)
  driver = await new Builder().forBrowser(Browser.SAFARI).withCapabilities(capabilities).build()
  console.log('Simulator Safari session ready')
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
  console.log('Simulator Safari platform capability checks passed')

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
  console.log('Opening the synthetic demo through deterministic harness setup')
  await driver.executeScript((element) => element.click(), demoButton)
  await driver.sleep(2_000)
  const canvas = await driver.wait(until.elementLocated(By.css('canvas')), 10_000)
  assert.equal(await canvas.isDisplayed(), true)
  console.log('Synthetic demo is open and its Canvas is visible')

  const repetitionsInput = await driver.findElement(
    By.xpath("//span[normalize-space()='Repetitions']/following-sibling::input[@type='number']"),
  )
  await driver.executeScript((target) => {
    const valueSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value')?.set
    valueSetter?.call(target, '1')
    target.dispatchEvent(new Event('input', { bubbles: true }))
    target.dispatchEvent(new Event('change', { bubbles: true }))
  }, repetitionsInput)
  await driver.wait(
    async () => (await driver.executeScript((target) => target.value, repetitionsInput)) === '1',
    5_000,
  )
  console.log('Synthetic demo is configured for one take')

  const startButton = await driver.wait(
    until.elementLocated(By.xpath("//button[normalize-space()='Start']")),
    10_000,
  )
  await waitForPracticePhase(['ready'], 20_000)
  await driver.wait(until.elementIsEnabled(startButton), 20_000)
  await trustedStart(startButton)
  await waitForPracticePhase(['recording'], 15_000)
  await driver.sleep(1_500)
  assert.equal(await practicePhase(), 'recording')

  const stopButton = await driver.findElement(By.xpath("//button[normalize-space()='Stop']"))
  await driver.wait(until.elementIsEnabled(stopButton), 5_000)
  await nativeTap(stopButton)
  await driver.wait(
    async () =>
      String(await driver.executeScript(() => window.location.hash)).startsWith('#/review/'),
    20_000,
  )
  const reviewLabel = await driver.wait(
    until.elementLocated(By.css('.ss-review-heading .ss-eyebrow')),
    10_000,
  )
  assert.equal(await reviewLabel.getText(), 'Review · Take 1')

  await driver.navigate().refresh()
  await driver.wait(
    async () =>
      String(await driver.executeScript(() => window.location.hash)).startsWith('#/review/'),
    10_000,
  )
  const reloadedReviewLabel = await driver.wait(
    until.elementLocated(By.css('.ss-review-heading .ss-eyebrow')),
    10_000,
  )
  assert.equal(await reloadedReviewLabel.getText(), 'Review · Take 1')
  const reloadedCanvas = await driver.wait(until.elementLocated(By.css('canvas')), 10_000)
  assert.equal(await reloadedCanvas.isDisplayed(), true)
  console.log('Recorded take reached Review and survived a Safari reload')
} catch (error) {
  const body = driver
    ? await driver
        .findElement(By.css('body'))
        .getText()
        .catch(() => 'Body unavailable')
    : 'Safari session unavailable'
  console.error(`Safari smoke body at failure:\n${body.slice(0, 4_000)}`)
  throw error
} finally {
  if (driver) {
    await driver.quit().catch((error) => console.warn(`SafariDriver quit failed: ${error}`))
  }
  clearTimeout(watchdog)
}
