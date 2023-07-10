import { debug, warn } from 'console';
import assert from 'assert';
import buildOpenAIApi from './buildOpenAIApi.js';
import { browser, crawler } from './crawl.js';
import {
  ChatCompletionRequestMessage,
  CreateChatCompletionResponse,
} from 'openai';
import { AxiosResponse } from 'axios';

export async function completeForm(
  loadedUrl: string,
  prompt: string,
  form: string
) {
  const ai = await buildOpenAIApi();

  debug(`Analyzing ${loadedUrl} with AI`);

  const systemMessages: ChatCompletionRequestMessage[] = [
    'You are a website user. You read the page content on a website and fill out forms with the necessary information to continue your workflow',
    `You'll be presented with some text from the website, and the HTML of a form`,
    `The text and form are separated by the delimeter '---'`,
    `Respond with three form submissions that you think are appropriate for the text`,
    `You only need to provide the user-visible fields, not hidden fields`,
    `The reason to respond with three submissions is to be compatible with form validation`,
  ].map((message) => ({
    content: message,
    role: 'system',
  }));

  const userMessages: ChatCompletionRequestMessage[] = [
    `The page text is: --- ${prompt} ---`,
    `The form is: --- ${form} ---`,
  ].map((message) => ({
    content: message,
    role: 'user',
  }));

  const messages = [...userMessages, ...systemMessages];

  let result: AxiosResponse<CreateChatCompletionResponse, any>;
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
          .reduce<number>((a, b) => a + (b as number), 0),
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
    });
  } catch (e) {
    warn(e);
    warn(JSON.stringify((e as any).response.data, null, 2));
    return;
  }
  const response = result.data.choices
    .map(
      (choice) => (
        assert(choice.message),
        assert(choice.message.function_call),
        choice.message.function_call.arguments
      )
    )
    .map((arg) => (assert(arg), JSON.parse(arg)))[0];
  // debug(response)
  assert(response);

  const page = await browser.newPage();
  await page.goto(loadedUrl);
  for (const submission of response.submissions) {
    const setByName = async (name, value) =>
      await page.type(`form [name="${name}"]`, value);
    const setById = async (id, value) => await page.type(`#${id}`, value);

    for (const field of submission.fields) {
      const { form_element_name, form_element_value } = field;
      const name = form_element_name;
      const value = form_element_value;
      let set = false;
      let errors: any[] = [];
      for (const setter of [setByName, setById]) {
        try {
          await setter(name, value);
          set = true;
          break;
        } catch (e) {
          errors.push(e as any);
        }
      }

      if (!set) {
        warn(`Failed to set ${name} to ${value}: ${errors.join(', ')}`);
        return;
      }
    }

    debug(`Submitting AI-populated form to ${loadedUrl}`);
    await page.click(`form [name="${response.submit_element_name}"]`);
    try {
      await page.waitForNavigation({ timeout: 3 * 1000 });
    } catch (e) {
      warn(`Timed out waiting for navigation: ${e}`);
      warn(`Proceeding optimistically`);
    }

    if (page.url() !== loadedUrl) {
      debug(
        `Form successfully submitted to ${loadedUrl}, then redirected to ${page.url()}: ${JSON.stringify(
          submission
        )}`
      );
      // TODO: Add links to the processing queue
      debug(`Adding ${page.url()} to the processing queue`);
      crawler.addRequests([page.url()]);
      return;
    }

    debug(
      `Form submission to ${loadedUrl} appears to have been rejected, because the page URL didn't change: ${JSON.stringify(
        submission
      )}`
    );
  }
}
