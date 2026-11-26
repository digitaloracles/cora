# Invite an agent to Google Meet

1. Open the agent and choose **Settings → Google Meet**. Turn on **Enable Google Meet**. The agent and its desktop must be on.
2. Choose **Connect the agent’s email**. The agent receives a one-time command in its private chat and signs in or registers using its configured mailbox. You can close the panel while it works. If Google requires your help, complete the requested step on the agent’s desktop and choose **I’ve completed verification**. Setup finishes when the Meet browser confirms the agent’s email.
3. Invite that email to the meeting, or have the organizer admit the account when it asks to join.
4. Paste the meeting link, select the spoken language and choose the transcript folder under `meetings/`. The agent and the person starting the call need write access to that folder. Choose **Join meeting**.
5. Wait for **In the meeting**. The agent listens with its microphone and camera off. Choose **Leave meeting** when finished. The agent also leaves after the meeting ends or everyone else has left.

Open the transcript from the agent’s settings or its private chat. The link opens the artifact version. A folder configured for review keeps the transcript pending until a reviewer approves it.

The space’s Soniox connection transcribes the recording and returns speaker turns. The agent uses Meet captions to associate a displayed name with a voice. When Soniox is unavailable, the agent can save the captions that Meet actually displayed. Caption accuracy depends on the spoken language and the meeting audio. If transcription fails, the session retains its recording on the agent’s desktop and the panel offers **Retry transcript**.

## Self-hosted desktops

Use the desktop image supplied with this version of Cora. It includes PulseAudio and its recording tools. The Meet browser uses its own Google profile, audio server and virtual output. The agent records that output only while in the call. Successful artifact delivery removes the session recording.
