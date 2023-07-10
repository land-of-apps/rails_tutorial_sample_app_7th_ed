import levenshteinDistance from './levenshteinDistance.js';

export default function closestMatch(
  input: string,
  examples: string[]
): string {
  let closest = examples[0];
  let closestDistance = levenshteinDistance(input, closest);

  for (let i = 1; i < examples.length; i++) {
    const distance = levenshteinDistance(input, examples[i]);
    if (distance < closestDistance) {
      closest = examples[i];
      closestDistance = distance;
    }
  }

  return closest;
}
