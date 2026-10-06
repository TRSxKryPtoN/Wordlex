# Wordlex

## Screenshots
<img width="2267" height="980" alt="banner (1)" src="https://github.com/user-attachments/assets/71a6114f-b87d-4d8e-ae97-3afa47c9a8ac" />
<img width="2267" height="980" alt="banner-2 (1)" src="https://github.com/user-attachments/assets/d3128b5f-c9bc-49fd-977b-93e9a8e8a4ce" />

A five-letter word puzzle. Guess the word in six tries: green means the letter
is in the right spot, yellow means it is in the word but in the wrong spot, grey
means it is not in the word.

- **Solo:** a Daily word (the same for everyone each day) and unlimited Random puzzles.
- **Play with friends:** team matches in a private room, with chat, team MVPs and
  a best-player award.

The same game runs as a website on a PC and as an Android app.

| | PC (website) | Android app |
|---|---|---|
| Solo | Yes, works offline after the first visit | Yes, always offline |
| Friends: Online | Yes, needs internet | Yes, needs internet |
| Friends: Same Wi-Fi (offline) | Not available | Yes, no internet needed |

---


---

## On a PC (website)

### What you need

- [Node.js](https://nodejs.org) version 22 or newer.

### Run it

Open a terminal in this folder (the one containing `package.json`) and run:

```
npm install
npm run dev
```

`npm install` is only needed the first time. `npm run dev` prints a link such as
`http://localhost:8080/`; open it in a browser. Press `Ctrl + C` in the terminal
to stop.

### If the page looks old or blank

Press `Ctrl + Shift + R` to force the browser to load the newest files. The
version number is at the bottom of Settings in the game.

### Playing with friends on PC

Choose **Play with friends**, then **Host a room** or **Join a room**. Every
player needs internet. The host shares the Room ID and password.

---

## On an Android phone (app)

### Install

1. Copy `APK/app-debug.apk` to the phone (USB cable, WhatsApp, Google Drive or
   Bluetooth all work).
2. Tap the file on the phone. If Android asks, allow "Install unknown apps" for
   the app you opened it from.
3. Tap **Install**, then open **Wordlex**.

When updating to a newer APK, uninstall the old Wordlex first. Every phone in a
match should have the same version.

### Play with friends with no internet

1. One phone turns on its **hotspot** (mobile data can be off). The other phones
   connect to that hotspot. A shared Wi-Fi router also works.
2. **Host:** Play with friends > **Same Wi-Fi (offline)** > Host a room. Type a
   Room ID and password (or tap **New**), then **Create room**.
3. **Others:** Play with friends > **Same Wi-Fi (offline)** > Join a room. The
   room appears under **Rooms nearby**. Tap it, enter the password, then
   **Join room**. If it is not listed, tap **Refresh**.
4. Everyone picks a team in the lobby, and the host taps **Start match**.

Tips:

- The room keeps running if the host switches to another app (a small
  notification shows while it is open). If the host leaves, the player who joined
  first becomes the new host and the room stays open. If the original host
  comes back under the same name, they get the host controls again. A round in progress
  restarts with a new word; points from finished rounds are kept.
- A player who leaves by mistake can join again with the **same name** and keeps
  their points.
- Some office or hotel Wi-Fi networks block phones from talking to each other.
  A phone hotspot avoids that.

### Play with friends over the internet

Choose **Online** instead of **Same Wi-Fi (offline)**. This works between phones
and PCs anywhere, and every player needs internet.

### iPhone

There is no iPhone app yet. Building one needs a Mac with Xcode; the plugin
source and steps are in `mobile/ios/` and `MOBILE.md`.

---

## How a match works

- Everyone gets the same word each round. The host sets the number of rounds and
  an optional timer.
- Points per round: 6 for solving on the first guess, down to 1 on the sixth.
  With a timer, solving in the first half of the time adds 2, and in the first
  three quarters adds 1.
- A team's score is the total of its players' points.
- A Hint costs 1 point: remove three letters that are not in the word, or reveal
  one letter that is. Up to three hints a round.
- When a teammate solves the word, the rest of the team is told who solved it,
  but not the word.
- Chat is open in the lobby and on the final results. During a round it opens for
  a player once they have solved the word or used all six guesses; players still
  guessing cannot see those messages until the round ends.
- The final screen shows the winning team, an MVP for each team, and the best
  player overall.

---

## Changing the game and rebuilding the app

All game code is in `public/wordle/`. After changing anything there:

1. **PC:** refresh the browser with `Ctrl + Shift + R`.
2. **App:** copy the change into the Android project, then rebuild.

   ```
   npx cap sync android
   ```

   Open the `android` folder in Android Studio, choose **Build > Clean Project**,
   then **Build > Build App Bundle(s) / APK(s) > Build APK(s)**. The new file is
   `android/app/build/outputs/apk/debug/app-debug.apk`. Copy it into `APK/`.

If the sync step is skipped, the app keeps the old copy of the game. To check,
open Settings in the app and look at the version number.

To offer the app on the website, also copy the APK to
`public/downloads/Wordlex.apk`. The home screen of the website then shows a
**Get the Android app** button (never inside the app itself).

`MOBILE.md` has the full build details.

---

## What is in this folder

| Folder or file | What it is |
|---|---|
| `public/wordle/` | The game itself: HTML, CSS, JavaScript and the word lists |
| `android/` | The Android Studio project that wraps the game as an app |
| `APK/` | The built app, ready to install on a phone |
| `mobile/` | Source of the offline-room plugin for Android and iOS |
| `assets/` | Source images for the app icon and splash screen |
| `src/` | A small web wrapper that opens the game when you run `npm run dev` |
| `tests/` | Automatic checks for the game rules (`npm test`) |
| `node_modules/` | Downloaded libraries. Recreated by `npm install`; do not edit or share |
| `MOBILE.md` | Detailed app build guide |

When sharing the project, leave out `node_modules`, `.output`, `.wrangler` and
`android/app/build`. They are large and are recreated automatically.

---

## Disclaimer

Wordlex is an independent project **inspired by** the word game Wordle. It is not
a copy of Wordle and is not affiliated with, endorsed by, or connected to
The New York Times Company, which owns Wordle. "Wordle" is a trademark of its
owner and is mentioned here only to describe the style of game.

The name, design, code, team multiplayer, chat and scoring in Wordlex were made
for this project. No copyright or trademark infringement is intended. If you
believe something here infringes your rights, please contact the project owner
and it will be looked at promptly.

---

## Troubleshooting

| Problem | What to do |
|---|---|
| Blank page on PC | Press `Ctrl + Shift + R`. If a red box appears at the top, it says what failed. |
| "Could not open the room. Check your internet." | Online rooms need internet. In the app, use Same Wi-Fi (offline) instead. |
| No rooms under Rooms nearby | Check that both phones are on the same hotspot or Wi-Fi, then tap Refresh. Both phones need the same app version. |
| "Connect to Wi-Fi or turn on your hotspot first." | The phone is on no local network. Join the hotspot or turn one on. |
| "Wrong password" | Ask the host for the password shown at the top of their lobby. |
| The app still shows an old version | Run `npx cap sync android`, rebuild, uninstall the old app, then install the new APK. |
