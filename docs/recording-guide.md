# Recording the Odobook video: step by step

**Tip:** press **Ctrl+Shift+V** in VS Code to read this as a tidy page.

You'll record **5 short clips**, join them in **Clipchamp** (it comes with Windows 11), and upload to **YouTube**.
The finished video should be **under 3 minutes**. Mistakes are fine: you can cut them out afterwards.

In each clip:
- 🎙 **SAY TO ODOBOOK**: tap the big mic button first, then say it.
- 🗣 **SAY TO THE VIEWER**: just talk normally (mic button *off*). This is your narration.
- ⏸ **WAIT**: let Odobook finish talking before you do the next thing.

---

## Part 1: Get ready (about 10 minutes)

1. **Quiet room.** Turn off fans. Phone on silent.
2. **Do Not Disturb:** press **Win+N**, then turn on **Do not disturb**.
3. **Tell Claude: "reset for take".** Claude resets the demo account and restarts the voice app so it's ready to link on camera.
4. **Open Chrome (normal window)** with 3 tabs, in this order:
   - Tab 1: https://odobook-alexa.odobook-alexa.workers.dev/ (the landing page)
   - Tab 2: https://github.com/AlSayedGamal/mcp-voice-simulator/pull/10 (your open-source pull request)
   - Tab 3: http://127.0.0.1:8790 (the voice app)
   - Press **Ctrl+Shift+B** to hide the bookmarks bar.
5. **Open a Chrome incognito window** (**Ctrl+Shift+N**) and go to **http://127.0.0.1:8790**.
   - Press **Ctrl and +** until it shows **125%** (top right).
   - This is where you record the main demo. Incognito means no saved-password pop-ups.
   - **Don't** click "Link account" yet.
6. **VS Code:** open a **PowerShell** terminal in the `alexa-logbook` folder (Terminal → New Terminal). Then:
   - Type `cls` and press Enter.
   - Open these two files in tabs: `addon-package/addon.json` and `skills/odobook-car-logbook/SKILL.md`.
7. **Check the recorder:**
   - Press **Win+G**. In the **Capture** box, make sure the **microphone icon is on** (no line through it). Press **Esc**.
   - Click on any window, press **Win+Alt+R**, say "testing one two three", then press **Win+Alt+R** again.
   - Open the clip from **Videos → Captures** and listen. Can you hear yourself clearly? Good. Delete the test clip.

**How recording works:** click the window you want to record, then press **Win+Alt+R** to start and **Win+Alt+R** to stop. It records only that one window. Clips save to **Videos → Captures**.

---

## Part 2: Record the clips

### Clip 1: Intro (about 12 seconds)
**Window:** Chrome, Tab 1 (landing page). Click the page, press **Win+Alt+R**, wait 1 second.

🗣 **SAY TO THE VIEWER:**
> "If you drive for work in Australia, the tax office wants a 12-week logbook: every trip, the odometer, and a real purpose. Nobody can type that while driving. So I built Odobook: a car logbook you talk to."

Press **Win+Alt+R** to stop.

---

### Clip 2: The voice demo (about 1½ minutes, the important one)
**Window:** the incognito window with the voice app. Click it, press **Win+Alt+R**.

**Step A. Link the account**

🗣 **SAY TO THE VIEWER:**
> "This is Odobook in a voice simulator, standing in for Alexa+. First I link my account, the same way Alexa+ does."

1. Click **Link account ↗** (top right). A sign-in tab opens.
2. Type the demo email `demo@odobook.example` and the demo password, then click **Sign in and allow**.
3. Go back to the voice app tab (the first tab). The dashboard fills in.

🗣 **SAY TO THE VIEWER:**
> "One sign-in, and there's my logbook: day 22 of 84, and 81 percent business use."

**Step B. Start a trip**

(The first time you tap the mic in this window, Chrome asks to use the microphone. Click **Allow**.)

🎙 **SAY TO ODOBOOK:** "Start a work trip to Torquay."
⏸ Wait for the reply. The green trip light comes on.

🗣 **SAY TO THE VIEWER:**
> "Twenty minutes later, I arrive."

**Step C. End it with a bad purpose (Odobook says no)**

🎙 **SAY TO ODOBOOK:** "End trip, odometer 52,931. It was for business."
⏸ Wait. Odobook asks what the trip was *for*.

🗣 **SAY TO THE VIEWER:**
> "'Business' isn't a purpose the tax office accepts, so Odobook asks."

**Step D. Give a real purpose**

🎙 **SAY TO ODOBOOK:** "Quote for a bathroom renovation in Torquay."
⏸ Wait. It logs 24 km and the gauge moves.

**Step E. Fix a detail**

🎙 **SAY TO ODOBOOK:** "Update my logbook, the model is a HiLux SR5."
⏸ Wait.

**Step F. A forgotten trip**

🎙 **SAY TO ODOBOOK:** "I forgot to log a trip the day before yesterday. 64 kilometres to Bannockburn and back, quoting a rainwater tank install."
⏸ Wait. It's logged and marked late.

🗣 **SAY TO THE VIEWER:**
> "Because I added it late, it's flagged, which is what the tax office expects."

**Step G. Check progress**

🎙 **SAY TO ODOBOOK:** "How's my logbook going?"
⏸ Wait. It should say about: *"Day 22 of 84… 13 trips… Business use is 84%… 1 business trip has no odometer readings."*

