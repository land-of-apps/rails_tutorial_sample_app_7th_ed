import { Configuration, OpenAIApi } from 'openai';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY)
  throw new Error('OPENAI_API_KEY environment variable not set');

export default async function buildOpenAIApi(): Promise<OpenAIApi> {
  return new OpenAIApi(new Configuration({ apiKey: OPENAI_API_KEY }));
}
