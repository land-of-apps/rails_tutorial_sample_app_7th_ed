import { debug } from 'console';
import { Browser } from 'puppeteer';

export default async function loadCookies(browser: Browser): Promise<string> {
  const page = await browser.newPage();
  const url = page.url();
  await page.goto('http://localhost:3000/login');
  await page.waitForSelector('#session_email');
  await page.type('#session_email', 'example@railstutorial.org');
  await page.type('#session_password', 'foobar');
  await page.click('input[type="submit"]');
  await page.waitForNavigation();

  async function waitForDestination(): Promise<string> {
    return new Promise<string>((resolve) => {
      let i = setInterval(async () => {
        if (page.url() !== url) {
          const cookies = JSON.stringify(await page.cookies(), null, 2);
          debug('Cookies loaded');
          clearTimeout(i);
          resolve(cookies);
        }
      }, 100);
    });
  }

  return await waitForDestination();
}
