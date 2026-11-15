'use strict';
// Supported media types, see "Formats" in docs/ARCHITECTURE.md.

const VIDEO = {
  mp4: { playable: 'yes', mime: 'video/mp4' },
  m4v: { playable: 'yes', mime: 'video/mp4' },
  webm: { playable: 'maybe', mime: 'video/webm' },
  mov: { playable: 'maybe', mime: 'video/quicktime' },
  mkv: { playable: 'no', mime: 'video/x-matroska' },
  avi: { playable: 'no', mime: 'video/x-msvideo' },
  wmv: { playable: 'no', mime: 'video/x-ms-wmv' },
  flv: { playable: 'no', mime: 'video/x-flv' },
  mpg: { playable: 'no', mime: 'video/mpeg' },
  mpeg: { playable: 'no', mime: 'video/mpeg' },
  ts: { playable: 'no', mime: 'video/mp2t' },
  '3gp': { playable: 'no', mime: 'video/3gpp' }
};

const PHOTO = {
  jpg: { native: true, mime: 'image/jpeg' },
  jpeg: { native: true, mime: 'image/jpeg' },
  png: { native: true, mime: 'image/png' },
  gif: { native: true, mime: 'image/gif' },
  webp: { native: true, mime: 'image/webp' },
  heic: { native: false, mime: 'image/heic' },
  heif: { native: false, mime: 'image/heif' },
  tif: { native: false, mime: 'image/tiff' },
  tiff: { native: false, mime: 'image/tiff' },
  bmp: { native: false, mime: 'image/bmp' }
};

const STATIC_MIME = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  mp4: 'video/mp4',
  vtt: 'text/vtt; charset=utf-8'
};

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase();
}

function kindOf(ext) {
  if (Object.prototype.hasOwnProperty.call(VIDEO, ext)) return 'video';
  if (Object.prototype.hasOwnProperty.call(PHOTO, ext)) return 'photo';
  return null;
}

function mimeOf(ext) {
  if (VIDEO[ext]) return VIDEO[ext].mime;
  if (PHOTO[ext]) return PHOTO[ext].mime;
  return 'application/octet-stream';
}

const CODEC_NAMES = { hevc: 'HEVC (H.265)', h265: 'HEVC (H.265)', av1: 'AV1', vp9: 'VP9', vp8: 'VP8', mpeg4: 'MPEG-4', mpeg2video: 'MPEG-2', prores: 'ProRes', ac3: 'Dolby Digital (AC-3)', eac3: 'Dolby Digital Plus', dts: 'DTS', truehd: 'Dolby TrueHD', flac: 'FLAC', opus: 'Opus', vorbis: 'Vorbis' };
const OK_VIDEO_CODECS = { h264: 1 };
const OK_AUDIO_CODECS = { aac: 1, mp3: 1 };

// Decide { playable, note } for a video from its extension and (optional) ffprobe codecs.
function playability(ext, meta) {
  const base = VIDEO[ext] ? VIDEO[ext].playable : 'no';
  const upper = ext.toUpperCase();
  if (base === 'no') {
    return { playable: 'no', note: 'Most TVs cannot play ' + upper + ' files in their browser. Convert it to MP4 to watch it on the TV.' };
  }
  if (base === 'maybe') {
    return { playable: 'maybe', note: upper + ' files play on some TVs but not all. If it will not play, convert it to MP4.' };
  }
  const v = meta && meta.vcodec, a = meta && meta.acodec;
  if (v && !OK_VIDEO_CODECS[v]) {
    return { playable: 'maybe', note: 'This video uses ' + (CODEC_NAMES[v] || v.toUpperCase()) + ', which some TVs cannot play. If it will not play, convert it to MP4.' };
  }
  if (a && !OK_AUDIO_CODECS[a]) {
    return { playable: 'maybe', note: 'The sound in this video uses ' + (CODEC_NAMES[a] || a.toUpperCase()) + ', which some TVs cannot play. If there is no sound, convert it to MP4.' };
  }
  return { playable: 'yes', note: null };
}

module.exports = { VIDEO, PHOTO, STATIC_MIME, extOf, kindOf, mimeOf, playability };
