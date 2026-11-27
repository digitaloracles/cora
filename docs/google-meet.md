# Invite an agent to Google Meet

1. Open **Settings → Google Meet** and connect the shared Google account through OAuth. Choose **Verify Meet browser**. If Google requests sign-in, open the shared browser, sign in with that same account, then verify again. All agents belonging to this owner use this one persistent browser. One call can use its audio output at a time.
2. Open an agent’s **Settings → Google Meet** and enable it. The agent and its desktop must be on for transcript delivery.
3. The agent panel shows its tagged invitation address. Gmail delivers tagged addresses to the shared mailbox. Meet displays the shared account’s Google profile name. The organizer may need to admit that account.
4. Paste the meeting link, select the spoken language and choose the transcript folder under `meetings/`. The agent and the person starting the call need write access to that folder. Choose **Join meeting**.
5. Wait for **In the meeting**. The agent listens with its microphone and camera off. Choose **Leave meeting** when finished. The agent also leaves after the meeting ends or everyone else has left.

Open the transcript from the agent’s settings or its private chat. The link opens the artifact version. A folder configured for review keeps the transcript pending until a reviewer approves it.

The space’s Soniox connection transcribes the recording and returns speaker turns. The agent uses Meet captions to associate a displayed name with a voice. When Soniox is unavailable, the agent can save the captions that Meet actually displayed. Caption accuracy depends on the spoken language and the meeting audio. If transcription fails, the session retains its recording in the meeting browser’s storage and the panel offers **Retry transcript**.

## Self-hosted desktops

Use the desktop image supplied with this version of Cora. It includes PulseAudio and its recording tools. The shared Meet browser uses its own Google profile, audio server and virtual output. The agent records that output only while in the call. Successful artifact delivery removes the session recording.
