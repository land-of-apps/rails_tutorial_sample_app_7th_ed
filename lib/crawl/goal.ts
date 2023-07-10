import puppeteer, { Browser, ElementHandle, Page } from 'puppeteer';
import { debug, info, log, warn } from 'console';
import assert from 'assert';
import inquirer, { Answers, QuestionCollection } from 'inquirer';
import { ArgumentParser } from 'argparse';
import { readFile } from 'fs/promises';

import { chooseGoalAction } from './chooseGoalAction.js';
import History from './history.js';

export let DEBUG = process.env.DEBUG === 'true';

const assert_css_selector = JSON.parse(
  await readFile(
    new URL('./schema/assert_css_selector.json', import.meta.url),
    'utf-8'
  )
);
const assert_page_url = JSON.parse(
  await readFile(
    new URL('./schema/assert_page_url.json', import.meta.url),
    'utf-8'
  )
);

type Step = {
  mode: string;
  nextMode?: string;
  action: any;
  done: boolean;
};

class Goal {
  public history = new History();
  public errors: string[] = [];
  public modeName = 'choose_action';

  page: Page | undefined;

  constructor(
    public browser: Browser,
    public startUrl: string,
    public goal: string,
    public successCriteria: string
  ) {}

  async initialize() {
    this.page = await browser.newPage();
    await this.page.goto(this.startUrl);
  }

  async step(): Promise<Step | undefined> {
    assert(this.page);
    const page = this.page;

    const links = (
      await page.$$eval('a', (elements) => {
        return elements
          .filter((el) => el.getAttribute('data-turbo-method') !== 'delete')
          .map((el) => el.getAttribute('href'));
      })
    ).filter(Boolean) as string[];

    //   const text = el.textContent;
    //   if (!href || !text) return;
    //   return `[${text}](${href})`;
    // }

    const forms = await page.$$eval('form', (elements) => {
      return elements.map((el) => el.outerHTML);
    });
    // debug(forms);

    // const visitLinks = links.map((link) => `visit_link: ${link}`);
    const submitForms = forms.map((form) => `submit_form: ${form}`);
    const actions = submitForms;

    const modes = this.modeOptions(links);
    const { modeName: mode } = this;

    // const actions: string[] = [...visitLinks, ...submitForms];
    // const actions = ['Visit a link', ...submitForms];

    const pageText = await page.evaluate(() => document.body.outerHTML);
    const aiResponse = await chooseGoalAction(
      this.goal,
      this.successCriteria,
      this.modeName,
      modes[this.modeName],
      page.url(),
      pageText,
      this.history,
      forms
    );
    if (!aiResponse) return;

    // if (DEBUG)
    debug(JSON.stringify(aiResponse, null, 2));
    let done = false;

    if (this.modeName === 'choose_action') {
      assert(aiResponse.action_name);
      info(`Choosing ${aiResponse.action_name}, because ${aiResponse.reason}`);
      if (aiResponse.action_name === 'complete') {
        done = true;
      } else {
        this.modeName = aiResponse.action_name;
      }
    } else if (this.modeName === 'navigate_to_url') {
      let pathname = '';
      if (aiResponse.url.indexOf('http') === -1) {
        try {
          pathname = new URL(aiResponse.url).pathname;
        } catch (e) {}
      }
      if (!pathname) {
        pathname = new URL(aiResponse.url, 'http://localhost:3000').pathname;
      }
      const url = new URL(pathname, 'http://localhost:3000');
      this.appendHistory(`Visit ${url.toString()}`);
      await page.goto(url.toString());
      this.modeName = 'choose_action';
    } else if (this.modeName === 'assert_css_selector') {
      const { selector, is_goal_completion } = aiResponse;

      this.appendHistory(`Assert CSS selector ${selector}`);
      let selection: ElementHandle<any> | null = null;
      try {
        selection = await page.waitForSelector(selector, { timeout: 100 });
      } catch (e) {
        warn(`Failed to locate ${selector} after 100ms`);
      }
      if (selection) {
        this.appendHistory(`Found ${selector}`);
        if (is_goal_completion) done = true;
      } else {
        this.reportError(`selector was not found`);
      }
      this.modeName = 'choose_action';
    } else if (this.modeName === 'assert_page_url') {
      const { pattern, is_goal_completion } = aiResponse;
      if (!pattern) return;

      this.appendHistory(`Assert page URL ${pattern}`);
      const match = new RegExp(pattern).test(page.url());
      if (match) {
        this.appendHistory(`Page URL ${page.url()} matches ${pattern}`);
        if (is_goal_completion) done = true;
      } else {
        this.reportError(`Page URL ${page.url()} does not match ${pattern}`);
      }
      this.modeName = 'choose_action';
    } else if (this.modeName === 'submit_form') {
      // const setByName = async (name: string, value: string) =>
      //   await page
      //     .locator(`form [name="${name}"]`)
      //     .fill(value, { signal: undefined });
      // const setById = async (id: string, value: string) =>
      //   await page.locator(`#${id}`).fill(value, { signal: undefined });
      const setByName = async (name: string, value: string) => (
        await page.click(`form [name="${name}"]`, { clickCount: 3 }),
        await page.type(`form [name="${name}"]`, value, { delay: 10 })
      );
      const setById = async (name: string, value: string) => (
        await page.click(`#${name}`, { clickCount: 3 }),
        await page.type(`#${name}`, value, { delay: 10 })
      );

      this.appendHistory(
        `Submitting form with fields ${aiResponse.fields
          .map((f: any) => f.form_element_name)
          .join(', ')}`
      );

      let errors: any[] = [];
      for (const field of aiResponse.fields) {
        const { form_element_name, form_element_value } = field;
        const name = form_element_name;
        const value = form_element_value;
        let set = false;
        for (const setter of [setByName, setById]) {
          try {
            await setter(name, value);
            set = true;
            break;
          } catch (e) {
            if (DEBUG) debug(e as any);
          }
        }

        if (!set) {
          warn(`Failed to set ${name} to ${value}: ${errors.join(', ')}`);
        }
      }

      if (DEBUG) debug(`Submitting AI-populated form`);
      try {
        await page.click(`form [name="${aiResponse.submit_element_name}"]`);
      } catch (e) {
        errors.push(e);
      }

      if (errors.length > 0) {
        this.reportError(
          `Errors occured submitting form: ${errors.join(', ')}`
        );
      } else {
        try {
          await page.waitForNavigation({ timeout: 3 * 1000 });
          this.appendHistory(`Form submitted successfully`);
        } catch (e) {
          warn(`Timed out waiting for navigation: ${e}`);
          warn(`Proceeding optimistically`);
        }
      }

      this.modeName = 'choose_action';
    } else {
      this.appendHistory(
        `I don't know how to handle ${this.modeName} yet. Please try something else.`
      );
      this.modeName = 'choose_action';
    }

    return { mode, nextMode: this.modeName, action: aiResponse, done };
  }

