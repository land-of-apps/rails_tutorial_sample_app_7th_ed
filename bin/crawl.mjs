#!/usr/bin/env node

import { debug } from 'console'
import { PuppeteerCrawler, Dataset } from 'crawlee'
import puppeteer from 'puppeteer'

const browser = await puppeteer.launch({ headless: true })

let cookies = []

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
          browser.close()
          resolve()
        }
      }, 100)
    })
  }

  await waitForDestination()
}

await loadCookies()

// PuppeteerCrawler crawls the web using a headless
// browser controlled by the Puppeteer library.
const crawler = new PuppeteerCrawler({
  // Use the requestHandler to process each of the crawled pages.
  async requestHandler({ request, page, enqueueLinks, log }) {
    const title = await page.title()
    log.info(
      `Requested page ${request.url}, loaded '${title}'${
        request.loadedUrl !== request.url ? ` from '${request.loadedUrl}'` : ''
      }`
    )
    page.setCookie(...JSON.parse(cookies))

    // Save results as JSON to ./storage/datasets/default
    await Dataset.pushData({
      title,
      url: request.loadedUrl,
      cookies: JSON.parse(cookies),
    })

    // Extract links from the current page
    // and add them to the crawling queue.
    await enqueueLinks()
  },
  // Uncomment this option to see the browser window.
  // headless: false,
})

// Add first URL to the queue and start the crawl.
await crawler.run(['http://localhost:3000'])

// async function login(page, log) {
//   await page.waitForSelector('#session_email')
//   await page.type('#session_email', 'example@railstutorial.org')
//   await page.type('#session_password', 'foobar')
//   await page.click('input[type="submit"]')
//   await page.waitForNavigation()

//   log.info(Object.keys(await page.cookies()))
//   return new Promise((resolve) => {
//     page.on('response', async (res) => {
//       log.info(Object.keys(await page.cookies()))
//       log.info(Object.keys(res.headers()))
//       resolve()
//     })
//   })
// }

// async function before(request, page, log) {
//   const uri = new URL(request.url)
//   if (uri.pathname === '/login') await login(page, log)

//   const loginPage = await browser.newPage()
//   await loginPage.goto('http://localhost:3000/login')
//   await login(loginPage, log)
// }
