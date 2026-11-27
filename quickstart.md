# Trace quickstart

Trace helps you find what your team decided and who needs to do what next. Give it a meeting transcript and it will suggest drafts you can check against the original words. You choose what to approve, export, or send to another tool.

## Open Trace

If Trace is already running on your computer, open [Trace](http://localhost:5173). To start a fresh copy, follow [the README setup](README.md#start-here). You can try the full review and export workflow without connecting another account.

On a fresh local setup, open the `.env` file in your Trace folder in a text editor and copy the value after `APP_PASSWORD=`. In Trace, keep the workspace ID as `local_seedy`, leave **Username** blank, and paste the password. Open **Workspace settings → Add access** to create a workspace member with the **Admin** role and a password of at least 12 characters. Then sign in with that username and new password. If someone already set up your workspace, ask them for your workspace ID and account details.

## Import a meeting

1. In **Meetings**, click **Import transcript**. Paste a transcript or upload a transcript file. Each turn in a plain-text transcript starts with a timestamp and speaker.
2. Give the meeting a title. Under **Meeting details**, you can set the date or group it under a project.
3. Click **Create meeting drafts** and open the meeting.

Use this short example to try the workflow without uploading a real meeting:

```text
[00:12] Maya: We decided to keep weekly backups.
[00:31] Jordan: I’ll write the backup checklist.
[00:42] Maya: Who should review the checklist?
```

You can also use **Send bot to meeting** to send **Trace Notetaker** to a call or import by ID after an admin connects MeetStream. Tell participants before sending a recording bot. If it waits in the lobby, admit it. After the meeting, wait for **Transcript ready** and select **Use transcript**. [MeetStream setup](README.md#connect-a-tool-when-you-need-it)

## Review what Trace found

| Section | What it’s for |
| --- | --- |
| **Discussions** | Choices the team agreed on. Open **View ADR draft** to see an architecture decision record, a short write-up of the choice, its reasons, and its consequences. |
| **Action items** | Follow-up work. Confirm who agreed to do it and add a due date if you know it. |
| **Open questions** | Things the group still needs to answer. |

Click a timestamp to jump to the words behind a draft. Reviewers can also play the audio when a linked MeetStream recording is still available. Use **Review this turn** in the transcript to add a missed draft or correct a speaker.

The default extraction runs on your computer and looks for statements such as “we decided” or “I’ll do it.” A meeting may produce no discussion drafts if nobody clearly agreed on a choice. Check the drafts for missed commitments and wording before approving them. If you explicitly enable Claude for an import, Trace sends that transcript to Anthropic for extraction.

## Export or publish

- **Keep a copy.** Use **Export meeting** for the meeting notes, or **View ADR draft → Download ADR** to save an individual discussion.
- **Send approved work.** With a Reviewer or Admin account, approve the drafts you want, then choose **Publish outputs** and pick a connected destination. You can also publish a single draft directly from **Discussions** or **Action items**. The action checkbox tracks whether the work is finished. The **Approve** control selects what can be published.
- **Assign an issue later.** If Trace has no account mapping for the action owner, it includes the owner’s name in the description. Open the issue or card to assign it in the destination. Connectors are optional and an admin sets them up under **Integrations**. [Connection instructions](README.md#connect-a-tool-when-you-need-it)
- **Follow an issue across meetings.** Say the task name or Linear issue ID and what changed. Review the proposed status beside the transcript timestamp, then publish it to update that issue.
- **Check uncertain sends.** Look in the meeting’s **Activity** before trying again. Trace can check Linear or GitHub for an existing issue. For other tools, verify the result in the destination.

Trace runs on your computer. Links back to a meeting open your local copy, so someone on another computer cannot follow them into your workspace. When you’re done, press **Ctrl+C** in the terminal running Trace. Your meetings stay saved for next time.
