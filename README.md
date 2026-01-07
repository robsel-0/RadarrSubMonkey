# RadarrSubMonkey
A [Tampermonkey](https://www.tampermonkey.net/) script to enhance Radarr's
interactive search by adding a subtitle column that indicates the availability
of subtitles in various languages.

- 🇸🇪 Indicates the supported languages.
- ◌  Loading / searching for subtitles.
- ⛔ The site is not allowed to be accessed. Add the site to @match and @connect
     in the userscript header to allow access.
- 💤 The site did not respond in time.
- ❌ No supported subtitles were found.

Known quirks:
- May not work on all torrent sites due to x-frame-options restrictions.
  A possible workaround is to use a browser plugin that disables    x-frame-options.

Known bugs:
- Don't always work when filtering.


![RadarrSubMonkey Logo](rsb.jpg)

# Screenshot
![Screenshot](screenshot.png)