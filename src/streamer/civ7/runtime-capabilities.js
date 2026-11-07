/** @param {object} globals @param {Record<string, unknown>} primitives */
export function runtimeCapabilities(globals, primitives) {
  const names = Object.getOwnPropertyNames(globals).sort();
  const limit = 512;
  const entries = names.slice(0, limit).map(name => {
    const descriptor = Object.getOwnPropertyDescriptor(globals, name);
    return {name, type: descriptor && 'value' in descriptor ? typeof descriptor.value : 'accessor'};
  });
  return {globalCount: names.length, globalsTruncated: names.length > limit, globals: entries,
    primitives: Object.keys(primitives).sort().map(name => ({name, type: typeof primitives[name]})),
    nativeArguments: 6, valuesIncluded: false};
}

/** @param {object} source */
export function mediaCapabilities(source) {
  const globals = /** @type {Record<string, unknown>} */ (source);
  const document = /** @type {{createElement?: (name: string) => {canPlayType?: (mime: string) => string}} | undefined} */ (globals.document);
  const report = {status: 'unavailable', advertisementOnly: true, error: '',
    videoElement: typeof globals.HTMLVideoElement, webCodecs: typeof globals.VideoDecoder,
    mediaSource: typeof globals.MediaSource, types: /** @type {{codec: string, mime: string, result: string}[]} */ ([])};
  try {
    if (typeof document?.createElement !== 'function') return report;
    const video = document.createElement('video');
    if (typeof video.canPlayType !== 'function') return report;
    const types = [
      ['h264', 'video/mp4; codecs="avc1.42E01E"'],
      ['hevc-hvc1', 'video/mp4; codecs="hvc1.1.6.L93.B0"'],
      ['hevc-hev1', 'video/mp4; codecs="hev1.1.6.L93.B0"'],
      ['hevc-elementary', 'video/hevc'],
      ['vp8', 'video/webm; codecs="vp8"'],
      ['vp9', 'video/webm; codecs="vp09.00.31.08"'],
      ['av1-webm', 'video/webm; codecs="av01.0.05M.08"'],
      ['av1-mp4', 'video/mp4; codecs="av01.0.05M.08"'],
      ['invalid-codec-control', 'video/mp4; codecs="moonlight-invalid"'],
      ['invalid-type-control', 'video/x-moonlight-invalid']
    ];
    for (const [codec, mime] of types) report.types.push({codec, mime, result: String(video.canPlayType(mime))});
    report.status = 'advertisement-read';
  } catch (error) {
    report.status = 'query-failed';
    report.error = String(error);
  }
  return report;
}
