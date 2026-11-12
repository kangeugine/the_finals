# THE FINALS map notes

> The beautiful high-resolution map images are by [Ape Squad](https://apesquad.org/maps), and all credit for them goes to Ape Squad.

A browser tool for marking up THE FINALS arenas: spawns, cashout stations, cash boxes, high ground, 1:1 duel spots, questions, zones, and distances. You can also review your own VODs: play the video, record YouTube-style timestamps, link each one to an icon on the map, and attach screenshots.

You can view it online (read-only) at https://kangeugine.github.io/the_finals/.

To add your own notes you run the tool on your computer. The more people add, the better the maps get, so please send your changes back as a pull request (see [Contributing](#contributing)).

A YouTube video on how to use the tool will be made on request. [Open an issue](https://github.com/kangeugine/the_finals/issues/new?title=Video%20walkthrough%20request) to ask for one.

## Contents

- [What you need](#what-you-need)
- [Mac setup](#mac)
- [Windows setup](#windows)
- [Using the tool](#using-the-tool)
- [Contributing](#contributing)
  - [One-time setup](#one-time-setup)
  - [Each time you contribute](#each-time-you-contribute)
- [Publish your own copy (optional)](#publish-your-own-copy-optional)

## What you need

- Node.js 18 or newer. The tool needs nothing else, and there is no `npm install`.
- Git, to download the project and send your changes back.
- A web browser (Chrome, Edge, Safari or Firefox).

Without Node.js you can still browse the [online version](https://kangeugine.github.io/the_finals/), but adding notes needs it. It's a free installer that takes a couple of minutes, and the steps below cover it.

## Mac

### 1. Open Terminal
Press **⌘ Space**, type **Terminal**, and press **Return**.

### 2. Check for Node.js
```sh
node -v
```
- If it prints a version such as `v22.11.0` (18 or higher), you're set.
- If it says `command not found` (or the version is below 18), install it:
  1. Go to https://nodejs.org and download the **LTS** installer for macOS (`.pkg`).
  2. Open it and click through the installer.
  3. **Quit Terminal (⌘ Q) and open it again**, then run `node -v` to confirm.

  (If you use Homebrew, `brew install node` works too.)

### 3. Check for Git
```sh
git --version
```
If macOS asks to install the **command line developer tools**, click **Install**, wait for it to finish, then run `git --version` again.

### 4. Get the code
First **fork** the repo so you can send changes back: open https://github.com/kangeugine/the_finals, click **Fork** (top right), then **Create fork**. Then download *your* fork, replacing `YOUR-USERNAME` with your GitHub username:
```sh
cd ~/Documents
git clone https://github.com/YOUR-USERNAME/the_finals.git
cd the_finals
```

### 5. Start the tool
```sh
node app/server.js
```
You should see:
```
Ape Squad map tool: http://localhost:5173
```

### 6. Open it in your browser
Select the address `http://localhost:5173` in Terminal and copy it with **⌘ C**. Open your browser, click the address bar, paste with **⌘ V**, and press **Return**. (You can also just type `localhost:5173` into the address bar.)

Leave Terminal open while you use the tool. To stop it, click the Terminal window and press **Control C**. To start it again later:
```sh
cd ~/Documents/the_finals
node app/server.js
```

## Windows

### 1. Open PowerShell
Press the **Windows key**, type **PowerShell**, and press **Enter**.

### 2. Check for Node.js
```powershell
node -v
```
- If it prints a version such as `v22.11.0` (18 or higher), you're set.
- If it says `node is not recognized…` (or the version is below 18), install it:
  1. Go to https://nodejs.org and download the **LTS** installer for Windows (`.msi`).
  2. Run it and keep the default options.
  3. **Close PowerShell and open it again**, then run `node -v` to confirm.

  (Or install from PowerShell with `winget install OpenJS.NodeJS.LTS`, then reopen PowerShell.)

### 3. Check for Git
```powershell
git --version
```
If it says `git is not recognized…`, download Git from https://git-scm.com/download/win and install it with the default options (or run `winget install Git.Git`). Then **close and reopen PowerShell**.

### 4. Get the code
First **fork** the repo so you can send changes back: open https://github.com/kangeugine/the_finals, click **Fork** (top right), then **Create fork**. Then download *your* fork, replacing `YOUR-USERNAME` with your GitHub username:
```powershell
cd $HOME\Documents
git clone https://github.com/YOUR-USERNAME/the_finals.git
cd the_finals
```

### 5. Start the tool
```powershell
node app\server.js
```
You should see:
```
Ape Squad map tool: http://localhost:5173
```
If Windows asks whether to allow Node.js through the firewall, you can click **Cancel**. The tool only runs on your own computer.

### 6. Open it in your browser
Select the address `http://localhost:5173` in PowerShell with your mouse and press **Enter** (or right-click) to copy it. Open your browser, click the address bar, paste with **Ctrl V**, and press **Enter**. (You can also just type `localhost:5173` into the address bar.)

Leave PowerShell open while you use the tool. To stop it, click the PowerShell window and press **Ctrl C**. Don't press Ctrl C while you have text selected: that copies instead of stopping. To start it again later:
```powershell
cd $HOME\Documents\the_finals
node app\server.js
```

## Using the tool

- Maps: pick an arena on the left. Pick an icon type under *Place POI* (or press **1**, **2** or **3**), then click the map. Drag icons to move them, and press **Delete** to remove the selected one.
- Secondary icons: select a POI, then add High Ground, 1:1 Duel or Question icons to it. They only show while their POI is selected.
- Photos: select an icon and drop images on the **+** tile at the bottom.
- Distance: press **M** and click two icons.
- VOD review: put your video (`.mp4`, `.mov`, `.webm`) in the `vod_review` folder and press **R**.
  - **Space** plays and pauses. **← →** skip 10 s. **Shift ← →** skip 3 s; on a Mac, **⌃⌘← ⌃⌘→** also skip 3 s.
  - While paused, type a description and press **Enter** to save a `MM:SS` timestamp. Link it to an icon with **Use selected**, or create a new icon from the **New** row. Press **S** to screenshot the frame.
  - Paste the video's YouTube link in the box under the video picker. The online version then plays it from YouTube, and every timestamp links to the right moment.
  - Timestamps are also written to `vod_review/<video name>.txt`, ready to paste into a YouTube description.

Everything saves automatically to `app/data/map-data.json` and `app/data/photos/`.

If you'd like a video walkthrough of any of this, [open an issue](https://github.com/kangeugine/the_finals/issues/new?title=Video%20walkthrough%20request) and one will be made.

## Contributing

Pull requests with new icons, photos, zone fixes and VOD timestamps are very welcome. Every accepted PR shows up on the online version.

The commands below are the same on Mac and Windows. Run them from inside the `the_finals` folder.

### One-time setup
Tell Git who you are, and connect your fork to the main repo:
```sh
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
git remote add upstream https://github.com/kangeugine/the_finals.git
```

### Each time you contribute
1. **Get the latest data** so your changes don't conflict with other people's:
   ```sh
   git checkout main
   git pull upstream main
   ```
2. **Make a branch** for your changes, for example:
   ```sh
   git checkout -b skyway-spawns
   ```
3. **Make your changes** in the tool (`node app/server.js`), then stop it with Ctrl C.
4. **Commit and push:**
   ```sh
   git add app/data vod_review
   git commit -m "Add Skyway Stadium spawn notes"
   git push -u origin skyway-spawns
   ```
   The first push asks you to sign in to GitHub.
   - **Windows:** a browser window opens; sign in there.
   - **Mac:** the password prompt does *not* take your GitHub password. Either install GitHub's command line tool once and sign in with it (`brew install gh`, then `gh auth login`), or paste a [personal access token](https://github.com/settings/tokens) as the password.
5. **Open the pull request:** go to your fork on GitHub, click **Compare & pull request**, describe what you added, and click **Create pull request**.

Tips:
- Keep PRs small, for example one map or one VOD each. All notes live in a single `app/data/map-data.json` file, so small PRs are much easier to merge.
- Git ignores video files, so your VOD never gets uploaded. Put it on YouTube and paste the link in VOD review instead.
- Photos are resized automatically, so screenshots are fine to include.

## Publish your own copy (optional)

Your fork can have its own read-only site:
1. On GitHub, open your fork's **Actions** tab and click **I understand my workflows, go ahead and enable them** (GitHub turns workflows off on forks).
2. Go to **Settings → Pages** and, under **Source**, choose **GitHub Actions**.

Every push to your fork's `main` then publishes it at `https://YOUR-USERNAME.github.io/the_finals/`.
