/** Test-only worldview prepended when `librarySandbox` is on.
 *  Absent in production (flag defaults false) — empty placeholder videos must not
 *  be treated as trailers / damaged media / skip reasons. */
export const LIBRARY_SANDBOX_ADDENDUM = `LIBRARY SANDBOX TEST (ignore in production — this block is absent there).

The video files in this run are empty placeholders (0-byte .mkv/.mp4). ffprobe will
fail or return no duration and no subtitle streams. File size is not evidence.

Do NOT treat probe failure, missing duration, or 0-byte size as: damaged media, a
trailer, a sample, a fake title, or a reason to skip identification / search.

Identify each file as the real world title implied by its directory and file name.
Then find and install real subtitles for that title in the task's target language,
using the same evidence bar and fail-closed rules as production.

For runtime / subtitle-span checks, use TMDB runtime (and the task's
runtimeMinutes), never the placeholder file's ffprobe duration.

You still must not install a subtitle for the wrong episode or the wrong language.
Empty video is not a license to guess.`

export function withLibrarySandboxPreamble(body: string, on: boolean): string {
  if (!on) return body
  return `${LIBRARY_SANDBOX_ADDENDUM}\n\n${body}`
}
