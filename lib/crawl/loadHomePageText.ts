import { debug } from 'console';
import { Browser } from 'puppeteer';

export default async function loadHomePageText(
  browser: Browser
): Promise<string> {
  const page = await browser.newPage();
  await page.goto('http://localhost:3000');
  const homePageText = await page.$eval('*', (el) => el.textContent);
  debug('Home page text loaded');
  return homePageText || '';
}
