==============================================================
                          WORDLEX
==============================================================

A five-letter word puzzle. Guess the word in six tries.

  GREEN   = the letter is in the right spot
  YELLOW  = the letter is in the word, but in the wrong spot
  GREY    = the letter is not in the word

Solo:               a Daily word (same for everyone each day)
                    and unlimited Random puzzles.
Play with friends:  team matches in a private room, with chat,
                    team MVPs and a best-player award.

The same game runs as a website on a PC and as an Android app.

                               PC (website)      Android app
  Solo                         Yes               Yes (always offline)
  Friends - Online             Yes (internet)    Yes (internet)
  Friends - Same Wi-Fi         Not available     Yes (no internet)


==============================================================
  ON A PC (WEBSITE)
==============================================================

WHAT YOU NEED
  Node.js version 22 or newer  (https://nodejs.org)

HOW TO RUN
  1. Open a terminal in this folder (the one with package.json).
  2. Type these two commands:

         npm install
         npm run dev

     "npm install" is only needed the first time.
  3. "npm run dev" prints a link such as http://localhost:8080/
     Open that link in a browser.
  4. Press Ctrl + C in the terminal to stop.

IF THE PAGE LOOKS OLD OR BLANK
  Press Ctrl + Shift + R to load the newest files.
  The version number is at the bottom of Settings in the game.

PLAYING WITH FRIENDS ON PC
  Choose "Play with friends", then "Host a room" or "Join a room".
  Every player needs internet.
  The host shares the Room ID and password.


==============================================================
  ON AN ANDROID PHONE (APP)
==============================================================

INSTALL
  1. Copy  APK\app-debug.apk  to the phone
     (USB cable, WhatsApp, Google Drive or Bluetooth).
  2. Tap the file on the phone. If Android asks, allow
     "Install unknown apps".
  3. Tap Install, then open Wordlex.

  When updating to a newer APK, uninstall the old Wordlex first.
  Every phone in a match should have the same version.

PLAY WITH FRIENDS WITH NO INTERNET
  1. One phone turns on its HOTSPOT (mobile data can be off).
     The other phones connect to that hotspot.
     A shared Wi-Fi router also works.
  2. HOST:
       Play with friends > Same Wi-Fi (offline) > Host a room
       Type a Room ID and password (or tap New) > Create room
  3. OTHERS:
       Play with friends > Same Wi-Fi (offline) > Join a room
       The room appears under "Rooms nearby".
       Tap it, enter the password, tap Join room.
       If it is not listed, tap Refresh.
  4. Everyone picks a team in the lobby.
     The host taps Start match.

  Tips:
  - The room keeps running if the host switches to another app
    (a small notification shows while it is open). If the host
    leaves, the player who joined first becomes the new host and
    the room stays open. If the original host comes back under
    the same name, they get the host controls again. A round in progress restarts with a new
    word; points from finished rounds are kept.
  - A player who leaves by mistake can join again with the SAME
    NAME and keeps their points.
  - Some office or hotel Wi-Fi blocks phones from talking to
    each other. A phone hotspot avoids that.

PLAY WITH FRIENDS OVER THE INTERNET
  Choose "Online" instead of "Same Wi-Fi (offline)".
  Works between phones and PCs anywhere.
  Every player needs internet.

IPHONE
  There is no iPhone app yet. Building one needs a Mac with
  Xcode. The plugin source and steps are in the mobile\ios
  folder and in MOBILE.md.


==============================================================
  HOW A MATCH WORKS
==============================================================

- Everyone gets the same word each round. The host sets the
  number of rounds and an optional timer.
- Points per round: 6 for solving on the first guess, down to
  1 on the sixth guess.
- With a timer: +2 if solved in the first half of the time,
  +1 if solved in the first three quarters.
- A team's score is the AVERAGE of its players, so a bigger
  team has no advantage.
- A Hint costs 1 point: remove three letters that are not in the word, or reveal
  one letter that is. Up to three hints a round.
- When a teammate solves the word, the rest of the team is told
  who solved it, but not the word.
- Chat is open in the lobby and on the final results. During a
  round it opens for a player once they have solved the word or
  used all six guesses; players still guessing cannot see those
  messages until the round ends.
- The final screen shows the winning team, an MVP for each team,
  and the best player overall.


==============================================================
  CHANGING THE GAME AND REBUILDING THE APP
==============================================================

All game code is in the folder  public\wordle

After changing anything there:

  PC:   refresh the browser with Ctrl + Shift + R

  APP:  1. In the project folder, run:

               npx cap sync android

        2. Open the "android" folder in Android Studio.
        3. Build > Clean Project
        4. Build > Build App Bundle(s) / APK(s) > Build APK(s)
        5. The new file is:
           android\app\build\outputs\apk\debug\app-debug.apk
           Copy it into the APK folder.

IMPORTANT: if step 1 (sync) is skipped, the app keeps the OLD
copy of the game. To check, open Settings in the app and look
at the version number.

MOBILE.md has the full build details.


==============================================================
  WHAT IS IN THIS FOLDER
==============================================================

  public\wordle   The game itself: HTML, CSS, JavaScript and
                  the word lists
  android         The Android Studio project that wraps the
                  game as an app
  APK             The built app, ready to install on a phone
  mobile          Source of the offline-room plugin for Android
                  and iOS
  assets          Source images for the app icon and splash
  src             Small web wrapper that opens the game when
                  you run "npm run dev"
  tests           Automatic checks for the game rules (npm test)
  node_modules    Downloaded libraries. Recreated by
                  "npm install". Do not edit or share.
  MOBILE.md       Detailed app build guide

When sharing the project, leave out these folders. They are
large and are recreated automatically:
  node_modules, .output, .wrangler, android\app\build


==============================================================
  DISCLAIMER
==============================================================

Wordlex is an independent project INSPIRED BY the word game
Wordle. It is not a copy of Wordle and is not affiliated with,
endorsed by, or connected to The New York Times Company, which
owns Wordle. "Wordle" is a trademark of its owner and is
mentioned here only to describe the style of game.

The name, design, code, team multiplayer, chat and scoring in
Wordlex were made for this project. No copyright or trademark
infringement is intended. If you believe something here
infringes your rights, please contact the project owner and it
will be looked at promptly.


==============================================================
  TROUBLESHOOTING
==============================================================

Blank page on PC
  Press Ctrl + Shift + R. If a red box appears at the top, it
  says what failed.

"Could not open the room. Check your internet."
  Online rooms need internet. In the app, use
  Same Wi-Fi (offline) instead.

No rooms under "Rooms nearby"
  Check that both phones are on the same hotspot or Wi-Fi, then
  tap Refresh. Both phones need the same app version.

"Connect to Wi-Fi or turn on your hotspot first."
  The phone is on no local network. Join the hotspot or turn
  one on.

"Wrong password"
  Ask the host for the password shown at the top of their lobby.

The app still shows an old version
  Run "npx cap sync android", rebuild, uninstall the old app,
  then install the new APK.
