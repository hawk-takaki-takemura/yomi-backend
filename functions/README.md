# yomi backend functions

## Setup

1. Install dependencies.
   - `npm install`
2. Login and select Firebase project.
   - `firebase use <project-id>`
3. Set Claude API key as Functions secret.
   - `firebase functions:secrets:set CLAUDE_API_KEY`

## Local development

- `npm run build`
- `npm run serve`

## Deploy

- `npm run deploy`

## Callable API

- Function name: `translateStories`
- Input:
  - `stories`: `Record<string, string>` (required)
  - `lang`: `string` (optional, default `ja`)
- Output:
  - `translations`: `Record<string, string>`
  - `cachedCount`: `number`
  - `translatedCount`: `number`
