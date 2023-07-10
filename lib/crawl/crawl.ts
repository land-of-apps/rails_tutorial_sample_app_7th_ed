#!/usr/bin/env node

import { PuppeteerCrawler, Dataset } from 'crawlee';
import { diffWords } from 'diff';
import puppeteer from 'puppeteer';
import closestMatch from './closestMatch.js';
import loadHomePageText from './loadHomePageText.js';
import loadCookies from './loadCookies.js';
import { recordPage } from './recordPage.js';
import { completeForm } from './completeForm.js';
import assert from 'assert';

export const browser = await puppeteer.launch({ headless: true });

const TEXT_HISTORY_LENGTH = 20;

export let cookies: string = '';
export let homePageText: string[] = [];
export let textHistory: string[] = [];

homePageText.push(await loadHomePageText(browser));
cookies = await loadCookies(browser);

browser.close();

export const DUPLICATE_PAGE_COUNT_THRESHOLD = 3;

export const duplicatePageCount = new Map();

// PuppeteerCrawler crawls the web using a headless
// browser controlled by the Puppeteer library.
export const crawler = new PuppeteerCrawler({
  // headless: false,
  async failedRequestHandler({ request, error }) {
    console.error(`Request ${request.url} failed: ${error}`);
  },
  async requestHandler({ request, page, _enqueueLinks, log }) {
    const title = await page.title();
    log.info(
      `Requested page ${request.url}, loaded '${title}'${
        request.loadedUrl !== request.url ? ` from '${request.loadedUrl}'` : ''
      }`
    );
    page.setCookie(...JSON.parse(cookies));

    const text = await page.$eval('*', (el) => el.textContent);

    const forms = await page.$$eval('form', (elements) => {
      return elements.map((el) => el.outerHTML);
    });

    if (text && textHistory.length > 0) {
      const closestMatchingText = closestMatch(text, textHistory);
      const diff = diffWords(closestMatchingText, text);
      const prompt = diff
        .map((part) => {
          if (part.added) return part.value;
        })
        .filter(Boolean)
        .join(' ');
      log.debug(`Relevant text: ${prompt}`);
      if (forms.length > 0 && request.loadedUrl) {
        log.debug(`Forms on this page: ${forms.join('\n')}`);

        // Fire these async, to avoid blocking the request handler.
        // If the form can be submitted, the resulting page will be added to the crawler queue.
        forms.map(
          (form) => (
            assert(request.loadedUrl),
            completeForm(request.loadedUrl, prompt, form)
          )
        );
        // wait 10 seconds to give the AI time to run
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }
    }

    if (text) {
      textHistory.push(text);
      if (textHistory.length > TEXT_HISTORY_LENGTH) textHistory.shift();
    }

    const links = (
      await page.$$eval('a', (elements) => {
        return elements
          .filter((el) => el.getAttribute('data-turbo-method') !== 'delete')
          .map((el) => el.getAttribute('href'));
      })
    ).filter(Boolean) as string[];
    await Dataset.pushData({
      title,
      url: request.loadedUrl,
      text,
      links,
      forms,
    });

    const { origin } = new URL(request.loadedUrl || request.url);
    await Promise.all(
      links
        .filter((link) => !link.startsWith('#'))
        .map((link) => {
          try {
            return link.startsWith('/') ? new URL(link, origin) : new URL(link);
          } catch (e) {
            log.warning(`Invalid URL: ${link} (${(e as any).toString()}))`);
          }
        })
        .filter(Boolean)
        .filter((url) => (assert(url), url.origin === origin))
        .map(async (url) => {
          assert(url);
          if (recordPage(url))
            await crawler.requestQueue!.addRequest({ url: url.toString() });
        })
    );
  },
});

await crawler.run(['http://localhost:3000']);
