import { arr, defineTools, int, num, obj, oneOf, str, tabIdParam } from '../../shared/tool-spec.ts';

const videoParam = str('Media ref from video_list (e.g. "e7"). Defaults to the main video: the largest visible one, preferring a playing one.');

export const videoTools = defineTools(
  {
    name: 'video_list',
    title: 'List videos',
    description:
      'Lists every <video>/<audio> element on the page, including iframes and shadow DOM: ref, source, duration, position, playing/paused, volume, rate, resolution, live stream or not, DRM, caption tracks, and the detected platform (YouTube, Vimeo…).',
    inputSchema: obj({ tabId: tabIdParam }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'video_control',
    title: 'Control playback',
    description: 'Plays, pauses, seeks, changes rate, mutes/unmutes or sets the volume of a video. play works even on pages that require a user gesture.',
    inputSchema: obj(
      {
        action: oneOf(['play', 'pause', 'seek', 'rate', 'mute', 'unmute', 'volume'], 'What to do.'),
        video: videoParam,
        time: num('Seconds to seek to (action seek).'),
        rate: num('Playback rate (action rate), e.g. 1.5.', { minimum: 0.0625, maximum: 16 }),
        volume: num('Volume 0-1 (action volume).', { minimum: 0, maximum: 1 }),
        tabId: tabIdParam,
      },
      ['action'],
    ),
    annotations: { readOnlyHint: false, openWorldHint: false },
    exclusive: true,
  },
  {
    name: 'video_frame',
    title: 'Video frames',
    description:
      'Returns frames of a video as images: the current frame, or frames at given times. Playback position and play/pause state are restored afterwards. Cross-origin videos are captured from the screen; DRM-blocked (black) frames are reported as such.',
    inputSchema: obj({
      video: videoParam,
      times: arr(num('Seconds'), 'Timestamps to capture (default: the current frame).', { maxItems: 12 }),
      maxWidth: int('Downscale frames to this width (default 960).', { minimum: 64, maximum: 1920 }),
      tabId: tabIdParam,
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    exclusive: true,
    timeoutMs: 60_000,
  },
  {
    name: 'video_storyboard',
    title: 'Video storyboard',
    description:
      'Samples N frames evenly across a time range and returns them as ONE grid image, each tile stamped with its timestamp, so you can see a whole stretch of video at once. Live or non-seekable videos are sampled while playing.',
    inputSchema: obj({
      video: videoParam,
      start: num('Range start in seconds (default 0).'),
      end: num('Range end in seconds (default: video end).'),
      count: int('Number of frames (default 12).', { minimum: 2, maximum: 36 }),
      columns: int('Grid columns (default: auto).', { minimum: 1, maximum: 8 }),
      tileWidth: int('Width of each tile in pixels (default 320).', { minimum: 96, maximum: 640 }),
      tabId: tabIdParam,
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    exclusive: true,
    timeoutMs: 120_000,
    maxTimeoutMs: 600_000,
  },
  {
    name: 'video_captions',
    title: 'Video captions',
    description:
      'Returns the captions/subtitles of a video with timestamps. Sources, in order: HTML5 caption tracks, YouTube captions, caption files the player downloaded (from the Network log). Reports clearly when there are none (then use video_transcribe).',
    inputSchema: obj({
      video: videoParam,
      language: str('Preferred language code, e.g. "en", "vi".'),
      start: num('Only cues after this second.'),
      end: num('Only cues before this second.'),
      tabId: tabIdParam,
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    timeoutMs: 45_000,
  },
  {
    name: 'video_transcribe',
    title: 'Transcribe audio (local Whisper)',
    description:
      'Transcribes the speech of a video segment with Whisper running locally on this machine (audio never leaves it). Picks the audio source automatically: decodes the media file directly when it has a URL, otherwise records the segment in real time while it plays (you still hear it), and as a last resort records the audio of the whole tab if the user allowed it by clicking the Kyte WebMCP icon on that tab. The first run downloads the model. Returns timestamped text in video time.',
    inputSchema: obj({
      video: videoParam,
      start: num('Segment start in seconds (default: current position).'),
      duration: num('Segment length in seconds (default 60, max 1800).', { minimum: 1, maximum: 1800 }),
      language: str('Spoken language code, e.g. "en", "vi" (default: auto-detect).'),
      source: oneOf(['auto', 'decode', 'stream', 'tab'], 'Audio source strategy (default auto).'),
      model: oneOf(['tiny', 'base', 'small'], 'Whisper model size (default from extension settings).'),
      tabId: tabIdParam,
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    exclusive: true,
    timeoutMs: 600_000,
    maxTimeoutMs: 3_600_000,
  },
  {
    name: 'video_watch',
    title: 'Watch a video segment',
    description:
      'The fastest way to understand a video: in one call returns video info, a storyboard of the segment, and its speech as a timeline (captions when available, otherwise local Whisper transcription), stating which source was used.',
    inputSchema: obj({
      video: videoParam,
      start: num('Segment start in seconds (default 0).'),
      duration: num('Segment length in seconds (default: whole video up to 300).'),
      frames: int('Storyboard frames (default 12).', { minimum: 2, maximum: 36 }),
      speech: oneOf(['auto', 'captions', 'transcribe', 'none'], 'Where the speech comes from (default auto).'),
      language: str('Language for captions/transcription.'),
      tabId: tabIdParam,
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    exclusive: true,
    timeoutMs: 900_000,
    maxTimeoutMs: 3_600_000,
  },
  {
    name: 'media_inspect',
    title: 'Media player details',
    description:
      'Player details like the DevTools Media panel: resolution, frame rate, dropped frames, buffered ranges, ready/network state, errors and recent events; codec and bitrate when they can be determined. Uses the full DevTools channel when available.',
    inputSchema: obj({ video: videoParam, sampleMs: int('Measure frame rate over this many milliseconds (default 1000).', { minimum: 200, maximum: 10000 }), tabId: tabIdParam }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    timeoutMs: 30_000,
  },
);

export const DEFAULT_WATCH_SECONDS = 300;
