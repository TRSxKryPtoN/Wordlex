# Turning Wordlex into an Android and iOS app

The game in `public/wordle/` is a plain static site: no build step and no
outside files. [Capacitor](https://capacitorjs.com) wraps that folder in a
native app. `capacitor.config.json` in the project root already points at it.

What works with no internet in the app:

- **Solo** (Daily and Random): always.
- **Play with friends -> Same Wi-Fi (offline)**: everyone joins one Wi-Fi network
  or one phone's hotspot. The host's phone runs a tiny server inside the app
  (the `LocalRoom` plugin in `mobile/`) and the others connect to it directly.
- **Play with friends -> Online** still exists for friends in different places
  and needs internet.

> Honest status: the game side of offline rooms was tested in a browser against
> a real WebSocket server. The Android (Java) and iOS (Swift) plugin files were
> written carefully but have NOT been compiled or run on a phone here. Expect to
> do a test build and possibly small fixes.

## Android: already set up in this project

The `android/` folder is a complete Android Studio project. It was generated
with Capacitor 8 and already contains:

- the game files (copied from `public/wordle/`),
- the offline-room plugin (`android/app/src/main/java/com/wordlex/app/LocalRoomPlugin.java`),
  registered in `MainActivity.java`,
- the WebSocket library line in `android/app/build.gradle`,
- permission for local connections in `AndroidManifest.xml`,
- app icons and splash screens.

The app ID is `com.wordlex.app`. To use your own, change `appId` in
`capacitor.config.json`, delete the `android/` folder, run `npx cap add android`
and repeat the plugin steps listed at the end of this file. It cannot be changed
after the app is published.

### Build the APK: two ways

**A. On your computer with Android Studio (free)**

1. Install Android Studio and Node.js 22 or newer.
2. In the project folder run `npm install`, then `npx cap sync android`.
3. Run `npx cap open android` (or open the `android` folder in Android Studio)
   and wait for "Gradle sync" to finish. It downloads what it needs the first
   time, so this step needs internet.
4. Plug in a phone with USB debugging on and press **Run**, or choose
   **Build > Build App Bundle(s) / APK(s) > Build APK(s)**. The file is
   `android/app/build/outputs/apk/debug/app-debug.apk`; send it to any Android
   phone and install it.

**B. Without installing anything: let GitHub build it**

1. Put this project in a GitHub repository.
2. Open the repository's **Actions** tab, choose **Build Android APK**, press
   **Run workflow**.
3. When it finishes (about 5 minutes), download **wordlex-apk** from the run.

For the Play Store you need a signed release build:
**Build > Generate Signed App Bundle / APK** in Android Studio.

### After changing the game

Whenever files under `public/wordle/` change, run `npx cap sync android` and
build again.

## iOS (needs a Mac with Xcode)

Run `npx cap add ios` first, then:

1. Run `npx cap open ios`.
2. Drag `mobile/ios/LocalRoomPlugin.swift` and `mobile/ios/AppViewController.swift`
   into the **App** group in Xcode. Tick "Copy items if needed"; target **App**.
3. Open `Main.storyboard`, select the Bridge View Controller, and in the Identity
   inspector set **Class** to `AppViewController` and **Module** to `App`.
4. Open `Info.plist` and add:
   - `Privacy - Local Network Usage Description` (`NSLocalNetworkUsageDescription`):
     "Wordlex uses your Wi-Fi to play with friends nearby."
   - `App Transport Security Settings` > `Allow Local Networking`
     (`NSAllowsLocalNetworking`) = `YES`.

The first time someone hosts or joins an offline room, iOS asks for permission
to use the local network. They must tap Allow.

Then `npx cap sync ios`, `npx cap open ios` and press Run in Xcode.

## How players use offline rooms

1. One phone turns on its hotspot (mobile data can be off), or everyone joins
   the same Wi-Fi router.
2. Host: Play with friends > **Same Wi-Fi (offline)** > Host a room > choose any
   Room ID and password (or tap New) > Create room.
3. Others: Play with friends > **Same Wi-Fi (offline)** > Join a room. The room
   appears under **Rooms nearby**; tap it and enter the password. Typing the
   Room ID by hand also works.

Rooms are found by checking each address on the phone's own network for the
game's port (47800). It needs no internet and no extra permissions. It only
looks at the phone's own /24 network, which is what hotspots and home routers use.

## Test these on real phones

- Android host + Android guest on one hotspot, mobile data off on both.
- The phone that is the hotspot hosting the room, and a hotspot client hosting.
- iPhone as host and as guest (allow the local-network prompt).
- Android and iPhone in the same room.
- Lock the host phone during a match: the match pauses while the host app is
  suspended, and guests reconnect when it comes back. Hosts should keep the app
  open.
- Some Wi-Fi routers (offices, hotels) block phone-to-phone traffic. A phone
  hotspot avoids that.

## Without an app store: install from the browser

If the game is hosted on an https website, phones can also "Add to Home screen"
from Chrome or Safari. That gives an icon and offline **solo** play, but not
offline rooms: a web page cannot run the host's server.

## Reference: the Android plugin steps (already done here)

1. Copy `mobile/android/LocalRoomPlugin.java` next to `MainActivity.java` and make
   its `package` line match.
2. In `MainActivity.java`, call `registerPlugin(LocalRoomPlugin.class);` before
   `super.onCreate(savedInstanceState);`.
3. In `android/app/build.gradle` dependencies add
   `implementation 'org.java-websocket:Java-WebSocket:1.5.6'`.
4. In `AndroidManifest.xml` add `android:usesCleartextTraffic="true"` to `<application>`.
5. Copy `mobile/android/RoomService.java` next to it as well (same package line), and add
   the `<service android:name=".RoomService" ...>` entry and the `FOREGROUND_SERVICE`,
   `FOREGROUND_SERVICE_CONNECTED_DEVICE`, `CHANGE_NETWORK_STATE`, `CHANGE_WIFI_STATE`,
   `WAKE_LOCK` and `POST_NOTIFICATIONS` permissions shown in this project's
   `android/app/src/main/AndroidManifest.xml`. This keeps a room running while the app
   is in the background.
