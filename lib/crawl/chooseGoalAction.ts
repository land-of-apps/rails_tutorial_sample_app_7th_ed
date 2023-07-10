import { debug, warn } from 'console';
import {
  ChatCompletionRequestMessage,
  CreateChatCompletionResponse,
} from 'openai';
import { AxiosResponse } from 'axios';
import assert from 'assert';
import buildOpenAIApi from './buildOpenAIApi.js';
import { DEBUG } from './goal.js';
import History from './history.js';
import TurndownService from 'turndown';

export async function chooseGoalAction(
  goal: string,
  successCriteria: string,
  modeName: string,
  modeSchema: Record<string, any>,
  pageUrl: string,
  pageText: string,
  history: History,
  forms: string[],
  subgoal?: string
): Promise<any> {
  const ai = await buildOpenAIApi();

  const turndownService = new TurndownService();
  turndownService.keep(['form', 'a', 'button']);
  const pageMarkdown = turndownService.turndown(pageText);

  if (DEBUG) {
    debug([`Goal: `, goal].join(''));
    debug([`Success criteria: `, successCriteria].join(''));
    debug([`Mode name: `, modeName].join(''));
    debug([`History: `, history].join(''));
    debug([`Page text: `, pageText].join(''));
    if (subgoal) debug(['Subgoal: ', subgoal].join(''));
  }

  const systemMessages: ChatCompletionRequestMessage[] = [
    'You are a user of a web application.',
    'Explain why you are choosing each action.',
  ].map((message) => ({
    content: message,
    role: 'system',
  }));

  const displayHistory = history.messages(3);

  const userMessages: ChatCompletionRequestMessage[] = [
    `Your objective is: ${goal}`,
    ...[successCriteria]
      .filter(Boolean)
      .map((criteria) => `You've achieved the objective when: ${criteria}`),
    `Page URL: ${pageUrl}`,
    `Page Markdown: ${pageMarkdown}`,
    ...displayHistory.map((action) => `You already tried: ${action}`),
    `What is your next action?`,
  ].map((message) => ({
    content: message,
    role: 'user',
  }));

  const messages = [...systemMessages, ...userMessages];

  if (DEBUG) debug([`Messages: `, messages.map((m) => m.content)].join(''));

  const functions = [
    {
      name: modeName,
      description: modeSchema.description,
      parameters: modeSchema.parameters,
    },
  ];

  const tokenInputs: string[] = [
    ...(messages.map((msg) => msg.content).filter(Boolean) as string[]),
    JSON.stringify(functions),
  ];

  const tokenEstimate = Math.round(
    tokenInputs
      .map((input) => input.length)
      .reduce<number>((a, b) => a + (b as number), 0) / 2.5
  );

  let model = 'gpt-3.5-turbo';
  let modelTokens = 4097;
  if (tokenEstimate > 16000) {
    warn(`Switching to 32k model due to token estimate of ${tokenEstimate}`);
    model = 'gpt-4-32k';
    modelTokens = 32000;
  } else if (tokenEstimate > 2500) {
    warn(`Switching to 16k model due to token estimate of ${tokenEstimate}`);
    model = 'gpt-3.5-turbo-16k';
    modelTokens = 16384;
  } else {
    debug(`Using 4k model due to token estimate of ${tokenEstimate}`);
  }
  // let model = 'gpt-4';
  // let modelTokens = 8096;
  let result: AxiosResponse<CreateChatCompletionResponse, any>;
  try {
    result = await ai.createChatCompletion({
      model,
      messages,
      n: 1,
      max_tokens: modelTokens - Math.round(tokenEstimate * 1.25),
      temperature: 0.6,
      function_call: { name: modeName },
      functions,
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
    .map((arg) => {
      assert(arg);
      try {
        return JSON.parse(arg);
      } catch (e) {
        warn(e);
        warn(JSON.stringify(arg, null, 2));
      }
    })[0];
  return response;
}
