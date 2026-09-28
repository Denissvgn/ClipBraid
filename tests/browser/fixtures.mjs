import { readFile } from 'node:fs/promises';
export async function asset(file, overrides = {}) {
  const image = file.endsWith('.png');
  return { id: 'visual-1', mediaId: file, name: file, type: image ? 'image' : 'video',
    mimeType: image ? 'image/png' : 'video/mp4', base64: (await readFile(`tests/fixtures/${file}`)).toString('base64'),
    duration: 1, originalDuration: 1, trimStart: 0, trimEnd: 0, startTime: 0,
    transitionDuration: 0, filter: 'none', hasAudio: !image, muted: false, sourceFps: image ? undefined : 30000/1001,
    ...overrides };
}
export function draft(mediaAssets, audioTracks = []) {
  return { mediaAssets, audioTracks, aspectRatio:'16:9',fitMode:'contain',transitionDuration:0,currentTime:0 };
}
export async function openProbe(context) {
  const page = await context.newPage();
  await page.goto('/tests/probe.html');
  await page.waitForFunction(() => window.testRuntime);
  return page;
}
