# Wordlex

Plain HTML, CSS and JavaScript. No framework and no build step: open
`index.html` from any static server. Solo play makes no network requests.

## Folder layout

```
wordle/
├─ index.html             Markup and script loading order
├─ manifest.webmanifest   Installable web app (PWA) metadata
├─ sw.js                  Offline cache for the website version
├─ css/styles.css         Theme tokens, layout, animations
├─ js/
│  ├─ rules.js            Pure rules: scoring, daily word, points, awards (unit tested)
│  ├─ store.js            localStorage wrapper
│  ├─ stats.js            Solo statistics
│  ├─ ui.js               Dialogs, toasts, confirm, share/copy helpers
│  ├─ keyboard.js         On-screen and physical keyboard
│  ├─ game.js             Board engine, saving, round timer
│  ├─ lan.js              Multiplayer networking (host is the authority)
│  ├─ lanui.js            Multiplayer screens: lobby, scores, results
│  ├─ fx.js               Confetti and easter eggs
│  └─ main.js             Home, solo mode, settings, stats, app wiring
├─ data/words.js          20,149 valid guesses and 3,554 answers
├─ vendor/peerjs.min.js   PeerJS 1.5.4 (loaded only for multiplayer)
├─ fonts/                 Inter (bundled)
└─ icons/
```

## Solo

- **Daily**: the day number (player's local date) picks a word from a fixed
  shuffle of the answer list, so every device gets the same word and the
  sequence is not alphabetical.
- **Random**: unlimited; recently used answers are avoided.
- Both are saved after every guess. Starting a new random puzzle with guesses
  already made counts as a loss.

## Multiplayer

The host's device runs the match. Guests never receive the answer until the
round ends: each guess is sent to the host, which scores it, measures time and
awards points. Messages from guests are validated (word list, team index,
lengths) and names/colours are escaped or whitelisted before display.

- Points: 6 for a first-guess solve down to 1 for the sixth. With a timer,
  +2 if solved in the first half of the time, +1 in the first 75%.
- Team score is the **average** of its players, so team size gives no edge.
- A round ends when everyone connected has finished, when the timer runs out,
  or when the host taps "End round now". Disconnected players are not waited for.
- Dropped players rejoin automatically and keep their score and board.
- Players joining mid-match play from the next round.
- Wrong-password attempts are limited to 8 per minute per room.

## Tests

From the project root: `npm test` (rules) and `npm run lint`.

## Awards and teammate alerts

- When a player solves the word, their teammates see a toast and a status line
  with that player's name (never the word).
- The final screen shows the **best player** overall and an **MVP** for each
  team: highest score, ties broken by rounds solved, then fewer guesses on
  solved rounds, then less time. Nobody gets an award on zero points.
