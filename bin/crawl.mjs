#!/usr/bin/env node

import { debug, time, warn } from 'console'
import { PuppeteerCrawler, Dataset } from 'crawlee'
import { diffWords } from 'diff'
import puppeteer from 'puppeteer'
import { Configuration, OpenAIApi } from 'openai'
import assert from 'assert'

const browser = await puppeteer.launch({ headless: true })

const TEXT_HISTORY_LENGTH = 20

let cookies = []
let homePageText = []
let textHistory = []

function levenshteinDistance(str1 = '', str2 = '') {
  const track = Array(str2.length + 1)
    .fill(null)
    .map(() => Array(str1.length + 1).fill(null))
  for (let i = 0; i <= str1.length; i += 1) {
    track[0][i] = i
  }
  for (let j = 1; j <= str2.length; j += 1) {
    track[j][0] = j
  }
  for (let j = 1; j <= str2.length; j += 1) {
    for (let i = 1; i <= str1.length; i += 1) {
      const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1
      track[j][i] = Math.min(
        track[j][i - 1] + 1, // deletion
        track[j - 1][i] + 1, // insertion
        track[j - 1][i - 1] + indicator // substitution
      )
    }
  }
  return track[str2.length][str1.length]
}

function closestMatch(input, examples) {
  let closest = examples[0]
  let closestDistance = levenshteinDistance(input, closest)

  for (let i = 1; i < examples.length; i++) {
    const distance = levenshteinDistance(input, examples[i])
    if (distance < closestDistance) {
      closest = examples[i]
      closestDistance = distance
    }
  }

  return closest
}

async function loadHomePageText() {
  const page = await browser.newPage()
  await page.goto('http://localhost:3000')
  homePageText = await page.$eval('*', (el) => el.innerText)
  debug('Home page text loaded')
  textHistory.push(homePageText)
}

async function loadCookies() {
  const page = await browser.newPage()
  const url = page.url()
  await page.goto('http://localhost:3000/login')
  await page.waitForSelector('#session_email')
  await page.type('#session_email', 'example@railstutorial.org')
  await page.type('#session_password', 'foobar')
  await page.click('input[type="submit"]')
  await page.waitForNavigation()

  async function waitForDestination() {
    return new Promise((resolve) => {
      let i = setInterval(async () => {
        if (page.url() !== url) {
          cookies = JSON.stringify(await page.cookies(), null, 2)
          debug('Cookies loaded')
          clearTimeout(i)
          resolve()
        }
      }, 100)
    })
  }

  await waitForDestination()
}

await loadHomePageText()
await loadCookies()
// browser.close()

function normalizePage(url) {
  const { pathname, searchParams } = url
  const normalizedPathname = pathname
    .split('/')
    .map((part) => (!part || Number.isNaN(Number(part)) ? part : ':param'))
    .join('/')
  return [normalizedPathname, searchParams.toString()].filter(Boolean).join('?')
}

const DUPLICATE_PAGE_COUNT_THRESHOLD = 3

const duplicatePageCount = new Map()

const OPENAI_API_KEY = process.env.OPENAI_API_KEY
if (!OPENAI_API_KEY)
  throw new Error('OPENAI_API_KEY environment variable not set')

export default async function buildOpenAIApi() {
  return new OpenAIApi(new Configuration({ apiKey: OPENAI_API_KEY }))
}

function recordPage(url) {
  const normalizedUri = normalizePage(url)
  const count = duplicatePageCount.get(normalizedUri) || 0
  duplicatePageCount.set(normalizedUri, count + 1)
  return count < DUPLICATE_PAGE_COUNT_THRESHOLD
}