**Step H. Export**

🎙 **SAY TO ODOBOOK:** "Export my logbook for my accountant."
⏸ Wait.

🗣 **SAY TO THE VIEWER:**
> "That's the spreadsheet my accountant needs. Odobook never guesses a dollar amount; it just keeps the records."

Press **Win+Alt+R** to stop.

**If it goes wrong:**
- **It misheard you:** tap the mic and say it again. You can cut the mistake out later.
- **It went badly wrong and you want to start over:** tell Claude **"reset for take"** and record Clip 2 again from the start.
- **The mic doesn't react:** click the address bar's mic icon and choose **Allow**, then try again.

**After Clip 2, tell Claude: "refresh the CSV".** That updates the spreadsheet for Clip 3.

---

### Clip 3: The spreadsheet (about 10 seconds)
1. In File Explorer, open `alexa-logbook\docs\demo-logbook.csv`. It opens in Excel.
2. Widen the columns: click the top-left corner to select everything, then double-click any column edge.
3. Click Excel, press **Win+Alt+R**.

🗣 **SAY TO THE VIEWER:**
> "Every trip: date, times, odometer, distance, purpose, and whether it was entered late."

Press **Win+Alt+R** to stop.

---

### Clip 4: Under the hood (about 30 seconds)
**Window:** VS Code.

1. Click the terminal.
2. Paste this, but **don't press Enter yet**:
   ```powershell
   $env:BASE="https://odobook-alexa.odobook-alexa.workers.dev"; $env:ADMIN_TOKEN=((Get-Content .dev.vars | Select-String '^REMOTE_ADMIN_TOKEN=').Line -replace '^REMOTE_ADMIN_TOKEN=',''); npm run test:e2e
   ```
3. Press **Win+Alt+R** to start recording, then press **Enter**.

🗣 **SAY TO THE VIEWER** (while it runs):
> "Amazon's Alexa+ toolkit is only open to partners right now, so I built to every published requirement and test it against the live server: OAuth with PKCE, the latest MCP version, and every call well under Alexa's 500 millisecond limit."

4. When it says **ALL PASSED**, click the `addon.json` tab.

🗣 **SAY TO THE VIEWER:**
> "This is the add-on manifest, following Amazon's documented fields."

5. Click the `SKILL.md` tab.

🗣 **SAY TO THE VIEWER:**
> "And an Agent Skill, so any AI agent knows the rules: ask for a real purpose, one question at a time while driving, and never a dollar figure."

Press **Win+Alt+R** to stop.

---

### Clip 5: AWS, open source, and goodbye (about 25 seconds)
**Window:** Chrome (normal window). Click **Tab 3** (the voice app), then press **Win+Alt+R**.

🗣 **SAY TO THE VIEWER** (pointing at "Brain: bedrock" at the top right):
> "The voice assistant's brain runs on Amazon Bedrock, using Amazon's Nova model to pick Odobook's tools."

Click **Tab 2** (the pull request).

🗣 **SAY TO THE VIEWER:**
> "And for open source, I sent a fix to the voice simulator itself, so it keeps listening when you pause mid-sentence, like when you're reading an odometer."

Click **Tab 1** (the landing page).

🗣 **SAY TO THE VIEWER:**
> "Odobook. Say the trip, keep the logbook. Built by me, Jayden Tebble, a Victorian primary teacher, with Claude Code. Thanks for watching."

Wait 2 seconds, then press **Win+Alt+R** to stop.

---

## Part 3: Join the clips in Clipchamp (about 15 minutes)

1. Press **Start**, type **Clipchamp**, open it. Sign in with your Microsoft account if it asks.
2. Click **Create a new video**.
3. Click **Import media**, go to **Videos → Captures**, select your 5 clips, and click **Open**.
4. Drag the clips onto the timeline at the bottom **in order: 1, 2, 3, 4, 5**.
5. **Trim the dead bits:**
   - **Start or end of a clip:** click the clip, then drag its left or right edge inwards.
   - **The middle of a clip (a mistake or a long pause):** move the white line to the start of the bad bit and press **S** (split). Move it to the end of the bad bit and press **S** again. Click the bad piece and press **Delete**.
6. Check the total time (bottom of the timeline). Aim for **under 3:00**. If it's over, trim pauses in Clip 2.
7. **Captions (recommended, because many judges watch with the sound off):** click **Captions** on the right, then **Turn on auto captions**. Skim them and fix any wrong words, especially "Odobook".
8. Click **Export** (top right), then **1080p**. It saves to your **Downloads** folder.

---

## Part 4: Upload to YouTube and add it to Devpost (about 10 minutes)

1. Go to **youtube.com**, click **Create** (the camera icon with a +), then **Upload video**, and choose the exported file.
2. **Title:** `Odobook: a car logbook you talk to (Alexa+ hackathon)`.
3. **Audience:** choose **"No, it's not made for kids"**.
4. Click **Next** until **Visibility**. Choose **Unlisted** (or **Public**). Click **Save**.
5. Copy the video link. Open it in an incognito window to check it plays.
6. Paste the link into the **video** field on your Devpost submission.

**Deadline:** Sat 24 Oct, **6:00 AM** Melbourne time. Aim to be done by 10 pm Fri.
