import type { Skill } from './types.js'

/** Progressive-disclosure skill for library-sandbox test runs only.
 *  Indexed ahead of production skills when `librarySandbox` is true; never present
 *  in production skillDocs (flag defaults false). */
export const LIBRARY_SANDBOX_SKILL: Skill = {
  descriptor: {
    name: 'library-sandbox-test',
    description:
      'Test-only worldview for empty placeholder videos: do not treat 0-byte files as trailers or skip reasons.',
  },
  content: `Empty placeholder video files (0-byte) are not identity evidence — identify from directory and file name only.
For subtitle-span / runtime checks, use TMDB runtime (and the task's runtimeMinutes), never ffprobe duration from the placeholder.
Fail-closed rules are not relaxed: wrong episode or wrong language still means no install.`,
}