async function completeForm(loadedUrl, prompt, form) {
  const ai = await buildOpenAIApi()

  debug(`Analyzing ${loadedUrl} with AI`)

  const systemMessages = [
    'You are a website user. You read the page content on a website and fill out forms with the necessary information to continue your workflow',
    `You'll be presented with some text from the website, and the HTML of a form`,
    `The text and form are separated by the delimeter '---'`,
    `Respond with three form submissions that you think are appropriate for the text`,
    `You only need to provide the user-visible fields, not hidden fields`,
    `The reason to respond with three submissions is to be compatible with form validation`,
  ].map((message) => ({
    content: message,
    role: 'system',
  }))

  const userMessages = [
    `The page text is: --- ${prompt} ---`,
    `The form is: --- ${form} ---`,
  ].map((message) => ({
    content: message,
    role: 'user',
  }))

  const messages = [...userMessages, ...systemMessages]
  let result

  try {
    result = await ai.createChatCompletion({
      model: 'gpt-3.5-turbo-16k',
      messages,
      n: 1,
      max_tokens:
        // 16384 is the maximum number of tokens allowed by gpt-3.5-turbo-16k
        16384 -
        // This is a conservative estimate of the number of tokens in the prompt, since
        // a token can be more than one character.
        messages
          .map((msg) => msg.content?.length)
          .filter(Boolean)
          .reduce((a, b) => a + b, 0),
      // function_call: 'submit',
      functions: [
        {
          name: 'submit',
          parameters: {
            type: 'object',
            properties: {
              submissions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    fields: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          form_element_name: {
                            type: 'string',
                          },
                          form_element_value: {
                            type: 'string',
                          },
                        },
                        required: ['form_element_name', 'form_element_value'],
                      },
                    },
                  },
                  required: ['fields'],
                },
              },
              submit_element_name: {
                type: 'string',
                description: 'Name of the submit element',
              },
            },
            required: ['submissions', 'submit_element_name'],
          },
        },
      ],
    })
  } catch (e) {
    warn(e)
    warn(JSON.stringify(e.response.data, null, 2))
    return
  }
  const response = result.data.choices
    .map(
      (choice) => (
        assert(choice.message),
        assert(choice.message.function_call),
        choice.message.function_call.arguments
      )
    )
    .map((arg) => JSON.parse(arg))[0]
  // debug(response)
  assert(response)

  const page = await browser.newPage()
  await page.goto(loadedUrl)
  for (const submission of response.submissions) {
    const setByName = async (name, value) =>
      await page.type(`form [name="${name}"]`, value)
    const setById = async (id, value) => await page.type(`#${id}`, value)

    for (const field of submission.fields) {
      const { form_element_name, form_element_value } = field
      const name = form_element_name
      const value = form_element_value
      let set = false
      let errors = []
      for (const setter of [setByName, setById]) {
        try {
          await setter(name, value)
          set = true
          break
        } catch (e) {
          errors.push(e)
        }
      }

      if (!set) {
        warn(`Failed to set ${name} to ${value}: ${errors.join(', ')}`)
        return
      }
    }

    debug(`Submitting AI-populated form to ${loadedUrl}`)
    await page.click(`form [name="${response.submit_element_name}"]`)
    try {
      await page.waitForNavigation({ timeout: 3 * 1000 })
    } catch (e) {
      warn(`Timed out waiting for navigation: ${e}`)
      warn(`Proceeding optimistically`)
    }

    if (page.url() !== loadedUrl) {
      debug(
        `Form successfully submitted to ${loadedUrl}, then redirected to ${page.url()}: ${JSON.stringify(
          submission
        )}`
      )
      // TODO: Add links to the processing queue
      debug(`Adding ${page.url()} to the processing queue`)
      crawler.addRequests([page.url()])
      return
    }

    debug(
      `Form submission to ${loadedUrl} appears to have been rejected, because the page URL didn't change: ${JSON.stringify(
        submission
      )}`
    )
  }
}

// PuppeteerCrawler crawls the web using a headless
// browser controlled by the Puppeteer library.
const crawler = new PuppeteerCrawler({
  // headless: false,
  async failedRequestHandler({ request, error }) {
    console.error(`Request ${request.url} failed: ${error}`)
  },
  async requestHandler({ request, page, _enqueueLinks, log }) {
    const title = await page.title()
    log.info(
      `Requested page ${request.url}, loaded '${title}'${
        request.loadedUrl !== request.url ? ` from '${request.loadedUrl}'` : ''
      }`
    )
    page.setCookie(...JSON.parse(cookies))

    const text = await page.$eval('*', (el) => el.innerText)

    const forms = await page.$$eval('form', (elements) => {
      return elements.map((el) => el.outerHTML)
    })

    if (textHistory.length > 0) {
      const closestMatchingText = closestMatch(text, textHistory)
      const diff = diffWords(closestMatchingText, text)
      const prompt = diff
        .map((part) => {
          if (part.added) return part.value
        })
        .filter(Boolean)
        .join(' ')
      log.debug(`Relevant text: ${prompt}`)
      if (forms.length > 0) {
        log.debug(`Forms on this page: ${forms.join('\n')}`)

        // Fire these async, to avoid blocking the request handler.
        // If the form can be submitted, the resulting page will be added to the crawler queue.
        forms.map((form) => completeForm(request.loadedUrl, prompt, form))
        // wait 10 seconds to give the AI time to run
        await new Promise((resolve) => setTimeout(resolve, 10000))
      }
    }

    if (textHistory.length > TEXT_HISTORY_LENGTH) textHistory.shift()
    textHistory.push(text)

    const links = await page.$$eval('a', (elements) => {
      return elements
        .filter((el) => el.getAttribute('data-turbo-method') !== 'delete')
        .map((el) => el.getAttribute('href'))
    })
    await Dataset.pushData({
      title,
      url: request.loadedUrl,
      text,
      links,
      forms,
    })

    const { origin } = new URL(request.loadedUrl)
    await Promise.all(
      links
        .filter((link) => !link.startsWith('#'))
        .map((link) => {
          try {
            return link.startsWith('/') ? new URL(link, origin) : new URL(link)
          } catch (e) {
            log.warning(`Invalid URL: ${link} (${e.toString()}))`)
          }
        })
        .filter(Boolean)
        .filter((url) => url.origin === origin)
        .map(async (url) => {
          if (recordPage(url))
            await crawler.requestQueue.addRequest({ url: url.toString() })
        })
    )
  },
})

await crawler.run(['http://localhost:3000'])
browser.close()