  protected appendHistory(message: string) {
    info(message);
    this.history.push({ message });
  }

  protected reportError(message: string) {
    this.history.failed(message);
    this.errors.push(message);
  }

  protected modeOptions(links: string[]) {
    return {
      choose_action: {
        description: 'Choose an action to take',
        parameters: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          properties: {
            action_name: {
              type: 'string',
              enum: [
                'navigate_to_url',
                'submit_form',
                'assert_page_url',
                'assert_css_selector',
                'complete',
              ],
            },
            reason: {
              type: 'string',
              description: `Why I've decided to take this action`,
            },
          },
          required: ['action_name', 'reason'],
          type: 'object',
        },
      },
      navigate_to_url: {
        description: 'Navigate the browser to a URL',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              enum: links,
            },
          },
          required: ['url'],
        },
      },
      submit_form: {
        description: 'Submit a form',
        parameters: {
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
            submit_element_name: {
              type: 'string',
              description: 'Name of the submit element',
            },
          },
          required: ['fields', 'submit_element_name'],
        },
      },
      // assert_response: {
      //   description: 'Assert HTTP status code from the last response',
      //   parameters: assert_response,
      // },
      assert_css_selector: {
        description: 'Make an assertion about CSS selector content',
        parameters: assert_css_selector,
      },
      assert_page_url: {
        description: 'Make an assertion about the page URL',
        parameters: assert_page_url,
      },
    };
  }
}

let startUrl = 'http://localhost:3000';

const parser = new ArgumentParser({
  description: 'Self-driving web application testing',
});
parser.add_argument('-v', '--verbose', {
  action: 'store_true',
});
parser.add_argument('--show-browser', {
  action: 'store_true',
});
parser.add_argument('-g', '--goal');
parser.add_argument('-s', '--success-criteria');
parser.add_argument('-u', '--url', { default: startUrl });

const options = parser.parse_args();

let headless = true;
if (options.verbose) {
  headless = false;
  DEBUG = true;
}
if (options.show_browser) headless = false;
if (options.url) startUrl = options.url;
const goalText = options.goal;
const successCriteriaText = options.success_criteria;

export const browser = await puppeteer.launch({
  headless: headless ? 'new' : false,
});

const goal = new Goal(browser, startUrl, goalText, successCriteriaText);
await goal.initialize();

type NextGoal = {
  goal?: string;
  quit?: boolean;
};

async function promptForGoal(
  prompt: string,
  includeQuitOption: boolean
): Promise<NextGoal> {
  const confirmationAnswer = await inquirer.prompt({
    type: 'input',
    name: 'confirmation',
    message: `${prompt}? (y/n${includeQuitOption ? '/q' : ''})`,
  });

  if (confirmationAnswer.confirmation === 'q') {
    return { quit: true };
  }

  if (confirmationAnswer.confirmation === 'y') {
    const goalAnswer = await inquirer.prompt({
      type: 'input',
      name: 'goal',
      message: 'New goal:',
    });
    goal.goal = goalAnswer.goal;

    const successAnswer = await inquirer.prompt({
      type: 'input',
      name: 'successCriteria',
      message: 'Success criteria:',
    });
    goal.successCriteria = successAnswer.successCriteria;

    return { goal: goalAnswer.goal };
  }

  return {};
}

const MAX_STEPS_SINCE_GOAL_COMPLETION = 5;

const steps = new Array<Step>();
let stepsSinceGoalCompletion = 0;
while (true) {
  const errorCount = goal.errors.length;
  log(`Goal: ${goal.goal} (${goal.successCriteria})`);
  const step = await goal.step();
  if (!step) continue;

  steps.push(step);
  if (step.done) {
    log('Goal completed!');
    stepsSinceGoalCompletion = 0;
    const nextGoal = await promptForGoal('New goal', false);
    if (!nextGoal.goal) break;
  } else {
    stepsSinceGoalCompletion++;
  }

  if (
    goal.errors.length > errorCount ||
    stepsSinceGoalCompletion > MAX_STEPS_SINCE_GOAL_COMPLETION
  ) {
    const nextGoal = await promptForGoal('Adjust goal', true);
    if (nextGoal.quit) break;
    stepsSinceGoalCompletion = 0;
  }
}

for (const step of steps) {
  log(
    `From mode ${step.mode}, chose ${JSON.stringify(step.action)}${
      step.nextMode ? ` and transitioned to ${step.nextMode}` : ''
    }`
  );
}

debug(goal.history.messages().join('\n'));

browser.close();
