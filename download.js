'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const youtubeDl = require('youtube-dl-exec');
const ffmpegPath = require('ffmpeg-static');

const ROOT = __dirname;
const MP4_DIR = path.join(ROOT, 'MP4');
const GIF_DIR = path.join(ROOT, 'GIF');
const TEMP_ROOT = path.join(ROOT, '.tmp');
const MAX_GIF_BYTES = 10_000_000;
const INITIAL_GIF_WIDTH = 960;
const REDUCED_GIF_FPS = 12;
const GIF_RESOLUTION_MARGIN = 0.95;

function printUsage() {
  console.log(`
사용법:
  .\\download.ps1 "동영상_URL" mp4
  .\\download.ps1 "동영상_URL" gif

예시:
  .\\download.ps1 "https://x.com/i/status/2103358175319916606" mp4
`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: 'inherit',
      windowsHide: true,
      ...options,
    });

    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`명령이 종료 코드 ${code}로 실패했습니다.`));
    });
  });
}

function formatFileSize(bytes) {
  return `${(bytes / 1_000_000).toFixed(2)}MB`;
}

function probeVideoWidth(source) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner',
      '-i', source,
      '-map', '0:v:0',
      '-frames:v', '1',
      '-f', 'null',
      '-',
    ], { cwd: ROOT, windowsHide: true });
    let output = '';

    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error('동영상 해상도를 확인하지 못했습니다.'));
        return;
      }

      const match = output.match(/Video:.*?\b(\d{2,5})x(\d{2,5})\b/s);
      if (!match) {
        reject(new Error('동영상 너비를 확인하지 못했습니다.'));
        return;
      }
      resolve(Number(match[1]));
    });
  });
}

async function convertGif(source, destination, fps, maxWidth) {
  const filter = `fps=${fps},scale=min(${maxWidth}\\,iw):-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256[p];[s1][p]paletteuse=dither=sierra2_4a`;

  console.log(`\nGIF 변환: ${fps}fps, 최대 너비 ${maxWidth}px`);
  await run(ffmpegPath, [
    '-hide_banner',
    '-loglevel', 'warning',
    '-stats',
    '-y',
    '-i', source,
    '-filter_complex', filter,
    '-loop', '0',
    destination,
  ]);

  const size = fs.statSync(destination).size;
  console.log(`생성된 용량: ${formatFileSize(size)}`);
  return size;
}

async function createSizeLimitedGif(source, destination) {
  const sourceWidth = await probeVideoWidth(source);
  let width = Math.min(INITIAL_GIF_WIDTH, sourceWidth);
  let size = await convertGif(source, destination, 15, width);
  if (size <= MAX_GIF_BYTES) return { fps: 15, width, size };

  const estimatedSize = size * 0.8;
  console.log(`12fps 예상 용량 (기존의 80%): ${formatFileSize(estimatedSize)}`);

  if (estimatedSize > MAX_GIF_BYTES) {
    // 용량이 픽셀 면적에 비례한다고 추정합니다. 가로·세로에 같은 비율을 적용합니다.
    // 추정 오차에 대비해 계산된 너비에서 5% 여유를 둡니다.
    const scale = Math.sqrt(MAX_GIF_BYTES / estimatedSize) * GIF_RESOLUTION_MARGIN;
    width = Math.max(2, Math.floor(width * scale / 2) * 2);
    console.log(`해상도도 함께 축소합니다: 최대 너비 ${width}px (여유분 포함)`);
  } else {
    console.log('예상 용량이 10MB 이하이므로 해상도를 유지합니다.');
  }

  // 초기 변환 후 재변환은 한 번만 수행합니다.
  size = await convertGif(source, destination, REDUCED_GIF_FPS, width);
  return { fps: REDUCED_GIF_FPS, width, size };
}

async function download(url, outputTemplate, extraFlags = {}) {
  const processHandle = youtubeDl.exec(url, {
    noPlaylist: true,
    newline: true,
    windowsFilenames: true,
    output: outputTemplate,
    ffmpegLocation: ffmpegPath,
    format: 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
    mergeOutputFormat: 'mp4',
    remuxVideo: 'mp4',
    ...extraFlags,
  });

  processHandle.stdout.pipe(process.stdout);
  processHandle.stderr.pipe(process.stderr);
  await processHandle;
}

function listMediaFiles(directory) {
  const ignoredExtensions = new Set(['.part', '.ytdl', '.json', '.jpg', '.jpeg', '.png', '.webp']);
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(directory, entry.name))
    .filter((file) => !ignoredExtensions.has(path.extname(file).toLowerCase()));
}

function uniqueOutputPath(directory, baseName, extension) {
  let candidate = path.join(directory, `${baseName}${extension}`);
  let index = 2;

  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${baseName} (${index})${extension}`);
    index += 1;
  }

  return candidate;
}

async function downloadMp4(url) {
  fs.mkdirSync(MP4_DIR, { recursive: true });
  const template = path.join(MP4_DIR, '%(title).120B [%(id)s].%(ext)s');

  console.log('\nMP4 다운로드를 시작합니다...\n');
  await download(url, template);
  console.log(`\n완료: ${MP4_DIR}`);
}

async function downloadGif(url) {
  fs.mkdirSync(GIF_DIR, { recursive: true });
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  const tempDirectory = fs.mkdtempSync(path.join(TEMP_ROOT, 'gif-'));
  const template = path.join(tempDirectory, '%(title).120B [%(id)s].%(ext)s');

  try {
    console.log('\nGIF 변환용 동영상을 다운로드합니다...\n');
    await download(url, template);

    const mediaFiles = listMediaFiles(tempDirectory);
    if (mediaFiles.length !== 1) {
      throw new Error(`변환할 동영상 파일을 하나만 찾지 못했습니다. 발견: ${mediaFiles.length}개`);
    }

    const source = mediaFiles[0];
    const baseName = path.basename(source, path.extname(source));
    const destination = uniqueOutputPath(GIF_DIR, baseName, '.gif');

    console.log('\nGIF로 변환합니다...\n');
    const result = await createSizeLimitedGif(source, destination);

    if (result.size > MAX_GIF_BYTES) {
      console.warn(`\n예상 용량과 차이가 있어 최종 용량이 10MB를 초과했습니다: ${formatFileSize(result.size)} (추가 재변환 없이 저장)`);
    }

    console.log(`\n완료: ${destination}`);
    console.log(`최종 설정: ${result.fps}fps, 최대 너비 ${result.width}px, ${formatFileSize(result.size)}`);
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const [url, requestedFormat = 'mp4'] = process.argv.slice(2);
  const format = requestedFormat.toLowerCase();

  if (!url || !['mp4', 'gif'].includes(format)) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  try {
    const parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error();
  } catch {
    console.error('오류: 올바른 http 또는 https URL을 입력해 주세요.');
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(MP4_DIR, { recursive: true });
  fs.mkdirSync(GIF_DIR, { recursive: true });

  if (format === 'gif') await downloadGif(url);
  else await downloadMp4(url);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\n다운로드 실패: ${error.shortMessage || error.message}`);
    console.error('비공개 게시물이나 로그인이 필요한 링크는 다운로드할 수 없습니다.');
    process.exitCode = 1;
  });
}

module.exports = { createSizeLimitedGif };
