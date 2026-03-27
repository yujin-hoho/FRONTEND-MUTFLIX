/**
 * SRT → VTT subtitle converter.
 * 
 * WebVTT only supports .vtt format, but many subtitle files are .srt.
 * This utility converts SRT content to VTT on the client side.
 * 
 * Key differences between SRT and VTT:
 * - VTT requires "WEBVTT" header
 * - SRT uses comma (,) as decimal separator in timestamps, VTT uses dot (.)
 * - SRT cue indices are numeric, VTT cue identifiers are optional
 */

/**
 * Detect if text content is SRT format (vs VTT).
 */
export function isSRT(text) {
  const trimmed = text.trim();
  // VTT files start with "WEBVTT"
  if (trimmed.startsWith('WEBVTT')) return false;
  // SRT files typically start with a number (cue index)
  // and contain timestamps with commas like 00:01:23,456
  return /\d{2}:\d{2}:\d{2},\d{3}/.test(trimmed);
}

/**
 * Convert SRT text content to VTT format.
 * @param {string} srtContent - Raw SRT file content
 * @returns {string} VTT formatted content
 */
export function srtToVtt(srtContent) {
  if (!srtContent) return 'WEBVTT\n\n';

  // Normalize line endings
  let content = srtContent
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();

  // Replace comma decimal separators with dots in timestamps
  // SRT: 00:01:23,456 --> 00:01:25,789
  // VTT: 00:01:23.456 --> 00:01:25.789
  content = content.replace(
    /(\d{2}:\d{2}:\d{2}),(\d{3})/g,
    '$1.$2'
  );

  return 'WEBVTT\n\n' + content;
}

export function shiftTime(timeString, delaySeconds) {
  timeString = timeString.replace(',', '.');
  const parts = timeString.split(':');
  let h = 0, m = 0, s = 0;
  if (parts.length === 3) {
    h = parseInt(parts[0], 10);
    m = parseInt(parts[1], 10);
    s = parseFloat(parts[2]);
  } else {
    m = parseInt(parts[0], 10);
    s = parseFloat(parts[1]);
  }
  let totalSeconds = (h * 3600) + (m * 60) + s + delaySeconds;
  if (totalSeconds < 0) totalSeconds = 0.001;

  const newH = Math.floor(totalSeconds / 3600);
  const newM = Math.floor((totalSeconds % 3600) / 60);
  const newS = (totalSeconds % 60);
  const sFixed = newS.toFixed(3);
  const sParts = sFixed.split('.');

  const pad = (num) => String(num).padStart(2, '0');
  return `${pad(newH)}:${pad(newM)}:${pad(sParts[0])}.${sParts[1]}`;
}

export function shiftSubtitleTimes(content, delaySeconds) {
  if (!delaySeconds) return content;
  // Regex matches VTT and SRT: 00:00:00,000 or 00:00:00.000 or 00:00.000
  return content.replace(/(\d{2}:\d{2}:\d{2}[,\.]\d{3})/g, (match) => {
    return shiftTime(match, delaySeconds);
  });
}

/**
 * Convert subtitle content (auto-detecting SRT vs VTT) to a Blob URL
 * suitable for use as a <track> src.
 * @param {string} textContent - Raw subtitle text (SRT or VTT)
 * @returns {string} Blob URL for the VTT content
 */
export function createSubtitleBlobUrl(textContent) {
  if (!textContent) return null;

  let vttContent;
  if (isSRT(textContent)) {
    vttContent = srtToVtt(textContent);
  } else {
    // Already VTT or close enough
    vttContent = textContent.trim();
    if (!vttContent.startsWith('WEBVTT')) {
      vttContent = 'WEBVTT\n\n' + vttContent;
    }
  }

  const blob = new Blob([vttContent], { type: 'text/vtt' });
  return URL.createObjectURL(blob);
}

/**
 * Revoke a previously created subtitle Blob URL to free memory.
 * @param {string} blobUrl 
 */
export function revokeSubtitleBlobUrl(blobUrl) {
  if (blobUrl && blobUrl.startsWith('blob:')) {
    URL.revokeObjectURL(blobUrl);
  }
}
